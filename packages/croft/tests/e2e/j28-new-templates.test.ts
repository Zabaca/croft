// Journey 28: `croft new`, template by template (DESIGN.md §3a–§3e, §4.1, §4.2, §9), through the real CLI, as an
// agent follows the template's own words: croft new → croft validate as written (nothing but SECRET_MISSING before
// the secret) → the edits the Edit line and the comments name → the secret (croft secrets set --stdin, or .env) →
// croft validate → croft preview → croft run → croft query → one more run, to see the template's incremental read.
//   a. api, one test per pagination style, each against a mock API that pages that way and checks the bearer
//      token: keyset (sort=updated_at&direction=asc&since), cursor (Stripe's created[gte]/starting_after/has_more,
//      newest first; also the default without --pagination, and §4.2's human output), link (the Link header's
//      rel="next") and page (page/per_page until an empty page). The second run writes only the three records
//      that changed. The keyset template stops with KEYSET_STUCK on a full page of one updated_at, and the file
//      template's other case, one file at a URL, is downloaded and skipped while unchanged. croft query of an asset
//      never built says it is not built yet, with its run, before the first run and once the warehouse exists; a
//      typo in a built table's name gets the asset as its did-you-mean;
//   b. file: CSV files dropped into files/<name>/, key set to their id column, a new file loaded on its own;
//   c. transform over the file ingest, with the paid call the template's comment shows made for real against a
//      mock "LLM": preview --rows 20 bills 20 calls, 1,205 new rows are over confirmAbove (1,000), so the run asks
//      (exit 5) and croft confirm bills each row once; three new rows run without asking;
//   d. sql over the transform, as written and then as a GROUP BY;
//   e. refusals: NAME_CONFLICT (a file, and a table whose file is gone), a bad --pagination, a kind croft does not
//      have, a name that is no table name; croft new --list.
// Every --json envelope is checked against its published schema (schemas/<command>.schema.json) with the golden
// tests' validator.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { SchemaCommand } from "../../src/cli/schemas.ts";
import { golden, type GoldenOptions } from "../golden/kit.ts";
import {
  type CliResult, cleanupAll, type Envelope, findProblem, initProject, json, type MockApi, mockApi, type Project, type Req, show, stepOf,
} from "./harness.ts";

let api: MockApi;
let p: Project;
beforeAll(async () => {
  api = mockApi();
  p = (await initProject("templates")).project;
}, 120_000);
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

/** `croft <args> --json` in the project, its envelope checked against schemas/<command>.schema.json. */
async function croftJson(command: SchemaCommand, args: string[], o: GoldenOptions & { stdin?: string } = {}): Promise<{ r: CliResult; env: Envelope }> {
  const r = await p.croft([...args, "--json"], o.stdin !== undefined ? { stdin: o.stdin } : {});
  return { r, env: golden(command, r, o) };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const BASE = Date.parse("2026-09-01T00:00:00Z");
/** Minute i after BASE, as an API writes it. */
const isoAt = (i: number) => new Date(BASE + i * 60_000).toISOString().replace(".000Z", "Z");
const secsAt = (i: number) => BASE / 1000 + i * 60;

/** 401 unless the request carries the bearer token. */
function denied(req: Request, token: string): Response | null {
  return req.headers.get("authorization") === `Bearer ${token}` ? null : json({ message: "Bad credentials" }, { status: 401 });
}

/** The problems of a validate envelope that are not info notes. */
const serious = (env: Envelope) => (env.problems as { severity: string; code: string }[]).filter((x) => x.severity !== "info");

/** What croft query said of each api asset after its preview and before its first run. */
const notBuilt = new Map<string, Envelope>();

// ---------------------------------------------------------------------------------------------------------
// a. API ingests: one mock per pagination style

interface ApiCase {
  style: "keyset" | "cursor" | "link" | "page";
  /** The asset name, and the secret croft new derives from it (§4.2: the name's first word). */
  name: string;
  secret: string;
  /** The placeholder URL the template writes. */
  placeholder: string;
  /** Where the mock serves it: the placeholder's origin becomes api.url + prefix. */
  prefix: string;
  token: string;
  /** How the user sets the secret. */
  via: "stdin" | ".env";
  /** The mock's records, and a change for the second run: two new records and one edited. */
  count(): number;
  change(): void;
  /** Requests a full read of the 250 records takes. */
  fullRead: number;
  /** The incremental second run: its requests, and what they carried. */
  second(reqs: Req[]): void;
  /** SQL giving the edited record's changed value, and what it should be. */
  edited: [string, unknown];
}

// keyset: GitHub-like issues, oldest first by updated_at, `since` inclusive.
const tracker = { issues: range(1, 250).map((i) => ({ id: i, title: `Issue ${i}`, updated_at: isoAt(i) })) };
// cursor: Stripe-like charges, newest first, created[gte] and starting_after.
const stripe = { charges: range(1, 250).map((i) => ({ id: `ch_${String(i).padStart(4, "0")}`, created: secsAt(i), amount: i * 100, currency: "usd", status: "succeeded" })) };
// link: commits by id, updated_after, with a Link header.
const forge = { commits: range(1, 250).map((i) => ({ id: i, message: `Commit ${i}`, updated_at: isoAt(i) })) };
// page: products by page number.
const catalog = { products: range(1, 250).map((i) => ({ id: i, name: `Product ${i}`, price: i + 0.5 })) };

const TOKENS = { tracker: "trk_e2e_journey28_0001", stripe: "sk_test_e2e_journey28_0002", forge: "frg_e2e_journey28_0003", catalog: "cat_e2e_journey28_0004" };

function routes(): void {
  api.route("/keyset/v1/issues", (req, url) => {
    const no = denied(req, TOKENS.tracker);
    if (no) return no;
    const q = url.searchParams;
    if (q.get("sort") !== "updated_at" || q.get("direction") !== "asc") return json({ message: "only sort=updated_at&direction=asc" }, { status: 400 });
    const since = q.get("since");
    const rows = [...tracker.issues].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.id - b.id)
      .filter((r) => since === null || Date.parse(r.updated_at) >= Date.parse(since));
    return json(rows.slice(0, Number(q.get("per_page") ?? 30)));
  });
  api.route("/cursor/v1/charges", (req, url) => {
    const no = denied(req, TOKENS.stripe);
    if (no) return no;
    const q = url.searchParams;
    const gte = q.get("created[gte]");
    const after = q.get("starting_after");
    const limit = Number(q.get("limit") ?? 10);
    const ordered = [...stripe.charges].sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1))
      .filter((c) => gte === null || c.created >= Number(gte));
    const start = after === null ? 0 : ordered.findIndex((c) => c.id === after) + 1;
    if (after !== null && start === 0) return json({ error: { message: `No such charge: ${after}` } }, { status: 400 });
    return json({ object: "list", data: ordered.slice(start, start + limit), has_more: start + limit < ordered.length });
  });
  api.route("/link/v1/commits", (req, url) => {
    const no = denied(req, TOKENS.forge);
    if (no) return no;
    const q = url.searchParams;
    const per = Number(q.get("per_page") ?? 30);
    const page = Number(q.get("page") ?? 1);
    const after = q.get("updated_after");
    const rows = forge.commits.filter((c) => after === null || Date.parse(c.updated_at) >= Date.parse(after)).sort((a, b) => a.id - b.id);
    const last = Math.max(1, Math.ceil(rows.length / per));
    const at = (n: number) => {
      const u = new URL(`${api.url}/link/v1/commits`);
      u.searchParams.set("page", String(n));
      u.searchParams.set("per_page", String(per));
      if (after !== null) u.searchParams.set("updated_after", after);
      return u.href;
    };
    const links = [`<${at(1)}>; rel="first"`, `<${at(last)}>; rel="last"`, ...(page < last ? [`<${at(page + 1)}>; rel="next"`] : [])];
    return json(rows.slice((page - 1) * per, page * per), { headers: { link: links.join(", ") } });
  });
  api.route("/page/v1/products", (req, url) => {
    const no = denied(req, TOKENS.catalog);
    if (no) return no;
    const page = Number(url.searchParams.get("page") ?? 1);
    const per = Number(url.searchParams.get("per_page") ?? 30);
    return json(catalog.products.slice((page - 1) * per, page * per));
  });
}

const API_CASES: ApiCase[] = [
  {
    style: "keyset", name: "tracker_issues", secret: "TRACKER_KEY", placeholder: "https://api.example.com/v1/issues", prefix: "/keyset",
    token: TOKENS.tracker, via: "stdin", fullRead: 3,
    count: () => tracker.issues.length,
    change() {
      tracker.issues[4] = { ...tracker.issues[4]!, title: "Issue 5 (edited)", updated_at: isoAt(300) };
      tracker.issues.push({ id: 251, title: "Issue 251", updated_at: isoAt(301) }, { id: 252, title: "Issue 252", updated_at: isoAt(302) });
    },
    second(reqs) {
      // One request from the saved updated_at minus a second: the boundary record, the edited one and the new ones.
      expect(reqs.length).toBe(1);
      expect(Date.parse(reqs[0]!.query.since ?? "")).toBe(Date.parse(isoAt(250)) - 1000);
    },
    edited: ["SELECT title AS v FROM tracker_issues WHERE id = 5", "Issue 5 (edited)"],
  },
  {
    style: "cursor", name: "stripe_charges", secret: "STRIPE_KEY", placeholder: "https://api.example.com/v1/charges", prefix: "/cursor",
    token: TOKENS.stripe, via: ".env", fullRead: 3,
    count: () => stripe.charges.length,
    change() {
      stripe.charges[4] = { ...stripe.charges[4]!, status: "refunded" };
      stripe.charges.push(
        { id: "ch_0251", created: secsAt(251), amount: 25_100, currency: "usd", status: "succeeded" },
        { id: "ch_0252", created: secsAt(252), amount: 25_200, currency: "usd", status: "succeeded" },
      );
    },
    second(reqs) {
      // The lookback: the newest created saved (secsAt(250)) minus 30 days, so the refund is read again.
      expect(reqs.length).toBe(3);
      expect(reqs.map((r) => r.query["created[gte]"])).toEqual(Array(3).fill(String(secsAt(250) - 30 * 86_400)));
    },
    edited: ["SELECT status AS v FROM stripe_charges WHERE id = 'ch_0005'", "refunded"],
  },
  {
    style: "link", name: "forge_commits", secret: "FORGE_KEY", placeholder: "https://api.example.com/v1/commits", prefix: "/link",
    token: TOKENS.forge, via: "stdin", fullRead: 3,
    count: () => forge.commits.length,
    change() {
      forge.commits[4] = { ...forge.commits[4]!, message: "Commit 5 (amended)", updated_at: isoAt(300) };
      forge.commits.push({ id: 251, message: "Commit 251", updated_at: isoAt(301) }, { id: 252, message: "Commit 252", updated_at: isoAt(302) });
    },
    second(reqs) {
      expect(reqs.length).toBe(1);
      expect(Date.parse(reqs[0]!.query.updated_after ?? "")).toBe(Date.parse(isoAt(250)) - 1000);
    },
    edited: ["SELECT message AS v FROM forge_commits WHERE id = 5", "Commit 5 (amended)"],
  },
  {
    style: "page", name: "catalog_products", secret: "CATALOG_KEY", placeholder: "https://api.example.com/v1/products", prefix: "/page",
    token: TOKENS.catalog, via: ".env", fullRead: 4,
    count: () => catalog.products.length,
    change() {
      catalog.products[4] = { ...catalog.products[4]!, price: 99.5 };
      catalog.products.push({ id: 251, name: "Product 251", price: 251.5 }, { id: 252, name: "Product 252", price: 252.5 });
    },
    second(reqs) {
      // No cursor: every page again, the table replaced.
      expect(reqs.map((r) => r.query.page)).toEqual(["1", "2", "3", "4"]);
    },
    edited: ["SELECT price AS v FROM catalog_products WHERE id = 5", 99.5],
  },
];

describe("a. api templates, one per pagination style", () => {
  beforeAll(routes);

  test("cursor is the default, and croft new prints §4.2's lines for people", async () => {
    const r = await p.croft(["new", "api", "stripe_charges"]);
    expect(r.code, show(r)).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("Created assets/stripe_charges.ts (cursor pagination: starting_after/has_more).");
    expect(lines).toContain("Edit: the URL, the cursor field and whether records change after creation (see comments).");
    const next = lines.find((l) => l.startsWith("next: "));
    expect(next, r.stdout).toContain("STRIPE_KEY");
    expect(next).toContain("croft preview stripe_charges");
    expect(r.stderr).toBe("");
    expect(p.read("assets/stripe_charges.ts")).toContain("--pagination cursor");
  }, 60_000);

  for (const c of API_CASES) {
    test(`${c.style}: new → validate → edit → secret → validate → preview → run → query → an incremental run`, async () => {
      const file = `assets/${c.name}.ts`;
      const mockPath = `${c.prefix}${new URL(c.placeholder).pathname}`;

      // 1. croft new (the cursor case was written by the test above, in words for people).
      if (c.style !== "cursor") {
        const made = (await croftJson("new", ["new", "api", c.name, "--pagination", c.style])).env;
        expect(made.data).toEqual({
          asset: c.name, kind: "api", pagination: c.style, file, what: expect.any(String), edit: expect.any(String), reads: null,
          secrets: [{ name: c.secret, status: "missing" }], created: [file],
        });
        // The secret is the user's to add: next is croft secrets (never a read of .env), then the preview.
        expect(made.next).toEqual([{ command: "croft secrets", reason: expect.stringContaining(`croft preview ${c.name}`) }]);
        expect(made.next[0].reason).toContain(`${c.secret}=...`);
      }
      const text = p.read(file);
      expect(text).toContain("When this applies");
      expect(text).toContain(`croft new api ${c.name} --pagination ${c.style}`);
      expect(text).toContain(`secret(${JSON.stringify(c.secret)})`);
      expect(text).toContain(JSON.stringify(c.placeholder));

      // 2. As written it validates, but for the secret nobody has set yet.
      const before = (await croftJson("validate", ["validate", c.name])).env;
      expect(serious(before).map((x) => x.code), JSON.stringify(before.problems)).toEqual(["SECRET_MISSING"]);
      expect(findProblem(before, "SECRET_MISSING")).toMatchObject({ severity: "warning", asset: c.name, details: expect.objectContaining({ name: c.secret }) });

      // 3. The edits the Edit line names: the URL (the mock takes the parameters and pages the way the template
      //    expects, so nothing else needs to change), and the commented checks line (and the page template's
      //    schedule) turned on.
      p.edit(file, JSON.stringify(c.placeholder), JSON.stringify(`${api.url}${mockPath}`));
      p.edit(file, "  // checks: [", "  checks: [");
      if (c.style === "page") p.edit(file, "  // schedule: ", "  schedule: ");

      // 4. The user sets the secret: from a password manager through --stdin, or in .env.
      if (c.via === "stdin") {
        const set = await croftJson("secrets", ["secrets", "set", c.secret, "--stdin"], { stdin: `${c.token}\n` });
        expect(set.env.data).toMatchObject({ name: c.secret });
        expect(set.r.stdout + set.r.stderr).not.toContain(c.token);
      } else {
        p.secret(c.secret, c.token);
      }
      const listed = (await croftJson("secrets", ["secrets"])).env;
      expect(listed.data.find((s: { name: string }) => s.name === c.secret)).toMatchObject({ status: "set" });

      // 5. validate, clean.
      const clean = (await croftJson("validate", ["validate", c.name])).env;
      expect(serious(clean), JSON.stringify(clean.problems)).toEqual([]);

      // 6. preview: the whole mock (250 records, under --rows' 1,000), nothing saved.
      const previewed = (await croftJson("preview", ["preview", c.name])).env;
      const pa = previewed.data.assets.find((a: { asset: string }) => a.asset === c.name);
      expect(pa, JSON.stringify(previewed)).toMatchObject({ status: "ok", rows: 250, liveRows: null, capped: false, requests: c.fullRead });
      expect(api.requests(mockPath).length).toBe(c.fullRead);
      const noTable = await croftJson("query", ["query", `SELECT count(*) FROM ${c.name}`], { failed: true, exit: 2 });
      // DB_NOT_FOUND ("… is not built yet", fix croft run <asset>), before anything ran in the project (keyset, the
      // first journey) and once the warehouse exists (the others; see the tests after these journeys).
      expect(noTable.env.problems.map((x: { code: string }) => x.code), show(noTable.r)).toEqual(["DB_NOT_FOUND"]);
      notBuilt.set(c.name, noTable.env.problems[0]);

      // 7. run, then query.
      const ran = await croftJson("run", ["run", c.name]);
      expect(stepOf(ran.env, c.name), show(ran.r)).toMatchObject({ status: "ok", requests: c.fullRead, rows: { total: 250 } });
      expect(api.requests(mockPath).length).toBe(2 * c.fullRead);
      expect(api.requests(mockPath).every((r) => r.headers.authorization === `Bearer ${c.token}`)).toBe(true);
      const counted = (await croftJson("query", ["query", `SELECT count(*) AS n, count(DISTINCT id) AS ids FROM ${c.name}`])).env;
      expect(counted.data.rows).toEqual([{ n: 250, ids: 250 }]);

      // 8. The mock changes (two new records, one edited): the second run reads the way its template says, and
      //    only those three rows are written; the rest keep their _loaded_at (§3a "Boundary rows").
      c.change();
      const seen = api.requests(mockPath).length;
      const again = await croftJson("run", ["run", c.name]);
      expect(stepOf(again.env, c.name), show(again.r)).toMatchObject({ status: "ok", rows: { added: 2, updated: 1, deleted: 0, total: c.count() } });
      c.second(api.requests(mockPath).slice(seen));
      const edited = (await croftJson("query", ["query", c.edited[0]])).env;
      expect(edited.data.rows).toEqual([{ v: c.edited[1] }]);
      const stamped = (await croftJson("query", ["query", `SELECT count(*) AS n FROM ${c.name} WHERE _loaded_at = (SELECT max(_loaded_at) FROM ${c.name})`])).env;
      expect(stamped.data.rows).toEqual([{ n: 3 }]);
    }, 120_000);
  }

  test("croft query of an asset never built, before anything ran: it is not built yet, and the fix is its run", async () => {
    expect(notBuilt.get("tracker_issues")).toMatchObject({
      code: "DB_NOT_FOUND", message: expect.stringContaining("tracker_issues is not built yet"), fix: { kind: "command", command: "croft run tracker_issues" },
    });
    // And a typo in the name of a table that is built.
    const typo = await croftJson("query", ["query", "SELECT count(*) FROM tracker_issue"], { failed: true, exit: 2 });
    expect(typo.env.problems.map((x: { code: string }) => x.code), show(typo.r)).toEqual(["UNKNOWN_TABLE"]);
    notBuilt.set("tracker_issue", typo.env.problems[0]);
  });

  // Once the warehouse exists (a bug of W5.2, fixed): `croft query "SELECT … FROM stripe_charges"` after `croft new`
  // and `croft preview stripe_charges` said UNKNOWN_TABLE "no table named stripe_charges", hint "list the tables with:
  // croft status", with no fix, and a typo in a built table's name (tracker_issue) got no did-you-mean (§5 "Errors
  // from user queries"). Now both say what they say before the project's first run (§3b "Zero-asset path").
  test("croft query of an asset never built, once the warehouse exists: it is not built yet, and the fix is its run", () => {
    for (const name of ["stripe_charges", "forge_commits", "catalog_products"]) {
      expect(notBuilt.get(name)).toMatchObject({
        code: "DB_NOT_FOUND", message: expect.stringContaining(`${name} is not built yet`), fix: { kind: "command", command: `croft run ${name}` },
      });
    }
  });
  test("croft query of a typo in a built table's name suggests the asset", () => {
    expect(notBuilt.get("tracker_issue")).toMatchObject({
      code: "UNKNOWN_TABLE", details: { suggestion: "tracker_issues" }, hint: expect.stringContaining("tracker_issues"),
      fix: { kind: "command", command: `croft query "SELECT count(*) FROM tracker_issues"` },
    });
  });

  test("keyset: a full page on one updated_at stops with KEYSET_STUCK instead of asking for the same page forever", async () => {
    api.route("/stuck/v1/issues", (req, url) => {
      const no = denied(req, TOKENS.tracker);
      if (no) return no;
      const rows = range(1, 150).map((id) => ({ id, title: `Issue ${id}`, updated_at: isoAt(0) }));
      return json(rows.slice(0, Number(url.searchParams.get("per_page") ?? 30)));
    });
    // tracker_old_issues reads TRACKER_KEY (the name's first word), set above.
    const made = (await croftJson("new", ["new", "api", "tracker_old_issues", "--pagination", "keyset"])).env;
    expect(made.data.secrets).toEqual([{ name: "TRACKER_KEY", status: "set" }]);
    p.edit("assets/tracker_old_issues.ts", '"https://api.example.com/v1/issues"', JSON.stringify(`${api.url}/stuck/v1/issues`));
    const ran = await croftJson("run", ["run", "tracker_old_issues"], { exit: 1 });
    const s = stepOf(ran.env, "tracker_old_issues");
    expect(s, show(ran.r)).toMatchObject({ status: "failed", requests: 2, error: { code: "KEYSET_STUCK" } });
    expect(s.error.message).toContain("share updated_at");
    expect(api.requests("/stuck/v1/issues").length).toBe(2);
    p.remove("assets/tracker_old_issues.ts");
  }, 60_000);

  test("file at a URL (the file template's other case): downloaded, skipped while unchanged, loaded again when it changes", async () => {
    let csv = "sku,name,price\nA1,Apple,1.5\nB2,Banana,0.25\nC3,Cherry,4\n";
    api.route("/exports/prices.csv", () => new Response(csv, { headers: { "content-type": "text/csv" } }));
    const made = (await croftJson("new", ["new", "file", "price_list"])).env;
    expect(made.data.created).toEqual(["assets/price_list.ts", "files/price_list/"]);
    // "For one file at a URL, set file to the URL"; and the key.
    p.edit("assets/price_list.ts", '"files/price_list/*.csv"', JSON.stringify(`${api.url}/exports/prices.csv`));
    p.edit("assets/price_list.ts", '  key: "id",', '  key: "sku",');
    const v = (await croftJson("validate", ["validate", "price_list"])).env;
    expect(serious(v), JSON.stringify(v.problems)).toEqual([]);
    const first = await croftJson("run", ["run", "price_list"]);
    expect(stepOf(first.env, "price_list"), show(first.r)).toMatchObject({ status: "ok", rows: { added: 3, total: 3 } });
    const same = await croftJson("run", ["run", "price_list"]);
    expect(stepOf(same.env, "price_list"), show(same.r)).toMatchObject({ status: "unchanged", rows: { added: 0, updated: 0 } });
    csv += "D4,Date,3\n";
    const changed = await croftJson("run", ["run", "price_list"]);
    expect(stepOf(changed.env, "price_list"), show(changed.r)).toMatchObject({ status: "ok", rows: { added: 1, unchanged: 3, total: 4 } });
  }, 60_000);

  test("a new api asset once its secret is set: next is the preview", async () => {
    const made = (await croftJson("new", ["new", "api", "stripe_refunds", "--pagination", "cursor"])).env;
    expect(made.data.secrets).toEqual([{ name: "STRIPE_KEY", status: "set" }]);
    expect(made.next).toEqual([{ command: "croft preview stripe_refunds", reason: expect.stringContaining("croft validate") }]);
    const v = (await croftJson("validate", ["validate", "stripe_refunds"])).env;
    expect(serious(v), JSON.stringify(v.problems)).toEqual([]);
    // Not needed below: the sql and transform templates read the asset changed most recently.
    p.remove("assets/stripe_refunds.ts");
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
// b.–d. file → transform (paid) → sql

const REGIONS = ["north", "south", "east", "west"] as const;
/** A CSV export of orders `from`..`to`. */
const salesCsv = (from: number, to: number) => `order_id,region,amount\n${range(from, to).map((i) => `${i},${REGIONS[i % 4]},${(i % 90) + 10}.25`).join("\n")}\n`;

describe("b.–d. file, transform and sql templates", () => {
  test("b. file: new → validate → CSV files and the key → preview → run → query → a new file", async () => {
    const made = (await croftJson("new", ["new", "file", "sales"])).env;
    expect(made.data).toMatchObject({ asset: "sales", kind: "file", pagination: null, file: "assets/sales.ts", reads: null, secrets: [], created: ["assets/sales.ts", "files/sales/"] });
    expect(made.next).toEqual([{ command: "croft preview sales", reason: expect.stringContaining("files/sales/") }]);
    expect(p.exists("files/sales")).toBe(true);
    const text = p.read("assets/sales.ts");
    expect(text).toContain("When this applies");
    expect(text).toContain('file: "files/sales/*.csv"');

    const asWritten = (await croftJson("validate", ["validate", "sales"])).env;
    expect(serious(asWritten), JSON.stringify(asWritten.problems)).toEqual([]);

    // The Edit line: put the CSV files in files/sales/, then set key to the column that identifies a row.
    p.write("files/sales/2026-09-01.csv", salesCsv(1, 700));
    p.write("files/sales/2026-09-02.csv", salesCsv(701, 1200));
    p.edit("assets/sales.ts", '  key: "id",', '  key: "order_id",');
    const edited = (await croftJson("validate", ["validate", "sales"])).env;
    expect(serious(edited), JSON.stringify(edited.problems)).toEqual([]);

    const previewed = (await croftJson("preview", ["preview", "sales"])).env;
    expect(previewed.data.assets.find((a: { asset: string }) => a.asset === "sales")).toMatchObject({ status: "ok", rows: 1200, liveRows: null });
    const ran = await croftJson("run", ["run", "sales"]);
    expect(stepOf(ran.env, "sales"), show(ran.r)).toMatchObject({ status: "ok", rows: { added: 1200, total: 1200 } });
    const q = (await croftJson("query", ["query", "SELECT count(*) AS n, count(DISTINCT order_id) AS ids, sum(amount) > 0 AS paid FROM sales"])).env;
    expect(q.data.rows).toEqual([{ n: 1200, ids: 1200, paid: true }]);

    // A new export in the folder: only it is read.
    p.write("files/sales/2026-09-03.csv", salesCsv(1201, 1205));
    const more = await croftJson("run", ["run", "sales"]);
    expect(stepOf(more.env, "sales"), show(more.r)).toMatchObject({ status: "ok", rows: { added: 5, total: 1205 } });
  }, 120_000);

  const llm = { calls: 0, byOrder: new Map<number, number>(), auth: new Set<string>() };
  const LLM_TOKEN = "llm_e2e_journey28_0005";
  const label = (region: string) => (region === "north" || region === "south" ? "domestic" : "export");

  test("c. transform over the file ingest: the paid call as the comment shows it, preview --rows 20, then the cost guard", async () => {
    api.route("/llm/v1/classify", async (req) => {
      const body = (await req.json()) as { text: string };
      llm.calls++;
      llm.auth.add(req.headers.get("authorization") ?? "");
      return json({ label: label(body.text) });
    });

    // The asset changed most recently with a key is sales (just edited): the transform reads it.
    const made = (await croftJson("new", ["new", "transform", "sales_labels"])).env;
    expect(made.data).toMatchObject({ asset: "sales_labels", kind: "transform", pagination: null, file: "assets/sales_labels.ts", reads: "sales", secrets: [] });
    expect(made.data.edit).toContain("sales");
    expect(made.next).toEqual([{ command: "croft preview sales_labels --rows 20", reason: expect.any(String) }]);
    const file = "assets/sales_labels.ts";
    const text = p.read(file);
    expect(text).toContain("When this applies");
    expect(text).toContain("confirmAbove: 1000,");
    expect(text).toContain('newRows<Input>("sales")');

    // As written it validates (a placeholder result per row, no requests).
    const asWritten = (await croftJson("validate", ["validate", "sales_labels"])).env;
    expect(serious(asWritten), JSON.stringify(asWritten.problems)).toEqual([]);

    // The comment's own steps: add http and secret to the arguments of rows, secrets: [...] to the config, the call
    // uncommented and pointed at the service, the placeholder result removed; the Input type names what it reads.
    p.edit(file, "async *rows({ newRows, log })", "async *rows({ newRows, log, http, secret })");
    p.edit(file, '  inputs: ["sales"],', '  secrets: ["LLM_KEY"],\n  inputs: ["sales"],');
    p.edit(file, "type Input = { order_id: unknown };", "type Input = { order_id: number; region: string; amount: number };");
    p.edit(file, "      //   ", "      ", { all: true });
    p.edit(file, '"https://api.example.com/v1/classify"', JSON.stringify(`${api.url}/llm/v1/classify`));
    p.edit(file, "String(row.title)", "String(row.region)");
    p.edit(file, 'secret("EXAMPLE_KEY")', 'secret("LLM_KEY")');
    const placeholder = p.read(file).split("\n").filter((l) => l.includes("replace with what you compute for this row"));
    expect(placeholder.length).toBe(1);
    p.edit(file, `${placeholder[0]}\n`, "");

    const missing = (await croftJson("validate", ["validate", "sales_labels"])).env;
    expect(serious(missing).map((x) => x.code), JSON.stringify(missing.problems)).toEqual(["SECRET_MISSING"]);
    await croftJson("secrets", ["secrets", "set", "LLM_KEY", "--stdin"], { stdin: `${LLM_TOKEN}\n` });
    const clean = (await croftJson("validate", ["validate", "sales_labels"])).env;
    expect(serious(clean), JSON.stringify(clean.problems)).toEqual([]);

    // preview --rows 20: 20 input rows reach the code, so 20 paid calls; nothing real changes.
    const previewed = (await croftJson("preview", ["preview", "sales_labels", "--rows", "20"])).env;
    expect(previewed.data.assets.find((a: { asset: string }) => a.asset === "sales_labels")).toMatchObject({ status: "ok", rows: 20, capped: true });
    expect(llm.calls).toBe(20);
    // A preview never asks: --rows beyond confirmAbove is refused, with the --rows that fits (§6).
    const tooMany = (await croftJson("preview", ["preview", "sales_labels", "--rows", "2000"], { exit: 1 })).env;
    expect(findProblem(tooMany, "LARGE_REPROCESS")).toMatchObject({
      asset: "sales_labels", fix: { kind: "command", command: "croft preview sales_labels --rows 1000" }, details: { confirmAbove: 1000, fits: 1000 },
    });
    expect(llm.calls).toBe(20);

    // The dry run and the run ask first: 1,205 new rows are over confirmAbove. No call is made.
    const dry = (await croftJson("run", ["run", "sales_labels", "--dry-run"])).env;
    expect(stepOf(dry, "sales_labels").confirmation).toMatchObject({ action: "large_reprocess", command: "croft run sales_labels", impact: { rows: 1205, estimatedRequests: 1205 } });
    const asked = await croftJson("run", ["run", "sales_labels"], { exit: 5 });
    const c = asked.env.confirmation;
    expect(c, show(asked.r)).toMatchObject({ command: "croft run sales_labels", impact: { asset: "sales_labels", rows: 1205, estimatedRequests: 1205 } });
    expect(findProblem(asked.env, "CONFIRMATION_REQUIRED")?.hint ?? "").toContain(`croft confirm ${c.token}`);
    expect(llm.calls).toBe(20);

    // The user said yes: croft confirm bills every row once.
    const done = await croftJson("confirm", ["confirm", c.token]);
    expect(stepOf(done.env, "sales_labels"), show(done.r)).toMatchObject({ status: "ok", requests: 1205, rows: { added: 1205, total: 1205 } });
    expect(llm.calls).toBe(20 + 1205);
    expect([...llm.auth]).toEqual([`Bearer ${LLM_TOKEN}`]);
    const q = (await croftJson("query", ["query", "SELECT result, count(*) AS n FROM sales_labels GROUP BY result ORDER BY result"])).env;
    expect(q.data.rows).toEqual([{ result: "domestic", n: 603 }, { result: "export", n: 602 }]);

    // Three new orders: under confirmAbove, the run downstream of the ingest bills just them, without asking.
    p.write("files/sales/2026-09-04.csv", salesCsv(1206, 1208));
    const small = await croftJson("run", ["run", "sales"]);
    expect(small.env.confirmation).toBeUndefined();
    expect(stepOf(small.env, "sales_labels"), show(small.r)).toMatchObject({ status: "ok", requests: 3, rows: { added: 3, total: 1208 } });
    expect(llm.calls).toBe(20 + 1205 + 3);
  }, 180_000);

  test("d. sql over the transform: as written, then a GROUP BY", async () => {
    // The asset changed most recently is the transform just edited.
    const made = (await croftJson("new", ["new", "sql", "label_counts"])).env;
    expect(made.data).toMatchObject({ asset: "label_counts", kind: "sql", pagination: null, file: "assets/label_counts.sql", reads: "sales_labels", secrets: [], created: ["assets/label_counts.sql"] });
    expect(made.next).toEqual([{ command: "croft preview label_counts", reason: expect.stringContaining("sales_labels") }]);
    const file = "assets/label_counts.sql";
    expect(p.read(file)).toContain("-- key: order_id");

    // As written (SELECT * over a built input) the bind check passes.
    const asWritten = (await croftJson("validate", ["validate", "label_counts"])).env;
    expect(asWritten.problems, JSON.stringify(asWritten.problems)).toEqual([]);

    // The Edit line: the SELECT, the key and the check.
    p.edit(file, "-- key: order_id", "-- key: label");
    p.edit(file, "  *                        -- list the columns it needs instead; rename them with AS", "  result AS label,\n  count(*) AS orders");
    p.edit(file, "FROM sales_labels\n", "FROM sales_labels\nGROUP BY result\n");
    const clean = (await croftJson("validate", ["validate", "label_counts"])).env;
    expect(clean.problems, JSON.stringify(clean.problems)).toEqual([]);

    const previewed = (await croftJson("preview", ["preview", "label_counts"])).env;
    expect(previewed.data.assets.find((a: { asset: string }) => a.asset === "label_counts")).toMatchObject({ status: "ok", rows: 2, liveRows: null });
    const ran = await croftJson("run", ["run", "label_counts"]);
    expect(stepOf(ran.env, "label_counts"), show(ran.r)).toMatchObject({ status: "ok", rows: { total: 2 } });
    const q = (await croftJson("query", ["query", "SELECT label, orders FROM label_counts ORDER BY label"])).env;
    expect(q.data.rows).toEqual([{ label: "domestic", orders: 604 }, { label: "export", orders: 604 }]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------
// e. Refusals, and --list

describe("e. refusals and croft new --list", () => {
  const assetFiles = () => readdirSync(join(p.root, "assets")).sort();

  test("NAME_CONFLICT: a name an asset file has (any kind), and a table whose asset file is gone; nothing is written", async () => {
    const files = assetFiles();
    const sameName = await croftJson("new", ["new", "sql", "sales"], { failed: true, exit: 2 });
    expect(findProblem(sameName.env, "NAME_CONFLICT"), show(sameName.r)).toMatchObject({
      file: "assets/sales.ts", fix: { kind: "command", command: "croft new sql sales_2" }, details: { name: "sales", file: "assets/sales.ts" },
    });
    const styled = await croftJson("new", ["new", "api", "tracker_issues", "--pagination", "keyset"], { failed: true, exit: 2 });
    expect(findProblem(styled.env, "NAME_CONFLICT")?.fix).toMatchObject({ command: "croft new api tracker_issues_2 --pagination keyset" });
    expect(assetFiles()).toEqual(files);
    expect(p.read("assets/sales.ts")).toContain('key: "order_id"');

    // The page ingest's file goes; its table (252 rows) stays, and a new asset of that name would write into it.
    p.remove("assets/catalog_products.ts");
    const orphan = await croftJson("new", ["new", "api", "catalog_products", "--pagination", "page"], { failed: true, exit: 2 });
    const problem = findProblem(orphan.env, "NAME_CONFLICT");
    expect(problem?.message ?? "", show(orphan.r)).toContain("already names a table (252 rows)");
    expect(problem).toMatchObject({ fix: { kind: "command", command: "croft new api catalog_products_2 --pagination page" }, details: { name: "catalog_products", rows: 252 } });
    expect(p.exists("assets/catalog_products.ts")).toBe(false);
  }, 60_000);

  test("a bad --pagination, --pagination on a kind without pages, a kind croft does not have, a name that is no table name", async () => {
    const files = assetFiles();
    const typo = await croftJson("new", ["new", "api", "refunds", "--pagination", "cursr"], { failed: true, exit: 2 });
    expect(findProblem(typo.env, "USAGE_ERROR"), show(typo.r)).toMatchObject({
      fix: { kind: "command", command: "croft new api refunds --pagination cursor" }, details: { pagination: "cursr", suggestion: "cursor" },
    });
    const unknown = await croftJson("new", ["new", "api", "refunds", "--pagination", "offset"], { failed: true, exit: 2 });
    expect(findProblem(unknown.env, "USAGE_ERROR")?.message ?? "").toContain("keyset, cursor, link and page");
    expect(findProblem(unknown.env, "USAGE_ERROR")?.fix).toMatchObject({ command: "croft new --list" });
    const noPages = await croftJson("new", ["new", "file", "refunds", "--pagination", "page"], { failed: true, exit: 2 });
    expect(findProblem(noPages.env, "USAGE_ERROR")?.fix, show(noPages.r)).toMatchObject({ command: "croft new file refunds" });
    const ingest = await croftJson("new", ["new", "ingest", "refunds"], { failed: true, exit: 2 });
    expect(findProblem(ingest.env, "USAGE_ERROR")?.hint ?? "", show(ingest.r)).toContain("croft new api refunds");
    const path = await croftJson("new", ["new", "sql", "assets/refunds.sql"], { failed: true, exit: 2 });
    expect(findProblem(path.env, "NAME_INVALID")?.fix, show(path.r)).toMatchObject({ command: "croft new sql refunds" });
    expect(assetFiles()).toEqual(files);
  }, 60_000);

  test("croft new --list: every kind and pagination style, and when each applies", async () => {
    const list = (await croftJson("new", ["new", "--list"])).env;
    expect(list.data.templates.map((t: { kind: string; pagination: string | null }) => `${t.kind}${t.pagination ? `:${t.pagination}` : ""}`))
      .toEqual(["api:keyset", "api:cursor", "api:link", "api:page", "file", "sql", "transform"]);
    expect(list.data.templates.filter((t: { default: boolean }) => t.default).map((t: { command: string }) => t.command)).toEqual(["croft new api <name> --pagination cursor"]);
    const human = await p.croft(["new", "--list"]);
    expect(human.code, show(human)).toBe(0);
    for (const style of ["keyset", "cursor", "link", "page"]) expect(human.stdout).toContain(`croft new api <name> --pagination ${style}`);
    for (const kind of ["file", "sql", "transform"]) expect(human.stdout).toContain(`croft new ${kind} <name>`);
  }, 60_000);
});
