// Public API for asset files: import { ingest, transform, fail } from "@zabaca/croft".
import { CroftError, isCode } from "./core/errors.ts";
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

/** Stop the current asset with a registered error code, e.g. fail("KEYSET_STUCK", "..."). */
export function fail(code: string, message: string): never {
  if (isCode(code)) throw new CroftError(code, { message, hint: `croft docs ${code}` });
  throw new CroftError("ASSET_CODE_ERROR", { message: `${code}: ${message}`, hint: "fix the asset code" });
}
