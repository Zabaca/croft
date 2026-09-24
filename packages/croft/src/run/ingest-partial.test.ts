// Monotone partial commits through a real run (DESIGN.md §8 "Large first loads"), and EMPTY_EXTRACT (§3a): a cursor
// ingest against a mock API, run the way `croft run --foreground` runs it, with PARTIAL_COMMIT shrunk so a handful of
// rows makes several parts. The kill between two partial commits is a real SIGKILL of a child croft process
// (CROFT_FAULT). The load half (the order check, the cut into parts) is in load/partial.test.ts.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Problem, StepResult } from "../core/types.ts";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { getCatalog } from "../history/catalog.ts";
import { RunsDb } from "../history/runs-db.ts";
import { PARTIAL_COMMIT, PARTIAL_COMMIT_MS, PARTIAL_COMMIT_ROWS } from "../load/partial.ts";
import { cleanupProjects, makeProject, PKG, runIn } from "./testkit.ts";

interface Ev { id: number; ts: string; [k: string]: unknown }

const state = {
  rows: [] as Ev[],
  /** /pages serves these in order; "fail" answers 401. */
  pages: [] as (Ev[] | "fail")[],
  /** /asc answers 401 from this request on (0: never). */
  failAt: 0,
  requests: 0,
  /** /asc answers [] (a revoked token that still gets 200). */
  empty: false,
  log: [] as { path: string; query: Record<string, string> }[],
};

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const byTs = (a: Ev, b: Ev) => Date.parse(a.ts) - Date.parse(b.ts) || a.id - b.id;

const server: Server<undefined> = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    const q = Object.fromEntries(u.searchParams);
    state.log.push({ path: u.pathname, query: q });
    const per = Number(q.per_page ?? 2);
    const page = Number(q.page ?? 1);
    switch (u.pathname) {
      case "/asc": {
        // Ascending by ts, `since` inclusive, numbered pages.
        state.requests++;
        if (state.failAt && state.requests >= state.failAt) return new Response("token expired", { status: 401 });
        if (state.empty) return json([]);
        const rows = [...state.rows].sort(byTs).filter((r) => q.since === undefined || Date.parse(r.ts) >= Date.parse(q.since));
        return json(rows.slice((page - 1) * per, page * per));
      }
      case "/desc": {
        // Newest first, as Stripe lists.
        const rows = [...state.rows].sort(byTs).reverse();
        return json(rows.slice((page - 1) * per, page * per));
      }
      case "/epoch": {
        // Newest first, epoch seconds, like Stripe's charges.
        if (state.empty) return json([]);
        return json([...state.rows].sort(byTs).reverse().map((r) => ({ id: r.id, created: Date.parse(r.ts) / 1000 })));
      }
      case "/pages": {
        const p = state.pages[page - 1] ?? [];
        return p === "fail" ? new Response("token expired", { status: 401 }) : json(p);
      }
      default:
        return new Response("not found", { status: 404 });
    }
  },
});
const api = `http://127.0.0.1:${server.port}`;

beforeEach(() => {
  Object.assign(state, { rows: [], pages: [], failAt: 0, requests: 0, empty: false, log: [] });
});
afterEach(() => {
  PARTIAL_COMMIT.rows = PARTIAL_COMMIT_ROWS;
  PARTIAL_COMMIT.ms = PARTIAL_COMMIT_MS;
});
afterAll(async () => {
  server.stop(true);
  await closeAllWarehouses();
  cleanupProjects();
});

/** Instant 2026-09-01T00:00:0<i>Z; `offset` writes it at +01:00 instead, which sorts differently as text. */
const at = (i: number, offset = false) => (offset ? `2026-09-01T01:00:${String(i).padStart(2, "0")}+01:00` : `2026-09-01T00:00:${String(i).padStart(2, "0")}Z`);
const events = (n: number, o: { offset?: (i: number) => boolean } = {}) =>
  Array.from({ length: n }, (_, k) => ({ id: k + 1, ts: at(k + 1, o.offset?.(k + 1) ?? false), n: k + 1 }));

const pagedIngest = (path: string, o: { incremental?: string; extra?: string; key?: string | null } = {}) => `import { ingest } from "@zabaca/croft";
type Ev = { id: number; ts: string };
export default ingest({
  ${o.key === null ? `write: "append",` : `key: "${o.key ?? "id"}",`}
  incremental: ${o.incremental ?? `"ts"`},${o.extra ?? ""}
  async *rows({ since, http }) {
    for (let page = 1; ; page++) {
      const rows = (await http.get("${api}${path}", { query: { per_page: 2, page, since } })).json<Ev[]>();
      yield rows;
      if (rows.length < 2) return;
    }
  },
});
`;

/** The /pages source: every page until an empty one (a page that is not full does not end it). */
const pagesIngest = () => `import { ingest } from "@zabaca/croft";
type Ev = { id: number; ts: string };
export default ingest({
  key: "id",
  incremental: "ts",
  async *rows({ http }) {
    for (let page = 1; ; page++) {
      const rows = (await http.get("${api}/pages", { query: { page } })).json<Ev[]>();
      if (rows.length === 0) return;
      yield rows;
    }
  },
});
`;

async function sql<T = Record<string, unknown>>(root: string, text: string): Promise<T[]> {
  await closeAllWarehouses();
  const db = await DuckDBInstance.create(join(root, "warehouse.duckdb"), { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    return (await c.runAndReadAll(text)).getRowObjectsJS() as T[];
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

function withRuns<T>(root: string, fn: (db: RunsDb) => T): T {
  const db = RunsDb.open(join(root, ".croft"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const writesOf = (root: string) =>
  sql<{ rows_in: number; cursor_after: string | null }>(root, `SELECT rows_in::INTEGER AS rows_in, cursor_after FROM _croft.writes WHERE asset = 'events' ORDER BY loaded_at`);
const cursorOf = async (root: string) => (await sql<{ c: string | null }>(root, `SELECT cursor_value AS c FROM _croft.assets WHERE name = 'events'`))[0]?.c ?? null;
const countOf = async (root: string) => Number((await sql<{ n: number }>(root, `SELECT count(*)::INTEGER AS n FROM events`))[0]!.n);
const step = (out: { data: { steps: StepResult[] } }) => out.data.steps.find((s) => s.asset === "events")!;
const sinceOf = (path: string) => state.log.filter((l) => l.path === path).map((l) => l.query.since ?? null);

describe("monotone partial commits", () => {
  test("rows in cursor order commit every PARTIAL_COMMIT.rows rows, with the cursor at each part's typed maximum", async () => {
    PARTIAL_COMMIT.rows = 2;
    // Even ids are written at +01:00: later instants that sort earlier as text.
    state.rows = events(7, { offset: (i) => i % 2 === 0 });
    const root = makeProject({ "assets/events.ts": pagedIngest("/asc") });
    const out = await runIn(root, ["events"]);
    expect(out.exit).toBe(0);
    const s = step(out);
    expect(s.status).toBe("ok");
    expect(s.rows).toEqual({ in: 7, added: 7, updated: 0, unchanged: 0, deleted: 0, total: 7 });
    expect(s.reason).toContain("saved in 4 commits as ts arrived in order");
    expect(s.cursor).toMatchObject({ after: at(7) });
    expect(s.created).toBeDefined();
    // Three parts committed on the way, each with the typed maximum of its rows; the last part is the ordinary write.
    expect(await writesOf(root)).toEqual([
      { rows_in: 2, cursor_after: at(2, true) },
      { rows_in: 2, cursor_after: at(4, true) },
      { rows_in: 2, cursor_after: at(6, true) },
      { rows_in: 1, cursor_after: at(7) },
    ]);
    expect(await countOf(root)).toBe(7);
    withRuns(root, (db) => {
      expect(getCatalog(db, "events")).toMatchObject({ rows: 7, cursor: { field: "ts", value: at(7) } });
      const [run] = db.listRuns();
      expect(db.stepsFor(run!.id)[0]).toMatchObject({ status: "ok", added: 7 });
    });
    expect(existsSync(join(root, ".croft", "staging", out.data.runId))).toBe(false);
  }, 30_000);

  test("an append ingest commits in parts too", async () => {
    PARTIAL_COMMIT.rows = 4;
    state.rows = events(7);
    const root = makeProject({ "assets/events.ts": pagedIngest("/asc", { key: null }) });
    const out = await runIn(root, ["events"]);
    expect(out.exit).toBe(0);
    expect((await writesOf(root)).map((w) => w.rows_in)).toEqual([4, 3]);
    expect(await countOf(root)).toBe(7);
    expect(await cursorOf(root)).toBe(at(7));
  }, 30_000);

  test("every PARTIAL_COMMIT.ms too", async () => {
    PARTIAL_COMMIT.ms = 0;
    state.rows = events(5);
    const root = makeProject({ "assets/events.ts": pagedIngest("/asc") });
    const out = await runIn(root, ["events"]);
    expect(out.exit).toBe(0);
    expect((await writesOf(root)).map((w) => w.rows_in)).toEqual([2, 2, 1, 0]);
    expect(step(out).rows.total).toBe(5);
  }, 30_000);

  test("a small load commits once, as before, and its reason says nothing about parts", async () => {
    state.rows = events(7);
    const root = makeProject({ "assets/events.ts": pagedIngest("/asc") });
    const out = await runIn(root, ["events"]);
    expect(out.exit).toBe(0);
    expect(await writesOf(root)).toEqual([{ rows_in: 7, cursor_after: at(7) }]);
    expect(step(out).reason).not.toContain("commit");
  }, 30_000);

  test("newest first keeps one transaction, and the step's reason says why", async () => {
    PARTIAL_COMMIT.rows = 2;
    state.rows = events(7);
    const root = makeProject({ "assets/events.ts": pagedIngest("/desc") });
    const out = await runIn(root, ["events"]);
    expect(out.exit).toBe(0);
    expect(await writesOf(root)).toEqual([{ rows_in: 7, cursor_after: at(7) }]);
    const reason = step(out).reason;
    expect(reason).toContain("saved in one commit");
    expect(reason).toContain(`ts arrived out of order (${at(6)} after ${at(7)})`);
  }, 30_000);

  test("a failure after two commits keeps them; the next run continues from the cursor they saved", async () => {
    PARTIAL_COMMIT.rows = 2;
    state.rows = events(7);
    state.failAt = 3;
    const root = makeProject({ "assets/events.ts": pagedIngest("/asc") });
    const first = await runIn(root, ["events"], { retryDelaysMs: [] });
    expect(first.exit).toBe(1);
    const p = first.problems.find((x) => x.code === "HTTP_ERROR")!;
    expect(p.effect).toBe(`4 rows from 2 earlier commits were saved, with ts up to ${at(4)}; the next run continues from there`);
    expect(p.details).toMatchObject({ savedRows: 4, savedCommits: 2, cursor: at(4) });
    expect(await countOf(root)).toBe(4);
    expect(await cursorOf(root)).toBe(at(4));
    withRuns(root, (db) => expect(getCatalog(db, "events")).toMatchObject({ rows: 4, cursor: { value: at(4) } }));

    state.failAt = 0;
    state.log = [];
    const next = await runIn(root, ["events"]);
    expect(next.exit).toBe(0);
    // From the saved cursor, minus the 1 s a keyed timestamp cursor re-reads.
    expect(sinceOf("/asc")[0]).toBe(at(3));
    expect(await countOf(root)).toBe(7);
    expect(await cursorOf(root)).toBe(at(7));
  }, 30_000);

  test("a blocking check runs on each part: a part that fails it rolls back alone, the parts before it stay", async () => {
    PARTIAL_COMMIT.rows = 2;
    state.rows = events(7);
    const root = makeProject({ "assets/events.ts": pagedIngest("/asc", { extra: `\n  checks: ["id <> 3"],` }) });
    const out = await runIn(root, ["events"], { retryDelaysMs: [] });
    expect(out.exit).toBe(3);
    const p = out.problems.find((x) => x.code === "CHECK_FAILED")!;
    expect(p.effect).toContain("2 rows from 1 earlier commit were saved");
    expect(await countOf(root)).toBe(2);
    expect(await cursorOf(root)).toBe(at(2));
  }, 30_000);

  test("min_rows waits for the last part, when the table holds the whole load", async () => {
    PARTIAL_COMMIT.rows = 2;
    state.rows = events(7);
    const ok = makeProject({ "assets/events.ts": pagedIngest("/asc", { extra: `\n  checks: ["min_rows(5)"],` }) });
    expect((await runIn(ok, ["events"])).exit).toBe(0);
    expect(await countOf(ok)).toBe(7);

    const short = makeProject({ "assets/events.ts": pagedIngest("/asc", { extra: `\n  checks: ["min_rows(10)"],` }) });
    const out = await runIn(short, ["events"], { retryDelaysMs: [] });
    expect(out.exit).toBe(3);
    expect(out.problems.find((x) => x.code === "CHECK_FAILED")!.effect).toContain("6 rows from 3 earlier commits were saved");
    expect(await countOf(short)).toBe(6);
  }, 30_000);

  test("a part the typing refuses rolls back alone: TYPE_CONFLICT keeps the parts before it", async () => {
    PARTIAL_COMMIT.rows = 2;
    state.rows = events(7);
    state.rows[4]!.n = "five";
    const root = makeProject({ "assets/events.ts": pagedIngest("/asc") });
    const out = await runIn(root, ["events"], { retryDelaysMs: [] });
    expect(out.exit).not.toBe(0);
    const p = out.problems.find((x) => x.code === "TYPE_CONFLICT")!;
    expect(p.effect).toContain("4 rows from 2 earlier commits were saved");
    expect(await countOf(root)).toBe(4);
  }, 30_000);

  test("the order breaks after commits: the saved cursor goes back at once, so a failure before the end loses nothing", async () => {
    PARTIAL_COMMIT.rows = 2;
    const [e1, e2, e3, e4] = events(4);
    const e0 = { id: 10, ts: "2026-08-31T23:59:59Z", n: 0 };
    state.pages = [[e1!, e2!], [e3!, e4!], [e0], "fail"];
    const root = makeProject({ "assets/events.ts": pagesIngest() });
    const first = await runIn(root, ["events"], { retryDelaysMs: [] });
    expect(first.exit).toBe(1);
    // Two parts committed, then a value older than the cursor they saved: it went back to where the run began
    // (nothing, a first load), so the next run fetches everything again instead of skipping the rows before it.
    expect(await countOf(root)).toBe(4);
    expect(await cursorOf(root)).toBeNull();
    withRuns(root, (db) => expect(getCatalog(db, "events")!.cursor!.value).toBeNull());
    const p = first.problems.find((x) => x.code === "HTTP_ERROR")!;
    expect(p.effect).toContain("4 rows from 2 earlier commits were saved");
    expect(p.effect).toContain("ts stopped arriving in order");
    expect(p.effect).toContain("the next run fetches from the start again");

    // A run that finishes keeps the highest cursor any part saved, not the maximum of its last part.
    state.pages = [[e1!, e2!], [e3!, e4!], [e0]];
    const next = await runIn(root, ["events"]);
    expect(next.exit).toBe(0);
    expect(await cursorOf(root)).toBe(at(4));
    expect(await countOf(root)).toBe(5);
    const s = step(next);
    expect(s.reason).toContain(`saved in 3 commits: ts stopped arriving in order at row 5 (${e0.ts} after ${at(4)})`);
    expect(s.cursor).toMatchObject({ after: at(4) });
  }, 30_000);

  test("after a break, a last part that reaches higher sets the cursor itself", async () => {
    PARTIAL_COMMIT.rows = 2;
    const [e1, e2, e3, e4, , , , , e9] = events(9);
    const e0 = { id: 10, ts: "2026-08-31T23:59:59Z", n: 0 };
    state.pages = [[e1!, e2!], [e3!, e4!], [e0], [e9!]];
    const root = makeProject({ "assets/events.ts": pagesIngest() });
    const out = await runIn(root, ["events"]);
    expect(out.exit).toBe(0);
    expect(await cursorOf(root)).toBe(at(9));
    expect((await writesOf(root)).map((w) => w.cursor_after)).toEqual([at(2), at(4), at(9)]);
  }, 30_000);

  test("--from after the saved cursor holds it there through every part (§8)", async () => {
    state.rows = events(3);
    const root = makeProject({ "assets/events.ts": pagedIngest("/asc") });
    expect((await runIn(root, ["events"])).exit).toBe(0);
    state.rows = events(9);
    PARTIAL_COMMIT.rows = 2;
    const out = await runIn(root, ["events"], { from: at(6) });
    expect(out.exit).toBe(0);
    expect(step(out).rows).toMatchObject({ in: 4, added: 4, total: 7 });
    expect((await writesOf(root)).slice(1).map((w) => w.cursor_after)).toEqual([at(3), at(3), at(3)]);
    expect(await cursorOf(root)).toBe(at(3));
  }, 30_000);
});

describe("a kill between two partial commits (CROFT_FAULT)", () => {
  test("the parts committed before the kill stay, with their cursor; the next run reconciles and resumes from it", async () => {
    state.rows = events(7);
    const root = makeProject({ "assets/events.ts": pagedIngest("/asc") });
    const script = join(root, "child.ts");
    const src = (p: string) => JSON.stringify(join(PKG, "src", p));
    writeFileSync(script, `
import { PARTIAL_COMMIT } from ${src("load/partial.ts")};
import { main } from ${src("cli/main.ts")};
PARTIAL_COMMIT.rows = 2;
await main(["run", "events", "--foreground", "--json"], {
  cwd: ${JSON.stringify(root)}, env: { CROFT_FAULT: "after_partial_commit_2", HOME: ${JSON.stringify(root)} },
  stdinTTY: false, stdoutTTY: false, stderrTTY: false,
});
console.log("finished without the fault");
`);
    const child = spawn(process.execPath, ["--no-env-file", script], {
      cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    const [code, signal] = await new Promise<[number | null, string | null]>((r) => child.on("exit", (c, s) => r([c, s])));
    expect({ code, signal, output }).toMatchObject({ code: null, signal: "SIGKILL" });
    // Killed after the second part committed, before the third: two parts are in, with the cursor they saved.
    expect(await countOf(root)).toBe(4);
    expect(await cursorOf(root)).toBe(at(4));
    const deadId = withRuns(root, (db) => {
      expect(getCatalog(db, "events")).toMatchObject({ rows: 4, cursor: { value: at(4) } });
      return db.listRuns()[0]!.id;
    });
    expect(state.log.filter((l) => l.path === "/asc")).toHaveLength(2);

    state.log = [];
    const next = await runIn(root, ["events"]);
    expect(next.exit).toBe(0);
    expect(sinceOf("/asc")[0]).toBe(at(3));
    expect(await countOf(root)).toBe(7);
    expect(await cursorOf(root)).toBe(at(7));
    withRuns(root, (db) => {
      expect(db.getRun(deadId)!.status).toBe("crashed");
      expect(db.stepsFor(deadId)[0]).toMatchObject({ status: "ok" });
      expect(db.stepsFor(deadId)[0]!.reason).toContain("recovered: 2 commits");
    });
    expect(existsSync(join(root, ".croft", "staging", deadId))).toBe(false);
  }, 60_000);
});

describe("EMPTY_EXTRACT", () => {
  const lookback = `{ field: "ts", lookback: "1 day" }`;

  test("an ingest with a lookback gets no rows although its window held rows last time: a warning, the run succeeds", async () => {
    state.rows = events(3);
    const root = makeProject({ "assets/events.ts": pagedIngest("/asc", { incremental: lookback }) });
    expect((await runIn(root, ["events"])).exit).toBe(0);
    state.empty = true;
    const out = await runIn(root, ["events"]);
    expect(out.exit).toBe(0);
    expect(step(out).status).toBe("ok");
    const w = out.problems.find((p) => p.code === "EMPTY_EXTRACT") as Problem;
    expect(w).toMatchObject({
      severity: "warning", asset: "events",
      fix: { kind: "command", command: "croft logs events" },
      details: { field: "ts", since: "2026-08-31T00:00:03Z", windowRows: 3 },
    });
    expect(w.message).toBe("events returned no rows, but 3 of its rows have ts at or after 2026-08-31T00:00:03Z, the start of its lookback window: last time that window held rows");
    expect(w.hint).toContain("revoked or expired token");
    expect(w.hint).toContain("changed filter");
    expect(await countOf(root)).toBe(3);
  }, 30_000);

  test("an epoch cursor's window is counted in its own numbers", async () => {
    state.rows = events(4);
    const root = makeProject({ "assets/events.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  incremental: { field: "created", unit: "s", lookback: "30 days" },
  async *rows({ http }) {
    yield (await http.get("${api}/epoch")).json<{ id: number; created: number }[]>();
  },
});
` });
    expect((await runIn(root, ["events"])).exit).toBe(0);
    state.empty = true;
    const out = await runIn(root, ["events"]);
    const w = out.problems.find((p) => p.code === "EMPTY_EXTRACT")!;
    const saved = Date.parse(at(4)) / 1000;
    expect(w.details).toMatchObject({ field: "created", since: String(saved - 30 * 86_400), windowRows: 4, lastRows: { rows: 4 } });
  }, 30_000);

  test("not without a lookback, not on a first load, not with --from, and not when rows came", async () => {
    state.rows = events(3);
    const plain = makeProject({ "assets/events.ts": pagedIngest("/asc") });
    expect((await runIn(plain, ["events"])).exit).toBe(0);
    state.empty = true;
    const a = await runIn(plain, ["events"]);
    expect(a.problems.map((p) => p.code)).not.toContain("EMPTY_EXTRACT");

    const withLookback = makeProject({ "assets/events.ts": pagedIngest("/asc", { incremental: lookback }) });
    const first = await runIn(withLookback, ["events"]);
    expect(first.problems.map((p) => p.code)).not.toContain("EMPTY_EXTRACT");
    state.empty = false;
    expect((await runIn(withLookback, ["events"])).exit).toBe(0);
    const again = await runIn(withLookback, ["events"]);
    expect(again.problems.map((p) => p.code)).not.toContain("EMPTY_EXTRACT");
    state.empty = true;
    const from = await runIn(withLookback, ["events"], { from: "2026-08-01" });
    expect(from.exit).toBe(0);
    expect(from.problems.map((p) => p.code)).not.toContain("EMPTY_EXTRACT");
  }, 30_000);
});
