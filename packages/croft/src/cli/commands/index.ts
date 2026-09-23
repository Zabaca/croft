// The command registry. Add each new command here; help and did-you-mean read this list.
import type { Command } from "../command.ts";
import { docs } from "./docs.ts";
import { help } from "./help.ts";
import { version } from "./version.ts";

export const COMMANDS: readonly Command[] = [docs, help, version];
