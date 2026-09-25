# Writing a TypeScript transform: per-row (API or LLM) and whole-table templates

A TypeScript transform is one file in assets/ that computes one table from other assets with code. It
default-exports transform({...}) from "@zabaca/croft" and lists the assets it reads in inputs: croft builds
those first, snapshots them for the code, and knows to update the transform when they change. Use it for what
SQL does badly: an API or LLM call per row, parsing, scoring with a library. For filters, joins and aggregates,
write an SQL asset instead (croft docs sql). Shared code goes in lib/, imported with a relative path
(import { triage } from "../lib/triage.ts"); an edit there counts as an edit of every asset that imports it.

Start with croft new transform <name>. It writes the per-row kind below: keyed and incremental, reading with
newRows() the asset with a key that changed most recently, with confirmAbove set and a comment where the paid call
goes. The file passes croft validate as written; then edit the input, the per-row work, what each row yields and
the checks. Preview it with croft preview <name> --rows 20 once it makes paid calls.

There are two kinds:

  incremental: true   processes each input row once, read with newRows(); an input row that changed comes
                      again. Rows are merged into the table by key, in chunks. For per-row work, and always
                      for code that pays per row.
  not incremental     recomputes the whole table from rows() whenever an input or the code changes, and
                      replaces the table (unchanged rows keep their _loaded_at). For whole-table computations
                      that make no requests.

## Per row, calling an API or an LLM (the default for per-row work)

```ts
// assets/issue_labels.ts
import { transform } from "@zabaca/croft";

type Issue = { id: number; title: string; body: string | null };
type Answer = { label: string; confidence: number };

export default transform({
  description: "A label for every issue, suggested by a classification API",
  inputs: ["github_issues"],
  key: "issue_id",
  incremental: true,              // each issue is sent once; an issue that changed is sent again
  secrets: ["CLASSIFIER_KEY"],
  checks: ["not_null(label)", "confidence BETWEEN 0 AND 1"],

  async *rows({ newRows, http, secret, log }) {
    let n = 0;
    for await (const issue of newRows<Issue>("github_issues")) {
      const res = await http.post("https://api.example.com/v1/classify", {
        text: `${issue.title}\n\n${issue.body ?? ""}`,
        labels: ["bug", "feature", "question"],
      }, { headers: { Authorization: `Bearer ${secret("CLASSIFIER_KEY")}` } });
      const answer = res.json<Answer>();
      yield { issue_id: issue.id, label: answer.label, confidence: answer.confidence };
      if (++n % 100 === 0) log(`${n} issues labeled`);
    }
  },
});
```

An SDK works as well as ctx.http (openai, @anthropic-ai/sdk and others; create the client inside rows() with
the key from secret()). croft detects requests either way and applies the cost guard below. ctx.http retries
network errors, 429 and 5xx, honors Retry-After, redacts secrets from its errors, and res.json() keeps big
integers exact.

## Per row, without requests

```ts
// assets/issue_triage.ts
import { transform } from "@zabaca/croft";

type Issue = { id: number; title: string; body: string | null; labels: { name: string }[] | null };

function triage(text: string, labels: string[]): { priority: string; reason: string } {
  if (labels.includes("crash") || /segfault|panic/i.test(text)) return { priority: "p0", reason: "crash" };
  if (labels.includes("bug")) return { priority: "p1", reason: "bug label" };
  return { priority: "p2", reason: "default" };
}

export default transform({
  description: "Priority and reason for every issue, computed in TypeScript",
  inputs: ["github_issues"],
  key: "issue_id",
  incremental: true,
  checks: ["priority IN ('p0', 'p1', 'p2')", "not_null(reason)"],

  async *rows({ newRows }) {
    for await (const issue of newRows<Issue>("github_issues")) {
      const labels = (issue.labels ?? []).map((l) => l.name);
      yield { issue_id: issue.id, ...triage(`${issue.title}\n${issue.body ?? ""}`, labels) };
    }
  },
});
```

## The whole table at once

```ts
// assets/region_streaks.ts: the longest run of consecutive days with sales, per region
import { transform } from "@zabaca/croft";

const DAY_MS = 86_400_000;

export default transform({
  description: "Per region, the longest run of consecutive days with at least one sale",
  inputs: ["example_sales"],
  key: "region",
  checks: ["longest_streak >= 1"],

  async *rows({ query }) {
    const days = await query<{ region: string; day: string }>(
      "SELECT DISTINCT region, order_date AS day FROM example_sales ORDER BY region, day");
    const best = new Map<string, number>();
    let region = "";
    let run = 0;
    let last = 0;
    for (const d of days) {
      const t = Date.parse(d.day);
      run = d.region === region && t - last === DAY_MS ? run + 1 : 1;
      region = d.region;
      last = t;
      best.set(region, Math.max(best.get(region) ?? 0, run));
    }
    for (const [r, longest] of best) yield { region: r, longest_streak: longest };
  },
});
```

## What rows() gets

- rows(name): every row of an input, streamed. newRows(name): in an incremental transform, the input's rows it
  has not processed yet (all of them on the first run); in a full-refresh one, the same as rows(name).
- query(sql, ...params): one SELECT over the declared inputs, e.g. a lookup or an aggregate; $1, $2 are params.
- http.get / http.post, secret("NAME") (names listed in secrets only), log(...) to the step's log (croft logs
  <name>), signal (aborted on timeout or Ctrl-C), and preview (true under croft preview).
- Only the inputs can be read: any other table in rows(), newRows() or query() is UNDECLARED_INPUT, and so is
  the transform's own table. Asset code never opens the database itself (ASSET_OPENS_DATABASE): no
  @duckdb/node-api, no @zabaca/croft/read.

Values arrive as JavaScript values that load back unchanged: JSON columns parsed; TIMESTAMPTZ as an ISO string
with Z ("2026-03-01T07:30:00.123456Z"); TIMESTAMP as an ISO string without an offset; DATE as "YYYY-MM-DD";
integers as number, or bigint beyond ±2^53 (HUGEINT always bigint); DECIMAL of up to 15 digits as number,
wider as its exact text. new Date(row.created_at) when you need date arithmetic.

Rows are guarded: reading a column the input does not have throws UNKNOWN_INPUT_COLUMN with a did-you-mean,
instead of storing NULL. Copy a row with { ...row } (structuredClone does not work on it); croft's _loaded_at
and _file can be read but are left out of the copy. Yield plain objects, or arrays of them; they are typed and
loaded like an ingest's rows (columns: { x: "DECIMAL(18,2)" } pins a type).

## Incremental: positions, chunks and retries

- The transform needs a key (INCREMENTAL_WITHOUT_KEY otherwise), and so does every input it reads with
  newRows() (INPUT_NEEDS_KEY): croft remembers its place in each input by (_loaded_at, key). Inputs it only
  looks things up in are read with rows() or query() and need no key.
- Write the loop plainly: for each input row, make its calls, yield its output, then take the next row.
- It commits every 500 output rows or 60 s, whichever comes first; each chunk commits its rows, its checks and
  its position together. A failure, a timeout or Ctrl-C loses at most the current chunk: the next run
  continues after the last committed one, and the error says how many rows were saved.
- A chunk that could not commit (a failed check, a busy database) is kept, and the next attempt commits it
  without running the code again while the code, the checks and the input rows are unchanged; change any of
  them and it is computed again.
- Changing the code applies to new input rows only: rows built earlier keep their values, so paid calls are
  never repeated implicitly (croft status shows EDITED_SINCE_LAST_RUN). croft preview <name> --rebuild shows
  how a rebuild would differ, within its --rows cap; croft run <name> --rebuild redoes every row, after moving
  the table to the trash and asking for a confirmation. Ask the user before running it.

## The cost guard

An incremental transform that makes requests (ctx.http, fetch(), or an HTTP or LLM SDK package, also through
lib/) and would process more than confirmAbove input rows in one run (default 1000) stops before any of its
code runs, with LARGE_REPROCESS: on a first build of a large input, or after an upstream rewrote many rows.
croft run then asks: Proceed? [y/N] on a terminal, and off one it exits 5 with a confirmation token. Show the
user the impact and run croft confirm <token> only after their explicit yes. Raising confirmAbove also needs
their yes. A full-refresh transform that makes requests pays for every row on every rebuild, so croft validate
warns TRANSFORM_MAKES_REQUESTS: make it incremental.

## Try it

  croft validate --json                config, inputs, keys and requests; --types also runs the project's tsc
  croft preview <name> --rows 20       at most 20 input rows reach the code (the default is 1000: keep it
                                       small for code that pays per row); nothing real changes
  croft run <name>                     then croft query "from <name> limit 5" and croft describe <name>
