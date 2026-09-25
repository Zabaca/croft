// A docs page for every code (DESIGN.md §9 "Each one has croft docs CODE"; §11 phase 5 "a docs page per code"). Every
// code in core/errors.ts has src/agent/docs/<CODE>.md, titled with the code, saying what the problem means, why it
// happens and what to do; `croft docs <CODE>` serves it (never the generated summary), and `croft docs --list` lists
// every code. agent/contract.test.ts checks every page for commands and flags this build lacks.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../cli/command.ts";
import { docs, DOCS_DIR } from "../cli/commands/docs.ts";
import { main } from "../cli/main.ts";
import { BUN_FLOOR } from "../cli/version.ts";
import { type Code, CODES } from "../core/errors.ts";
import { HTTP_DEFAULTS } from "../http/http.ts";
import { DEFAULT_LIMIT } from "../read/wire.ts";

const ALL = Object.keys(CODES) as Code[];

/** Pages from before phase 5 that say what to do in their own layout, without a "What to do" heading. */
const OWN_LAYOUT = new Set<Code>([
  "DUPLICATE_OUTPUT_COLUMN", "INGEST_CONFIG_CHANGED", "PIN_CHANGES_DATA", "LARGE_REPROCESS", "EDITED_SINCE_LAST_RUN",
  "SERVE_UNAUTHORIZED", "SCHEDULER_STALE", "UNKNOWN_TABLE", "SERVE_UNAVAILABLE",
]);

async function page(code: string): Promise<{ source: string; page: string; category: string; severity: string }> {
  return (await docs.run({ positionals: [code], values: {} } as unknown as Ctx)).data as { source: string; page: string; category: string; severity: string };
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("a docs page per code", () => {
  test("every registered code has src/agent/docs/<CODE>.md, titled with the code", async () => {
    const missing = ALL.filter((c) => !existsSync(join(DOCS_DIR, `${c}.md`)));
    expect(missing).toEqual([]);
    for (const code of ALL) {
      const d = await page(code);
      expect(d.source, code).toBe("file");
      expect(d.page, code).toMatch(new RegExp(`^# ${code}: \\S[^\\n]{8,}\\n\\n\\S`));
    }
  });

  test("each page says what to do", async () => {
    for (const code of ALL) {
      if (OWN_LAYOUT.has(code)) continue;
      expect((await page(code)).page, code).toMatch(/(^|\n)What to do/);
    }
  });

  test("a warning's or an info's title says so, and an error's does not", async () => {
    for (const code of ALL) {
      const d = await page(code);
      const title = d.page.split("\n")[0]!;
      // SCHEDULE_HELD's title says what the scheduler does; its page says that a held asset never fails a run.
      if (d.severity === "warning" && code !== "SCHEDULE_HELD") expect(title, code).toEndWith("(warning)");
      if (d.severity === "info") expect(title, code).toEndWith("(info)");
      if (d.severity === "error") expect(title, code).not.toMatch(/\((warning|info)\)/);
    }
  });

  test("a page that sends the agent to a destructive command says to ask the user first", async () => {
    for (const code of ALL) {
      const text = (await page(code)).page;
      if (/croft confirm|--rebuild|--allow-shrink|croft delete|croft restore <|rm -rf/.test(text)) expect(text, code).toMatch(/[Aa]sk\s+the\s+user|(the\s+user's|their)\s+explicit\s+yes/);
    }
  });

  test("the numbers a page states are this build's", async () => {
    expect((await page("BUN_TOO_OLD")).page).toContain(`Bun ${BUN_FLOOR} or newer`);
    expect((await page("QUERY_TOO_MANY_ROWS")).page).toContain(`${DEFAULT_LIMIT.toLocaleString("en-US")} rows by default`);
    expect((await page("HTTP_ERROR")).page).toContain(`up to ${HTTP_DEFAULTS.maxRetryAfterMs / 60_000} minutes`);
    expect(HTTP_DEFAULTS.retries).toBe(3);
    expect((await page("HTTP_ERROR")).page).toContain("three times with");
  });

  test("the pages are plain text: no fenced blocks, lines of at most 120 characters, no trailing spaces", () => {
    for (const code of ALL) {
      const text = readFileSync(join(DOCS_DIR, `${code}.md`), "utf8");
      expect(text.includes("```"), code).toBe(false);
      expect(text.endsWith("\n"), code).toBe(true);
      const long = text.split("\n").filter((l) => l.length > 120 || / $/.test(l));
      expect(long, code).toEqual([]);
    }
  });
});

describe("the CLI serves them", () => {
  const cli = async (args: string[]): Promise<{ exit: number; out: string }> => {
    const cwd = mkdtempSync(join(tmpdir(), "croft-code-pages-"));
    dirs.push(cwd);
    let out = "";
    const exit = await main(args, {
      cwd, env: { PATH: process.env.PATH, HOME: cwd, NO_COLOR: "1" }, stdout: (t) => { out += t; }, stderr: () => {},
      stdinTTY: false, stdoutTTY: false, stderrTTY: false,
    });
    return { exit, out };
  };

  test("croft docs --list --json lists every code", async () => {
    const r = await cli(["docs", "--list", "--json"]);
    expect(r.exit).toBe(0);
    const codes = (JSON.parse(r.out) as { data: { codes: { code: string }[] } }).data.codes.map((c) => c.code);
    expect(codes.sort()).toEqual([...ALL].sort());
  });

  test("croft docs <CODE> --json serves each code's page, in any case", async () => {
    for (const code of ALL) {
      const r = await cli(["docs", code.toLowerCase(), "--json"]);
      expect(r.exit, code).toBe(0);
      const d = (JSON.parse(r.out) as { data: { code: string; source: string; page: string } }).data;
      expect(d, code).toMatchObject({ code, source: "file" });
      expect(d.page.startsWith(`# ${code}: `), code).toBe(true);
    }
  });

  test("croft docs <CODE> prints the page after the code's category, severity and exit", async () => {
    const r = await cli(["docs", "HTTP_ERROR"]);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("HTTP_ERROR\n  category  run");
    expect(r.out).toContain("# HTTP_ERROR: ");
  });
});
