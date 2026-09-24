// The command registry. Add each new command here; help and did-you-mean read this list.
//
// A command is registered with lazyCommand(spec, loader): the spec (name, summary, usage, options) is
// all that help, --help, flag parsing and did-you-mean need, and main.ts imports the command's module
// only to run it. So a module that cannot load, because the DuckDB binding is missing or built for
// another machine, fails its own command and nothing else (§2 "Install-time failures"). A module that
// imports db/* belongs here as a lazy entry and exports a CommandImpl (run and human).
//
// docs, help and version are imported directly: they are tiny, import nothing heavy, and are what a
// broken install still has to answer with. A test (commands/registry.test.ts) loads this registry with
// @duckdb/node-api made unloadable.
import { lazyCommand, type Command } from "../command.ts";
import { docs } from "./docs.ts";
import { help } from "./help.ts";
import { version } from "./version.ts";

const init = lazyCommand({
  name: "init",
  summary: "create a croft project (or data/ inside an existing app); --claude refreshes the Claude files",
  usage: "croft init [dir] [--claude] [--no-install]",
  options: {
    claude: { type: "boolean", description: "only refresh CLAUDE.md's croft block and .claude/skills/croft/SKILL.md" },
    "no-install": { type: "boolean", description: "do not run bun install (the project needs it before its first run)" },
  },
  maxPositionals: 1,
}, async () => (await import("./init.ts")).init);

const doctor = lazyCommand({
  name: "doctor",
  summary: "check the environment and the project: Bun, DuckDB, the warehouse, storage, Claude files",
  usage: "croft doctor",
  options: {},
  maxPositionals: 0,
  humanShowsProblems: true,
}, async () => (await import("./doctor.ts")).doctor);

const run = lazyCommand({
  name: "run",
  summary: "update assets and the stale transforms downstream (off a terminal the run detaches; croft wait follows it)",
  usage: "croft run [selector…] [--dry-run] [--only] [--upstream] [--from <date|ISO|-90d>] [--allow-shrink] [--foreground] [--follow 100s] [--no-wait] [--events]",
  options: {
    "dry-run": { type: "boolean", description: "show what would run and why (windows, confirmations) without running; reads only runs.sqlite and never waits" },
    only: { type: "boolean", description: "run only the named assets, not the stale assets downstream of them" },
    upstream: { type: "boolean", description: "also refresh the stale assets the named ones read, first" },
    from: { type: "string", value: "<when>", description: "backfill a merge ingest from a date, an ISO time or a relative value (-90d, -12h, today)" },
    "allow-shrink": { type: "boolean", description: "override SHRINK_GUARD for one replace ingest: the current rows go to the trash first, after confirmation" },
    foreground: { type: "boolean", description: "run in this process even off a terminal (no detaching)" },
    follow: { type: "string", value: "<dur>", description: "off a terminal: how long to follow the detached run before returning exit 6 (default 100s)" },
    "no-wait": { type: "boolean", description: "exit 4 at once when an asset or the database is busy, instead of waiting" },
    events: { type: "boolean", description: "NDJSON progress events on stderr" },
    "run-id": { type: "string", value: "<id>", hidden: true, description: "the run id a detached run was given (set by croft)" },
    detached: { type: "boolean", hidden: true, description: "marks the detached child of a run (set by croft)" },
    // No option carries a confirmation token: only `croft confirm <token>` carries one out (§6), handing it
    // to run in-process (main.ts Dispatch), never on a command line.
  },
}, async () => (await import("./run.ts")).run);

const wait = lazyCommand({
  name: "wait",
  summary: "block until a detached run ends; exit 6 if it is still running",
  usage: "croft wait <run-id> [--timeout 100s]",
  options: {
    timeout: { type: "string", value: "<dur>", description: "how long to wait before returning exit 6 (default 100s)" },
    events: { type: "boolean", description: "NDJSON progress events on stderr" },
  },
  maxPositionals: 1,
}, async () => (await import("./wait.ts")).wait);

const secrets = lazyCommand({
  name: "secrets",
  summary: "list declared secrets as set or missing; set writes one to .env from a hidden prompt or stdin",
  usage: "croft secrets | croft secrets set NAME [--stdin]",
  options: {
    stdin: { type: "boolean", description: "with set: read the value from stdin (for piping from a password manager)" },
  },
  maxPositionals: 2,
}, async () => (await import("./secrets.ts")).secrets);

const context = lazyCommand({
  name: "context",
  summary: "the whole project in one payload, for agents (capped at 20 KB)",
  usage: "croft context [--asset NAME]...",
  options: {
    asset: { type: "string", multiple: true, value: "NAME", description: "only this asset (repeatable)" },
  },
  maxPositionals: 0,
}, async () => (await import("./context.ts")).context);

const status = lazyCommand({
  name: "status",
  summary: "freshness and health of every asset, and running runs; never waits on the database",
  usage: "croft status [--check]",
  options: {
    check: { type: "boolean", description: "exit 1 when anything is failed, crashed, held or stale (a health probe)" },
  },
  maxPositionals: 0,
}, async () => (await import("./status.ts")).status);

const describe = lazyCommand({
  name: "describe",
  summary: "one asset: behavior in words, columns, JSON keys, checks, cursor, recent writes, samples",
  usage: "croft describe <asset> [--full-values]",
  options: {
    "full-values": { type: "boolean", description: "show whole sample values instead of cutting them at 80 characters" },
  },
  maxPositionals: 1,
}, async () => (await import("./describe.ts")).describe);

const query = lazyCommand({
  name: "query",
  summary: "one SELECT against the warehouse (read-only, sandboxed; 50 rows unless --limit)",
  usage: `croft query "<sql>" [--limit N] [--full-values]`,
  options: {
    limit: { type: "string", value: "N", description: "rows to show (default 50)" },
    "full-values": { type: "boolean", description: "show whole values instead of cutting them at 80 characters" },
    preview: { type: "boolean", description: "query the preview database that croft preview built (.croft/preview.duckdb) instead of the warehouse" },
  },
  maxPositionals: 1,
}, async () => (await import("./query.ts")).query);

const validate = lazyCommand({
  name: "validate",
  summary: "static checks and a bind check of every SQL asset (with its output columns); never touches the warehouse",
  usage: "croft validate [asset…] [--types]",
  options: {
    types: { type: "boolean", description: "also type-check the project's TypeScript with its own tsc --noEmit" },
  },
  humanShowsProblems: true,
}, async () => (await import("./validate.ts")).validate);

const preview = lazyCommand({
  name: "preview",
  summary: "build assets in a sandbox and diff them against the live tables; changes nothing real",
  usage: "croft preview <asset…> [--rows N] [--rebuild]",
  options: {
    rows: { type: "string", value: "N", description: "the input rows a TS transform receives, and the rows an ingest fetches (default 1000)" },
    rebuild: { type: "boolean", description: "build from scratch and compare with the live table (finds incremental drift and out-of-band edits)" },
  },
}, async () => (await import("./preview.ts")).preview);

const logs = lazyCommand({
  name: "logs",
  summary: "console output and errors of a step; --runs lists past runs and steps",
  usage: "croft logs [asset|run-id] [--failed] [--runs] [--follow] [--lines N]",
  options: {
    failed: { type: "boolean", description: "only failed, crashed or interrupted steps" },
    runs: { type: "boolean", description: "list runs and their steps instead of log text" },
    follow: { type: "boolean", description: "keep printing a running step's output until it ends" },
    lines: { type: "string", value: "N", description: "how many of the last lines to show (default 200)" },
  },
  maxPositionals: 1,
}, async () => (await import("./logs.ts")).logs);

const confirm = lazyCommand({
  name: "confirm",
  summary: "carry out a destructive action whose impact was printed; only after the user said yes",
  usage: "croft confirm <token>",
  options: {},
  maxPositionals: 1,
}, async () => (await import("./confirm.ts")).confirm);

export const COMMANDS: readonly Command[] = [
  docs, help, version, init, doctor, validate, preview, run, wait, status, query, describe, context, logs, secrets, confirm,
];
