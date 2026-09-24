// croft serve's query engine (DESIGN.md §5 "Server mode"): the read-only instance, admission and the
// write-intent handoff. Phase 3 contract stub: its builder (SH) replaces this.
import { phaseStub } from "../core/phase.ts";
import type { ServeEngine, ServeEngineOptions } from "./types.ts";

/** Open the engine for a project. Throws SERVE_UNSAFE_FILESYSTEM when the warehouse is on a filesystem whose
 *  locks cannot be trusted (virtiofs, grpcfuse, fakeowner, 9p, network filesystems). */
export async function openServeEngine(o: ServeEngineOptions): Promise<ServeEngine> {
  return phaseStub(`openServeEngine(${o.root})`);
}
