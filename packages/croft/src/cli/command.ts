// The command contract. Each file in cli/commands/ exports one command: a CommandImpl (run, human) that
// cli/commands/index.ts registers lazily with its spec, or, for the few tiny ones, a whole Command.
// main.ts parses flags, loads and runs the command, and renders the result as an envelope (--json) or
// as human text.
import type { Confirmation, Problem } from "../core/types.ts";
import type { ProjectEnv } from "../project/env.ts";
import type { Project } from "../project/root.ts";
import type { Next, Render } from "./render.ts";

export type { Next } from "./render.ts";

export interface CommandResult<T = unknown> {
  data: T;
  problems: Problem[];
  next: Next[];
  exit?: number;                     // default: exitCodeFor(problems, { pendingConfirmation })
  ok?: boolean;                      // default: no error-severity problem
  confirmation?: Confirmation;
}

export interface OptionSpec {
  type: "boolean" | "string";
  short?: string;
  multiple?: boolean;
  description: string;
  value?: string;                    // placeholder in help, e.g. "N" for --rows N
  /** Set by croft itself (a detached run's --run-id and --detached): parsed like any option, but left out
   *  of help and never suggested by did-you-mean. Never consent: a confirmation travels only in-process
   *  (main.ts Dispatch), since any option can be typed. */
  hidden?: boolean;
}

export type OptionValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

/** What help, did-you-mean and flag parsing need to know about a command, without loading its module. */
export interface CommandSpec {
  name: string;
  summary: string;                   // one line for `croft help`
  usage: string;                     // e.g. "croft docs [topic|ERROR_CODE] | croft docs --list"
  options: Record<string, OptionSpec>;
  maxPositionals?: number;           // default: unlimited
  /** human() prints every problem itself, next to what it is about (doctor puts each under its section,
   *  §2), so main.ts does not append the standard problem blocks. Next lines are still appended. */
  humanShowsProblems?: boolean;
}

export interface Command<T = unknown> extends CommandSpec {
  run(ctx: Ctx): Promise<CommandResult<T>>;
  /** Human output built from the (already redacted) result. Problems (unless humanShowsProblems) and
   *  next lines are printed after it by main.ts. Without it, data is printed as indented JSON. */
  human?(result: CommandResult<T>, ctx: Ctx): string | undefined;
  /** Set on registry entries made by lazyCommand(): imports the module that implements the command.
   *  main.ts calls it only for the command it runs, after parsing flags. */
  load?(): Promise<Command<T>>;
}

/** What a lazily registered command's module exports: the spec lives in the registry. */
export type CommandImpl<T = unknown> = Pick<Command<T>, "run" | "human">;

/**
 * A registry entry that imports its module only when the command runs. A module that cannot load (a
 * missing or foreign-arch DuckDB binding, say) then fails that one command, while help, docs, doctor,
 * init and the launcher keep working. `spec` is the only description of the command: the module
 * supplies run() and human().
 */
export function lazyCommand<T>(spec: CommandSpec, load: () => Promise<CommandImpl<T>>): Command<T> {
  let loading: Promise<Command<T>> | undefined;
  const once = () => (loading ??= load().then(
    (impl) => ({ ...spec, run: impl.run.bind(impl), ...(impl.human ? { human: impl.human.bind(impl) } : {}) }),
    (e: unknown) => { loading = undefined; throw e; },
  ));
  return { ...spec, load: once, run: async (ctx) => (await once()).run(ctx) };
}

export interface Ctx {
  readonly command: string;
  readonly argv: readonly string[];  // arguments after the command name
  readonly values: OptionValues;
  readonly positionals: readonly string[];
  readonly json: boolean;
  readonly cwd: string;
  readonly processEnv: Record<string, string | undefined>;
  /** The project; loaded on first use. Throws PROJECT_NOT_FOUND outside a project, USAGE_ERROR for a bad croft.json. */
  readonly project: Project;
  /** The project, or null outside one (still throws for a bad croft.json). */
  findProject(): Project | null;
  /** Secrets from <root>/.env and the shell; loaded on first use. */
  readonly env: ProjectEnv;
  readonly render: Render;
  readonly isTTY: { readonly stdin: boolean; readonly stdout: boolean };
  readonly commands: readonly Command[];
  readonly startedAt: number;        // performance.now() at start
  /** The current time; honors CROFT_NOW. */
  now(): Date;
}
