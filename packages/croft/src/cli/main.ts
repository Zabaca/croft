#!/usr/bin/env bun
// The croft CLI (DESIGN.md §4). One invocation: find the command, parse its flags with
// node:util parseArgs, run it, and print either one --json envelope or human text. A CroftError
// becomes its problem and exit code; anything else is INTERNAL_ERROR with a trimmed stack.
import { parseArgs, type ParseArgsConfig } from "node:util";
import { fileURLToPath } from "node:url";
import { CODES, CroftError, EXIT, exitCodeFor, problem } from "../core/errors.ts";
import type { Envelope, Problem } from "../core/types.ts";
import { didYouMean } from "../project/suggest.ts";
import type { Command, CommandResult, OptionSpec } from "./command.ts";
import { COMMANDS } from "./commands/index.ts";
import { GLOBAL_OPTIONS } from "./commands/help.ts";
import { CliContext } from "./context.ts";
import { launch } from "./launcher.ts";
import { buildEnvelope, formatNext, formatProblem, formatProblems, redactEnvelope, redactProblem, Render, toJsonLine } from "./render.ts";
import { BUN_FLOOR, versionAtLeast } from "./version.ts";

export interface MainIO {
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  stderrTTY?: boolean;
  commands?: readonly Command[];
  bunVersion?: string;
}

/** Where the command name sits in argv and which global flags are present. Global flags may appear
 *  anywhere before a bare `--`; the first argument that is not a flag names the command. */
export function scanArgv(argv: readonly string[]): { name?: string; index: number; json: boolean; help: boolean; version: boolean } {
  let name: string | undefined;
  let index = -1;
  let json = false, help = false, version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--version" || a === "-V") version = true;
    else if (name === undefined && !a.startsWith("-")) { name = a; index = i; }
  }
  return { ...(name !== undefined ? { name } : {}), index, json, help, version };
}

/** Run croft with `argv` (without the program name) and return the exit code. Never exits the process. */
export async function main(argv: readonly string[], io: MainIO = {}): Promise<number> {
  const startedAt = performance.now();
  const env = io.env ?? process.env;
  const commands = io.commands ?? COMMANDS;
  const pre = scanArgv(argv);
  const render = new Render({
    json: pre.json,
    stdout: io.stdout ?? ((t) => void process.stdout.write(t)),
    stderr: io.stderr ?? ((t) => void process.stderr.write(t)),
    stdoutTTY: io.stdoutTTY ?? !!process.stdout.isTTY,
    stderrTTY: io.stderrTTY ?? !!process.stderr.isTTY,
    env,
  });
  const ctx = new CliContext({
    cwd: io.cwd ?? process.cwd(),
    processEnv: env,
    render,
    isTTY: { stdin: io.stdinTTY ?? !!process.stdin.isTTY, stdout: io.stdoutTTY ?? !!process.stdout.isTTY },
    commands,
    startedAt,
  });
  // Progress written while the command runs is redacted too; .env is read on the first write.
  render.redact = (text) => ctx.redactor()(text);

  // --version wins anywhere; a bare `croft` (or `croft --help`) shows the command list.
  let name = pre.version ? "version" : pre.name ?? "help";
  let cmd: Command | undefined;
  let result: CommandResult | undefined;
  let failure: { problem: Problem; exit: number } | undefined;
  try {
    const bun = io.bunVersion ?? Bun.version;
    if (!versionAtLeast(bun, BUN_FLOOR)) {
      throw new CroftError("BUN_TOO_OLD", {
        message: `croft needs Bun ${BUN_FLOOR} or newer; this is Bun ${bun}`,
        hint: "run bun upgrade",
        fix: { kind: "command", description: "upgrade Bun", command: "bun upgrade", requiresHuman: true },
      });
    }
    cmd = commands.find((c) => c.name === name);
    if (!cmd) throw unknownCommand(name, argv, pre.index, commands);
    let rest = pre.version && name === "version" ? [] : argv.filter((_, i) => i !== pre.index);
    // `croft <command> --help` is `croft help <command>`, whatever else is on the line.
    const helpCmd = commands.find((c) => c.name === "help");
    if (pre.help && cmd.name !== "help" && helpCmd) {
      rest = [cmd.name, ...(pre.json ? ["--json"] : [])];
      cmd = helpCmd;
      name = "help";
    }
    const parsed = parseFlags(cmd, rest);
    ctx.command = cmd.name;
    ctx.argv = rest;
    ctx.values = parsed.values;
    ctx.positionals = parsed.positionals;
    result = await cmd.run(ctx);
  } catch (e) {
    failure = toFailure(e);
  }

  try {
    return emit(ctx, render, name, cmd, result, failure);
  } catch (e) {
    // Data that cannot be serialized (a cycle, say) is croft's bug; report it rather than crash.
    return emit(ctx, render, name, cmd, undefined, toFailure(e));
  }
}

function emit(ctx: CliContext, render: Render, name: string, cmd: Command | undefined,
  result: CommandResult | undefined, failure: { problem: Problem; exit: number } | undefined): number {
  const meta = ctx.envelopeMeta();
  const durationMs = performance.now() - ctx.startedAt;
  const redact = ctx.redactor();
  // A registered name is croft's own constant; anything else was typed by the user and may hold a secret.
  name = cmd && cmd.name === name ? name : redact(name);

  let envelope: Envelope<unknown>;
  let exit: number;
  if (failure || !result) {
    const p = failure?.problem ?? internalProblem(new Error("command returned no result"));
    envelope = buildEnvelope({ command: name, ok: false, data: null, problems: [p], next: [], ...meta, durationMs });
    exit = failure?.exit ?? EXIT.FAILED;
  } else {
    envelope = buildEnvelope({
      command: name, data: result.data, problems: result.problems, next: result.next,
      ...(result.ok !== undefined ? { ok: result.ok } : {}),
      ...(result.confirmation ? { confirmation: result.confirmation } : {}),
      ...meta, durationMs,
    });
    exit = result.exit ?? exitCodeFor(result.problems, { pendingConfirmation: !!result.confirmation });
  }
  envelope = redactEnvelope(envelope, redact);

  if (render.json) {
    render.envelope(envelope);
    return exit;
  }
  if (failure || !result) {
    printFailure(render, envelope.problems[0]!);
    return exit;
  }
  const shown: CommandResult = { ...result, data: envelope.data, problems: envelope.problems, next: envelope.next };
  let text: string | undefined;
  try {
    text = cmd?.human ? cmd.human(shown, ctx) : defaultHuman(envelope.data);
  } catch (e) {
    // A formatter bug must not hide the result: report it and fall back to JSON of the data.
    printFailure(render, redactProblem(internalProblem(e), redact));
    text = defaultHuman(envelope.data);
  }
  if (text) render.outRaw(text);
  if (envelope.problems.length) render.outRaw(formatProblems(envelope.problems, render.color));
  if (envelope.next.length) render.outRaw(formatNext(envelope.next, render.color));
  return exit;
}

/** A failed command's problem on stderr; an internal error also shows its trimmed stack. */
function printFailure(render: Render, p: Problem): void {
  const stack = p.code === "INTERNAL_ERROR" && Array.isArray(p.details?.stack) ? (p.details.stack as string[]) : [];
  render.errRaw([formatProblem(p, render.errColor), ...stack.map((l) => `        ${render.errStyle.dim(l)}`)].join("\n"));
}

function defaultHuman(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  return JSON.stringify(JSON.parse(toJsonLine(data)), null, 2);
}

function parseFlags(cmd: Command, args: string[]): { values: Record<string, string | boolean | (string | boolean)[] | undefined>; positionals: string[] } {
  const all: Record<string, OptionSpec> = { ...cmd.options, ...GLOBAL_OPTIONS };
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const [key, o] of Object.entries(all)) {
    options[key] = { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) };
  }
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw flagError(cmd, all, args, e as Error & { code?: string });
  }
  if (cmd.maxPositionals !== undefined && parsed.positionals.length > cmd.maxPositionals) {
    const extra = parsed.positionals.slice(cmd.maxPositionals);
    throw new CroftError("USAGE_ERROR", {
      message: cmd.maxPositionals === 0
        ? `croft ${cmd.name} takes no arguments; got ${extra.map((a) => JSON.stringify(a)).join(" ")}`
        : `croft ${cmd.name} takes at most ${cmd.maxPositionals} argument${cmd.maxPositionals === 1 ? "" : "s"}; ${extra.map((a) => JSON.stringify(a)).join(" ")} is extra`,
      hint: `usage: ${cmd.usage}`,
      fix: { kind: "command", description: "show usage", command: `croft ${cmd.name} --help` },
    });
  }
  return { values: parsed.values as Record<string, string | boolean | (string | boolean)[] | undefined>, positionals: parsed.positionals };
}

function flagError(cmd: Command, all: Record<string, OptionSpec>, args: string[], e: Error & { code?: string }): CroftError {
  const usage = { kind: "command" as const, description: "show usage", command: `croft ${cmd.name} --help` };
  if (e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const flag = /'([^']+)'/.exec(e.message)?.[1] ?? "";
    const guess = flag.startsWith("--") ? didYouMean(flag.slice(2), Object.keys(all)) : undefined;
    const corrected = guess
      ? ["croft", cmd.name, ...args.map((a) => (a === flag || a.startsWith(`${flag}=`) ? `--${guess}${a.slice(flag.length)}` : a))].map(shellQuote).join(" ")
      : "";
    return new CroftError("USAGE_ERROR", {
      message: `croft ${cmd.name} has no option ${flag}`,
      hint: guess ? `did you mean --${guess}?` : `croft ${cmd.name} --help lists its options`,
      fix: guess ? { kind: "command", description: `use --${guess}`, command: corrected } : usage,
      details: { option: flag, ...(guess ? { suggestion: `--${guess}` } : {}) },
    });
  }
  if (e.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    const flag = /'(--?[\w-]+)/.exec(e.message)?.[1] ?? "an option";
    const takesValue = Object.entries(all).some(([k, o]) => `--${k}` === flag && o.type === "string");
    return new CroftError("USAGE_ERROR", {
      message: takesValue ? `${flag} needs a value` : `${flag} does not take a value`,
      hint: takesValue ? `write ${flag} <value> (a value starting with "-" needs ${flag}=<value>)` : `write ${flag} on its own`,
      fix: usage,
    });
  }
  return new CroftError("USAGE_ERROR", { message: e.message.split("\n")[0]!, hint: `usage: ${cmd.usage}`, fix: usage });
}

function unknownCommand(name: string, argv: readonly string[], index: number, commands: readonly Command[]): CroftError {
  const guess = didYouMean(name, commands.map((c) => c.name));
  const corrected = guess ? ["croft", ...argv.map((a, i) => (i === index ? guess : a))].map(shellQuote).join(" ") : "";
  return new CroftError("USAGE_ERROR", {
    message: `unknown command "${name}"`,
    hint: guess ? `did you mean "croft ${guess}"?` : "croft help lists every command",
    fix: guess
      ? { kind: "command", description: `run croft ${guess} instead`, command: corrected }
      : { kind: "command", description: "list the commands", command: "croft help" },
    details: { command: name, ...(guess ? { suggestion: guess } : {}) },
  });
}

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function toFailure(e: unknown): { problem: Problem; exit: number } {
  if (e instanceof CroftError) return { problem: e.problem, exit: e.exit || EXIT.FAILED };
  return { problem: internalProblem(e), exit: CODES.INTERNAL_ERROR.exit };
}

const SRC_DIR = fileURLToPath(new URL("../", import.meta.url));

/** An unexpected exception: croft's bug, not the user's. Keep the message and a short stack. */
export function internalProblem(e: unknown): Problem {
  const err = e instanceof Error ? e : new Error(String(e));
  return problem("INTERNAL_ERROR", {
    message: `${err.name}: ${err.message}`,
    hint: "this is a bug in croft, not in your project; report it with the command you ran and this output",
    fix: { kind: "manual", description: "report the bug with the command you ran and this output" },
    details: { stack: trimStack(err.stack) },
  });
}

/** Stack frames without runtime internals, with croft's own paths shortened, at most `max`. */
export function trimStack(stack: string | undefined, max = 8): string[] {
  if (!stack) return [];
  return stack.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at ") && !/\((?:node|bun):|\bnative\b|^at (?:node|bun):|<anonymous>$/.test(l))
    .map((l) => l.split(SRC_DIR).join("croft/src/"))
    .slice(0, max);
}

if (import.meta.main) {
  // exitCode, not process.exit(): exit() cuts piped stdout off at 64 KB in Bun.
  // The launcher decides first: inside a project it may hand the invocation to the pinned copy (§2).
  process.exitCode = await launch({ main: (argv) => main(argv), commandNames: COMMANDS.map((c) => c.name) });
}
