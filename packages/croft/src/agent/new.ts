// The templates `croft new` writes (DESIGN.md §3a–§3e, §4.1, §4.2): commented, working assets that pass croft
// validate as written, with a placeholder URL (api.example.com) and a secret named after the asset.
//
// - api, by pagination style (§3a): keyset (ascending since, re-queried from the newest value seen, KEYSET_STUCK
//   when a page cannot move), cursor (the API's own starting_after/has_more over a newest-first list, filtered by
//   creation time, with an epoch cursor, its unit and a lookback: the Stripe shape), link (the Link header's
//   res.next, filtered by an updated-since parameter) and page (page/per_page until an empty page, re-read in
//   full each run). Each reads one secret and says when it applies.
// - file (§3b): a CSV glob under files/<name>/, incremental (new and changed files only), with a key.
// - sql (§3c): the header (description, key, a check) and one SELECT over an existing asset.
// - transform (§3e): keyed, incremental, newRows() over an existing asset with a key, the paid call as a comment,
//   and confirmAbove (the cost guard). newRows("x") takes no type argument, so its rows get x's generated row type
//   (.croft/types) and validate --types sees a column renamed upstream; the key and the yielded names are the
//   cleaned names (§7) a TS asset's output columns get.
//
// templateFor is pure: it renders text. The command (cli/commands/new.ts) checks the name, picks the input an sql
// or transform template reads, writes the file and says what to do next. agent/contract.test.ts reads every
// string here like any other agent-facing text; new.test.ts validates every rendered template in a project.

export type NewKind = "api" | "file" | "sql" | "transform";
export type Pagination = "keyset" | "cursor" | "link" | "page";

export const NEW_KINDS: readonly NewKind[] = ["api", "file", "sql", "transform"];
export const PAGINATIONS: readonly Pagination[] = ["keyset", "cursor", "link", "page"];
/** `croft new api <name>` without --pagination: newest-first lists with the API's own cursor are the common case,
 *  and the safe one (§9 APIs: keyset only when the API sorts ascending). */
export const DEFAULT_PAGINATION: Pagination = "cursor";

/** The asset an sql or transform template reads. */
export interface TemplateInput {
  asset: string;
  /** Its key columns: the sql template keeps them, the transform's newRows() needs them (INPUT_NEEDS_KEY). */
  key: string[];
  /** Why the command picked it, in words ("the asset changed most recently"); shown in the file and the Edit line. */
  why?: string;
}

/** What `croft init` makes: the default input, so templateFor works without a project. */
export const EXAMPLE_INPUT: TemplateInput = { asset: "example_sales", key: ["order_id"] };

export interface TemplateOptions {
  /** api only; default DEFAULT_PAGINATION. */
  pagination?: Pagination;
  /** sql and transform: the asset it reads (default EXAMPLE_INPUT). A transform's input needs a key. */
  input?: TemplateInput;
}

export interface Template {
  kind: NewKind;
  pagination?: Pagination;
  /** Relative to the project root: assets/<name>.ts or .sql. */
  path: string;
  content: string;
  /** One line: what it is and what to edit (`what`, then `edit`). */
  summary: string;
  /** What it is, for "Created assets/x.ts (<what>)": "cursor pagination: starting_after/has_more". */
  what: string;
  /** What to edit before the first preview, for "Edit: <edit>." */
  edit: string;
  /** Secrets the template reads (ctx.secret), for the next step. */
  secrets: string[];
  /** The asset an sql or transform template reads. */
  reads?: string;
  /** The folder a file ingest reads, relative to the project root, ending in "/". */
  folder?: string;
}

export interface TemplateKind {
  kind: NewKind;
  pagination?: Pagination;
  /** When it applies, in one line. */
  description: string;
  /** `croft new api <name>` without --pagination writes this style. */
  default?: boolean;
}

/** The kinds and styles, for `croft new --list`, each with when it applies. */
export const TEMPLATE_KINDS: readonly TemplateKind[] = [
  { kind: "api", pagination: "keyset", description: "the API sorts ascending by a field that grows as records change (updated_at) and filters by it" },
  { kind: "api", pagination: "cursor", default: true, description: "newest first, paged by the API's own cursor (starting_after/has_more, next_page_token): Stripe and most list endpoints" },
  { kind: "api", pagination: "link", description: "the next page's URL is in the Link header (rel=\"next\"), as in GitHub, GitLab and many REST APIs" },
  { kind: "api", pagination: "page", description: "page numbers only (page/per_page): safe only for data that does not change while it is read" },
  { kind: "file", description: "CSV files dropped into a folder (or one file at a URL); new and changed files are loaded" },
  { kind: "sql", description: "a filter, join or aggregate over other assets, as one SELECT; rebuilt when an input changes" },
  { kind: "transform", description: "per-row TypeScript over another asset, such as one API or LLM call per row; incremental" },
];

/** Render the template for a new asset. Pure: the caller has checked the name and picked the input. Throws for a
 *  transform whose input has no key (the command refuses that first: newRows() needs one). */
export function templateFor(kind: NewKind, name: string, o: TemplateOptions = {}): Template {
  switch (kind) {
    case "api": return apiTemplate(name, o.pagination ?? DEFAULT_PAGINATION);
    case "file": return fileTemplate(name);
    case "sql": return sqlTemplate(name, o.input ?? EXAMPLE_INPUT);
    case "transform": return transformTemplate(name, o.input ?? EXAMPLE_INPUT);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Names and layout

/** The secret an api template reads: the name's first word ("stripe_charges" → STRIPE_KEY, §4.2), or the whole name
 *  when that word is short ("hn_stories" → HN_STORIES_KEY) or the name is one word ("orders" → ORDERS_KEY). */
export function secretNameFor(name: string): string {
  const first = name.split("_")[0] ?? name;
  const base = first.length >= 3 && first !== name ? first : name;
  return `${base.toUpperCase()}_KEY`;
}

/** A readable default description: "stripe_charges" → "Stripe charges". */
export function titleWords(name: string): string {
  const words = name.split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The placeholder endpoint's last path segment: the name's last word ("stripe_charges" → charges). */
function endpoint(name: string): string {
  const last = name.split("_").filter(Boolean).at(-1) ?? name;
  return /^[a-z]{3,}/.test(last) ? last : name;
}

const TS_IDENT = /^[A-Za-z_$][\w$]*$/;
/** A property name in a TS object literal or type: order_id, or "Order ID". */
const tsProp = (col: string): string => (TS_IDENT.test(col) ? col : JSON.stringify(col));
/** Reading a column from a row: row.order_id, or row["Order ID"]. */
const tsAccess = (obj: string, col: string): string => (TS_IDENT.test(col) ? `${obj}.${col}` : `${obj}[${JSON.stringify(col)}]`);
/** key: "id", or key: ["day", "region"]. */
const tsKey = (key: readonly string[]): string => (key.length === 1 ? JSON.stringify(key[0]) : `[${key.map((k) => JSON.stringify(k)).join(", ")}]`);
/** A column or table in SQL: plain when it is a simple lower-case name, else double-quoted. */
const sqlName = (col: string): string => (/^[a-z_][a-z0-9_]*$/.test(col) ? col : `"${col.replaceAll("\"", "\"\"")}"`);

/** Where trailing comments start in TS templates. */
const NOTE_COLUMN = 46;
/** How wide comment paragraphs are wrapped. */
const WRAP = 116;

/** A code line with a trailing comment, aligned: `  key: "id",            // …`. */
function note(code: string, text: string, column = NOTE_COLUMN): string {
  return `${code.padEnd(column - 1)} // ${text}`;
}

// An SQL header line is `-- name: value` (project/sql-asset.ts HEADER_LINE): a comment line in the header must never
// start with one word and a colon, or it is read as one (HEADER_UNKNOWN_KEY).
const HEADER_LIKE = /^[A-Za-z_][A-Za-z0-9_]*\s*:(?!\/\/)/;

/** A paragraph as comment lines: `lead` ("// " or "-- ") and words wrapped at WRAP. A command stays on one line
 *  with its first word ("croft describe"), and no line starts with `word:`, which an SQL header would read as a
 *  header line: such a word goes down with the word before it. */
function comment(lead: string, text: string): string[] {
  const words: string[] = [];
  for (const w of text.split(" ")) {
    if (words.length && /(^|\()croft$/.test(words.at(-1)!)) words[words.length - 1] += ` ${w}`;
    else words.push(w);
  }
  const lines: string[][] = [[]];
  let length = lead.length;
  for (const word of words) {
    const line = lines.at(-1)!;
    if (line.length > 0 && length + 1 + word.length > WRAP) {
      const next: string[] = [word];
      if (HEADER_LIKE.test(word) && line.length > 1) next.unshift(line.pop()!);
      lines.push(next);
      length = lead.length + next.join(" ").length;
    } else {
      line.push(word);
      length += (line.length > 1 ? 1 : 0) + word.length;
    }
  }
  return lines.map((l) => `${lead}${l.join(" ")}`);
}

/** Paragraphs as one comment block, separated by empty comment lines. */
function block(lead: string, paragraphs: readonly string[]): string[] {
  return paragraphs.flatMap((p, i) => [...(i ? [lead.trimEnd()] : []), ...comment(lead, p)]);
}

function finish(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

function make(t: Omit<Template, "summary">): Template {
  return { ...t, summary: `${t.what}. Edit: ${t.edit}` };
}

// ---------------------------------------------------------------------------------------------------------
// API ingests (§3a)

const API_WHAT: Record<Pagination, string> = {
  keyset: "keyset pagination: ascending since",
  cursor: "cursor pagination: starting_after/has_more",
  link: "Link header pagination: res.next",
  page: "page pagination: page/per_page until an empty page",
};

/** How the first line names the style. */
const API_STYLE: Record<Pagination, string> = {
  keyset: "keyset pagination", cursor: "cursor pagination", link: "Link header pagination", page: "page numbers",
};

const API_EDIT: Record<Pagination, string> = {
  keyset: "the URL, the sort and since parameters, the cursor field and the Item type; keep the ascending sort (see comments)",
  // DESIGN.md §4.2, word for word.
  cursor: "the URL, the cursor field and whether records change after creation (see comments)",
  link: "the URL, the updated-since parameter and the cursor field, or remove both to re-read every page (see comments)",
  page: "the URL, the page parameters, the Item type and the key (see comments)",
};

/** When each style applies, and what to edit: the comment block at the top of the file. */
const API_ABOUT: Record<Pagination, string[]> = {
  keyset: [
    "When this applies: the API sorts ascending by a field that grows whenever a record is created or changed (updated_at "
    + "here), and filters by it. Each request asks for the records from the newest value seen so far, so pages cannot shift "
    + "under the fetch, and each run fetches only what changed since the last one. If the API returns the newest records "
    + "first, this skips records: use the cursor style instead (croft new --list).",
    "To edit: the URL and the auth header, the sort and filter parameters, the Item type, key, and the cursor field "
    + "(incremental). Keep the ascending sort.",
  ],
  cursor: [
    "When this applies: the API returns the newest records first and pages with its own cursor (starting_after and has_more "
    + "here, as Stripe does; elsewhere next_page_token, next_cursor or after), and filters by creation time. Most list "
    + "endpoints work this way. Records that change after they are created (payments, refunds, orders, tickets) are caught "
    + "by the lookback: each run reads a recent window again, and the key merges what changed.",
    "To edit: the URL and the auth header, the filter and cursor parameters, the Item and Page types, key, and the cursor "
    + "field with its unit (\"s\" for epoch seconds, \"ms\" for milliseconds, none for ISO timestamps) and its lookback: how "
    + "long after creation a record can still change (remove lookback if records never change).",
  ],
  link: [
    "When this applies: the API puts the next page's URL in a Link header (rel=\"next\"), as GitHub, GitLab and many REST "
    + "APIs do; res.next is that URL, and undefined on the last page. With an \"updated since\" filter (updated_after here) "
    + "each run fetches only what changed since the last one. If the API has no such filter, remove incremental and the "
    + "updated_after parameter: each run then reads every page and replaces the table (rows that did not change keep "
    + "their _loaded_at).",
    "To edit: the URL and the auth header, the filter parameter, the Item type, key, and the cursor field (incremental).",
  ],
  page: [
    "When this applies: the API only offers page numbers (page=1, 2, 3, … with per_page). Pages shift when records are "
    + "added or removed during the fetch, so a record can be read twice (the key stores it once) or skipped (the next run "
    + "reads it): use this only for data that does not change while it is read, such as reference lists, reports and "
    + "archives. If the API has a cursor, a Link header or an ascending \"updated since\" sort, use that style instead "
    + "(croft new --list). Without a cursor, each run reads every page and replaces the table; rows that did not change "
    + "keep their _loaded_at.",
    "To edit: the URL and the auth header, the page parameters, the Item type and key.",
  ],
};

const ITEM_NOTE = "// The fields this code reads. The table gets every field the API returns (nested objects become JSON columns).";

function apiTemplate(name: string, pagination: Pagination): Template {
  const secret = secretNameFor(name);
  const url = JSON.stringify(`https://api.example.com/v1/${endpoint(name)}`);
  const auth = `{ Authorization: \`Bearer \${secret(${JSON.stringify(secret)})}\` }`;
  const head = (key: string, schedule: string, check: string, incremental?: [string, string, number?]) => [
    "export default ingest({",
    note(`  description: ${JSON.stringify(titleWords(name))},`, "one line: what a row is (croft describe shows it)"),
    note(`  secrets: [${JSON.stringify(secret)}],`, `read from .env: ask the user to add ${secret}=... there`),
    note("  key: \"id\",", key),
    ...(incremental ? [note(`  incremental: ${incremental[0]},`, incremental[1], incremental[2])] : []),
    note(`  // schedule: ${JSON.stringify(schedule)},`, "fetch on its own once scheduling is on (croft docs scheduling)"),
    note(`  // checks: [${JSON.stringify(check)}],`, "rules every load must pass (croft docs checks)"),
    "",
  ];
  const updatedAt: [string, string] = ["\"updated_at\"", "croft saves the newest updated_at it loaded; since hands it back"];
  let code: string[];
  switch (pagination) {
    case "keyset":
      code = [
        "import { fail, ingest } from \"@zabaca/croft\";",
        "",
        ITEM_NOTE,
        "type Item = { id: number; updated_at: string };",
        "",
        "const PAGE_SIZE = 100;",
        "",
        ...head("a record fetched again replaces its old row", "every hour", "not_null(updated_at)", updatedAt),
        "  async *rows({ since, http, secret }) {",
        "    // since: undefined on the first run (fetch everything); later the saved updated_at minus 1 second, so the",
        "    // records on the boundary come again, and the key stores each of them once.",
        "    let from = since;",
        "    for (;;) {",
        `      const res = await http.get(${url}, {`,
        `        headers: ${auth},`,
        "        // Oldest first, from the newest value seen. undefined query values are left out of the URL.",
        "        query: { sort: \"updated_at\", direction: \"asc\", per_page: PAGE_SIZE, since: from },",
        "      });",
        note("      const page = res.json<Item[]>();", "res.json() keeps big integers exact"),
        note("      yield page;", "an array is one batch of rows"),
        note("      if (page.length < PAGE_SIZE) return;", "a short page is the last one"),
        "      const last = page.at(-1)!.updated_at;",
        "      // A full page whose records all share one updated_at would ask for the same page forever.",
        "      if (last === from) fail(\"KEYSET_STUCK\", `${PAGE_SIZE}+ records share updated_at ${last}`);",
        note("      from = last;", "ask again from the newest value seen"),
        "    }",
        "  },",
        "});",
      ];
      break;
    case "cursor":
      code = [
        "import { ingest } from \"@zabaca/croft\";",
        "",
        ITEM_NOTE,
        "type Item = { id: string; created: number };",
        "type Page = { data: Item[]; has_more: boolean };",
        "",
        ...head("a record read again replaces its old row", "every hour", "not_null(created)",
          ["{ field: \"created\", unit: \"s\", lookback: \"30 days\" }", "epoch seconds; re-read the last 30 days", 72]),
        "  async *rows({ since, http, secret }) {",
        "    // since: undefined on the first run (fetch everything); later a number: the newest created saved, minus 30",
        "    // days. The pages follow the API's cursor: newest first, back to since.",
        "    let after: string | undefined;",
        "    for (;;) {",
        `      const res = await http.get(${url}, {`,
        `        headers: ${auth},`,
        "        // undefined query values are left out: the first run sends no filter, the first page no cursor.",
        "        query: { limit: 100, \"created[gte]\": since, starting_after: after },",
        "      });",
        note("      const page = res.json<Page>();", "res.json() keeps big integers exact"),
        note("      yield page.data;", "an array is one batch of rows"),
        "      if (!page.has_more || page.data.length === 0) return;",
        note("      after = page.data.at(-1)!.id;", "the next page starts after this page's last record"),
        "    }",
        "  },",
        "});",
      ];
      break;
    case "link":
      code = [
        "import { ingest } from \"@zabaca/croft\";",
        "",
        ITEM_NOTE,
        "type Item = { id: number; updated_at: string };",
        "",
        ...head("a record fetched again replaces its old row", "every hour", "not_null(updated_at)", updatedAt),
        "  async *rows({ since, http, secret }) {",
        "    // since: undefined on the first run (fetch everything); later the saved updated_at minus 1 second.",
        `    const headers = ${auth};`,
        "    // Only the first request carries the filter: each next URL holds its own query. undefined values are left out.",
        `    let res = await http.get(${url}, {`,
        "      headers,",
        "      query: { per_page: 100, updated_after: since },",
        "    });",
        "    for (;;) {",
        note("      yield res.json<Item[]>();", "one batch of rows; res.json() keeps big integers exact"),
        note("      if (!res.next) return;", "no rel=\"next\": this was the last page"),
        "      res = await http.get(res.next, { headers });",
        "    }",
        "  },",
        "});",
      ];
      break;
    case "page":
      code = [
        "import { ingest } from \"@zabaca/croft\";",
        "",
        ITEM_NOTE,
        "type Item = { id: number };",
        "",
        "const PAGE_SIZE = 100;",
        "",
        ...head("identifies a record: one read twice is stored once", "daily at 06:00", "min_rows(1)"),
        "  async *rows({ http, secret }) {",
        "    for (let page = 1; ; page++) {",
        `      const res = await http.get(${url}, {`,
        `        headers: ${auth},`,
        "        query: { page, per_page: PAGE_SIZE },",
        "      });",
        note("      const items = res.json<Item[]>();", "res.json() keeps big integers exact"),
        note("      if (items.length === 0) return;", "an empty page: past the last one"),
        note("      yield items;", "an array is one batch of rows"),
        "    }",
        "  },",
        "});",
      ];
      break;
  }
  const lines = [
    `// assets/${name}.ts: an API ingest with ${API_STYLE[pagination]} (croft new api ${name} --pagination ${pagination}).`,
    "//",
    ...block("// ", API_ABOUT[pagination]),
    ...code,
  ];
  return make({
    kind: "api", pagination, path: `assets/${name}.ts`, content: finish(lines),
    what: API_WHAT[pagination], edit: API_EDIT[pagination], secrets: [secret],
  });
}

// ---------------------------------------------------------------------------------------------------------
// File ingest (§3b)

function fileTemplate(name: string): Template {
  const folder = `files/${name}/`;
  const lines = [
    `// assets/${name}.ts: a file ingest (croft new file ${name}).`,
    "//",
    ...block("// ", [
      "When this applies: the data comes as files, such as exports someone downloads or files another system drops into a "
      + `folder. Every CSV in ${folder} is loaded once; a file that changes is loaded again, and a new file adds its rows. `
      + "For one file at a URL, set file to the URL: it is downloaded, and skipped while it is unchanged. Other formats are "
      + "read by their extension: .tsv, .json, .ndjson/.jsonl and .parquet.",
      `To edit: put the files in ${folder}, then set key to the column that identifies a row.`,
    ]),
    "import { ingest } from \"@zabaca/croft\";",
    "",
    "export default ingest({",
    note(`  description: ${JSON.stringify(titleWords(name))},`, "one line: what a row is (croft describe shows it)"),
    note(`  file: ${JSON.stringify(`${folder}*.csv`)},`, "a path, glob or URL; paths are relative to the project folder"),
    note("  incremental: true,", "only new and changed files are read; croft remembers each file"),
    note("  key: \"id\",", "the column that identifies a row: exports overlap, and the key"),
    note("", "keeps one row per id, from the newest file. No such column?"),
    note("", "Remove key; rows are then tracked by the file they came from."),
    note("  // csv: { header: true },", "say whether line 1 is a header when every column is text"),
    note("  // map: (row) => ({ ...row, email: String(row.email ?? \"\").trim().toLowerCase() }),", "clean values", 90),
    note("  // schedule: \"daily at 06:00\",", "look for new files on its own once scheduling is on"),
    note("  // checks: [\"min_rows(1)\"],", "rules every load must pass (croft docs checks)"),
    "});",
  ];
  return make({
    kind: "file", path: `assets/${name}.ts`, content: finish(lines), secrets: [], folder,
    what: `file ingest: the CSV files in ${folder}, new and changed files only`,
    edit: `put the CSV files in ${folder}, then set key to the column that identifies a row (see comments)`,
  });
}

// ---------------------------------------------------------------------------------------------------------
// SQL transform (§3c). Header lines are `-- name: value`, and take no trailing comment; comment() keeps every plain
// comment line from starting like one.

function sqlTemplate(name: string, input: TemplateInput): Template {
  const why = input.why ? ` (${input.why})` : "";
  const key = input.key.length
    ? [
      ...comment("-- ", `The key is what identifies a row (${input.asset} has the same); it adds unique and not_null checks.`),
      `-- key: ${input.key.map(sqlName).join(", ")}`,
    ]
    : comment("-- ", `${input.asset} has no key. When a column identifies a row, add a key line like the description line `
      + "above: it adds unique and not_null checks, and a TypeScript transform that reads this table with newRows() needs one.");
  const lines = [
    `-- assets/${name}.sql: an SQL transform (croft new sql ${name}).`,
    "--",
    ...block("-- ", [
      "When this applies: the table can be computed from other assets with one SELECT, such as a filter, a join or an "
      + "aggregate. croft finds what it reads in the SQL, builds those first, and rebuilds this table in full whenever one of "
      + "them changes (there is no incremental SQL); rows that did not change keep their _loaded_at. For per-row code, such "
      + "as an API or LLM call per row, make a TypeScript transform instead (croft new transform <name>). SQL reads assets, "
      + "never files: for a file, make a file ingest first (croft new file <name>).",
      `It reads ${input.asset}${why}. To edit: the SELECT, the key and the check. croft describe ${input.asset} lists the `
      + "columns. The header is the -- lines with a name and a colon below, above any SQL (croft docs sql).",
    ]),
    `-- description: ${titleWords(name)}`,
    ...key,
    ...comment("-- ", "A check line is a rule every build must pass (croft docs checks); an empty result is usually a mistake."),
    "-- check: min_rows(1)",
    "SELECT",
    "  *                        -- list the columns it needs instead; rename them with AS",
    `FROM ${sqlName(input.asset)}`,
    "-- WHERE …                 -- keep only the rows it needs",
  ];
  return make({
    kind: "sql", path: `assets/${name}.sql`, content: finish(lines), secrets: [], reads: input.asset,
    what: `SQL transform over ${input.asset}`,
    edit: `the SELECT (it reads ${input.asset}${input.why ? `, ${input.why}` : ""}), the key and the check (see comments)`,
  });
}

// ---------------------------------------------------------------------------------------------------------
// TypeScript transform (§3e)

function transformTemplate(name: string, input: TemplateInput): Template {
  if (input.key.length === 0) throw new Error(`templateFor(transform): the input ${input.asset} has no key; newRows() needs one`);
  const why = input.why ? ` (${input.why})` : "";
  // The output column the placeholder computes; never one of the key columns it copies.
  const result = input.key.includes("result") ? "result_value" : "result";
  const keyCopy = input.key.map((k) => `${tsProp(k)}: ${tsAccess("row", k)}`).join(", ");
  const label = input.key.map((k) => `\${${tsAccess("row", k)}}`).join(" ");
  const lines = [
    `// assets/${name}.ts: a TypeScript transform (croft new transform ${name}).`,
    "//",
    ...block("// ", [
      "When this applies: per-row work that SQL cannot do, above all one API or LLM call per row (classify, enrich, "
      + "summarize, geocode), or parsing and scoring with a library. It is incremental: newRows() hands each input row over "
      + "once, and again only when it changes upstream, so a paid call is never repeated for rows already done. For "
      + "filters, joins and aggregates, write SQL instead (croft new sql <name>).",
      `It reads ${input.asset}${why}. To edit: inputs and newRows() for the asset it should read, the per-row work (the `
      + "paid call goes where the comment shows), what each row yields, and the checks. Once it makes paid calls, preview "
      + `it with croft preview ${name} --rows 20: each input row is one call.`,
      `Each row has the columns of ${input.asset} (croft describe ${input.asset} lists them). Once ${input.asset} has been `
      + `run or previewed they are typed by name (.croft/types/${input.asset}.d.ts), and croft validate --types reports `
      + `code that reads a column ${input.asset} does not have, such as one renamed upstream; until then each column is `
      + `unknown. So keep newRows(${JSON.stringify(input.asset)}) without a type argument: newRows<T>() replaces the `
      + "generated type, and tsc no longer sees a rename.",
    ]),
    "import { transform } from \"@zabaca/croft\";",
    "",
    "export default transform({",
    note(`  description: ${JSON.stringify(titleWords(name))},`, "one line: what a row is (croft describe shows it)"),
    note(`  inputs: [${JSON.stringify(input.asset)}],`, "the assets this code reads; croft builds them first"),
    note(`  key: ${tsKey(input.key)},`, `one output row per input row, by the key of ${input.asset}`),
    note("  incremental: true,", "newRows() gives only rows not processed yet; results merge"),
    note("", "by key, committed in chunks, so a failure loses little"),
    note("  confirmAbove: 1000,", "the cost guard: a run that would send more input rows than"),
    note("", "this to code that makes requests asks first (a first build,"),
    note("", "a large upstream change). Raise it only with the user's yes."),
    note(`  checks: [${JSON.stringify(`not_null(${result})`)}],`, "rules every chunk must pass (croft docs checks)"),
    "",
    "  async *rows({ newRows, log }) {",
    "    let n = 0;",
    `    for await (const row of newRows(${JSON.stringify(input.asset)})) {`,
    "      // A paid call per row goes here, for example a classification API (add http and secret to the arguments",
    "      // of rows above, and secrets: [\"EXAMPLE_KEY\"] to the config, then ask the user to add it to .env):",
    "      //   const res = await http.post(\"https://api.example.com/v1/classify\", { text: String(row.title) }, {",
    "      //     headers: { Authorization: `Bearer ${secret(\"EXAMPLE_KEY\")}` },",
    "      //   });",
    `      //   const ${result} = res.json<{ label: string }>().label;`,
    "      // croft sees the requests: validate and the cost guard treat it as paid work from then on.",
    note(`      const ${result} = \`${label}\`;`, "replace with what you compute for this row"),
    note(`      yield { ${keyCopy}, ${result} };`, "yield before taking the next row: croft saves its place"),
    "      if (++n % 100 === 0) log(`${n} rows processed`);",
    "    }",
    "  },",
    "});",
  ];
  return make({
    kind: "transform", path: `assets/${name}.ts`, content: finish(lines), secrets: [], reads: input.asset,
    what: `incremental TypeScript transform over ${input.asset}`,
    edit: `inputs and newRows() (they read ${input.asset}${input.why ? `, ${input.why}` : ""}), the per-row work where the paid call goes, `
      + "what each row yields and the checks (see comments)",
  });
}
