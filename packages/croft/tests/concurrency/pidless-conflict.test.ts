// A lock error that names only a PID (DESIGN §5 "Foreign holders", "Lock conflicts"). While a lock holder is being
// killed, DuckDB cannot name its program and says "Conflicting lock is held in PID 812. However, …" [V: a READ_ONLY
// holder SIGKILLed while another process retried its lock gave it in 6 of 20 rounds]. croft serve hands the file to a
// writer exactly that way: it SIGKILLs its query worker. A writer that read such a conflict as a foreign program's
// withdrew its write intent at once, instead of after 2 s of a foreign holder: lockConflict found no PID, describe
// called a PID-less holder identified (known) and not croft, and the foreign clock, keyed on the PID, stayed at 0.
// That is the flake of tests/concurrency/serve.test.ts "a croft run blocked by a foreign program withdraws its
// intent…" (withdrawn 355–849 ms after the run started, under load).
//
// PRODUCT BUG (db/connect.ts lockConflict, db/warehouse.ts describe and its foreign clock), reported with its fix as
// a shared change: flip both test.failing() to test() with it.
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { lockConflict } from "../../src/db/connect.ts";

const PKG = resolve(import.meta.dir, "../..");

test.failing("lockConflict reads the PID when DuckDB cannot name the program (a holder being killed)", () => {
  const msg = 'IO Error: Could not set lock on file "/p/warehouse.duckdb": Conflicting lock is held in PID 812. However, you would be able to open this database in read-only mode, e.g. by using the -readonly parameter in the CLI';
  expect(lockConflict(new Error(msg))).toEqual({ path: "/p/warehouse.duckdb", program: null, pid: 812 });
});

// The fixture mocks db/connect.ts (openInstance fails five times with that error), which mock.module does for the
// whole process: so it runs in a `bun test` of its own.
test.failing("a writer keeps its intent announced through lock errors that name only a PID, then writes", async () => {
  const proc = Bun.spawn([process.execPath, "test", join(import.meta.dir, "pidless-conflict-fixture.ts")], {
    cwd: PKG, env: process.env, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, `${out}\n${err}`).toBe(0);
}, 60_000);
