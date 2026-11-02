// A person's DuckDB 2.0 in a child process, for the Quack tests (DESIGN.md D125): the helper around
// serve/quack-client-child-testkit.ts. Every client a test starts is a child of the test and is killed in teardown
// (`QuackClients.close()`), never left running. Test support, left out of the published package (package.json "files").
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

export type ClientAnswer = { ok: true; rows: Record<string, unknown>[]; ms: number } | { ok: false; error: string; ms: number };

export interface QuackClient {
  /** Run SQL on the client's default connection, or on the one named `conn`. */
  run(sql: string, conn?: string): Promise<ClientAnswer>;
  /** `run`, expecting rows. */
  rows(sql: string, conn?: string): Promise<Record<string, unknown>[]>;
  /** `run`, expecting the error's text. */
  error(sql: string, conn?: string): Promise<string>;
  /** ATTACH a Quack server as `r` with a key, and return the answer. */
  attach(uri: string, key: string, as?: string): Promise<ClientAnswer>;
  stop(): void;
}

export class QuackClients {
  private readonly children: ChildProcess[] = [];

  /** A client with quack and httpfs loaded from `extensionDir`. */
  async start(extensionDir: string): Promise<QuackClient> {
    const proc = spawn(process.execPath, [join(import.meta.dir, "quack-client-child-testkit.ts"), "--ext", extensionDir], { stdio: ["pipe", "pipe", "pipe"] });
    this.children.push(proc);
    const lines: string[] = [];
    const waiters: (() => void)[] = [];
    let buf = "";
    let err = "";
    proc.stdout!.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
        for (const w of waiters.splice(0)) w();
      }
    });
    proc.stderr!.on("data", (d) => (err += String(d)));
    const next = async (timeoutMs = 60_000): Promise<string> => {
      const end = Date.now() + timeoutMs;
      while (lines.length === 0) {
        if (Date.now() > end) throw new Error(`the Quack client said nothing for ${timeoutMs} ms: ${err}`);
        if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`the Quack client exited: ${err}`);
        await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
      }
      return lines.shift()!;
    };
    if ((await next()) !== "READY") throw new Error(`the Quack client did not start: ${err}`);
    let id = 0;
    const run = async (sql: string, conn = ""): Promise<ClientAnswer> => {
      proc.stdin!.write(`${JSON.stringify({ id: ++id, sql, conn })}\n`);
      return JSON.parse(await next()) as ClientAnswer;
    };
    const client: QuackClient = {
      run,
      async rows(sql, conn) {
        const a = await run(sql, conn);
        if (!a.ok) throw new Error(`${sql}: ${a.error}`);
        return a.rows;
      },
      async error(sql, conn) {
        const a = await run(sql, conn);
        if (a.ok) throw new Error(`expected an error, got ${JSON.stringify(a.rows)}: ${sql}`);
        return a.error;
      },
      attach: (uri, key, as = "r") => run(`ATTACH '${uri}' AS ${as} (TOKEN '${key}')`),
      stop: () => { proc.kill("SIGKILL"); },
    };
    return client;
  }

  /** Kill every client this started. */
  close(): void {
    for (const c of this.children) c.kill("SIGKILL");
  }
}

/** A port nothing listens on now, for a Quack listener that must come back at the same address after its process is killed. */
export function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

/** `sql` sent to a Quack server as written, with a key, without attaching: the server sees exactly this text. */
export function raw(client: QuackClient, uri: string, key: string, sql: string): Promise<ClientAnswer> {
  return client.run(`SELECT * FROM quack_query('${uri}', '${sql.replaceAll("'", "''")}', token = '${key}')`);
}
