import { afterAll, describe, expect, test } from "bun:test";
import { cleanup, cli, ISSUES_TS, makeProject } from "./inspect-testkit.ts";

afterAll(async () => {
  await cleanup();
});

// The phase-2 contract registers preview with its final spec; builder PV replaces the stub (and this test).
describe("croft preview (contract stub)", () => {
  test("is registered with its final options and refuses as PHASE_STUB until built", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    const help = await cli(["preview", "--help", "--json"], { cwd: p.root });
    expect(help.json.data.command).toMatchObject({ name: "preview", usage: "croft preview <asset…> [--rows N] [--rebuild]" });
    const r = await cli(["preview", "github_issues", "--rows", "10", "--rebuild", "--json"], { cwd: p.root });
    expect(r.json.problems[0]).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(r.json.problems[0].message).toStartWith("PHASE_STUB");
  });
});
