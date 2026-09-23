// Asset console output (core/output.ts): each scope gets its own output, however deep its async work goes, and
// an import's top-level output goes to the import's sink. The CLI side (one --json envelope on stdout, the step
// log, redaction) is covered by tests/e2e/j14-asset-output.test.ts and the runner tests.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { spawnSync } from "node:child_process";
import { captureImport, captureOutput, collectingSink, currentSink, guardImport } from "./output.ts";

const dir = mkdtempSync(join(tmpdir(), "croft-output-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run a script that imports this module in its own bun process (fd-level capture changes the process's fds). */
async function script(body: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const file = join(mkdtempSync(join(dir, "s-")), "script.ts");
  writeFileSync(file, `import * as out from ${JSON.stringify(join(import.meta.dir, "output.ts"))};\nimport { $ } from "bun";\n${body}\n`);
  const proc = Bun.spawn([process.execPath, "--no-env-file", file], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir() }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, code: await proc.exited };
}

// Subprocesses (Bun Shell `$` prints by default; Bun.spawn / child_process with inherited stdio) and
// Bun.write(Bun.stdout) write to fds 1 and 2 directly, past console and process.stdout.
describe("captureOutput: file descriptors 1 and 2", () => {
  test("a subprocess, Bun Shell and Bun.write(Bun.stdout) inside a scope print into its sink", async () => {
    const sink = collectingSink();
    await captureOutput(sink, async () => {
      await $`echo shell says ${"hi there"}`;
      await $`sh -c ${"echo shell stderr >&2"}`;
      await Bun.spawn(["echo", "spawned"], { stdio: ["ignore", "inherit", "inherit"] }).exited;
      spawnSync("sh", ["-c", "echo spawnSync"], { stdio: "inherit" });
      await Bun.write(Bun.stdout, "bun write stdout\n");
      await Bun.write(Bun.stderr, "bun write stderr\n");
    });
    expect(sink.lines.join("\n").split("\n")).toEqual(["shell says hi there", "shell stderr", "spawned", "spawnSync", "bun write stdout", "bun write stderr"]);
  });

  test("croft's own writes go to the real stdout; fds are restored when the last capture ends", async () => {
    const r = await script(`
      const sink = out.collectingSink();
      await out.captureOutput(sink, async () => {
        await $\`echo inside\`;
        out.outsideCapture(() => process.stdout.write("croft's own line\\n"));
      });
      process.stderr.write("sink=" + JSON.stringify(sink.lines) + "\\n");
      await $\`echo after\`;
    `);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("croft's own line\nafter\n");
    expect(r.stderr).toContain('sink=["inside"]');
  });

  test("with steps running at once, fd output goes to stderr, redacted, never to stdout", async () => {
    const r = await script(`
      out.setOutputRedactor((t) => t.replaceAll("sk_live_123456", "[redacted:KEY]"));
      const a = out.collectingSink(), b = out.collectingSink();
      await Promise.all([
        out.captureOutput(a, async () => { await Bun.sleep(30); await $\`echo from a sk_live_123456\`; await Bun.sleep(60); }),
        out.captureOutput(b, async () => { await Bun.sleep(60); }),
      ]);
      process.stdout.write(JSON.stringify({ a: a.lines, b: b.lines }) + "\\n");
    `);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ a: [], b: [] });
    expect(r.stderr).toContain("from a [redacted:KEY]");
    expect(r.stderr).not.toContain("sk_live_123456");
  });

  test("in croft's own process, a subprocess that outlives its step still cannot reach stdout", async () => {
    const r = await script(`
      out.keepFdsCaptured();
      out.setOutputRedactor((t) => t.replaceAll("sk_live_123456", "[redacted:KEY]"));
      await out.captureOutput(out.collectingSink(), async () => {
        Bun.spawn(["sh", "-c", "sleep 0.2; echo late sk_live_123456; echo late stderr >&2"], { stdio: ["ignore", "inherit", "inherit"] });
        setTimeout(() => void Bun.write(Bun.stdout, "timer sk_live_123456\\n"), 100);
      });
      await Bun.sleep(500);
      process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
      await $\`printf 'no newline at exit'\`;
    `);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe('{"ok":true}\n');
    expect(r.stderr).toContain("late [redacted:KEY]");
    expect(r.stderr).toContain("late stderr");
    expect(r.stderr).toContain("timer [redacted:KEY]");
    expect(r.stderr).toContain("no newline at exit");
    expect(r.stderr).not.toContain("sk_live_123456");
  });

  test("a lot of output arrives whole, and the capture file starts over once it is read and quiet", async () => {
    const r = await script(`
      const { fstatSync } = await import("node:fs");
      const sink = out.collectingSink();
      let size = -1;
      await out.captureOutput(sink, async () => {
        await Bun.spawn(["sh", "-c", "yes line-${"x".repeat(94)} | head -n 50000"], { stdio: ["ignore", "inherit", "inherit"] }).exited;
        await Bun.sleep(400);
        size = fstatSync(1).size;   // fd 1 is the capture file here
        await $\`echo after\`;
      });
      const lines = sink.lines.join("\\n").split("\\n");
      process.stdout.write(JSON.stringify({ n: lines.length, first: lines[0], last: lines.at(-1), size }) + "\\n");
    `);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ n: 50_001, first: `line-${"x".repeat(94)}`, last: "after", size: 0 });
  });

  test("a subprocess started at an import's top level goes to the import's sink", async () => {
    const file = join(mkdtempSync(join(dir, "m-")), "shell.ts");
    writeFileSync(file, `import { $ } from "bun";\nawait $\`echo top-level shell\`;\nexport default 7;\n`);
    const sink = collectingSink();
    const mod = await captureImport(sink, () => import(file));
    expect(mod.default).toBe(7);
    expect(sink.lines).toEqual(["top-level shell"]);
  });
});

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
