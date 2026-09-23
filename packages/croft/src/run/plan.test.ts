import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Incremental } from "../core/types.ts";
import { backfillUnsupported, behaviorHash, behaviorLabel, behaviorWords, fileDirsOf, isGlob, planRun, resolveWrite, selectAssets } from "./plan.ts";
import { cleanupProjects, makeProject } from "./testkit.ts";

afterAll(() => cleanupProjects());

const none: Incremental = { kind: "none" };
const cursor: Incremental = { kind: "cursor", field: "updated_at", lookbackMs: 0 };

describe("selectAssets", () => {
  const names = ["github_issues", "github_prs", "stripe_charges", "taxi_zones"];

  test("no selector selects everything; names and globs select in name order without duplicates", () => {
    expect(selectAssets(names, [])).toEqual(names);
    expect(selectAssets(names, ["taxi_zones", "github_*"])).toEqual(["github_issues", "github_prs", "taxi_zones"]);
    expect(selectAssets(names, ["github_issues", "github_*"])).toEqual(["github_issues", "github_prs"]);
    expect(selectAssets(names, ["*_zone?"])).toEqual(["taxi_zones"]);
  });

  test("an unknown name suggests the closest; a glob that matches nothing says so", () => {
    try {
      selectAssets(names, ["stripe_chargse"]);
      throw new Error("expected a usage error");
    } catch (e) {
      expect(e).toMatchObject({ code: "USAGE_ERROR", problem: { hint: "did you mean stripe_charges?", fix: { command: "croft run stripe_charges" } } });
    }
    expect(() => selectAssets(names, ["shopify_*"])).toThrow(/no asset matches "shopify_\*"/);
    expect(() => selectAssets([], ["x"])).toThrow(/there is no asset named "x"/);
  });

  test("isGlob", () => {
    expect(isGlob("a_*")).toBe(true);
    expect(isGlob("a?")).toBe(true);
    expect(isGlob("{a,b}")).toBe(true);
    expect(isGlob("plain_name")).toBe(false);
  });
});

describe("behavior", () => {
  test("write mode from key and incremental (§1), unless write overrides it", () => {
    expect(resolveWrite({ key: [], incremental: none })).toBe("replace");
    expect(resolveWrite({ key: ["id"], incremental: none })).toBe("replace");
    expect(resolveWrite({ key: [], incremental: cursor })).toBe("append");
    expect(resolveWrite({ key: ["id"], incremental: cursor })).toBe("merge");
    expect(resolveWrite({ key: ["id"], incremental: { kind: "files" } })).toBe("merge");
    expect(resolveWrite({ key: [], incremental: cursor, write: "append" })).toBe("append");
    expect(resolveWrite({ key: ["id"], incremental: none, write: "merge" })).toBe("merge");
  });

  test("labels and plain words", () => {
    expect(behaviorLabel("merge", ["id"])).toBe("merge by id");
    expect(behaviorLabel("replace", [])).toBe("replace");
    expect(behaviorLabel("replace", ["LocationID"])).toBe("replace; key LocationID");
    expect(behaviorLabel("append", [])).toBe("append");
    expect(behaviorWords("merge", ["id"], { kind: "cursor", field: "created", unit: "s", lookbackMs: 30 * 86_400_000 }))
      .toBe("updates rows by id; fetches created newer than the saved position, re-reading the last 30 days (created is epoch seconds)");
    expect(behaviorWords("replace", [], none)).toBe("replaces the table's contents; unchanged rows keep their _loaded_at");
    expect(behaviorWords("merge", ["order_id"], { kind: "files" })).toBe("updates rows by order_id; loads new and changed files only; rows of deleted files are kept");
  });

  test("the behavior hash changes with write, key and cursor field, not with the lookback", () => {
    const a = behaviorHash("merge", ["id"], { kind: "cursor", field: "updated_at", lookbackMs: 0 });
    expect(behaviorHash("merge", ["id"], { kind: "cursor", field: "updated_at", lookbackMs: 5000 })).toBe(a);
    expect(behaviorHash("merge", ["id", "x"], { kind: "cursor", field: "updated_at", lookbackMs: 0 })).not.toBe(a);
    expect(behaviorHash("merge", ["id"], { kind: "cursor", field: "created", lookbackMs: 0 })).not.toBe(a);
    expect(behaviorHash("append", ["id"], { kind: "cursor", field: "updated_at", lookbackMs: 0 })).not.toBe(a);
  });

  test("file ingest directories for the sandbox: the fixed part of each path or glob; URLs have none", () => {
    expect(fileDirsOf("/p", { file: "files/sales/*.csv" })).toEqual(["/p/files/sales"]);
    expect(fileDirsOf("/p", { file: ["exports/a.csv", "/data/in/**/*.json", "https://x.test/a.csv"] })).toEqual(["/p/exports", "/data/in"]);
    expect(fileDirsOf("/p", { file: "*.csv" })).toEqual(["/p"]);
  });
});

describe("planRun", () => {
  test("ingests fetch; transforms skip with a note; file ingest dirs outside files/ reach the sandbox", async () => {
    const root = makeProject({
      "assets/api.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ key: "id", incremental: "updated_at", async *rows() {} });\n`,
      "assets/sales.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "exports/*.csv", incremental: true, key: "order_id" });\n`,
      "assets/local.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/a.csv" });\n`,
      "assets/triage.ts": `import { transform } from "@zabaca/croft";\nexport default transform({ inputs: ["api"], async *rows() {} });\n`,
      "assets/report.sql": "select 1 as x\n",
    });
    const plan = await planRun({ root, timezone: "UTC", selectors: [] });
    const by = Object.fromEntries(plan.steps.map((s) => [s.asset, s]));
    expect(Object.keys(by)).toEqual(["api", "local", "report", "sales", "triage"]);
    expect(by.api).toMatchObject({ kind: "rows", action: "fetch", write: "merge", behavior: "merge by id", retries: 2, timeoutMs: 600_000 });
    expect(by.sales).toMatchObject({ kind: "file", action: "fetch", write: "merge" });
    expect(by.triage).toMatchObject({ kind: "transform", action: "skip" });
    expect(by.report).toMatchObject({ kind: "sql", action: "skip" });
    expect(by.api!.codeHash).toMatch(/^[0-9a-f]+$/);
    expect(plan.fileDirs).toEqual([join(root, "exports")]);
  });

  // An agent that just wrote assets/order.ts and runs `croft run order` must hear the real reason (NAME_RESERVED,
  // rename to orders), not "there is no asset named order".
  test("a selector naming a file that failed discovery reports that file's problem", async () => {
    const root = makeProject({
      "assets/order.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() {} });\n`,
      "assets/_private.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() {} });\n`,
      "assets/a/dup.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() {} });\n`,
      "assets/b/dup.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() {} });\n`,
      "assets/fine.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() {} });\n`,
    });
    const codeOf = async (selectors: string[]) => {
      try {
        await planRun({ root, timezone: "UTC", selectors });
        return null;
      } catch (e) {
        return e as { code: string; problem: { file?: string; hint: string; details?: Record<string, unknown> } };
      }
    };
    const reserved = await codeOf(["order"]);
    expect(reserved).toMatchObject({ code: "NAME_RESERVED", problem: { file: "assets/order.ts", details: { name: "order", suggestion: "orders" } } });
    expect(reserved!.problem.hint).toContain("orders.ts");
    expect(await codeOf(["_private"])).toMatchObject({ code: "NAME_RESERVED", problem: { file: "assets/_private.ts" } });
    expect(await codeOf(["dup"])).toMatchObject({ code: "NAME_CONFLICT" });
    expect(await codeOf(["ord*"])).toMatchObject({ code: "NAME_RESERVED" });
    expect(await codeOf(["nothing"])).toMatchObject({ code: "USAGE_ERROR" });
    // A glob that also matches a valid asset runs it, and reports the broken file as a problem.
    const plan = await planRun({ root, timezone: "UTC", selectors: ["*"] });
    expect(plan.steps.map((s) => s.asset)).toEqual(["fine"]);
    expect(plan.problems.map((p) => p.code).sort()).toEqual(["NAME_CONFLICT", "NAME_RESERVED", "NAME_RESERVED"]);
    // Naming only valid assets reports nothing about the others.
    expect((await planRun({ root, timezone: "UTC", selectors: ["fine"] })).problems).toEqual([]);
  });

  test("retries and timeout come from the asset", async () => {
    const root = makeProject({
      "assets/api.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ retries: 0, timeout: "30m", async *rows() {} });\n`,
    });
    const plan = await planRun({ root, timezone: "UTC", selectors: ["api"] });
    expect(plan.steps[0]).toMatchObject({ retries: 0, timeoutMs: 30 * 60_000 });
  });
});

describe("the --from matrix (§8)", () => {
  const step = (o: Partial<Parameters<typeof backfillUnsupported>[0]>) =>
    ({ asset: "x", file: "assets/x.ts", kind: "rows", write: "merge", incremental: cursor, ...o }) as Parameters<typeof backfillUnsupported>[0];

  test("merge and append cursor ingests take --from; everything else is BACKFILL_UNSUPPORTED with its own fix", () => {
    expect(backfillUnsupported(step({}))).toBeNull();
    expect(backfillUnsupported(step({ write: "append" }))).toBeNull();
    expect(backfillUnsupported(step({ write: "replace", incremental: none }))?.problem.hint).toBe("replace ingests always fetch everything: croft run x");
    expect(backfillUnsupported(step({ kind: "file" }))?.problem.hint).toContain("changed files reload automatically");
    expect(backfillUnsupported(step({ kind: "sql" }))?.problem.hint).toContain("nothing to backfill: croft run x");
    expect(backfillUnsupported(step({ kind: "transform" }))?.code).toBe("BACKFILL_UNSUPPORTED");
  });
});
