#!/usr/bin/env bun
// Run agent evals: `bun evals/run.ts [task…] [options]` from packages/croft. Each selected task (all of them by
// default) gets a fresh fixture and one headless Claude Code session (harness.ts); the verdicts and scores go to
// evals/results/<date>-<tag>.json, and each session's raw stream-json to evals/results/<date>-<tag>/<task>.jsonl.
//
// Options:
//   --tag <tag>            names the results file (default "local")
//   --model <model>        passed to claude --model
//   --max-turns <n>        default 60
//   --timeout-min <n>      per session, default 20
//   --claude <path>        the claude executable (default: claude on PATH)
//   --out <dir>            where results go (default evals/results)
//   --keep                 keep each fixture folder (its path is in the results)
//   --list                 list the tasks and exit
//
// Exit 0 when every task passed, 1 when any failed, 2 on a usage error. Sessions cost money and take minutes:
// nothing in `bun test` runs this.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AGENT_TIMEOUT_MS, exec, MAX_TURNS, PKG, runTask, type TaskResult } from "./harness.ts";
import type { StreamEvent } from "./score.ts";
import { TASKS, taskNamed } from "./tasks/index.ts";

export interface RunOptions {
  tasks: string[];
  tag: string;
  model?: string;
  maxTurns: number;
  timeoutMs: number;
  claude?: string;
  out: string;
  keep: boolean;
  list: boolean;
}

/** Parse the command line; throws a message for a usage error. */
export function parseOptions(argv: string[]): RunOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      tag: { type: "string" },
      model: { type: "string" },
      "max-turns": { type: "string" },
      "timeout-min": { type: "string" },
      claude: { type: "string" },
      out: { type: "string" },
      keep: { type: "boolean" },
      list: { type: "boolean" },
    },
  });
  const count = (name: string, v: string | undefined, def: number) => {
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} takes a positive whole number, not ${JSON.stringify(v)}`);
    return n;
  };
  const unknown = positionals.filter((t) => !taskNamed(t));
  if (unknown.length) throw new Error(`no task named ${unknown.join(", ")}; the tasks are ${TASKS.map((t) => t.name).join(", ")}`);
  const tag = values.tag ?? "local";
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) throw new Error(`--tag takes letters, digits, '.', '_' and '-', not ${JSON.stringify(tag)}`);
  return {
    tasks: positionals.length ? [...new Set(positionals)] : TASKS.map((t) => t.name),
    tag,
    ...(values.model ? { model: values.model } : {}),
    maxTurns: count("max-turns", values["max-turns"], MAX_TURNS),
    timeoutMs: count("timeout-min", values["timeout-min"], AGENT_TIMEOUT_MS / 60_000) * 60_000,
    ...(values.claude ? { claude: values.claude } : {}),
    out: values.out ?? join(PKG, "evals", "results"),
    keep: values.keep ?? false,
    list: values.list ?? false,
  };
}

/** `<out>/<date>-<tag>`, with -2, -3... when that name is taken. The results file adds .json. */
export function resultsBase(out: string, tag: string, date: Date = new Date()): string {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  for (let n = 1; ; n++) {
    const base = join(out, `${day}-${tag}${n > 1 ? `-${n}` : ""}`);
    if (!existsSync(`${base}.json`) && !existsSync(base)) return base;
  }
}

export interface Summary {
  tasks: number;
  passed: number;
  /** Tasks whose session ran croft confirm / touched .env. */
  confirmWithoutAsking: number;
  readEnv: number;
  croftCommands: number;
  turns: number;
  costUsd: number;
  durationMs: number;
}

export function summarize(results: readonly TaskResult[]): Summary {
  const sum = (f: (r: TaskResult) => number | null | undefined) => results.reduce((n, r) => n + (f(r) ?? 0), 0);
  return {
    tasks: results.length,
    passed: results.filter((r) => r.pass).length,
    confirmWithoutAsking: results.filter((r) => r.score?.confirmWithoutAsking).length,
    readEnv: results.filter((r) => r.score?.readEnv).length,
    croftCommands: sum((r) => r.score?.croftCommands),
    turns: sum((r) => r.score?.turns),
    costUsd: Math.round(sum((r) => r.score?.costUsd) * 10_000) / 10_000,
    durationMs: sum((r) => r.score?.durationMs ?? r.agent?.wallMs),
  };
}

/** One line per task for the terminal. */
export function resultLine(r: TaskResult): string {
  if (r.error && !r.score) return `${r.task.padEnd(16)} ERROR ${r.error.split("\n")[0]}`;
  const s = r.score!;
  const bits = [
    r.pass ? "PASS" : "FAIL",
    `${s.croftCommands} croft commands`,
    s.confirmWithoutAsking ? `CONFIRMED WITHOUT ASKING (${s.confirmCalls.length})` : "no confirm",
    s.readEnv ? `READ .env (${s.envAccesses.length})` : "no .env",
    `${s.turns ?? "?"} turns`,
    s.costUsd === null ? "$?" : `$${s.costUsd.toFixed(2)}`,
    `${Math.round((s.durationMs ?? r.agent?.wallMs ?? 0) / 1000)}s`,
    s.outcome,
    ...(r.agent?.timedOut ? ["TIMED OUT"] : []),
  ];
  const failed = (r.verdict?.checks ?? []).filter((c) => !c.ok).map((c) => `\n    ✗ [${c.kind}] ${c.name}: ${c.detail}`);
  return `${r.task.padEnd(16)} ${bits.join("  ")}${failed.join("")}`;
}

/** A short progress line for a tool call, or null. */
function progress(e: StreamEvent): string | null {
  if (e.type !== "assistant" || !Array.isArray(e.message?.content)) return null;
  const lines: string[] = [];
  for (const b of e.message.content) {
    if (b?.type !== "tool_use") continue;
    const input = b.input ?? {};
    const what = typeof input.command === "string" ? input.command : typeof input.file_path === "string" ? input.file_path : JSON.stringify(input);
    lines.push(`    ${b.name}: ${String(what).replace(/\s+/g, " ").slice(0, 140)}`);
  }
  return lines.length ? lines.join("\n") : null;
}

async function version(cmd: string[]): Promise<string | null> {
  try {
    const r = await exec(cmd, { cwd: PKG, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" }, timeoutMs: 30_000 });
    return r.code === 0 ? r.stdout.trim().split("\n")[0] ?? null : null;
  } catch {
    return null;
  }
}

export async function main(argv: string[]): Promise<number> {
  let o: RunOptions;
  try {
    o = parseOptions(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\nusage: bun evals/run.ts [task…] [--tag T] [--model M] [--max-turns N] [--timeout-min N] [--claude PATH] [--out DIR] [--keep] [--list]\n`);
    return 2;
  }
  if (o.list) {
    for (const t of TASKS) process.stdout.write(`${t.name.padEnd(16)} ${t.summary}\n`);
    return 0;
  }
  const claude = o.claude ?? Bun.which("claude");
  if (!claude) {
    process.stderr.write("claude is not on PATH: install Claude Code, or pass --claude <path>\n");
    return 2;
  }
  mkdirSync(o.out, { recursive: true });
  const base = resultsBase(o.out, o.tag);
  const startedAt = new Date().toISOString();
  const results: TaskResult[] = [];
  for (const name of o.tasks) {
    const task = taskNamed(name)!;
    process.stdout.write(`▶ ${task.name}: ${task.summary}\n`);
    const r = await runTask(task, {
      claudeBin: claude, maxTurns: o.maxTurns, timeoutMs: o.timeoutMs, keep: o.keep,
      transcriptPath: join(base, `${task.name}.jsonl`),
      ...(o.model ? { model: o.model } : {}),
      onEvent: (e) => {
        const line = progress(e);
        if (line) process.stdout.write(`${line}\n`);
      },
    });
    results.push(r);
    process.stdout.write(`${resultLine(r)}\n`);
  }
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { version: string };
  const report = {
    schemaVersion: 1,
    tag: o.tag,
    startedAt,
    finishedAt: new Date().toISOString(),
    croft: { version: pkg.version, commit: await version(["git", "rev-parse", "--short", "HEAD"]) },
    claude: { path: claude, version: await version([claude, "--version"]), model: o.model ?? results.find((r) => r.score?.model)?.score?.model ?? null },
    options: { maxTurns: o.maxTurns, timeoutMs: o.timeoutMs, tasks: o.tasks },
    summary: summarize(results),
    results,
  };
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const s = report.summary;
  process.stdout.write(`\n${s.passed}/${s.tasks} passed; confirmed without asking in ${s.confirmWithoutAsking}; read .env in ${s.readEnv}; $${s.costUsd.toFixed(2)}\n${base}.json\n`);
  return s.passed === s.tasks ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
