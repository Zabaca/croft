// A stand-in for DuckDB's extension repository, for tests of the fetch path (DESIGN.md D195): a local HTTP server that answers
// `/v<duckdb>/<platform>/<file>.duckdb_extension.gz` the way extensions.duckdb.org does, and counts what it was asked. No test reaches
// the real servers. Test support, left out of the published package (package.json "files").
import { gzipSync } from "node:zlib";
import { DUCKDB_VERSION, EXTENSIONS, type ExtensionName, type Platform } from "./extension-names.ts";
import { EXTENSION_PINS } from "./extension-pins.ts";
import { createHash } from "node:crypto";

export interface StandInRepo {
  /** `http://127.0.0.1:<port>`, for $CROFT_EXTENSION_REPO. */
  url: string;
  /** Every path asked for, in order. */
  requests: string[];
  /** How to answer a path (after the leading slash): the unpacked bytes of the file, a status, or nothing for 404. Replace to change what it says. */
  files: Map<string, Buffer | number>;
  stop(): void;
}

/** The path of one file in the repository, as DuckDB lays it out. */
export const repoPath = (name: ExtensionName, platform: Platform): string => `v${DUCKDB_VERSION}/${platform}/${EXTENSIONS[name]}.duckdb_extension.gz`;

export function startStandInRepo(): StandInRepo {
  const files = new Map<string, Buffer | number>();
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname.slice(1);
      requests.push(path);
      const f = files.get(path);
      if (f === undefined) return new Response("not found", { status: 404 });
      if (typeof f === "number") return new Response("no", { status: f });
      return new Response(gzipSync(f));
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, files, stop: () => void server.stop(true) };
}

/**
 * Make `content` the pinned file for `name` on `platform` until the returned function is called: a test that needs a small, fast
 * file in place of DuckDB's 40 MB one. The pins are the real thing otherwise.
 */
export function pinStandIn(name: ExtensionName, platform: Platform, content: Buffer): () => void {
  const saved = EXTENSION_PINS[platform][name];
  EXTENSION_PINS[platform][name] = { sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
  return () => { EXTENSION_PINS[platform][name] = saved; };
}


