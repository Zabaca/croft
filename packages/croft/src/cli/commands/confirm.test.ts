import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { RunsDb } from "../../history/runs-db.ts";
import { Confirmations } from "../../safety/confirm.ts";
import type { Command } from "../command.ts";
import { shellQuote } from "../main.ts";
import { confirmArgv, splitCommand } from "./confirm.ts";
import { COMMANDS } from "./index.ts";
import { cleanup, cli, makeProject, runsDb } from "./inspect-testkit.ts";

afterAll(() => cleanup());

// A destructive command registered only in this test: off a TTY it returns a confirmation token; with the
// hidden --confirm-token it revalidates through Confirmations.consume() and then "deletes" the rows.
let rowsNow = 265;
let zapped: { asset: string; force: boolean; token: string }[] = [];
beforeEach(() => {
  rowsNow = 265;
  zapped = [];
});

const ZAP: Command<{ zapped: string; rows: number } | null> = {
  name: "zap",
  summary: "test: delete an asset's rows",
  usage: "croft zap <asset> [--force]",
  options: {
    force: { type: "boolean", description: "test flag that must survive the round trip" },
    "confirm-token": { type: "string", description: "(internal) set by croft confirm" },
  },
  maxPositionals: 1,
  async run(ctx) {
    const asset = ctx.positionals[0]!;
    const db = RunsDb.open(ctx.project.paths.stateDir);
    try {
      const confirms = new Confirmations(db);
      const impact = () => ({ asset, action: "delete", rows: rowsNow, downstream: ["zone_trips"] });
      const token = ctx.values["confirm-token"];
      if (typeof token !== "string") {
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

// A command that takes a token but never checks it: croft confirm must catch that bug.
const LAX: Command = {
  name: "lax", summary: "test", usage: "croft lax", options: { "confirm-token": { type: "string", description: "" } },
  async run() {
    return { data: { done: true }, problems: [], next: [] };
  },
};

const COMMANDS_PLUS = [...COMMANDS, ZAP, LAX];

async function tokenFor(root: string, asset = "taxi_zones"): Promise<string> {
  const r = await cli(["zap", asset, "--json"], { cwd: root, commands: COMMANDS_PLUS });
  expect(r.exit).toBe(5);
  return r.json.confirmation.token as string;
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
      data: { token, command: "croft zap taxi_zones --force", result: { zapped: "taxi_zones", rows: 265 } },
      problems: [], next: [{ command: "croft status", reason: "see what is left" }],
    });
    expect(Object.keys(r.json.data)).toEqual(["token", "command", "result"]);
    expect(zapped).toEqual([{ asset: "taxi_zones", force: true, token }]);
    const db = runsDb(p.stateDir);
    expect(new Confirmations(db).get(token)!.usedAt).not.toBeNull();
    db.close();
  });

  test("a token works once: a second confirm is CONFIRMATION_STALE", async () => {
    const p = makeProject();
    const token = await tokenFor(p.root);
    expect((await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS })).exit).toBe(0);
    const again = await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(again.exit).toBe(5);
    expect(again.json.problems[0]).toMatchObject({ code: "CONFIRMATION_STALE", details: { reason: "used" } });
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
    expect(r.json.data).toEqual({ token, command: "croft zap taxi_zones --force", result: null });
    expect(zapped).toEqual([]);
  });

  test("an expired token is CONFIRMATION_STALE with the current impact", async () => {
    const p = makeProject();
    const token = await tokenFor(p.root);
    const db = runsDb(p.stateDir);
    db.sqlite.query("UPDATE confirmations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token = ?").run(token);
    db.close();
    const r = await cli(["confirm", token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(r.exit).toBe(5);
    expect(r.json.problems[0]).toMatchObject({ code: "CONFIRMATION_STALE", details: { reason: "expired", impact: { rows: 265 } } });
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
  });

  test("a stored command that takes no confirmation, or never checks it, is reported as croft's bug", async () => {
    const p = makeProject();
    const db = runsDb(p.stateDir);
    const c = new Confirmations(db);
    const impact = { asset: "x", action: "delete", rows: 1, downstream: [] };
    const status = c.create({ command: "croft status", impact });
    const lax = c.create({ command: "croft lax", impact });
    db.close();
    const a = await cli(["confirm", status.token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(a.json.problems[0]).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(a.json.problems[0].message).toContain("croft status takes no confirmation");
    const b = await cli(["confirm", lax.token, "--json"], { cwd: p.root, commands: COMMANDS_PLUS });
    expect(b.json.problems[0].message).toBe(`croft lax ran without checking confirmation ${lax.token}`);
  });
});

describe("the stored command line", () => {
  test("splitCommand reads back what shellQuote writes", () => {
    const argv = ["delete", "orders", "--where", "amount < 0 and note = 'it''s'", "", "tab\there", "a\\b", "$HOME"];
    expect(splitCommand(["croft", ...argv].map(shellQuote).join(" "))).toEqual(["croft", ...argv]);
    expect(splitCommand(`croft run "a \\"b\\" \\$c"  x\\ y`)).toEqual(["croft", "run", `a "b" $c`, "x y"]);
    expect(() => splitCommand("croft run 'open")).toThrow("unterminated");
  });

  test("confirmArgv drops croft, --json and an old token, and adds this one", () => {
    expect(confirmArgv("croft run taxi_zones --allow-shrink", "c_abcdef", false)).toEqual(["run", "taxi_zones", "--allow-shrink", "--confirm-token", "c_abcdef"]);
    expect(confirmArgv("croft run x --json --confirm-token c_111111", "c_abcdef", true)).toEqual(["run", "x", "--confirm-token", "c_abcdef", "--json"]);
    expect(confirmArgv("croft run x --confirm-token=c_111111 -- y", "c_abcdef", false)).toEqual(["run", "x", "--confirm-token", "c_abcdef", "--", "y"]);
    expect(() => confirmArgv("rm -rf /", "c_abcdef", false)).toThrow("not a croft command");
  });
});
