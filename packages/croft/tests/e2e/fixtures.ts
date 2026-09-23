// Asset sources and mock routes shared by several journeys. Asset text follows DESIGN.md §3 (the templates
// Claude starts from), with a mock base URL and small pages so pagination happens.
import { type MockApi, rawJson } from "./harness.ts";

export const TOKEN = "ghp_e2eTestToken1234567890";
export const BIG = "12345678901234567890"; // > 2^63: HUGEINT

export interface Issue { id: number; title: string; state: string; updated_at: string; external_id: number | string; user: { login: string }; labels: { name: string }[]; closed_at: null; [k: string]: unknown }

export const at = (min: number) => `2026-09-20T10:${String(min).padStart(2, "0")}:00Z`;
export function issue(id: number, min: number, extra: Partial<Issue> = {}): Issue {
  return { id, title: `Issue ${id}`, state: "open", updated_at: at(min), external_id: id * 10, user: { login: `u${id}` }, labels: [{ name: "bug" }], closed_at: null, ...extra };
}

/** JSON.stringify with "__big__<digits>" strings written as bare digits. */
export function serialize(v: unknown): string {
  return JSON.stringify(v).replace(/"__big__(\d+)"/g, "$1");
}

export const githubAsset = (base: string, perPage = 3) => `// assets/github_issues.ts (DESIGN.md §3a, with a mock base URL and small pages)
import { ingest, fail } from "@zabaca/croft";

type Issue = { id: number; updated_at: string };

export default ingest({
  description: "Issues and pull requests of oven-sh/bun",
  schedule: "every hour",
  secrets: ["GITHUB_TOKEN"],
  key: "id",                    // a re-fetched issue replaces its old row
  incremental: "updated_at",    // croft remembers the newest updated_at it saved
  checks: ["not_null(title)", "state IN ('open', 'closed')"],

  async *rows({ since, http, secret }) {
    let from = since;
    for (;;) {
      const res = await http.get("${base}/repos/oven-sh/bun/issues", {
        headers: { Authorization: \`Bearer \${secret("GITHUB_TOKEN")}\` },
        query: { state: "all", sort: "updated", direction: "asc", per_page: ${perPage}, since: from },
      });
      const page = res.json<Issue[]>();
      yield page;                                   // an array is one batch of rows
      if (page.length < ${perPage}) return;                  // last page
      const last = page.at(-1)!.updated_at;
      if (last === from) fail("KEYSET_STUCK", "${perPage}+ issues share one updated_at");
      from = last;                                  // ask again from the newest value seen
    }
  },
});
`;

/** A GitHub-like issues endpoint over `state.issues`: bearer auth, ascending by updated_at, inclusive since;
 *  `limited` 429s first, and `delayMs` before every answer. */
export function githubRoute(api: MockApi, state: { issues: Issue[]; limited: number; delayMs?: number }, token = TOKEN): void {
  api.route("/repos/oven-sh/bun/issues", async (req, url) => {
    if (state.delayMs) await Bun.sleep(state.delayMs);
    if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    if (state.limited > 0) {
      state.limited--;
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 429, headers: { "retry-after": "1" } });
    }
    const per = Number(url.searchParams.get("per_page") ?? 30);
    const since = url.searchParams.get("since");
    const rows = [...state.issues]
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.id - b.id)
      .filter((r) => since === null || Date.parse(r.updated_at) >= Date.parse(since));
    return rawJson(serialize(rows.slice(0, per)));
  });
}


export const stripeAsset = (base: string) => `// assets/stripe_charges.ts (DESIGN.md §3a, with a mock base URL and pages of 4)
import { ingest } from "@zabaca/croft";

type Charge = { id: string; created: number };
type Page = { data: Charge[]; has_more: boolean };

export default ingest({
  description: "Stripe charges; re-reads the last 30 days to pick up refunds and disputes",
  schedule: "every hour",
  secrets: ["STRIPE_KEY"],
  key: "id",
  incremental: { field: "created", unit: "s", lookback: "30 days" },
  checks: ["amount >= 0", "not_null(currency)"],

  async *rows({ since, http, secret, log }) {
    // since is a number here (epoch seconds, already minus 30 days); undefined on the first run
    log("since", typeof since, since ?? "none");
    let after: string | undefined;
    for (;;) {
      const res = await http.get("${base}/v1/charges", {
        headers: { Authorization: \`Bearer \${secret("STRIPE_KEY")}\` },
        query: { limit: 4, "created[gte]": since, starting_after: after },
      });
      const page = res.json<Page>();
      yield page.data;
      if (!page.has_more || page.data.length === 0) return;
      after = page.data.at(-1)!.id;
    }
  },
});
`;

export const slowAsset = (base: string) => `import { ingest } from "@zabaca/croft";

export default ingest({
  description: "A slow paged API",
  key: "id",
  async *rows({ http, log }) {
    for (let page = 1; ; page++) {
      const res = await http.get("${base}/slow", { query: { page } });
      const body = res.json<{ rows: Record<string, unknown>[]; more: boolean }>();
      log(\`fetched page \${page} with \${body.rows.length} rows\`);
      yield body.rows;
      if (!body.more) return;
    }
  },
});
`;
