// Run by pidless-conflict.test.ts as its own `bun test` process, never by the suite (the name is no test file's):
// mock.module replaces db/connect.ts for the whole process it runs in.
//
// While a lock holder is being killed, DuckDB's lock error names only its PID: "Conflicting lock is held in PID 812.
// However, …" (no program, no parentheses) [V: a holder SIGKILLed while another process retried its lock, 6 of 20
// rounds]. croft serve hands the file to a writer exactly that way: it SIGKILLs its query worker. Such a conflict
// is no identified foreign program, so the writer's intent must stay announced (DESIGN §5 "Foreign holders":
// withdrawn only after 2 s of a foreign holder). Here openInstance fails that way for a few attempts, then works.
import { expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as connectModule from "../../src/db/connect.ts";

const realOpen = connectModule.openInstance;
/** Attempts still to fail with the PID-only lock error. */
let pidOnly = 0;
const PID = 999_999;
mock.module("../../src/db/connect.ts", () => ({
  ...connectModule,
  openInstance: async (...args: Parameters<typeof realOpen>) => {
    if (pidOnly > 0) {
      pidOnly--;
      throw new Error(`IO Error: Could not set lock on file "${args[0]}": Conflicting lock is held in PID ${PID}. However, you would be able to open this database in read-only mode, e.g. by using the -readonly parameter in the CLI. See also https://duckdb.org/docs/stable/connect/concurrency`);
    }
    return realOpen(...args);
  },
}));
const { openWarehouse } = await import("../../src/db/warehouse.ts");
const { listIntents } = await import("../../src/db/intent.ts");

test("a lock error naming only a PID (a holder being killed) keeps the write intent announced; the write goes ahead", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-pidless-")));
  const stateDir = join(root, ".croft");
  mkdirSync(join(root, "files"));
  mkdirSync(stateDir);
  const w = openWarehouse({
    path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir, isTTY: false, register: false,
    waits: { offTtyMs: 10_000 }, foreignWithdrawMs: 2000, foreignReannounceMs: 60_000,
  });
  // Five attempts fail (about 25 + 50 + 100 + 200 ms of backoff): well under the 2 s after which a foreign holder's
  // conflict withdraws the intent.
  pidOnly = 5;
  let withdrawn = false;
  let done = false;
  const write = w.write("pid-only conflicts", (tx) => tx.exec("CREATE TABLE t AS SELECT 1 AS a"), { runId: "r_pidless" }).finally(() => {
    done = true;
  });
  await Bun.sleep(1);
  while (!done) {
    if (pidOnly > 0 && listIntents(stateDir).length === 0) withdrawn = true;
    await Bun.sleep(2);
  }
  await write;
  expect(pidOnly).toBe(0);
  expect(withdrawn).toBe(false);
  expect(await w.read((sql) => sql.all("SELECT a FROM t"), { purpose: "check" })).toEqual([{ a: 1 }]);
  await w.close();
});
