// The secretsFrom command in a lake project (DESIGN.md D163): the lake's secrets (two logins' passwords, two keys) may live only in the store the
// command reads, so every command that opens the lake runs it, once, and the docs and doctor say so. The first real-lake trial found doctor saying
// "not run by doctor" while it ran it, and `croft secrets` listing none of the lake's names.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lakeRigReady, type LakeRig, startLakeRig } from "../../db/lake-testkit.ts";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { cleanup, cli, makeProject } from "./inspect-testkit.ts";
import { ORDERS_SQL } from "./lake-project-testkit.ts";
import { docs } from "./docs.ts";
import type { Ctx } from "../command.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[lake-secrets.test] SKIPPING: ${ready.skipReason}`);
const maybe = ready.ready ? test : test.skip;

let rig: LakeRig | undefined;
beforeAll(async () => {
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  await closeAllWarehouses();
  await cleanup();
  await rig?.stop();
});

describe("secretsFrom in a lake project", () => {
  maybe("every command that opens the lake runs it once; the others never; croft secrets lists the lake's names; doctor says what happened", async () => {
    const lake = await rig!.lake();
    const p = makeProject({ files: { "files/x.csv": "a,b\n1,2\n", "assets/orders.sql": ORDERS_SQL } });
    const log = join(p.root, "secretsfrom.log");
    // A store of the lake's secrets that is not .env: the command prints them as .env text and notes that it ran.
    writeFileSync(join(p.root, "store.ts"), `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "ran\\n");
const secrets = ${JSON.stringify(lake.env)};
console.log(Object.entries(secrets).map(([k, v]) => k + "=" + v).join("\\n"));
`);
    writeFileSync(join(p.root, "croft.json"), JSON.stringify({
      database: "warehouse.duckdb", timezone: "UTC", lake: lake.block, secretsFrom: { command: [process.execPath, "store.ts"] },
    }));
    const env = { CROFT_EXTENSION_DIR: ready.dir };
    const runs = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
    const times = async (argv: string[], want: number) => {
      const before = runs();
      const r = await cli(argv, { cwd: p.root, env });
      await closeAllWarehouses();
      expect(runs() - before, `croft ${argv.join(" ")} ran secretsFrom ${runs() - before} times; ${r.stdout.slice(0, 300)}`).toBe(want);
      return r;
    };

    // The first run creates the lake; the secrets come only from the command.
    const first = await times(["run", "--foreground", "--json"], 1);
    expect(first.exit, first.stdout.slice(0, 600)).toBe(0);
    for (const argv of [["query", "select count(*) as n from orders", "--json"], ["describe", "orders", "--json"], ["context", "--json"], ["maintain", "--dry-run", "--json"], ["doctor", "--json"]]) {
      const r = await times(argv, 1);
      expect(r.exit, `croft ${argv[0]}: ${r.stdout.slice(0, 600)}`).toBe(0);
    }
    // A command that does not open the lake never runs it.
    for (const argv of [["status", "--json"], ["validate", "--json"], ["logs", "--json"]]) await times(argv, 0);

    // doctor says that it ran it, once, and for what.
    const doctor = await cli(["doctor", "--json"], { cwd: p.root, env });
    await closeAllWarehouses();
    const checks = (doctor.json as { data: { checks: { id: string; text: string }[] } }).data.checks;
    expect(checks.find((c) => c.id === "secrets-from")!.text).toContain("run once by doctor, for the lake's secrets");
    expect(checks.find((c) => c.id === "secrets-from")!.text).not.toContain("not run by doctor");

    // croft secrets lists the lake's six names, set from the command, used by the lake.
    const listed = await cli(["secrets", "--json"], { cwd: p.root, env });
    await closeAllWarehouses();
    const rows = (listed.json as { data: { name: string; status: string; source: string; usedBy: string[] }[] }).data;
    expect(rows.map((s) => s.name).sort()).toEqual(Object.keys(lake.env).sort());
    for (const s of rows) expect(s).toMatchObject({ status: "set", source: "command", usedBy: ["the lake (croft.json)"] });
  }, 240_000);

  test("the secrets page says which commands run secretsFrom", async () => {
    const page = ((await docs.run({ positionals: ["secrets"], values: {} } as unknown as Ctx)).data as { page: string }).page;
    expect(page).toContain("in a lake project");
    expect(page).not.toContain("status, query, validate, doctor and the rest never run it");
  });
});
