// The generated input types after a run and a preview (project/types-gen.ts; runner.ts afterRun, preview.ts):
// when they are regenerated, with which folders, and that their trouble never fails the run or the preview.
// types-gen-tsc.test.ts runs the real CLI and a real tsc against what they write.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectEnv } from "../project/env.ts";
import { loadProject } from "../project/root.ts";
import { runPreview } from "./preview.ts";
import { cleanupProjects, makeProject, runIn } from "./testkit.ts";

afterAll(() => cleanupProjects());

const ORDERS_TS = `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", async *rows() { yield [{ id: 1, total: 9.5 }, { id: 2, total: 12 }]; } });
`;

describe("after a run", () => {
  test("the run's project root and state folder go to the hook; a hook that throws never fails the run", async () => {
    const root = makeProject({ "assets/orders.ts": ORDERS_TS });
    const calls: [string, string][] = [];
    const out = await runIn(root, [], { hooks: { refreshReadCopy: async () => {}, generateInputTypes: (r, s) => void calls.push([r, s]) } });
    expect(out.data.status).toBe("succeeded");
    expect(calls).toEqual([[root, join(root, ".croft")]]);

    const failing = await runIn(root, [], {
      hooks: { refreshReadCopy: async () => {}, generateInputTypes: () => { throw new Error("disk full"); } },
    });
    expect(failing.exit).toBe(0);
  });

  test("by default the run writes .croft/types from what it built", async () => {
    const root = makeProject({ "assets/orders.ts": ORDERS_TS });
    const out = await runIn(root, [], { hooks: { refreshReadCopy: async () => {} } });
    expect(out.exit).toBe(0);
    const text = readFileSync(join(root, ".croft", "types", "orders.d.ts"), "utf8");
    expect(text).toContain("  /** BIGINT, the key */\n  id: number | bigint;\n  /** DOUBLE */\n  total: number | null;\n");
  });

  test("a run with a failed step regenerates too: a failed incremental transform may have committed chunks", async () => {
    const root = makeProject({ "assets/broken.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ key: "id", async *rows() { throw new Error("down"); } });\n`,
      "assets/after.sql": "SELECT id FROM broken\n" });
    const calls: string[] = [];
    const out = await runIn(root, [], { retryDelaysMs: [], hooks: { refreshReadCopy: async () => {}, generateInputTypes: (r) => void calls.push(r) } });
    expect(out.data.steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
    expect(calls).toEqual([root]);
  });
});

describe("after a preview", () => {
  test("a preview that built something regenerates; its trouble never fails the preview", async () => {
    const root = makeProject({ "assets/fresh.sql": "SELECT 1 AS n\n" });
    const project = loadProject({ root });
    const env = ProjectEnv.load(root, {});
    const calls: [string, string][] = [];
    const out = await runPreview({ project, env, selectors: ["fresh"], generateInputTypes: (r, s) => void calls.push([r, s]) });
    expect(out.built).toEqual(["fresh"]);
    expect(calls).toEqual([[root, join(root, ".croft")]]);

    const failing = await runPreview({ project, env, selectors: ["fresh"], generateInputTypes: () => { throw new Error("disk full"); } });
    expect(failing.built).toEqual(["fresh"]);

    await runPreview({ project, env, selectors: ["fresh"] });
    expect(readFileSync(join(root, ".croft", "types", "fresh.d.ts"), "utf8")).toContain("  n: number | null;\n");
  });

  test("a preview that built nothing does not", async () => {
    const root = makeProject({ "assets/bad.sql": "SELECT nope FROM nowhere_at_all\n" });
    const calls: string[] = [];
    const out = await runPreview({ project: loadProject({ root }), env: ProjectEnv.load(root, {}), selectors: ["bad"], generateInputTypes: (r) => void calls.push(r) });
    expect(out.built).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(join(root, ".croft", "types"))).toBe(false);
  });
});
