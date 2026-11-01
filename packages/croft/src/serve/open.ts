// Which engine croft serve runs (DESIGN.md D119): the file engine (serve/instance.ts), which holds the live warehouse
// and steps aside for every writer, or, with "serverMode" on in croft.json, the readers' engine (serve/readers.ts),
// which answers from the read copy and never opens the live file. A project that never turns server mode on gets the
// file engine, exactly as before.
import { loadProject } from "../project/root.ts";
import { openServeEngine } from "./instance.ts";
import { openReadersEngine } from "./readers.ts";
import type { ServeEngine, ServeEngineOptions } from "./types.ts";

export async function openEngine(o: ServeEngineOptions): Promise<ServeEngine> {
  return loadProject({ root: o.root }).config.serverMode.enabled ? openReadersEngine(o) : openServeEngine(o);
}
