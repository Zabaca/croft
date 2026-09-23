// The command contract. Each file in cli/commands/ exports one Command; main.ts parses flags,
// builds the Ctx, runs it and renders the result as an envelope (--json) or as human text.
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
}

export type OptionValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface Command<T = unknown> {
  name: string;
  summary: string;                   // one line for `croft help`
  usage: string;                     // e.g. "croft docs [topic|ERROR_CODE] | croft docs --list"
  options: Record<string, OptionSpec>;
  maxPositionals?: number;           // default: unlimited
  run(ctx: Ctx): Promise<CommandResult<T>>;
  /** Human output built from the (already redacted) result. Problems and next lines are printed
   *  after it by main.ts. Without it, data is printed as indented JSON. */
  human?(result: CommandResult<T>, ctx: Ctx): string | undefined;
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
