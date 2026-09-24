import { afterAll, describe, expect, test } from "bun:test";
import { cleanup, cli, ISSUES_TS, makeProject, OPEN_SQL } from "./inspect-testkit.ts";

afterAll(async () => {
  await cleanup();
});

// The phase-2 contract registers validate with its final spec; builder V replaces the stub (and this test).
describe("croft validate (contract stub)", () => {
  test("is registered with its final options and refuses as PHASE_STUB until built", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": OPEN_SQL } });
    const help = await cli(["validate", "--help", "--json"], { cwd: p.root });
    expect(help.json.data.command).toMatchObject({ name: "validate", usage: "croft validate [asset…] [--types]" });
    const r = await cli(["validate", "open_issues", "--types", "--json"], { cwd: p.root });
    expect(r.json.problems[0]).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(r.json.problems[0].message).toStartWith("PHASE_STUB");
  });
});
