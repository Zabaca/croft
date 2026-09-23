// Confirmation tokens (DESIGN.md §6 "How confirmation works"). Off a TTY a destructive command
// stops with exit 5 and a token instead of acting; `croft confirm <token>` then recomputes the
// impact and refuses with CONFIRMATION_STALE if it changed. Consent is tied to the impact the
// user was shown: a token is single-use, expires after 15 minutes, and stores a hash of the impact.
import { createHash, randomBytes } from "node:crypto";
import { CroftError } from "../core/errors.ts";
import type { Confirmation, Impact } from "../core/types.ts";
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
    if (!row) {
      throw new CroftError("USAGE_ERROR", {
        message: `no confirmation ${JSON.stringify(token)} exists in this project`,
        hint: "run the destructive command again to get a token; tokens look like c_7f3a9e",
      });
    }
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
