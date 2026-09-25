// What this build ships (DESIGN.md §11 "Phases"), so the text croft gives an agent only names commands and
// flags that exist. DESIGN.md §4.1 describes all of v1; this build is phase 5 ("Agent-grade release").
//
// - The command manifest below lists every command, and each run, validate and init flag DESIGN.md §4.1 gives a
//   phase after 1, with the phase that ships it. The registry (cli/commands/index.ts) must register exactly the
//   commands of this phase and no flag of a later one (a test checks both).
// - A test scans CLAUDE.md, SKILL.md, every `croft docs` page, and every string in the source (this file aside)
//   for a `croft <command>` or `--flag` this build does not have (agent/contract.test.ts). Phases 1–4 shipped the
//   texts of DESIGN.md §9 cut to their commands, with a "This version" section in SKILL.md rendered from this
//   manifest; phase 5 has every command, and ships §9 word for word (agent/templates.test.ts).
// - When a phase lands: raise PHASE, register its commands, and add the skill text for them.
//
// phaseStub() is what a module of the next wave throws until it is built: the contract commit gives each one
// its final signature, so builders code against it in parallel (the phase execution spec). grep PHASE_STUB
// finds what is left.
import { CroftError } from "./errors.ts";

/** What an unbuilt stub throws: INTERNAL_ERROR with a message starting "PHASE_STUB". Its builder replaces the
 *  call with the real code. */
export function phaseStub(what: string): never {
  throw new CroftError("INTERNAL_ERROR", { message: `PHASE_STUB: ${what} is not built yet`, hint: "report this croft bug" });
}

/** The phase of DESIGN.md §11 this build implements. */
export const PHASE: number = 5;

/** Whether PHASE is finished. False while its waves are being built: its error codes may still be unraised
 *  (core/codes-raised.test.ts). Set to true when the phase ends; a release requires it. */
export const PHASE_COMPLETE: boolean = true;

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

/** Flags DESIGN.md §4.1 gives a phase after 1, by command, with that phase (laterFlags() keeps those after PHASE). */
export const LATER_FLAGS: Partial<Record<CommandName, Record<string, number>>> = {
  run: { "dry-run": 2, only: 2, upstream: 2, rebuild: 4, due: 3 },
  validate: { hook: 5 },
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

