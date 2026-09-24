// croft schedule (DESIGN.md §8, §5 "Server mode"). Phase 3 contract stub: its builder replaces this.
import { phaseStub } from "../../core/phase.ts";
import type { CommandImpl } from "../command.ts";

export const schedule: CommandImpl = {
  async run() {
    return phaseStub("croft schedule");
  },
};
