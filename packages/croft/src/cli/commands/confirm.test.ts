import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RunsDb } from "../../history/runs-db.ts";
import { Confirmations } from "../../safety/confirm.ts";
import type { Command } from "../command.ts";
import { dispatchOf, shellQuote } from "../main.ts";
import { CONFIRMABLE, confirmArgv, splitCommand } from "./confirm.ts";
import { COMMANDS } from "./index.ts";
import { cleanup, cli, makeProject, runsDb } from "./inspect-testkit.ts";

// Test commands, registered only here, that carry out a confirmation like run does: croft confirm hands them
// the token through the Dispatch (never argv).
beforeAll(() => {
  for (const n of ["zap", "lax", "sloppy", "flaky"]) CONFIRMABLE.add(n);
});
afterAll(() => {
  for (const n of ["zap", "lax", "sloppy", "flaky"]) CONFIRMABLE.delete(n);
  cleanup();
});

// A destructive command: without a token it returns a confirmation; with one it revalidates through
// Confirmations.consume() and then "deletes" the rows.
let rowsNow = 265;
let zapCalls = 0;
let zapped: { asset: string; force: boolean; token: string }[] = [];
beforeEach(() => {
  rowsNow = 265;
  zapCalls = 0;
  zapped = [];
});

const ZAP: Command<{ zapped: string; rows: number } | null> = {
  name: "zap",
  summary: "test: delete an asset's rows",
  usage: "croft zap <asset> [--force]",
  options: {
    force: { type: "boolean", description: "test flag that must survive the round trip" },
  },
  maxPositionals: 1,
  async run(ctx) {
    zapCalls++;
    const asset = ctx.positionals[0]!;
    const db = RunsDb.open(ctx.project.paths.stateDir);
    try {
      const confirms = new Confirmations(db);
      const impact = () => ({ asset, action: "delete", rows: rowsNow, downstream: ["zone_trips"] });
      const token = dispatchOf(ctx)?.confirmToken;
      if (token === undefined) {
        ctx.render.out(`needs confirmation: ${asset} would lose ${rowsNow} rows`);
        return { data: null, problems: [], next: [], confirmation: confirms.create({ command: `croft zap ${asset} --force`, impact: impact() }) };
      }
      await confirms.consume(token, () => impact());
      zapped.push({ asset, force: ctx.values.force === true, token });
      return { data: { zapped: asset, rows: rowsNow }, problems: [], next: [{ command: "croft status", reason: "see what is left" }] };
    } finally {
      db.close();
    }
  },
  human(result) {
    return result.data ? `ok    ${result.data.zapped}   ${result.data.rows} rows deleted` : undefined;
  },
};

// A command that never reaches its confirmation (nothing destructive left to do) and says nothing about it.
const LAX: Command = {
  name: "lax", summary: "test", usage: "croft lax", options: {},
  async run() {
    return { data: { done: true }, problems: [], next: [] };
  },
};

// A command that trashes rows without spending its token: croft's bug, which confirm must report.
const SLOPPY: Command = {
  name: "sloppy", summary: "test", usage: "croft sloppy", options: {},
  async run() {
    return { data: { steps: [{ asset: "x", status: "ok", trashed: { path: "t", rows: 1 } }] }, problems: [], next: [] };
  },
};

// A command that fails before it reaches its confirmation.
let flakyCalls = 0;
const FLAKY: Command = {
  name: "flaky", summary: "test", usage: "croft flaky", options: {},
  async run() {
    flakyCalls++;
    return { data: { steps: [] }, problems: [], next: [], ok: false, exit: 1 };
  },
};

const COMMANDS_PLUS = [...COMMANDS, ZAP, LAX, SLOPPY, FLAKY];

async function tokenFor(root: string, asset = "taxi_zones"): Promise<string> {
  const r = await cli(["zap", asset, "--json"], { cwd: root, commands: COMMANDS_PLUS });
  expect(r.exit).toBe(5);
  zapCalls = 0;
  return r.json.confirmation.token as string;
}

function stored(root: string, command: string): string {
  const db = runsDb(`${root}/.croft`);
  try {
    return new Confirmations(db).create({ command, impact: { asset: "x", action: "delete", rows: 1, downstream: [] } }).token;
  } finally {
    db.close();
  }
}

function usedAt(stateDir: string, token: string): string | null | undefined {
  const db = runsDb(stateDir);
  try {
    return new Confirmations(db).get(token)?.usedAt;
  } finally {
    db.close();
  }
}

describe("croft confirm", () => {
  test("carries out the stored command with the token, and the command revalidates it (golden JSON)", async () => {
    const p = makeProject();
    const token = await tokenFor(p.root);
    expect(zapped).toEqual([]);
    const r = await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({
      ok: true, command: "confirm",
      data: { token, command: "croft zap taxi_zones --force", result: { zapped: "taxi_zones", rows: 265 }, outcome: "used" },
      problems: [], next: [{ command: "croft status", reason: "see what is left" }],
    });
    expect(Object.keys(r.json.data)).toEqual(["token", "command", "result", "outcome"]);
    expect(zapped).toEqual([{ asset: "taxi_zones", force: true, token }]);
    expect(usedAt(p.stateDir, token)).not.toBeNull();
  });

  test("a token works once: a second confirm is CONFIRMATION_STALE, and the stored command does not run again", async () => {
    const p = makeProject();
    const token = await tokenFor(p.root);
    expect((await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS })).exit).toBe(0);
    expect(zapCalls).toBe(1);
    const again = await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(again.exit).toBe(5);
    expect(again.json.problems[0]).toMatchObject({ code: "CONFIRMATION_STALE", details: { reason: "used" } });
    expect(zapCalls).toBe(1);
    expect(zapped).toHaveLength(1);
  });

  test("a changed impact is CONFIRMATION_STALE with the new impact, and nothing happens", async () => {
    const p = makeProject();
    const token = await tokenFor(p.root);
    rowsNow = 300;   // the scheduler added rows meanwhile
    const r = await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(r.exit).toBe(5);
    expect(r.json.ok).toBe(false);
    expect(r.json.problems[0]).toMatchObject({
      code: "CONFIRMATION_STALE", effect: "nothing was changed",
      details: { reason: "impact_changed", impact: { rows: 300 }, previousImpact: { rows: 265 } },
      fix: { kind: "command", command: "croft zap taxi_zones --force" },
    });
    expect(r.json.data).toEqual({ token, command: "croft zap taxi_zones --force", result: null, outcome: "used" });
    expect(zapped).toEqual([]);
  });

  test("an expired token is CONFIRMATION_STALE before the stored command runs at all", async () => {
    const p = makeProject();
    const token = await tokenFor(p.root);
    const db = runsDb(p.stateDir);
    db.sqlite.query("UPDATE confirmations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token = ?").run(token);
    db.close();
    const r = await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(r.exit).toBe(5);
    expect(r.json.problems[0]).toMatchObject({ code: "CONFIRMATION_STALE", details: { reason: "expired", impact: null, previousImpact: { rows: 265 } } });
    expect(zapCalls).toBe(0);
    expect(zapped).toEqual([]);
  });

  test("human mode prints the confirmed command's own output", async () => {
    const p = makeProject();
    const token = await tokenFor(p.root);
    const r = await cli(["confirm", token], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("ok    taxi_zones   265 rows deleted\nnext: croft status  # see what is left\n");
    rowsNow = 1;
    const token2 = await tokenFor(p.root);
    rowsNow = 2;
    const stale = await cli(["confirm", token2], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(stale.exit).toBe(5);
    expect(stale.stdout).toBe("");
    expect(stale.stderr).toContain("error CONFIRMATION_STALE");
  });

  test("an unknown or malformed token is a usage error; so is none", async () => {
    const p = makeProject();
    const unknown = await cli(["confirm", "c_000000", "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(unknown.exit).toBe(2);
    expect(unknown.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", message: 'no confirmation "c_000000" exists in this project' });
    await tokenFor(p.root);
    expect((await cli(["confirm", "nonsense", "--json"], { cwd: p.root, commands: COMMANDS_PLUS })).json.problems[0].code).toBe("USAGE_ERROR");
    expect((await cli(["confirm", "--json"], { cwd: p.root, commands: COMMANDS_PLUS })).json.problems[0].code).toBe("USAGE_ERROR");
    expect(zapCalls).toBe(0);
  });

  test("the token never travels on a command line: the confirmed command gets it only through the Dispatch", async () => {
    const p = makeProject();
    const token = await tokenFor(p.root);
    const r = await cli(["zap", "taxi_zones", "--confirm-token", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0].message).toBe("croft zap has no option --confirm-token");
    expect(zapCalls).toBe(0);
    expect(usedAt(p.stateDir, token)).toBeNull();
  });

  test("a command that no longer needs its confirmation: its own result plus a note; the token is spent anyway", async () => {
    const p = makeProject();
    const token = stored(p.root, "croft lax");
    const r = await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ ok: true, problems: [], data: { token, command: "croft lax", result: { done: true }, outcome: "not_needed" } });
    expect(r.json.data.note).toBe(`croft lax did not need confirmation ${token}: nothing destructive was left to do, so it ran as a plain command. The token is spent.`);
    expect(usedAt(p.stateDir, token)).not.toBeNull();
    const again = await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(again.json.problems[0]).toMatchObject({ code: "CONFIRMATION_STALE", details: { reason: "used" } });

    const human = await cli(["confirm", stored(p.root, "croft lax")], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(human.exit).toBe(0);
    expect(human.stdout).toContain("note: croft lax did not need confirmation");
  });

  test("a command that failed before its confirmation leaves the token valid, and says so", async () => {
    const p = makeProject();
    const token = stored(p.root, "croft flaky");
    flakyCalls = 0;
    const r = await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(r.exit).toBe(1);
    expect(r.json.data).toMatchObject({ outcome: "unused" });
    expect(r.json.data.note).toContain("the token was not used and stays valid until");
    expect(usedAt(p.stateDir, token)).toBeNull();
    expect((await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS })).json.data.outcome).toBe("unused");
    expect(flakyCalls).toBe(2);
  });

  test("a stored command that takes no confirmation, or acts without spending it, is reported as croft's bug", async () => {
    const p = makeProject();
    const status = stored(p.root, "croft status");
    const a = await cli(["confirm", status, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(a.json.problems[0]).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(a.json.problems[0].message).toContain("croft status takes no confirmation");
    const sloppy = stored(p.root, "croft sloppy");
    const b = await cli(["confirm", sloppy, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(b.exit).toBe(1);
    expect(b.json.problems[0].message).toBe(`croft sloppy acted without spending confirmation ${sloppy}`);
  });
});

describe("the stored command line", () => {
  test("splitCommand reads back what shellQuote writes", () => {
    const argv = ["delete", "orders", "--where", "amount < 0 and note = 'it''s'", "", "tab\there", "a\\b", "$HOME"];
    expect(splitCommand(["croft", ...argv].map(shellQuote).join(" "))).toEqual(["croft", ...argv]);
    expect(splitCommand(`croft run "a \\"b\\" \\$c"  x\\ y`)).toEqual(["croft", "run", `a "b" $c`, "x y"]);
    expect(() => splitCommand("croft run 'open")).toThrow("unterminated");
  });

  test("confirmArgv drops croft and --json (adding --json back when confirm has it); the token is never in it", () => {
    expect(confirmArgv("croft run taxi_zones --allow-shrink", false)).toEqual(["run", "taxi_zones", "--allow-shrink"]);
    expect(confirmArgv("croft run x --json", true)).toEqual(["run", "x", "--json"]);
    expect(confirmArgv("croft run x -- y --json", true)).toEqual(["run", "x", "--json", "--", "y", "--json"]);
    expect(() => confirmArgv("rm -rf /", false)).toThrow("not a croft command");
  });
});
