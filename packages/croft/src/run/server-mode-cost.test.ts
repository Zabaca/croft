// A run in server mode past the copy limit (DESIGN.md D121): the read copy is still refreshed, and the run says what that
// costs, as a warning that does not fail it. Without server mode, or with the cost accepted, it says nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { cleanupProjects, makeProject, runIn } from "./testkit.ts";

afterAll(() => cleanupProjects());

const ITEMS = `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", async *rows() { yield [{ id: 1 }, { id: 2 }]; } });
`;

// A filesystem that cannot clone, and a threshold the two-row warehouse is over.
const hooks = { refreshReadCopy: async () => {}, copyProbe: { clone: { canClone: false, method: null, why: "no reflink here" }, thresholdBytes: 1 } };

describe("a run past the copy limit", () => {
  test("carries a warning with the cost, and still succeeds", async () => {
    const root = makeProject({ "assets/items.ts": ITEMS }, { config: { serverMode: { enabled: true } } });
    const out = await runIn(root, [], { hooks });
    expect(out.data.status).toBe("succeeded");
    expect(out.exit).toBe(0);
    const p = out.problems.find((x) => x.code === "SERVER_MODE_COPY_COSTLY")!;
    expect(p).toMatchObject({ severity: "warning" });
    expect(p.message).toContain("server mode is past its limit");
    expect(p.message).toContain("no reflink here");
    expect(p.hint).toContain("serverMode.acceptFullCopyCost");
  });

  test("says nothing when the cost is accepted, or without server mode", async () => {
    const accepted = makeProject({ "assets/items.ts": ITEMS }, { config: { serverMode: { enabled: true, acceptFullCopyCost: true } } });
    expect((await runIn(accepted, [], { hooks })).problems.map((x) => x.code)).not.toContain("SERVER_MODE_COPY_COSTLY");
    const off = makeProject({ "assets/items.ts": ITEMS }, { config: { readCopy: true } });
    expect((await runIn(off, [], { hooks })).problems.map((x) => x.code)).not.toContain("SERVER_MODE_COPY_COSTLY");
  });
});
