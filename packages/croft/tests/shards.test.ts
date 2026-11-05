// CI runs the suite as N jobs each with a share of the test files (.github/workflows/ci.yml, DESIGN.md §10 "Test strategy", D191, D196):
// seven for a pull request's run of the whole suite, which scripts/shard-files.ts deals out by the seconds each file took, and as
// `bun test --shard=K/N` for the lake journeys (four and five) and the log run (two), and the same N over a list of files given on the command line
// (the pull request's run of the log, which names the files that touch the bookkeeping). The jobs only add up to the suite if every file lands in exactly one shard, so this runs Bun's own split on a folder of
// throwaway files, nested the way ours are, and checks that the shards partition them: none twice, none missing, none empty, and the
// split the same on a second ask. It guards the Bun that runs it (CI runs the floor and the latest), not croft.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dealByTime, readTimes, testFiles } from "../scripts/shard-files.ts";
import { fileSeconds } from "../scripts/shard-timings.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-shards-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FILES = ["a.test.ts", "b.test.ts", "src/c.test.ts", "src/d.test.ts", "src/deep/e.test.ts", "tests/f.test.ts", "tests/e2e/g.test.ts", "tests/e2e/h.test.ts", "tests/e2e/i.test.ts", "tests/j.test.ts", "k.test.ts"];
for (const f of FILES) {
  mkdirSync(join(dir, f, ".."), { recursive: true });
  writeFileSync(join(dir, f), `import { test } from "bun:test";\ntest(${JSON.stringify(f)}, () => {});\n`);
}

/** The files one shard ran, from its JUnit report. */
async function shard(k: number, n: number, only: string[] = []): Promise<string[]> {
  const report = join(dir, `shard-${k}-of-${n}.xml`);
  const proc = Bun.spawn([process.execPath, "test", `--shard=${k}/${n}`, "--reporter=junit", `--reporter-outfile=${report}`, ...only], { cwd: dir, env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, out + err).toBe(0);
  return [...readFileSync(report, "utf8").matchAll(/<testsuite name="([^"]+\.test\.ts)"/g)].map((m) => m[1]!).sort();
}

test("the shards of a run split the test files with none twice and none missing", async () => {
  for (const n of [2, 4, 7]) {
    const shards = await Promise.all(Array.from({ length: n }, (_, i) => shard(i + 1, n)));
    const all = shards.flat().sort();
    expect(all, `${n} shards: every file once`).toEqual([...FILES].sort());
    for (const [i, s] of shards.entries()) expect(s.length, `shard ${i + 1}/${n} has files`).toBeGreaterThan(0);
    expect(await Promise.all(Array.from({ length: n }, (_, i) => shard(i + 1, n))), `${n} shards: the same split on a second ask`).toEqual(shards);
  }
}, 180_000);

test("the shards of a run given a list of files split that list, as the pull request's run of the log does", async () => {
  const chosen = ["./a.test.ts", "./src/c.test.ts", "./src/deep/e.test.ts", "./tests/f.test.ts", "./tests/e2e/g.test.ts", "./tests/j.test.ts"];
  for (const n of [2, 4]) {
    const shards = await Promise.all(Array.from({ length: n }, (_, i) => shard(i + 1, n, chosen)));
    expect(shards.flat().sort(), `${n} shards: the listed files once each, and no other`).toEqual(chosen.map((f) => f.slice(2)).sort());
    for (const [i, s] of shards.entries()) expect(s.length, `shard ${i + 1}/${n} has files`).toBeGreaterThan(0);
  }
}, 90_000);

// D196: the pull request's seven shards are dealt by scripts/shard-files.ts. It finds the files itself, so it must find the ones Bun would, and
// it must be a partition whatever its table of times says.
test("the files the shard script finds are the files Bun runs, by name, in a tree with look-alikes Bun leaves out", async () => {
  const tree = realpathSync(mkdtempSync(join(tmpdir(), "croft-shard-files-")));
  try {
    const run = ["a.test.ts", "b_test.ts", "c.spec.ts", "d_spec.js", "e.test.tsx", "f.test.js", "g.test.mjs", "h.test.cjs", "j.test.mts", "sub/deep/k.test.ts"];
    const left = ["node_modules/x/z.test.ts", ".hid/h.test.ts", "sub/.dot/q.test.ts", "i.test.d.ts", "notes.ts", "test.json", "latest.ts"];
    for (const f of [...run, ...left]) {
      mkdirSync(join(tree, f, ".."), { recursive: true });
      writeFileSync(join(tree, f), `import { test } from "bun:test";\ntest(${JSON.stringify(f)}, () => {});\n`);
    }
    const report = join(tree, "report.xml");
    const proc = Bun.spawn([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${report}`], { cwd: tree, env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, out + err).toBe(0);
    const bunRan = [...readFileSync(report, "utf8").matchAll(/<testsuite name="([^"]+\.[a-z]+)"/g)].map((m) => m[1]!).filter((n) => /test|spec/.test(n)).sort();
    expect(testFiles(tree)).toEqual(bunRan);
    expect(bunRan).toEqual([...run].sort());
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}, 60_000);

test("the shard script finds this package's test files, and none under node_modules", () => {
  const found = testFiles(resolve(import.meta.dir, ".."));
  expect(found.length).toBeGreaterThan(100);
  expect(found).toContain("tests/shards.test.ts");
  expect(found.every((f) => !f.startsWith("node_modules/") && !f.includes("/node_modules/"))).toBe(true);
});

test("dealt by time, the shards are a partition of the files whatever the table says: none twice, none missing, a new file placed, a gone file ignored", () => {
  const files = Array.from({ length: 40 }, (_, i) => `src/f${String(i).padStart(2, "0")}.test.ts`);
  const table = { ...Object.fromEntries(files.slice(0, 30).map((f, i) => [f, (i % 7) * 10 + 1])), "src/gone.test.ts": 999 };
  for (const n of [1, 2, 4, 7]) {
    const shards = dealByTime(files, table, n);
    expect(shards.length).toBe(n);
    expect(shards.flat().sort(), `${n} shards`).toEqual([...files].sort());
    expect(dealByTime(files, table, n), `${n} shards: the same on a second ask`).toEqual(shards);
    for (const s of shards) expect(s, "each shard sorted").toEqual([...s].sort());
  }
  expect(dealByTime(files, {}, 7).flat().sort(), "no table at all").toEqual([...files].sort());
});

test("dealt by time, a few heavy files do not share a shard while the others have room, and the longest shard is near the mean", () => {
  const files = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((x) => `${x}.test.ts`);
  const table = Object.fromEntries(files.map((f, i) => [f, i < 3 ? 100 : 10]));
  const shards = dealByTime(files, table, 4);
  expect(shards.filter((s) => s.filter((f) => table[f] === 100).length > 1)).toEqual([]);
  const loads = shards.map((s) => s.reduce((a, f) => a + table[f]!, 0));
  expect(Math.max(...loads)).toBeLessThanOrEqual(110);
});

test("the committed table of times deals this package's files into seven shards within 10% of an even split, and every shard has files", () => {
  const pkg = resolve(import.meta.dir, "..");
  const files = testFiles(pkg);
  const table = readTimes();
  expect(Object.keys(table).length, "the table knows most of the files; refresh it with scripts/shard-timings.ts").toBeGreaterThan(files.length * 0.8);
  const shards = dealByTime(files, table, 7);
  const known = (s: string[]) => s.reduce((a, f) => a + (table[f] ?? 0), 0);
  const total = known(files);
  for (const [i, s] of shards.entries()) expect(s.length, `shard ${i + 1}`).toBeGreaterThan(0);
  expect(Math.max(...shards.map(known)), "the longest shard against an even split of the known seconds").toBeLessThanOrEqual((total / 7) * 1.1);
});

test("the seconds of a file are read from a job log: the time between its group header and the next, the last one to the summary line", () => {
  const log = [
    "2026-11-04T10:00:00.0000000Z bun test v1.3.14 (abc)",
    "2026-11-04T10:00:01.0000000Z ##[group]src/a.test.ts:",
    "2026-11-04T10:00:02.0000000Z (pass) a > x [10ms]",
    "2026-11-04T10:00:11.5000000Z ##[endgroup]",
    "2026-11-04T10:00:11.5000000Z ##[group]tests/e2e/b.test.ts:",
    "2026-11-04T10:00:41.5000000Z ##[endgroup]",
    "2026-11-04T10:00:41.5000000Z ##[group]src/c.spec.ts:",
    "2026-11-04T10:00:45.0000000Z  Ran 3 tests across 3 files. [44.00s]",
  ].join("\n");
  expect(fileSeconds(log)).toEqual({ "src/a.test.ts": 10.5, "tests/e2e/b.test.ts": 30, "src/c.spec.ts": 3.5 });
});

test("a list of ./ paths runs exactly those files, though another file's path holds the same name or a longer one", async () => {
  const names = ["a.test.ts", "sub/a.test.ts", "sub/ba.test.ts", "sub/a.test.ts.test.ts", "tests/e2e/a.test.ts"];
  for (const f of names) {
    mkdirSync(join(dir, "list", f, ".."), { recursive: true });
    writeFileSync(join(dir, "list", f), `import { test } from "bun:test";\ntest(${JSON.stringify(f)}, () => {});\n`);
  }
  for (const chosen of [["a.test.ts"], ["sub/a.test.ts", "tests/e2e/a.test.ts"], ["sub/ba.test.ts", "a.test.ts"]]) {
    const report = join(dir, "list-report.xml");
    const proc = Bun.spawn([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${report}`, ...chosen.map((f) => `./${f}`)], { cwd: join(dir, "list"), env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, out + err).toBe(0);
    const ran = [...readFileSync(report, "utf8").matchAll(/<testsuite name="([^"]+\.test\.ts)"/g)].map((m) => m[1]!).sort();
    expect(ran, chosen.join(" ")).toEqual([...chosen].sort());
  }
}, 60_000);
