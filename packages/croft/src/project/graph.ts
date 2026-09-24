// The asset graph (DESIGN.md §3c "Dependencies", §4.1 run --upstream, §5 "Versions, staleness and atomicity"):
// who reads whom, the order steps run in, and cycles.
//
// Two kinds of edge: `inputs` (the asset reads that table; staleness and downstream follow them) and
// `orderAfter` (inputs plus tables its checks read in subqueries, §3f: they only order the steps).
//
// PHASE 2 STUB. The signature is final (the phase-2 contract): builder B (bind and graph) implements it;
// until then it throws INTERNAL_ERROR "PHASE_STUB".
import { phaseStub } from "../core/phase.ts";
import type { Problem } from "../core/types.ts";

export interface GraphNode {
  name: string;
  /** The assets it reads (PlannedStep.inputs). */
  inputs: readonly string[];
  /** Everything that must run before it: its inputs and the tables its checks read. */
  orderAfter: readonly string[];
  /** Root-relative, for CYCLE's problem ("assets/a.sql → assets/b.sql → assets/a.sql"). */
  file?: string;
}

export interface Graph {
  /** Every node, each after everything in its orderAfter, ties broken by name. Nodes on a cycle, and nodes
   *  after one, are left out (their CYCLE problem says why). Names outside the graph (an input that is not an
   *  asset) are not edges. */
  readonly order: readonly string[];
  /** The assets `name` reads (its inputs that are nodes), by name. */
  reads(name: string): string[];
  /** The assets that read `name`, by name. */
  readBy(name: string): string[];
  /** Every asset that reads any of `names`, directly or through other assets, in `order`; `names` excluded. */
  downstream(names: readonly string[]): string[];
  /** Every asset any of `names` reads, directly or through other assets, in `order`; `names` excluded. */
  upstream(names: readonly string[]): string[];
  /** Each cycle as the names along it, the first repeated at the end (["a", "b", "a"]), in a stable order. */
  readonly cycles: readonly (readonly string[])[];
}

/** Build the graph of these assets. Problems: one CYCLE per cycle, naming the path and the files. */
export function buildGraph(nodes: readonly GraphNode[]): { graph: Graph; problems: Problem[] } {
  return phaseStub("buildGraph (project/graph.ts)");
}
