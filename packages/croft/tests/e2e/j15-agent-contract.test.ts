// The agent's side of phase 1, through the real CLI: what CLAUDE.md, the skill, croft docs and next[] tell an
// agent to run exists and works, and status, context and query tell one story when the warehouse file is gone.
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, findProblem, initProject, show } from "./harness.ts";

afterAll(async () => {
  await cleanupAll();
});

/** `croft <word>` commands in a text, with their words up to the end of the code span or line. */
function commandsIn(text: string): string[] {
  return [...text.matchAll(/`(croft [^`]+)`/g)].map((m) => m[1]!);
}

describe("the agent contract", () => {
  test("every step of the CLAUDE.md loop runs in a fresh project, and no text init wrote names a missing command", async () => {
    const { project: p } = await initProject();
    const claude = p.read("CLAUDE.md");
    const loop = claude.split("\n").find((l) => l.startsWith("Loop:"))!;
    expect(commandsIn(loop)).toEqual(["croft run <asset>", 'croft query "..."', "croft describe <asset>", "croft logs <asset>"]);
    const concrete: Record<string, string[]> = {
      "croft run <asset>": ["run", "example_sales"],
      'croft query "..."': ["query", "select count(*) AS n from example_sales"],
      "croft describe <asset>": ["describe", "example_sales"],
      "croft logs <asset>": ["logs", "example_sales"],
    };
    for (const c of commandsIn(loop)) {
      const r = await p.json(concrete[c]!);
      expect(r.code, `${c}\n${show(r)}`).toBe(0);
    }
    expect((await p.rows("select count(*) AS n from example_sales"))[0]!.n).toBe(120);

    // What the review found missing: none of these may appear in what init wrote.
    const skill = p.read(".claude/skills/croft/SKILL.md");
    const body = skill.slice(skill.indexOf("## Orient"));                 // after "This version", which lists them on purpose
    for (const text of [claude, body, p.read("assets/example_sales.ts")]) {
      for (const missing of ["croft validate", "croft preview", "croft new", "croft rename", "croft schedule", "croft serve", "--dry-run"]) {
        expect(text).not.toContain(missing);
      }
    }
    expect(skill).toContain("croft run <asset> --from -90d");
    // The version section names what this build lacks, so the agent does not try it.
    expect(skill).toContain("Not in this version, so never call them (each exits 2): schedule, serve");

    // The skill's pointers answer: the templates page and the backfill flag (refused for a file ingest, not unknown).
    const ingestDocs = await p.json(["docs", "ingest"]);
    expect(ingestDocs.code, show(ingestDocs)).toBe(0);
    expect(ingestDocs.json.data.page).toContain('incremental: { field: "created", unit: "s", lookback: "30 days" }');
    const backfill = await p.json(["run", "example_sales", "--from", "-90d"]);
    expect(findProblem(backfill.json, "BACKFILL_UNSUPPORTED"), show(backfill)).toBeDefined();
    expect(findProblem(backfill.json, "USAGE_ERROR"), show(backfill)).toBeUndefined();

    // croft docs' "what to do" and the empty-project next[] point at commands that exist.
    const typeConflict = await p.croft(["docs", "TYPE_CONFLICT"]);
    expect(typeConflict.stdout).toContain("What to do:");
    expect(typeConflict.stdout).not.toContain("croft preview");
    const sqlSyntax = await p.croft(["docs", "SQL_SYNTAX"]);
    expect(sqlSyntax.stdout).not.toContain("croft validate");
    p.remove("assets/example_sales.ts");
    const empty = await p.json(["run"]);
    expect(empty.code, show(empty)).toBe(0);
    expect(empty.json.next).toEqual([{ command: "croft docs ingest", reason: "assets/ has no assets yet; start from a template" }]);
    expect((await p.json(["docs", "ingest"])).code).toBe(0);
  }, 60_000);
});

describe("the warehouse file is missing after a run", () => {
  test("status, context and query agree: it was built before and is gone", async () => {
    const { project: p } = await initProject();
    const run = await p.json(["run", "example_sales", "--foreground"]);
    expect(run.code, show(run)).toBe(0);
    for (const f of readdirSync(p.root)) if (f.startsWith("warehouse.duckdb")) rmSync(join(p.root, f));

    const status = await p.json(["status"]);
    expect(status.code, show(status)).toBe(0);
    expect(status.json.data.healthy).toBe(false);
    expect(status.json.data.assets).toEqual([expect.objectContaining({ asset: "example_sales", rows: null, status: "unknown" })]);
    const missing = findProblem(status.json, "DB_NOT_FOUND");
    expect(missing, show(status)).toBeDefined();
    expect(missing!.message).toContain("warehouse.duckdb is missing: croft built it before");
    expect((await p.json(["status", "--check"])).code).toBe(1);

    const context = await p.json(["context"]);
    expect(context.json.data.assets[0]).toMatchObject({ asset: "example_sales", rows: null, status: "unknown" });
    expect(findProblem(context.json, "DB_NOT_FOUND"), show(context)).toBeDefined();

    const query = await p.json(["query", "select count(*) from example_sales"]);
    expect(query.code, show(query)).toBe(2);
    const q = findProblem(query.json, "DB_NOT_FOUND")!;
    expect(q.message).toContain("warehouse.duckdb is missing: croft built it before");
    expect(q.message).not.toContain("nothing has run");
    expect(p.exists("warehouse.duckdb")).toBe(false);                    // no read-only command recreated it
  }, 60_000);
});
