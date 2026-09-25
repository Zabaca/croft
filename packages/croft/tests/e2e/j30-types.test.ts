// Journey 30: generated input types and `croft validate --types` (DESIGN.md §3e "The context API", §6 "Ways to try
// a change" 1, §11 phase 5), through the real CLI and the project's own tsc (node_modules/.bin/tsc, as `bun install`
// leaves it for the devDependencies croft init writes).
//   a. an ingest (croft new file), an SQL asset over it and a TS transform reading one of the SQL asset's columns
//      by name (newRows("open_issues"), typed by .croft/types). Before anything is built there are no row types;
//      a preview of the ingest writes its type, and validate --types the SQL asset's, from its code. After a run
//      .croft/types holds each asset's row type and the project's tsc passes; validate --types is ok.
//   b. the column is renamed in the SQL asset between them: plain validate is clean (the SQL binds), and before
//      any run validate --types reports UNKNOWN_INPUT_COLUMN at the transform's line, with a did-you-mean edit fix.
//      The fix, applied as written, passes, and the run after it works.
//   c. the same rename under a transform made by `croft new transform`, edited the way its comments say: only the
//      run catches it (bugTest: the template's own Input type bypasses the generated row types).
// Every --json envelope is checked against its published schema with the golden tests' validator.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { golden } from "../golden/kit.ts";
import { bugTest, cleanupAll, type Envelope, findProblem, initProject, linkTypescript, type Project, projectTsc, show, stepOf } from "./harness.ts";

afterAll(cleanupAll);

const ISSUES_CSV = `id,title,state,author
1,Crash on start,open,ada
2,Typo in the docs,closed,grace
3,Slow query,open,linus
4,Dark mode,open,
5,Broken link,closed,ken
`;

const OPEN_ISSUES = (author: string) => `-- description: Issues still open
-- key: id
SELECT id, title, ${author} FROM issues WHERE state = 'open'
`;

// The row type comes from the input's name: newRows("open_issues") is .croft/types' OpenIssuesRow once it exists.
const TRIAGE = `import { transform } from "@zabaca/croft";

export default transform({
  description: "Who looks at each open issue",
  inputs: ["open_issues"],
  key: "id",
  incremental: true,
  async *rows({ newRows }) {
    for await (const issue of newRows("open_issues")) {
      const owner = issue.author ?? "nobody";
      yield { id: issue.id, owner, title_length: String(issue.title).length };
    }
  },
});
`;

/** Apply an edit fix as an agent would: on its line, `from` becomes `to`. */
function applyFix(p: Project, fix: { file: string; line: number; replace: { from: string; to: string } }): void {
  const lines = p.read(fix.file).split("\n");
  const at = fix.line - 1;
  expect(lines[at], `line ${fix.line} of ${fix.file}`).toContain(fix.replace.from);
  lines[at] = lines[at]!.replace(fix.replace.from, fix.replace.to);
  p.write(fix.file, lines.join("\n"));
}

/** The runs croft recorded (croft status knows the last one of each asset). */
async function lastRuns(p: Project): Promise<Record<string, unknown>> {
  const s = golden("status", await p.croft(["status", "--json"])).data as Envelope;
  return Object.fromEntries((s.assets as { asset: string; lastRun?: { runId?: string } | null }[]).map((a) => [a.asset, a.lastRun?.runId ?? null]));
}

describe("a.–b. an ingest, an SQL asset and a TS transform reading its column", () => {
  let p: Project;
  beforeAll(async () => {
    p = (await initProject("typed")).project;
    linkTypescript(p);
  }, 120_000);

  test("a. after a run, .croft/types holds every asset's row type, the project's tsc passes, and validate --types is ok", async () => {
    const made = golden("new", await p.croft(["new", "file", "issues", "--json"]));
    expect(made.data).toMatchObject({ asset: "issues", kind: "file", created: ["assets/issues.ts", "files/issues/"] });
    p.write("files/issues/2026-09.csv", ISSUES_CSV);
    p.write("assets/open_issues.sql", OPEN_ISSUES("author"));
    p.write("assets/triage.ts", TRIAGE);

    // Before anything was built there are no row types, so tsc reads every input row as a Row, and passes.
    const cold = golden("validate", await p.croft(["validate", "--types", "--json"]));
    expect(cold.data.types).toEqual({ status: "ok", errors: 0 });
    expect(cold.problems.filter((x: { severity: string }) => x.severity !== "info")).toEqual([]);
    expect(existsSync(join(p.root, ".croft", "types", "open_issues.d.ts"))).toBe(false);

    // A preview of the ingest gives it columns: its row type is written, and validate --types derives the SQL
    // asset's from its code, so the transform is checked before any run.
    golden("preview", await p.croft(["preview", "issues", "--json"]));
    expect(p.read(".croft/types/issues.d.ts")).toContain("From the columns the last croft preview gave it");
    const previewed = golden("validate", await p.croft(["validate", "--types", "--json"]));
    expect(previewed.data.types).toEqual({ status: "ok", errors: 0 });
    expect(p.read(".croft/types/open_issues.d.ts")).toContain("  author: string | null;\n");

    const ran = await p.croft(["run", "--json"]);
    const env = golden("run", ran);
    for (const a of ["issues", "open_issues", "triage"]) expect(stepOf(env, a).status, show(ran)).toBe("ok");
    expect(stepOf(env, "triage").rows).toMatchObject({ total: 3 });

    const dir = join(p.root, ".croft", "types");
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["example_sales.d.ts", "index.d.ts", "issues.d.ts", "open_issues.d.ts", "triage.d.ts"]);
    const open = p.read(".croft/types/open_issues.d.ts");
    expect(open).toContain("  author: string | null;\n");
    expect(open).toMatch(/\n {2}id: number \| bigint;\n/);
    expect(p.read(".croft/types/index.d.ts")).toContain("open_issues");

    const tsc = await projectTsc(p);
    expect(tsc.code, tsc.out).toBe(0);
    const typed = golden("validate", await p.croft(["validate", "--types", "--json"]));
    expect(typed.data.types).toEqual({ status: "ok", errors: 0 });
    expect(typed.problems.filter((x: { severity: string }) => x.severity !== "info")).toEqual([]);
  }, 180_000);

  test("b. a column renamed in the SQL between them: UNKNOWN_INPUT_COLUMN with a did-you-mean edit fix, before any run; the fix passes", async () => {
    const runsBefore = await lastRuns(p);
    p.write("assets/open_issues.sql", OPEN_ISSUES("author AS author_name"));

    // The SQL itself binds: plain validate has nothing to say.
    const plain = golden("validate", await p.croft(["validate", "--json"]));
    expect(plain.problems.filter((x: { severity: string }) => x.severity !== "info")).toEqual([]);

    const r = await p.croft(["validate", "--types", "--json"]);
    const env = golden("validate", r, { exit: 2 });
    expect(env.data.types).toEqual({ status: "failed", errors: 1 });
    expect(env.problems.map((x: { code: string }) => x.code), show(r)).toEqual(["UNKNOWN_INPUT_COLUMN"]);
    const line = TRIAGE.split("\n").findIndex((l) => l.includes("issue.author")) + 1;
    const problem = findProblem(env, "UNKNOWN_INPUT_COLUMN")!;
    expect(problem).toMatchObject({
      severity: "error", asset: "triage", file: "assets/triage.ts", line,
      message: 'open_issues has no column "author"; did you mean "author_name"?',
      fix: { kind: "edit", file: "assets/triage.ts", line, replace: { from: "author", to: "author_name" } },
      details: { input: "open_issues", column: "author", suggestion: "author_name" },
    });
    expect(env.next).toEqual([{ command: "croft validate --types", reason: expect.any(String) }]);
    // For people: the same, with the fix.
    const human = await p.croft(["validate", "--types"]);
    expect(human.code).toBe(2);
    expect(human.stdout).toContain("UNKNOWN_INPUT_COLUMN");
    expect(human.stdout).toContain(`assets/triage.ts:${line}`);

    // Before any run: nothing ran, and the live table still has the old column.
    expect(await lastRuns(p)).toEqual(runsBefore);
    const live = golden("query", await p.croft(["query", "SELECT count(author) AS n FROM open_issues", "--json"]));
    expect(live.data.rows).toEqual([{ n: 2 }]);

    // The fix, as written.
    applyFix(p, problem.fix);
    expect(p.read("assets/triage.ts")).toContain("issue.author_name ?? \"nobody\"");
    const fixed = golden("validate", await p.croft(["validate", "--types", "--json"]));
    expect(fixed.data.types).toEqual({ status: "ok", errors: 0 });
    expect(fixed.problems.filter((x: { severity: string }) => x.severity !== "info")).toEqual([]);

    // The run: the SQL rebuilt with the new name, the transform reads it; the types follow, and tsc still passes.
    const ran = await p.croft(["run", "--json"]);
    const renv = golden("run", ran);
    expect(stepOf(renv, "open_issues").status, show(ran)).toBe("ok");
    expect(stepOf(renv, "triage").status, show(ran)).not.toBe("failed");
    expect(p.read(".croft/types/open_issues.d.ts")).toContain("  author_name: string | null;\n");
    expect(p.read(".croft/types/open_issues.d.ts")).not.toContain("  author: ");
    const tsc = await projectTsc(p);
    expect(tsc.code, tsc.out).toBe(0);
  }, 180_000);
});

describe("c. a transform made by croft new transform", () => {
  let p: Project;
  /** validate --types after the rename, before any run. */
  let typesAfterRename: Envelope | undefined;

  test("edited the way its comments say, it runs and passes tsc; after the rename, the run stops at the first row", async () => {
    p = (await initProject("typed-template")).project;
    linkTypescript(p);
    golden("new", await p.croft(["new", "file", "issues", "--json"]));
    p.write("files/issues/2026-09.csv", ISSUES_CSV);
    p.write("assets/open_issues.sql", OPEN_ISSUES("author"));
    // The asset changed most recently with a key is open_issues: the template reads it.
    const made = golden("new", await p.croft(["new", "transform", "triage", "--json"]));
    expect(made.data.reads).toBe("open_issues");
    // The edits its comments ask for: the Input type names the columns the code reads, and the result uses one.
    const file = "assets/triage.ts";
    expect(p.read(file)).toContain('newRows<Input>("open_issues")');
    p.edit(file, "type Input = { id: unknown };", "type Input = { id: number; author: string | null };");
    const result = p.read(file).split("\n").find((l) => l.includes("replace with what you compute for this row"))!;
    p.edit(file, result, '      const result = row.author ?? "nobody";');
    const ran = await p.croft(["run", "--json"]);
    expect(stepOf(golden("run", ran), "triage").status, show(ran)).toBe("ok");
    expect(p.read(".croft/types/open_issues.d.ts")).toContain("  author: string | null;\n");
    const tsc = await projectTsc(p);
    expect(tsc.code, tsc.out).toBe(0);

    p.write("assets/open_issues.sql", OPEN_ISSUES("author AS author_name"));
    const r = await p.croft(["validate", "--types", "--json"]);
    typesAfterRename = golden("validate", r, { exit: r.code ?? undefined });

    // What catches it today: the run, at the first row the transform reads (the runtime guard of §3e).
    const after = await p.croft(["run", "--json"]);
    const env = golden("run", after, { exit: after.code ?? undefined });
    expect(stepOf(env, "open_issues").status, show(after)).toBe("ok");
    expect(stepOf(env, "triage").status, show(after)).toBe("failed");
    expect(findProblem(env, "UNKNOWN_INPUT_COLUMN"), show(after)).toMatchObject({ asset: "triage", details: expect.objectContaining({ column: "author" }) });
  }, 180_000);

  // BUG (the transform template bypasses the generated row types): the croft new transform template reads its input
  // with an explicit row type, `newRows<Input>("open_issues")` over its own `type Input = { id: unknown }`, and an
  // explicit type argument picks the `newRows<T extends Row>(input: string)` overload, not the generated
  // OpenIssuesRow. So in a transform made the way croft tells an agent to make one, validate --types never sees a
  // column renamed upstream (types ok, no problem): tsc checks the code against the template's Input type, which
  // still says `author`. Only the run catches it, at the first row.
  bugTest("validate --types catches the rename in a template-made transform too (UNKNOWN_INPUT_COLUMN with the edit fix), before any run", () => {
    expect(typesAfterRename?.data.types).toEqual({ status: "failed", errors: 1 });
    expect(findProblem(typesAfterRename ?? {}, "UNKNOWN_INPUT_COLUMN")?.fix).toMatchObject({
      kind: "edit", file: "assets/triage.ts", replace: { from: "author", to: "author_name" },
    });
  });
});
