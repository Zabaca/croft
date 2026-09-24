// The asset graph (DESIGN.md §3c "Dependencies", §4.1 run --upstream, §5 "Versions, staleness and atomicity"):
// who reads whom, the order steps run in, and cycles.
//
// Two kinds of edge: `inputs` (the asset reads that table; staleness and downstream follow them) and
// `orderAfter` (inputs plus tables its blocking checks read in subqueries, §3f: they only order the steps). A
// warning's tables are no edge at all: it runs after the commit against the tables as they are, so it can read a
// table downstream of its own asset (§3c's `-- warn: id IN (SELECT issue_id FROM issue_triage)`) without a cycle.
//
// - The order is Kahn's algorithm over both kinds, always taking the smallest ready name, so it never depends
//   on the order the nodes came in.
// - A cycle is a strongly connected component (Tarjan) of more than one node, or a node that reads itself.
//   Each is reported once, as the shortest path from its smallest name back to it. A check that reads its own
//   asset (`parent_id IN (SELECT id FROM categories)` on categories) is no cycle: checks run after the write.
import { problem } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";

export interface GraphNode {
  name: string;
  /** The assets it reads (PlannedStep.inputs). */
  inputs: readonly string[];
  /** Everything that must run before it: its inputs and the tables its blocking checks read. */
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
  /** Every asset that reads any of `names`, directly or through other assets, in `order`; `names` excluded.
   *  Assets left out of `order` (on or after a cycle) come last, by name. */
  downstream(names: readonly string[]): string[];
  /** Every asset any of `names` reads, directly or through other assets, in `order`; `names` excluded.
   *  Assets left out of `order` (on or after a cycle) come last, by name. */
  upstream(names: readonly string[]): string[];
  /** Each cycle as the names along it, the first repeated at the end (["a", "b", "a"]), in a stable order. */
  readonly cycles: readonly (readonly string[])[];
}

/** Plain code-unit order: asset names are ASCII, and locale rules must not change the run order. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Build the graph of these assets. Problems: one CYCLE per cycle, naming the path and the files. */
export function buildGraph(nodes: readonly GraphNode[]): { graph: Graph; problems: Problem[] } {
  // The first node of a name wins; NAME_CONFLICT is reported where assets are discovered.
  const byNode = new Map<string, GraphNode>();
  for (const n of nodes) if (!byNode.has(n.name)) byNode.set(n.name, n);
  const names = [...byNode.keys()].sort(byName);
  const edges = (list: readonly string[]) => [...new Set(list)].filter((x) => byNode.has(x)).sort(byName);

  // reads: input edges (a node reading itself included: that is a cycle). after: ordering edges, which add
  // the tables checks read, but not the node's own table.
  const reads = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  const readBy = new Map<string, string[]>(names.map((n) => [n, []]));
  const before = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const name of names) {
    const node = byNode.get(name)!;
    const r = edges(node.inputs);
    const o = edges([...node.inputs, ...node.orderAfter]).filter((x) => x !== name || r.includes(name));
    reads.set(name, r);
    after.set(name, o);
    for (const x of r) readBy.get(x)!.push(name);
    for (const x of o) before.get(x)!.push(name);
  }

  const order = topologicalOrder(names, after, before);
  const cycles = findCycles(names, after);
  const position = new Map(order.map((n, i) => [n, i]));
  const sortByOrder = (list: Iterable<string>): string[] => [...list].sort((a, b) => {
    const pa = position.get(a) ?? Infinity;
    const pb = position.get(b) ?? Infinity;
    return pa !== pb ? pa - pb : byName(a, b);
  });
  const reach = (start: readonly string[], next: Map<string, string[]>): string[] => {
    const from = start.filter((n) => byNode.has(n));
    const seen = new Set<string>();
    const stack = [...from];
    while (stack.length) {
      for (const x of next.get(stack.pop()!) ?? []) {
        if (!seen.has(x)) {
          seen.add(x);
          stack.push(x);
        }
      }
    }
    for (const n of start) seen.delete(n);
    return sortByOrder(seen);
  };

  const graph: Graph = {
    order,
    reads: (name) => [...(reads.get(name) ?? [])],
    readBy: (name) => [...(readBy.get(name) ?? [])],
    downstream: (list) => reach(list, readBy),
    upstream: (list) => reach(list, reads),
    cycles,
  };
  return { graph, problems: cycles.map((c) => cycleProblem(c, byNode, reads)) };
}

/** Kahn's algorithm, taking the smallest ready name each time. Nodes on or after a cycle never get ready. */
function topologicalOrder(names: readonly string[], after: Map<string, string[]>, before: Map<string, string[]>): string[] {
  const waiting = new Map(names.map((n) => [n, after.get(n)!.length]));
  const ready = names.filter((n) => waiting.get(n) === 0);
  const order: string[] = [];
  while (ready.length) {
    // `ready` stays sorted: the smallest is first. Asset counts are small, so a sorted insert is enough.
    const n = ready.shift()!;
    order.push(n);
    for (const m of before.get(n)!) {
      const left = waiting.get(m)! - 1;
      waiting.set(m, left);
      if (left === 0) ready.splice(insertionPoint(ready, m), 0, m);
    }
  }
  return order;
}

function insertionPoint(sorted: readonly string[], x: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byName(sorted[mid]!, x) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One cycle per strongly connected component that has one: the shortest path from its smallest name back to
 *  that name, preferring smaller names at each step; sorted by that first name. */
function findCycles(names: readonly string[], after: Map<string, string[]>): string[][] {
  const out: string[][] = [];
  for (const component of stronglyConnected(names, after)) {
    const start = [...component].sort(byName)[0]!;
    const selfLoop = after.get(start)!.includes(start);
    if (component.size === 1 && !selfLoop) continue;
    if (selfLoop) {
      out.push([start, start]);
      continue;
    }
    // BFS along `after` edges (a → x: a runs after x, because it or one of its checks reads x).
    const prev = new Map<string, string>();
    const queue = [start];
    let found = false;
    while (queue.length && !found) {
      const n = queue.shift()!;
      for (const x of after.get(n)!) {
        if (!component.has(x)) continue;
        if (x === start) {
          prev.set(start, n);
          found = true;
          break;
        }
        if (!prev.has(x)) {
          prev.set(x, n);
          queue.push(x);
        }
      }
    }
    // Walk back from the edge that closed the cycle, then turn it around: start → x1 → … → start.
    const back: string[] = [];
    for (let n = prev.get(start)!; n !== start; n = prev.get(n)!) back.push(n);
    out.push([start, ...back.reverse(), start]);
  }
  return out.sort((a, b) => byName(a[0]!, b[0]!));
}

/** Tarjan's algorithm, iterative (a long chain of assets must not overflow the stack). */
function stronglyConnected(names: readonly string[], after: Map<string, string[]>): Set<string>[] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: Set<string>[] = [];
  let next = 0;
  for (const root of names) {
    if (index.has(root)) continue;
    const work: { n: string; i: number }[] = [{ n: root, i: 0 }];
    index.set(root, next);
    low.set(root, next++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1]!;
      const succ = after.get(top.n)!;
      if (top.i < succ.length) {
        const x = succ[top.i++]!;
        if (!index.has(x)) {
          index.set(x, next);
          low.set(x, next++);
          stack.push(x);
          onStack.add(x);
          work.push({ n: x, i: 0 });
        } else if (onStack.has(x)) {
          low.set(top.n, Math.min(low.get(top.n)!, index.get(x)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.n, Math.min(low.get(parent.n)!, low.get(top.n)!));
      if (low.get(top.n) === index.get(top.n)) {
        const component = new Set<string>();
        let x: string;
        do {
          x = stack.pop()!;
          onStack.delete(x);
          component.add(x);
        } while (x !== top.n);
        out.push(component);
      }
    }
  }
  return out;
}

function cycleProblem(cycle: readonly string[], nodes: Map<string, GraphNode>, reads: Map<string, string[]>): Problem {
  const fileOf = (n: string) => nodes.get(n)?.file ?? n;
  const first = cycle[0]!;
  const steps: string[] = [];
  let check = false;
  for (let i = 0; i + 1 < cycle.length; i++) {
    const a = cycle[i]!;
    const b = cycle[i + 1]!;
    const input = reads.get(a)!.includes(b);
    check ||= !input;
    steps.push(input ? `${fileOf(a)} reads ${b}` : `a check in ${fileOf(a)} reads ${b}`);
  }
  const self = cycle.length === 2;
  const file = nodes.get(first)?.file;
  // Why a check's read counts (only a blocking check's does), so the agent does not look for a read in the SQL.
  const why = check ? " (a blocking check runs before its write commits, so the table it reads is built first; a warning's is not)" : "";
  return problem("CYCLE", {
    message: self
      ? `${first} reads its own table (${fileOf(first)})`
      : `assets read each other in a cycle: ${cycle.join(" → ")} (${cycle.map(fileOf).join(" → ")})`,
    hint: self
      ? `an asset cannot read the table it builds; remove the read of ${first} from ${fileOf(first)}`
      : `remove one of these reads: ${steps.join("; ")}${why}`,
    asset: first,
    ...(file ? { file } : {}),
    // What a run does (run/plan.ts: CYCLE is a static error of each asset on the cycle); validate and the plan
    // put them last in the order.
    effect: "the assets on the cycle fail before they run, and the assets that read them are skipped; the others still run",
    details: { cycle: [...cycle], files: cycle.map(fileOf) },
  });
}
