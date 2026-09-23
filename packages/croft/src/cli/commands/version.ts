// croft version / croft --version
import type { Command } from "../command.ts";
import { CROFT_VERSION } from "../version.ts";

export interface VersionData { version: string; bun: string; platform: string }

export const version: Command<VersionData> = {
  name: "version",
  summary: "print the croft version",
  usage: "croft version | croft --version",
  options: {},
  maxPositionals: 0,
  async run() {
    return {
      data: { version: CROFT_VERSION, bun: Bun.version, platform: `${process.platform}-${process.arch}` },
      problems: [],
      next: [],
    };
  },
  human(result) {
    return `croft ${result.data.version}`;
  },
};
