import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { problem } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import type { Command } from "./command.ts";
import { main } from "./main.ts";
import {
  buildEnvelope, cellText, formatCount, formatDuration, formatNext, formatProblem, problemSummary, redactEnvelope,
  redactStrings, Render, table, tableFromObjects, toJsonLine, truncate, useColor,
} from "./render.ts";
import { CROFT_VERSION } from "./version.ts";

const META = { database: "warehouse.duckdb", timezone: "America/Los_Angeles" };

describe("envelope", () => {
  test("golden shape and key order", () => {
    const env = buildEnvelope({ command: "validate", data: { order: ["a"] }, ...META, durationMs: 612.4 });
    expect(Object.keys(env)).toEqual([
      "schemaVersion", "ok", "command", "croftVersion", "database", "timezone", "durationMs", "data", "problems", "next",
    ]);
    expect(env).toEqual({
      schemaVersion: 1, ok: true, command: "validate", croftVersion: CROFT_VERSION, database: "warehouse.duckdb",
      timezone: "America/Los_Angeles", durationMs: 612, data: { order: ["a"] }, problems: [], next: [],
    });
  });

  test("ok follows error problems unless set; warnings keep ok", () => {
    const err = problem("UNKNOWN_COLUMN", { message: "m", hint: "h" });
    const warn = problem("MIXED_TYPES", { message: "m", hint: "h" });
    expect(buildEnvelope({ command: "x", data: null, problems: [err], ...META, durationMs: 1 }).ok).toBe(false);
    expect(buildEnvelope({ command: "x", data: null, problems: [warn], ...META, durationMs: 1 }).ok).toBe(true);
    expect(buildEnvelope({ command: "status", data: null, problems: [err], ok: true, ...META, durationMs: 1 }).ok).toBe(true);
  });

  test("confirmation appears last and only when present", () => {
    const confirmation = {
      token: "c_7f3a9e", expiresAt: "2026-09-22T11:55:00-07:00", command: "croft confirm c_7f3a9e",
      impact: { asset: "taxi_zones", action: "replace", rows: 265, downstream: ["zone_trips"] },
    };
    const env = buildEnvelope({ command: "run", data: null, confirmation, ...META, durationMs: 1 });
    expect(Object.keys(env).at(-1)).toBe("confirmation");
    expect(env.confirmation).toEqual(confirmation);
    expect("confirmation" in buildEnvelope({ command: "run", data: null, ...META, durationMs: 1 })).toBe(false);
  });

  test("toJsonLine is one line; bigints are numbers when safe and strings beyond 2^53", () => {
    const line = toJsonLine({ a: 1n, b: 2n ** 60n, c: -(2n ** 53n), s: "multi\nline" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ a: 1, b: "1152921504606846976", c: "-9007199254740992", s: "multi\nline" });
  });

  test("redaction leaves structural fields alone", () => {
    // A .env holding LEVEL=info or MODE=error must not corrupt severity, code or docs.
    const redact = (s: string) => s.replace(/info|error|sk_live_123/g, (m) => `[redacted:${m === "sk_live_123" ? "KEY" : "X"}]`);
    const p: Problem = {
      ...problem("INPUT_NOT_BUILT", { message: "info about sk_live_123", hint: "error hint", details: { url: "x?k=sk_live_123" } }),
      fix: { kind: "command", description: "d", command: "croft preview sk_live_123" },
    };
    const env = redactEnvelope(buildEnvelope({
      command: "validate", data: { rows: [{ v: "sk_live_123" }], n: 5 }, problems: [p],
      next: [{ command: "croft x sk_live_123", reason: "error" }], ...META, durationMs: 1,
    }), redact);
    expect(env.problems[0]).toEqual({
      severity: "info", code: "INPUT_NOT_BUILT", message: "[redacted:X] about [redacted:KEY]", hint: "[redacted:X] hint",
      docs: "croft docs INPUT_NOT_BUILT", details: { url: "x?k=[redacted:KEY]" },
      fix: { kind: "command", description: "d", command: "croft preview [redacted:KEY]" },
    });
    expect(Object.keys(env.problems[0]!).slice(0, 5)).toEqual(["severity", "code", "message", "hint", "docs"]);
    expect(env.data as unknown).toEqual({ rows: [{ v: "[redacted:KEY]" }], n: 5, redactedValues: true });
    expect(env.next).toEqual([{ command: "croft x [redacted:KEY]", reason: "[redacted:X]" }]);
    expect(env.command).toBe("validate");
  });

  test("data uses the redactor's narrower data policy and says when it changed a value", () => {
    // PORT=5432, LOG_LEVEL=info, NODE_ENV=production are redacted from messages but not from query rows.
    const text = (s: string) => s.replace(/production|info|5432|sk_live_abc123/g, (m) => `[redacted:${m === "sk_live_abc123" ? "KEY" : "ENV"}]`);
    const redact = Object.assign(text, { data: (s: string) => s.replace(/sk_live_abc123/g, "[redacted:KEY]") });
    const note = "customer info: production order #5432";
    const env = redactEnvelope(buildEnvelope({
      command: "query", data: { rows: [{ note, key: "sk_live_abc123" }], rowCount: 1 },
      problems: [problem("QUERY_FAILED", { message: `bad value "${note}"`, hint: "h" })], ...META, durationMs: 1,
    }), redact);
    expect(env.data as unknown).toEqual({ rows: [{ note, key: "[redacted:KEY]" }], rowCount: 1, redactedValues: true });
    expect(env.problems[0]!.message).toBe('bad value "customer [redacted:ENV]: [redacted:ENV] order #[redacted:ENV]"');
    // Nothing redacted in data: no flag.
    const clean = redactEnvelope(buildEnvelope({ command: "query", data: { rows: [{ note }] }, ...META, durationMs: 1 }), redact);
    expect(clean.data).toEqual({ rows: [{ note }] });
    // Data that is not an object cannot carry the flag but is still redacted.
    expect(redactEnvelope(buildEnvelope({ command: "x", data: ["sk_live_abc123"], ...META, durationMs: 1 }), redact).data)
      .toEqual(["[redacted:KEY]"]);
  });

  test("redactStrings keeps a __proto__ key as a key", () => {
    const v = JSON.parse('{"__proto__": {"x": "secret1"}, "a": ["secret1"]}');
    const out = redactStrings(v, (s) => s.replace("secret1", "[redacted:S]"));
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"x":"[redacted:S]"},"a":["[redacted:S]"]}');
  });
});

describe("Render", () => {
  function capture(json: boolean) {
    const out: string[] = [];
    const err: string[] = [];
    const r = new Render({ json, stdout: (t) => out.push(t), stderr: (t) => err.push(t), stdoutTTY: false, stderrTTY: false, env: {} });
    return { r, out, err };
  }

  test("JSON mode: human text and progress go to stderr, stdout gets one envelope", () => {
    const { r, out, err } = capture(true);
    r.out("human text");
    r.progress("fetching…");
    r.envelope(buildEnvelope({ command: "x", data: 1, ...META, durationMs: 0 }));
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).data).toBe(1);
    expect(err).toEqual(["human text\n", "fetching…\n"]);
    expect(() => r.envelope(buildEnvelope({ command: "x", data: 2, ...META, durationMs: 0 }))).toThrow(/second envelope/);
  });

  test("an envelope that fails to serialize does not use up the one envelope", () => {
    const { r, out } = capture(true);
    class Opaque { toJSON(): never { throw new Error("cannot serialize"); } }
    expect(() => r.envelope(buildEnvelope({ command: "x", data: { v: new Opaque() }, ...META, durationMs: 0 }))).toThrow("cannot serialize");
    expect(out).toEqual([]);
    r.envelope(buildEnvelope({ command: "x", data: null, ok: false, ...META, durationMs: 0 }));
    expect(out).toHaveLength(1);
  });

  test("main: unserializable data still prints exactly one envelope (INTERNAL_ERROR)", async () => {
    class Opaque { toJSON(): never { throw new Error("cannot serialize"); } }
    const cmd: Command = { name: "opaque", summary: "s", usage: "croft opaque", options: {}, run: async () => ({ data: { v: new Opaque() }, problems: [], next: [] }) };
    const out: string[] = [];
    const exit = await main(["opaque", "--json"], {
      cwd: tmpdir(), env: {}, commands: [cmd], stdinTTY: false, stdoutTTY: false, stderrTTY: false, stdout: (t) => out.push(t), stderr: () => {},
    });
    expect(exit).toBe(1);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, command: "opaque", problems: [{ code: "INTERNAL_ERROR" }] });
  });

  test("human mode: out goes to stdout, redacted", () => {
    const { r, out, err } = capture(false);
    r.redact = (s) => s.replace("secretvalue", "[redacted:K]");
    r.out("token secretvalue");
    r.progress("p");
    expect(out).toEqual(["token [redacted:K]\n"]);
    expect(err).toEqual(["p\n"]);
  });

  test("colors only on a TTY without NO_COLOR", () => {
    expect(useColor(true, {})).toBe(true);
    expect(useColor(true, { NO_COLOR: "1" })).toBe(false);
    expect(useColor(true, { NO_COLOR: "" })).toBe(true);
    expect(useColor(false, {})).toBe(false);
    const r = new Render({ json: false, stdout: () => {}, stderr: () => {}, stdoutTTY: true, stderrTTY: false, env: {} });
    expect(r.color).toBe(true);
    expect(r.errColor).toBe(false);
    expect(r.style.bold("x")).toBe("\x1b[1mx\x1b[22m");
  });
});

describe("tables", () => {
  test("aligned like the §4.2 query example", () => {
    const t = table(["state", "n"], [["open", "1,204"], ["closed", "17,352"]]);
    expect(t.text).toBe(["state    n", "open     1,204", "closed   17,352"].join("\n"));
    expect(t).toMatchObject({ shownRows: 2, hiddenRows: 0, truncatedValues: 0 });
  });

  test("50-row cap with a note on how to see more", () => {
    const rows = Array.from({ length: 60 }, (_, i) => [i]);
    const t = table(["i"], rows);
    const lines = t.text.split("\n");
    expect(lines).toHaveLength(1 + 50 + 1);
    expect(lines.at(-1)).toBe("(50 of 60 rows shown; --limit N shows more)");
    expect(t.hiddenRows).toBe(10);
    expect(table(["i"], rows.slice(0, 3), { total: 1204, moreRows: "--limit 1204" }).text.split("\n").at(-1))
      .toBe("(3 of 1,204 rows shown; --limit 1204 shows more)");
    expect(table(["i"], rows, { limit: Infinity }).hiddenRows).toBe(0);
  });

  test("values are cut to 80 characters with a note", () => {
    const long = "x".repeat(200);
    const t = table(["v", "w"], [[long, "short"]]);
    const [, row, note] = t.text.split("\n");
    expect(row!.startsWith("x".repeat(79) + "…   short")).toBe(true);
    expect(note).toBe("(values cut to 80 characters; --full-values shows them whole)");
    expect(t.truncatedValues).toBe(1);
  });

  test("wide characters align by display width", () => {
    const t = table(["name", "n"], [["日本", 1], ["abcd", 2]]);
    expect(t.text.split("\n")).toEqual(["name   n", "日本   1", "abcd   2"]);
    expect(truncate("日本語テキスト", 7)).toEqual({ text: "日本語…", cut: true });
  });

  test("cell rendering", () => {
    expect(cellText(null)).toBe("NULL");
    expect(cellText(undefined)).toBe("");
    expect(cellText("a\nb\tc")).toBe("a\\nb c");
    expect(cellText(12n)).toBe("12");
    expect(cellText({ k: [1, 2n] })).toBe('{"k":[1,2]}');
    expect(cellText(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
  });

  test("tableFromObjects uses first-seen column order", () => {
    expect(tableFromObjects([{ a: 1, b: 2 }, { c: 3, a: 4 }]).text).toBe(["a   b   c", "1   2", "4       3"].join("\n"));
  });
});

describe("problem blocks", () => {
  test("§4.2 UNKNOWN_COLUMN with an edit fix", () => {
    const p = problem("UNKNOWN_COLUMN", {
      message: 'Referenced column "creatd_at" not found in github_issues. Candidate bindings: "created_at"',
      hint: 'did you mean "created_at"?', asset: "open_issues", file: "assets/open_issues.sql", line: 9, column: 3,
      fix: { kind: "edit", description: "fix the column name", file: "assets/open_issues.sql", line: 9, replace: { from: "creatd_at", to: "created_at" } },
    });
    expect(formatProblem(p)).toBe([
      "error UNKNOWN_COLUMN  assets/open_issues.sql:9:3",
      '      Referenced column "creatd_at" not found in github_issues. Candidate bindings: "created_at"',
      "      fix: replace creatd_at with created_at on line 9",
    ].join("\n"));
  });

  test("§4.2 INPUT_NOT_BUILT info with a next command", () => {
    const p = problem("INPUT_NOT_BUILT", {
      message: "columns of stripe_charges are unknown until it has run or been previewed; bind check skipped",
      hint: "run croft preview stripe_charges", file: "assets/daily_revenue.sql",
      fix: { kind: "command", description: "preview the input", command: "croft preview stripe_charges" },
    });
    expect(formatProblem(p)).toBe([
      "info  INPUT_NOT_BUILT  assets/daily_revenue.sql",
      "      columns of stripe_charges are unknown until it has run or been previewed; bind check skipped",
      "      next: croft preview stripe_charges",
    ].join("\n"));
  });

  test("§4.2 QUERY_NOT_SELECT without a location puts the message on the first line", () => {
    const p = problem("QUERY_NOT_SELECT", {
      message: "query runs exactly one SELECT (DESCRIBE, SUMMARIZE and SHOW also work)",
      hint: "to export, put the SELECT in an asset or pipe --json output; exports are post-v1",
    });
    expect(formatProblem(p)).toBe([
      "error QUERY_NOT_SELECT  query runs exactly one SELECT (DESCRIBE, SUMMARIZE and SHOW also work)",
      "      hint: to export, put the SELECT in an asset or pipe --json output; exports are post-v1",
    ].join("\n"));
  });

  test("warnings, multi-line messages, effects, and a hint that adds to a command fix", () => {
    const p = problem("SHRINK_GUARD", {
      message: "would remove 265 of 265 rows\nthe API returned nothing", hint: "did you mean to pass --allow-shrink?",
      asset: "taxi_zones", effect: "nothing was written",
      fix: { kind: "command", description: "override", command: "croft run taxi_zones --allow-shrink", requiresHuman: true },
    });
    expect(formatProblem(p)).toBe([
      "error SHRINK_GUARD  taxi_zones",
      "      would remove 265 of 265 rows",
      "      the API returned nothing",
      "      hint: did you mean to pass --allow-shrink?",
      "      fix: croft run taxi_zones --allow-shrink (ask the user to run it in their terminal)",
      "      effect: nothing was written",
    ].join("\n"));
    const w = problem("ENV_FILE_IGNORED", { message: ".env.local is ignored", hint: "move it", file: ".env.local", fix: { kind: "manual", description: "d" } });
    expect(formatProblem(w)).toBe("warn  ENV_FILE_IGNORED  .env.local\n      .env.local is ignored\n      fix: move it");
  });

  test("colored labels", () => {
    const p = problem("MIXED_TYPES", { message: "m", hint: "h" });
    expect(formatProblem(p, true)).toContain("\x1b[33mwarn \x1b[39m");
    expect(formatProblem(p, false)).not.toContain("\x1b");
  });

  test("summary and next lines", () => {
    const ps = [problem("UNKNOWN_COLUMN", { message: "", hint: "" }), problem("INPUT_NOT_BUILT", { message: "", hint: "" })];
    expect(problemSummary(ps)).toBe("1 error, 0 warnings, 1 info");
    expect(problemSummary([])).toBe("0 errors, 0 warnings");
    expect(formatNext([{ command: "croft validate", reason: "re-check after the edit" }])).toBe("next: croft validate  # re-check after the edit");
  });
});

describe("numbers and durations", () => {
  test("formatCount", () => {
    expect(formatCount(18342)).toBe("18,342");
    expect(formatCount(12345678901234567890n)).toBe("12,345,678,901,234,567,890");
  });

  test("formatDuration", () => {
    expect(formatDuration(9)).toBe("9 ms");
    expect(formatDuration(41_234)).toBe("41.2 s");
    expect(formatDuration(59_990)).toBe("1 min");
    expect(formatDuration(200_000)).toBe("3 min 20 s");
    expect(formatDuration(7_500_000)).toBe("2 h 5 min");
  });
});
