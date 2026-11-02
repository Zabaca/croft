// A real refresh child (serve/refresh-child.ts runRefreshChild, which does db/readcopy.ts's refreshReadCopy against a real
// project) held where a stop matters: after the checkpoint of the live warehouse, under the write lease, before the clone.
// For copy-maker.test.ts. Test support, left out of the published package (package.json "files").
//
//   bun refresh-slow-testkit.ts <project root> <control folder> <orphan grace ms>
//
// It writes <control folder>/checkpointed (its pid) when it reaches the pause, and waits there until <control folder>/proceed
// exists (or a minute passes); then the refresh goes on and the outcome is printed like the real child's.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRefreshChild } from "./refresh-child.ts";

const [root, dir, grace] = process.argv.slice(2) as [string, string, string];
const out = await runRefreshChild(root, {
  orphanGraceMs: Number(grace),
  refresh: {
    hooks: {
      async checkpointed() {
        writeFileSync(join(dir, "checkpointed"), String(process.pid));
        const end = Date.now() + 60_000;
        while (!existsSync(join(dir, "proceed")) && Date.now() < end) await Bun.sleep(20);
      },
    },
  },
});
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(out.status === "failed" ? 1 : 0);
