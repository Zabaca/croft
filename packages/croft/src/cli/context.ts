// The Ctx handed to every command. Everything that touches the disk is lazy, so `croft --version`
// and `croft docs` work outside a project and never read .env unless output needs redacting.
import { now, systemTimeZone } from "../core/time.ts";
import { ProjectEnv } from "../project/env.ts";
import { findRoot, loadProject, notFound, type Project } from "../project/root.ts";
import type { Command, Ctx, OptionValues } from "./command.ts";
import type { Redactor, Render } from "./render.ts";

export interface ContextInit {
  cwd: string;
  processEnv: Record<string, string | undefined>;
  render: Render;
  isTTY: { stdin: boolean; stdout: boolean };
  commands: readonly Command[];
  startedAt: number;
}

export class CliContext implements Ctx {
  command = "";
  argv: readonly string[] = [];
  values: OptionValues = {};
  positionals: readonly string[] = [];
  readonly cwd: string;
  readonly processEnv: Record<string, string | undefined>;
  readonly render: Render;
  readonly isTTY: { readonly stdin: boolean; readonly stdout: boolean };
  readonly commands: readonly Command[];
  readonly startedAt: number;
  #root: string | null | undefined;
  #project: { value: Project | null } | { error: unknown } | undefined;
  #env: ProjectEnv | undefined;

  constructor(init: ContextInit) {
    this.cwd = init.cwd;
    this.processEnv = init.processEnv;
    this.render = init.render;
    this.isTTY = init.isTTY;
    this.commands = init.commands;
    this.startedAt = init.startedAt;
  }

  get json(): boolean {
    return this.render.json;
  }

  /** The project folder, found without validating croft.json (so .env still loads when it is broken). */
  get root(): string | null {
    if (this.#root === undefined) this.#root = findRoot(this.cwd);
    return this.#root;
  }

  findProject(): Project | null {
    if (!this.#project) {
      try {
        this.#project = { value: this.root ? loadProject({ root: this.root }) : null };
      } catch (error) {
        this.#project = { error };
      }
    }
    if ("error" in this.#project) throw this.#project.error;
    return this.#project.value;
  }

  get project(): Project {
    const p = this.findProject();
    if (!p) throw notFound(this.cwd);
    return p;
  }

  get env(): ProjectEnv {
    this.#env ??= ProjectEnv.load(this.root, this.processEnv);
    return this.#env;
  }

  now(): Date {
    return now(this.processEnv);
  }

  #redactor: Redactor | undefined;

  /** Redaction for output, loading .env on first use: free text through ProjectEnv.redact, command data
   *  through its narrower redactData. Best effort: an unreadable .env cannot leak through croft either. */
  redactor(): Redactor {
    if (!this.#redactor) {
      try {
        const env = this.env;
        this.#redactor = Object.assign((text: string) => env.redact(text), { data: (text: string) => env.redactData(text) });
      } catch {
        this.#redactor = (text) => text;
      }
    }
    return this.#redactor;
  }

  /** database and timezone for the envelope; empty database and this machine's zone outside a project. */
  envelopeMeta(): { database: string; timezone: string } {
    try {
      const p = this.findProject();
      if (p) return { database: p.databaseLabel, timezone: p.timezone };
    } catch {
      // A broken croft.json is reported by the command itself; the envelope still goes out.
    }
    return { database: "", timezone: systemTimeZone() };
  }
}
