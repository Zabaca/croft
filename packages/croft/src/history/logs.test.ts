import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { DEFAULT_TAIL_LINES, follow, logPath, openLog, tail } from "./logs.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "croft-logs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const redactSecret = (s: string) => s.replaceAll("sk_live_123", "[redacted]");

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of it) out.push(line);
  return out;
}

describe("paths", () => {
  test("logs live at <stateDir>/logs/<runId>/<asset>.log", () => {
    expect(logPath(dir, "r_0922_1015_k3f9", "github_issues")).toBe(join(dir, "logs", "r_0922_1015_k3f9", "github_issues.log"));
  });

  test("path segments that could escape the folder are refused", () => {
    for (const [run, asset] of [["../x", "a"], ["r_1", "../../etc/passwd"], ["r_1", "a/b"], ["", "a"], ["r_1", ".hidden"]]) {
      expect(() => logPath(dir, run!, asset!)).toThrow(CroftError);
    }
  });
});

describe("writer", () => {
  test("appends formatted lines, redacted, and ignores writes after close", () => {
    const log = openLog(dir, "r_0922_1015_k3f9", "orders", { redact: redactSecret });
    log.log("fetched", 3, "pages", { next: "cursor-1", nested: { deep: [1, 2] } });
    log.write("token sk_live_123 used");
    log.write("already terminated\n");
    log.write("two\nlines");
    log.close();
    log.write("late");
    log.close();
    const text = readFileSync(log.path, "utf8");
    expect(text).toBe(
      "fetched 3 pages { next: 'cursor-1', nested: { deep: [ 1, 2 ] } }\n" +
      "token [redacted] used\nalready terminated\ntwo\nlines\n",
    );
  });

  test("a second writer (a retry) appends to the same file", () => {
    const a = openLog(dir, "r_1", "orders");
    a.write("attempt 1");
    a.close();
    const b = openLog(dir, "r_1", "orders");
    b.write("attempt 2");
    b.close();
    expect(tail(b.path).lines).toEqual(["attempt 1", "attempt 2"]);
  });

  test("redaction sees the whole message, even across line breaks", () => {
    const log = openLog(dir, "r_1", "orders", { redact: (s) => s.replaceAll("abc\ndef", "[redacted]") });
    log.write("x abc\ndef y");
    log.close();
    expect(readFileSync(log.path, "utf8")).toBe("x [redacted] y\n");
  });
});

describe("tail", () => {
  const file = () => join(dir, "t.log");

  test("a missing file is empty and says so", () => {
    expect(tail(file())).toEqual({ lines: [], truncated: false, exists: false, size: 0 });
  });

  test("an empty file", () => {
    writeFileSync(file(), "");
    expect(tail(file())).toEqual({ lines: [], truncated: false, exists: true, size: 0 });
  });

  test("returns the last n lines and whether more exist, with or without a final newline", () => {
    writeFileSync(file(), "a\nb\nc\n");
    expect(tail(file(), 5)).toMatchObject({ lines: ["a", "b", "c"], truncated: false });
    expect(tail(file(), 3)).toMatchObject({ lines: ["a", "b", "c"], truncated: false });
    expect(tail(file(), 2)).toMatchObject({ lines: ["b", "c"], truncated: true, size: 6 });
    expect(tail(file(), 1)).toMatchObject({ lines: ["c"], truncated: true });
    expect(tail(file(), 0)).toMatchObject({ lines: [], truncated: true });
    writeFileSync(file(), "a\nb\nc");
    expect(tail(file(), 2)).toMatchObject({ lines: ["b", "c"], truncated: true });
    expect(tail(file(), 3)).toMatchObject({ lines: ["a", "b", "c"], truncated: false });
    writeFileSync(file(), "\n\nx\n");
    expect(tail(file(), 2)).toMatchObject({ lines: ["", "x"], truncated: true });
  });

  test("defaults to 200 lines and reads a long log across chunk boundaries", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"é".repeat(i % 50)}`);
    writeFileSync(file(), `${lines.join("\n")}\n`);
    const t = tail(file());
    expect(DEFAULT_TAIL_LINES).toBe(200);
    expect(t.lines).toEqual(lines.slice(-200));
    expect(t.truncated).toBe(true);
    expect(tail(file(), 4000).lines).toEqual(lines.slice(-4000));
    expect(tail(file(), 10_000)).toMatchObject({ truncated: false });
    expect(tail(file(), 10_000).lines).toEqual(lines);
  });

  test("can redact on the way out too", () => {
    writeFileSync(file(), "key sk_live_123\n");
    expect(tail(file(), 10, { redact: redactSecret }).lines).toEqual(["key [redacted]"]);
  });
});

describe("follow", () => {
  const file = () => join(dir, "f.log");

  test("yields existing and appended lines, and drains a partial last line when done", async () => {
    writeFileSync(file(), "one\ntwo\n");
    let done = false;
    setTimeout(() => appendFileSync(file(), "three\nfou"), 30);
    setTimeout(() => appendFileSync(file(), "r\nfive"), 60);
    setTimeout(() => { done = true; }, 120);
    const lines = await collect(follow(file(), { pollMs: 10, until: () => done }));
    expect(lines).toEqual(["one", "two", "three", "four", "five"]);
  });

  test("from 'end' skips what is already there; from a tail's size continues exactly", async () => {
    writeFileSync(file(), "old 1\nold 2\n");
    let done = false;
    setTimeout(() => { appendFileSync(file(), "new\n"); done = true; }, 30);
    expect(await collect(follow(file(), { from: "end", pollMs: 10, until: () => done }))).toEqual(["new"]);
    const t = tail(file(), 1);
    appendFileSync(file(), "after tail\n");
    expect(await collect(follow(file(), { from: t.size, until: () => true }))).toEqual(["after tail"]);
  });

  test("waits for the file to appear", async () => {
    let done = false;
    setTimeout(() => writeFileSync(file(), "hello\n"), 40);
    setTimeout(() => { done = true; }, 80);
    expect(await collect(follow(file(), { pollMs: 10, until: () => done }))).toEqual(["hello"]);
  });

  test("starts over after truncation", async () => {
    writeFileSync(file(), "a long first line\n");
    let done = false;
    setTimeout(() => writeFileSync(file(), "b\n"), 40);
    setTimeout(() => { done = true; }, 90);
    expect(await collect(follow(file(), { pollMs: 10, until: () => done }))).toEqual(["a long first line", "b"]);
  });

  test("a multi-byte character split across writes arrives whole", async () => {
    const bytes = Buffer.from("naïve ✓\n", "utf8");
    const cut = bytes.indexOf(0xe2) + 1;   // inside the 3-byte ✓
    writeFileSync(file(), bytes.subarray(0, cut));
    let done = false;
    setTimeout(() => { appendFileSync(file(), bytes.subarray(cut)); done = true; }, 30);
    expect(await collect(follow(file(), { pollMs: 5, until: () => done }))).toEqual(["naïve ✓"]);
  });

  test("an abort stops following at once", async () => {
    writeFileSync(file(), "x\n");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    expect(await collect(follow(file(), { pollMs: 10_000, signal: ac.signal }))).toEqual(["x"]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("redacts followed lines", async () => {
    writeFileSync(file(), "k=sk_live_123\n");
    expect(await collect(follow(file(), { until: () => true, redact: redactSecret }))).toEqual(["k=[redacted]"]);
  });

  test("an async until works", async () => {
    writeFileSync(file(), "x\n");
    expect(await collect(follow(file(), { until: async () => true }))).toEqual(["x"]);
  });
});
