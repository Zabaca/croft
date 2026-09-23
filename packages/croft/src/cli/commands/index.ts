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
  summary: "update assets: fetch ingests (off a terminal the run detaches; croft wait follows it)",
  usage: "croft run [selector…] [--from <date|ISO|-90d>] [--allow-shrink] [--foreground] [--follow 100s] [--no-wait] [--events]",
  options: {
    from: { type: "string", value: "<when>", description: "backfill a merge ingest from a date, an ISO time or a relative value (-90d, -12h, today)" },
    "allow-shrink": { type: "boolean", description: "override SHRINK_GUARD for one replace ingest: the current rows go to the trash first, after confirmation" },
    foreground: { type: "boolean", description: "run in this process even off a terminal (no detaching)" },
    follow: { type: "string", value: "<dur>", description: "off a terminal: how long to follow the detached run before returning exit 6 (default 100s)" },
    "no-wait": { type: "boolean", description: "exit 4 at once when an asset or the database is busy, instead of waiting" },
    events: { type: "boolean", description: "NDJSON progress events on stderr" },
    "run-id": { type: "string", value: "<id>", description: "internal: the run id a detached run was given" },
    detached: { type: "boolean", description: "internal: marks the detached child of a run" },
    "confirm-token": { type: "string", value: "<token>", description: "internal: set by croft confirm" },
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

export const COMMANDS: readonly Command[] = [docs, help, version, init, doctor, run, wait];
