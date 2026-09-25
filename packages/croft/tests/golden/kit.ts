// The golden tests' one assertion (DESIGN.md §4.3 "Data shapes are frozen by golden tests and published as JSON
// Schemas", §10 "Every --json output is golden-tested against its JSON Schema"): a command's stdout is exactly one
// envelope, it carries schemaVersion: 1, and it matches both the envelope schema and its command's schema
// (schemas/<command>.schema.json, read through schemaFor as croft ships it).
//
// The journeys run the real CLI through tests/e2e/harness.ts, so the envelopes are what an agent reads.
import { expect } from "bun:test";
import { envelopeSchema, type SchemaCommand, schemaFor } from "../../src/cli/schemas.ts";
import { type CliResult, type Envelope, show } from "../e2e/harness.ts";
import { validate } from "./validator.ts";

export interface GoldenOptions {
  /** The command is expected to fail before it has data (data null, ok false). */
  failed?: boolean;
  /** The exit code expected (default: 0, or whatever a failure exits with). */
  exit?: number;
}

/**
 * Assert that `r` printed one envelope of `command` matching its schema, and return it. By default the command
 * must have worked and exited 0 with data, so the schema is checked against a real payload, not an error.
 */
export function golden(command: SchemaCommand, r: CliResult, o: GoldenOptions = {}): Envelope {
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  expect(lines.length, `stdout holds exactly one envelope\n${show(r)}`).toBe(1);
  const env = JSON.parse(lines[0]!) as Envelope;
  expect(env.schemaVersion, `schemaVersion\n${show(r)}`).toBe(1);
  expect(env.command, show(r)).toBe(command);
  if (o.failed) {
    expect(env.ok, show(r)).toBe(false);
    expect(env.data, show(r)).toBeNull();
  } else {
    expect(env.data, `data\n${show(r)}`).not.toBeNull();
  }
  if (o.exit !== undefined || !o.failed) expect(r.code, show(r)).toBe(o.exit ?? 0);
  expect(validate(envelopeSchema(), env), `the envelope schema\n${show(r)}`).toEqual([]);
  expect(validate(schemaFor(command), env), `schemas/${command}.schema.json\n${show(r)}`).toEqual([]);
  return env;
}

/** The generic envelope schema alone: for an envelope whose command has no schema (an unknown command). */
export function goldenEnvelope(r: CliResult): Envelope {
  const env = JSON.parse(r.stdout) as Envelope;
  expect(env.schemaVersion, show(r)).toBe(1);
  expect(validate(envelopeSchema(), env), show(r)).toEqual([]);
  return env;
}
