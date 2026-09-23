// Public API for asset files: import { ingest, transform, fail } from "@zabaca/croft".
import { CroftError } from "./core/errors.ts";
import type { AssetDefinition, FileIngest, RowsIngest, TransformConfig } from "./types.ts";

export type * from "./types.ts";

/** Define an ingest: an asset that brings data in from an API (`rows`) or from files (`file`). */
export function ingest(config: RowsIngest | FileIngest): AssetDefinition {
  return Object.freeze({ __croft: "ingest" as const, config });
}

/** Define a TypeScript transform: an asset computed from other assets. */
export function transform(config: TransformConfig): AssetDefinition {
  return Object.freeze({ __croft: "transform" as const, config });
}

/**
 * Stop the current asset, e.g. fail("KEYSET_STUCK", "100+ issues share one updated_at"). KEYSET_STUCK is the
 * one code asset code raises itself. Any other code, registered or not, becomes ASSET_CODE_ERROR with the code
 * in details.requestedCode: croft's control-flow, check and safety codes (INTERRUPTED, CHECK_FAILED,
 * CONFIRMATION_REQUIRED, ...) change the run's exit code and what an agent does next, so only croft reports them.
 */
export function fail(code: "KEYSET_STUCK" | (string & {}), message: string): never {
  const requested = String(code);
  if (requested === "KEYSET_STUCK") {
    throw new CroftError("KEYSET_STUCK", {
      message,
      hint: "page by a key that strictly increases (such as id, or the timestamp plus id), or ask for bigger pages so one page spans the tied rows",
    });
  }
  throw new CroftError("ASSET_CODE_ERROR", {
    message: `${requested}: ${message}`,
    hint: `the asset stopped itself with fail("${requested}"); fix what the message describes, then run the asset again`,
    details: { requestedCode: requested },
  });
}
