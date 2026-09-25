// JSON Schemas of every --json output (DESIGN.md §4.3: "Data shapes are frozen by golden tests and published as
// JSON Schemas"): the envelope, and the envelope of each command with that command's data. They ship in the package
// as schemas/envelope.schema.json and schemas/<command>.schema.json (draft 2020-12).
//
// The schemas are generated, never written by hand: scripts/build-schemas.ts reads the TypeScript types below with
// the compiler (the envelope of core/types.ts, and the data type each command module declares as CommandImpl<T>)
// and writes them. A test fails when the committed files differ from what it writes, so a changed data shape
// changes its schema in the same commit (`bun scripts/build-schemas.ts` from packages/croft), and the golden tests
// (tests/golden) run every command's --json and validate the envelope against its schema.
//
// This module is what croft itself reads at run time: it imports only types from the command modules, so it loads
// nothing heavy, and schemaFor() reads the shipped files.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CroftError } from "../core/errors.ts";
import type { Envelope } from "../core/types.ts";
import { didYouMean } from "../project/suggest.ts";
import type { Command, CommandImpl } from "./command.ts";
import type { confirm } from "./commands/confirm.ts";
import type { context } from "./commands/context.ts";
import type { del } from "./commands/delete.ts";
import type { describe } from "./commands/describe.ts";
import type { docs } from "./commands/docs.ts";
import type { doctor } from "./commands/doctor.ts";
import type { help } from "./commands/help.ts";
import type { init } from "./commands/init.ts";
import type { logs } from "./commands/logs.ts";
import type { newAsset } from "./commands/new.ts";
import type { preview } from "./commands/preview.ts";
import type { query } from "./commands/query.ts";
import type { rename } from "./commands/rename.ts";
import type { restore } from "./commands/restore.ts";
import type { run } from "./commands/run.ts";
import type { schedule } from "./commands/schedule.ts";
import type { secrets } from "./commands/secrets.ts";
import type { serve } from "./commands/serve.ts";
import type { status } from "./commands/status.ts";
import type { validate } from "./commands/validate.ts";
import type { version } from "./commands/version.ts";
import type { wait } from "./commands/wait.ts";

/** The data type a command module declares: `CommandImpl<T>` or `Command<T>` gives T. */
export type DataOf<C> = C extends Command<infer T> ? T : C extends CommandImpl<infer T> ? T : never;

/**
 * Each command's `data` in its --json envelope, as its module declares it. scripts/build-schemas.ts turns every
 * property into schemas/<command>.schema.json. The hidden `tick` has none: croft runs it, an agent never does.
 * A command whose module still declares no data type (`CommandImpl` alone) gets data of any shape.
 */
export interface CommandData {
  init: DataOf<typeof init>;
  doctor: DataOf<typeof doctor>;
  docs: DataOf<typeof docs>;
  help: DataOf<typeof help>;
  version: DataOf<typeof version>;
  secrets: DataOf<typeof secrets>;
  context: DataOf<typeof context>;
  status: DataOf<typeof status>;
  describe: DataOf<typeof describe>;
  query: DataOf<typeof query>;
  logs: DataOf<typeof logs>;
  run: DataOf<typeof run>;
  wait: DataOf<typeof wait>;
  confirm: DataOf<typeof confirm>;
  validate: DataOf<typeof validate>;
  preview: DataOf<typeof preview>;
  schedule: DataOf<typeof schedule>;
  serve: DataOf<typeof serve>;
  rename: DataOf<typeof rename>;
  delete: DataOf<typeof del>;
  restore: DataOf<typeof restore>;
  new: DataOf<typeof newAsset>;
}

/** The envelope every command prints, whatever its data (schemas/envelope.schema.json). */
export type AnyEnvelope = Envelope<unknown>;

/** The commands with a schema, in the order of CommandData. */
export const SCHEMA_COMMANDS = [
  "init", "doctor", "docs", "help", "version", "secrets", "context", "status", "describe", "query", "logs",
  "run", "wait", "confirm", "validate", "preview", "schedule", "serve", "rename", "delete", "restore", "new",
] as const satisfies readonly (keyof CommandData)[];

export type SchemaCommand = (typeof SCHEMA_COMMANDS)[number];

// Every key of CommandData is listed above: a key left out makes this a type error.
type OnlyNever<T extends never> = T;
export type UnlistedCommands = OnlyNever<Exclude<keyof CommandData, SchemaCommand>>;

/** Where the schema files are: schemas/ next to src/ in this package (shipped with it). */
export const SCHEMAS_DIR = fileURLToPath(new URL("../../schemas/", import.meta.url));

/** The file of a command's schema, or of the envelope's: relative to the package root. */
export function schemaFile(name: SchemaCommand | "envelope"): string {
  return `schemas/${name}.schema.json`;
}

export function isSchemaCommand(name: string): name is SchemaCommand {
  return (SCHEMA_COMMANDS as readonly string[]).includes(name);
}

/** The JSON Schema of `croft <command> --json`'s envelope with that command's data. */
export function schemaFor(command: string): Record<string, unknown> {
  if (!isSchemaCommand(command)) {
    const guess = didYouMean(command, SCHEMA_COMMANDS);
    throw new CroftError("USAGE_ERROR", {
      message: `no JSON Schema for "${command}": it is not a croft command with --json output`,
      hint: guess ? `did you mean "${guess}"?` : `the commands with a schema: ${SCHEMA_COMMANDS.join(", ")}`,
      fix: { kind: "manual", description: guess ? `ask for the schema of ${guess}` : "name one of the commands croft help lists" },
    });
  }
  return readSchema(command);
}

/** The JSON Schema of the envelope every command prints, with data of any shape. */
export function envelopeSchema(): Record<string, unknown> {
  return readSchema("envelope");
}

function readSchema(name: SchemaCommand | "envelope"): Record<string, unknown> {
  const path = `${SCHEMAS_DIR}${name}.schema.json`;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new CroftError("INSTALL_FAILED", {
      message: `croft's JSON Schema ${schemaFile(name)} cannot be read: ${(e as Error).message}`,
      hint: "this croft install lacks its schemas/ folder; reinstall the project's packages (rm -rf node_modules && bun install)",
      fix: { kind: "command", description: "reinstall the project's packages", command: "rm -rf node_modules && bun install", requiresHuman: true },
    });
  }
}
