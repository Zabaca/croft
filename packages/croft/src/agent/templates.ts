// What `croft init` writes (DESIGN.md §2 "croft init in an empty folder", §9 "Claude Code integration").
// Text files live next to this module so they can be read and reviewed as they ship: skill.md and
// claude-md.md are the §9 texts word for word (agent/templates.test.ts compares them byte for byte, and
// agent/contract.test.ts checks that every command and flag they name exists), and project/ holds the
// scaffold. Files whose names would change behavior inside this repository are stored under neutral
// names and renamed on write: a real .gitignore would apply to croft's own source tree (and npm drops
// .gitignore files when packing), and a real CLAUDE.md or .claude/skills/ folder would be loaded by
// Claude Code sessions working on croft.
import { readFileSync } from "node:fs";
import pkg from "../../package.json" with { type: "json" };

export const CROFT_PACKAGE = "@zabaca/croft";
export const CROFT_VERSION: string = pkg.version;

/** Where the skill lives in a project; Claude Code discovers skills under .claude/skills/<name>/. */
export const SKILL_PATH = ".claude/skills/croft/SKILL.md";
export const CLAUDE_MD = "CLAUDE.md";

// The managed block's markers. The start marker carries a note after "croft:start", so it is matched
// by prefix; the end marker is exact.
export const BLOCK_START = "<!-- croft:start";
export const BLOCK_END = "<!-- croft:end -->";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** SKILL.md stamped with the croft version that wrote it (CLAUDE_FILES_OUTDATED compares the stamp). */
export function skillMd(version: string = CROFT_VERSION): string {
  return read("./skill.md").replace("{{version}}", version);
}

/** The version stamped into a SKILL.md (`<!-- croft 0.1.0 -->`), or null when there is none. */
export function skillStamp(text: string): string | null {
  return /^<!-- croft (\S+) -->$/m.exec(text)?.[1] ?? null;
}

/** The CLAUDE.md managed block: "project" for a croft project's own folder, "app" for the root of an
 *  app repo whose croft project lives in data/. Ends with a newline. */
export function claudeBlock(kind: "project" | "app" = "project"): string {
  return read(kind === "app" ? "./claude-md-app.md" : "./claude-md.md");
}

export interface BlockSpan { start: number; end: number; text: string }

/** Where the managed block sits in a CLAUDE.md: from the start of the start marker's line to the end of
 *  the end marker's line (including its newline). null when there is no start marker. Throws when the
 *  markers are unbalanced, because guessing where the block ends could delete the user's own text. */
export function findBlock(text: string): BlockSpan | null {
  const at = text.indexOf(BLOCK_START);
  if (at === -1) return null;
  const start = text.lastIndexOf("\n", at) + 1;
  const endAt = text.indexOf(BLOCK_END, at);
  if (endAt === -1) throw new UnbalancedBlock(`"${BLOCK_START} …" has no matching "${BLOCK_END}"`);
  if (text.indexOf(BLOCK_START, at + BLOCK_START.length) !== -1) throw new UnbalancedBlock("the croft block appears more than once");
  const nl = text.indexOf("\n", endAt);
  const end = nl === -1 ? text.length : nl + 1;
  return { start, end, text: text.slice(start, end) };
}

export class UnbalancedBlock extends Error {}

export type BlockAction = "created" | "appended" | "replaced" | "unchanged";

/** Put `block` into a CLAUDE.md: create the file, append the block, or replace the old block in place.
 *  Text outside the markers is never touched. */
export function upsertBlock(existing: string | null, block: string): { text: string; action: BlockAction } {
  const body = block.endsWith("\n") ? block : `${block}\n`;
  if (existing === null) return { text: body, action: "created" };
  const span = findBlock(existing);
  if (!span) {
    if (existing.trim() === "") return { text: body, action: "appended" };
    const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return { text: existing + sep + body, action: "appended" };
  }
  // A block that was the last thing in a file without a trailing newline keeps that shape.
  const replacement = span.text.endsWith("\n") ? body : body.slice(0, -1);
  if (span.text === replacement) return { text: existing, action: "unchanged" };
  return { text: existing.slice(0, span.start) + replacement + existing.slice(span.end), action: "replaced" };
}

export interface ScaffoldOptions {
  version?: string;
  timezone: string;
  /** Relocated database and state folder (as written to croft.json), when the project is in a synced folder. */
  relocated?: { database: string; stateDir: string } | null;
}

export interface TemplateFile {
  path: string;                      // relative to the project root, "/"-separated
  text: string;
  mode?: number;                     // .env is private: 0600
}

/** croft.json. The time zone is recorded at init so "daily at 06:00" keeps its meaning on a UTC server. */
export function croftJson(o: ScaffoldOptions): string {
  const config: Record<string, string> = {
    $schema: `./node_modules/${CROFT_PACKAGE}/croft.schema.json`,
    database: o.relocated?.database ?? "warehouse.duckdb",
    timezone: o.timezone,
  };
  if (o.relocated) config.stateDir = o.relocated.stateDir;
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** package.json with exact pins: the project runs the croft version it was made with until it is
 *  upgraded on purpose, and bun.lock is the whole environment. */
export function packageJson(o: { version?: string } = {}): string {
  const dev = pkg.devDependencies as Record<string, string>;
  return `${JSON.stringify({
    private: true,
    type: "module",
    dependencies: { [CROFT_PACKAGE]: o.version ?? CROFT_VERSION },
    devDependencies: { "@types/bun": dev["@types/bun"], typescript: dev.typescript },
  }, null, 2)}\n`;
}

/** tsconfig.json for assets/ and lib/, and the input row types croft generates in .croft/types
 *  (project/types-gen.ts), so an editor, Claude and `croft validate --types` check a TS transform's rows
 *  against its inputs' columns. Only declaration files: nothing else in .croft/ is compiled. The package
 *  ships TypeScript source, so these options must also accept croft's own files: .ts import extensions,
 *  JSON imports and Bun's types. */
export function tsconfigJson(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "esnext",
      module: "esnext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      types: ["bun"],
    },
    include: ["assets", "lib", ".croft/types/**/*.d.ts"],
  }, null, 2)}\n`;
}

/** Every file of a new project, in the order init reports them. */
export function scaffold(o: ScaffoldOptions): TemplateFile[] {
  const version = o.version ?? CROFT_VERSION;
  const env = read("./project/env.example");
  return [
    { path: "croft.json", text: croftJson(o) },
    { path: "package.json", text: packageJson({ version }) },
    { path: "tsconfig.json", text: tsconfigJson() },
    { path: ".gitignore", text: read("./project/gitignore") },
    { path: ".env", text: env, mode: 0o600 },
    { path: ".env.example", text: env },
    { path: CLAUDE_MD, text: claudeBlock("project") },
    { path: SKILL_PATH, text: skillMd(version) },
    { path: "assets/example_sales.ts", text: read("./project/assets/example_sales.ts") },
    { path: "files/example_sales.csv", text: read("./project/files/example_sales.csv") },
  ];
}

/** The .gitignore patterns croft needs, for merging into an existing .gitignore. */
export function gitignorePatterns(): string[] {
  return read("./project/gitignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}
