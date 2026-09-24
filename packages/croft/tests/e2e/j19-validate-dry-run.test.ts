// Journey 19: `croft validate` and `croft run --dry-run` (DESIGN §4.1, §4.2, §4.3 "validate", §5 "How commands
// behave while a run is writing", §8 "Backfills"), over the assets of DESIGN §3 written as a user would:
// GitHub and Stripe ingests against a mock API, a file ingest, the open_issues (§3c) and daily_revenue (§3d) SQL
// transforms, the issue_triage TS transform (§3e), and an SQL summary downstream of open_issues.
//
// - before the first run, validate binds nothing it cannot (INPUT_NOT_BUILT, with `croft preview` of the ingest
//   to run), and the dry run lists every step as "never built"; neither creates the warehouse or calls the API;
// - after the first run, validate binds every SQL asset (outputColumns from prepare());
// - a typo is the §4.2 JSON: UNKNOWN_COLUMN at its line and column with an edit fix, which applied as written
//   makes validate pass (and then suggest a preview of the changed asset); a typo in a `-- check:` line is
//   reported on that line; VOLATILE_SQL warns;
// - the dry-run lines of §4.2: windows (the saved cursor minus the lookback, --from echoed as an instant with the
//   project offset), rebuild/update reasons, a static error that fails a step before it runs and skips what
//   reads it, --only and --upstream, and the confirmations a real run would stop for (--allow-shrink, the cost
//   guard), without issuing a token, fetching, or recording a run;
// - validate, status and the dry run never wait while another program holds the warehouse.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { githubAsset, githubRoute, type Issue, issue, stripeAsset, TOKEN } from "./fixtures.ts";
import { cleanupAll, type Envelope, initProject, json, type MockApi, mockApi, type Project, show } from "./harness.ts";

const KEY = "sk_test_e2eStripeKey987654";
let api: MockApi;
/** The GitHub-like issues the mock serves (fixtures.ts githubRoute). */
const gh = { issues: [] as Issue[], limited: 0 };
/** Calls to the paid mock endpoint the cost-guard transform uses. */
let billed = 0;

// Six charges 12 hours apart from 2026-06-26T18:53:20Z: the saved cursor after the first run is 1782716000.
const T0 = 1_782_500_000;
const SAVED_CREATED = T0 + 5 * 43_200;
interface Charge { id: string; created: number; amount: number; amount_refunded: number; currency: string; status: string }
const charges: Charge[] = Array.from({ length: 6 }, (_, i) => ({
  id: `ch_${String(i + 1).padStart(4, "0")}`, created: T0 + i * 43_200, amount: 1001 + i, amount_refunded: i === 2 ? 500 : 0, currency: "usd", status: "succeeded",
}));

beforeAll(() => {
  api = mockApi();
  gh.issues = [1, 2, 3, 4, 5].map((n) => issue(n, n, {
    number: 100 + n, body: n === 2 ? "segfault in bun test" : null, comments: n, created_at: `2026-09-1${n}T08:00:00Z`,
    pull_request: n === 4 ? { url: "https://example.com/pulls/104" } : null,
  }));
  githubRoute(api, gh);
  // A Stripe-like list endpoint (j03): newest first, created[gte], starting_after, has_more.
  api.route("/v1/charges", (req, url) => {
    if (req.headers.get("authorization") !== `Bearer ${KEY}`) return json({ error: { message: "Invalid API Key" } }, { status: 401 });
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const gte = url.searchParams.get("created[gte]");
    const after = url.searchParams.get("starting_after");
    let rows = [...charges].sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
    if (gte !== null) rows = rows.filter((c) => c.created >= Number(gte));
    if (after !== null) rows = rows.slice(rows.findIndex((c) => c.id === after) + 1);
    return json({ object: "list", data: rows.slice(0, limit), has_more: rows.length > limit });
  });
  api.route("/v1/summarize", async (req) => {
    billed++;
    const body = await req.json() as { title: string };
    return json({ summary: `about ${body.title}` });
  });
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

// ---------------------------------------------------------------------------------------------------------
// The project: DESIGN §3's examples, verbatim where they fit the mock data.

const OPEN_ISSUES = `-- assets/open_issues.sql
-- description: Open issues (not pull requests) with author and label names
-- key: id
-- check: not_null(author)
-- warn: id IN (SELECT issue_id FROM issue_triage)
SELECT
  id,
  number,
  title,
  user->>'login'        AS author,        -- nested objects are JSON columns
  labels->>'$[*].name'  AS label_names,   -- VARCHAR[]
  comments,
  created_at
FROM github_issues
WHERE state = 'open' AND pull_request IS NULL
`;

const DAILY_REVENUE = `-- assets/daily_revenue.sql
-- description: Revenue per day (project time zone) and currency, net of refunds
-- key: day, currency
-- check: net <= gross
SELECT
  to_timestamp(created)::DATE                     AS day,        -- project time zone days
  currency,
  sum(amount) / 100.0                             AS gross,
  sum(amount_refunded) / 100.0                    AS refunded,
  (sum(amount) - sum(amount_refunded)) / 100.0    AS net
FROM stripe_charges
WHERE status = 'succeeded'
GROUP BY ALL
`;

const ISSUE_TRIAGE = `// assets/issue_triage.ts
import { transform } from "@zabaca/croft";
import { triage } from "../lib/triage.ts";

type Issue = { id: number; title: string; body: string | null; labels: { name: string }[] };

export default transform({
  description: "Priority and reason for every issue, computed in TypeScript",
  inputs: ["github_issues"],
  key: "issue_id",
  incremental: true,           // each input row is processed once; changed rows are processed again
  checks: ["priority IN ('p0', 'p1', 'p2')", "not_null(reason)"],
  async *rows({ newRows, log }) {
    let n = 0;
    for await (const issue of newRows<Issue>("github_issues")) {
      const { priority, reason } = triage(issue.title, issue.body ?? "", issue.labels.map((l) => l.name));
      yield { issue_id: issue.id, priority, reason };
      if (++n % 1000 === 0) log(\`\${n} issues triaged\`);
    }
  },
});
`;

const TRIAGE_LIB = `// lib/triage.ts
export function triage(title: string, body: string, labels: string[]) {
  if (labels.includes("crash") || /segfault|panic/i.test(title + body)) return { priority: "p0", reason: "crash" };
  if (labels.includes("bug")) return { priority: "p1", reason: "bug label" };
  return { priority: "p2", reason: "default" };
}
`;

const ISSUE_STATS = `-- description: How many issues are open, and how many comments they have
SELECT count(*) AS open_issues, sum(comments) AS comments
FROM open_issues
`;

const TAXI_ZONES = `import { ingest } from "@zabaca/croft";

export default ingest({
  description: "NYC taxi zones",
  file: "files/taxi_zones.csv",
  key: "zone_id",
});
`;

/** An incremental transform that pays for one request per issue; its cost guard trips above 3 rows. */
const issueSummaries = (base: string) => `import { transform } from "@zabaca/croft";

type Issue = { id: number; title: string };

export default transform({
  description: "A paid one-line summary of every issue",
  inputs: ["github_issues"],
  key: "issue_id",
  incremental: true,
  confirmAbove: 3,
  async *rows({ newRows, http }) {
    for await (const issue of newRows<Issue>("github_issues")) {
      const res = await http.post("${base}/v1/summarize", { json: { title: issue.title } });
      yield { issue_id: issue.id, summary: res.json<{ summary: string }>().summary };
    }
  },
});
`;

async function trackerProject(): Promise<Project> {
  const { project: p } = await initProject("tracker");
  p.remove("assets/example_sales.ts");
  p.remove("files/example_sales.csv");
  p.write("assets/github_issues.ts", githubAsset(api.url));
  p.write("assets/stripe_charges.ts", stripeAsset(api.url));
  p.write("assets/open_issues.sql", OPEN_ISSUES);
  p.write("assets/daily_revenue.sql", DAILY_REVENUE);
  p.write("assets/issue_triage.ts", ISSUE_TRIAGE);
  p.write("lib/triage.ts", TRIAGE_LIB);
  p.write("assets/issue_stats.sql", ISSUE_STATS);
  p.write("assets/taxi_zones.ts", TAXI_ZONES);
  p.write("files/taxi_zones.csv", "zone_id,borough,zone\n1,EWR,Newark Airport\n2,Queens,Jamaica Bay\n3,Bronx,Allerton\n4,Manhattan,Alphabet City\n");
  p.secret("GITHUB_TOKEN", TOKEN);
  p.secret("STRIPE_KEY", KEY);
  return p;
}

// ---------------------------------------------------------------------------------------------------------
// Helpers

type Obj = Record<string, any>;
const ORDER = ["github_issues", "issue_triage", "open_issues", "issue_stats", "stripe_charges", "daily_revenue", "taxi_zones"];

const assetOf = (env: Envelope, name: string): Obj => env.data.assets.find((a: Obj) => a.name === name);
const stepOf = (env: Envelope, asset: string): Obj => env.data.steps.find((s: Obj) => s.asset === asset);
const actions = (env: Envelope) => (env.data.steps as Obj[]).map((s) => [s.asset, s.action]);

/** The dry run's line of one asset (human output). */
function lineOf(stdout: string, asset: string): string {
  const line = stdout.split("\n").find((l) => l.split(/\s+/)[1] === asset);
  if (line === undefined) throw new Error(`no line for ${asset} in:\n${stdout}`);
  return line.replace(/\s+/g, " ");
}

/** Each asset's last run id, from status: a dry run must not record one. */
async function lastRuns(p: Project): Promise<Record<string, string | null>> {
  const st = await p.json(["status"]);
  return Object.fromEntries((st.json.data.assets as Obj[]).map((a) => [a.asset, a.lastRun?.runId ?? null]));
}

/** The 1-based line and column where `text` first appears in a file. */
function position(source: string, text: string): { line: number; column: number } {
  const lines = source.split("\n");
  const i = lines.findIndex((l) => l.includes(text));
  if (i < 0) throw new Error(`${text} is not in the file`);
  return { line: i + 1, column: lines[i]!.indexOf(text) + 1 };
}

/** Apply an edit fix exactly as written: replace `from` with `to` on its line. */
function applyFix(p: Project, fix: Obj): void {
  expect(fix.kind).toBe("edit");
  const lines = p.read(fix.file).split("\n");
  const at = fix.line - 1;
  expect(lines[at]).toContain(fix.replace.from);
  lines[at] = lines[at]!.replace(fix.replace.from, fix.replace.to);
  p.write(fix.file, lines.join("\n"));
}

let shared: Project | undefined;

// ---------------------------------------------------------------------------------------------------------
// The journey

test("journey 19a: before the first run, validate reports INPUT_NOT_BUILT and the dry run lists every step as never built", async () => {
  const p = shared = await trackerProject();

  const v = await p.json(["validate"]);
  expect(v.code, show(v)).toBe(0);
  expect(v.json).toMatchObject({ ok: true, command: "validate" });
  expect(v.json.data.order).toEqual(ORDER);
  expect(v.json.data.assets.map((a: Obj) => a.name)).toEqual(ORDER);
  expect(assetOf(v.json, "github_issues")).toEqual({ name: "github_issues", kind: "ingest", inputs: [], outputColumns: null, behavior: "merge by id", codeChanged: false });
  expect(assetOf(v.json, "issue_triage")).toMatchObject({ kind: "ts", inputs: ["github_issues"], outputColumns: null, behavior: "merge by issue_id" });
  expect(assetOf(v.json, "open_issues")).toEqual({ name: "open_issues", kind: "sql", inputs: ["github_issues"], outputColumns: null, behavior: "replace; key id", codeChanged: false });
  // Nothing has run: the SQL over the ingests (and over them, transitively) cannot be bound yet.
  const notBuilt = (v.json.problems as Obj[]).filter((x) => x.code === "INPUT_NOT_BUILT");
  expect(v.json.problems.length).toBe(notBuilt.length);
  expect(notBuilt.map((x) => [x.asset, x.severity, x.fix?.command])).toEqual([
    ["open_issues", "info", "croft preview github_issues"],
    ["issue_stats", "info", "croft preview github_issues"],
    ["daily_revenue", "info", "croft preview stripe_charges"],
  ]);
  expect(notBuilt[0]).toMatchObject({
    file: "assets/open_issues.sql", docs: "croft docs INPUT_NOT_BUILT",
    message: "columns of github_issues are unknown until it has run or been previewed; bind check skipped",
    fix: { kind: "command", command: "croft preview github_issues" },
  });
  expect(notBuilt[1]!.message).toBe("columns of open_issues are unknown until github_issues has run or been previewed; bind check skipped");

  // Human output (§4.2 layout).
  const human = await p.croft(["validate"]);
  expect(human.code, show(human)).toBe(0);
  expect(human.stdout).toMatch(/^checked 7 assets in /);
  expect(human.stdout).toMatch(/^info\s+INPUT_NOT_BUILT\s+assets\/daily_revenue\.sql$/m);
  expect(human.stdout).toContain("columns of stripe_charges are unknown until it has run or been previewed; bind check skipped");
  expect(human.stdout).toContain("next: croft preview stripe_charges");
  expect(human.stdout).toMatch(/^0 errors, 0 warnings, 3 info/m);

  // The dry run: every step, in run order, with its action and why.
  const dry = await p.json(["run", "--dry-run"]);
  expect(dry.code, show(dry)).toBe(0);
  expect(dry.json.data.dryRun).toBe(true);
  expect(dry.json.data.order).toEqual(ORDER);
  expect(actions(dry.json)).toEqual([
    ["github_issues", "fetch"], ["issue_triage", "update"], ["open_issues", "rebuild"], ["issue_stats", "rebuild"],
    ["stripe_charges", "fetch"], ["daily_revenue", "rebuild"], ["taxi_zones", "fetch"],
  ]);
  expect(stepOf(dry.json, "github_issues")).toMatchObject({ kind: "rows", reasons: ["requested", "never_built"], problems: [] });
  expect(stepOf(dry.json, "github_issues").window).toBeUndefined();
  expect(stepOf(dry.json, "open_issues")).toMatchObject({ kind: "sql", reasons: ["never_built"], reason: "never built" });
  const lines = await p.croft(["run", "--dry-run"]);
  expect(lines.code, show(lines)).toBe(0);
  expect(lineOf(lines.stdout, "github_issues")).toBe("fetch github_issues merge by id, first load: fetches everything");
  expect(lineOf(lines.stdout, "issue_triage")).toBe("update issue_triage never built");
  expect(lineOf(lines.stdout, "open_issues")).toBe("rebuild open_issues never built");
  expect(lineOf(lines.stdout, "taxi_zones")).toBe("fetch taxi_zones replace; key zone_id (nothing is written when no file changed)");
  expect(lines.stdout).toContain("dry run: 7 of 7 steps would run; nothing ran");
  // --upstream from a named transform: its never-built inputs first (and what else they feed).
  const up = await p.json(["run", "open_issues", "--upstream", "--dry-run"]);
  expect(up.code, show(up)).toBe(0);
  expect(actions(up.json)).toEqual([["github_issues", "fetch"], ["issue_triage", "update"], ["open_issues", "rebuild"], ["issue_stats", "rebuild"]]);
  expect(up.json.next).toEqual([{ command: "croft run open_issues --upstream", reason: "run it" }]);
  const only = await p.json(["run", "open_issues", "--only", "--dry-run"]);
  expect(actions(only.json)).toEqual([["open_issues", "rebuild"]]);

  // Neither touched the API or made the warehouse.
  expect(api.log).toHaveLength(0);
  expect(p.exists("warehouse.duckdb")).toBe(false);
}, 120_000);

test("journey 19b: after the first run, validate binds every SQL asset against the tables' columns", async () => {
  expect(shared).toBeDefined();
  const p = shared!;
  const run = await p.json(["run"]);
  expect(run.code, show(run)).toBe(0);
  expect(run.json.data.steps.map((s: Obj) => [s.asset, s.status])).toEqual(ORDER.map((a) => [a, "ok"]));
  expect(await p.rows("select id, author, label_names from open_issues order by id")).toEqual([
    { id: 1, author: "u1", label_names: ["bug"] }, { id: 2, author: "u2", label_names: ["bug"] },
    { id: 3, author: "u3", label_names: ["bug"] }, { id: 5, author: "u5", label_names: ["bug"] },
  ]);
  // sum() of a BIGINT is a HUGEINT, which JSON carries as a string (§4.3).
  expect(await p.rows("select * exclude (_loaded_at) from issue_stats")).toEqual([{ open_issues: 4, comments: "11" }]);
  expect((await p.rows("select priority from issue_triage where issue_id = 2"))[0]).toEqual({ priority: "p0" });
  expect(await p.rows("select day, gross, refunded, net from daily_revenue order by day")).toEqual([
    { day: "2026-06-26", gross: 20.03, refunded: 0, net: 20.03 },
    { day: "2026-06-27", gross: 20.07, refunded: 5, net: 15.07 },
    { day: "2026-06-28", gross: 20.11, refunded: 0, net: 20.11 },
  ]);

  const v = await p.json(["validate"]);
  expect(v.code, show(v)).toBe(0);
  expect(v.json.problems).toEqual([]);
  expect(v.json.next).toEqual([]);
  expect(assetOf(v.json, "open_issues")).toEqual({
    name: "open_issues", kind: "sql", inputs: ["github_issues"], behavior: "replace; key id", codeChanged: false,
    outputColumns: [
      { name: "id", type: "BIGINT" }, { name: "number", type: "BIGINT" }, { name: "title", type: "VARCHAR" },
      { name: "author", type: "VARCHAR" }, { name: "label_names", type: "VARCHAR[]" }, { name: "comments", type: "BIGINT" },
      { name: "created_at", type: "TIMESTAMPTZ" },
    ],
  });
  expect(assetOf(v.json, "issue_stats")).toMatchObject({ inputs: ["open_issues"], behavior: "replace", outputColumns: [{ name: "open_issues", type: "BIGINT" }, { name: "comments", type: "HUGEINT" }] });
  expect(assetOf(v.json, "daily_revenue").outputColumns.map((c: Obj) => c.name)).toEqual(["day", "currency", "gross", "refunded", "net"]);
  const human = await p.croft(["validate"]);
  expect(human.stdout).toMatch(/^0 errors, 0 warnings/m);
}, 120_000);

test("journey 19c: the §4.2 validate JSON: UNKNOWN_COLUMN with an edit fix that makes validate pass as written", async () => {
  expect(shared).toBeDefined();
  const p = shared!;
  // The agent adds a column, misspelled.
  p.write("assets/open_issues.sql", OPEN_ISSUES.replace("  created_at\n", "  created_at,\n  updatd_at\n"));
  const at = position(p.read("assets/open_issues.sql"), "updatd_at");
  const v = await p.json(["validate"]);
  expect(v.code, show(v)).toBe(2);
  expect(v.json).toMatchObject({ schemaVersion: 1, ok: false, command: "validate", database: "warehouse.duckdb", timezone: "America/Los_Angeles" });
  expect(v.json.data.order).toEqual(ORDER);
  expect(assetOf(v.json, "open_issues")).toEqual({
    name: "open_issues", kind: "sql", inputs: ["github_issues"], behavior: "replace; key id", outputColumns: null, codeChanged: true,
  });
  // Its reader binds against the table open_issues has now, and is fine.
  expect(assetOf(v.json, "issue_stats").outputColumns).toEqual([{ name: "open_issues", type: "BIGINT" }, { name: "comments", type: "HUGEINT" }]);
  expect(v.json.problems).toHaveLength(1);
  expect(v.json.problems[0]).toMatchObject({
    severity: "error", code: "UNKNOWN_COLUMN", asset: "open_issues", file: "assets/open_issues.sql", line: at.line, column: at.column,
    hint: 'did you mean "updated_at"?', docs: "croft docs UNKNOWN_COLUMN",
    fix: { kind: "edit", description: "fix the column name", file: "assets/open_issues.sql", line: at.line, replace: { from: "updatd_at", to: "updated_at" } },
  });
  expect(v.json.problems[0].message).toStartWith('Referenced column "updatd_at" not found');
  expect(v.json.next).toEqual([{ command: "croft validate", reason: "re-check after the edit" }]);
  const human = await p.croft(["validate"]);
  expect(human.code, show(human)).toBe(2);
  expect(human.stdout).toMatch(new RegExp(`^error\\s+UNKNOWN_COLUMN\\s+assets/open_issues\\.sql:${at.line}:${at.column}$`, "m"));
  expect(human.stdout).toContain(`fix: replace updatd_at with updated_at on line ${at.line}`);
  expect(human.stdout).toMatch(/^1 error, 0 warnings/m);
  expect(human.stdout).toContain("next: croft validate");

  // A dry run of the asset: it would fail before it runs, and the asset reading it would be skipped.
  const dry = await p.json(["run", "open_issues", "--dry-run"]);
  expect(dry.code, show(dry)).toBe(0);
  expect(actions(dry.json)).toEqual([["open_issues", "rebuild"], ["issue_stats", "skip"]]);
  expect(stepOf(dry.json, "open_issues").problems.map((x: Obj) => x.code)).toEqual(["UNKNOWN_COLUMN"]);
  expect(stepOf(dry.json, "issue_stats").skippedBecause).toBe("input open_issues would fail (UNKNOWN_COLUMN)");
  expect(dry.json.next).toEqual([{ command: "croft validate", reason: "see every problem of the project with its fix" }]);
  const dryHuman = await p.croft(["run", "open_issues", "--dry-run"]);
  expect(dryHuman.stdout).toContain(`fails before it runs: UNKNOWN_COLUMN Referenced column "updatd_at" not found`);
  expect(lineOf(dryHuman.stdout, "issue_stats")).toBe("skip issue_stats input open_issues would fail (UNKNOWN_COLUMN)");
  expect(dryHuman.stdout).toContain("dry run: 0 of 2 steps would run; nothing ran");

  // The fix, applied exactly as written, is enough; the changed asset is worth a preview now.
  applyFix(p, v.json.problems[0].fix);
  const fixed = await p.json(["validate"]);
  expect(fixed.code, show(fixed)).toBe(0);
  expect(fixed.json.problems).toEqual([]);
  expect(assetOf(fixed.json, "open_issues")).toMatchObject({ codeChanged: true });
  expect(assetOf(fixed.json, "open_issues").outputColumns.at(-1)).toEqual({ name: "updated_at", type: "TIMESTAMPTZ" });
  expect(fixed.json.next).toEqual([{ command: "croft preview open_issues", reason: "see what the changed code builds before running it" }]);

  // A misspelled column in a check is reported on its header line, where the check text has it.
  const withCheck = p.read("assets/open_issues.sql").replace("-- check: not_null(author)", "-- check: not_null(author)\n-- check: comments >= 0 AND numbr > 0");
  p.write("assets/open_issues.sql", withCheck);
  const bad = position(withCheck, "numbr");
  const c = await p.json(["validate", "open_issues"]);
  expect(c.code, show(c)).toBe(2);
  expect(c.json.data.assets.map((a: Obj) => a.name)).toEqual(["open_issues"]);
  expect(c.json.problems).toHaveLength(1);
  expect(c.json.problems[0]).toMatchObject({
    code: "UNKNOWN_COLUMN", file: "assets/open_issues.sql", line: bad.line, column: bad.column, hint: 'did you mean "number"?',
    fix: { kind: "edit", line: bad.line, replace: { from: "numbr", to: "number" } },
  });
  applyFix(p, c.json.problems[0].fix);
  expect((await p.json(["validate"])).code).toBe(0);

  // VOLATILE_SQL: a value frozen until the next rebuild is a warning, not an error.
  p.write("assets/issue_stats.sql", ISSUE_STATS.replace("sum(comments) AS comments", "sum(comments) AS comments, current_date AS as_of"));
  const vol = await p.json(["validate"]);
  expect(vol.code, show(vol)).toBe(0);
  expect(vol.json.problems.map((x: Obj) => [x.code, x.severity, x.asset, x.line])).toEqual([["VOLATILE_SQL", "warning", "issue_stats", 2]]);
  expect(assetOf(vol.json, "issue_stats").outputColumns.at(-1)).toEqual({ name: "as_of", type: "DATE" });
  p.write("assets/issue_stats.sql", ISSUE_STATS);
}, 120_000);

test("journey 19d: dry-run lines: windows, reasons, --from echoed, confirmations a run would stop for; nothing runs", async () => {
  expect(shared).toBeDefined();
  const p = shared!;
  const requests = api.log.length;
  const runsBefore = await lastRuns(p);

  const dry = await p.json(["run", "--dry-run"]);
  expect(dry.code, show(dry)).toBe(0);
  expect(actions(dry.json)).toEqual([
    ["github_issues", "fetch"], ["issue_triage", "update"], ["open_issues", "rebuild"], ["issue_stats", "rebuild"],
    ["stripe_charges", "fetch"], ["daily_revenue", "rebuild"], ["taxi_zones", "fetch"],
  ]);
  // The saved cursor minus the lookback, in the cursor's own type, and as an instant with the project offset.
  expect(stepOf(dry.json, "github_issues").window).toEqual({
    sinceValue: "2026-09-20T10:04:59Z", sinceType: "timestamp", sinceAt: "2026-09-20T03:04:59-07:00", source: "saved",
    saved: "2026-09-20T10:05:00Z", lookback: "1 second",
  });
  expect(stepOf(dry.json, "stripe_charges").window).toEqual({
    sinceValue: SAVED_CREATED - 30 * 86_400, sinceType: "integer", sinceAt: "2026-05-29T23:53:20-07:00", source: "saved",
    saved: String(SAVED_CREATED), lookback: "30 days",
  });
  expect(stepOf(dry.json, "open_issues")).toMatchObject({ reasons: ["code_changed", "input_changed"], reason: "SQL changed (assets/open_issues.sql); input github_issues may have new rows" });
  expect(stepOf(dry.json, "issue_triage")).toMatchObject({ reasons: ["input_changed"], reason: "input github_issues may have new rows (TS code unchanged)" });
  const human = await p.croft(["run", "--dry-run"]);
  expect(human.code, show(human)).toBe(0);
  expect(lineOf(human.stdout, "github_issues")).toBe("fetch github_issues merge by id, since 2026-09-20T10:04:59Z (2026-09-20T03:04:59-07:00) = saved − 1 second");
  expect(lineOf(human.stdout, "stripe_charges")).toBe(`fetch stripe_charges merge by id, since ${SAVED_CREATED - 30 * 86_400} (2026-05-29T23:53:20-07:00) = saved − 30 days`);
  expect(lineOf(human.stdout, "issue_triage")).toBe("update issue_triage input github_issues may have new rows (TS code unchanged)");
  expect(lineOf(human.stdout, "open_issues")).toBe("rebuild open_issues SQL changed (assets/open_issues.sql); input github_issues may have new rows");
  expect(lineOf(human.stdout, "daily_revenue")).toBe("rebuild daily_revenue input stripe_charges may have new rows");
  // Column alignment of §4.2: action padded to 8, then the asset.
  expect(human.stdout.split("\n")[0]).toMatch(/^fetch {4}github_issues {4}merge by id/);

  // --from converts to the cursor's type and echoes the conversion (§8: 2026-06-24 → 1782284400).
  const from = await p.json(["run", "stripe_charges", "--dry-run", "--from", "2026-06-24"]);
  expect(from.code, show(from)).toBe(0);
  expect(stepOf(from.json, "stripe_charges").window).toEqual({
    sinceValue: 1782284400, sinceType: "integer", sinceAt: "2026-06-24T00:00:00-07:00", source: "from", saved: String(SAVED_CREATED),
  });
  const fromHuman = await p.croft(["run", "stripe_charges", "--dry-run", "--from", "2026-06-24"]);
  expect(lineOf(fromHuman.stdout, "stripe_charges")).toBe("fetch stripe_charges merge by id, since 1782284400 (2026-06-24T00:00:00-07:00) from --from 2026-06-24");
  // A relative --from is read with the project clock; in a bare run the ingests it cannot apply to are skipped.
  const rel = await p.json(["run", "--dry-run", "--from", "-30d"], { env: { CROFT_NOW: "2026-09-24T12:00:00-07:00" } });
  expect(rel.code, show(rel)).toBe(0);
  expect(stepOf(rel.json, "github_issues").window).toMatchObject({ sinceValue: "2026-08-25T19:00:00Z", sinceAt: "2026-08-25T12:00:00-07:00", source: "from" });
  expect(stepOf(rel.json, "stripe_charges").window).toMatchObject({ sinceValue: 1787684400, sinceAt: "2026-08-25T12:00:00-07:00", source: "from" });
  expect(stepOf(rel.json, "taxi_zones")).toMatchObject({ action: "skip", skippedBecause: "--from applies to merge ingests" });
  // --from on a transform named exactly is refused before anything runs.
  const refused = await p.json(["run", "open_issues", "--dry-run", "--from", "2026-06-24"]);
  expect(refused.code, show(refused)).toBe(2);
  expect(refused.json.problems.map((x: Obj) => x.code)).toEqual(["BACKFILL_UNSUPPORTED"]);

  // --only and --upstream.
  const only = await p.json(["run", "open_issues", "--only", "--dry-run"]);
  expect(actions(only.json)).toEqual([["open_issues", "rebuild"]]);
  expect(only.json.next).toEqual([{ command: "croft run open_issues --only", reason: "run it" }]);
  const named = await p.json(["run", "open_issues", "--dry-run"]);
  expect(actions(named.json)).toEqual([["open_issues", "rebuild"], ["issue_stats", "rebuild"]]);
  const upstream = await p.json(["run", "issue_stats", "--upstream", "--dry-run"]);
  // Built ingests are not refetched by --upstream; the stale SQL between them is rebuilt first.
  expect(actions(upstream.json)).toEqual([["open_issues", "rebuild"], ["issue_stats", "rebuild"]]);
  expect(stepOf(upstream.json, "open_issues").reasons).toContain("code_changed");

  // --allow-shrink: the confirmation a real run would ask for, with its impact; no token, and never in next.
  const shrink = await p.json(["run", "taxi_zones", "--dry-run", "--allow-shrink"]);
  expect(shrink.code, show(shrink)).toBe(0);
  expect(stepOf(shrink.json, "taxi_zones").confirmation).toMatchObject({
    action: "allow_shrink", command: "croft run taxi_zones --allow-shrink", impact: { asset: "taxi_zones", rows: 4, downstream: [] },
  });
  expect(shrink.json.confirmation).toBeUndefined();
  expect(shrink.json.next).toEqual([]);
  const shrinkHuman = await p.croft(["run", "taxi_zones", "--dry-run", "--allow-shrink"]);
  expect(shrinkHuman.stdout).toContain("needs confirmation if the source returns less than half: the current 4 rows go to the trash first");

  // The cost guard: a new paid transform would process every issue (5 > confirmAbove 3).
  p.write("assets/issue_summaries.ts", issueSummaries(api.url));
  const paid = await p.json(["run", "issue_summaries", "--dry-run"]);
  expect(paid.code, show(paid)).toBe(0);
  expect(stepOf(paid.json, "issue_summaries")).toMatchObject({
    action: "update", reason: "never built",
    confirmation: { action: "large_reprocess", command: "croft run issue_summaries", impact: { asset: "issue_summaries", rows: 5, estimatedRequests: 5 } },
  });
  expect(paid.json.confirmation).toBeUndefined();
  expect(paid.json.next).toEqual([{ command: "croft run issue_summaries", reason: "run it; it stops to ask before the steps that need confirmation" }]);
  const paidHuman = await p.croft(["run", "--dry-run"]);
  expect(paidHuman.stdout).toMatch(/^update\s+issue_summaries\s+never built$/m);
  expect(paidHuman.stdout).toContain("needs confirmation: about 5 input rows to process, and its code makes requests for them (LARGE_REPROCESS)");
  p.remove("assets/issue_summaries.ts");

  // None of it fetched, paid, or recorded a run.
  expect(api.log.length).toBe(requests);
  expect(billed).toBe(0);
  expect(await lastRuns(p)).toEqual(runsBefore);
}, 120_000);

test("journey 19e: validate, status and the dry run never wait while another program holds the warehouse", async () => {
  expect(shared).toBeDefined();
  const p = shared!;
  // A program that is not croft (a DuckDB UI, say) opens the file read-write and keeps it.
  const holder = holdWarehouse(`${p.root}/warehouse.duckdb`);
  try {
    await holder.held;
    for (const args of [["run", "--dry-run"], ["validate"], ["status"]]) {
      const r = await p.json(args);
      expect(r.code, show(r)).toBe(0);
      expect(r.ms, show(r)).toBeLessThan(15_000);                    // a lock wait is 60 s or more
    }
    // The lock really is held: a run that may not wait gives up at once.
    const blocked = await p.json(["run", "open_issues", "--only", "--no-wait"]);
    expect(blocked.code, show(blocked)).toBe(4);
    expect(stepOf(blocked.json, "open_issues").error.code).toBe("DB_HELD_BY_OTHER_PROGRAM");
  } finally {
    holder.proc.kill("SIGKILL");
    await holder.proc.exited;
  }
  // Released: the same run goes through.
  const r = await p.json(["run", "open_issues"]);
  expect(r.code, show(r)).toBe(0);
  expect(stepOf(r.json, "open_issues")).toMatchObject({ status: "ok", schemaChanges: [{ kind: "recreate", reason: "shape_changed" }] });
}, 120_000);

// ---------------------------------------------------------------------------------------------------------
// Product bugs reported in W2.3, fixed since (they were bugTest()s). A new product bug goes here as a bugTest()
// (tests/e2e/harness.ts) until it is fixed.

// FIXED (reported): under --from the dry run and the run disagreed. `croft run stripe_charges --from 2026-06-24
// --dry-run` plans daily_revenue as "rebuild … input stripe_charges may have new rows" ("2 of 2 steps would
// run"), but the run skips it with "--from applies to merge ingests". A bare `--from -30d` dry run likewise lists
// every transform (and a LARGE_REPROCESS confirmation) that the run then skips. DESIGN §8: "run --dry-run --from
// -90d shows the same without fetching"; run/dry-run.ts: "It plans exactly as the run does".
test("journey 19f: under --from, the dry run's actions match what the run does", async () => {
  const p = await trackerProject();
  const first = await p.json(["run", "stripe_charges"]);
  expect(first.code, show(first)).toBe(0);
  const dry = await p.json(["run", "stripe_charges", "--from", "2026-06-24", "--dry-run"]);
  expect(dry.code, show(dry)).toBe(0);
  const run = await p.json(["run", "stripe_charges", "--from", "2026-06-24"]);
  expect(run.code, show(run)).toBe(0);
  const planned = Object.fromEntries((dry.json.data.steps as Obj[]).map((s) => [s.asset, s.action === "skip" ? "skipped" : "runs"]));
  const happened = Object.fromEntries((run.json.data.steps as Obj[]).map((s) => [s.asset, s.status === "skipped" ? "skipped" : "runs"]));
  expect(planned, `${show(dry)}\n${show(run)}`).toEqual(happened);
}, 120_000);

// FIXED (reported): a mistyped asset name got USAGE_ERROR with a did-you-mean fix that always said
// `croft run <guess>`, whichever command was typed. After `croft validate open_issue` (which never touches data)
// or `croft run open_issue --dry-run`, the fix an agent follows really runs the asset: fetching, writing, and
// for a paid transform spending money. The fix should repeat the command that was typed.
test("journey 19g: a mistyped asset's did-you-mean fix repeats the command typed (validate, run --dry-run)", async () => {
  expect(shared).toBeDefined();
  const p = shared!;
  const v = await p.json(["validate", "open_issue"]);
  expect(v.code, show(v)).toBe(2);
  expect(v.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", hint: "did you mean open_issues?" });
  expect(v.json.problems[0].fix?.command, show(v)).toBe("croft validate open_issues");
  const dry = await p.json(["run", "open_issue", "--dry-run"]);
  expect(dry.code, show(dry)).toBe(2);
  expect(dry.json.problems[0].fix?.command, show(dry)).toBe("croft run open_issues --dry-run");
}, 60_000);

// ---------------------------------------------------------------------------------------------------------
// A program holding the warehouse file (not croft: the DuckDB package itself, in its own process)

const DUCKDB_API = Bun.fileURLToPath(import.meta.resolve("@duckdb/node-api"));

// The instance stays referenced from globalThis: an unreferenced instance is collected, which releases the lock.
// It exits by itself after 90 s, so a test that times out before killing it leaves nothing behind.
const HOLDER = `const { DuckDBInstance } = require(process.env.DUCKDB_API);
setTimeout(() => process.exit(0), 90000);
(async () => {
  const db = await DuckDBInstance.create(process.env.DB_PATH);
  const c = await db.connect();
  globalThis.keep = [db, c];
  console.log("held");
  setInterval(() => {}, 1000);
})().catch((e) => { console.error(e.message); process.exit(1); });`;

function holdWarehouse(database: string): { proc: ReturnType<typeof Bun.spawn>; held: Promise<void> } {
  const proc = Bun.spawn([process.execPath, "-e", HOLDER], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", TMPDIR: process.env.TMPDIR ?? "/tmp", DUCKDB_API, DB_PATH: database },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const held = (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 20_000;
    while (!text.includes("held")) {
      if (Date.now() > deadline) throw new Error(`the holder never took the file: ${text}`);
      const { value, done } = await reader.read();
      if (done) throw new Error(`the holder exited: ${text}${await new Response(proc.stderr as ReadableStream).text()}`);
      text += decoder.decode(value);
    }
    reader.releaseLock();
  })();
  return { proc, held };
}
