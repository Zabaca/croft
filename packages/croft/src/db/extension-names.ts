// The extensions croft's modes load and the DuckDB platforms it pins them for (DESIGN.md D117). Names only; the
// checksums are generated into extension-pins.ts by scripts/pin-extensions.ts.

/** The one DuckDB version the pins are for; extensions are built per version. */
export const DUCKDB_VERSION = "2.0.0";

/** Logical name -> the file's base name in DuckDB's repository (`<file>.duckdb_extension`). */
export const EXTENSIONS = {
  quack: "quack",
  httpfs: "httpfs",
  ducklake: "ducklake",
  postgres: "postgres_scanner",
  sqlite: "sqlite_scanner",
} as const;

export type ExtensionName = keyof typeof EXTENSIONS;

/** DuckDB's platform names for tier 1 (DESIGN.md §2): macOS arm64 and x64, Linux x64 and arm64 with glibc. */
export const PLATFORMS = ["osx_arm64", "osx_amd64", "linux_amd64", "linux_arm64"] as const;
export type Platform = (typeof PLATFORMS)[number];
