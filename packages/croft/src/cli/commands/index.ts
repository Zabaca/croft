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
    preview: { type: "boolean", description: "query the preview database (comes with croft preview)" },
  },
  maxPositionals: 1,
}, async () => (await import("./query.ts")).query);

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

export const COMMANDS: readonly Command[] = [docs, help, version, init, doctor, secrets, context, status, describe, query, logs, confirm];
