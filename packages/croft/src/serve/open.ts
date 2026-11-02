// Which engine croft serve runs (DESIGN.md D119, D143): the file engine (serve/instance.ts), which holds the live warehouse and steps
// aside for every writer; with "serverMode" on in croft.json, the readers' engine (serve/readers.ts), which answers from the read copy and
// never opens the live file; or, for a project with a "lake", the lake engine (serve/lake-engine.ts), which reads the lake's last
// snapshot with the read-only login and key and never steps aside. A project that names neither gets the file engine, exactly as before.
import { loadProject } from "../project/root.ts";
import { openServeEngine } from "./instance.ts";
import { openLakeEngine } from "./lake-engine.ts";
import { openReadersEngine } from "./readers.ts";
import type { ServeEngine, ServeEngineOptions } from "./types.ts";

export async function openEngine(o: ServeEngineOptions): Promise<ServeEngine> {
  const config = loadProject({ root: o.root }).config;
  if (config.lake) return openLakeEngine(o);
  return config.serverMode.enabled ? openReadersEngine(o) : openServeEngine(o);
}
