// CI: is the program the lake tests start as a child process (Postgres) installed? Prints where, or says what is
// missing and exits 1. It installs nothing and starts nothing (DESIGN.md D118: no OS services, no launchctl).
import { postgresBin } from "../src/db/mode-testkit.ts";

const bin = postgresBin();
if (!bin) {
  console.error("check-mode-tools: postgres, initdb and psql were not found (the lake profile's tests start Postgres in the foreground)");
  process.exit(1);
}
console.log(`postgres tools: ${bin}`);
