// croft validate [asset…] [--types] (DESIGN.md §4.1, §4.2, §4.3 "validate", §6 "Ways to try a change" 1). Static
// checks of every asset (project/resolve.ts resolveProject: headers, the one-SELECT gate, config shapes, checks,
// cycles), then the bind check: sql/bind.ts ShadowCatalog in graph order, each input defined from its cached
// columns (or the previous asset's output columns), so an SQL asset's column and table errors show up with
// file, line and column before anything runs. Never opens the warehouse and never waits. Data: ValidateData
// (core/types.ts). Its spec (usage, options) is in commands/index.ts.
//
// PHASE 2 STUB. The spec is registered with its final options; builder V implements run() and human(). Until
// then run() throws INTERNAL_ERROR "PHASE_STUB".
import { phaseStub } from "../../core/phase.ts";
import type { ValidateData } from "../../core/types.ts";
import type { CommandImpl } from "../command.ts";

export const validate: CommandImpl<ValidateData> = {
  async run() {
    return phaseStub("croft validate (cli/commands/validate.ts)");
  },
};
