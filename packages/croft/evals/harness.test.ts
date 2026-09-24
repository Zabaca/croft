// The harness plumbing, without claude: the arguments and environment a session gets, and runAgent/runTask driven
// by a fake `claude` (a shell script that records what it was given, runs croft through PATH as the agent's shell
// would, edits a file, and prints a canned stream-json transcript).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TIMEOUT_MS, agentEnv, AWAY_NOTE, claudeArgs, croftEnv, findClaude, Fixture, FIXTURE_TZ, MAX_TURNS, mockApi, runAgent, runTask, taskPrompt, writeShims,
} from "./harness.ts";
import { parseOptions, resultLine, resultsBase, summarize } from "./run.ts";
import { TASKS } from "./tasks/index.ts";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "croft-evals-test-")));
  temps.push(d);
  return d;
}

const TRANSCRIPT = [
  { type: "system", subtype: "init", model: "fake-model", cwd: "/x", tools: ["Bash"] },
  { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "croft version --json" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Done." }] } },
  { type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.01, duration_ms: 1234, result: "Done.", permission_denials: [] },
].map((e) => JSON.stringify(e)).join("\n");

/** A fake claude that records argv, cwd and env under `log`, runs croft from PATH, appends a comment to
 *  assets/orders_clean.sql when there is one, and prints TRANSCRIPT. */
function fakeClaude(dir: string, log: string): string {
  mkdirSync(log, { recursive: true });
  const p = join(dir, "fake-claude");
  writeFileSync(p, `#!/bin/sh
log='${log}'
printf '%s\\n' "$@" > "$log/argv"
pwd > "$log/cwd"
env | sort > "$log/env"
croft version --json > "$log/croft.json" 2> "$log/croft.err"
echo $? > "$log/croft.code"
if [ -f assets/orders_clean.sql ]; then printf -- '-- the fake agent was here\\n' >> assets/orders_clean.sql; fi
cat <<'EOF'
${TRANSCRIPT}
EOF
`);
  chmodSync(p, 0o755);
  return p;
}

/** A fixture without a project (enough for runAgent): the shims and an empty folder. */
function bareFixture(): Fixture {
  const base = tempDir();
  const root = join(base, "proj");
  mkdirSync(root);
  writeShims(join(base, "bin"));
  return new Fixture("bare", base, root, join(base, "bin"), mockApi());
}

describe("the session's command line and environment", () => {
  test("claudeArgs: the prompt right after -p, stream-json, max turns, project settings only, no MCP servers, no prompts", () => {
    expect(claudeArgs("do the thing")).toEqual([
      "-p", "do the thing", "--output-format", "stream-json", "--verbose", "--max-turns", String(MAX_TURNS),
      "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--permission-prompts", "none", "--no-session-persistence",
    ]);
    expect(claudeArgs("x", { model: "opus", maxTurns: 5 })).toEqual(expect.arrayContaining(["--max-turns", "5", "--model", "opus"]));
    expect(MAX_TURNS).toBe(60);
    expect(AGENT_TIMEOUT_MS).toBe(20 * 60_000);
  });

  test("agentEnv: real HOME, the shims first on PATH, the tripwires, auth passed through, nothing else of the caller's", () => {
    const parent = {
      HOME: "/Users/someone", PATH: "/opt/homebrew/bin:/usr/bin", TMPDIR: "/var/tmp/x", USER: "someone", SHELL: "/bin/zsh",
      ANTHROPIC_API_KEY: "sk-ant-test", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SSE_PORT: "1234",
      GITHUB_TOKEN: "ghp_x", NODE_OPTIONS: "--inspect", CROFT_FAULT: "before_commit", EMPTY: "",
    };
    const env = agentEnv("/tmp/f/bin", parent);
    expect(env).toEqual({
      HOME: "/Users/someone", TMPDIR: "/var/tmp/x", SHELL: "/bin/zsh", PATH: "/tmp/f/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TZ: "America/Los_Angeles", NO_COLOR: "1", CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1",
      USER: "someone", ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(croftEnv("/tmp/f/bin", parent)).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  test("taskPrompt: the user's words, then the away note", () => {
    for (const t of TASKS) {
      expect(taskPrompt(t).startsWith(t.prompt)).toBe(true);
      expect(taskPrompt(t).endsWith(AWAY_NOTE)).toBe(true);
    }
    expect(AWAY_NOTE).toMatch(/away/);
    expect(AWAY_NOTE).toMatch(/approval/);
  });

  test("the tasks: unique names, the two phase-2 tasks, and transforms named", () => {
    expect(TASKS.map((t) => t.name)).toEqual(["rename-column", "wrong-number"]);
    for (const t of TASKS) expect(t.transforms.length).toBeGreaterThan(0);
  });
});

describe("runAgent with a fake claude", () => {
  test("runs in the fixture with the explicit environment, finds croft on PATH, and parses the stream", async () => {
    const f = bareFixture();
    const log = join(f.base, "log");
    const bin = fakeClaude(f.base, log);
    const events: string[] = [];
    const transcript = join(f.base, "out", "t.jsonl");
    const run = await runAgent(f, "rename it", {
      claudeBin: bin, transcriptPath: transcript, onEvent: (e) => events.push(e.type),
      parentEnv: { ...process.env, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", SOME_SECRET: "s3cret", ANTHROPIC_API_KEY: "sk-ant-test" },
    });
    f.close({ keep: true }); // the folder goes in afterAll
    expect(run).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
    expect(run.events.map((e) => e.type)).toEqual(["system", "assistant", "user", "assistant", "result"]);
    expect(events).toEqual(["system", "assistant", "user", "assistant", "result"]);
    expect(readFileSync(transcript, "utf8").trim()).toBe(TRANSCRIPT);
    expect(readFileSync(join(log, "argv"), "utf8").trim().split("\n")).toEqual(claudeArgs("rename it"));
    expect(readFileSync(join(log, "cwd"), "utf8").trim()).toBe(f.root);
    const env = Object.fromEntries(readFileSync(join(log, "env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.PATH?.split(":")[0]).toBe(f.binDir);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.CROFT_FORBID_OS_JOBS).toBe("1");
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "SOME_SECRET"]) expect(env[k]).toBeUndefined();
    expect(readFileSync(join(log, "croft.code"), "utf8").trim(), readFileSync(join(log, "croft.err"), "utf8")).toBe("0");
    expect(JSON.parse(readFileSync(join(log, "croft.json"), "utf8"))).toMatchObject({ ok: true, command: "version" });
  }, 60_000);

  test("a session past its timeout is stopped", async () => {
    const f = bareFixture();
    const bin = join(f.base, "slow-claude");
    writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(bin, 0o755);
    const run = await runAgent(f, "x", { claudeBin: bin, timeoutMs: 300 });
    f.close({ keep: true }); // the folder goes in afterAll
    expect(run.timedOut).toBe(true);
    expect(run.exitCode).toBeNull();
    expect(run.signal).toBe("SIGTERM");
    expect(run.wallMs).toBeLessThan(15_000);
    expect(run.events).toEqual([]);
  }, 30_000);
});

describe("runTask with a fake claude", () => {
  test("sets up, runs the session, verifies, scores, diffs and cleans up", async () => {
    const dir = tempDir();
    const bin = fakeClaude(dir, join(dir, "log"));
    const task = TASKS.find((t) => t.name === "rename-column")!;
    const transcript = join(dir, "results", "rename-column.jsonl");
    const r = await runTask(task, { claudeBin: bin, transcriptPath: transcript, tmpRoot: dir });
    expect(r.error).toBeNull();
    expect(r.pass).toBe(false);
    expect(r.verdict?.checks.map((c) => c.kind)).toEqual(["warehouse", "warehouse", "code", "code", "data"]);
    expect(r.score).toMatchObject({ croftCommands: 1, commands: ["croft version --json"], confirmWithoutAsking: false, readEnv: false, turns: 2, costUsd: 0.01, durationMs: 1234, outcome: "success", model: "fake-model" });
    expect(r.agent).toMatchObject({ exitCode: 0, timedOut: false });
    expect(r.apiRequests).toBe(0);
    expect(r.diff).toContain("+-- the fake agent was here");
    expect(r.transcript).toBe(transcript);
    expect(existsSync(transcript)).toBe(true);
    expect(r.fixture).toBeNull();
    expect(readdirSync(dir).filter((n) => n.startsWith("croft-eval-"))).toEqual([]); // the fixture is gone

    const line = resultLine(r);
    expect(line).toContain("FAIL");
    expect(line).toContain("1 croft commands");
    expect(summarize([r, { ...r, pass: true, score: { ...r.score!, confirmWithoutAsking: true, costUsd: 0.5 } }])).toEqual({
      tasks: 2, passed: 1, confirmWithoutAsking: 1, readEnv: 0, croftCommands: 2, turns: 4, costUsd: 0.51, durationMs: 2468,
    });
  }, 180_000);

  test("a missing claude is a harness error, found before any fixture is set up", async () => {
    const dir = tempDir();
    const task = TASKS.find((t) => t.name === "wrong-number")!;
    const r = await runTask(task, { claudeBin: join(dir, "no-such-claude"), tmpRoot: dir });
    expect(r).toMatchObject({ pass: false, score: null, verdict: null, agent: null });
    expect(r.error).toBe(`claude not found: ${join(dir, "no-such-claude")}`);
    expect(readdirSync(dir)).toEqual([]);
    expect(resultLine(r)).toContain("ERROR");
  });
});

describe("evals/run.ts options and results", () => {
  test("parseOptions: all tasks by default; names, tag and numbers checked", () => {
    const o = parseOptions([]);
    expect(o).toMatchObject({ tasks: ["rename-column", "wrong-number"], tag: "local", maxTurns: 60, timeoutMs: 20 * 60_000, keep: false, list: false });
    expect(o.out.endsWith(join("evals", "results"))).toBe(true);
    expect(parseOptions(["wrong-number", "--tag", "p2-gate", "--model", "opus", "--max-turns", "30", "--timeout-min", "5", "--keep"]))
      .toMatchObject({ tasks: ["wrong-number"], tag: "p2-gate", model: "opus", maxTurns: 30, timeoutMs: 300_000, keep: true });
    expect(() => parseOptions(["no-such-task"])).toThrow(/no task named no-such-task/);
    expect(() => parseOptions(["--tag", "../x"])).toThrow(/--tag/);
    expect(() => parseOptions(["--max-turns", "0"])).toThrow(/--max-turns/);
    expect(() => parseOptions(["--bogus"])).toThrow();
  });

  test("resultsBase: <date>-<tag>, numbered when taken", () => {
    const out = tempDir();
    const day = new Date(2026, 8, 24, 12);
    expect(resultsBase(out, "local", day)).toBe(join(out, "2026-09-24-local"));
    writeFileSync(join(out, "2026-09-24-local.json"), "{}");
    expect(resultsBase(out, "local", day)).toBe(join(out, "2026-09-24-local-2"));
    mkdirSync(join(out, "2026-09-24-local-2"));
    expect(resultsBase(out, "local", day)).toBe(join(out, "2026-09-24-local-3"));
  });
});

describe("findClaude", () => {
  test("skips a shell-script shim named claude for the real executable after it on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "croft-findclaude-"));
    try {
      const shim = join(dir, "shim"), real = join(dir, "real");
      mkdirSync(shim); mkdirSync(real);
      writeFileSync(join(shim, "claude"), "#!/usr/bin/env bash\nexec claude \"$@\"\n", { mode: 0o755 });
      writeFileSync(join(real, "claude"), "\x7fELF binary", { mode: 0o755 });
      expect(findClaude({ PATH: `${shim}:${real}` })).toBe(join(real, "claude"));
      expect(findClaude({ PATH: shim })).toBe(join(shim, "claude"));
      expect(findClaude({ PATH: shim, CROFT_EVAL_CLAUDE: "/x/claude" })).toBe("/x/claude");
      expect(findClaude({ PATH: "" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agentEnv with CROFT_EVAL_INHERIT_ENV=1", () => {
  test("inherits the calling environment minus session markers and croft settings; croft's own values win", () => {
    const env = agentEnv("/bin-dir", {
      CROFT_EVAL_INHERIT_ENV: "1", HOME: "/h", PATH: "/usr/local/bin", SOME_PROXY_TOKEN: "t", CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s", CMUX_CLAUDE_PID: "9", CROFT_NOW: "2026-01-01T00:00:00Z", TZ: "UTC",
    });
    expect(env.SOME_PROXY_TOKEN).toBe("t");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CMUX_CLAUDE_PID).toBeUndefined();
    expect(env.CROFT_NOW).toBeUndefined();
    expect(env.CROFT_FORBID_OS_JOBS).toBe("1");
    expect(env.TZ).toBe(FIXTURE_TZ);
    expect(env.PATH!.startsWith("/bin-dir:")).toBe(true);
  });

  test("without it, nothing outside the list is inherited", () => {
    expect(agentEnv("/bin-dir", { HOME: "/h", SOME_PROXY_TOKEN: "t" }).SOME_PROXY_TOKEN).toBeUndefined();
  });
});
