// The leak guard (tests/leak-guard.ts, tests/file-guard.ts, the plugin in tests/preload.ts): what it counts as left behind, by tables of
// processes made up for the purpose, and then for real, in a `bun test` run of its own over throwaway test files in a temp folder: a
// file that leaves a child (or a detached grandchild running this checkout's code) fails by name and the child is killed; a file that
// stops what it started, or kills it without waiting for the exit, passes.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anotherRunHere, describeProc, descendantsOf, findLeaks, PACKAGE_ROOT, parseProcessTable, processTable, type Proc } from "./leak-guard.ts";

const p = (pid: number, ppid: number, command: string, stat = "S"): Proc => ({ pid, ppid, stat, command });
const SELF = 100;

describe("which processes count as left behind", () => {
  test("a descendant that was not there when the file loaded, at any depth; not one that was, not a zombie, not the test process", () => {
    const table = [p(SELF, 1, "bun test"), p(101, SELF, "postgres -D /tmp/x"), p(102, 101, "postgres: checkpointer"), p(103, SELF, "croft serve", "Z"), p(104, SELF, "old child"), p(200, 1, "unrelated")];
    const leaks = findLeaks(table, new Set([104]), SELF, "/repo/packages/croft");
    expect(leaks.map((x) => x.pid)).toEqual([101, 102]);
    expect(descendantsOf(SELF, table).map((x) => x.pid)).toEqual([101, 103, 104, 102]);
  });

  test("a reparented process running this checkout's code, unless a bun test run is among its ancestors; never another checkout's, never an unrelated one", () => {
    const root = "/repo/packages/croft";
    const table = [
      p(SELF, 1, "bun test --timeout 60000"),
      p(300, 1, `bun ${root}/bin/croft.mjs serve --port 0`),
      p(310, 1, "bun test --timeout 60000"), // another suite, running now
      p(311, 310, `bun ${root}/bin/croft.mjs serve --port 0`),
      p(320, 1, "bun /elsewhere/packages/croft/bin/croft.mjs serve"),
      p(330, 1, `tsserver /repo/node_modules/typescript/lib/tsserver.js ${root}/tsconfig.json`),
    ];
    expect(findLeaks(table, new Set(), SELF, root).map((x) => x.pid)).toEqual([300]);
  });

  test("the table is ps's, a command line with spaces kept whole", () => {
    expect(parseProcessTable("  12     1 Ss   /usr/sbin/cron -f\n 345   12 S+   bun test --timeout 60000 \n")).toEqual([p(12, 1, "/usr/sbin/cron -f", "Ss"), p(345, 12, "bun test --timeout 60000", "S+")]);
    expect(describeProc(p(7, 1, "x".repeat(500)))).toHaveLength("pid 7 (parent 1): ".length + 403);
  });
});

describe("a second suite in this checkout", () => {
  test("is seen by its working directory, and one elsewhere is not", async () => {
    const stand = (cwd: string) => Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)", "test"], { cwd, stdio: ["ignore", "ignore", "ignore"] });
    const here = stand(PACKAGE_ROOT);
    const away = stand(tmpdir());
    try {
      const seen = async (child: ReturnType<typeof stand>) => {
        // lsof can only name the directory once the process exists; poll until it can
        for (const end = Date.now() + 10_000; Date.now() < end; await Bun.sleep(50)) if (anotherRunHere(processTable().filter((p) => p.pid === child.pid), 1)) return true; // as seen by some other run: self 1 has no descendants here
        return false;
      };
      expect(await seen(here)).toBe(true);
      expect(anotherRunHere(processTable().filter((p) => p.pid === away.pid), 1)).toBe(false);
    } finally {
      here.kill("SIGKILL");
      away.kill("SIGKILL");
      await Promise.all([here.exited, away.exited]);
    }
  });
});

// A throwaway test run, with this package's preload (the guard) over files written for the occasion.
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function runFiles(files: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-leak-guard-")));
  dirs.push(dir);
  writeFileSync(join(dir, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(join(PACKAGE_ROOT, "tests", "preload.ts"))}]\n`);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const proc = Bun.spawn([process.execPath, "test", "--timeout", "60000"], {
    cwd: dir,
    // Bun 1.4 sets BUN_FEATURE_FLAG_NO_ORPHANS in the children of a `bun test --no-orphans` run, and every Bun process that has it kills what its own
    // children left behind when they exit: the fixtures here would be reaped before the guard looked, so the throwaway run is without it.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "BUN_FEATURE_FLAG_NO_ORPHANS")), CROFT_LEAK_GRACE_MS: "1500", CROFT_LEAK_GUARD_ORPHANS: "always", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: stdout + stderr };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Wait until a process is gone (the guard kills; the kernel needs a moment to reap). */
async function gone(pid: number): Promise<boolean> {
  for (const end = Date.now() + 5000; Date.now() < end; await Bun.sleep(25)) if (!alive(pid)) return true;
  return !alive(pid);
}

/** A fixture file that starts `sleep` as its child, reporting the pid on stdout as `CHILD <pid>`. */
const startsSleep = (after: string) => `import { afterAll, test, expect } from "bun:test";
let child: ReturnType<typeof Bun.spawn>;
test("starts a child", () => {
  child = Bun.spawn(["sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
  console.log("CHILD " + child.pid);
  expect(1).toBe(1);
});
${after}
`;

const pidOf = (out: string) => Number(/CHILD (\d+)/.exec(out)?.[1]);

describe("a test file that is run for real", () => {
  test("one that leaves its child running fails, by name, and the child is killed", async () => {
    const { code, out } = await runFiles({ "leaky.test.ts": startsSleep("") });
    expect(code, out).not.toBe(0);
    expect(out).toContain("leaky.test.ts left 1 process running after its last test");
    expect(out).toContain("sleep 300");
    expect(await gone(pidOf(out)), "the leaked child was killed").toBe(true);
  }, 90_000);

  test("one that stops its child in an afterAll passes (the guard is the last afterAll of the file), and so does a kill that is not awaited", async () => {
    const stops = await runFiles({ "stops.test.ts": startsSleep("afterAll(async () => { child.kill(); await child.exited; });") });
    expect(stops.code, stops.out).toBe(0);
    const kills = await runFiles({ "kills.test.ts": startsSleep("afterAll(() => { child.kill(); });") });
    expect(kills.code, kills.out).toBe(0);
    expect(await gone(pidOf(kills.out))).toBe(true);
  }, 90_000);

  test("a leak fails its own file only: the files before and after it pass, and the leaker is named among them", async () => {
    const quiet = (n: string) => `import { test, expect } from "bun:test";\ntest("${n}", () => { expect(1).toBe(1); });\n`;
    const { code, out } = await runFiles({ "a-before.test.ts": quiet("before"), "b-leaky.test.ts": startsSleep(""), "c-after.test.ts": quiet("after") });
    expect(code, out).not.toBe(0);
    expect(out).toContain("b-leaky.test.ts left 1 process running");
    expect(out).not.toContain("a-before.test.ts left");
    expect(out).not.toContain("c-after.test.ts left");
    expect(out).toMatch(/\n 3 pass\n/); // the three files' tests; the leak is the guard's own failure, under the leaking file
    expect(out).toMatch(/\n 1 fail\n/);
  }, 90_000);

  test("a grandchild that outlived its parent and runs this checkout's code is a leak too", async () => {
    const orphan = `import { test, expect } from "bun:test";
test("starts a detached grandchild", async () => {
  const marker = ${JSON.stringify(join(PACKAGE_ROOT, "tests", "orphan-marker"))};
  const middle = Bun.spawn([process.execPath, "-e", "const g = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)', process.argv[1]], { stdio: ['ignore', 'ignore', 'ignore'] }); console.log('GRANDCHILD ' + g.pid); g.unref();", marker], { stdout: "pipe" });
  const text = await new Response(middle.stdout).text();
  await middle.exited;
  console.log("CHILD " + /GRANDCHILD (\\d+)/.exec(text)![1]);
  expect(1).toBe(1);
});
`;
    const { code, out } = await runFiles({ "orphan.test.ts": orphan });
    expect(code, out).not.toBe(0);
    expect(out).toContain("orphan.test.ts left 1 process running");
    expect(out).toContain("orphan-marker");
    expect(await gone(pidOf(out)), "the orphan was killed").toBe(true);
  }, 90_000);
});
