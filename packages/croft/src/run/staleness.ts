// Staleness (DESIGN.md §5 "Versions, staleness and atomicity", §8 "What a code change does"): why an asset
// would run in a bare `croft run`, from the catalog mirror alone (no DuckDB lock), and the warning for an
// asset edited since it last ran.
//
// A transform is stale when it was never built (never_built), when an input changed since it last read all
// of it (input_changed: the input's lastLoadedAt is newer than InputSeen.inputLastLoadedAt, that is null, or
// the input has no InputSeen entry at all; an input that never had rows changes nothing), when an input was
// replaced (input_replaced: the input's lastReplacedAt is newer than what the transform saw), or when its code
// changed (code_changed). Incremental TS transforms are forward-only: new code applies to new rows, so their
// code change is EDITED_SINCE_LAST_RUN, never a reason to run. Ingests are only ever never_built here.
//
// PHASE 2 STUB. The signatures are final (the phase-2 contract): builder C (checks and staleness) implements
// them; until then each throws INTERNAL_ERROR "PHASE_STUB".
import { phaseStub } from "../core/phase.ts";
import type { AssetKind, Problem, Reason } from "../core/types.ts";
import type { CatalogAsset } from "../history/catalog.ts";

/** One asset as staleness sees it: the definition's side and the catalog mirror's. */
export interface StaleView {
  asset: string;
  /** Root-relative, for EDITED_SINCE_LAST_RUN. */
  file: string;
  kind: AssetKind;
  /** An incremental TS transform (newRows()): forward-only. */
  incremental: boolean;
  /** The assets it reads (PlannedStep.inputs). */
  inputs: readonly string[];
  /** The code hash now (PlannedStep.codeHash); undefined when the asset does not load. */
  codeHash?: string;
  /** Its catalog entry (entry.codeHash is the code it was built with, entry.inputsSeen what it has read); null
   *  when it was never built. */
  entry: CatalogAsset | null;
  /** The catalog entry of each input, by name; null for an input never built. */
  inputEntries: Readonly<Record<string, CatalogAsset | null>>;
}

/** Why the asset is stale, in the order of core/types.ts Reason; empty when it is fresh. */
export function staleReasons(v: StaleView): Reason[] {
  return phaseStub("staleReasons (run/staleness.ts)");
}

/** EDITED_SINCE_LAST_RUN when the asset's code changed since it was built; for an incremental TS transform it
 *  says how many rows older code built. null when unedited, or never built. */
export function editedProblem(v: StaleView): Problem | null {
  return phaseStub("editedProblem (run/staleness.ts)");
}
