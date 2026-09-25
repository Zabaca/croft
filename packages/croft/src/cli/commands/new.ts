// croft new <kind> <name> / croft new --list (DESIGN.md §4.1, §4.2, §3): write a commented, working template for a
// new asset (agent/new.ts renders it) and say what to edit and what to do next.
//
// 1. The arguments: a kind (api, file, sql, transform; a typo or a near miss such as "ingest" is USAGE_ERROR with the
//    way to say it), a name, and --pagination for api only (default cursor; a bad style is USAGE_ERROR with a
//    did-you-mean).
// 2. The name must work as a table name (NAME_INVALID, NAME_RESERVED: project/discover.ts nameProblem, with a usable
//    name in the fix) and be free: no asset file of that name in assets/** (any extension, any folder), and no table
//    of that name in the catalog mirror whose file is gone (NAME_CONFLICT, with the first free <name>_2, _3, … in the
//    fix). croft new never overwrites a file: the file is created exclusively.
// 3. An sql or transform template reads an existing asset: the asset whose file changed most recently (the one the
//    user just made, as a rule), keyed for a transform, since newRows() needs a key (INPUT_NEEDS_KEY when no asset
//    has one). With nothing to read, it is USAGE_ERROR: bring data in first.
// 4. Write the file (and a file ingest's folder under files/), then next[]: `croft secrets` while a secret the
//    template reads is missing (the user adds it; the agent never reads .env), else `croft preview <name>`.
//
// It never opens the warehouse: the catalog mirror (runs.sqlite) says which tables exist.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PAGINATION, NEW_KINDS, type NewKind, type Pagination, PAGINATIONS, TEMPLATE_KINDS, type Template, type TemplateInput,
  templateFor,
} from "../../agent/new.ts";
import { CroftError } from "../../core/errors.ts";
import { allCatalog, type CatalogAsset } from "../../history/catalog.ts";
import { RUNS_DB_FILE, RunsDb } from "../../history/runs-db.ts";
import { discoverAssets, nameProblem, sqlKeywordNames } from "../../project/discover.ts";
import { resolveProject } from "../../project/resolve.ts";
import type { Project } from "../../project/root.ts";
import { didYouMean } from "../../project/suggest.ts";
import type { CommandImpl, Next } from "../command.ts";
import { formatCount } from "../render.ts";

/** `croft new <kind> <name> --json` data. */
export interface NewAssetData {
  /** The new asset's name, which is its table's. */
  asset: string;
  kind: NewKind;
  /** The api template's style; null for the other kinds. */
  pagination: Pagination | null;
  /** The file written, relative to the project root: assets/<name>.ts, or .sql for sql. */
  file: string;
  /** What it is: "cursor pagination: starting_after/has_more". */
  what: string;
  /** What to edit before the first preview. */
  edit: string;
  /** The asset an sql or transform template reads; null for ingests. */
  reads: string | null;
  /** The secrets the template reads, and whether each is set now (.env or the shell). Values are never shown. */
  secrets: { name: string; status: "set" | "missing" }[];
  /** What was created, relative to the project root: the file, and a file ingest's folder when it was missing
   *  ("files/sales/"). */
  created: string[];
}

/** One template of `croft new --list`. */
export interface NewTemplateEntry {
  kind: NewKind;
  pagination: Pagination | null;
  /** The style `croft new api <name>` writes without --pagination. */
  default: boolean;
  /** "croft new api <name> --pagination keyset". */
  command: string;
  /** When it applies. */
  description: string;
}

/** `croft new --list --json` data. */
export interface NewListData {
  templates: NewTemplateEntry[];
}

export type NewData = NewAssetData | NewListData;

/** "a, b and c"; ORS: "a, b or c". */
const WORDS = (xs: readonly string[], last = "and"): string => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${last} ${xs.at(-1)}`);
const ORS = (xs: readonly string[]): string => WORDS(xs, "or");

/** Kinds people reach for that croft spells differently: what to say instead. */
const NEAR_KINDS: Record<string, { hint: (name: string) => string; kind?: NewKind }> = {
  ingest: { hint: (n) => `an ingest is croft new api ${n} (from an API) or croft new file ${n} (from files)` },
  csv: { kind: "file", hint: (n) => `files are croft new file ${n}` },
  json: { kind: "file", hint: (n) => `files are croft new file ${n}` },
  parquet: { kind: "file", hint: (n) => `files are croft new file ${n}` },
  ts: { kind: "transform", hint: (n) => `a TypeScript transform is croft new transform ${n}` },
  typescript: { kind: "transform", hint: (n) => `a TypeScript transform is croft new transform ${n}` },
  http: { kind: "api", hint: (n) => `an API ingest is croft new api ${n}` },
  rest: { kind: "api", hint: (n) => `an API ingest is croft new api ${n}` },
};

export const newAsset: CommandImpl<NewData> = {
  async run(ctx) {
    if (ctx.values.list === true) return { data: { templates: listTemplates() }, problems: [], next: [] };

    const [kindArg, name] = ctx.positionals;
    const kind = parseKind(kindArg, name);
    if (!name) {
      throw new CroftError("USAGE_ERROR", {
        message: `croft new ${kind} needs the new asset's name`,
        hint: `e.g. croft new ${kind} ${kind === "api" ? "stripe_charges" : kind === "file" ? "sales" : kind === "sql" ? "daily_revenue" : "issue_labels"}; the name becomes the table's name`,
        fix: { kind: "command", description: "see the kinds and when each applies", command: "croft new --list" },
      });
    }
    const pagination = parsePagination(ctx.values.pagination, kind, name);
    const again = (n: string) => `croft new ${kind} ${n}${ctx.values.pagination !== undefined && pagination ? ` --pagination ${pagination}` : ""}`;

    const keywords = await sqlKeywordNames();
    const ext = kind === "sql" ? "sql" : "ts";
    const bad = nameProblem(name, `assets/${name}.${ext}`, keywords);
    if (bad) {
      const to = String(bad.details?.suggestion ?? "");
      throw new CroftError(bad.code === "NAME_RESERVED" ? "NAME_RESERVED" : "NAME_INVALID", {
        message: bad.details?.reason === "keyword" ? bad.message.replace(/; rename to \S+$/, `; use ${to}`) : bad.message,
        hint: `use a name that works as a table name: ${again(to)}`,
        fix: { kind: "command", description: `write the template as ${to}`, command: again(to) },
        effect: "nothing was written",
        details: { ...bad.details, name },
      });
    }

    const project = ctx.project;
    const { assetsDir, stateDir } = project.paths;
    const discovery = await discoverAssets(project.root, { assetsDir, keywords });
    const tables = new Map(readCatalog(stateDir).map((c) => [c.asset, c]));
    const files = new Map<string, string>();
    for (const a of discovery.assets) files.set(a.name, a.file);
    for (const p of discovery.problems) {
      const n = p.details?.name;
      if (typeof n === "string" && typeof p.file === "string" && !files.has(n)) files.set(n, p.file);
    }
    const target = `assets/${name}.${ext}`;
    const taken = (n: string) => files.has(n) || tables.has(n) || existsSync(join(project.root, `assets/${n}.ts`)) || existsSync(join(project.root, `assets/${n}.sql`));
    const free = () => {
      for (let k = 2; ; k++) {
        const n = `${name}_${k}`;
        if (!taken(n) && !nameProblem(n, `assets/${n}.${ext}`, keywords)) return n;
      }
    };
    const existing = files.get(name) ?? (existsSync(join(project.root, target)) ? target : undefined);
    if (existing) throw fileConflict(name, existing, again(free()));
    const table = tables.get(name);
    if (table) {
      const other = again(free());
      throw new CroftError("NAME_CONFLICT", {
        message: `${name} already names a table (${formatCount(table.rows)} row${table.rows === 1 ? "" : "s"}) whose asset file is gone; a new asset of that name would write into it`,
        hint: `choose another name (${other}), or ask the user what should become of the table ${name} before an asset takes it over (croft describe ${name} shows it)`,
        fix: { kind: "command", description: "write the template under a name no asset or table has", command: other },
        effect: "nothing was written",
        details: { name, rows: table.rows, kind: table.kind },
      });
    }

    const input = kind === "sql" || kind === "transform" ? await chooseInput(project, kind, name) : undefined;
    const t = templateFor(kind, name, { ...(pagination ? { pagination } : {}), ...(input ? { input } : {}) });

    mkdirSync(assetsDir, { recursive: true });
    try {
      writeFileSync(join(project.root, t.path), t.content, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw fileConflict(name, t.path, again(free()));
      throw e;
    }
    const created = [t.path];
    let csvFiles = 0;
    if (t.folder) {
      const folder = join(project.root, t.folder);
      if (existsSync(folder)) csvFiles = countCsv(folder);
      else {
        mkdirSync(folder, { recursive: true });
        created.push(t.folder);
      }
    }

    const secrets = t.secrets.map((s) => ({ name: s, status: ctx.env.lookup(s) ? "set" as const : "missing" as const }));
    const data: NewAssetData = {
      asset: name, kind, pagination: pagination ?? null, file: t.path, what: t.what, edit: t.edit, reads: t.reads ?? null, secrets, created,
    };
    return { data, problems: [], next: nextSteps(t, name, secrets, csvFiles) };
  },

  human(result, ctx) {
    const d = result.data;
    if ("templates" in d) return formatList(d);
    const lines = [`Created ${d.file} (${d.what}).`];
    if (d.kind === "api" && ctx.values.pagination === undefined) {
      const others = ORS(PAGINATIONS.filter((p) => p !== DEFAULT_PAGINATION));
      lines.push(`Pagination: ${DEFAULT_PAGINATION}, the default; croft new --list says when ${others} fits the API better.`);
    }
    for (const c of d.created.slice(1)) lines.push(`Created ${c} (put the CSV files here).`);
    lines.push(`Edit: ${d.edit}.`);
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------------------------------------
// Arguments

function parseKind(arg: string | undefined, name: string | undefined): NewKind {
  if (arg === undefined) {
    throw new CroftError("USAGE_ERROR", {
      message: "croft new needs a kind and a name",
      hint: "e.g. croft new api stripe_charges; croft new --list shows the kinds and when each applies",
      fix: { kind: "command", description: "see the kinds and when each applies", command: "croft new --list" },
    });
  }
  const lower = arg.toLowerCase();
  if ((NEW_KINDS as readonly string[]).includes(lower)) return lower as NewKind;
  const near = NEAR_KINDS[lower];
  const guess = near ? near.kind : didYouMean(arg, NEW_KINDS) as NewKind | undefined;
  if (name === undefined && !near && !guess) {
    // One argument that is no kind: the name, without its kind.
    throw new CroftError("USAGE_ERROR", {
      message: `croft new needs a kind before the name: ${ORS(NEW_KINDS)}`,
      hint: `e.g. croft new api ${arg} (croft new --list says when each applies)`,
      fix: { kind: "command", description: "see the kinds and when each applies", command: "croft new --list" },
    });
  }
  const n = name ?? "<name>";
  const command = guess && name ? `croft new ${guess} ${name}` : "croft new --list";
  throw new CroftError("USAGE_ERROR", {
    message: `croft new has no kind "${arg}"; the kinds are ${WORDS(NEW_KINDS)}`,
    hint: near ? near.hint(n) : guess ? `did you mean croft new ${guess} ${n}?` : "croft new --list says when each kind applies",
    fix: guess && name
      ? { kind: "command", description: `write a ${guess} template`, command }
      : { kind: "command", description: "see the kinds and when each applies", command },
    details: { kind: arg, ...(guess ? { suggestion: guess } : {}) },
  });
}

function parsePagination(value: unknown, kind: NewKind, name: string): Pagination | undefined {
  if (value === undefined) return kind === "api" ? DEFAULT_PAGINATION : undefined;
  const v = String(value);
  if (kind !== "api") {
    throw new CroftError("USAGE_ERROR", {
      message: `--pagination is for api templates; a ${kind} template has no pages`,
      hint: `leave it out: croft new ${kind} ${name}`,
      fix: { kind: "command", description: `write the ${kind} template`, command: `croft new ${kind} ${name}` },
    });
  }
  const lower = v.toLowerCase();
  if ((PAGINATIONS as readonly string[]).includes(lower)) return lower as Pagination;
  const guess = didYouMean(v, PAGINATIONS) as Pagination | undefined;
  const command = guess ? `croft new api ${name} --pagination ${guess}` : "croft new --list";
  throw new CroftError("USAGE_ERROR", {
    message: `unknown pagination "${v}"; the styles are ${WORDS(PAGINATIONS)}`,
    hint: guess ? `did you mean ${command}?` : "croft new --list says when each style applies",
    fix: guess
      ? { kind: "command", description: `write the ${guess} template`, command }
      : { kind: "command", description: "see the styles and when each applies", command },
    details: { pagination: v, ...(guess ? { suggestion: guess } : {}) },
  });
}

// ---------------------------------------------------------------------------------------------------------
// The project

function fileConflict(name: string, file: string, other: string): CroftError {
  return new CroftError("NAME_CONFLICT", {
    message: `${file} already defines the asset ${name}; croft new never overwrites a file`,
    hint: `edit ${file} instead, or choose another name: ${other}`,
    file,
    fix: { kind: "command", description: "write the template under a name no asset has", command: other },
    effect: "nothing was written",
    details: { name, file },
  });
}

/** runs.sqlite's catalog mirror: the tables croft built. Empty before the first run or when it cannot be read. */
function readCatalog(stateDir: string): CatalogAsset[] {
  if (!existsSync(join(stateDir, RUNS_DB_FILE))) return [];
  let db: RunsDb | undefined;
  try {
    db = RunsDb.open(stateDir);
    return allCatalog(db);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The asset an sql or transform template reads: the one whose file changed most recently (ties by name), since that
 * is the asset the user has just been working on. A transform reads it with newRows(), so only assets with a key
 * count. Resolving imports the TS assets, as croft validate does, for their keys.
 */
async function chooseInput(project: Project, kind: "sql" | "transform", name: string): Promise<TemplateInput> {
  const resolved = await resolveProject({ root: project.root, timezone: project.timezone });
  const all = resolved.assets.filter((a) => a.name !== name).map((a) => ({ a, mtime: mtimeOf(a.path) }))
    .sort((x, y) => y.mtime - x.mtime || (x.a.name < y.a.name ? -1 : x.a.name > y.a.name ? 1 : 0));
  if (all.length === 0) {
    throw new CroftError("USAGE_ERROR", {
      message: kind === "sql"
        ? "an SQL transform reads other assets, and assets/ has none yet"
        : "a TypeScript transform reads another asset, and assets/ has none yet",
      hint: "bring data in first: croft new api <name> for an API, or croft new file <name> for files",
      fix: { kind: "command", description: "see the ingest templates", command: "croft new --list" },
      effect: "nothing was written",
    });
  }
  const usable = kind === "transform" ? all.filter((c) => c.a.key.length > 0) : all;
  if (usable.length === 0) {
    const latest = all[0]!.a;
    throw new CroftError("INPUT_NEEDS_KEY", {
      message: "a TypeScript transform reads its input with newRows(), which needs a key, and no asset of this project has one "
        + `(${all.map((c) => c.a.name).slice(0, 10).join(", ")})`,
      hint: `add a key to the asset it should read (key: "id" in a TS asset, a -- key: id line in an SQL asset), then run croft new transform ${name} again`,
      file: latest.file,
      fix: { kind: "edit", description: `add a key to ${latest.name}: the column that identifies a row`, file: latest.file },
      effect: "nothing was written",
      details: { assets: all.map((c) => c.a.name) },
    });
  }
  const pick = usable[0]!.a;
  const keyed = kind === "transform" && usable.length < all.length;
  const why = usable.length === 1
    ? (keyed ? "the project's only asset with a key" : "the project's only asset")
    : (keyed ? "the asset with a key changed most recently" : "the asset changed most recently");
  return { asset: pick.name, key: [...pick.key], why };
}

function countCsv(folder: string): number {
  try {
    return readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".csv")).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Output

function nextSteps(t: Template, name: string, secrets: NewAssetData["secrets"], csvFiles: number): Next[] {
  const missing = secrets.filter((s) => s.status === "missing").map((s) => s.name);
  if (missing.length) {
    return [{
      command: "croft secrets",
      reason: `ask the user to add ${WORDS(missing.map((m) => `${m}=...`))} to .env (or to run croft secrets set ${missing[0]} in their terminal); `
        + `never read .env yourself. Once croft secrets shows it set and your edits pass croft validate: croft preview ${name}`,
    }];
  }
  switch (t.kind) {
    case "api":
      return [{ command: `croft preview ${name}`, reason: "after your edits pass croft validate: fetches up to 1,000 rows into a sandbox; nothing is saved and the cursor does not move" }];
    case "file":
      return [{
        command: `croft preview ${name}`,
        reason: csvFiles > 0
          ? `after setting key to the column that identifies a row (croft validate checks the edit): loads ${t.folder} into a sandbox; nothing is saved`
          : `after putting CSV files in ${t.folder} and setting key (croft validate checks the edit): loads them into a sandbox; nothing is saved`,
      }];
    case "sql":
      return [{ command: `croft preview ${name}`, reason: `after editing the SELECT (croft validate binds it against the columns of ${t.reads}): builds it in a sandbox and diffs it; nothing real changes` }];
    case "transform":
      return [{ command: `croft preview ${name} --rows 20`, reason: "after your edits pass croft validate: at most 20 input rows reach the code (keep --rows small once it makes paid calls); nothing real changes" }];
  }
}

/** Every template, for --list. */
export function listTemplates(): NewTemplateEntry[] {
  return TEMPLATE_KINDS.map((k) => ({
    kind: k.kind, pagination: k.pagination ?? null, default: k.default === true,
    command: `croft new ${k.kind} <name>${k.pagination ? ` --pagination ${k.pagination}` : ""}`, description: k.description,
  }));
}

/** --list for people: one line per template, its command and when it applies. */
export function formatList(d: NewListData): string {
  const width = Math.max(...d.templates.map((t) => t.command.length));
  return [
    "croft new writes a commented, working template to assets/<name>.ts (.sql for sql); edit it, then croft validate.",
    ...d.templates.map((t) => `  ${t.command.padEnd(width)}   ${t.default ? `(the default for ${t.kind}) ` : ""}${t.description}`),
  ].join("\n");
}
