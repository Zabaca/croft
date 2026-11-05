// What croft serve's two server-mode engines share about Quack (DESIGN.md D125, D126, D131): the readers' engine (serve/readers.ts) and the
// lake engine (serve/lake-engine.ts) each hold one child process that listens for DuckDB clients, and each checks the listener's address,
// follows the keys file and starts that process the same way.
import { plaintextNotAccepted } from "./errors.ts";
import type { KeyStore } from "./keys.ts";
import type { QuackEvent, QuackKey } from "./quack-access.ts";
import { listenAddress } from "./quack-address.ts";
import { QueryWorker, type SpawnOptions } from "./query-worker.ts";

/** The listener's address must be loopback, or the project must have accepted plaintext on the network (D131). */
export function assertQuackAddress(quackAt: { host: string; port: number } | null, plaintextAccepted: boolean): void {
  if (!quackAt) return;
  const { uri, loopback } = listenAddress(quackAt.host, quackAt.port);
  if (!loopback && !plaintextAccepted) throw plaintextNotAccepted(uri);
}

/** The keys file as an engine follows it. A Quack session outlives a request, so the process checks every query against its list, and a
 *  removed key stops working within a look (D126): the engine looks on its poll, and sends the process the list when the file changed. */
export class KeyFollower {
  /** The keys last read, which a process opens with and is sent again when the file changes. */
  current: QuackKey[] = [];

  /** `on` false: the engine has no keys to follow (a lake that serves apps only) and the file is never read. */
  constructor(private readonly store: KeyStore, private readonly on = true) {}

  /** Read the keys file when it changed since the last look: the new list, or null. */
  read(): QuackKey[] | null {
    if (!this.on) return null;
    const changed = this.store.changes();
    if (changed) this.current = changed;
    return changed;
  }

  /** Tell `worker` the keys, when they changed (a process that opens next starts with the list); `sent` hears the names. */
  send(worker: QueryWorker | null, sent: (names: string[]) => void): void {
    const changed = this.read();
    if (!changed || !worker) return;
    worker.setKeys(changed);
    sent(changed.map((k) => k.name));
  }
}

/** What an engine hears of its process: its exit, Quack's events and the lake's snapshots; `overdue` hears a query that ran past the
 *  deadline, as the process is being killed. */
export interface QuackWorkerOptions extends Pick<SpawnOptions, "onExit" | "argv" | "onSnapshot"> {
  onQuack?: (e: QuackEvent) => void;
  overdue?: (e: { pid: number; ms: number }) => void;
}

/** Start the process an engine serves from. */
export function spawnQuackWorker(o: QuackWorkerOptions): QueryWorker {
  const worker: QueryWorker = QueryWorker.spawn({
    ...(o.onExit ? { onExit: o.onExit } : {}),
    onQuack: (e) => {
      try {
        o.onQuack?.(e);
      } catch {
        // A log or a last-use time that cannot be written never costs a client its answer.
      }
    },
    onOverdue: (x) => {
      // Quack has no server-side cancel [V: 2.0.0]: the process ends, every session on it with it, and clients attach again (D127).
      o.overdue?.({ pid: worker.pid, ms: x.ms });
      void worker.kill();
    },
    ...(o.onSnapshot ? { onSnapshot: o.onSnapshot } : {}),
    ...(o.argv ? { argv: o.argv } : {}),
  });
  return worker;
}
