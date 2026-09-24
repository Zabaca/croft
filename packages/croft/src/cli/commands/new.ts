// croft new (DESIGN.md §4.1, §4.2, §3). Phase 5 contract stub: its builder (NW) replaces this.
import { phaseStub } from "../../core/phase.ts";
import type { CommandImpl } from "../command.ts";

export const newAsset: CommandImpl = {
  async run() {
    return phaseStub("croft new");
  },
};
