import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Impact } from "../core/types.ts";
import { RunsDb } from "../history/runs-db.ts";
import { CONFIRMATION_TTL_MS, Confirmations, grantDetached, impactHash, redeemGrant } from "./confirm.ts";

let dir: string;
let clock: number;
let db: RunsDb;
let confirms: Confirmations;

const COMMAND = "croft run taxi_zones --allow-shrink";
const impact = (over: Partial<Impact> = {}): Impact => ({
  asset: "taxi_zones", action: "replace", rows: 265, bytes: 18_000,
  trashPath: ".croft/trash/taxi_zones/2026-09-22T1140.duckdb", downstream: ["zone_trips"], ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "croft-confirm-"));
  clock = Date.parse("2026-09-22T18:40:00.000Z");
  db = RunsDb.open(dir, { now: () => new Date(clock) });
  confirms = new Confirmations(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function stale(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CroftError);
    expect((e as CroftError).code).toBe("CONFIRMATION_STALE");
    expect((e as CroftError).exit).toBe(5);
    return e as CroftError;
  }
  throw new Error("expected CONFIRMATION_STALE");
}

describe("create", () => {
  test("returns a c_ + 6 hex token valid for 15 minutes and stores a hash of the impact", () => {
    const c = confirms.create({ command: COMMAND, impact: impact() });
    expect(c.token).toMatch(/^c_[0-9a-f]{6}$/);
    expect(c.expiresAt).toBe("2026-09-22T18:55:00.000Z");
    expect(c).toMatchObject({ command: COMMAND, impact: impact() });
    const row = db.sqlite.query("SELECT * FROM confirmations WHERE token = ?").get(c.token) as Record<string, string | null>;
    expect(row).toMatchObject({ command: COMMAND, impact_hash: impactHash(impact()), created_at: "2026-09-22T18:40:00.000Z",
      expires_at: "2026-09-22T18:55:00.000Z", used_at: null });
    expect(JSON.parse(row.impact!)).toEqual(impact());
    expect(confirms.get(c.token)).toMatchObject({ token: c.token, usedAt: null, impact: impact() });
  });

  test("tokens are distinct", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => confirms.create({ command: COMMAND, impact: impact() }).token));
    expect(tokens.size).toBe(100);
  });

  test("old tokens are cleaned up after a day, not before", () => {
    const old = confirms.create({ command: COMMAND, impact: impact() });
    clock += CONFIRMATION_TTL_MS + 60_000;
    confirms.create({ command: COMMAND, impact: impact() });
    expect(confirms.get(old.token)).not.toBeNull();   // still explains "expired"
    clock += 24 * 60 * 60_000;
    confirms.create({ command: COMMAND, impact: impact() });
    expect(confirms.get(old.token)).toBeNull();
  });
});

describe("impact hash", () => {
  test("ignores trash path, bytes and downstream order; covers what the action does", () => {
    const base = impactHash(impact({ downstream: ["a", "b"] }));
    expect(impactHash(impact({ downstream: ["b", "a"], trashPath: "elsewhere", bytes: 1 }))).toBe(base);
    expect(impactHash(impact({ downstream: ["a", "b"], rows: 266 }))).not.toBe(base);
    expect(impactHash(impact({ downstream: ["a", "b"], action: "delete" }))).not.toBe(base);
    expect(impactHash(impact({ downstream: ["a"] }))).not.toBe(base);
    expect(impactHash(impact({ downstream: ["a", "b"], estimatedRequests: 10 }))).not.toBe(base);
  });
});

describe("consume", () => {
  test("an unchanged impact returns the command, once", async () => {
    const c = confirms.create({ command: COMMAND, impact: impact() });
    let calls = 0;
    const recompute = (s: { command: string; impact: Impact }) => {
      calls++;
      expect(s).toEqual({ command: COMMAND, impact: impact() });
      return impact({ trashPath: "a new timestamped path", bytes: 18_432 });
    };
    clock += 60_000;
    expect(await confirms.consume(c.token, recompute)).toEqual({ token: c.token, expiresAt: c.expiresAt, command: COMMAND, impact: impact() });
    expect(confirms.get(c.token)?.usedAt).toBe("2026-09-22T18:41:00.000Z");

    const err = await stale(confirms.consume(c.token, recompute));
    expect(calls).toBe(1);   // a used token is refused before recomputing
    expect(err.message).toContain("was already used at 2026-09-22T18:41:00.000Z");
    expect(err.problem.details).toMatchObject({ reason: "used", token: c.token, impact: null });
  });

  test("a changed impact is stale, carries the new impact, and spends the token", async () => {
    const c = confirms.create({ command: COMMAND, impact: impact() });
    const now = impact({ rows: 300, downstream: ["zone_trips", "trip_stats"] });
    const err = await stale(confirms.consume(c.token, () => now));
    expect(err.message).toBe("the impact changed since it was shown: now replace taxi_zones: 300 rows; then zone_trips, trip_stats "
      + "(was replace taxi_zones: 265 rows; then zone_trips)");
    expect(err.problem).toMatchObject({
      asset: "taxi_zones", effect: "nothing was changed",
      fix: { kind: "command", command: COMMAND },
      details: { reason: "impact_changed", token: c.token, command: COMMAND, impact: now, previousImpact: impact() },
    });
    expect((await stale(confirms.consume(c.token, () => impact()))).problem.details).toMatchObject({ reason: "used" });
  });

  test("an expired token is stale with the recomputed impact, even if nothing changed", async () => {
    const c = confirms.create({ command: COMMAND, impact: impact() });
    clock += CONFIRMATION_TTL_MS - 1;
    const early = confirms.create({ command: COMMAND, impact: impact() });
    clock += 1;   // exactly 15 minutes after c
    const err = await stale(confirms.consume(c.token, async () => impact({ rows: 280 })));
    expect(err.message).toContain(`confirmation ${c.token} expired at 2026-09-22T18:55:00.000Z`);
    expect(err.problem.details).toMatchObject({ reason: "expired", impact: impact({ rows: 280 }), previousImpact: impact() });
    expect(confirms.get(c.token)?.usedAt).not.toBeNull();
    // one created a millisecond later is still valid
    expect((await confirms.consume(early.token, () => impact())).token).toBe(early.token);
  });

  test("an expired token whose impact cannot be recomputed is still reported as expired", async () => {
    const c = confirms.create({ command: COMMAND, impact: impact() });
    clock += CONFIRMATION_TTL_MS + 1;
    const err = await stale(confirms.consume(c.token, () => { throw new Error("asset gone"); }));
    expect(err.problem.details).toMatchObject({ reason: "expired", impact: null });
  });

  test("a failed recompute leaves a valid token unspent", async () => {
    const c = confirms.create({ command: COMMAND, impact: impact() });
    const busy = new CroftError("DB_BUSY", { message: "locked", hint: "wait" });
    await expect(confirms.consume(c.token, () => { throw busy; })).rejects.toBe(busy);
    expect(confirms.get(c.token)?.usedAt).toBeNull();
    expect((await confirms.consume(c.token, () => impact())).command).toBe(COMMAND);
  });

  test("unknown and malformed tokens are usage errors", async () => {
    for (const t of ["c_000000", "c_7F3A9E", "7f3a9e", "c_7f3a9e; rm -rf /", ""]) {
      try {
        await confirms.consume(t, () => impact());
        throw new Error("expected a usage error");
      } catch (e) {
        expect((e as CroftError).code).toBe("USAGE_ERROR");
      }
    }
  });

  test("two concurrent confirms (separate connections, as from two processes): exactly one wins", async () => {
    const c = confirms.create({ command: COMMAND, impact: impact() });
    const otherDb = RunsDb.open(dir, { now: () => new Date(clock) });
    const other = new Confirmations(otherDb);
    // Both recompute before either claims, which is the racy window.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const recompute = async () => {
      if (++arrived === 2) release();
      await gate;
      return impact();
    };
    const results = await Promise.allSettled([confirms.consume(c.token, recompute), other.consume(c.token, recompute)]);
    otherDb.close();
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as CroftError).problem.details).toMatchObject({ reason: "used" });
  });
});

describe("usable (croft confirm's check before anything runs)", () => {
  test("a live token is returned without being spent", () => {
    const c = confirms.create({ command: COMMAND, impact: impact() });
    expect(confirms.usable(c.token)).toMatchObject({ token: c.token, command: COMMAND, impact: { rows: 265 } });
    expect(confirms.get(c.token)?.usedAt).toBeNull();
  });

  test("used and expired tokens are CONFIRMATION_STALE without recomputing anything; unknown ones are usage errors", async () => {
    const used = confirms.create({ command: COMMAND, impact: impact() });
    await confirms.consume(used.token, () => impact());
    expect((await stale((async () => confirms.usable(used.token))())).problem.details).toMatchObject({ reason: "used", impact: null });
    const old = confirms.create({ command: COMMAND, impact: impact() });
    clock += CONFIRMATION_TTL_MS;
    const e = await stale((async () => confirms.usable(old.token))());
    expect(e.problem.details).toMatchObject({ reason: "expired", impact: null, previousImpact: { rows: 265 } });
    expect(confirms.get(old.token)?.usedAt).toBeNull();
    expect(() => confirms.usable("c_000000")).toThrow("no confirmation");
    expect(() => confirms.usable("nonsense")).toThrow("no confirmation");
  });
});

describe("spendUnused (a confirmed command that never reached its confirmation)", () => {
  test("spends a live token once, so it cannot be carried out again", async () => {
    const c = confirms.create({ command: COMMAND, impact: impact() });
    expect(confirms.spendUnused(c.token)).toBe(true);
    expect(confirms.spendUnused(c.token)).toBe(false);
    expect(confirms.get(c.token)?.usedAt).toBe("2026-09-22T18:40:00.000Z");
    expect((await stale(confirms.consume(c.token, () => impact()))).problem.details).toMatchObject({ reason: "used" });
    expect(confirms.spendUnused("nonsense")).toBe(false);
  });
});

describe("tokens for the same command do not outlive each other's use (R41-11)", () => {
  test("carrying out one token spends every other open token for the same command; another command's token stays", async () => {
    const older = confirms.create({ command: COMMAND, impact: impact() });
    clock += 60_000;
    const newer = confirms.create({ command: COMMAND, impact: impact() });
    const other = confirms.create({ command: "croft delete taxi_zones", impact: impact({ action: "delete the whole table" }) });
    clock += 60_000;
    await confirms.consume(newer.token, () => impact());
    const err = await stale(confirms.consume(older.token, () => impact()));
    expect(err.problem.details).toMatchObject({ reason: "superseded", token: older.token, supersededBy: newer.token });
    expect(err.message).toBe(`confirmation ${older.token} no longer applies: ${newer.token} carried out the same command (${COMMAND}) at 2026-09-22T18:42:00.000Z`);
    expect(() => confirms.usable(older.token)).toThrow("no longer applies");
    expect(confirms.usable(other.token).token).toBe(other.token);
  });

  test("a token spent as not needed spends the others too; a stale one does not", async () => {
    const a = confirms.create({ command: COMMAND, impact: impact() });
    const b = confirms.create({ command: COMMAND, impact: impact() });
    const c = confirms.create({ command: COMMAND, impact: impact({ rows: 300 }) });
    // a is stale (the impact is now 300 rows): b's consent is as stale, but c, minted for 300 rows, still stands.
    await stale(confirms.consume(a.token, () => impact({ rows: 300 })));
    expect(confirms.usable(c.token).token).toBe(c.token);
    expect(confirms.spendUnused(c.token)).toBe(true);
    expect((await stale(confirms.consume(b.token, () => impact()))).problem.details).toMatchObject({ reason: "superseded", supersededBy: c.token });
  });

  test("a token for a whole command line is superseded when the same action was confirmed on a terminal", async () => {
    const a = confirms.create({ command: COMMAND, impact: impact() });
    expect(confirms.supersede(COMMAND, null)).toBe(1);
    const err = await stale(confirms.consume(a.token, () => impact()));
    expect(err.message).toContain("the same command was carried out");
  });

  test("the table's generation is part of the hash, but not of the impact shown or stored", async () => {
    const shown = { ...impact(), generation: "100/-" };
    const c = confirms.create({ command: COMMAND, impact: shown });
    expect(c.impact).toEqual(impact());
    expect(confirms.get(c.token)!.impact).toEqual(impact());
    expect(impactHash(shown)).not.toBe(impactHash(impact()));
    const err = await stale(confirms.consume(c.token, () => ({ ...impact(), generation: "200/150" })));
    expect(err.problem.details).toMatchObject({ reason: "impact_changed" });
    expect(err.message).toContain("the table was written or replaced since");
    const d = confirms.create({ command: COMMAND, impact: shown });
    expect(await confirms.consume(d.token, () => ({ ...impact(), generation: "100/-" }))).toMatchObject({ token: d.token });
  });
});

describe("detached grants (croft confirm → its detached run)", () => {
  const RUN = "r_0922_1140_a1b2";

  test("the child redeems the token with the secret, once; the file holds only a hash", () => {
    const secret = grantDetached(dir, RUN, "c_7f3a9e");
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    const file = join(dir, "logs", RUN, "confirm-grant.json");
    expect(readFileSync(file, "utf8")).not.toContain(secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(redeemGrant(dir, RUN, secret)).toBe("c_7f3a9e");
    expect(existsSync(file)).toBe(false);
    expect(() => redeemGrant(dir, RUN, secret)).toThrow("no confirmation grant");
  });

  test("a wrong secret, another run's grant, or no grant at all carries nothing (and the grant is gone)", () => {
    const secret = grantDetached(dir, RUN, "c_7f3a9e");
    expect(() => redeemGrant(dir, RUN, "c_7f3a9e")).toThrow("no confirmation grant");
    expect(() => redeemGrant(dir, RUN, secret)).toThrow("no confirmation grant");
    const other = grantDetached(dir, "r_0922_1141_zzzz", "c_7f3a9e");
    expect(() => redeemGrant(dir, RUN, other)).toThrow("no confirmation grant");
    let code = "";
    try {
      redeemGrant(dir, "r_0922_1142_none", "x");
    } catch (e) {
      code = (e as CroftError).code;
    }
    expect(code).toBe("USAGE_ERROR");
  });

  test("a hand-written grant file with a made-up hash is refused", () => {
    const secret = grantDetached(dir, RUN, "c_7f3a9e");
    writeFileSync(join(dir, "logs", RUN, "confirm-grant.json"), JSON.stringify({ token: "c_7f3a9e", runId: RUN, hash: "00".repeat(32) }));
    expect(() => redeemGrant(dir, RUN, secret)).toThrow("no confirmation grant");
  });
});
