// The one edit `croft init` proposes to an app's own files (DESIGN.md §2, D42, D100): in the root tsconfig.json,
// exclude data/assets and data/lib, so the app's type-check (next build, tsc) does not compile code that needs
// Bun's types, and include data/.croft/types, so query<"table">() from @zabaca/croft/read is typed. tsconfig.json is JSONC (comments, trailing commas), and it is the user's file, so the edit
// is a minimal text insertion that keeps every other byte, never a parse-and-reserialize.

export type Node =
  | { type: "object"; start: number; end: number; props: { key: string; value: Node }[] }
  | { type: "array"; start: number; end: number; items: Node[]; trailingComma: number | null }
  | { type: "value"; start: number; end: number; value: unknown };

class JsoncError extends Error {}

/** Parse JSONC into a tree that keeps the source span of every node. Throws on malformed input. */
export function parseJsonc(text: string): Node {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text.startsWith("//", i)) {
        const nl = text.indexOf("\n", i);
        i = nl === -1 ? text.length : nl + 1;
      } else if (text.startsWith("/*", i)) {
        const close = text.indexOf("*/", i + 2);
        if (close === -1) throw new JsoncError("unclosed /* comment");
        i = close + 2;
      } else return;
    }
  };
  const string = (): string => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) throw new JsoncError("unclosed string");
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): Node => {
    skip();
    const start = i;
    const ch = text[i];
    if (ch === "{") {
      i++;
      const props: { key: string; value: Node }[] = [];
      for (;;) {
        skip();
        if (text[i] === "}") { i++; return { type: "object", start, end: i, props }; }
        if (text[i] !== '"') throw new JsoncError(`expected a key at offset ${i}`);
        const key = string();
        skip();
        if (text[i++] !== ":") throw new JsoncError(`expected ":" after "${key}"`);
        props.push({ key, value: value() });
        skip();
        if (text[i] === ",") i++;
        else if (text[i] !== "}") throw new JsoncError(`expected "," or "}" at offset ${i}`);
      }
    }
    if (ch === "[") {
      i++;
      const items: Node[] = [];
      let trailingComma: number | null = null;
      for (;;) {
        skip();
        if (text[i] === "]") { i++; return { type: "array", start, end: i, items, trailingComma }; }
        items.push(value());
        trailingComma = null;
        skip();
        if (text[i] === ",") trailingComma = i++;
        else if (text[i] !== "]") throw new JsoncError(`expected "," or "]" at offset ${i}`);
      }
    }
    if (ch === '"') {
      const s = string();
      return { type: "value", start, end: i, value: s };
    }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!m) throw new JsoncError(`unexpected ${ch === undefined ? "end of file" : `"${ch}"`} at offset ${i}`);
    i += m[0].length;
    return { type: "value", start, end: i, value: JSON.parse(m[0]) };
  };
  const root = value();
  skip();
  if (i < text.length) throw new JsoncError(`unexpected text after the closing brace at offset ${i}`);
  return root;
}

/** The plain value of a parsed node (for checking an edit). */
export function toValue(n: Node): unknown {
  if (n.type === "value") return n.value;
  if (n.type === "array") return n.items.map(toValue);
  return Object.fromEntries(n.props.map((p) => [p.key, toValue(p.value)]));
}

export interface ExcludePlan {
  status: "needed" | "not_needed" | "manual";
  reason: string;
  after?: string;                    // the edited text, when status is "needed"
  diff?: string;
}

const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");

/** Whether an include pattern can reach files under <dir>/. TypeScript treats a pattern without a
 *  wildcard in its last segment as a directory, and "*" never crosses a "/". */
function reaches(pattern: string, dir: string): boolean {
  const p = norm(pattern);
  if (p === "" || p === "." || p.startsWith("**")) return true;
  const first = p.split("/")[0]!;
  if (first === dir) return true;
  // "d*/**/*.ts" reaches data/; "*.ts" does not (it names files in the root folder only).
  return first.includes("*") && p.includes("/") && new Bun.Glob(first).match(dir);
}

function excludes(pattern: string, dir: string): boolean {
  const p = norm(pattern);
  return p === dir || p === `${dir}/**` || p === `${dir}/**/*`;
}

/** The folders of a croft project whose code needs Bun's types: an app's type-check must skip them. Everything
 *  else a project holds is no TypeScript, or sits where TypeScript's wildcards never look (node_modules, .croft). */
export const BUN_ONLY = ["assets", "lib"] as const;
/** The generated row types (types-gen.ts): an app that includes them gets query<"table">() typed. Wildcards never
 *  enter a dot folder, so the pattern names .croft; a pattern that matches nothing yet (no run so far) is no error. */
export const typesPattern = (dir: string) => `${dir}/.croft/types/**/*.d.ts`;

const strings = (n: Node | undefined) =>
  n?.type === "array" ? n.items.flatMap((i) => (i.type === "value" && typeof i.value === "string" ? [i.value] : [])) : [];

/**
 * Plan the edit to an app's root tsconfig.json for a croft project in <dir>/ (D42, D100): exclude the project's
 * Bun-only folders (dir/assets, dir/lib) and include its generated row types (dir/.croft/types), so the app's
 * type-check (next build, tsc) skips the pipelines and sees each table's rows. Excluding all of dir/ would also
 * drop the types: "exclude" filters what "include" matches, whatever the include pattern says [V: tsc 5.9].
 */
export function planExclude(text: string, file = "tsconfig.json", dir = "data"): ExcludePlan {
  let root: Node;
  try {
    root = parseJsonc(text);
  } catch (e) {
    return { status: "manual", reason: `${file} could not be read (${(e as Error).message}); ${byHand(dir)}` };
  }
  if (root.type !== "object") return { status: "manual", reason: `${file} is not a JSON object; ${byHand(dir)}` };
  const prop = (r: Extract<Node, { type: "object" }>, key: string) => r.props.find((p) => p.key === key)?.value;
  const include = prop(root, "include");
  const exclude = prop(root, "exclude");
  const types = typesPattern(dir);

  if (exclude && exclude.type !== "array") return { status: "manual", reason: `"exclude" in ${file} is not a list; ${byHand(dir)}` };
  if (include && include.type !== "array") return { status: "manual", reason: `"include" in ${file} is not a list; ${byHand(dir)}` };
  if (strings(exclude).some((p) => excludes(p, dir))) {
    // The pipelines are skipped already; only the row types are missing, and the fix rewrites the user's own entry.
    return { status: "manual", reason: `${file} excludes all of ${dir}/, its row types included; to type query<"table">(), replace "${dir}" in its "exclude" with ${BUN_ONLY.map((f) => `"${dir}/${f}"`).join(" and ")}, and add "${types}" to its "include"` };
  }

  let after = text;
  const why: string[] = [];
  const reparse = () => parseJsonc(after) as Extract<Node, { type: "object" }>;
  // 1. Skip the Bun-only folders, when the app's type-check reaches dir/ at all.
  const reach = include ? strings(include).some((p) => reaches(p, dir)) : !(prop(root, "files") && !prop(root, "extends"));
  if (reach) {
    const missing = BUN_ONLY.map((f) => `${dir}/${f}`).filter((d) => !strings(exclude).some((p) => excludes(p, d)));
    if (missing.length) why.push(`would type-check ${dir}/'s pipelines, which need Bun's types`);
    for (const d of missing) {
      const r = reparse();
      const ex = prop(r, "exclude");
      // A new "exclude" replaces TypeScript's default one, so node_modules must be listed again.
      after = ex?.type === "array" ? insertIntoArray(after, ex, JSON.stringify(d)) : insertProperty(after, r, `"exclude": ["node_modules", ${JSON.stringify(d)}]`);
    }
  }
  // 2. Include the row types. With no "include", TypeScript's default is every file ("**/*"), which a new
  //    "include" would replace, so it is written out; under "extends" the base may set its own, so that is the user's.
  let typesNote = "";
  if (!strings(include).includes(types)) {
    const r = reparse();
    const inc = prop(r, "include");
    if (!prop(r, "extends") || inc) why.push(`would not see ${dir}/'s table types, which type query<"table">()`);
    if (inc?.type === "array") after = insertIntoArray(after, inc, JSON.stringify(types));
    else if (prop(r, "extends")) typesNote = `; to type query<"table">(), add "${types}" to its "include" by hand (it extends another config)`;
    else after = insertProperty(after, r, prop(r, "files") ? `"include": [${JSON.stringify(types)}]` : `"include": ["**/*", ${JSON.stringify(types)}]`);
  }
  if (after === text) return { status: "not_needed", reason: `${file} already skips ${dir}/'s pipelines and includes its row types${typesNote}` };

  // Belt and braces: the edit must parse and must hold what it set out to add.
  let check: { exclude?: unknown; include?: unknown } = {};
  try { check = toValue(parseJsonc(after)) as typeof check; } catch { /* reported below */ }
  const has = (k: "exclude" | "include", v: string) => Array.isArray(check[k]) && (check[k] as unknown[]).includes(v);
  const ok = (!reach || BUN_ONLY.every((f) => has("exclude", `${dir}/${f}`) || strings(exclude).some((p) => excludes(p, `${dir}/${f}`))))
    && (typesNote !== "" || has("include", types));
  if (!ok) return { status: "manual", reason: byHand(dir) };
  return {
    status: "needed",
    reason: `${file} ${why.join(", and ")}${typesNote}`,
    after, diff: lineDiff(file, text, after),
  };
}

const byHand = (dir: string) =>
  `by hand, add ${BUN_ONLY.map((f) => `"${dir}/${f}"`).join(" and ")} to its "exclude" and "${typesPattern(dir)}" to its "include"`;

function lineStartIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

function insertIntoArray(text: string, arr: Extract<Node, { type: "array" }>, item: string): string {
  const multiline = text.slice(arr.start, arr.end).includes("\n");
  const last = arr.items.at(-1);
  if (!last) {
    // "[]" or "[ ]": put the item inside, keeping any comments.
    return `${text.slice(0, arr.start + 1)}${item}${text.slice(arr.start + 1)}`;
  }
  const indent = multiline ? lineStartIndent(text, last.start) : "";
  if (arr.trailingComma !== null) {
    const at = arr.trailingComma + 1;
    return multiline ? `${text.slice(0, at)}\n${indent}${item},${text.slice(at)}` : `${text.slice(0, at)} ${item},${text.slice(at)}`;
  }
  const at = last.end;
  return multiline ? `${text.slice(0, at)},\n${indent}${item}${text.slice(at)}` : `${text.slice(0, at)}, ${item}${text.slice(at)}`;
}

function insertProperty(text: string, obj: Extract<Node, { type: "object" }>, prop: string): string {
  const last = obj.props.at(-1);
  if (!last) return `${text.slice(0, obj.start + 1)}\n  ${prop}\n${text.slice(obj.start + 1)}`;
  const multiline = text.slice(obj.start, obj.end).includes("\n");
  // The key of the last property starts at the first quote before its value on that line.
  const keyAt = text.lastIndexOf(`"${last.key}"`, last.value.start);
  const indent = multiline ? lineStartIndent(text, keyAt) : "";
  // A trailing comma after the last property stays where it is.
  let after = last.value.end;
  const rest = text.slice(after);
  const comma = /^(\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*),/.exec(rest);
  if (comma) {
    after += comma[0].length;
    return multiline ? `${text.slice(0, after)}\n${indent}${prop},${text.slice(after)}` : `${text.slice(0, after)} ${prop},${text.slice(after)}`;
  }
  return multiline ? `${text.slice(0, after)},\n${indent}${prop}${text.slice(after)}` : `${text.slice(0, after)}, ${prop}${text.slice(after)}`;
}

/** A minimal unified diff of one changed region: enough to show the user what init would change. */
export function lineDiff(file: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return [
    `--- ${file}`,
    `+++ ${file}`,
    `@@ line ${p + 1} @@`,
    ...a.slice(p, a.length - s).map((l) => `-${l}`),
    ...b.slice(p, b.length - s).map((l) => `+${l}`),
  ].join("\n");
}
