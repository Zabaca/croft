// croft restore (DESIGN.md §4.1, §6). Phase 4 contract stub: its builder replaces this.
import { phaseStub } from "../../core/phase.ts";
import type { CommandImpl } from "../command.ts";

export const restore: CommandImpl = {
  async run() {
    return phaseStub("croft restore");
  },
};
