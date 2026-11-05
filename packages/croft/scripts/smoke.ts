// CI: the smoke every platform runs on a pull request (.github/workflows/ci.yml, DESIGN.md D191). The full suite runs once, on one platform
// and one Bun; this is what the others must still do: a fresh project runs a pipeline and answers a query, croft serve starts in server
// mode, answers a key with the shared table, and stops, and every DuckDB extension file croft pins for this platform loads. It uses the
// real CLI and nothing from the test suite, so a platform that cannot run it is a platform croft cannot run on.
//
//   CROFT_EXTENSION_DIR=<folder filled by scripts/fetch-extensions.ts> bun scripts/smoke.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openMemoryInstance } from "../src/db/connect.ts";
import { EXTENSIONS, type ExtensionName } from "../src/db/extension-names.ts";
import { hostPlatform, resolveExtensionDir, verifyExtensions } from "../src/db/extension-files.ts";

const PKG = resolve(import.meta.dir, "..");
const BIN = join(PKG, "bin", "croft.mjs");
const base = mkdtempSync(join(tmpdir(), "croft-smoke-"));
const project = join(base, "proj");
/** croft serve, once the smoke has started it: `fail` ends the process on the spot, and a server left running would outlive the smoke (and hold the job's folder). */
let server: ReturnType<typeof Bun.spawn> | undefined;
process.on("exit", () => {
  if (server && server.exitCode === null) server.kill("SIGINT");
  rmSync(base, { recursive: true, force: true });
});
const extensionDir = process.env.CROFT_EXTENSION_DIR ?? resolveExtensionDir();

// Nothing of the machine's: a home of its own, no OS jobs, no notifications, and the extension files named since a fake home has no cache.
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: base,
  TMPDIR: tmpdir(),
  NO_COLOR: "1",
  CROFT_HOME: join(base, ".croft"),
  CROFT_JOB_LABEL: `dev.croft.smoke.${process.pid}`,
  CROFT_FORBID_OS_JOBS: "1",
  CROFT_NOTIFY_DRY: "1",
  CROFT_EXTENSION_DIR: extensionDir,
};

function step(name: string): void {
  console.log(`\n== ${name}`);
}
function fail(msg: string): never {
  console.error(`smoke: ${msg}`);
  process.exit(1);
}

interface Result { code: number | null; stdout: string; stderr: string }
async function croft(cwd: string, args: string[]): Promise<Result> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}
/** `croft <args> --json`, its envelope's data; a nonzero exit or a refusal ends the smoke with what croft said. */
async function data(cwd: string, args: string[]): Promise<any> {
  const r = await croft(cwd, [...args, "--json"]);
  if (r.code !== 0) fail(`croft ${args.join(" ")} exited ${r.code}\n${r.stdout}${r.stderr}`);
  try { return JSON.parse(r.stdout).data; } catch { return fail(`croft ${args.join(" ")} printed no JSON envelope\n${r.stdout}${r.stderr}`); }
}

const platform = hostPlatform();
console.log(`croft smoke on ${process.platform} ${process.arch}, bun ${Bun.version}, duckdb platform ${platform ?? "none pinned"}`);
if (!platform) fail(`croft pins no DuckDB extension files for ${process.platform} ${process.arch}`);

step("version");
const version = await croft(base, ["--version"]);
if (version.code !== 0 || !version.stdout.trim()) fail(`croft --version exited ${version.code}\n${version.stdout}${version.stderr}`);
console.log(version.stdout.trim());

step("a small project runs its pipeline and answers a query");
await data(base, ["init", project, "--no-install"]);
mkdirSync(join(project, "node_modules", "@zabaca"), { recursive: true });
symlinkSync(PKG, join(project, "node_modules", "@zabaca", "croft"));
// The example's table is shared, so a key can read it; server mode is what a key signs in to.
const config = readFileSync(join(project, "croft.json"), "utf8");
if (!config.includes('"timezone"')) fail(`croft init wrote a croft.json without a timezone line:\n${config}`);
writeFileSync(join(project, "croft.json"), config.replace('"timezone"', `"serverMode": { "enabled": true, "quackPort": 0 }, "serve": { "sharedTables": ["example_sales"] }, "timezone"`));
const ran = await croft(project, ["run", "example_sales", "--foreground"]);
if (ran.code !== 0) fail(`croft run exited ${ran.code}\n${ran.stdout}${ran.stderr}`);
const counted = await data(project, ["query", "select count(*) as n from example_sales"]);
const n = Number(counted.rows?.[0]?.n);
if (!(n > 0)) fail(`the example table has no rows: ${JSON.stringify(counted)}`);
console.log(`example_sales: ${n} rows`);

step(`the ${platform} extension files pass their checksums and load`);
const names = Object.keys(EXTENSIONS) as ExtensionName[];
const files = verifyExtensions(extensionDir, names, platform);
const instance = await openMemoryInstance();
const conn = await instance.connect();
for (const name of names) {
  await conn.run(`LOAD '${files.get(name)!.replaceAll("'", "''")}'`);
  console.log(`loaded ${name}`);
}
const loaded = new Set((await (await conn.runAndReadAll("select extension_name from duckdb_extensions() where loaded")).getRowObjectsJson()).map((r) => String(r.extension_name)));
for (const name of names) if (!loaded.has(EXTENSIONS[name])) fail(`DuckDB reports ${EXTENSIONS[name]} as not loaded after LOAD`);
conn.closeSync();
instance.closeSync();

step("croft serve answers a key, then stops");
const key = (await data(project, ["serve", "key", "add", "smoke"])).key as string;
if (!key?.startsWith("croftkey_")) fail("croft serve key add printed no key");
server = Bun.spawn([process.execPath, BIN, "serve", "--port", "0"], { cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const out = Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text()]);
const record = join(project, ".croft", "serve.json");
try {
  const deadline = Date.now() + 60_000;
  while (!existsSync(record)) {
    if (server.exitCode !== null) fail(`croft serve exited ${server.exitCode} before it was ready\n${(await out).join("")}`);
    if (Date.now() > deadline) fail("croft serve was not ready in 60 s");
    await Bun.sleep(100);
  }
  const rec = JSON.parse(readFileSync(record, "utf8")) as { url: string };
  const ask = async (sql: string) => fetch(`${rec.url}/query`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
  const res = await ask("select count(*) as n from example_sales");
  const body = (await res.json()) as { data?: { rows?: { n: number }[] } };
  if (res.status !== 200 || Number(body.data?.rows?.[0]?.n) !== n) fail(`a key's read answered ${res.status}: ${JSON.stringify(body)}`);
  console.log(`a key read ${n} rows over ${rec.url}`);
  const hidden = await ask("select * from _croft.assets");
  if (hidden.status !== 400) fail(`a key reading croft's own tables answered ${hidden.status}, not a refusal`);
} finally {
  server.kill("SIGINT");
}
const stopped = await Promise.race([server.exited, Bun.sleep(30_000).then(() => "timeout" as const)]);
if (stopped === "timeout") { server.kill("SIGKILL"); fail("croft serve did not stop within 30 s of SIGINT"); }
if (stopped !== 0) fail(`croft serve stopped with ${stopped}\n${(await out).join("")}`);
console.log("croft serve stopped cleanly");

console.log("\nsmoke: ok");
