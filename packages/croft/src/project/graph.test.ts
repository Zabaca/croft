import { describe, expect, test } from "bun:test";
import { buildGraph, type GraphNode } from "./graph.ts";

/** A node reading `inputs`, whose checks also read `checks`. */
function node(name: string, inputs: string[] = [], checks: string[] = [], file = `assets/${name}.sql`): GraphNode {
  return { name, inputs, orderAfter: [...inputs, ...checks], file };
}

// The DESIGN.md §3 project: three ingests, a file ingest, two SQL transforms and a TS transform.
const project = [
  node("open_issues", ["github_issues"], ["issue_triage"]),
  node("daily_revenue", ["stripe_charges"]),
  node("issue_triage", ["github_issues"], [], "assets/issue_triage.ts"),
  node("github_issues", [], [], "assets/github_issues.ts"),
  node("stripe_charges", [], [], "assets/stripe_charges.ts"),
  node("taxi_zones", [], [], "assets/taxi_zones.ts"),
  node("sales", [], [], "assets/sales.ts"),
];

describe("order", () => {
  test("each asset after everything it reads or its checks read; ties broken by name", () => {
    const { graph, problems } = buildGraph(project);
    expect(problems).toEqual([]);
    expect(graph.order).toEqual(["github_issues", "issue_triage", "open_issues", "sales", "stripe_charges", "daily_revenue", "taxi_zones"]);
    expect(graph.cycles).toEqual([]);
  });

  test("does not depend on the order the nodes come in", () => {
    const first = buildGraph(project).graph.order;
    for (let seed = 1; seed <= 20; seed++) {
      const shuffled = [...project].sort((a, b) => ((a.name.charCodeAt(seed % a.name.length) * seed) % 7) - ((b.name.charCodeAt(seed % b.name.length) * seed) % 7));
      expect(buildGraph(shuffled.reverse()).graph.order).toEqual(first);
    }
  });

  test("names that are not assets are not edges", () => {
    const { graph, problems } = buildGraph([node("b", ["a", "raw_table"]), node("a", ["missing"])]);
    expect(problems).toEqual([]);
    expect(graph.order).toEqual(["a", "b"]);
    expect(graph.reads("b")).toEqual(["a"]);
    expect(graph.reads("a")).toEqual([]);
  });

  test("an input listed twice, or in both inputs and orderAfter, is one edge", () => {
    const { graph } = buildGraph([{ name: "b", inputs: ["a", "a"], orderAfter: ["a", "a"] }, node("a")]);
    expect(graph.order).toEqual(["a", "b"]);
    expect(graph.reads("b")).toEqual(["a"]);
    expect(graph.readBy("a")).toEqual(["b"]);
  });

  test("the first node of a name wins", () => {
    const { graph } = buildGraph([node("a", ["b"]), node("a"), node("b")]);
    expect(graph.order).toEqual(["b", "a"]);
  });

  test("a long chain", () => {
    const n = 20_000;
    const name = (i: number) => `a${String(i).padStart(5, "0")}`;
    const nodes = Array.from({ length: n }, (_, i) => node(name(i), i ? [name(i - 1)] : []));
    const { graph, problems } = buildGraph(nodes.reverse());
    expect(problems).toEqual([]);
    expect(graph.order.length).toBe(n);
    expect(graph.order[0]).toBe(name(0));
    expect(graph.order[n - 1]).toBe(name(n - 1));
    expect(graph.downstream([name(0)]).length).toBe(n - 1);
  });
});

describe("reads, readBy, downstream, upstream", () => {
  const { graph } = buildGraph([
    node("a"), node("b", ["a"]), node("c", ["b"]), node("d", ["a", "c"]), node("e"), node("f", ["e"], ["d"]),
  ]);

  test("direct edges follow inputs only, by name", () => {
    expect(graph.reads("d")).toEqual(["a", "c"]);
    expect(graph.readBy("a")).toEqual(["b", "d"]);
    // f's check reads d: it orders f after d, but f does not read d.
    expect(graph.readBy("d")).toEqual([]);
    expect(graph.reads("f")).toEqual(["e"]);
    expect(graph.order).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("an unknown name has no edges", () => {
    expect(graph.reads("zz")).toEqual([]);
    expect(graph.readBy("zz")).toEqual([]);
  });

  test("downstream: everything that reads them, transitively, in order, themselves excluded", () => {
    expect(graph.downstream(["a"])).toEqual(["b", "c", "d"]);
    expect(graph.downstream(["b"])).toEqual(["c", "d"]);
    expect(graph.downstream(["b", "c"])).toEqual(["d"]);
    expect(graph.downstream(["d"])).toEqual([]);
    expect(graph.downstream(["e", "zz"])).toEqual(["f"]);
  });

  test("upstream: everything they read, transitively, in order, themselves excluded", () => {
    expect(graph.upstream(["d"])).toEqual(["a", "b", "c"]);
    expect(graph.upstream(["c", "b"])).toEqual(["a"]);
    // A check's table is ordered before f, but f does not read it.
    expect(graph.upstream(["f"])).toEqual(["e"]);
    expect(graph.upstream(["a"])).toEqual([]);
  });

  test("the returned lists are copies", () => {
    graph.reads("d").push("x");
    expect(graph.reads("d")).toEqual(["a", "c"]);
  });
});

describe("cycles", () => {
  test("two assets reading each other: a CYCLE naming the path and the files", () => {
    const { graph, problems } = buildGraph([
      node("open_issues", ["issue_triage"]),
      node("issue_triage", ["open_issues"], [], "assets/issue_triage.ts"),
      node("github_issues", [], [], "assets/github_issues.ts"),
      node("summary", ["open_issues"]),
    ]);
    expect(graph.cycles).toEqual([["issue_triage", "open_issues", "issue_triage"]]);
    // Nodes on the cycle and after it are left out of the order.
    expect(graph.order).toEqual(["github_issues"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      severity: "error", code: "CYCLE", asset: "issue_triage", file: "assets/issue_triage.ts",
      message: "assets read each other in a cycle: issue_triage → open_issues → issue_triage "
        + "(assets/issue_triage.ts → assets/open_issues.sql → assets/issue_triage.ts)",
      hint: "remove one of these reads: assets/issue_triage.ts reads open_issues; assets/open_issues.sql reads issue_triage",
      details: { cycle: ["issue_triage", "open_issues", "issue_triage"], files: ["assets/issue_triage.ts", "assets/open_issues.sql", "assets/issue_triage.ts"] },
    });
    // downstream and upstream still follow the edges.
    expect(graph.downstream(["github_issues"])).toEqual([]);
    expect(graph.downstream(["open_issues"])).toEqual(["issue_triage", "summary"]);
    expect(graph.upstream(["summary"])).toEqual(["issue_triage", "open_issues"]);
  });

  test("a check's subquery can close a cycle, and the hint says so", () => {
    const { graph, problems } = buildGraph([node("a", ["b"]), node("b", [], ["a"])]);
    expect(graph.cycles).toEqual([["a", "b", "a"]]);
    expect(graph.order).toEqual([]);
    expect(problems[0]!.hint).toBe("remove one of these reads: assets/a.sql reads b; a check in assets/b.sql reads a");
  });

  test("an asset reading itself is a cycle; a check reading its own asset is not", () => {
    const self = buildGraph([node("a", ["a"]), node("b")]);
    expect(self.graph.cycles).toEqual([["a", "a"]]);
    expect(self.graph.order).toEqual(["b"]);
    expect(self.problems[0]).toMatchObject({ code: "CYCLE", message: "a reads its own table (assets/a.sql)", asset: "a" });
    const check = buildGraph([node("categories", [], ["categories"]), node("x", ["categories"])]);
    expect(check.problems).toEqual([]);
    expect(check.graph.order).toEqual(["categories", "x"]);
  });

  test("one problem per cycle, in a stable order; the shortest path from the smallest name", () => {
    const nodes = [
      node("m", ["n"]), node("n", ["m"]),                          // m ⇄ n
      node("a", ["c"]), node("b", ["a"]), node("c", ["b", "d"]), node("d", ["a"]),  // a→c→b→a and a→c→d→a
      node("z"),
    ];
    const { graph, problems } = buildGraph(nodes);
    expect(graph.cycles).toEqual([["a", "c", "b", "a"], ["m", "n", "m"]]);
    expect(problems.map((p) => p.details?.cycle)).toEqual([["a", "c", "b", "a"], ["m", "n", "m"]]);
    expect(buildGraph([...nodes].reverse()).graph.cycles).toEqual(graph.cycles);
    expect(graph.order).toEqual(["z"]);
  });

  test("without files, the names stand in for them", () => {
    const { problems } = buildGraph([{ name: "a", inputs: ["b"], orderAfter: ["b"] }, { name: "b", inputs: ["a"], orderAfter: ["a"] }]);
    expect(problems[0]!.message).toBe("assets read each other in a cycle: a → b → a (a → b → a)");
    expect(problems[0]!.file).toBeUndefined();
  });
});
