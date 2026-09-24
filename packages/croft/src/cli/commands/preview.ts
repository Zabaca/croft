// croft preview <asset…> [--rows N] [--rebuild] (DESIGN.md §4.1, §4.2, §6 "Ways to try a change" 2). Builds the
// named assets in .croft/preview.duckdb from Parquet snapshots of their live inputs (taken under one short read
// lease; the live file is never ATTACHed), and diffs each against its live table: row counts, added, removed
// and changed rows by key, column changes, checks and samples. SQL downstream of a named SQL asset is built too;
// an ingest fetches at most --rows rows from its saved position, which does not move, and its downstream is
// listed, not built. `croft query --preview` explores the result. Data: PreviewData (core/types.ts). Its spec
// (usage, options) is in commands/index.ts.
//
// PHASE 2 STUB. The spec is registered with its final options; builder PV implements run() and human(). Until
// then run() throws INTERNAL_ERROR "PHASE_STUB".
import { phaseStub } from "../../core/phase.ts";
import type { PreviewData } from "../../core/types.ts";
import type { CommandImpl } from "../command.ts";

export const preview: CommandImpl<PreviewData> = {
  async run() {
    return phaseStub("croft preview (cli/commands/preview.ts)");
  },
};
