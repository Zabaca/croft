// Building blocks for task verifiers. A verifier reads the project through `croft query` (never the DuckDB file
// directly) and compares with numbers computed from the fixture's own data.
//
// Two views of a transform are checked:
// - warehouse: the table the agent left built;
// - code: what the project's SQL computes now, run as one query in which each SQL asset of the chain becomes a
//   CTE over the raw ingest tables. It tells "fixed the SQL but never ran it" from "did not fix it", and it is
//   what the self-test can check before this croft builds transforms.
//
// An ingest's code is checked through croft's own account of it (`describe`, `validate`, `schedule status`), and
// where it matters by running it: a verifier may change the mock API and run the ingest itself, after the checks
// that read what the session left. The session's checks read its score (the croft commands it ran, whether it
// touched .env, its last message to the user).
import { type Fixture, FIXTURE_TZ, type Verdict, type VerifyCheck } from "./harness.ts";
import { type Score, scoreTranscript, type StreamEvent } from "./score.ts";

/** Run one check: ok unless it throws; the error message is the detail. */
export async function check(name: string, kind: VerifyCheck["kind"], fn: () => Promise<string | void> | string | void): Promise<VerifyCheck> {
  try {
    const detail = await fn();
    return { name, kind, ok: true, detail: detail ?? "" };
  } catch (e) {
    return { name, kind, ok: false, detail: (e as Error).message };
  }
}

export function verdict(checks: VerifyCheck[]): Verdict {
  return { pass: checks.length > 0 && checks.every((c) => c.ok), checks };
}

/**
 * An SQL asset's text without a trailing `;` (and the comments and blank space after it), so it can sit inside
 * parentheses. Strings, quoted names and comments are skipped while looking for it.
 */
export function sqlBody(text: string): string {
  let lastCode = -1; // index of the last character outside comments and whitespace
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        const k = text.indexOf(c, j);
        if (k < 0) {
          j = text.length;
          break;
        }
        if (text[k + 1] === c) {
          j = k + 2;
          continue;
        }
        j = k + 1;
        break;
      }
      lastCode = j - 1;
      i = j;
    } else {
      if (!/\s/.test(c)) lastCode = i;
      i++;
    }
  }
  if (lastCode >= 0 && text[lastCode] === ";") return sqlBody(text.slice(0, lastCode));
  return text;
}

/**
 * One SELECT that computes `select` over the project's SQL assets as they are now: `WITH a AS (<a's SQL>), b AS
 * (<b's SQL>) <select>`. List the assets in dependency order; each reads the raw tables and the CTEs before it.
 */
export function composeSql(f: Fixture, assets: readonly string[], select: string): string {
  const ctes = assets.map((name) => {
    const rel = `assets/${name}.sql`;
    if (!f.exists(rel)) throw new Error(`${rel} is missing`);
    return `"${name}" AS (\n${sqlBody(f.read(rel))}\n)`;
  });
  return `WITH ${ctes.join(",\n")}\n${select}`;
}

/** A number of cents from a dollar value croft returned (DOUBLE, DECIMAL as number or text). */
export function cents(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v));
  if (!Number.isFinite(n)) throw new Error(`not a number: ${JSON.stringify(v)}`);
  return Math.round(n * 100);
}

/** Throws unless every name is among the columns. */
export function needColumns(table: string, columns: readonly string[], names: readonly string[]): void {
  const missing = names.filter((n) => !columns.includes(n));
  if (missing.length) throw new Error(`${table} has no column ${missing.join(", ")} (columns: ${columns.join(", ")})`);
}

/** Throws unless the rows are equal, in order; the message names the first difference. */
export function sameRows<T>(label: string, actual: readonly T[], expected: readonly T[]): string {
  const a = actual.map((r) => JSON.stringify(r));
  const e = expected.map((r) => JSON.stringify(r));
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) {
      throw new Error(`${label}: row ${i + 1} is ${a[i] ?? "missing"}, expected ${e[i] ?? "no row"} (${actual.length} rows, expected ${expected.length})`);
    }
  }
  return `${actual.length} rows as expected`;
}

/** Throws unless every listed file has the text it had when the session started. */
export function unchanged(f: Fixture, files: readonly string[]): string {
  const changed = files.filter((rel) => !f.exists(rel) || f.read(rel) !== f.originals.get(rel));
  if (changed.length) throw new Error(`changed: ${changed.join(", ")}`);
  return `${files.length} files unchanged`;
}

/**
 * `croft <args> --json` run by the harness: the envelope's data. Throws the first error problem (`CODE: message`)
 * when croft refuses or fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function croftData(f: Fixture, args: readonly string[]): Promise<Record<string, any>> {
  const r = await f.croft([...args, "--json"]);
  const env = r.json;
  if (!env || env.ok !== true || r.code !== 0) {
    const p = env?.problems?.find((x: { severity?: string }) => x.severity === "error") ?? env?.problems?.[0];
    const what = `croft ${args.join(" ")}`;
    throw new Error(p ? `${what}: ${p.code}: ${p.message}` : `${what} failed (exit ${r.code}): ${r.stderr.slice(0, 500) || r.stdout.slice(0, 500)}`);
  }
  return env.data ?? {};
}

/** Throws unless `croft status` calls the project healthy with no asset failed or stale. A transform whose last
 *  attempt was skipped (up to date, or its input failed and wrote nothing) is fine. */
export async function healthy(f: Fixture): Promise<string> {
  const s = await croftData(f, ["status"]);
  type Row = { asset: string; status: string; stale: boolean; lastRun?: { code?: string | null } | null };
  const bad = ((s.assets ?? []) as Row[]).filter((a) => a.status === "failed" || a.stale);
  if (s.healthy !== true || bad.length) {
    throw new Error(`not healthy: ${bad.map((a) => `${a.asset} ${a.status}${a.stale ? " (stale)" : ""}${a.lastRun?.code ? ` ${a.lastRun.code}` : ""}`).join(", ") || "status says so"}`);
  }
  return "healthy";
}

/** A small deterministic PRNG (mulberry32), for fixture data that is the same on every machine. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The day (YYYY-MM-DD) an instant (epoch milliseconds) falls on in the fixture's zone. */
export function localDay(epochMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FIXTURE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochMs));
}

/** A wall time in the fixture's zone (YYYY-MM-DD, HH:MM:SS) as an ISO instant with that zone's offset then. */
export function localTime(day: string, time: string): string {
  // The offset at noon UTC of that day is the day's offset except in the small hours of a DST change.
  const probe = new Date(`${day}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: FIXTURE_TZ, timeZoneName: "longOffset" }).formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const offset = name === "GMT" ? "+00:00" : name.slice(3);
  return `${day}T${time}${offset}`;
}

/** A day as croft returns it (a DATE, or a timestamp at midnight with the project offset) as YYYY-MM-DD. */
export function dayOf(v: unknown): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  if (!m) throw new Error(`not a day: ${JSON.stringify(v)}`);
  return m[1]!;
}

const DURATION_UNITS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, wk: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

/** A duration as croft writes one ("30 days", "2 weeks", "36h") in milliseconds; null when unreadable. */
export function durationMs(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(text);
  const unit = m ? DURATION_UNITS[m[2]!.toLowerCase()] : undefined;
  return m && unit !== undefined ? Math.round(Number(m[1]) * unit) : null;
}

/** The session's score; throws when the verifier was given none. */
export function needSession(session: Score | null | undefined): Score {
  if (!session) throw new Error("no session transcript to check");
  return session;
}

/** What a task's self-test (tasks/tasks.test.ts) holds its verifier to, without claude. */
export interface SelfTest {
  /** The secret the fixture writes to .env. */
  secret: { name: string; value: string };
  /** The assets the fixture's first run built. */
  built: readonly string[];
  /** The kinds of check that fail on the untouched fixture, verified without a session. */
  untouched: readonly VerifyCheck["kind"][];
  /** Plausible wrong solutions, applied in this order to one fixture before the scripted solution. */
  wrong: readonly WrongSolution[];
  /** The session verified with the wrong solutions and the scripted one: what a good agent ran and said. */
  session: Score;
  /** Files the scripted solution's diff touches (none for a backfill). */
  diff: readonly string[];
}

export interface WrongSolution {
  what: string;
  /** Tried on a fixture of its own, when what it does cannot be undone on the shared one. */
  fresh?: boolean;
  /** Edit files, run croft: what the wrong solution does to the fixture. */
  apply(f: Fixture): Promise<void>;
  /** The session to verify with; SelfTest.session when left out. */
  session?: Score;
  /** The names of exactly the checks that must fail. */
  fails: readonly string[];
  /** What the failing checks' details say, together. */
  detail: RegExp;
}

/** For self-tests: the score of a session that ran these Bash commands, one tool call each, and ended with this
 *  reply. */
export function scriptedSession(commands: readonly string[], reply: string): Score {
  const events: StreamEvent[] = [{ type: "system", subtype: "init", model: "scripted" }];
  commands.forEach((command, i) => {
    events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command } }] } });
    events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "" }] } });
  });
  events.push({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
  events.push({ type: "result", subtype: "success", num_turns: commands.length + 1, result: reply, permission_denials: [] });
  return scoreTranscript(events);
}
