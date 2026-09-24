// A writer that measures when the warehouse is really free (DESIGN.md §5 "Write intents", "Handing the file over").
// It announces itself exactly as db/warehouse.ts does (db/intent.ts: <state>/write-intent.d/<pid>-<start>.json),
// then tries the lock every 5 ms through db/connect.ts, so the time it gets the file is when the holder let go, not
// when a backoff happened to retry. It writes a row, holds the file, closes it, and only then removes its intent.
//
// Usage: bun probe-writer-testkit.ts <database> <stateDir> <label> <holdMs | "stdin">
//   holdMs "stdin": hold until a line arrives on stdin (the test decides when the writer lets go).
//   START_AT=<epoch ms>: announce the intent at that moment (several writers at once).
//   RETRY_MS=<ms>: retry the lock this often instead of every 5 ms (a writer that is slow to try again, like
//   warehouse.ts's backoff of up to 1 s: whoever it waits behind must keep the file closed for it meanwhile).
//   PROBE_SQL=<JSON array of statements>: run these too once the file is held (change what readers will see).
// Prints one JSON line per event, with t = Date.now() in this process:
//   {"event":"intent","t":…,"since":"<the intent's since>"}  {"event":"acquired","t":…,"attempts":n}
//   {"event":"released","t":…}
import { lockConflict, openInstance } from "../../src/db/connect.ts";
import { acquire, release } from "../../src/db/intent.ts";

const [path, stateDir, label, hold] = process.argv.slice(2);
if (!path || !stateDir || !label || !hold) {
  console.error("usage: bun probe-writer-testkit.ts <database> <stateDir> <label> <holdMs|stdin>");
  process.exit(2);
}
const say = (event: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, t: Date.now(), ...extra }));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const startAt = Number(process.env.START_AT ?? 0);
while (Date.now() < startAt) await sleep(1);

const intent = acquire(stateDir, { runId: label });
say("intent", { since: intent.since });
let attempts = 0;
let instance;
for (;;) {
  attempts++;
  try {
    instance = (await openInstance(path, "read_write")).instance;
    break;
  } catch (e) {
    if (!lockConflict(e)) throw e;
    await sleep(Number(process.env.RETRY_MS ?? 5));
  }
}
say("acquired", { attempts });
const c = await instance.connect();
await c.run("CREATE TABLE IF NOT EXISTS probe_log (who VARCHAR, stamp BIGINT)");
await c.run(`INSERT INTO probe_log VALUES ('${label.replace(/'/g, "''")}', ${Date.now()})`);
for (const sql of JSON.parse(process.env.PROBE_SQL ?? "[]") as string[]) await c.run(sql);
if (hold === "stdin") {
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
    process.stdin.once("end", () => resolve());
  });
} else {
  await sleep(Number(hold));
}
c.disconnectSync();
instance.closeSync();
release(stateDir); // only after closeSync(), as warehouse.ts does
say("released");
process.exit(0);
