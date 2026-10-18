#!/usr/bin/env bun
// What have croft's consumers had to build themselves? (.claude/skills/consumer-mining/SKILL.md)
//
// Every croft project is a record of where croft fell short: a lib/ helper written because no seam existed, a
// raw fetch() beside ctx.http, a bin/ wrapper around the CLI, a comment naming an API limit croft could not
// express, a run that failed the same way six times. This collects that record so it can be mined for the next
// feature. It decides nothing; it produces the evidence a reviewer reasons over.
//
// The design rests on one distinction, divergence versus staleness, taken from zbc's survey. `croft init`
// writes files into every project (the croft skill, the CLAUDE.md block, the example asset), and a project on
// 0.1.0 differs from main in all of them without anyone having edited a line. Diffing against main reads our
// own history back to us as feedback. So each vendored file is hashed against every historical revision of the
// template it came from: a match at any revision is `current` or `stale` and teaches nothing; no match is
// `divergent`, an edit someone made to our text.
//
// The second half is what has no template at all: the project's own code outside assets/, the escape hatches
// in its assets, the dependencies it added, and (for checkouts on this machine, since .croft/ is never
// committed) what its runs actually hit.
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------------------------------------------

export type Verdict = "current" | "stale" | "divergent" | "removed";

/** One historical revision of one template file. */
export interface Revision { rev: string; date: string; hash: string; normalizedHash: string; content: string }

/** The skill's version stamp (`<!-- croft 0.1.0 -->`) put back to the template's placeholder, so a skill
 *  written by 0.1.0 matches the template revision 0.1.0 shipped rather than differing on its first line. */
export function unstamp(text: string): string {
  return text.replace(/^<!-- croft \S+ -->$/m, "<!-- croft {{version}} -->");
}

/** Strip the axes a formatter or an editor owns: quote style, trailing semicolons and commas, indentation,
 *  blank lines, line endings. Comments are kept: a consumer's comment is often the finding. */
export function normalize(source: string): string {
  return unstamp(source)
    .replace(/\r\n/g, "\n")
    .replace(/"/g, "'")
    .split("\n")
    .map((l) => l.trim().replace(/[;,]+$/, ""))
    .filter((l) => l.length > 0)
    .join("\n");
}

export function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function revision(rev: string, content: string, date = ""): Revision {
  return { rev, date, hash: hash(unstamp(content)), normalizedHash: hash(normalize(content)), content };
}

/** Jaccard overlap of non-blank trimmed lines, 0..1. Only picks the revision a divergent file is closest to, so
 *  a reviewer diffs against what the consumer started from; nothing branches on the value. */
export function similarity(a: string, b: string): number {
  const lines = (s: string) => new Set(s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
  const [x, y] = [lines(a), lines(b)];
  if (x.size === 0 && y.size === 0) return 1;
  let shared = 0;
  for (const l of x) if (y.has(l)) shared++;
  return shared / (x.size + y.size - shared);
}

export interface Classification {
  verdict: Verdict;
  formattingOnly?: boolean;   // the match needed normalize(): a reformat, not an edit
  matchedRev?: string;        // current or stale: the revision this is a copy of
  nearestRev?: string;        // divergent: the revision to diff against
  similarity?: number;
}

/** Where a consumer's copy of a vendored file sits against `history`, every revision newest first. */
export function classify(content: string | null, history: Revision[]): Classification {
  if (content === null) return { verdict: "removed" };
  const newest = history[0]?.rev;
  const h = hash(unstamp(content));
  const exact = history.find((r) => r.hash === h);
  if (exact) return { verdict: exact.rev === newest ? "current" : "stale", matchedRev: exact.rev };
  const nh = hash(normalize(content));
  const reformatted = history.find((r) => r.normalizedHash === nh);
  if (reformatted) {
    return { verdict: reformatted.rev === newest ? "current" : "stale", matchedRev: reformatted.rev, formattingOnly: true };
  }
  let nearest = history[0];
  let best = -1;
  for (const r of history) {
    const score = similarity(unstamp(content), unstamp(r.content));
    if (score > best) [best, nearest] = [score, r];
  }
  return { verdict: "divergent", nearestRev: nearest?.rev, similarity: Number(best.toFixed(3)) };
}

/** One file classified against several templates (the CLAUDE.md block has a project and an app variant): the
 *  closest verdict wins, and among divergent ones the most similar. Each template is judged against its own
 *  history, so a block that is current for one variant is not called stale by the other's newer revision. */
export function bestOf(results: Classification[]): Classification {
  const rank: Record<Verdict, number> = { current: 0, stale: 1, divergent: 2, removed: 3 };
  return results.toSorted((a, b) => rank[a.verdict] - rank[b.verdict] || (b.similarity ?? 0) - (a.similarity ?? 0))[0] ?? { verdict: "removed" };
}

/** A CLAUDE.md split into croft's managed block (start marker line through end marker line) and everything
 *  the consumer wrote around it. block is null when there is no balanced block. */
export function splitClaudeMd(text: string): { block: string | null; outside: string } {
  const at = text.indexOf("<!-- croft:start");
  const endAt = at === -1 ? -1 : text.indexOf("<!-- croft:end -->", at);
  if (at === -1 || endAt === -1) return { block: null, outside: text.trim() };
  const start = text.lastIndexOf("\n", at) + 1;
  const nl = text.indexOf("\n", endAt);
  const end = nl === -1 ? text.length : nl + 1;
  const block = text.slice(start, end).endsWith("\n") ? text.slice(start, end) : `${text.slice(start, end)}\n`;
  return { block, outside: (text.slice(0, start) + text.slice(end)).trim() };
}

/** Top-level keys of the object literal passed to ingest( or transform(: the options this asset chose. Brace
 *  matched rather than parsed; an asset built some other way reports no keys rather than wrong ones. */
export function configKeys(source: string): string[] {
  const call = /\b(?:ingest|transform)\s*\(\s*\{/.exec(source);
  if (!call) return [];
  let depth = 0;
  let line = "";
  const keys: string[] = [];
  for (let i = call.index + call[0].length - 1; i < source.length; i++) {
    const c = source[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) {
        take(line);
        break;
      }
    }
    if (c === "\n") {
      take(line);
      line = "";
    } else if (depth === 1 || (depth === 2 && (c === "(" || c === "{"))) line += c;
  }
  function take(l: string) {
    const m = /^\s*(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*(?:[:(,]|$)/.exec(l);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

/** The context fields an asset's rows()/map() destructures: which parts of croft's API it actually leans on. */
export function contextFields(source: string): string[] {
  const fields = new Set<string>();
  for (const m of source.matchAll(/\b(?:rows|map)\s*\(\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) fields.add(name);
    }
  }
  return [...fields];
}

export function assetKind(path: string, source: string): string {
  if (path.endsWith(".sql")) return "sql";
  if (/\bingest\s*\(/.test(source)) return /^\s*file\s*:/m.test(source) ? "file-ingest" : "rows-ingest";
  if (/\btransform\s*\(/.test(source)) return "transform";
  return "unknown";
}

/** Module specifiers a file imports, croft's own included (a project importing @zabaca/croft internals is a
 *  finding too). */
export function imports(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/(?:^|\n)\s*import[\s\S]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
    out.add(m[1] ?? m[2]);
  }
  return [...out];
}

/** A comment line, in any of the languages a croft project holds (TS, SQL, shell). Its text, or null. */
const COMMENT_LINE = /^(?:\/\/|\/\*+|\*|--|#(?!!))/;

export function commentText(line: string): string | null {
  const t = line.trim();
  const lead = COMMENT_LINE.exec(t);
  if (lead) return t.slice(lead[0].length).trim();
  const trailing = /\s\/\/\s(.*)$/.exec(line);
  return trailing ? trailing[1] : null;
}

/** Things croft has a feature for, done some other way. Each hit is a line where croft's API was not enough or
 *  not known; which of the two is the reviewer's call. */
export const HATCHES: { kind: string; pattern: RegExp; means: string }[] = [
  { kind: "fetch", pattern: /\bfetch\s*\(/, means: "HTTP outside ctx.http: no retries, Retry-After, redaction or request log" },
  { kind: "sleep", pattern: /\bBun\.sleep\s*\(|\bsetTimeout\s*\(|\bsleep\s*\(/, means: "pacing by hand" },
  { kind: "shell", pattern: /child_process|Bun\.spawn|Bun\.\$|\bexecSync\b|\bexec\s+\S/, means: "a subprocess" },
  { kind: "duckdb", pattern: /@duckdb\/node-api|\bduckdb\s+-|\.duckdb\b/, means: "the database opened or named outside croft" },
  { kind: "sops", pattern: /\bsops\b/, means: "secrets from a store croft does not read" },
  { kind: "env", pattern: /process\.env|Bun\.env/, means: "configuration or secrets outside secret()" },
  { kind: "fs", pattern: /\b(?:readFileSync|readdirSync|writeFileSync|readFile|writeFile|Bun\.file|Bun\.write)\b/, means: "files outside a file ingest" },
  { kind: "scheduler", pattern: /\bcrontab\b|\blaunchctl\b|\bsystemctl\b|\.plist\b/, means: "scheduling outside croft schedule" },
  { kind: "croft-state", pattern: /\.croft\/|runs\.sqlite/, means: "croft's own state read directly" },
  { kind: "fail", pattern: /\bfail\s*\(\s*["'`]/, means: "an asset stopping itself with a code of its own" },
];

export interface Hit { file: string; line: number; kind: string; snippet: string }

export function findHatches(files: { path: string; content: string }[]): Hit[] {
  const hits: Hit[] = [];
  for (const f of files) {
    f.content.split("\n").forEach((text, i) => {
      const t = text.trim();
      if (COMMENT_LINE.test(t)) return;
      for (const h of HATCHES) {
        if (h.pattern.test(text)) hits.push({ file: f.path, line: i + 1, kind: h.kind, snippet: t.slice(0, 200) });
      }
    });
  }
  return hits;
}

/** Comments that talk about croft, a workaround or an API's limits: where a consumer wrote down, in their own
 *  words, what they had to work around. */
export const NOTE = /\bcroft\b|work ?around|\bhack\b|\btodo\b|\bfixme\b|\bxxx\b|rate.?limit|\bquota\b|\blimits?\b|requests? (?:an?|per|each) (?:second|minute|hour|day)|\bper (?:second|minute|hour|day)\b/i;

export function findNotes(files: { path: string; content: string }[]): Hit[] {
  const notes: Hit[] = [];
  for (const f of files) {
    f.content.split("\n").forEach((text, i) => {
      const c = commentText(text);
      if (c !== null && NOTE.test(c)) notes.push({ file: f.path, line: i + 1, kind: "note", snippet: c.trim().slice(0, 300) });
    });
  }
  return notes;
}

/** Dependencies beyond the three `croft init` writes: a library a consumer reached for is a capability croft
 *  did not offer, or a format it did not read. */
const SCAFFOLD_DEPS = new Set(["@zabaca/croft", "@types/bun", "typescript"]);
export function addedDependencies(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): string[] {
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => !SCAFFOLD_DEPS.has(d)).sort();
}

/** The croft version a bun.lock resolved, or null. */
export function lockedCroft(lock: string): string | null {
  return /"@zabaca\/croft@([^"]+)"/.exec(lock)?.[1] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..");
const AGENT = "packages/croft/src/agent";
const WORK = join(REPO_ROOT, ".consumer-survey");
const HOME = process.env.HOME ?? "~";
const expand = (p: string) => p.replace(/^~/, HOME);

/** The files `croft init` writes from a template, by where they land in a project. */
const VENDORED: { name: string; at: string; templates: string[] }[] = [
  { name: "skill", at: ".claude/skills/croft/SKILL.md", templates: [`${AGENT}/skill.md`] },
  { name: "claude-md", at: "CLAUDE.md", templates: [`${AGENT}/claude-md.md`, `${AGENT}/claude-md-app.md`] },
  { name: "example-asset", at: "assets/example_sales.ts", templates: [`${AGENT}/project/assets/example_sales.ts`] },
];

/** Project files croft owns or scaffolds; everything else outside assets/ and files/ is the consumer's own. */
const SCAFFOLD = new Set(["croft.json", "package.json", "bun.lock", "tsconfig.json", ".gitignore", ".env", ".env.example", "CLAUDE.md", "README.md"]);

function run(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr?.trim()}`);
  return r.stdout;
}

function tryRun(cmd: string, args: string[], cwd?: string): string | null {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Every revision of a template file, newest first, following renames. */
export function history(file: string, repoRoot = REPO_ROOT): Revision[] {
  const log = run("git", ["log", "--follow", "--format=%H %ad", "--date=short", "--name-only", "--", file], repoRoot);
  const revs: Revision[] = [];
  // --name-only gives each commit's path for the file, which changes across a rename.
  for (const entry of log.split(/\n(?=[0-9a-f]{40} )/)) {
    const [head, ...paths] = entry.trim().split("\n").filter(Boolean);
    if (!head) continue;
    const [rev, date] = head.split(" ");
    const content = tryRun("git", ["show", `${rev}:${paths.at(-1) ?? file}`], repoRoot);
    if (content !== null) revs.push(revision(rev, content, date));
  }
  return revs;
}

interface Consumer {
  id: string;
  repo: string | null;
  access: string;   // github | local:<repo path> | ssh:<host>:<repo path>
  root?: string;    // the croft project's directory inside the repo, where croft.json is
  state?: string;   // a checkout on this machine whose .croft/ holds the run history; local access defaults to itself
  tier: string;
}

interface Fetched { repoDir: string; ref: string; commits: string[] }

/** The consumer's repo on disk at its default branch, with the commit subjects that touched the project. */
function fetchConsumer(c: Consumer): Fetched {
  const dir = join(WORK, "repos", c.id);
  mkdirSync(dirname(dir), { recursive: true });
  const logArgs = ["log", "--format=%h %ad %s", "--date=short", "-n", "200", "--", c.root ?? "."];

  if (c.access === "github") {
    if (!c.repo) throw new Error(`${c.id}: access is github but no repo`);
    const url = `git@github.com:${c.repo}.git`;
    // Blobless rather than shallow: the commit log is evidence, the blobs are fetched only for HEAD.
    if (existsSync(join(dir, ".git"))) {
      run("git", ["remote", "set-url", "origin", url], dir);
      run("git", ["fetch", "--filter=blob:none", "origin", "HEAD"], dir);
      run("git", ["reset", "--hard", "FETCH_HEAD"], dir);
    } else {
      run("git", ["clone", "--filter=blob:none", url, dir]);
    }
    return { repoDir: dir, ref: run("git", ["rev-parse", "HEAD"], dir).trim(), commits: run("git", logArgs, dir).split("\n").filter(Boolean) };
  }

  if (c.access.startsWith("local:")) {
    // Archived at HEAD: what is committed, not what is sitting in the working tree.
    const local = expand(c.access.slice("local:".length));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const tar = spawnSync("sh", ["-c", `git -C '${local}' archive HEAD | tar -x -C '${dir}'`], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`${c.id}: local archive failed: ${tar.stderr}`);
    return { repoDir: dir, ref: run("git", ["-C", local, "rev-parse", "HEAD"]).trim(), commits: run("git", ["-C", local, ...logArgs]).split("\n").filter(Boolean) };
  }

  const m = /^ssh:([^:]+):(.+)$/.exec(c.access);
  if (!m) throw new Error(`${c.id}: unrecognised access ${c.access}`);
  const [, host, remote] = m;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = spawnSync("sh", ["-c", `ssh ${host} 'git -C ${remote} archive HEAD' | tar -x -C '${dir}'`], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`${c.id}: ssh archive failed: ${tar.stderr}`);
  const ref = spawnSync("ssh", [host, `git -C ${remote} rev-parse HEAD`], { encoding: "utf8" }).stdout.trim();
  const log = spawnSync("ssh", [host, `git -C ${remote} ${logArgs.map((a) => `'${a}'`).join(" ")}`], { encoding: "utf8" }).stdout;
  return { repoDir: dir, ref, commits: log.split("\n").filter(Boolean) };
}

const TEXT = /\.(ts|mts|js|mjs|sql|json|ya?ml|sh|toml|md)$|^[^.]+$/;

function walk(root: string, skip: (rel: string, isDir: boolean) => boolean): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const go = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (e.name === "node_modules" || e.name === ".git" || skip(rel, e.isDirectory())) continue;
      if (e.isDirectory()) go(full);
      else if (e.isFile() && TEXT.test(e.name) && statSync(full).size < 1024 * 1024) {
        out.push({ path: rel, content: readFileSync(full, "utf8") });
      }
    }
  };
  go(root);
  return out;
}

const readOr = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);

interface VendoredRecord extends Classification {
  name: string;
  path: string;
  stamp?: string | null;    // skill: the croft version that wrote it
  ownGuidance?: string;     // claude-md: what the consumer wrote around croft's block
}

interface AssetRecord { path: string; kind: string; lines: number; configKeys: string[]; contextFields: string[]; imports: string[]; runs?: Record<string, number> }

interface RunHistory {
  span: { first: string | null; last: string | null };
  runs: { status: string; trigger: string; count: number }[];
  failures: { asset: string; code: string; count: number; lastSeen: string; message: string }[];
  retried: { asset: string; count: number }[];
  confirmations: { command: string; count: number }[];
  scheduled: { asset: string; phrase: string }[];
  byAsset: Record<string, Record<string, number>>;
}

/** What a project's runs actually hit, from .croft/runs.sqlite. Opened read-only; .croft/ is never committed,
 *  so this exists only for a checkout on this machine. */
function runHistory(project: string): RunHistory | null {
  const file = join(project, ".croft", "runs.sqlite");
  if (!existsSync(file)) return null;
  const db = new Database(file, { readonly: true });
  try {
    const all = <T>(sql: string) => db.query(sql).all() as T[];
    const span = db.query("SELECT min(started_at) AS first, max(started_at) AS last FROM runs").get() as RunHistory["span"];
    const failures = new Map<string, RunHistory["failures"][number]>();
    for (const s of all<{ asset: string; error: string; started_at: string }>("SELECT asset, error, started_at FROM steps WHERE status = 'failed' AND coalesce(error, '') <> '' ORDER BY started_at")) {
      let code = "UNKNOWN";
      let message = s.error;
      try {
        const e = JSON.parse(s.error) as { code?: string; message?: string };
        code = e.code ?? code;
        message = e.message ?? message;
      } catch {}
      const key = `${s.asset}\0${code}`;
      const f = failures.get(key) ?? { asset: s.asset, code, count: 0, lastSeen: "", message: "" };
      f.count++;
      f.lastSeen = s.started_at;
      f.message = message.slice(0, 300);
      failures.set(key, f);
    }
    const byAsset: RunHistory["byAsset"] = {};
    for (const r of all<{ asset: string; status: string; n: number }>("SELECT asset, status, count(*) AS n FROM steps GROUP BY 1, 2")) {
      (byAsset[r.asset] ??= {})[r.status] = r.n;
    }
    return {
      span,
      runs: all("SELECT status, trigger, count(*) AS count FROM runs GROUP BY 1, 2 ORDER BY 3 DESC"),
      failures: [...failures.values()].toSorted((a, b) => b.count - a.count),
      retried: all("SELECT asset, count(*) AS count FROM steps WHERE attempt > 1 GROUP BY 1 ORDER BY 2 DESC"),
      confirmations: all("SELECT command, count(*) AS count FROM confirmations GROUP BY 1 ORDER BY 2 DESC"),
      scheduled: all("SELECT asset, phrase FROM schedule_state WHERE phrase IS NOT NULL"),
      byAsset,
    };
  } finally {
    db.close();
  }
}

function surveyConsumer(c: Consumer, templates: Record<string, Revision[]>, current: string) {
  const fetched = fetchConsumer(c);
  const repoDir = fetched.repoDir;
  const project = join(repoDir, c.root ?? "");
  if (!existsSync(join(project, "croft.json"))) throw new Error(`${c.id}: no croft.json at ${c.root ?? "the repo root"}`);

  // An app's croft project sits in data/ with the managed block in the app's CLAUDE.md, one level up.
  const appMode = (c.root ?? "").split("/").at(-1) === "data" && existsSync(join(project, "..", "package.json"));
  const vendored = VENDORED.map((v) => {
    let content = readOr(join(project, v.at));
    let outside: string | undefined;
    if (v.name === "claude-md") {
      const text = content ?? (appMode ? readOr(join(project, "..", "CLAUDE.md")) : null);
      const split = text === null ? null : splitClaudeMd(text);
      content = split?.block ?? null;
      outside = split?.outside || undefined;
    }
    const record: VendoredRecord = { name: v.name, path: v.at, ...bestOf(v.templates.map((t) => classify(content, templates[t] ?? []))) };
    if (v.name === "skill" && content) record.stamp = /^<!-- croft (\S+) -->$/m.exec(content)?.[1] ?? null;
    if (outside) record.ownGuidance = outside;
    return record;
  });

  const files = walk(project, (rel, isDir) =>
    isDir ? rel === ".croft" || rel === "files" || rel === "dist" : /\.duckdb/.test(rel) || rel === ".env");
  const assets = files.filter((f) => f.path.startsWith("assets/") && /\.(ts|sql)$/.test(f.path));
  const own = files.filter((f) => !f.path.startsWith("assets/") && !SCAFFOLD.has(f.path) && !f.path.startsWith(".claude/skills/croft/"));

  const statePath = c.state ? expand(c.state) : c.access.startsWith("local:") ? join(expand(c.access.slice(6)), c.root ?? "") : null;
  const history = statePath ? runHistory(statePath) : null;

  const pkg = JSON.parse(readOr(join(project, "package.json")) ?? "{}");
  const lock = readOr(join(project, "bun.lock")) ?? readOr(join(repoDir, "bun.lock")) ?? "";

  // Outside the project: who else in the repo drives croft or reads its data, and how.
  const outsideRefs: Hit[] = [];
  if (c.root) {
    const rootRel = c.root.replace(/\/$/, "");
    // The project by name or path, not any .duckdb: a monorepo can hold another warehouse croft has nothing to do with.
    const mentions = new RegExp(`@zabaca/croft|\\bcroft (?:run|query|serve|schedule|preview|validate|init|tick)\\b|bin/croft\\b|${rootRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    for (const f of walk(repoDir, (rel, isDir) => rel === rootRel || (isDir && /(^|\/)(dist|vendor|\.consumer-survey)$/.test(rel)) || /(^|\/)bun\.lock$/.test(rel))) {
      f.content.split("\n").forEach((text, i) => {
        if (mentions.test(text)) {
          outsideRefs.push({ file: f.path, line: i + 1, kind: "outside", snippet: text.trim().slice(0, 200) });
        }
      });
    }
  }

  return {
    id: c.id,
    repo: c.repo,
    root: c.root ?? null,
    tier: c.tier,
    ref: fetched.ref,
    surveyedAt: new Date().toISOString(),
    croft: { pinned: pkg.dependencies?.["@zabaca/croft"] ?? pkg.devDependencies?.["@zabaca/croft"] ?? null, locked: lockedCroft(lock), current },
    config: JSON.parse(readOr(join(project, "croft.json")) ?? "{}"),
    addedDependencies: addedDependencies(pkg),
    vendored,
    assets: assets.map((a): AssetRecord => {
      const name = a.path.replace(/^assets\//, "").replace(/\.(ts|sql)$/, "");
      return {
        path: a.path,
        kind: assetKind(a.path, a.content),
        lines: a.content.split("\n").length,
        configKeys: a.path.endsWith(".ts") ? configKeys(a.content) : [],
        contextFields: contextFields(a.content),
        imports: imports(a.content),
        ...(history ? { runs: history.byAsset[name] ?? {} } : {}),
      };
    }),
    ownCode: own.map((f) => ({ path: f.path, lines: f.content.split("\n").length, imports: imports(f.content) })),
    hatches: findHatches([...assets, ...own]),
    notes: findNotes([...assets, ...own]),
    outsideRefs,
    commits: fetched.commits,
    runHistory: history,
    stateFrom: history ? statePath : null,
  };
}

type Survey = ReturnType<typeof surveyConsumer>;

/** The same findings regrouped by croft surface: the deliverable is per surface, not per repo. */
export function rollup(surveys: Survey[]) {
  const surfaces: Record<string, { consumer: string; [k: string]: unknown }[]> = {};
  const add = (key: string, item: { consumer: string; [k: string]: unknown }) => (surfaces[key] ??= []).push(item);
  for (const s of surveys) {
    for (const v of s.vendored) if (v.verdict === "divergent") add(`vendored:${v.name}`, { consumer: s.id, ...v });
    for (const v of s.vendored) if (v.ownGuidance) add("vendored:claude-md-own-guidance", { consumer: s.id, text: v.ownGuidance });
    for (const h of s.hatches) add(`hatch:${h.kind}`, { consumer: s.id, ...h });
    for (const d of s.addedDependencies) add(`dependency:${d}`, { consumer: s.id });
    for (const o of s.ownCode) add("own-code", { consumer: s.id, ...o });
    for (const f of s.runHistory?.failures ?? []) add(`failure:${f.code}`, { consumer: s.id, ...f });
  }
  const tally = (pick: (s: Survey) => string[]) => {
    const t: Record<string, string[]> = {};
    for (const s of surveys) for (const k of new Set(pick(s))) (t[k] ??= []).push(s.id);
    return Object.fromEntries(Object.entries(t).toSorted((a, b) => b[1].length - a[1].length));
  };
  return {
    surfaces: Object.entries(surfaces)
      .map(([surface, items]) => ({ surface, consumers: [...new Set(items.map((i) => i.consumer))], items }))
      .toSorted((a, b) => b.consumers.length - a.consumers.length || b.items.length - a.items.length),
    // The interface as consumers use it: options and context fields by how many projects reach for them.
    usage: {
      kinds: tally((s) => s.assets.map((a) => a.kind)),
      configKeys: tally((s) => s.assets.flatMap((a) => a.configKeys)),
      contextFields: tally((s) => s.assets.flatMap((a) => a.contextFields)),
    },
    drift: surveys.map((s) => ({ consumer: s.id, ...s.croft, skillStamp: s.vendored.find((v) => v.name === "skill")?.stamp ?? null })),
  };
}

function main() {
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "docs/consumers/registry.json"), "utf8"));
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const consumers: Consumer[] = registry.consumers.filter((c: Consumer) => only.length === 0 || only.includes(c.id));
  const current = JSON.parse(readFileSync(join(REPO_ROOT, "packages/croft/package.json"), "utf8")).version as string;

  mkdirSync(WORK, { recursive: true });
  console.error("indexing template history…");
  const templates = Object.fromEntries(VENDORED.flatMap((v) => v.templates).map((t) => [t, history(t)]));

  const surveys: Survey[] = [];
  for (const c of consumers) {
    console.error(`surveying ${c.id}…`);
    let out: unknown;
    try {
      const s = surveyConsumer(c, templates, current);
      surveys.push(s);
      out = s;
    } catch (err) {
      out = { id: c.id, error: String(err instanceof Error ? err.message : err) };
      console.error(`  ${(out as { error: string }).error}`);
    }
    writeFileSync(join(WORK, `${c.id}.json`), `${JSON.stringify(out, null, 2)}\n`);
  }

  const index = rollup(surveys);
  writeFileSync(join(WORK, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  const vendored = surveys.flatMap((s) => s.vendored);
  const count = (v: Verdict) => vendored.filter((x) => x.verdict === v).length;
  console.error(
    `\n${vendored.length} vendored files: ${count("current")} current, ${count("stale")} stale, ${count("divergent")} divergent, ${count("removed")} removed`,
  );
  console.error(`${surveys.reduce((n, s) => n + s.ownCode.length, 0)} own-code files, ${surveys.reduce((n, s) => n + s.hatches.length, 0)} hatches, ${surveys.reduce((n, s) => n + s.notes.length, 0)} notes`);
  console.error(`${index.surfaces.length} surfaces → ${relative(REPO_ROOT, WORK)}/index.json`);
}

if (import.meta.main) main();
