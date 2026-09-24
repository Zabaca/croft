// What this build ships (DESIGN.md §11 "Phases"), so the text croft gives an agent only names commands and
// flags that exist. DESIGN.md §4.1 describes all of v1; this build is phase 1 ("Load and look").
//
// - The command manifest below lists every command and run/query/init flag DESIGN.md §4.1 names, with the phase
//   that ships it. The registry (cli/commands/index.ts) must register exactly the commands of this phase and
//   no flag of a later one except `query --preview`, which is registered to refuse clearly (a test checks both).
// - SKILL.md renders its "This version" section from the manifest (agent/templates.ts), and a test scans
//   CLAUDE.md, SKILL.md, every `croft docs` page, and every string in the source (this file aside) for a
//   `croft <command>` or `--flag` this build does not have (agent/contract.test.ts).
// - When a phase lands: raise PHASE, register its commands, and add the skill text for them.
//
// Checks (below) are the other phase-1 honesty note: declared, listed by describe and context, and passed
// through to the write, but nothing evaluates them until phase 2. So the output says so, rather than let
// "Checks unique(id) · not_null(id)" read as a promise. To remove when phase 2 runs checks: delete
// CHECKS_ENFORCED and every use of it (grep CHECKS_ENFORCED): the `checksEnforced` field of run, wait,
// describe and context data, and the human lines in run.ts, describe.ts and context.ts.
//
// phaseStub() is what a module of the next wave throws until it is built: the contract commit gives each one
// its final signature, so builders code against it in parallel (the phase-2 execution spec). grep PHASE_STUB
// finds what is left.
import { CroftError } from "./errors.ts";

/** What an unbuilt stub throws: INTERNAL_ERROR with a message starting "PHASE_STUB". Its builder replaces the
 *  call with the real code. */
export function phaseStub(what: string): never {
  throw new CroftError("INTERNAL_ERROR", { message: `PHASE_STUB: ${what} is not built yet`, hint: "report this croft bug" });
}

/** The phase of DESIGN.md §11 this build implements. */
export const PHASE: number = 1;

/** Every command DESIGN.md §4.1 names (and the internal `tick`), with the phase that ships it. */
export const COMMAND_PHASE = {
  init: 1, doctor: 1, docs: 1, help: 1, version: 1, secrets: 1,
  context: 1, status: 1, describe: 1, query: 1, logs: 1,
  run: 1, wait: 1, confirm: 1,
  validate: 2, preview: 2,
  schedule: 3, serve: 3, tick: 3,
  rename: 4, delete: 4, restore: 4,
  new: 5,
} as const;

export type CommandName = keyof typeof COMMAND_PHASE;

/** Flags of this build's commands that DESIGN.md §4.1 gives them in a later phase. */
export const LATER_FLAGS: Partial<Record<CommandName, Record<string, number>>> = {
  run: { "dry-run": 2, only: 2, upstream: 2, rebuild: 4, due: 3 },
  query: { preview: 2 },
  init: { "with-hook": 5 },
};

/** croft.json keys that are accepted (and validated) now but read only by a later phase's feature. */
export const LATER_CONFIG_KEYS: readonly { prefix: string; phase: number; feature: string }[] = [
  { prefix: "readCopy", phase: 3, feature: "the read copy for GUIs" },
  { prefix: "notify.", phase: 3, feature: "failure notifications of scheduled runs" },
  { prefix: "serve.", phase: 3, feature: "the read server for apps" },
];

const names = Object.keys(COMMAND_PHASE) as CommandName[];

/** The commands this build has. */
export const SHIPPED_COMMANDS: readonly CommandName[] = names.filter((n) => COMMAND_PHASE[n] <= PHASE);
/** Commands DESIGN.md §4.1 names that this build does not have yet (tick is internal and left out). */
export const LATER_COMMANDS: readonly CommandName[] = names.filter((n) => COMMAND_PHASE[n] > PHASE && n !== "tick");

/** Whether `croft <name>` exists in this build. */
export function hasCommand(name: string): boolean {
  return Object.hasOwn(COMMAND_PHASE, name) && COMMAND_PHASE[name as CommandName] <= PHASE;
}

/** Whether a word is a croft command of any phase (so "croft is not dbt" is prose, "croft preview" is not). */
export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(COMMAND_PHASE, name);
}

/** Flags of `command` that a later phase adds (registered or not). */
export function laterFlags(command: string): string[] {
  const flags = isCommandName(command) ? LATER_FLAGS[command] : undefined;
  return flags ? Object.keys(flags).filter((f) => flags[f]! > PHASE) : [];
}

/** The later-phase feature a croft.json key belongs to, or null when this build reads the key. */
export function laterConfigKey(key: string): { phase: number; feature: string } | null {
  const hit = LATER_CONFIG_KEYS.find((k) => (k.prefix.endsWith(".") ? key.startsWith(k.prefix) : key === k.prefix));
  return hit && hit.phase > PHASE ? { phase: hit.phase, feature: hit.feature } : null;
}

/** What phase 1 does not do yet, in words, for SKILL.md. */
export const PHASE_LIMITS = [
  "It builds ingests only (API rows and files): .sql files and transform() assets are listed but skipped by",
  "croft run. Checks are listed but not enforced, and nothing runs on a schedule: assets run when you run them.",
];

/** SKILL.md's "This version" section: the commands that exist, the ones that do not, and what is not built.
 *  Rendered from the manifest, so it never names a command as available that the registry lacks. */
export function versionNotes(version: string): string {
  const flags = Object.keys(LATER_FLAGS).flatMap((c) => {
    const fs = laterFlags(c);
    return fs.length ? [`${c} ${fs.map((f) => `--${f}`).join("/")}`] : [];
  });
  return [
    `croft ${version} (phase ${PHASE}) has these commands: ${SHIPPED_COMMANDS.join(", ")}.`,
    `Not in this version, so never call them (each exits 2): ${[...LATER_COMMANDS, ...flags].join(", ")}.`,
    ...PHASE_LIMITS,
  ].join("\n");
}

/** Whether checks run. `checksEnforced` in run, describe and context JSON. */
export const CHECKS_ENFORCED = false as const;

/** The human line that says it. */
export const CHECKS_NOT_ENFORCED = "checks: not enforced until phase 2";
