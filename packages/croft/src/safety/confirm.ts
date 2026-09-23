// Confirmation tokens (DESIGN.md §6 "How confirmation works"). Off a TTY a destructive command
// stops with exit 5 and a token instead of acting; `croft confirm <token>` then recomputes the
// impact and refuses with CONFIRMATION_STALE if it changed. Consent is tied to the impact the
// user was shown: a token is single-use, expires after 15 minutes, and stores a hash of the impact.
//
// A token reaches the command that acts only from `croft confirm`: in its own process through the CLI's
// Dispatch (never argv), and for a detached run through a one-time grant (grantDetached/redeemGrant below).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Confirmation, Impact } from "../core/types.ts";
import { logDir } from "../history/logs.ts";
import type { RunsDb } from "../history/runs-db.ts";

export const CONFIRMATION_TTL_MS = 15 * 60_000;
/** Spent and expired tokens are kept a day, so a late `croft confirm` says "expired", not "unknown". */
const KEEP_MS = 24 * 60 * 60_000;
const TOKEN = /^c_[0-9a-f]{6}$/;

export type RecomputeImpact = (stored: { command: string; impact: Impact }) => Impact | Promise<Impact>;
export type StaleReason = "expired" | "impact_changed" | "used";

interface Row { token: string; command: string; impact: string; impact_hash: string; created_at: string;
  expires_at: string; used_at: string | null }

/**
 * Hash of what the user agreed to. It covers what the action does (asset, action, rows,
 * downstream, estimated requests), not bookkeeping that differs on every computation: trashPath
 * embeds a timestamp and bytes shifts with compaction, so including them would make every token stale.
 */
export function impactHash(impact: Impact): string {
  const material = {
    asset: impact.asset,
    action: impact.action,
    rows: impact.rows,
    downstream: [...impact.downstream].sort(),
    estimatedRequests: impact.estimatedRequests ?? null,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function notFound(token: string): CroftError {
  return new CroftError("USAGE_ERROR", {
    message: `no confirmation ${JSON.stringify(token)} exists in this project`,
    hint: "run the destructive command again to get a token; tokens look like c_7f3a9e",
  });
}

function summarize(i: Impact): string {
  const reqs = i.estimatedRequests !== undefined ? `, ~${i.estimatedRequests} requests` : "";
  const down = i.downstream.length ? `; then ${i.downstream.join(", ")}` : "";
  return `${i.action} ${i.asset}: ${i.rows} rows${reqs}${down}`;
}

export class Confirmations {
  constructor(private readonly db: RunsDb) {}

  /** Store a token for `command` with its impact. Returned as the envelope's `confirmation`. */
  create(c: { command: string; impact: Impact }): Confirmation {
    const now = this.db.now();
    const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString();
    const hash = impactHash(c.impact);
    const insert = this.db.sqlite.query(
      `INSERT INTO confirmations (token, command, impact, impact_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (token) DO NOTHING`,
    );
    return this.db.transaction(() => {
      this.db.sqlite.query("DELETE FROM confirmations WHERE expires_at < ?").run(new Date(now.getTime() - KEEP_MS).toISOString());
      // 24 bits of token: a collision is rare but possible, so retry instead of overwriting.
      for (;;) {
        const token = `c_${randomBytes(3).toString("hex")}`;
        const res = insert.run(token, c.command, JSON.stringify(c.impact), hash, now.toISOString(), expiresAt);
        if (res.changes === 1) return { token, expiresAt, command: c.command, impact: c.impact };
      }
    });
  }

  /** A stored confirmation, without consuming it (for `croft confirm` to show what it will do). */
  get(token: string): (Confirmation & { usedAt: string | null; createdAt: string }) | null {
    const row = this.row(token);
    if (!row) return null;
    return { token: row.token, expiresAt: row.expires_at, command: row.command, impact: JSON.parse(row.impact) as Impact,
      usedAt: row.used_at, createdAt: row.created_at };
  }

  /**
   * Spend a token. Recomputes the impact and returns the stored command to carry out. Throws
   * CONFIRMATION_STALE (with the new impact in details) when the token was used, has expired, or
   * the impact changed; a stale token is spent too, since its consent no longer applies. If
   * `recomputeImpact` itself throws, the token is left unspent so the user can retry.
   */
  async consume(token: string, recomputeImpact: RecomputeImpact): Promise<Confirmation> {
    const row = this.row(token);
    if (!row) throw notFound(token);
    const stored = { command: row.command, impact: JSON.parse(row.impact) as Impact };
    if (row.used_at !== null) throw this.stale(row, stored.impact, null, "used");

    const expired = Date.parse(row.expires_at) <= this.db.now().getTime();
    let current: Impact | null;
    try {
      current = await recomputeImpact(stored);
    } catch (e) {
      if (!expired) throw e;   // unspent: a transient failure should not burn the user's consent
      current = null;          // expired anyway; report it without the new impact
    }
    const reason: StaleReason | null = expired ? "expired"
      : impactHash(current!) !== row.impact_hash ? "impact_changed" : null;

    // Claim atomically: of two concurrent `croft confirm`s only one sees changes === 1.
    const claimed = this.db.sqlite
      .query("UPDATE confirmations SET used_at = ? WHERE token = ? AND used_at IS NULL")
      .run(this.db.nowIso(), token).changes === 1;
    if (!claimed) throw this.stale(this.row(token)!, stored.impact, current, "used");
    if (reason) throw this.stale(row, stored.impact, current, reason);
    return { token, expiresAt: row.expires_at, command: row.command, impact: stored.impact };
  }

  /**
   * A token `croft confirm` may still carry out, checked before anything runs: USAGE_ERROR when it does not
   * exist, CONFIRMATION_STALE when it was used or has expired (without recomputing the impact, since the
   * stored command must not run at all). Not spent here: the command spends it with consume() where it acts.
   */
  usable(token: string): Confirmation {
    const row = this.row(token);
    if (!row) throw notFound(token);
    const impact = JSON.parse(row.impact) as Impact;
    if (row.used_at !== null) throw this.stale(row, impact, null, "used");
    if (Date.parse(row.expires_at) <= this.db.now().getTime()) throw this.stale(row, impact, null, "expired");
    return { token, expiresAt: row.expires_at, command: row.command, impact };
  }

  /**
   * Spend a token whose command ran to the end without reaching its confirmation: nothing destructive was
   * left to do (the source recovered, say), so it ran as a plain command. The token is spent anyway, like a
   * used one, so it can never run the command a second time. False when it was already spent.
   */
  spendUnused(token: string): boolean {
    if (!TOKEN.test(token)) return false;
    return this.db.sqlite.query("UPDATE confirmations SET used_at = ? WHERE token = ? AND used_at IS NULL")
      .run(this.db.nowIso(), token).changes === 1;
  }

  private row(token: string): Row | null {
    if (!TOKEN.test(token)) return null;
    return this.db.sqlite.query("SELECT * FROM confirmations WHERE token = ?").get(token) as Row | null;
  }

  private stale(row: Row, previous: Impact, current: Impact | null, reason: StaleReason): CroftError {
    const message = {
      used: `confirmation ${row.token} was already used${row.used_at ? ` at ${row.used_at}` : ""}`,
      expired: `confirmation ${row.token} expired at ${row.expires_at} (tokens last 15 minutes)`,
      impact_changed: `the impact changed since it was shown: now ${current ? summarize(current) : "?"} (was ${summarize(previous)})`,
    }[reason];
    return new CroftError("CONFIRMATION_STALE", {
      message,
      hint: `nothing was changed; run \`${row.command}\` again for a new token, show the user the new impact, and confirm only after an explicit yes`,
      asset: previous.asset,
      effect: "nothing was changed",
      fix: { kind: "command", description: "get a new token for the current impact", command: row.command },
      details: { reason, token: row.token, command: row.command, impact: current, previousImpact: previous,
        expiresAt: row.expires_at, usedAt: row.used_at },
    });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Handing a confirmation to a detached run

/** Carries a grant's secret to the detached child of a confirmed run. Only that child reads it (it also has
 *  --run-id and --detached); every other croft process ignores it and never passes it on. */
export const CONFIRM_GRANT_ENV = "CROFT_CONFIRM_GRANT";
const GRANT_FILE = "confirm-grant.json";

interface Grant { token: string; runId: string; hash: string }

const sha256 = (text: string): Buffer => createHash("sha256").update(text).digest();

/**
 * Off a TTY a confirmed run detaches like any other run (§5), so its token has to reach another process.
 * `croft confirm`, which holds the token in its own process (the CLI's Dispatch, never argv), writes a grant
 * for the run id it picked: the token and the hash of a random secret, next to the run's logs. The secret
 * goes to the child in its environment (CONFIRM_GRANT_ENV) and is never printed. No command line creates a
 * grant, and a value typed into the environment matches no hash croft wrote. Returns the secret.
 */
export function grantDetached(stateDir: string, runId: string, token: string): string {
  const secret = randomBytes(24).toString("hex");
  const dir = logDir(stateDir, runId);
  mkdirSync(dir, { recursive: true });
  const grant: Grant = { token, runId, hash: sha256(secret).toString("hex") };
  writeFileSync(join(dir, GRANT_FILE), JSON.stringify(grant), { mode: 0o600, flag: "wx" });
  return secret;
}

/**
 * The detached child's side: the token its grant carries. The grant file is removed before it is checked,
 * so it works once. USAGE_ERROR when this run has no grant or the secret does not match: a destructive
 * action is carried out only through `croft confirm <token>`.
 */
export function redeemGrant(stateDir: string, runId: string, secret: string): string {
  const path = join(logDir(stateDir, runId), GRANT_FILE);
  let grant: Partial<Grant> | null = null;
  try {
    grant = JSON.parse(readFileSync(path, "utf8")) as Partial<Grant>;
  } catch { /* missing or unreadable: refused below */ }
  rmSync(path, { force: true });
  const hash = typeof grant?.hash === "string" && /^[0-9a-f]{64}$/.test(grant.hash) ? Buffer.from(grant.hash, "hex") : null;
  if (!grant || !hash || grant.runId !== runId || typeof grant.token !== "string" || !TOKEN.test(grant.token)
    || !timingSafeEqual(hash, sha256(secret))) {
    throw new CroftError("USAGE_ERROR", {
      message: `run ${runId} has no confirmation grant that matches ${CONFIRM_GRANT_ENV}`,
      hint: `${CONFIRM_GRANT_ENV} is croft's own; a destructive action runs only through croft confirm <token>`,
    });
  }
  return grant.token;
}
