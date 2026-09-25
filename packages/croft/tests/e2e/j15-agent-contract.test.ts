// The agent's side of phases 2 to 4, through the real CLI: what CLAUDE.md, the skill, croft docs and next[] tell an
// agent to run exists and works, and status, context and query tell one story when the warehouse file is gone.
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, findProblem, initProject, show, tempDir } from "./harness.ts";

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
    expect(commandsIn(loop)).toEqual(["croft validate --json", "croft preview <asset>", "croft run <asset>", 'croft query "..."']);
    const concrete: Record<string, string[]> = {
      "croft validate --json": ["validate"],                                // p.json adds --json
      "croft preview <asset>": ["preview", "example_sales"],
      "croft run <asset>": ["run", "example_sales"],
      'croft query "..."': ["query", "select count(*) AS n from example_sales"],
    };
    for (const c of commandsIn(loop)) {
      const r = await p.json(concrete[c]!);
      // croft preview is built alongside this test (phase 2, W2.3): until its module lands, the registered stub
      // answers INTERNAL_ERROR "PHASE_STUB". Once it has landed this branch is never taken.
      if (c.startsWith("croft preview") && (r.json.problems ?? []).some((q: { message?: string }) => q.message?.startsWith("PHASE_STUB"))) continue;
      expect(r.code, `${c}\n${show(r)}`).toBe(0);
    }
    expect((await p.rows("select count(*) AS n from example_sales"))[0]!.n).toBe(120);

    // Phase 5's croft new is where a new asset starts, in the skill and in the example asset, and it answers. The
    // skill has no "This version" section: this build lacks nothing the texts name.
    const skill = p.read(".claude/skills/croft/SKILL.md");
    expect(skill).not.toContain("## This version");
    const body = skill.slice(skill.indexOf("## Orient"));
    expect(body).toContain("1. New asset: `croft new api|file|sql|transform <name>`; edit the template, don't invent APIs.");
    expect(skill).toContain("`croft new --list`");
    expect(p.read("assets/example_sales.ts")).toContain("croft new file <name>");
    expect((await p.json(["help", "new"])).code).toBe(0);
    // Phase 4's commands are in the skill, and answer: rename (its recipe and the ask-first line), and every
    // destructive action behind croft confirm.
    expect(body).toContain("- Rename: croft rename <old> <new>; fix every reference it lists; validate; preview; run.");
    expect(body).toContain("- Renaming or deleting files in assets/ (use `croft rename`)");
    expect(body).toContain("rebuild of an ingest or incremental TS transform,\n  --allow-shrink, delete, restore, lossy pin changes, key conversion");
    for (const command of ["rename", "delete", "restore"]) expect((await p.json(["help", command])).code).toBe(0);
    for (const topic of ["rename", "trash", "ASSET_RENAMED", "INGEST_CONFIG_CHANGED", "PIN_CHANGES_DATA"]) {
      const page = await p.json(["docs", topic]);
      expect(page.code, show(page)).toBe(0);
      expect(page.json.data.source, topic).toBe("file");
    }
    // Phase 3's commands are in the skill, and answer: scheduling (ask first), croft serve (the user starts it)
    // and the read copy for GUIs.
    expect(body).toContain("`croft schedule on|off|pause`");
    expect(body).toContain("- `croft serve` runs until stopped: ask the user to start it in their own terminal");
    expect(body).toContain('set "readCopy": true in croft.json and open warehouse.read.duckdb');
    const home = tempDir("croft-home-");
    const schedule = await p.json(["schedule", "status"], { env: { HOME: home, CROFT_HOME: join(home, ".croft") } });
    expect(schedule.code, show(schedule)).toBe(0);
    expect(schedule.json.data.scheduling).toMatchObject({ state: "off" });
    for (const command of ["schedule", "serve"]) expect((await p.json(["help", command])).code).toBe(0);
    for (const topic of ["scheduling", "serve", "read-copy"]) {
      const page = await p.json(["docs", topic]);
      expect(page.code, show(page)).toBe(0);
      expect(page.json.data.source, topic).toBe("file");
    }
    expect(skill).toContain("croft run <asset> --dry-run --from -90d");
    // Nothing is missing from this build, so nothing in the skill says so.
    expect(skill).not.toContain("Not in this version");

    // The skill's pointers answer: the template pages, and the backfill recipe (a file ingest refuses --from with
    // BACKFILL_UNSUPPORTED, in the dry run as in the run; neither is an unknown flag).
    for (const topic of ["ingest", "sql", "transforms", "checks"]) {
      const page = await p.json(["docs", topic]);
      expect(page.code, show(page)).toBe(0);
      expect(page.json.data.source).toBe("file");
    }
    expect((await p.json(["docs", "ingest"])).json.data.page).toContain('incremental: { field: "created", unit: "s", lookback: "30 days" }');
    for (const args of [["run", "example_sales", "--dry-run", "--from", "-90d"], ["run", "example_sales", "--from", "-90d"]]) {
      const backfill = await p.json(args);
      expect(findProblem(backfill.json, "BACKFILL_UNSUPPORTED"), show(backfill)).toBeDefined();
      expect(findProblem(backfill.json, "USAGE_ERROR"), show(backfill)).toBeUndefined();
    }

    // croft docs' "what to do" and the empty-project next[] point at commands that exist; phase 2's codes have
    // pages of their own.
    const typeConflict = await p.croft(["docs", "TYPE_CONFLICT"]);
    expect(typeConflict.stdout).toContain("What to do:");
    const checkFailed = await p.json(["docs", "CHECK_FAILED"]);
    expect(checkFailed.json.data).toMatchObject({ code: "CHECK_FAILED", exit: 3, source: "file" });
    expect(checkFailed.json.data.page).toContain("croft run <asset>");
    const sqlSyntax = await p.croft(["docs", "SQL_SYNTAX"]);
    expect(sqlSyntax.stdout).toContain("croft validate --json");
    p.remove("assets/example_sales.ts");
    const empty = await p.json(["run"]);
    expect(empty.code, show(empty)).toBe(0);
    expect(empty.json.next).toEqual([{ command: "croft new --list", reason: "assets/ has no assets yet; start from a template" }]);
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
