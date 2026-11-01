// One refresh of the read copy, in a process of its own (DESIGN.md D119): `bun --no-env-file refresh-child.ts <project root>`.
// croft serve in server mode never opens the live file, so when it finds the copy missing, behind or failed (serve/copy-maker.ts)
// it starts this, as the scheduler's ticks start `croft tick`. It runs db/readcopy.ts's refreshReadCopy: the same
// write intent, lease, checkpoint, clone and rename as a run's, coalesced with a run's refresh through runs.sqlite, so
// the two cannot race. It prints one JSON line (the outcome) and exits 0, or 1 when the refresh failed.
import { refreshReadCopy } from "../db/readcopy.ts";

const root = process.argv[2];
if (!root) {
  console.error("refresh-child.ts takes the project root");
  process.exit(2);
}
const out = await refreshReadCopy(root);
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(out.status === "failed" ? 1 : 0);
