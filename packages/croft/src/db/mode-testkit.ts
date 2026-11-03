// Child processes for the mode tests (DESIGN.md D118): a throwaway Postgres, an S3-compatible store and a Quack
// listener. Each runs as a CHILD of the test, in the foreground, and is killed in teardown. None is ever an OS
// service, and nothing here uses launchctl (tests/preload.ts keeps refusing it). A test that needs one skips with
// a clear reason when the program is not installed, and fails in CI (CROFT_CI=1).
import { type Subprocess } from "bun";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const children = new Set<Subprocess>();
process.on("exit", () => { for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } } });

async function stop(child: Subprocess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  children.delete(child);
  try { child.kill(signal); } catch { /* gone */ }
  const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 5000);
  await child.exited;
  clearTimeout(killer);
}

/** A free TCP port on 127.0.0.1 (briefly bound, then released). */
export function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port!;
  s.stop(true);
  return p as number;
}

/** Homebrew or distro Postgres 14 or newer: the directory holding initdb, postgres and psql, or null. */
export function postgresBin(): string | null {
  const found = Bun.which("postgres") && Bun.which("initdb") && Bun.which("psql");
  if (found) return dirname(Bun.which("postgres")!);
  for (const base of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).filter((n) => /^postgresql(@\d+)?$/.test(n)).sort().reverse()) {
      const bin = join(base, d, "bin");
      if (existsSync(join(bin, "postgres")) && existsSync(join(bin, "initdb")) && existsSync(join(bin, "psql"))) return bin;
    }
  }
  // Debian and Ubuntu keep each version under /usr/lib/postgresql/<n>/bin.
  try {
    const bins = readdirSync("/usr/lib/postgresql", { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join("/usr/lib/postgresql", e.name, "bin")).sort().reverse();
    for (const bin of bins) if (existsSync(join(bin, "postgres")) && existsSync(join(bin, "initdb")) && existsSync(join(bin, "psql"))) return bin;
  } catch { /* none */ }
  return null;
}

export interface TestPostgres {
  host: string;
  port: number;
  /** The superuser, for the test's own setup. */
  admin: { user: string; password: string };
  /** Run SQL as the superuser against `db` (default postgres); returns psql's -tA output. */
  sql(statement: string, db?: string): Promise<string>;
  /** Make a database with a writer login and a read-only login (SELECT on everything, now and later). */
  createLakeDatabase(db: string, writer: { user: string; password: string }, reader: { user: string; password: string }): Promise<void>;
  /** End every connection of the lake's logins (pg_terminate_backend), as a network drop or a failover does; returns how many ended. */
  terminateConnections(): Promise<number>;
  /** Stop the server, keep it down for `downMs`, and start it again on the same data folder and port. */
  restart(downMs?: number): Promise<void>;
  stop(): Promise<void>;
}

/** Start a Postgres with a temporary data folder, listening on 127.0.0.1 only. */
export async function startPostgres(): Promise<TestPostgres> {
  const bin = postgresBin();
  if (!bin) throw new Error("postgres is not installed");
  const dir = mkdtempSync(join(tmpdir(), "croft-pg-"));
  const data = join(dir, "data");
  const password = "pg-admin-pw-for-tests";
  writeFileSync(join(dir, "pw"), password);
  const init = Bun.spawnSync([join(bin, "initdb"), "-D", data, "-U", "postgres", "--auth=scram-sha-256", `--pwfile=${join(dir, "pw")}`, "-E", "UTF8"], { stdout: "ignore", stderr: "pipe" });
  if (init.exitCode !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`initdb failed: ${init.stderr.toString()}`);
  }
  const port = freePort();
  // -k points the unix socket at the temporary folder, so nothing is left in /tmp or the system socket folder.
  const launch = () => {
    const c = Bun.spawn([join(bin, "postgres"), "-D", data, "-p", String(port), "-k", dir, "-c", "listen_addresses=127.0.0.1", "-c", "fsync=off", "-c", "max_connections=60"], { stdout: "ignore", stderr: "ignore" });
    children.add(c);
    return c;
  };
  let child = launch();
  const sql = async (statement: string, db = "postgres"): Promise<string> => {
    const r = Bun.spawn([join(bin, "psql"), "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-tAc", statement], { env: { PATH: process.env.PATH ?? "", PGPASSWORD: password }, stdout: "pipe", stderr: "pipe" });
    const [out, errText, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
    if (code !== 0) throw new Error(`psql: ${errText.trim()}`);
    return out.trim();
  };
  for (let i = 0; i < 100; i++) {
    try { if ((await sql("select 1")) === "1") break; } catch { /* not up yet */ }
    if (i === 99) {
      await stop(child);
      rmSync(dir, { recursive: true, force: true });
      throw new Error("postgres did not start");
    }
    await Bun.sleep(100);
  }
  return {
    host: "127.0.0.1",
    port,
    admin: { user: "postgres", password },
    sql,
    async createLakeDatabase(db, writer, reader) {
      for (const u of [writer, reader]) {
        await sql(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${u.user}') THEN CREATE ROLE ${u.user} LOGIN PASSWORD '${u.password}'; END IF; END $$`);
      }
      await sql(`CREATE DATABASE ${db} OWNER ${writer.user}`);
      await sql(`GRANT CONNECT ON DATABASE ${db} TO ${reader.user}`, db);
      await sql(`GRANT USAGE ON SCHEMA public TO ${reader.user}; ALTER DEFAULT PRIVILEGES FOR ROLE ${writer.user} IN SCHEMA public GRANT SELECT ON TABLES TO ${reader.user}`, db);
    },
    async terminateConnections() {
      return Number(await sql("select count(pg_terminate_backend(pid)) from pg_stat_activity where usename not in ('postgres') and pid <> pg_backend_pid()"));
    },
    async restart(downMs = 300) {
      await stop(child, "SIGINT");
      await Bun.sleep(downMs);
      child = launch();
      for (let i = 0; i < 200; i++) {
        try { if ((await sql("select 1")) === "1") return; } catch { /* not up yet */ }
        await Bun.sleep(50);
      }
      throw new Error("postgres did not come back");
    },
    async stop() {
      await stop(child, "SIGINT");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestS3 {
  endpoint: string; // host:port, for httpfs's ENDPOINT
  port: number;
  root: string;
  /** The next `n` requests that delete objects answer HTTP `status` and delete nothing (R2 answered 500 to bulk deletes on a real lake). */
  failDeletes(n: number, status?: number): Promise<void>;
  /** How many requests asked to delete, how many were refused by failDeletes, and how many objects went. */
  stats(): Promise<{ deleteRequests: number; failedDeletes: number; objectsDeleted: number }>;
  stop(): Promise<void>;
}

/** Start the S3-compatible store (s3-store-testkit.ts) with a temporary folder. `keys`: id -> "rw" | "ro". */
export async function startS3(o: { buckets: string[]; keys: Record<string, "rw" | "ro"> }): Promise<TestS3> {
  const root = mkdtempSync(join(tmpdir(), "croft-s3-"));
  const args = [process.execPath, join(import.meta.dir, "s3-store-testkit.ts"), "--root", root];
  for (const b of o.buckets) args.push("--bucket", b);
  for (const [id, mode] of Object.entries(o.keys)) args.push("--key", `${id}:${mode}`);
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
  children.add(child);
  const port = await readListening(child);
  return {
    endpoint: `127.0.0.1:${port}`,
    port,
    root,
    async failDeletes(n, status = 500) {
      await fetch(`http://127.0.0.1:${port}/__control?failDeletes=${n}&status=${status}`, { method: "POST" });
    },
    async stats() {
      return (await (await fetch(`http://127.0.0.1:${port}/__control`)).json()) as { deleteRequests: number; failedDeletes: number; objectsDeleted: number };
    },
    async stop() {
      await stop(child);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Read `LISTENING <port>` from a child's stdout. */
export async function readListening(child: Subprocess<"ignore" | "pipe" | "inherit", "pipe", "pipe" | "inherit" | "ignore">, timeoutMs = 20_000): Promise<number> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
    if (!r || r.done) break;
    seen += decoder.decode(r.value);
    const m = /LISTENING (\d+)/.exec(seen);
    if (m) { reader.releaseLock(); return Number(m[1]); }
  }
  await stop(child as Subprocess);
  throw new Error(`the child did not say it was listening; it printed: ${seen.slice(0, 300)}`);
}

/** Start any child process the test owns; it is killed with the others at exit, or by the returned stop(). */
export function track(child: Subprocess): () => Promise<void> {
  children.add(child);
  return () => stop(child);
}
