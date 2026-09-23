// TypeScript assets: import scan, isolated import, config validation and the code fingerprint.
// Source of truth: DESIGN.md §3 (a, b, e), §5 ("Processes", "Owning the DuckDB file"), §8 ("What a code
// change does") and the public types in §10.
//
// Loading one asset, in order:
//   1. Import scan (Bun.Transpiler over the asset and every project file it imports, lib/ included).
//      Importing @duckdb/node-api or @zabaca/croft/read is ASSET_OPENS_DATABASE, and such an asset is
//      never imported: a second DuckDB instance on the warehouse in croft's own process would release
//      croft's file lock the moment it closed (§5).
//   2. Bun.build of the asset with packages external. Its output is the code fingerprint (with the
//      imported package versions and the project time zone) and the input to the ctx.http detector.
//      Identifier minification stays off: with it on, a comment-only edit changed the hash [V].
//   3. import() in isolation: a file that throws or does not parse fails only its own asset.
//   4. Hand-written validation of the default export against the public types, so every message names
//      the key, what was expected and what was found.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { CroftError, problem, type Code, type ProblemInit } from "../core/errors.ts";
import { guardImport } from "../core/output.ts";
import type { CursorType, Incremental, Problem, WriteMode } from "../core/types.ts";
import type { AssetDefinition } from "../types.ts";
import { NAME_PATTERN, type DiscoveredAsset } from "./discover.ts";
import { ProjectEnv } from "./env.ts";
import { didYouMean } from "./suggest.ts";

export interface TsProject {
  root: string;
  timezone: string;
}

/** The config, normalized for the planner. Present only when the asset has no errors. */
export interface TsAssetSpec {
  role: "ingest" | "transform";
  source: "rows" | "file" | "transform";
  key: string[];
  /** As declared; the planner infers the rest. */
  write?: WriteMode;
  incremental: Incremental;
  schedule?: string;
  secrets: string[];
  inputs: string[];
  checks: string[];
  warnings: string[];
  pins: Record<string, { type: string; format?: string }>;
  allowShrink: boolean;
  retries?: number;
  timeoutMs?: number;
  confirmAbove?: number;
}

export interface LoadedTsAsset {
  name: string;
  file: string;
  path: string;
  /** No error-severity problems. */
  ok: boolean;
  definition?: AssetDefinition;
  spec?: TsAssetSpec;
  /** Present when the asset bundles; covers lib/ code, package versions and the time zone. */
  codeHash?: string;
  /** Calls ctx.http, fetch or an HTTP client package (TRANSFORM_MAKES_REQUESTS, the cost guard). */
  usesHttp: boolean;
  /** Project files the asset imports, root-relative, the asset first. */
  localFiles: string[];
  /** Packages in the bundle and their installed versions (null when not found). */
  packages: Record<string, string | null>;
  problems: Problem[];
}

export interface LoadOptions {
  /** The saved cursor type from _croft state, when the asset has loaded before (CURSOR_TYPE_MISMATCH). */
  cursorType?: CursorType;
  /** An asset whose top-level code has not finished after this long fails (default 30 s). */
  importTimeoutMs?: number;
}

const IMPORT_TIMEOUT_MS = 30_000;

/** Load every TS asset of a discovery, one at a time. One broken file fails only its own asset. */
export async function loadTsAssets(assets: readonly DiscoveredAsset[], project: TsProject,
  o: { cursorTypes?: Record<string, CursorType>; importTimeoutMs?: number } = {}): Promise<LoadedTsAsset[]> {
  const out: LoadedTsAsset[] = [];
  for (const a of assets) {
    if (a.kind !== "ts") continue;
    const cursorType = o.cursorTypes?.[a.name];
    out.push(await loadTsAsset(a, project, {
      ...(cursorType ? { cursorType } : {}),
      ...(o.importTimeoutMs !== undefined ? { importTimeoutMs: o.importTimeoutMs } : {}),
    }));
  }
  return out;
}

export async function loadTsAsset(asset: Pick<DiscoveredAsset, "name" | "file" | "path">, project: TsProject,
  o: LoadOptions = {}): Promise<LoadedTsAsset> {
  const { name, file, path } = asset;
  const root = project.root;
  const out: LoadedTsAsset = { name, file, path, ok: false, usesHttp: false, localFiles: [file], packages: {}, problems: [] };
  const finish = () => {
    out.ok = !out.problems.some((p) => p.severity === "error");
    return out;
  };

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (e) {
    out.problems.push(problem("ASSET_INVALID", {
      message: `cannot read ${file}: ${(e as Error).message}`, hint: "check that the file exists and is readable",
      asset: name, file,
    }));
    return finish();
  }

  // 1. Import scan, before anything runs the code.
  const graph = scanImportGraph(path, root);
  out.localFiles = graph.files.map((f) => rel(root, f));
  for (const ref of graph.opensDatabase) out.problems.push(opensDatabaseProblem(ref, name, root));

  // 2. Bundle: syntax errors with positions, the fingerprint, and request detection.
  const bundle = await bundleTs(path);
  if (!bundle.ok) {
    out.problems.push(buildProblem(bundle.errors, name, file, root));
    return finish();
  }
  out.packages = packageVersions(bundle.imports, path);
  out.codeHash = fingerprintOf(normalizeBundle(bundle.code, path), out.packages, project.timezone);
  const requests = detectRequests(bundle.code, bundle.imports);
  out.usesHttp = requests.length > 0;

  if (graph.opensDatabase.length > 0) return finish();

  // 3. Import in isolation. Top-level console output never reaches stdout (core/output.ts): a run keeps it for
  //    the step log; other commands print it on stderr, redacted.
  let mod: Record<string, unknown>;
  try {
    mod = await guardImport(file, () => (t) => ProjectEnv.load(root, {}).redact(t), () => importIsolated(path, o.importTimeoutMs ?? IMPORT_TIMEOUT_MS));
  } catch (e) {
    out.problems.push(importProblem(e, name, file, root, o.importTimeoutMs ?? IMPORT_TIMEOUT_MS));
    return finish();
  }

  // 4. Validate.
  const v = validateDefinition(mod.default, {
    name, file, source, hasDefault: "default" in mod, usesHttp: out.usesHttp, requests,
    ...(o.cursorType ? { cursorType: o.cursorType } : {}),
  });
  out.problems.push(...v.problems);
  finish();
  if (out.ok && v.definition && v.spec) {
    out.definition = v.definition;
    out.spec = v.spec;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// 1. Import scan

export interface ImportRef {
  specifier: string;
  /** Absolute path of the importing file. */
  from: string;
  line?: number;
}

export interface ImportGraph {
  /** Project files reached from the entry (absolute), the entry first. */
  files: string[];
  /** Bare package imports anywhere in the graph. */
  packages: ImportRef[];
  /** Imports that would open a DuckDB database. */
  opensDatabase: ImportRef[];
  /** Files the transpiler could not scan (Bun.build reports these with positions). */
  unscanned: { file: string; message: string }[];
}

// Packages that open DuckDB files. @zabaca/croft/read opens the warehouse when no croft serve runs.
const DATABASE_PACKAGES = ["@duckdb/node-api", "@duckdb/node-bindings", "duckdb", "duckdb-async"];

export function opensDatabase(specifier: string): boolean {
  if (specifier === "@zabaca/croft/read" || specifier.startsWith("@zabaca/croft/read/")) return true;
  const pkg = packageName(specifier);
  return DATABASE_PACKAGES.includes(pkg) || pkg.startsWith("@duckdb/node-bindings-");
}

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
};

/** Follow the asset's imports through project files (lib/ and anything else outside node_modules).
 *  Type-only imports are skipped by the transpiler; dynamic import() and require() of string
 *  literals are included [verified]. */
export function scanImportGraph(entry: string, root: string): ImportGraph {
  const roots = projectRoots(root);
  const graph: ImportGraph = { files: [], packages: [], opensDatabase: [], unscanned: [] };
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    graph.files.push(file);
    const loader = LOADERS[extname(file)];
    if (!loader) continue;                            // JSON, TOML, text: nothing to follow
    let text: string;
    let imports: { path: string }[];
    try {
      text = readFileSync(file, "utf8");
      imports = new Bun.Transpiler({ loader }).scanImports(text);
    } catch (e) {
      graph.unscanned.push({ file, message: (e as Error).message });
      continue;
    }
    for (const { path: specifier } of imports) {
      if (isBuiltin(specifier)) continue;
      const ref: ImportRef = { specifier, from: file };
      const line = lineOfSpecifier(text, specifier);
      if (line !== undefined) ref.line = line;
      if (opensDatabase(specifier)) graph.opensDatabase.push(ref);
      const local = resolveLocal(specifier, file, roots);
      if (local) queue.push(local);
      else if (!isRelative(specifier)) graph.packages.push(ref);
    }
  }
  return graph;
}

function projectRoots(root: string): string[] {
  const out = [root];
  try {
    const real = realpathSync(root);
    if (real !== root) out.push(real);
  } catch { /* a missing root has no files to follow */ }
  return out;
}

function resolveLocal(specifier: string, from: string, roots: string[]): string | null {
  let resolved: string;
  try {
    resolved = Bun.resolveSync(specifier, dirname(from));
  } catch {
    return null;                                      // Bun.build reports unresolvable relative imports
  }
  if (!isAbsolute(resolved)) return null;
  if (resolved.split(sep).includes("node_modules")) return null;
  return roots.some((r) => resolved.startsWith(r + sep)) ? resolved : null;
}

const BUILTINS = new Set(builtinModules);

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || specifier.startsWith("bun:") || specifier === "bun" || BUILTINS.has(specifier);
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || specifier === "." || specifier === "..";
}

/** "@scope/pkg/sub/path" → "@scope/pkg"; "pkg/sub" → "pkg". */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function lineOfSpecifier(text: string, specifier: string): number | undefined {
  const re = new RegExp(`["'\`]${escapeRegExp(specifier)}["'\`]`);
  const lines = text.split("\n");
  const i = lines.findIndex((l) => re.test(l));
  return i >= 0 ? i + 1 : undefined;
}

function opensDatabaseProblem(ref: ImportRef, asset: string, root: string): Problem {
  const file = rel(root, ref.from);
  const what = ref.specifier.startsWith("@zabaca/croft/read") ? "@zabaca/croft/read" : packageName(ref.specifier);
  return problem("ASSET_OPENS_DATABASE", {
    message: `${file} imports ${ref.specifier}; asset code must never open the database itself (croft holds it, and a second connection from the same process can break croft's lock)`,
    hint: "remove the import and use ctx.query(sql) for read-only lookups",
    asset, file, ...(ref.line !== undefined ? { line: ref.line } : {}),
    fix: { kind: "edit", description: `remove the ${what} import and use ctx.query(sql) instead`, file, ...(ref.line !== undefined ? { line: ref.line } : {}) },
    details: { specifier: ref.specifier, importedBy: file },
  });
}

// ---------------------------------------------------------------------------------------------------
// 2. Bundle and fingerprint

export interface BuildError { message: string; file?: string; line?: number; column?: number; lineText?: string }
export type BundleResult = { ok: true; code: string; imports: string[] } | { ok: false; errors: BuildError[] };

// The one Bun.build configuration for fingerprints. identifiers: false is load-bearing (see the header).
const BUILD = {
  packages: "external",
  target: "bun",
  format: "esm",
  minify: { whitespace: true, syntax: true, identifiers: false },
  throw: false,
} as const;

/** Bundle one asset with its project imports. Packages stay external, so only project code is hashed. */
export async function bundleTs(entry: string): Promise<BundleResult> {
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({ entrypoints: [entry], ...BUILD });
  } catch (e) {
    // With throwing on, Bun.build rejects with an AggregateError of BuildMessages [verified]; keep the
    // same result shape should it ever do so with throw: false.
    const errors = e instanceof AggregateError ? e.errors : [e];
    return { ok: false, errors: errors.map(buildError) };
  }
  if (!result.success || result.outputs.length === 0) {
    const errors = result.logs.filter((l) => l.level === "error");
    return { ok: false, errors: (errors.length > 0 ? errors : result.logs).map(buildError) };
  }
  const code = await result.outputs[0]!.text();
  const imports = new Bun.Transpiler({ loader: "js" }).scanImports(code).map((i) => i.path);
  return { ok: true, code, imports };
}

function buildError(e: unknown): BuildError {
  const m = e as { message?: string; position?: { file?: string; line?: number; column?: number; lineText?: string } | null };
  const out: BuildError = { message: String(m?.message ?? e) };
  const p = m?.position;
  if (p?.file) out.file = p.file;
  if (p?.line) out.line = p.line;
  if (p?.column !== undefined && p.line) out.column = p.column;
  if (p?.lineText) out.lineText = p.lineText;
  return out;
}

/** Bun names a default export after its file (`issue_triage_default`). A renamed file must keep its
 *  hash, because a rename outside croft is detected by matching the orphan's hash (ASSET_RENAMED). */
export function normalizeBundle(code: string, entry: string): string {
  const base = entry.slice(entry.lastIndexOf(sep) + 1).replace(/\.[^.]+$/, "");
  const ident = base.replace(/[^A-Za-z0-9_$]/g, "_");
  return code.replace(new RegExp(`(?<![\\w$])${escapeRegExp(ident)}_default(?![\\w$])`, "g"), "__croft_asset_default");
}

// @zabaca/croft is the runtime, not the asset's code: counting its version would mark every TS asset
// "edited" (and hold it from the scheduler) after a croft upgrade.
const FINGERPRINT_IGNORED_PACKAGES = new Set(["@zabaca/croft"]);

/** Installed versions of the packages a bundle imports, found by walking up node_modules folders. */
export function packageVersions(imports: readonly string[], from: string): Record<string, string | null> {
  const names = [...new Set(imports.filter((s) => !isBuiltin(s) && !isRelative(s)).map(packageName))]
    .filter((n) => !FINGERPRINT_IGNORED_PACKAGES.has(n))
    .sort();
  const out: Record<string, string | null> = {};
  for (const name of names) out[name] = installedVersion(name, dirname(from));
  return out;
}

function installedVersion(name: string, dir: string): string | null {
  for (let cur = dir; ; cur = dirname(cur)) {
    const pkg = join(cur, "node_modules", name, "package.json");
    if (existsSync(pkg)) {
      try {
        const v = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown }).version;
        return typeof v === "string" ? v : null;
      } catch {
        return null;
      }
    }
    if (dirname(cur) === cur) return null;
  }
}

/** sha256 over the normalized bundle, the package versions and the project time zone. */
export function fingerprintOf(code: string, packages: Record<string, string | null>, timezone: string): string {
  const material = JSON.stringify({ v: 1, timezone, packages: Object.entries(packages).sort(), code });
  return new Bun.CryptoHasher("sha256").update(material).digest("hex");
}

/** The code fingerprint of one TS asset. Throws ASSET_INVALID when the asset does not bundle. */
export async function tsFingerprint(entry: string, project: TsProject): Promise<string> {
  const bundle = await bundleTs(entry);
  if (!bundle.ok) {
    const name = entry.slice(entry.lastIndexOf(sep) + 1).replace(/\.[^.]+$/, "");
    const { severity: _s, code: _c, docs: _d, ...init } = buildProblem(bundle.errors, name, rel(project.root, entry), project.root);
    throw new CroftError("ASSET_INVALID", init);
  }
  return fingerprintOf(normalizeBundle(bundle.code, entry), packageVersions(bundle.imports, entry), project.timezone);
}

function buildProblem(errors: BuildError[], asset: string, file: string, root: string): Problem {
  const first = errors[0] ?? { message: "Bun.build failed without a message" };
  const where = first.file ? rel(root, first.file) : file;
  const at = first.line ? `${where}:${first.line}${first.column !== undefined ? `:${first.column}` : ""}` : where;
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : "";
  return problem("ASSET_INVALID", {
    message: `${file} does not compile: ${first.message} at ${at}${more}${first.lineText ? `\n  ${first.lineText.trim()}` : ""}`,
    hint: `fix the code at ${at}`,
    asset, file: where, ...(first.line ? { line: first.line } : {}), ...(first.column !== undefined ? { column: first.column } : {}),
    fix: { kind: "edit", description: `fix: ${first.message}`, file: where, ...(first.line ? { line: first.line } : {}) },
    details: { errors: errors.map((e) => ({ ...e, ...(e.file ? { file: rel(root, e.file) } : {}) })) },
  });
}

// ---------------------------------------------------------------------------------------------------
// ctx.http detection (TRANSFORM_MAKES_REQUESTS and the cost guard)

// HTTP clients and paid-API SDKs: a call through one of these costs the same as a ctx.http call.
const REQUEST_PACKAGES = new Set([
  "http", "https", "http2", "undici", "axios", "node-fetch", "got", "ky", "superagent",
  "openai", "@anthropic-ai/sdk", "@google/genai", "@google/generative-ai", "@mistralai/mistralai", "cohere-ai", "groq-sdk", "ollama",
]);

/** How a bundle makes requests: "ctx.http", "fetch" or "package <name>". Empty when it makes none.
 *  Runs on the bundle, so helpers in lib/ count, and code tree-shaken away does not. String, template
 *  and regex literals and comments are blanked first, so a URL like "http://..." is not a match. */
export function detectRequests(code: string, imports: readonly string[] = []): string[] {
  const bare = stripLiterals(code);
  const out: string[] = [];
  // Any `http` identifier: ctx.http, a destructured { http }, or http passed on to a lib/ helper.
  if (/(?<![\w$])http(?![\w$])/.test(bare)) out.push("ctx.http");
  if (/(?<![\w$.])fetch\s*\(|globalThis\s*\.\s*fetch(?![\w$])/.test(bare)) out.push("fetch");
  for (const s of new Set(imports.map((i) => (i.startsWith("node:") ? i.slice(5) : i)).map(packageName))) {
    if (REQUEST_PACKAGES.has(s)) out.push(`package ${s}`);
  }
  return out;
}

const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/** Blank out comments and the contents of string, template and regex literals, keeping template
 *  `${...}` expressions as code. A lexer, not a parser: good enough to lint Bun's own output. */
export function stripLiterals(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  let depth = 0;                                      // { nesting, `${` included
  const templates: number[] = [];                     // depth at which each open `${` resumes its template
  let last = "";                                      // last significant token (punctuator or word)

  const template = () => {                            // i is just past "`" or the "}" closing a `${`
    while (i < n) {
      const c = code[i]!;
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; out += "`"; last = "`"; return; }
      if (c === "$" && code[i + 1] === "{") {
        i += 2;
        out += "${";
        templates.push(depth);
        depth++;
        last = "{";
        return;
      }
      i++;
    }
  };

  while (i < n) {
    const c = code[i]!;
    const d = code[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && code[i] !== c && code[i] !== "\n") i += code[i] === "\\" ? 2 : 1;
      i++;
      out += `${c}${c}`;
      last = c;
      continue;
    }
    if (c === "`") {
      i++;
      out += "`";
      template();
      continue;
    }
    if (c === "/" && regexAllowed(last)) {
      i++;
      let inClass = false;
      while (i < n && code[i] !== "\n") {
        const ch = code[i]!;
        if (ch === "\\") { i += 2; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(code[i]!)) i++;
      out += "/./";
      last = "/./";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        out += "}";
        i++;
        template();
        continue;
      }
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(code[j]!)) j++;
      last = code.slice(i, j);
      out += last;
      i = j;
      continue;
    }
    if (!/\s/.test(c)) last = c;
    out += c;
    i++;
  }
  return out;
}

function regexAllowed(last: string): boolean {
  if (last === "") return true;
  if (/^[\w$]+$/.test(last)) return REGEX_AFTER_WORD.has(last);
  return "(,=:[!&|?{};+-*%<>~^".includes(last);
}

// ---------------------------------------------------------------------------------------------------
// 3. Isolated import

class ImportTimeout extends Error {}

async function importIsolated(path: string, timeoutMs: number): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ImportTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([import(pathToFileURL(path).href) as Promise<Record<string, unknown>>, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function importProblem(e: unknown, asset: string, file: string, root: string, timeoutMs: number): Problem {
  if (e instanceof ImportTimeout) {
    return problem("ASSET_INVALID", {
      message: `${file} did not finish loading within ${timeoutMs / 1000} s; its top-level code is still running`,
      hint: "move network calls and other slow work into rows(), which croft runs only when the asset runs",
      asset, file,
    });
  }
  const err = e as { name?: string; message?: string; stack?: string; position?: { file?: string; line?: number; column?: number; lineText?: string } | null };
  // Parse and resolve failures are BuildMessage/ResolveMessage objects with a position and no stack.
  if (err?.name === "BuildMessage" || err?.name === "ResolveMessage") {
    const b = buildError(e);
    const where = b.file ? rel(root, b.file) : file;
    return problem("ASSET_INVALID", {
      message: `${file} could not be loaded: ${shortenPaths(b.message, root)}${b.line ? ` at ${where}:${b.line}` : ""}`,
      hint: b.line ? `fix ${where} line ${b.line}` : "fix the import or the syntax error named above",
      asset, file: where, ...(b.line ? { line: b.line } : {}), ...(b.column !== undefined ? { column: b.column } : {}),
    });
  }
  const message = shortenPaths(err instanceof Error || err?.message !== undefined ? `${err.name ?? "Error"}: ${err.message}` : String(e), root);
  const stack = trimStack(typeof err?.stack === "string" ? err.stack : message, root);
  const frame = firstProjectFrame(typeof err?.stack === "string" ? err.stack : "", root);
  return problem("ASSET_INVALID", {
    message: `${file} failed while loading: ${message}`,
    hint: frame
      ? `fix the code at ${frame.file}:${frame.line}; top-level code in an asset runs on every croft command, so keep work inside rows()`
      : "top-level code in an asset runs on every croft command; keep work inside rows()",
    asset, file: frame?.file ?? file, ...(frame ? { line: frame.line } : {}), ...(frame?.column !== undefined ? { column: frame.column } : {}),
    details: { stack },
  });
}

const FRAME = /^\s*at (?:.*? \()?(.+?):(\d+)(?::(\d+))?\)?\s*$/;

/** The error's message and only the stack frames in project code, with root-relative paths. Frames
 *  inside node_modules and croft itself are noise to the person fixing the asset. */
export function trimStack(stack: string, root: string, maxFrames = 8): string {
  const lines = stack.split("\n");
  const head: string[] = [];
  const frames: string[] = [];
  for (const line of lines) {
    if (/^\s*at /.test(line)) frames.push(line);
    else if (frames.length === 0) head.push(line);
  }
  const roots = projectRoots(root);
  const inProject = (p: string) => roots.some((r) => p.startsWith(r + sep)) && !p.split(sep).includes("node_modules");
  const shorten = (line: string) => shortenPaths(line, root).replace(/^\s+/, "    ");
  let kept = frames.filter((f) => {
    const m = FRAME.exec(f);
    return m ? inProject(m[1]!) : false;
  });
  if (kept.length === 0) kept = frames.slice(0, 3);
  return [...head, ...kept.slice(0, maxFrames).map(shorten)].join("\n");
}

function firstProjectFrame(stack: string, root: string): { file: string; line: number; column?: number } | undefined {
  const roots = projectRoots(root);
  for (const line of stack.split("\n")) {
    const m = FRAME.exec(line);
    if (!m) continue;
    const p = m[1]!;
    if (!roots.some((r) => p.startsWith(r + sep)) || p.split(sep).includes("node_modules")) continue;
    return { file: rel(root, p), line: Number(m[2]), ...(m[3] ? { column: Number(m[3]) } : {}) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// 4. Config validation

export interface ValidateOptions {
  name: string;
  file: string;
  /** Asset source text, to point problems at the line of the offending key. */
  source?: string;
  /** False when the module has no default export at all. */
  hasDefault?: boolean;
  /** The saved cursor type, when known from state. */
  cursorType?: CursorType;
  usesHttp?: boolean;
  /** How the code makes requests (detectRequests), for the TRANSFORM_MAKES_REQUESTS message. */
  requests?: string[];
}

export interface Validation {
  problems: Problem[];
  definition?: AssetDefinition;
  spec?: TsAssetSpec;
}

const COMMON_KEYS = ["description", "key", "write", "checks", "warnings", "columns", "secrets", "retries", "timeout"];
const INGEST_KEYS = [...COMMON_KEYS, "schedule", "allowShrink"];
const ROWS_INGEST_KEYS = [...INGEST_KEYS, "rows", "incremental"];
const FILE_INGEST_KEYS = [...INGEST_KEYS, "file", "format", "csv", "incremental", "map"];
const TRANSFORM_KEYS = [...COMMON_KEYS, "inputs", "incremental", "confirmAbove", "rows"];
const CURSOR_KEYS = ["field", "unit", "lookback"];
const CSV_KEYS = ["delimiter", "header", "skip", "encoding"];
const PIN_KEYS = ["type", "format"];
const WRITE_MODES = ["replace", "append", "merge"] as const;
const FORMATS = ["csv", "tsv", "json", "ndjson", "parquet"] as const;
const ENCODINGS = ["utf-8", "latin-1", "utf-16"] as const;
const UNITS = ["s", "ms"] as const;
const MAX_RETRIES = 10;

type Source = "rows" | "file" | "transform";

class Checker {
  readonly problems: Problem[] = [];
  constructor(readonly o: ValidateOptions) {}

  add(code: Code, key: string | null, message: string, hint: string, extra: Partial<ProblemInit> = {}): void {
    const line = key ? locateKey(this.o.source, key) : undefined;
    const { file, name } = this.o;
    this.problems.push(problem(code, {
      message, hint, asset: name, file,
      ...(line !== undefined ? { line } : {}),
      fix: { kind: "edit", description: hint, file, ...(line !== undefined ? { line } : {}) },
      ...extra,
      details: { key, ...(extra.details ?? {}) },
    }));
  }

  invalid(key: string | null, message: string, hint: string, extra: Partial<ProblemInit> = {}): void {
    this.add("ASSET_INVALID", key, message, hint, extra);
  }
}

/** Validate a module's default export against the public types. Returns the normalized spec when
 *  there are no errors (warnings allowed). */
export function validateDefinition(value: unknown, o: ValidateOptions): Validation {
  const c = new Checker(o);
  const done = (spec?: TsAssetSpec): Validation => {
    const ok = !c.problems.some((p) => p.severity === "error");
    return ok && spec ? { problems: c.problems, definition: value as AssetDefinition, spec } : { problems: c.problems };
  };

  if (value === undefined || value === null) {
    c.invalid(null,
      o.hasDefault === false ? `${o.file} has no default export` : `the default export of ${o.file} is ${value}`,
      "end the file with export default ingest({ ... }) or export default transform({ ... })");
    return done();
  }
  if (!isPlainObject(value) || !("__croft" in value)) {
    if (isPlainObject(value) && ("rows" in value || "file" in value || "inputs" in value)) {
      const fn = "inputs" in value ? "transform" : "ingest";
      c.invalid(null, `the default export is a plain object, not an asset definition`,
        `wrap it: export default ${fn}({ ... }), with import { ${fn} } from "@zabaca/croft"`);
    } else {
      c.invalid(null, `the default export is ${describe(value)}, not an asset definition`,
        "export default ingest({ ... }) or transform({ ... }) from @zabaca/croft");
    }
    return done();
  }
  const role = value.__croft;
  if (role !== "ingest" && role !== "transform") {
    c.invalid(null, `the default export has an unknown kind ${JSON.stringify(role)}`, "use ingest() or transform() from @zabaca/croft");
    return done();
  }
  const config = value.config;
  if (!isPlainObject(config)) {
    c.invalid(null, `${role}() was called with ${describe(config)}; it takes a config object`, `call ${role}({ ... })`);
    return done();
  }
  const cfg = definedEntries(config);

  let source: Source;
  if (role === "transform") source = "transform";
  else {
    const hasRows = cfg.rows !== undefined;
    const hasFile = cfg.file !== undefined;
    if (hasRows && hasFile) {
      c.invalid("file", "an ingest reads from an API with rows() or from files with file, not both",
        "keep rows() for an API, or file for files; split them into two assets if you need both");
    } else if (!hasRows && !hasFile) {
      c.invalid(null, "an ingest needs rows() (an API) or file (a path, glob or URL)",
        'add file: "files/data.csv", or async *rows({ http }) { ... } for an API');
    }
    source = hasFile && !hasRows ? "file" : "rows";
  }

  unknownKeys(c, cfg, source);
  const common = validateCommon(c, cfg);
  let incremental: Incremental = { kind: "none" };
  let inputs: string[] = [];
  let schedule: string | undefined;
  let allowShrink = false;
  let confirmAbove: number | undefined;

  if (role === "ingest") {
    if (cfg.schedule !== undefined) {
      if (typeof cfg.schedule !== "string" || cfg.schedule.trim() === "") {
        c.add("SCHEDULE_INVALID", "schedule", `schedule must be a non-empty string, got ${describe(cfg.schedule)}`,
          'write it in words or as cron: schedule: "every hour", "daily at 06:00", "0 6 * * 1-5"');
      } else schedule = cfg.schedule.trim();
    }
    if (cfg.allowShrink !== undefined) {
      if (typeof cfg.allowShrink !== "boolean") c.invalid("allowShrink", `allowShrink must be true or false, got ${describe(cfg.allowShrink)}`, "remove allowShrink, or set it to true");
      else allowShrink = cfg.allowShrink;
    }
  }

  if (source === "rows") {
    if (cfg.rows !== undefined) requireFunction(c, cfg, "rows", "async *rows({ http, since }) { ... }");
    incremental = cursorIncremental(c, cfg, common);
  } else if (source === "file") {
    validateFileIngest(c, cfg);
    if (cfg.incremental !== undefined) {
      if (typeof cfg.incremental === "boolean") incremental = cfg.incremental ? { kind: "files" } : { kind: "none" };
      else {
        c.invalid("incremental", `a file ingest's incremental is true or false, got ${describe(cfg.incremental)}`,
          "file ingests track files, not a cursor field: incremental: true loads only new or changed files");
      }
    }
  } else {
    inputs = validateInputs(c, cfg, o.name);
    if (cfg.rows === undefined) c.invalid("rows", "a transform needs rows(): the code that turns its inputs into rows", "add async *rows({ rows, newRows }) { ... }");
    else requireFunction(c, cfg, "rows", "async *rows({ newRows }) { ... }");
    if (cfg.incremental !== undefined) {
      if (typeof cfg.incremental !== "boolean") {
        c.invalid("incremental", `a transform's incremental is true or false, got ${describe(cfg.incremental)}`,
          "incremental: true processes only input rows written since the last run (read them with newRows())");
      } else if (cfg.incremental) incremental = { kind: "new-rows", inputs };
    }
    if (cfg.confirmAbove !== undefined) {
      if (!Number.isInteger(cfg.confirmAbove) || (cfg.confirmAbove as number) < 0) {
        c.invalid("confirmAbove", `confirmAbove must be a whole number of input rows, got ${describe(cfg.confirmAbove)}`, "for example confirmAbove: 1000");
      } else confirmAbove = cfg.confirmAbove as number;
    }
  }

  // Rules that span keys.
  const isIncremental = incremental.kind !== "none";
  if (common.write === "merge" && common.key.length === 0) {
    c.invalid("write", 'write: "merge" updates rows by key, and this asset has no key', 'add key: "id" (the column that identifies a record)');
  }
  if (common.write === "replace" && isIncremental) {
    c.invalid("write", 'write: "replace" with incremental would replace the whole table with only the newly fetched rows',
      common.key.length > 0 ? 'remove write (a keyed incremental asset merges), or remove incremental' : 'remove write: "replace", or remove incremental');
  }
  if ((incremental.kind === "cursor" || incremental.kind === "new-rows") && common.key.length === 0 && common.write !== "append") {
    const what = incremental.kind === "cursor" ? "an incremental API ingest re-fetches rows on purpose (lookback, boundary rows)" : "an incremental transform processes changed input rows again";
    c.add("INCREMENTAL_WITHOUT_KEY", "incremental",
      `${o.name} is incremental but has no key; ${what}, and without a key every re-read row would be stored twice`,
      'add key: "id" (the column that identifies a record), or write: "append" for append-only sources such as event logs');
  }
  if (role === "transform" && !isIncremental && o.usesHttp) {
    const via = o.requests && o.requests.length > 0 ? o.requests.join(", ") : "ctx.http";
    c.add("TRANSFORM_MAKES_REQUESTS", "rows",
      `${o.name} rebuilds in full whenever an input changes, and it makes requests (${via}); every rebuild pays for every row again`,
      "make it incremental: incremental: true, a key, and newRows() so each input row is processed once",
      { details: { via: o.requests ?? ["ctx.http"] } });
  }

  const spec: TsAssetSpec = {
    role, source, key: common.key, incremental, secrets: common.secrets, inputs,
    checks: common.checks, warnings: common.warnings, pins: common.pins, allowShrink,
    ...(common.write ? { write: common.write } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    ...(common.retries !== undefined ? { retries: common.retries } : {}),
    ...(common.timeoutMs !== undefined ? { timeoutMs: common.timeoutMs } : {}),
    ...(confirmAbove !== undefined ? { confirmAbove } : {}),
  };
  return done(spec);
}

// Keys that belong to another kind of asset get a message that says where they belong.
function misplaced(key: string, source: Source): string | undefined {
  const transform = source === "transform";
  switch (key) {
    case "schedule": return transform ? "transforms have no schedule: they run when their inputs change" : undefined;
    case "allowShrink": return transform ? "allowShrink is for ingests; a transform's size follows its inputs" : undefined;
    case "inputs": return transform ? undefined : "inputs is for transforms; an ingest brings data in with rows() or file";
    case "confirmAbove": return transform ? undefined : "confirmAbove is the cost guard of incremental transforms, not ingests";
    case "file": return transform ? "file belongs to file ingests: use ingest({ file: ... })" : undefined;
    case "map": return source === "rows" ? "map is for file ingests; clean values inside rows() before yielding them"
      : transform ? "map is for file ingests; shape rows inside rows()" : undefined;
    case "format":
    case "csv": return source === "file" ? undefined : `${key} describes input files, so it belongs to file ingests`;
    default: return undefined;
  }
}

function unknownKeys(c: Checker, cfg: Record<string, unknown>, source: Source): void {
  const allowed = source === "rows" ? ROWS_INGEST_KEYS : source === "file" ? FILE_INGEST_KEYS : TRANSFORM_KEYS;
  for (const key of Object.keys(cfg)) {
    if (allowed.includes(key)) continue;
    // rows and file on an ingest are reported by the rows-vs-file rule.
    if (source !== "transform" && (key === "rows" || key === "file")) continue;
    const where = misplaced(key, source);
    if (where) {
      c.invalid(key, where, `remove ${key}`);
      continue;
    }
    const guess = didYouMean(key, allowed);
    c.invalid(key, `unknown key "${key}"${guess ? `; did you mean "${guess}"?` : ""}`,
      guess ? `rename ${key} to ${guess}` : `remove ${key}; allowed keys: ${allowed.join(", ")}`,
      { details: { suggestion: guess ?? null } });
  }
}

interface Common {
  key: string[];
  write?: WriteMode;
  checks: string[];
  warnings: string[];
  pins: Record<string, { type: string; format?: string }>;
  secrets: string[];
  retries?: number;
  timeoutMs?: number;
}

function validateCommon(c: Checker, cfg: Record<string, unknown>): Common {
  const out: Common = { key: [], checks: [], warnings: [], pins: {}, secrets: [] };

  if (cfg.description !== undefined && typeof cfg.description !== "string") {
    c.invalid("description", `description must be a string, got ${describe(cfg.description)}`, 'description: "What this table holds"');
  }

  if (cfg.key !== undefined) {
    const k = cfg.key;
    if (typeof k === "string") {
      if (k.trim() === "") c.invalid("key", "key is empty", 'name the column that identifies a record: key: "id"');
      else out.key = [k];
    } else if (Array.isArray(k)) {
      if (k.length === 0) c.invalid("key", "key is an empty list", 'name at least one column: key: ["id"], or remove key');
      k.forEach((part, i) => {
        if (typeof part !== "string" || part.trim() === "") c.invalid("key", `key[${i}] must be a column name, got ${describe(part)}`, 'key: ["day", "currency"]');
      });
      const names = k.filter((p): p is string => typeof p === "string" && p.trim() !== "");
      const dup = duplicates(names);
      if (dup.length > 0) c.invalid("key", `key lists ${dup.map((d) => `"${d}"`).join(", ")} more than once`, "list each key column once");
      if (names.length === k.length && dup.length === 0) out.key = names;
    } else {
      c.invalid("key", `key must be a column name or a list of them, got ${describe(k)}`, 'key: "id" or key: ["day", "currency"]');
    }
  }

  if (cfg.write !== undefined) {
    if (typeof cfg.write === "string" && (WRITE_MODES as readonly string[]).includes(cfg.write)) out.write = cfg.write as WriteMode;
    else {
      const guess = typeof cfg.write === "string" ? didYouMean(cfg.write, WRITE_MODES) : undefined;
      c.invalid("write", `write must be "replace", "append" or "merge", got ${describe(cfg.write)}${guess ? `; did you mean "${guess}"?` : ""}`,
        guess ? `write: "${guess}"` : "remove write to let croft infer it from key and incremental");
    }
  }

  out.checks = stringList(c, cfg, "checks", 'checks: ["not_null(id)", "amount >= 0"]');
  out.warnings = stringList(c, cfg, "warnings", 'warnings: ["min_rows(10)"]');

  if (cfg.columns !== undefined) {
    if (!isPlainObject(cfg.columns)) {
      c.invalid("columns", `columns must map column names to types, got ${describe(cfg.columns)}`, 'columns: { amount: "DECIMAL(18,2)", day: { type: "DATE", format: "%d/%m/%Y" } }');
    } else {
      for (const [col, pin] of Object.entries(cfg.columns)) {
        const at = `columns.${col}`;
        if (typeof pin === "string") {
          if (pin.trim() === "") c.invalid("columns", `${at} is an empty type`, `give a DuckDB type: ${col}: "BIGINT"`);
          else out.pins[col] = { type: pin.trim() };
        } else if (isPlainObject(pin)) {
          for (const k of Object.keys(definedEntries(pin))) {
            if (!PIN_KEYS.includes(k)) {
              const guess = didYouMean(k, PIN_KEYS);
              c.invalid("columns", `unknown key "${k}" in ${at}${guess ? `; did you mean "${guess}"?` : ""}`, `a pin is a type, or { type, format }`);
            }
          }
          if (typeof pin.type !== "string" || pin.type.trim() === "") {
            c.invalid("columns", `${at}.type must be a DuckDB type name, got ${describe(pin.type)}`, `${col}: { type: "DATE", format: "%d/%m/%Y" }`);
          } else if (pin.format !== undefined && (typeof pin.format !== "string" || pin.format === "")) {
            c.invalid("columns", `${at}.format must be a strptime pattern such as "%d/%m/%Y", got ${describe(pin.format)}`, `remove format, or write one such as "%d/%m/%Y"`);
          } else {
            out.pins[col] = { type: pin.type.trim(), ...(typeof pin.format === "string" ? { format: pin.format } : {}) };
          }
        } else if (pin !== undefined) {
          c.invalid("columns", `${at} must be a type name or { type, format }, got ${describe(pin)}`, `${col}: "BIGINT"`);
        }
      }
    }
  }

  if (cfg.secrets !== undefined) {
    if (!Array.isArray(cfg.secrets)) {
      c.invalid("secrets", `secrets is a list of .env names, got ${describe(cfg.secrets)}`,
        typeof cfg.secrets === "string" ? `secrets: ["${cfg.secrets}"]` : 'secrets: ["GITHUB_TOKEN"]');
    } else {
      cfg.secrets.forEach((s, i) => {
        if (typeof s !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
          c.invalid("secrets", `secrets[${i}] must be an environment variable name such as GITHUB_TOKEN, got ${describe(s)}`,
            "use the name of the variable in .env, not its value");
        }
      });
      const names = cfg.secrets.filter((s): s is string => typeof s === "string");
      const dup = duplicates(names);
      if (dup.length > 0) c.invalid("secrets", `secrets lists ${dup.join(", ")} more than once`, "list each secret once");
      out.secrets = [...new Set(names)];
    }
  }

  if (cfg.retries !== undefined) {
    if (!Number.isInteger(cfg.retries) || (cfg.retries as number) < 0 || (cfg.retries as number) > MAX_RETRIES) {
      c.invalid("retries", `retries must be a whole number from 0 to ${MAX_RETRIES}, got ${describe(cfg.retries)}`, "retries: 2 (the default)");
    } else out.retries = cfg.retries as number;
  }

  if (cfg.timeout !== undefined) {
    const ms = typeof cfg.timeout === "string" ? parseDuration(cfg.timeout) : null;
    if (ms === null || ms <= 0) {
      c.invalid("timeout", `timeout must be a duration such as "10m" or "2 hours", got ${describe(cfg.timeout)}`, 'timeout: "10m" (the default)');
    } else out.timeoutMs = ms;
  }
  return out;
}

function stringList(c: Checker, cfg: Record<string, unknown>, key: "checks" | "warnings", example: string): string[] {
  const v = cfg[key];
  if (v === undefined) return [];
  if (typeof v === "string") {
    c.invalid(key, `${key} is a list of rules, got a single string`, `${key}: [${JSON.stringify(v)}]`);
    return [];
  }
  if (!Array.isArray(v)) {
    c.invalid(key, `${key} must be a list of rules written as strings, got ${describe(v)}`, example);
    return [];
  }
  const out: string[] = [];
  v.forEach((rule, i) => {
    if (typeof rule !== "string" || rule.trim() === "") {
      c.invalid(key, `${key}[${i}] must be a rule written as a string, such as "amount >= 0", got ${describe(rule)}`,
        "checks use croft's check language in strings: unique(a), not_null(a, b), min_rows(n), or an SQL condition");
    } else out.push(rule.trim());
  });
  return out;
}

function requireFunction(c: Checker, cfg: Record<string, unknown>, key: string, example: string): void {
  if (typeof cfg[key] !== "function") c.invalid(key, `${key} must be a function, got ${describe(cfg[key])}`, example);
}

function cursorIncremental(c: Checker, cfg: Record<string, unknown>, common: Common): Incremental {
  const inc = cfg.incremental;
  if (inc === undefined) return { kind: "none" };
  let field: string | undefined;
  let unit: "s" | "ms" | undefined;
  let lookback: string | undefined;
  let lookbackMs = 0;

  if (typeof inc === "string") {
    if (inc.trim() === "") c.invalid("incremental", "incremental is empty", 'name the cursor field: incremental: "updated_at"');
    else field = inc.trim();
  } else if (typeof inc === "boolean") {
    c.invalid("incremental", `an API ingest's incremental names its cursor field, got ${inc}`,
      'incremental: "updated_at" (or { field: "created", unit: "s", lookback: "30 days" }); incremental: true is for file ingests and transforms');
  } else if (isPlainObject(inc)) {
    const spec = definedEntries(inc);
    for (const k of Object.keys(spec)) {
      if (CURSOR_KEYS.includes(k)) continue;
      const guess = didYouMean(k, CURSOR_KEYS);
      c.invalid("incremental", `unknown key "${k}" in incremental${guess ? `; did you mean "${guess}"?` : ""}`,
        "incremental takes { field, unit?, lookback? }");
    }
    if (typeof spec.field !== "string" || spec.field.trim() === "") {
      c.invalid("incremental", `incremental.field must name the cursor column, got ${describe(spec.field)}`, 'incremental: { field: "updated_at" }');
    } else field = spec.field.trim();
    if (spec.unit !== undefined) {
      if (spec.unit === "s" || spec.unit === "ms") unit = spec.unit;
      else {
        const named: Record<string, string> = { seconds: "s", second: "s", sec: "s", milliseconds: "ms", millisecond: "ms" };
        const guess = typeof spec.unit === "string" ? named[spec.unit.toLowerCase()] ?? didYouMean(spec.unit, UNITS) : undefined;
        c.invalid("unit", `incremental.unit must be "s" or "ms" (epoch seconds or milliseconds), got ${describe(spec.unit)}`,
          guess ? `unit: "${guess}"` : 'unit: "s" for epoch seconds, "ms" for milliseconds');
      }
    }
    if (spec.lookback !== undefined) {
      const ms = typeof spec.lookback === "string" ? parseDuration(spec.lookback) : null;
      if (ms === null || ms <= 0) {
        const months = typeof spec.lookback === "string" && /\b(months?|years?|mo|y|yr)\b/i.test(spec.lookback);
        c.invalid("lookback", `incremental.lookback must be a duration such as "30 days" or "10 minutes", got ${describe(spec.lookback)}`,
          months ? 'months and years have no fixed length: write days, e.g. lookback: "90 days"' : 'lookback: "30 days"');
      } else {
        lookback = spec.lookback as string;
        lookbackMs = ms;
      }
    }
  } else {
    c.invalid("incremental", `incremental must name the cursor field, got ${describe(inc)}`, 'incremental: "updated_at"');
  }
  if (!field) return { kind: "none" };

  // CURSOR_TYPE_MISMATCH where the cursor type is knowable before a load: a pinned column, or the type
  // saved in state by earlier loads.
  const pinned = common.pins[field] ? cursorTypeOfPin(common.pins[field]!.type) : undefined;
  const type = pinned ?? c.o.cursorType;
  const why = pinned ? `columns pins ${field} as ${common.pins[field]!.type}` : `${field} was loaded as ${type === "integer" ? "an" : "a"} ${type} cursor`;
  if (type === "integer" && lookback !== undefined && unit === undefined) {
    c.add("CURSOR_TYPE_MISMATCH", "lookback",
      `lookback "${lookback}" on an integer cursor needs a unit: croft cannot tell how much ${lookback} is in ${field} without knowing it holds epoch time (${why})`,
      `add unit: "s" (epoch seconds) or unit: "ms" (milliseconds) to incremental`, { details: { field, cursorType: type } });
  } else if (type === "string" && lookback !== undefined) {
    c.add("CURSOR_TYPE_MISMATCH", "lookback",
      `a text cursor has no lookback: "${lookback}" cannot be subtracted from ${field} (${why})`,
      "remove lookback, or pin the column to TIMESTAMPTZ or BIGINT", { details: { field, cursorType: type } });
  } else if (unit !== undefined && type !== undefined && type !== "integer") {
    c.add("CURSOR_TYPE_MISMATCH", "unit",
      `unit "${unit}" is for integer cursors holding epoch time, but ${field} is a ${type} cursor (${why})`,
      "remove unit", { details: { field, cursorType: type } });
  }
  return { kind: "cursor", field, ...(unit ? { unit } : {}), lookbackMs };
}

/** The cursor type a pinned column type implies, or undefined when it implies none. */
export function cursorTypeOfPin(type: string): CursorType | undefined {
  const t = type.trim().toUpperCase();
  if (/^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|INT1|INT2|INT4|INT8|LONG|SHORT|SIGNED)$/.test(t)) return "integer";
  if (/^(TIMESTAMP|DATETIME|TIMESTAMPTZ|TIMESTAMP WITH TIME ZONE|TIMESTAMP_S|TIMESTAMP_MS|TIMESTAMP_NS)$/.test(t)) return "timestamp";
  if (t === "DATE") return "date";
  if (/^(VARCHAR|TEXT|STRING|CHAR|BPCHAR)(\(\d+\))?$/.test(t)) return "string";
  return undefined;
}

function validateFileIngest(c: Checker, cfg: Record<string, unknown>): void {
  const f = cfg.file;
  if (typeof f === "string") {
    if (f.trim() === "") c.invalid("file", "file is empty", 'file: "files/sales/*.csv" (a path, glob or URL)');
  } else if (Array.isArray(f)) {
    if (f.length === 0) c.invalid("file", "file is an empty list", 'file: ["files/a.csv", "files/b.csv"]');
    f.forEach((p, i) => {
      if (typeof p !== "string" || p.trim() === "") c.invalid("file", `file[${i}] must be a path, glob or URL, got ${describe(p)}`, 'file: ["files/a.csv"]');
    });
  } else if (f !== undefined) {
    c.invalid("file", `file must be a path, glob or URL (or a list of them), got ${describe(f)}`, 'file: "files/sales/*.csv"');
  }

  if (cfg.format !== undefined && !(typeof cfg.format === "string" && (FORMATS as readonly string[]).includes(cfg.format))) {
    const guess = typeof cfg.format === "string" ? didYouMean(cfg.format.replace(/^\./, ""), FORMATS) : undefined;
    c.invalid("format", `format must be one of ${FORMATS.join(", ")}, got ${describe(cfg.format)}${guess ? `; did you mean "${guess}"?` : ""}`,
      guess ? `format: "${guess}"` : "remove format to use the file extension");
  }

  if (cfg.csv !== undefined) {
    if (!isPlainObject(cfg.csv)) {
      c.invalid("csv", `csv must be an object of CSV options, got ${describe(cfg.csv)}`, "csv: { header: true }");
    } else {
      const o = definedEntries(cfg.csv);
      for (const k of Object.keys(o)) {
        if (CSV_KEYS.includes(k)) continue;
        const guess = didYouMean(k, CSV_KEYS);
        c.invalid("csv", `unknown key "${k}" in csv${guess ? `; did you mean "${guess}"?` : ""}`, `csv takes ${CSV_KEYS.join(", ")}`);
      }
      if (o.delimiter !== undefined && (typeof o.delimiter !== "string" || o.delimiter === "")) {
        c.invalid("delimiter", `csv.delimiter must be a character such as ";" or "|", got ${describe(o.delimiter)}`, 'csv: { delimiter: ";" }');
      }
      if (o.header !== undefined && typeof o.header !== "boolean") {
        c.invalid("header", `csv.header must be true or false, got ${describe(o.header)}`, "csv: { header: true } when the first line holds column names");
      }
      if (o.skip !== undefined && (!Number.isInteger(o.skip) || (o.skip as number) < 0)) {
        c.invalid("skip", `csv.skip must be a whole number of lines, got ${describe(o.skip)}`, "csv: { skip: 2 }");
      }
      if (o.encoding !== undefined && !(typeof o.encoding === "string" && (ENCODINGS as readonly string[]).includes(o.encoding))) {
        const guess = typeof o.encoding === "string" ? didYouMean(o.encoding.toLowerCase().replace(/^utf8$/, "utf-8").replace(/^latin1$/, "latin-1"), ENCODINGS) : undefined;
        c.invalid("encoding", `csv.encoding must be one of ${ENCODINGS.join(", ")}, got ${describe(o.encoding)}`,
          guess ? `encoding: "${guess}"` : 'encoding: "latin-1" for Windows exports');
      }
    }
  }

  if (cfg.map !== undefined && typeof cfg.map !== "function") {
    c.invalid("map", `map must be a function from a row to a row (or null to drop it), got ${describe(cfg.map)}`, "map: (row) => ({ ...row, email: String(row.email).trim() })");
  }
}

function validateInputs(c: Checker, cfg: Record<string, unknown>, self: string): string[] {
  const v = cfg.inputs;
  if (v === undefined) {
    c.invalid(null, "a transform needs inputs: the assets its code reads", 'add inputs: ["github_issues"]');
    return [];
  }
  if (typeof v === "string") {
    c.invalid("inputs", "inputs is a list of asset names, got a single string", `inputs: [${JSON.stringify(v)}]`);
    return [];
  }
  if (!Array.isArray(v)) {
    c.invalid("inputs", `inputs must be a list of asset names, got ${describe(v)}`, 'inputs: ["github_issues"]');
    return [];
  }
  if (v.length === 0) {
    c.invalid("inputs", "inputs is empty; a transform computes a table from other assets", 'list what it reads: inputs: ["github_issues"]; for data from outside, use ingest()');
    return [];
  }
  const out: string[] = [];
  v.forEach((name, i) => {
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
      c.invalid("inputs", `inputs[${i}] must be an asset name (lowercase letters, digits and _), got ${describe(name)}`, "use the asset's file name without .ts or .sql");
    } else if (name === self) {
      c.invalid("inputs", `${self} lists itself in inputs; a transform cannot read its own table`, `remove "${self}" from inputs`);
    } else out.push(name);
  });
  const dup = duplicates(out);
  if (dup.length > 0) c.invalid("inputs", `inputs lists ${dup.join(", ")} more than once`, "list each input once");
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------------
// Helpers

const DURATION_UNITS: Record<string, number> = {
  ms: 1, millisecond: 1, milliseconds: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, wk: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

/** "30 days", "10 minutes", "10m", "1.5h" → milliseconds; null when unreadable. Months and years are
 *  refused on purpose: they have no fixed length. */
export function parseDuration(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(text);
  if (!m) return null;
  const unit = DURATION_UNITS[m[2]!.toLowerCase()];
  if (unit === undefined) return null;
  return Math.round(Number(m[1]) * unit);
}

/** 1-based line of the first `key:` / `key(` in the source, to point a problem at it. */
export function locateKey(source: string | undefined, key: string): number | undefined {
  if (!source) return undefined;
  const re = new RegExp(`(?:^|[^\\w$.])["']?${escapeRegExp(key)}["']?\\s*\\??\\s*[:(]`);
  const lines = source.split("\n");
  const i = lines.findIndex((l) => re.test(l) && !/^\s*(\/\/|\*)/.test(l));
  return i >= 0 ? i + 1 : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Keys with undefined values count as absent: `file?: never` invites `file: undefined`. */
function definedEntries(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function duplicates(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const x of list) (seen.has(x) ? dup : seen).add(x);
  return [...dup];
}

/** A short description of a value for messages: "a number (3)", "a list", "a function". */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "nothing";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (typeof v === "function") return "a function";
  return "an object";
}

/** Absolute project paths in a message, made root-relative. */
function shortenPaths(text: string, root: string): string {
  return projectRoots(root).reduce((t, r) => t.split(r + sep).join(""), text);
}

function rel(root: string, path: string): string {
  for (const r of projectRoots(root)) {
    if (path.startsWith(r + sep)) return relative(r, path).split(sep).join("/");
  }
  return path;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
