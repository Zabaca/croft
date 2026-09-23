// Asset console output (core/output.ts): each scope gets its own output, however deep its async work goes, and
// an import's top-level output goes to the import's sink. The CLI side (one --json envelope on stdout, the step
// log, redaction) is covered by tests/e2e/j14-asset-output.test.ts and the runner tests.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureImport, captureOutput, collectingSink, currentSink, guardImport } from "./output.ts";

const dir = mkdtempSync(join(tmpdir(), "croft-output-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("captureOutput", () => {
  test("console.* and direct stdout/stderr writes inside a scope go to its sink, across awaits and timers", async () => {
    const a = collectingSink();
    const b = collectingSink();
    const work = (name: string, sink: typeof a) => captureOutput(sink, async () => {
      console.log(name, "log", { n: 1 });
      await Bun.sleep(5);
      console.error(`${name} error`);
      console.warn(`${name} warn`);
      console.info(`${name} info`);
      console.debug(`${name} debug`);
      process.stdout.write(`${name} stdout\n`);
      process.stderr.write(`${name} stderr\n`);
      await new Promise<void>((r) => setTimeout(() => {
        console.log(`${name} timer`);
        r();
      }, 5));
      queueMicrotask(() => console.log(`${name} microtask`));
      await new Promise((r) => setImmediate(r));
    });
    await Promise.all([work("a", a), work("b", b)]);
    const expected = (n: string) => [`${n} log { n: 1 }`, `${n} error`, `${n} warn`, `${n} info`, `${n} debug`, `${n} stdout`, `${n} stderr`, `${n} timer`, `${n} microtask`];
    expect(a.lines).toEqual(expected("a"));
    expect(b.lines).toEqual(expected("b"));
    expect(currentSink()).toBeUndefined();
  });

  test("an async generator iterated inside the scope prints into it", async () => {
    const sink = collectingSink();
    async function* rows() {
      console.log("page 1");
      yield 1;
      await Bun.sleep(1);
      console.log("page 2");
      yield 2;
    }
    const got: number[] = [];
    await captureOutput(sink, async () => {
      for await (const r of rows()) got.push(r);
    });
    expect(got).toEqual([1, 2]);
    expect(sink.lines).toEqual(["page 1", "page 2"]);
  });

  test("count, time, assert, table and dir are captured too", async () => {
    const sink = collectingSink();
    await captureOutput(sink, async () => {
      console.count("x");
      console.count("x");
      console.assert(false, "bad", 1);
      console.assert(true, "fine");
      console.dir({ a: { b: 1 } });
      console.table([{ a: 1 }]);
      console.time("t");
      console.timeEnd("t");
    });
    expect(sink.lines.slice(0, 5)).toEqual(["x: 1", "x: 2", "Assertion failed: bad 1", "{ a: { b: 1 } }", "[ { a: 1 } ]"]);
    expect(sink.lines[5]).toMatch(/^t: \d+\.\d{3}ms$/);
  });
});

describe("captureImport", () => {
  test("a module's top-level output, before and after a top-level await, goes to the import's sink", async () => {
    const file = join(mkdtempSync(join(dir, "m-")), "noisy.ts");
    writeFileSync(file, `console.log("top", 1);\nprocess.stdout.write("direct\\n");\nawait Bun.sleep(5);\nconsole.error("after await");\nexport default 42;\n`);
    const sink = collectingSink();
    const mod = await captureImport(sink, () => import(file));
    expect(mod.default).toBe(42);
    expect(sink.lines).toEqual(["top 1", "direct", "after await"]);
  });

  test("guardImport keeps an outer capture's sink", async () => {
    const outer = collectingSink();
    const file = join(mkdtempSync(join(dir, "m-")), "inner.ts");
    writeFileSync(file, `console.log("inner top");\nexport default 1;\n`);
    await captureImport(outer, () => guardImport("assets/inner.ts", () => (t) => t, () => import(file)));
    expect(outer.lines).toEqual(["inner top"]);
  });
});
