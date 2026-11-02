// CI: are the programs the lake tests start or run as child processes installed? Postgres (the lake tests start it in the foreground), and
// pg_dump with pg_restore (the lake backup's tests run them). Prints where, or says what is missing and exits 1. It installs nothing and starts
// nothing (DESIGN.md D118: no OS services, no launchctl).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { findPgDump } from "../src/db/lake-backup.ts";
import { postgresBin } from "../src/db/mode-testkit.ts";

const bin = postgresBin();
if (!bin) {
  console.error("check-mode-tools: postgres, initdb and psql were not found (the lake profile's tests start Postgres in the foreground)");
  process.exit(1);
}
console.log(`postgres tools: ${bin}`);

const dump = findPgDump(process.env);
if (!dump || !existsSync(join(dirname(dump), "pg_restore"))) {
  console.error("check-mode-tools: pg_dump and pg_restore were not found (the lake backup's tests dump a catalog and restore it)");
  process.exit(1);
}
console.log(`pg_dump: ${dump}`);
