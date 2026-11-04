// Fetching the pinned DuckDB extension files from DuckDB's own extension servers (DESIGN.md D195, which replaced the add-on
// packages of D134 and D135). croft publishes no extension: DuckDB does, signed, at https://extensions.duckdb.org/v<version>/
// <platform>/<file>.duckdb_extension.gz. A file is downloaded, unpacked in memory, checked against the sha256 and size croft
// pins (extension-pins.ts) and only then written, so a wrong file is never on disk. croft never runs INSTALL and never turns off
// DuckDB's signature check: a file croft loads has passed both its own pin and DuckDB's signature at LOAD.
//
// Fetching happens in exactly two places, both before any lockdown: `fetchMissingModeFiles` when an instance for a mode is first
// opened (db/connect.ts, ahead of the lock), and `croft fetch-extensions`. A locked instance never reaches either; its files
// were loaded before it locked. $CROFT_NO_FETCH=1 turns the first off (a machine that must not reach the network, croft's tests):
// a missing file is then EXTENSION_MISSING with the command as its fix.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { CroftError } from "../core/errors.ts";
import { extensionPath, fetchCommand, hostPlatform, platformError, resolveExtensionDir, verifyExtension } from "./extension-files.ts";
import { DUCKDB_VERSION, EXTENSIONS, type ExtensionName, type Platform } from "./extension-names.ts";
import { EXTENSION_PINS } from "./extension-pins.ts";

/** DuckDB's official extension repository, which DuckDB itself uses for this version. */
export const DEFAULT_REPOSITORY = "https://extensions.duckdb.org";

/** A whole download may take this long (the largest file is 60 MB); a slower link is a failed fetch that can be retried. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** The repository to fetch from: $CROFT_EXTENSION_REPO (a mirror, or a stand-in in croft's tests; every file is still checked against the pin), else DuckDB's. */
export function repositoryOf(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CROFT_EXTENSION_REPO || DEFAULT_REPOSITORY).replace(/\/+$/, "");
}

/** Whether $CROFT_NO_FETCH is set: croft then fetches nothing by itself, and `croft fetch-extensions` is the only way a file arrives. */
export function fetchingOff(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CROFT_NO_FETCH;
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}

/** The URL of one file in the repository, in DuckDB's own layout. */
export function extensionUrl(name: ExtensionName, platform: Platform, repository: string = DEFAULT_REPOSITORY): string {
  return `${repository}/v${DUCKDB_VERSION}/${platform}/${EXTENSIONS[name]}.duckdb_extension.gz`;
}

export interface FetchOptions {
  /** The folder to fill (DuckDB's layout); default resolveExtensionDir(). */
  dir?: string;
  /** Default: this machine's. */
  platform?: Platform | null;
  env?: NodeJS.ProcessEnv;
  /** Tests substitute the network. */
  fetch?: typeof fetch;
  /** One line per file as it starts; default one line on stderr. */
  log?: (line: string) => void;
}

export interface Fetched { name: ExtensionName; path: string; bytes: number; /** false: the file was there and correct, nothing was downloaded. */ downloaded: boolean }

const stderrLine = (line: string): void => { process.stderr.write(`croft: ${line}\n`); };

// Downloads in flight in this process, by destination, so several instances opening at once fetch a file once.
const inFlight = new Map<string, Promise<Fetched>>();

/** Fetch one extension into the folder unless a correct file is already there; a file that fails its check is replaced. */
export function fetchExtension(name: ExtensionName, o: FetchOptions = {}): Promise<Fetched> {
  const platform = o.platform === undefined ? hostPlatform() : o.platform;
  if (!platform) return Promise.reject(platformError(name));
  const env = o.env ?? process.env;
  const dir = o.dir ?? resolveExtensionDir(env);
  const path = extensionPath(dir, name, platform);
  const running = inFlight.get(path);
  if (running) return running;
  const p = download(name, platform, dir, path, env, o).finally(() => inFlight.delete(path));
  inFlight.set(path, p);
  return p;
}

/** Fetch each of `names`, in order; the first failure stops. */
export async function fetchExtensions(names: readonly ExtensionName[], o: FetchOptions = {}): Promise<Fetched[]> {
  const out: Fetched[] = [];
  for (const n of names) out.push(await fetchExtension(n, o));
  return out;
}

async function download(name: ExtensionName, platform: Platform, dir: string, path: string, env: NodeJS.ProcessEnv, o: FetchOptions): Promise<Fetched> {
  const pin = EXTENSION_PINS[platform][name];
  if (existsSync(path)) {
    try {
      verifyExtension(dir, name, platform);
      return { name, path, bytes: pin.bytes, downloaded: false };
    } catch (e) {
      if (!(e instanceof CroftError)) throw e;
      // Wrong or damaged: fetch it again, below.
    }
  }
  const repository = repositoryOf(env);
  const url = extensionUrl(name, platform, repository);
  (o.log ?? stderrLine)(`fetching DuckDB's ${name} extension (v${DUCKDB_VERSION}, ${platform}, ${(pin.bytes / 1e6).toFixed(0)} MB unpacked) from ${repository}`);
  const failed = (why: string, details: Record<string, unknown> = {}): CroftError => new CroftError("EXTENSION_FETCH_FAILED", {
    message: `could not fetch the ${name} extension from ${url}: ${why}`,
    hint: `croft needs the network once, to fetch DuckDB's extension files; check the connection (and HTTPS_PROXY if a proxy is needed) and run ${fetchCommand([name])} again`,
    fix: { kind: "command", description: `fetch the ${name} extension once the machine can reach ${repository}`, command: fetchCommand([name]) },
    retryable: true,
    details: { kind: "fetch", extension: name, platform, duckdb: DUCKDB_VERSION, url, ...details },
  });
  let packed: Buffer;
  try {
    const res = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      throw failed(res.status === 404 ? `the repository has no such file (HTTP 404)` : `HTTP ${res.status}`, { status: res.status });
    }
    packed = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof CroftError) throw e;
    throw failed(e instanceof Error ? e.message : String(e));
  }
  let bytes: Buffer;
  try {
    bytes = gunzipSync(packed);
  } catch (e) {
    throw failed(`the answer is not a gzip file (${e instanceof Error ? e.message : String(e)})`);
  }
  const sha256 = bytes.length === pin.bytes ? createHash("sha256").update(bytes).digest("hex") : null;
  if (sha256 !== pin.sha256) {
    throw new CroftError("EXTENSION_CHECKSUM_MISMATCH", {
      message: `the ${name} extension that ${url} sent is not the pinned file (its checksum differs); nothing was written`,
      hint: "croft loads only the files it pins; if DuckDB re-released this file, a newer croft pins the new one, otherwise something between this machine and the repository changed the file",
      fix: { kind: "manual", description: "upgrade croft, or ask the user whether a proxy or mirror in front of the repository can be trusted", requiresHuman: true },
      retryable: false,
      details: { kind: "download", extension: name, platform, duckdb: DUCKDB_VERSION, url, bytes: bytes.length, expectedBytes: pin.bytes },
    });
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.part-${process.pid}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { name, path, bytes: bytes.length, downloaded: true };
}

/**
 * The files a mode needs that are not on this machine yet, fetched. Called once per new instance, before the mode is checked and
 * before the lock; does nothing when fetching is off ($CROFT_NO_FETCH), when croft pins nothing for this machine (the check that
 * follows reports it), or when every file is there (a wrong one is the check's to refuse, not ours to replace silently).
 */
export async function fetchMissingModeFiles(names: readonly ExtensionName[], o: FetchOptions = {}): Promise<void> {
  const env = o.env ?? process.env;
  if (fetchingOff(env)) return;
  const platform = o.platform === undefined ? hostPlatform() : o.platform;
  if (!platform) return;
  const dir = o.dir ?? resolveExtensionDir(env);
  const absent = names.filter((n) => !existsSync(extensionPath(dir, n, platform)));
  if (absent.length) await fetchExtensions(absent, { ...o, dir, platform });
}
