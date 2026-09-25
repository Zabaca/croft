// JSON Schemas of every --json output (DESIGN.md §4.3): the envelope and each command's data, published in the
// package (schemas/) and golden-tested. Phase 5 contract stub: its builder (DC) replaces this.
import { phaseStub } from "../core/phase.ts";

/** The JSON Schema of `croft <command> --json`'s envelope with that command's data. */
export function schemaFor(command: string): Record<string, unknown> {
  return phaseStub(`schemaFor(${command})`);
}
