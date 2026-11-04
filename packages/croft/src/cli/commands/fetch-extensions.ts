// croft fetch-extensions [name…] [--all] (DESIGN.md D195): fetch the DuckDB extension files the modes load from DuckDB's own
// extension servers, ahead of the first time a mode needs them. For a machine that has no network when croft runs (an image
// built with the files in it, a server behind a firewall), for CI, and as the fix EXTENSION_MISSING names. Each file is checked
// against the sha256 croft pins before it is written; one already there and correct is left alone, one that is wrong is replaced.
// Fetches nothing a project did not ask for: with names, those; with --all, every extension a mode loads; otherwise the ones the
// project's modes need. Spec in commands/index.ts.
import { CroftError } from "../../core/errors.ts";
import { fetchExtensions, type Fetched, repositoryOf } from "../../db/extension-fetch.ts";
import { hostPlatform, resolveExtensionDir } from "../../db/extension-files.ts";
import { DUCKDB_VERSION, EXTENSIONS, type ExtensionName } from "../../db/extension-names.ts";
import { extensionsOfModes, FETCHABLE, modesNeeded } from "../../db/extension-status.ts";
import type { CommandImpl } from "../command.ts";

export interface FetchExtensionsData {
  /** DuckDB's name for this machine's platform. */
  platform: string;
  duckdb: string;
  /** The folder the files are in (DuckDB's layout under it). */
  dir: string;
  /** Where they came from. */
  repository: string;
  /** Each file, in the order fetched; `downloaded: false` was there and correct already. */
  files: Fetched[];
}

export const fetchExtensionsCommand: CommandImpl<FetchExtensionsData> = {
  async run(ctx) {
    const platform = hostPlatform();
    const known = Object.keys(EXTENSIONS) as ExtensionName[];
    const named = ctx.positionals.map((n) => {
      if (!known.includes(n as ExtensionName)) {
        throw new CroftError("USAGE_ERROR", {
          message: `${n} is not an extension croft pins`,
          hint: `the extensions are ${FETCHABLE.join(", ")}`,
        });
      }
      return n as ExtensionName;
    });
    const project = ctx.findProject();
    const names = named.length ? named : ctx.values.all || !project ? [...FETCHABLE] : extensionsOfModes(modesNeeded(project.config));
    const env = ctx.processEnv;
    const dir = resolveExtensionDir(env);
    const base = { platform: platform ?? `${process.platform}-${process.arch}`, duckdb: DUCKDB_VERSION, dir, repository: repositoryOf(env) };
    if (!names.length) {
      return {
        data: { ...base, files: [] },
        problems: [],
        next: [{ command: "croft fetch-extensions --all", reason: "no mode is on in croft.json, so this project needs no extension files; --all fetches every one a mode can load" }],
      };
    }
    const files = await fetchExtensions(names, { dir, platform, env, log: (line) => ctx.render.progress(line) });
    return { data: { ...base, files }, problems: [], next: [] };
  },

  human(result) {
    const d = result.data;
    if (!d.files.length) return "Nothing to fetch: no mode is on in croft.json, so this project needs no extension files.";
    const lines = d.files.map((f) => `  ${f.name}  ${(f.bytes / 1e6).toFixed(1)} MB  ${f.downloaded ? "fetched" : "already there"}`);
    return `DuckDB ${d.duckdb} extension files for ${d.platform} in ${d.dir}\n${lines.join("\n")}\nEach matches the checksum croft pins.`;
  },
};
