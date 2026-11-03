// CI runs the full suite as `bun test --shard=K/N`, N jobs each with a share of the test files (.github/workflows/ci.yml, DESIGN.md §10
// "Test strategy"). The jobs only add up to the suite if every file lands in exactly one shard, so this runs Bun's own split on a folder of
// throwaway files, nested the way ours are, and checks that the shards partition them: none twice, none missing, none empty, and the
// split the same on a second ask. It guards the Bun that runs it (CI runs the floor and the latest), not croft.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-shards-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FILES = ["a.test.ts", "b.test.ts", "src/c.test.ts", "src/d.test.ts", "src/deep/e.test.ts", "tests/f.test.ts", "tests/e2e/g.test.ts", "tests/e2e/h.test.ts", "tests/e2e/i.test.ts", "tests/j.test.ts", "k.test.ts"];
for (const f of FILES) {
  mkdirSync(join(dir, f, ".."), { recursive: true });
  writeFileSync(join(dir, f), `import { test } from "bun:test";\ntest(${JSON.stringify(f)}, () => {});\n`);
}

/** The files one shard ran, from its JUnit report. */
async function shard(k: number, n: number): Promise<string[]> {
  const report = join(dir, `shard-${k}-of-${n}.xml`);
  const proc = Bun.spawn([process.execPath, "test", `--shard=${k}/${n}`, "--reporter=junit", `--reporter-outfile=${report}`], { cwd: dir, env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, out + err).toBe(0);
  return [...readFileSync(report, "utf8").matchAll(/<testsuite name="([^"]+\.test\.ts)"/g)].map((m) => m[1]!).sort();
}

test("the shards of a run split the test files with none twice and none missing", async () => {
  for (const n of [2, 3]) {
    const shards = await Promise.all(Array.from({ length: n }, (_, i) => shard(i + 1, n)));
    const all = shards.flat().sort();
    expect(all, `${n} shards: every file once`).toEqual([...FILES].sort());
    for (const [i, s] of shards.entries()) expect(s.length, `shard ${i + 1}/${n} has files`).toBeGreaterThan(0);
    expect(await Promise.all(Array.from({ length: n }, (_, i) => shard(i + 1, n))), `${n} shards: the same split on a second ask`).toEqual(shards);
  }
}, 90_000);
