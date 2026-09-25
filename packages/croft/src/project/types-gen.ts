// Generated input types (DESIGN.md §11 phase 5): .croft/types/<asset>.d.ts per asset, from the catalog's columns,
// so TS transforms get checked row types and `croft validate --types` catches a renamed column. Phase 5 contract
// stub: its builder (TY) replaces this.
import { phaseStub } from "../core/phase.ts";

export interface TypesResult {
  /** The folder written: <state>/types. */
  dir: string;
  /** Assets with a generated type. */
  assets: string[];
}

/** Write .croft/types from the catalog mirror. Cheap; imports no asset code. */
export function generateInputTypes(root: string): TypesResult {
  return phaseStub(`generateInputTypes(${root})`);
}
