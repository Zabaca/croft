// Asset discovery and naming rules (DESIGN.md §3 "Layout and naming").
//
// One file in assets/ (any depth) is one asset, and its base name is the table name. Names must match
// [a-z][a-z0-9_]*, be unique across assets/**, and not be reserved:
// - `new` (kept free for post-v1 incremental SQL), `croft`, and anything starting with `_`;
// - DuckDB's reserved keywords, because `FROM order` is a parser error in every asset that reads it.
//
// The keyword list comes from the DuckDB croft ships (duckdb_keywords()), never a copied list, so an
// engine upgrade cannot drift from it. It also adds the `type_function` keywords that DuckDB cannot
// read as a bare table name: `FROM left`, `FROM join` and 28 others are syntax errors too, although
// DuckDB does not class them as reserved [verified on 1.5.5: 30 of 35 fail json_serialize_sql].
import { existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { problem } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import { openMemory } from "../db/connect.ts";

export type AssetFileKind = "ts" | "sql";

export interface DiscoveredAsset {
  name: string;
  /** Relative to the project root with "/" separators, e.g. "assets/github/issues.ts". */
  file: string;
  /** Absolute path. */
  path: string;
  kind: AssetFileKind;
}

export interface Discovery {
  /** Assets with valid, unique names, sorted by name. */
  assets: DiscoveredAsset[];
  /** NAME_INVALID and NAME_RESERVED in file order, then NAME_CONFLICT. */
  problems: Problem[];
}

export const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Names croft keeps for itself. */
export const RESERVED_NAMES: Readonly<Record<string, string>> = Object.freeze({
  new: "new is reserved for incremental SQL, which reads new.<table>",
  croft: "croft is reserved for croft itself",
});

let keywordsPromise: Promise<ReadonlySet<string>> | null = null;

/** SQL keywords that cannot be a bare table name in this DuckDB. Cached for the process. */
export function sqlKeywordNames(): Promise<ReadonlySet<string>> {
  keywordsPromise ??= loadKeywords().catch((e) => {
    keywordsPromise = null;          // a failed load (e.g. a broken binding) is not cached
    throw e;
  });
  return keywordsPromise;
}

async function loadKeywords(): Promise<ReadonlySet<string>> {
  const db = await openMemory({ timezone: "UTC" });
  try {
    const conn = await db.connect();
    const reader = await conn.runAndReadAll(`
      SELECT keyword_name
      FROM duckdb_keywords()
      WHERE keyword_category = 'reserved'
         OR (keyword_category = 'type_function'
             AND (json_serialize_sql('SELECT * FROM ' || keyword_name)::JSON ->> 'error')::BOOLEAN)
      ORDER BY 1`);
    return new Set(reader.getRowsJS().map((r) => String(r[0]).toLowerCase()));
  } finally {
    db.close();
  }
}

/** The problem with an asset name, or null when it is usable as a table name. */
export function nameProblem(name: string, file: string, keywords: ReadonlySet<string>): Problem | null {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const ext = file.slice(file.lastIndexOf("."));
  const renameTo = (to: string) => ({
    kind: "manual" as const,
    description: `rename ${file} to ${dir}${to}${ext} (and update assets that read ${name})`,
  });

  if (name.startsWith("_")) {
    const to = suggestName(name.replace(/^_+/, ""), keywords);
    return problem("NAME_RESERVED", {
      message: `asset names cannot start with "_"; croft keeps those for its own tables`,
      hint: `rename the file to ${to}${ext}`,
      file, fix: renameTo(to), details: { name, suggestion: to, reason: "underscore" },
    });
  }
  if (!NAME_PATTERN.test(name)) {
    const to = suggestName(name, keywords);
    const dotted = name.includes(".");
    return problem("NAME_INVALID", {
      message: `"${name}" is not a valid asset name; the file name becomes the table name, so it must be `
        + "lowercase letters, digits and _, starting with a letter",
      hint: dotted
        ? `every file in assets/ becomes a table; put tests and shared code in lib/, or rename the file to ${to}${ext}`
        : `rename the file to ${to}${ext}`,
      file, fix: renameTo(to), details: { name, suggestion: to },
    });
  }
  if (Object.hasOwn(RESERVED_NAMES, name)) {
    const to = `${name}_data`;
    return problem("NAME_RESERVED", {
      message: `${RESERVED_NAMES[name]}; choose another name`,
      hint: `rename the file to ${to}${ext}`,
      file, fix: renameTo(to), details: { name, suggestion: to, reason: "reserved" },
    });
  }
  if (keywords.has(name)) {
    const to = suggestName(name, keywords);
    return problem("NAME_RESERVED", {
      message: `"${name}" is an SQL keyword, so \`FROM ${name}\` would be a syntax error in every asset that reads it; rename to ${to}`,
      hint: `rename the file to ${to}${ext}`,
      file, fix: renameTo(to), details: { name, suggestion: to, reason: "keyword" },
    });
  }
  return null;
}

/** A valid, unreserved name close to `raw`: "GitHub-Issues" → "git_hub_issues", "order" → "orders". */
export function suggestName(raw: string, keywords: ReadonlySet<string> = new Set()): string {
  let s = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")      // camelCase → camel_case
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) s = "asset";
  if (/^[0-9]/.test(s)) s = `t_${s}`;
  if (keywords.has(s)) s = plural(s);
  if (Object.hasOwn(RESERVED_NAMES, s) || keywords.has(s)) s = `${s}_data`;
  return s;
}

/** A plain English plural, for "rename order to orders". */
export function plural(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Scan <root>/assets/** for .ts and .sql files and apply the naming rules. A missing assets/ folder is
 *  an empty project, not an error. Dotfiles and .d.ts declaration files are skipped. */
export async function discoverAssets(root: string, opts: { assetsDir?: string; keywords?: ReadonlySet<string> } = {}): Promise<Discovery> {
  const assetsDir = opts.assetsDir ?? join(root, "assets");
  if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) return { assets: [], problems: [] };
  const keywords = opts.keywords ?? await sqlKeywordNames();

  const files = [...new Bun.Glob("**/*.{ts,sql}").scanSync({ cwd: assetsDir, onlyFiles: true })]
    .filter((f) => !f.endsWith(".d.ts"))
    .sort();

  const problems: Problem[] = [];
  const byName = new Map<string, DiscoveredAsset[]>();
  for (const rel of files) {
    const path = join(assetsDir, rel);
    const file = relative(root, path).split(sep).join("/");
    const base = rel.split("/").pop()!;
    const kind: AssetFileKind = base.endsWith(".sql") ? "sql" : "ts";
    const name = base.slice(0, base.length - (kind === "sql" ? 4 : 3));
    const bad = nameProblem(name, file, keywords);
    if (bad) {
      problems.push(bad);
      continue;
    }
    const list = byName.get(name) ?? [];
    list.push({ name, file, path, kind });
    byName.set(name, list);
  }

  const assets: DiscoveredAsset[] = [];
  for (const [name, list] of byName) {
    if (list.length === 1) {
      assets.push(list[0]!);
      continue;
    }
    // Neither file wins: picking one would silently build the table from code the user may not mean.
    const kinds = new Set(list.map((a) => a.kind));
    const files = list.map((a) => a.file);
    problems.push(problem("NAME_CONFLICT", {
      message: kinds.size > 1
        ? `${files.join(" and ")} both define the asset ${name}; a .ts and a .sql file cannot share a name`
        : `${files.join(" and ")} both define the asset ${name}; asset names must be unique across assets/, whatever the folder`,
      hint: `keep one of them, or rename the other (for example to ${name}_2)`,
      file: files[0]!,
      fix: { kind: "manual", description: `keep one of ${files.join(", ")} and rename or remove the others` },
      details: { name, files },
    }));
  }
  assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { assets, problems };
}
