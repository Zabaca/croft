# Writing an ingest: API and file templates

An ingest is one file in assets/ that makes one table with the file's name (lowercase letters, digits and
_; assets/github_issues.ts makes github_issues). It default-exports ingest({...}) from "@zabaca/croft".

Start with croft new. It writes a commented, working template that passes croft validate as written, says
when it applies, and prints what to edit (croft new --list shows them all):

  croft new api <name> --pagination keyset   the API sorts ascending by a field that grows as records change
                                             (updated_at) and filters by it
  croft new api <name> --pagination cursor   newest first, paged by the API's own cursor (starting_after/has_more,
                                             next_page_token): Stripe and most list endpoints; the default
  croft new api <name> --pagination link     the next page's URL is in the Link header (GitHub, GitLab)
  croft new api <name> --pagination page     page numbers only: for data that does not change while it is read
  croft new file <name>                      CSV files dropped into files/<name>/; new and changed files only

The examples below are complete ingests of real APIs and files, to compare with. Change only what the source
needs; do not invent options. Then check it with croft validate, try it with croft preview <name> (it fetches
at most 1,000 rows, changes no real table and does not move the saved cursor), run it with croft run <name>,
and look at the result with croft describe <name> and croft query.

How rows are written follows from key and incremental (croft describe says it in words):
  no key, no incremental   each run replaces the table
  key, no incremental      each run replaces the table; the key must be unique
  key + incremental        each run fetches what is new since the saved cursor and updates rows by key
  incremental, no key      only with write: "append" (event logs); otherwise INCREMENTAL_WITHOUT_KEY
A replace that would remove most of the table's rows stops with SHRINK_GUARD instead of writing.

## API, ascending "updated since" (keyset paging)

Use keyset paging only when the API sorts ascending by the cursor field and filters by it
(croft new api <name> --pagination keyset).

```ts
// assets/github_issues.ts
import { ingest, fail } from "@zabaca/croft";

type Issue = { id: number; updated_at: string };

export default ingest({
  description: "Issues and pull requests of oven-sh/bun",
  schedule: "every hour",       // runs on its own once scheduling is on (croft docs scheduling)
  secrets: ["GITHUB_TOKEN"],
  key: "id",                    // a re-fetched issue replaces its old row
  incremental: "updated_at",    // croft remembers the newest updated_at it saved

  async *rows({ since, http, secret }) {
    // since: undefined on the first run, later the saved value, e.g. "2026-09-22T17:58:03Z"
    let from = since;
    for (;;) {
      const res = await http.get("https://api.github.com/repos/oven-sh/bun/issues", {
        headers: { Authorization: `Bearer ${secret("GITHUB_TOKEN")}` },
        query: { state: "all", sort: "updated", direction: "asc", per_page: 100, since: from },
      });
      const page = res.json<Issue[]>();
      yield page;                                   // an array is one batch of rows
      if (page.length < 100) return;                // last page
      const last = page.at(-1)!.updated_at;
      if (last === from) fail("KEYSET_STUCK", "100+ issues share one updated_at");
      from = last;                                  // ask again from the newest value seen
    }
  },
});
```

## API, newest first, with the API's own cursor

Most list endpoints (Stripe and the like) return the newest first: filter by since and follow the API's
cursor. Records that change after creation (payments, refunds, orders, tickets) need a lookback, and epoch
cursors need unit (croft new api <name> --pagination cursor).

```ts
// assets/stripe_charges.ts
import { ingest } from "@zabaca/croft";

type Charge = { id: string; created: number };
type Page = { data: Charge[]; has_more: boolean };

export default ingest({
  description: "Stripe charges; re-reads the last 30 days to pick up refunds and disputes",
  schedule: "every hour",
  secrets: ["STRIPE_KEY"],
  key: "id",
  incremental: { field: "created", unit: "s", lookback: "30 days" },

  async *rows({ since, http, secret }) {
    // since is a number here (epoch seconds, already minus 30 days); undefined on the first run
    let after: string | undefined;
    for (;;) {
      const res = await http.get("https://api.stripe.com/v1/charges", {
        headers: { Authorization: `Bearer ${secret("STRIPE_KEY")}` },
        query: { limit: 100, "created[gte]": since, starting_after: after },
      });
      const page = res.json<Page>();
      yield page.data;
      if (!page.has_more || page.data.length === 0) return;
      after = page.data.at(-1)!.id;
    }
  },
});
```

## API with a Link header, fetched in full each run

res.next is the rel="next" URL of the Link header. With a key and no incremental, each run re-reads every
page and replaces the table (unchanged rows keep their _loaded_at). croft new api <name> --pagination link
writes the same loop with an "updated since" filter and incremental, so each run fetches only what changed;
remove both where the API has no such filter.

```ts
// assets/gitlab_projects.ts
import { ingest } from "@zabaca/croft";

export default ingest({
  description: "Projects of the example group",
  secrets: ["GITLAB_TOKEN"],
  key: "id",

  async *rows({ http, secret }) {
    let url: string | undefined = "https://gitlab.com/api/v4/groups/example/projects?per_page=100";
    while (url) {
      const res = await http.get(url, { headers: { "PRIVATE-TOKEN": secret("GITLAB_TOKEN") } });
      yield res.json<Record<string, unknown>[]>();
      url = res.next;
    }
  },
});
```

## API with page numbers, fetched in full each run

When the API offers nothing but page numbers, ask for pages until one comes back empty. Records added or removed
during the fetch shift the pages, so a record can be read twice (the key stores it once) or skipped until the next
run: use it only for data that does not change while it is read (croft new api <name> --pagination page).

```ts
// assets/country_codes.ts
import { ingest } from "@zabaca/croft";

type Country = { code: string; name: string };

export default ingest({
  description: "Country codes of the example reference API",
  secrets: ["REFDATA_KEY"],
  key: "code",

  async *rows({ http, secret }) {
    for (let page = 1; ; page++) {
      const res = await http.get("https://api.example.com/v1/countries", {
        headers: { Authorization: `Bearer ${secret("REFDATA_KEY")}` },
        query: { page, per_page: 100 },
      });
      const countries = res.json<Country[]>();
      if (countries.length === 0) return;           // an empty page: past the last one
      yield countries;
    }
  },
});
```

## Files: a folder of exports, or a URL

Paths are relative to the project folder; put input files under files/. Formats come from the extension
(.csv, .tsv, .json, .ndjson/.jsonl, .parquet), or from format:. croft new file <name> writes the first example
and makes its folder, files/<name>/.

```ts
// assets/sales.ts: every CSV dropped into files/sales/ is loaded once; changed files are reloaded
import { ingest } from "@zabaca/croft";

export default ingest({
  description: "Daily order exports from the shop",
  file: "files/sales/*.csv",
  incremental: true,                                      // only new and changed files
  key: "order_id",                                        // exports overlap; the key removes repeats
  map: (row) => ({ ...row, email: String(row.email ?? "").trim().toLowerCase() }),
});
```

```ts
// assets/taxi_zones.ts: a CSV from a URL, refreshed monthly
import { ingest } from "@zabaca/croft";

export default ingest({
  description: "NYC taxi zone lookup",
  file: "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv",
  schedule: "monthly",
  key: "LocationID",
  csv: { header: true },
});
```

## What rows() gets

- since: the saved cursor (minus lookback) in its own JSON type, undefined on the first run, or the value of
  croft run <name> --from <when> (a date, an ISO time or -90d; merge ingests only).
- http.get(url, {headers, query, retries, timeoutMs}) and http.post(url, body, {...}): retries network errors,
  429 and 5xx, honors Retry-After, and throws HTTP_ERROR for 400 and above. null and undefined query values are
  dropped, so since can be passed as is. res.json() keeps big integers exact; res.text; res.next.
- secret("NAME"): only names listed in secrets: [...]; a missing value is SECRET_MISSING.
- log(...): goes to the step's log (croft logs <name>), redacted.
- query(sql): one SELECT over this asset's own table, e.g. which ids it already has.
- signal: aborted on timeout or Ctrl-C.

Other options: schedule (when it runs on its own: "every hour", "daily at 06:00", "weekdays at 9am", "monthly" or a
cron; croft docs scheduling), columns (type pins, e.g. { amount: "DECIMAL(18,2)" }), write ("replace", "append" or "merge"),
retries, timeout (no-progress timeout, default "10m"), csv: { header, delimiter, skip, encoding }, checks
(rules every load must pass, such as ["not_null(email)", "amount >= 0"]) and warnings (the same rules, reported
without blocking); croft docs checks. A failing check writes nothing: the table keeps its previous rows and the
cursor does not move.

## Changing an ingest that has data

Editing rows() or map() changes what is fetched next; rows already loaded are not fetched again. Some edits change
how the stored rows were written, and croft stops before fetching rather than rewrite them on its own:
- key, write or the incremental field: INGEST_CONFIG_CHANGED (croft docs INGEST_CONFIG_CHANGED). An append ingest
  that gains a key can be converted in place, after a confirmation. Adding a lookback applies directly.
- a columns pin that would change stored values: PIN_CHANGES_DATA (croft docs PIN_CHANGES_DATA).
- the file's name: rename with croft rename <old> <new>, never by hand (croft docs rename).
To fetch everything again from scratch: croft run <name> --rebuild. The table goes to the trash first and it asks
for a confirmation, because the source may no longer have the old history: ask the user first.

A long first load of a cursor ingest is saved in parts, every 50,000 rows or 5 minutes, while the cursor field
arrives in ascending order (the step's reason says "saved in N commits"). A failure or a kill late in the load then
continues from the last part saved instead of from the start. A newest-first source is saved in one commit at the
end. With a lookback, a run that gets no rows although the window held rows last time warns EMPTY_EXTRACT.
