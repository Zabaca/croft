// Where croft's tests (and scripts/fetch-extensions.ts) find the pinned DuckDB extension files (DESIGN.md D117).
// Test support, left out of the published package (package.json "files"); the files are never committed.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DUCKDB_VERSION } from "./extension-names.ts";
import { type ExtensionName } from "./extension-names.ts";
import { extensionPath, hostPlatform, verifyExtension } from "./extension-files.ts";

/** The folder tests read: $CROFT_EXTENSION_DIR, else a cache shared by every worktree. */
export function testExtensionDir(): string {
  return process.env.CROFT_EXTENSION_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "croft", "test-extensions");
}

/** Whether this is CI (the workflow sets CROFT_CI): a test that needs the files must fail there, never skip. */
export const IN_CI = process.env.CROFT_CI === "1";

/**
 * Whether the files `names` need are in the test folder and match the pins. Locally it is false when they are not,
 * and `skipReason` says why, so a skipped test is never silent. In CI a missing or wrong file throws, so a test
 * cannot pass by skipping.
 */
export function extensionsReady(names: readonly ExtensionName[]): { ready: boolean; dir: string; skipReason: string } {
  const dir = testExtensionDir();
  const platform = hostPlatform();
  const fillWith = `bun packages/croft/scripts/fetch-extensions.ts "${dir}"`;
  const reason = (what: string) => `${what} (${DUCKDB_VERSION}); fill it with: ${fillWith}`;
  if (!platform) {
    if (IN_CI) throw new Error(`CI runs on a platform croft pins no extensions for: ${process.platform} ${process.arch}`);
    return { ready: false, dir, skipReason: `croft pins no extensions for ${process.platform} ${process.arch}` };
  }
  for (const n of names) {
    try {
      if (!existsSync(extensionPath(dir, n, platform))) throw new Error(`the ${n} extension is not in ${dir}`);
      verifyExtension(dir, n, platform);
    } catch (e) {
      const msg = reason(`extension files for the mode tests are not ready: ${(e as Error).message}`);
      if (IN_CI) throw new Error(`CI must fetch the extensions before the tests: ${msg}`);
      return { ready: false, dir, skipReason: msg };
    }
  }
  return { ready: true, dir, skipReason: "" };
}
