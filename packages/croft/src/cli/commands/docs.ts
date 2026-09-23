// croft docs: offline docs for the installed version (DESIGN.md §9). Pages live in
// src/agent/docs/<topic|CODE>.md and ship with the package; a code without a page gets a generated
// summary from the registry, so `croft docs CODE` always answers.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CODES, CroftError, EXIT, isCode, type Category, type Code } from "../../core/errors.ts";
import { laterConfigKey } from "../../core/phase.ts";
import { CONFIG_KEYS } from "../../project/root.ts";
import { didYouMean } from "../../project/suggest.ts";
import type { Command } from "../command.ts";
import { table } from "../render.ts";
import { CROFT_VERSION } from "../version.ts";

export const DOCS_DIR = fileURLToPath(new URL("../../agent/docs/", import.meta.url));

export const EXIT_MEANINGS: Record<number, string> = {
  [EXIT.OK]: "ok",
  [EXIT.FAILED]: "an asset failed, or status --check found something unhealthy",
  [EXIT.INVALID]: "invalid project or usage",
  [EXIT.CHECKS_FAILED]: "blocking checks failed, and nothing else failed",
  [EXIT.BUSY]: "busy (lock or lease wait exceeded)",
  [EXIT.NEEDS_HUMAN]: "needs a human (confirmation or a human-only step)",
  [EXIT.STILL_RUNNING]: "still running (detached run, wait)",
  [EXIT.INTERRUPTED]: "interrupted",
};

export const CATEGORIES: Record<Category, { meaning: string; todo: string }> = {
  project: {
    meaning: "the project has a mistake in an asset file, croft.json or the command line",
    todo: "Fix the file or command the problem names (apply its fix when there is one), then run the command again. croft context --json lists the problems of every asset file without running anything.",
  },
  run: {
    meaning: "a step failed while it ran",
    todo: "The problem's effect says what was and was not written. Read croft logs <asset> --failed, fix the cause, then croft run <asset> again.",
  },
  coordination: {
    meaning: "another process holds the database or the asset",
    todo: "Wait and retry; croft status shows what is running. retryable says whether the same command can simply be run again.",
  },
  safety: {
    meaning: "a human has to decide",
    todo: "Show the user the printed impact. Run croft confirm <token> only after their explicit yes in this conversation.",
  },
  environment: {
    meaning: "the machine or install needs attention",
    todo: "Run croft doctor for the full picture and the fix.",
  },
  warning: {
    meaning: "nothing is blocked; the command still did its work",
    todo: "Read the message; the hint says how to address it or make it go away.",
  },
};

interface Topic { summary: string; page(): string }

const BUILT_IN: Record<string, Topic> = {
  "claude-permissions": { summary: "suggested Claude Code permission rules for croft", page: claudePermissionsPage },
  config: { summary: "croft.json keys, types and defaults", page: configPage },
  errors: { summary: "how problems work: codes, hints, fixes and categories", page: errorsPage },
  "exit-codes": { summary: "what each exit code means", page: exitCodesPage },
  internals: { summary: "croft's own tables in the warehouse and in .croft/runs.sqlite", page: internalsPage },
  json: { summary: "the --json envelope every command prints", page: jsonPage },
  secrets: { summary: ".env: where secrets come from, what is ignored, redaction", page: secretsPage },
};

export interface TopicEntry { name: string; summary: string; source: "file" | "built-in" }
export interface CodeEntry { code: string; category: Category; severity: string; exit: number }
export type DocsData =
  | { topics: TopicEntry[]; codes: CodeEntry[] }
  | { topic: string; source: "file" | "built-in"; page: string }
  | { code: string; category: Category; severity: string; exit: number; exitMeaning: string; source: "file" | "generated"; page: string };

/** The docs command reading pages from `dir` (tests point it at a fixture folder). */
export function docsCommand(dir = DOCS_DIR): Command<DocsData> {
  const files = () => listPages(dir);
  const topics = (): TopicEntry[] => {
    const out = new Map<string, TopicEntry>();
    for (const [name, t] of Object.entries(BUILT_IN)) out.set(name, { name, summary: t.summary, source: "built-in" });
    for (const [name, path] of files()) {
      if (!isCode(name)) out.set(name, { name, summary: summaryOf(readFileSync(path, "utf8")), source: "file" });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  return {
    name: "docs",
    summary: "offline docs for this version: topics and error codes",
    usage: "croft docs [topic|ERROR_CODE] | croft docs --list",
    options: { list: { type: "boolean", description: "list every topic and every error code with its category and severity" } },
    maxPositionals: 1,
    async run(ctx) {
      const want = ctx.positionals[0];
      if (ctx.values.list || want === undefined) {
        const codes = (Object.entries(CODES) as [Code, (typeof CODES)[Code]][])
          .map(([code, info]) => ({ code, category: info.category, severity: info.severity, exit: info.exit }));
        return { data: { topics: topics(), codes }, problems: [], next: [] };
      }

      const code = want.toUpperCase();
      if (isCode(code)) {
        const info = CODES[code];
        const path = files().get(code);
        return {
          data: {
            code, category: info.category, severity: info.severity, exit: info.exit, exitMeaning: EXIT_MEANINGS[info.exit] ?? "",
            source: path ? "file" : "generated", page: path ? readFileSync(path, "utf8").trim() : generatedCodePage(code),
          },
          problems: [], next: [],
        };
      }

      const name = want.toLowerCase();
      const path = files().get(name);
      if (path) return { data: { topic: name, source: "file", page: readFileSync(path, "utf8").trim() }, problems: [], next: [] };
      const builtIn = BUILT_IN[name];
      if (builtIn) return { data: { topic: name, source: "built-in", page: builtIn.page() }, problems: [], next: [] };

      const known = [...topics().map((t) => t.name), ...Object.keys(CODES)];
      const guess = didYouMean(want, known);
      throw new CroftError("USAGE_ERROR", {
        message: `no docs page "${want}"`,
        hint: guess ? `did you mean "croft docs ${guess}"?` : "croft docs --list shows every topic and error code",
        fix: guess
          ? { kind: "command", description: `read ${guess}`, command: `croft docs ${guess}` }
          : { kind: "command", description: "list the topics and codes", command: "croft docs --list" },
      });
    },
    human(result, ctx) {
      const s = ctx.render.style;
      const d = result.data;
      if ("topics" in d) {
        const topicTable = table(["TOPIC", "ABOUT"], d.topics.map((t) => [t.name, t.summary]), { limit: Infinity, maxWidth: 120, indent: "  " });
        const codeTable = table(["CODE", "CATEGORY", "SEVERITY", "EXIT"], d.codes.map((c) => [c.code, c.category, c.severity, c.exit]),
          { limit: Infinity, indent: "  " });
        return [
          s.bold("Topics") + "  (croft docs <topic>)", topicTable.text, "",
          s.bold("Error codes") + "  (croft docs <CODE>)", codeTable.text,
        ].join("\n");
      }
      if ("code" in d) {
        return [
          s.bold(d.code),
          `  category  ${d.category} (${CATEGORIES[d.category].meaning})`,
          `  severity  ${d.severity}`,
          `  exit      ${d.exit} (${d.exitMeaning})`,
          "",
          d.page,
        ].join("\n");
      }
      return d.page;
    },
  };
}

export const docs = docsCommand();

function listPages(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;                                                     // no docs folder in this build
  }
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const base = f.slice(0, -3);
    out.set(isCode(base) ? base : base.toLowerCase(), join(dir, f));
  }
  return out;
}

function summaryOf(markdown: string): string {
  const first = markdown.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l !== "") ?? "";
  return first.length > 100 ? `${first.slice(0, 99)}…` : first;
}

export function generatedCodePage(code: Code): string {
  const info = CODES[code];
  const cat = CATEGORIES[info.category];
  return [
    `${code} is ${info.severity === "warning" ? "a" : "an"} ${info.severity} in the ${info.category} category (${cat.meaning}).`,
    `croft ${CROFT_VERSION} has no detailed page for it yet. Every ${code} problem carries a message, a hint (the`,
    "literal next command or edit) and, where croft can express it, a machine-applicable fix: run the command",
    "again with --json and read problems[].",
    "",
    `What to do: ${cat.todo}`,
  ].join("\n");
}

function configPage(): string {
  // Keys a later phase's feature reads are accepted and validated now, and said to do nothing yet
  // (core/phase.ts), rather than described as if the feature were here.
  const now = CONFIG_KEYS.filter((k) => !laterConfigKey(k.key));
  const later = CONFIG_KEYS.flatMap((k) => {
    const l = laterConfigKey(k.key);
    return l ? [[k.key, k.type, k.default, `not used by this version (for ${l.feature}, in a later version)`]] : [];
  });
  return [
    "# croft.json",
    "",
    "Project settings, read without running any code. Unknown keys are errors (with a did-you-mean).",
    "",
    table(["KEY", "TYPE", "DEFAULT", "MEANING"], [...now.map((k) => [k.key, k.type, k.default, k.description]), ...later],
      { limit: Infinity, maxWidth: 140 }).text,
    "",
    "Example:",
    '  {"$schema": "./node_modules/@zabaca/croft/croft.schema.json", "database": "warehouse.duckdb",',
    '   "timezone": "America/Los_Angeles"}',
    "",
    "When the project sits in a synced folder (iCloud ~/Documents or ~/Desktop, Dropbox, OneDrive, network",
    "drives, WSL /mnt/<drive>), croft moves the database and .croft/ to ~/.local/share/croft/<project>-<hash>/",
    "and records the new paths in database and stateDir. Asset files stay in the project folder.",
  ].join("\n");
}

function errorsPage(): string {
  const cats = (Object.keys(CATEGORIES) as Category[]).map((c) => {
    const n = Object.values(CODES).filter((i) => i.category === c).length;
    return [c, String(n), CATEGORIES[c].meaning];
  });
  return [
    "# Problems and error codes",
    "",
    "Every problem croft reports has a severity (error, warning or info), a stable code, a message, a hint (the",
    "literal next command or edit) and a docs pointer (croft docs CODE). Where they apply it also has asset,",
    "file, line, column, runId, a machine-applicable fix, an effect (what was and was not written), retryable",
    "and details.",
    "",
    "fix is one of:",
    '  {kind: "edit", description, file, line?, replace?: {from, to}, insert?}',
    '  {kind: "command", description, command, requiresHuman?}',
    '  {kind: "manual", description, requiresHuman?}',
    "",
    table(["CATEGORY", "CODES", "MEANING"], cats, { limit: Infinity, maxWidth: 120 }).text,
    "",
    ...(Object.keys(CATEGORIES) as Category[]).map((c) => `${c}: ${CATEGORIES[c].todo}`),
    "",
    "croft docs --list lists every code; croft docs exit-codes explains exit statuses.",
  ].join("\n");
}

function exitCodesPage(): string {
  return [
    "# Exit codes",
    "",
    table(["CODE", "MEANING"], Object.entries(EXIT_MEANINGS).map(([k, v]) => [k, v]), { limit: Infinity, maxWidth: 120 }).text,
    "",
    "Precedence: 1 if anything other than a check failed; 3 only when every failure is CHECK_FAILED; 6 while a",
    "detached run is still going; 5 when the only outcome is a pending confirmation.",
    "In --json, ok means the command itself worked (status exits 0 even when an asset is unhealthy; status --check",
    "exits 1 and data.healthy carries health).",
  ].join("\n");
}

function jsonPage(): string {
  return [
    "# The --json envelope",
    "",
    "Every command takes --json and prints exactly one JSON object on stdout; progress and logs go to stderr.",
    "",
    "  {schemaVersion: 1, ok, command, croftVersion, database, timezone, durationMs, data, problems[], next[],",
    "   confirmation?}",
    "",
    "- ok: the command itself did what it was asked. For run it is false when any asset failed.",
    "- problems[]: see croft docs errors.",
    "- next[]: [{command, reason}]. A destructive command never appears in next; it comes only as",
    "  confirmation: {token, expiresAt, command, impact}. Ask the user before running croft confirm.",
    "- Timestamps are ISO-8601 with the project offset (2026-09-21T22:00:00-07:00), so they agree with ::DATE",
    "  in SQL. Durations are milliseconds.",
    "- HUGEINT, DECIMAL and integers beyond ±2^53 are strings, inside JSON columns too.",
    "- Every value found in .env is replaced with [redacted:NAME] in messages. In data (query rows) only declared",
    "  secrets and credential-looking values are replaced, and data then carries redactedValues: true.",
    "- Outside a project, database is \"\" and timezone is this machine's zone.",
  ].join("\n");
}

function secretsPage(): string {
  return [
    "# Secrets",
    "",
    "croft reads secrets from <project>/.env itself; Bun's automatic .env loading is off.",
    "",
    "- A variable set in the shell environment wins over .env (an empty one does not).",
    "- .env.local and other .env.* files are ignored, with the warning ENV_FILE_IGNORED.",
    "  (.env.example, .env.sample and .env.template are templates and are not reported.)",
    "- An asset lists the names it needs in secrets: [\"STRIPE_KEY\"] and reads them with ctx.secret(\"STRIPE_KEY\").",
    "  Other names are refused, and a missing value is SECRET_MISSING. Values never go into process.env.",
    "- Every .env value of 4 or more characters is replaced with [redacted:NAME] in croft's messages and logs.",
    "  In command data (query rows, samples) only declared secrets and values that look like credentials",
    "  (8+ characters, not only letters or only digits) are replaced, so PORT=5432 or LOG_LEVEL=info do not",
    "  rewrite ordinary values; data that had a value replaced carries redactedValues: true.",
    "- croft secrets --json lists each declared name as set or missing, where it came from, and which assets",
    "  use it, without printing values.",
    "",
    ".env syntax: KEY=value per line; # comments (inside an unquoted value only after a space); an optional",
    "export prefix; 'single' and `backtick` quotes are literal; \"double\" quotes understand \\n \\r \\t \\\" \\\\;",
    "quoted values may span lines. There is no ${VAR} expansion.",
    "",
    "Agents: never read .env. Ask the user to add NAME=... to .env, or to run croft secrets set NAME in",
    "their own terminal.",
  ].join("\n");
}

function claudePermissionsPage(): string {
  return [
    "# Claude Code permissions",
    "",
    "croft init does not write .claude/settings.json: permission rules change what Claude Code may do without",
    "asking, so they stay your decision. Every destructive croft action ends in croft confirm, so one ask rule",
    "gates all of them. The deny rules keep .env out of the agent's reach.",
    "",
    "Suggested .claude/settings.json (or .claude/settings.local.json for just you):",
    "",
    "  {",
    '    "permissions": {',
    '      "ask": ["Bash(croft confirm:*)"],',
    '      "deny": ["Read(./.env)", "Read(./.env.*)"]',
    "    }",
    "  }",
  ].join("\n");
}

function internalsPage(): string {
  return [
    "# Internals",
    "",
    "Data-coupled state lives in the warehouse, schema _croft, and commits with the data it describes:",
    "",
    "  _croft.meta      format_version, duckdb_version, croft_version",
    "  _croft.assets    one row per asset: kind, write mode, key, code and behavior hashes, cursor, row count",
    "  _croft.columns   column types, source names, pins, pending retypes, JSON kinds",
    "  _croft.inputs    what each transform has seen of each input (composite positions)",
    "  _croft.files     files a file ingest has loaded (size, mtime, ETag, sha256)",
    "  _croft.writes    one row per write: maps any row's _loaded_at to the run that wrote it",
    "",
    "Observability and coordination state lives in .croft/runs.sqlite and stays readable while the",
    "warehouse is locked: runs, steps, leases, lock_holder, lock_waiters, schedule_state, tick,",
    "confirmations and catalog (a mirror of _croft; the warehouse wins).",
    "",
    "Never write to either by hand; query _croft tables with croft query.",
  ].join("\n");
}
