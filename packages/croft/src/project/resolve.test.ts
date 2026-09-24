import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, makeProject } from "../run/testkit.ts";
import { type ResolvedAsset, resolveProject, sniffKind, stepKindOf } from "./resolve.ts";

afterAll(() => cleanupProjects());

const INGEST = (extra = "") => `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", incremental: "updated_at", ${extra} async *rows() {} });
`;

const PROJECT = {
  "assets/github_issues.ts": INGEST(`checks: ["state IN ('open', 'closed')"],`),
  "assets/open_issues.sql": `-- description: open issues
-- key: id
-- warn: id IN (SELECT id FROM github_issues)
SELECT id, title FROM github_issues WHERE state = 'open'
`,
  "assets/issue_triage.ts": `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["open_issues"], key: "id", incremental: true, confirmAbove: 50,
  checks: ["priority IN (SELECT p FROM priorities)"],
  async *rows() {},
});
`,
  "assets/priorities.sql": "SELECT 1 AS p\n",
};

const byName = (assets: readonly ResolvedAsset[]) => Object.fromEntries(assets.map((a) => [a.name, a]));

describe("resolveProject", () => {
  test("every asset loaded, with inputs, checks, behavior, and the graph in run order", async () => {
    const root = makeProject(PROJECT);
    const r = await resolveProject({ root, timezone: "UTC" });
    expect(r.problems).toEqual([]);
    expect(r.assets.map((a) => a.name)).toEqual(["github_issues", "issue_triage", "open_issues", "priorities"]);
    expect(r.selected).toEqual(["github_issues", "issue_triage", "open_issues", "priorities"]);
    const a = byName(r.assets);

    expect(a.github_issues).toMatchObject({
      kind: "ingest", loaded: true, ok: true, inputs: [], orderAfter: [], write: "merge", key: ["id"],
      incremental: { kind: "cursor", field: "updated_at" }, behavior: "merge by id", problems: [],
    });
    expect(a.github_issues!.checks.map((c) => c.source)).toEqual(["unique(id)", "not_null(id)", "state IN ('open', 'closed')"]);
    expect(a.github_issues!.ts?.spec?.source).toBe("rows");
    expect(stepKindOf(a.github_issues!)).toBe("rows");

    // SQL: inputs from the AST; the warning's subquery orders it after what it reads (already an input here).
    expect(a.open_issues).toMatchObject({
      kind: "sql", loaded: true, ok: true, inputs: ["github_issues"], orderAfter: ["github_issues"], write: "replace",
      key: ["id"], behavior: "replace; key id", description: "open issues",
    });
    expect(a.open_issues!.sql?.headerLines).toBe(3);
    expect(a.open_issues!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.open_issues!.checks.find((c) => !c.blocking)).toMatchObject({ kind: "rule", reads: ["github_issues"] });
    expect(stepKindOf(a.open_issues!)).toBe("sql");

    // TS transform: declared inputs; a check reading another table orders it without making it an input.
    expect(a.issue_triage).toMatchObject({
      kind: "ts", ok: true, inputs: ["open_issues"], orderAfter: ["open_issues", "priorities"], write: "merge",
      incremental: { kind: "new-rows", inputs: ["open_issues"] }, confirmAbove: 50, usesHttp: false,
    });
    expect(a.issue_triage!.codeHash).toMatch(/^[0-9a-f]+$/);
    expect(stepKindOf(a.issue_triage!)).toBe("transform");

    expect(r.graph.order).toEqual(["github_issues", "open_issues", "priorities", "issue_triage"]);
    expect(r.graph.readBy("github_issues")).toEqual(["open_issues"]);
    expect(r.graph.reads("issue_triage")).toEqual(["open_issues"]);
    expect(r.graph.downstream(["github_issues"])).toEqual(["open_issues", "issue_triage"]);
  });

  test("selectors: the selection, its upstream and every possible transform are imported; other ingests are not", async () => {
    const marker = (name: string) => `import { writeFileSync } from "node:fs";
import { ingest } from "@zabaca/croft";
writeFileSync(import.meta.dir + "/../imported_${name}", "x");
export default ingest({ async *rows() {} });
`;
    const root = makeProject({ ...PROJECT, "assets/github_issues.ts": marker("github_issues"), "assets/stripe_charges.ts": marker("stripe_charges") });
    const r = await resolveProject({ root, timezone: "UTC", selectors: ["issue_triage"] });
    expect(r.selected).toEqual(["issue_triage"]);
    const a = byName(r.assets);
    // github_issues is upstream of issue_triage (through open_issues): imported. stripe_charges is not needed.
    expect(existsSync(join(root, "imported_github_issues"))).toBe(true);
    expect(existsSync(join(root, "imported_stripe_charges"))).toBe(false);
    expect(a.github_issues).toMatchObject({ loaded: true, ok: true });
    expect(a.stripe_charges).toMatchObject({ kind: "ingest", loaded: false, ok: false, inputs: [], checks: [], problems: [] });
    expect(a.stripe_charges!.ts).toBeUndefined();
    expect(r.graph.order).toContain("stripe_charges");

    // Without selectors every asset is imported.
    await resolveProject({ root, timezone: "UTC" });
    expect(existsSync(join(root, "imported_stripe_charges"))).toBe(true);
  });

  test("unknown selectors are usage errors, as for croft run", async () => {
    const root = makeProject(PROJECT);
    await expect(resolveProject({ root, timezone: "UTC", selectors: ["open_issuse"] })).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  test("each asset carries its own problems; a broken asset is still listed; cycles are project problems", async () => {
    const root = makeProject({
      "assets/api.ts": INGEST(`checks: ["amount >= 0; DROP TABLE api"],`),
      "assets/broken.ts": `import { transform } from "@zabaca/croft";\nexport default transform({ inputs: [ });\n`,
      "assets/weird.ts": "export default 1;\n",
      "assets/a.sql": "SELECT * FROM b\n",
      "assets/b.sql": "SELECT * FROM a\n",
      "assets/bad.sql": "-- chek: x > 0\nSELECT 1 AS x\n",
    });
    const r = await resolveProject({ root, timezone: "UTC" });
    const a = byName(r.assets);
    expect(a.api).toMatchObject({ loaded: true, ok: false });
    expect(a.api!.problems.map((p) => p.code)).toEqual(["CHECK_INVALID"]);
    expect(a.api!.checks.map((c) => c.source)).toEqual(["unique(id)", "not_null(id)"]);
    expect(a.broken).toMatchObject({ kind: "ts", loaded: true, ok: false, inputs: [] });
    expect(a.broken!.problems[0]!.severity).toBe("error");
    expect(stepKindOf(a.broken!)).toBe("transform");
    expect(a.weird).toMatchObject({ kind: null, ok: false });
    expect(stepKindOf(a.weird!)).toBe("rows");
    expect(a.bad!.problems.map((p) => p.code)).toEqual(["HEADER_UNKNOWN_KEY"]);
    expect(r.problems.map((p) => p.code)).toEqual(["CYCLE"]);
    expect(r.graph.cycles).toEqual([["a", "b", "a"]]);
    expect(r.graph.order).not.toContain("a");
  });

  test("keepOutput collects each TS asset's top-level output instead of printing it", async () => {
    const root = makeProject({
      "assets/noisy.ts": `import { ingest } from "@zabaca/croft";\nconsole.log("hello from noisy");\nexport default ingest({ async *rows() {} });\n`,
    });
    const r = await resolveProject({ root, timezone: "UTC", keepOutput: true });
    expect(r.assets[0]!.output?.join("")).toContain("hello from noisy");
    expect((await resolveProject({ root, timezone: "UTC" })).assets[0]!.output).toBeUndefined();
  });

  test("discovery problems: all of them without selectors, only those a selector names with them", async () => {
    const root = makeProject({ "assets/order.ts": INGEST(), "assets/fine.ts": INGEST() });
    expect((await resolveProject({ root, timezone: "UTC" })).problems.map((p) => p.code)).toEqual(["NAME_RESERVED"]);
    expect((await resolveProject({ root, timezone: "UTC", selectors: ["fine"] })).problems).toEqual([]);
    expect((await resolveProject({ root, timezone: "UTC", selectors: ["*"] })).problems.map((p) => p.code)).toEqual(["NAME_RESERVED"]);
  });
});

describe("sniffKind", () => {
  test("reads the kind from the text without importing", () => {
    const root = makeProject({
      "assets/i.ts": INGEST(),
      "assets/t.ts": `import { transform } from "@zabaca/croft";\nexport default transform({ inputs: [], async *rows() {} });\n`,
      "assets/n.ts": "export default 1;\n",
    });
    const at = (f: string) => ({ kind: "ts" as const, path: join(root, "assets", f) });
    expect(sniffKind(at("i.ts"))).toBe("ingest");
    expect(sniffKind(at("t.ts"))).toBe("ts");
    expect(sniffKind(at("n.ts"))).toBeNull();
    expect(sniffKind(at("missing.ts"))).toBeNull();
    expect(sniffKind({ kind: "sql", path: "/nowhere.sql" })).toBe("sql");
  });
});
