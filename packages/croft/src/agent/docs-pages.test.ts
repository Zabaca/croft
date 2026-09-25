// Phase 4's pages in `croft docs` (DESIGN.md §9: every code an agent meets has a page; §6 "Nothing implicit destroys
// ingested data", "Destructive operations need confirmation", "Trash, restore and delete"; §5 "Out-of-band
// changes"; §8 "Large first loads"). agent/contract.test.ts checks every page for commands and flags this build
// lacks; this file checks that phase 4's features have their pages, that the pages send the agent to the command
// each problem's fix names, that every destructive step in them goes through the user, and that no page still
// says a phase-4 feature is missing.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../cli/command.ts";
import { docs, DOCS_DIR } from "../cli/commands/docs.ts";
import type { Code } from "../core/errors.ts";
import { skillMd } from "./templates.ts";

async function page(name: string): Promise<{ source: string; page: string }> {
  return (await docs.run({ positionals: [name], values: {} } as unknown as Ctx)).data as { source: string; page: string };
}

/** Every page file shipped in src/agent/docs, by name. */
function files(): { name: string; text: string }[] {
  return readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md")).map((f) => ({ name: f.slice(0, -3), text: readFileSync(join(DOCS_DIR, f), "utf8") }));
}

/** Phase 4's codes an agent meets in a run, validate, status or doctor, each with a page of its own. */
const PHASE_4_CODES: Code[] = ["INGEST_CONFIG_CHANGED", "PIN_CHANGES_DATA", "ASSET_RENAMED", "EMPTY_EXTRACT", "OUT_OF_BAND_CHANGE"];

describe("phase 4's pages", () => {
  test("each phase-4 code has a page of its own, titled with the code", async () => {
    for (const code of PHASE_4_CODES) {
      const d = await page(code);
      expect(d.source, code).toBe("file");
      expect(d.page, code).toMatch(new RegExp(`^# ${code}: \\S`));
    }
  });

  test("the rename and trash topics are listed, each with a one-line summary", async () => {
    const list = (await docs.run({ positionals: [], values: { list: true } } as unknown as Ctx)).data as { topics: { name: string; summary: string; source: string }[] };
    const topics = new Map(list.topics.map((t) => [t.name, t]));
    for (const name of ["rename", "trash"]) {
      expect(topics.get(name), name).toMatchObject({ source: "file" });
      expect(topics.get(name)!.summary.length, name).toBeLessThanOrEqual(100);
    }
  });

  test("each page names the command its problem's fix names", async () => {
    const wants: [string, string[]][] = [
      ["ASSET_RENAMED", ["croft rename <old> <new>", "croft validate"]],
      ["INGEST_CONFIG_CHANGED", ["croft run <asset> --rebuild", "croft confirm <token>", "croft run <asset>"]],
      ["PIN_CHANGES_DATA", ["croft confirm <token>", "croft restore <asset>"]],
      ["EMPTY_EXTRACT", ["croft logs <asset>"]],
      ["OUT_OF_BAND_CHANGE", ["croft doctor", "croft preview <asset> --rebuild", "croft docs read-copy"]],
      ["rename", ["croft rename <old> <new>", "croft validate --json", "croft wait <runId>"]],
      ["trash", ["croft restore <table>", "croft delete <table>", "croft confirm <token>", ".croft/backups/"]],
      ["claude-permissions", ["croft run --rebuild", "croft delete", "croft restore", "--allow-shrink", "LARGE_REPROCESS"]],
    ];
    for (const [name, texts] of wants) {
      const text = (await page(name)).page;
      for (const t of texts) expect(text, `${name}: ${t}`).toContain(t);
    }
  });

  test("every destructive step a page describes waits for the user's yes", async () => {
    // croft confirm, --rebuild, croft delete and croft restore change or remove data (§6); a page that sends the
    // agent to one says to ask the user first.
    for (const name of [...PHASE_4_CODES, "rename", "trash", "ingest", "EDITED_SINCE_LAST_RUN", "transforms"]) {
      const text = (await page(name)).page;
      if (/croft confirm|--rebuild|croft delete|croft restore/.test(text)) expect(text, name).toMatch(/[Aa]sk the user/);
    }
  });

  test("the ingest topic says what an edit to an ingest with data does, and how a long first load is saved", async () => {
    const text = (await page("ingest")).page;
    for (const t of ["croft docs INGEST_CONFIG_CHANGED", "croft docs PIN_CHANGES_DATA", "croft docs rename", "croft run <name> --rebuild", "50,000 rows"]) {
      expect(text, t).toContain(t);
    }
  });
});

describe("no text says a phase-4 feature is missing", () => {
  // Phase 3's pages said "this version has no rebuild from scratch", "the table stays under the old name", "the
  // destructive actions of later versions": phase 4 ships rename, restore, delete, --rebuild and pre-upgrade backups.
  const STALE = /this version has no|this version cannot|not in this version|in this version: |until phase 4|phase 4|later versions?|stays under the old name|no rebuild from scratch/i;

  test("the docs pages", () => {
    const hits = files().flatMap((f) => f.text.split("\n").filter((l) => STALE.test(l)).map((l) => `${f.name}: ${l}`));
    expect(hits).toEqual([]);
  });

  test("SKILL.md (phase 5 has no This version section)", () => {
    expect(skillMd().split("\n").filter((l) => STALE.test(l))).toEqual([]);
  });
});
