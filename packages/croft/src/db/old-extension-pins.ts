// The sha256 of the DuckDB 1.5.5 extension files that scripts/fetch-old-duckdb.ts fetches (ducklake, httpfs and postgres_scanner, on the four
// platforms croft pins): for the one test that reads a lake croft wrote with a DuckDB that is not the one croft runs on (DESIGN.md D137, D147;
// src/db/lake-reader-recipe.test.ts, acceptance 11). Taken from DuckDB's official extension repository over HTTPS on 2026-11-02, the unpacked
// files, by hashing what it served; the script refuses a file that does not match. They are the older DuckDB's own files, never loaded by croft
// itself, which pins only the version it runs on (extension-pins.ts).
import type { Platform } from "./extension-names.ts";

export const OLD_DUCKDB_VERSION = "v1.5.5";
export const OLD_NODE_API = "1.5.5-r.5";

export const OLD_EXTENSION_PINS: Readonly<Record<Platform, Readonly<Record<"ducklake" | "httpfs" | "postgres_scanner", { sha256: string; size: number }>>>> = {
  osx_arm64: {
    ducklake: { sha256: "1b72fc42164dbf21948e5a912cefc383b24071852f9e70209874ebd0a73b7caa", size: 27580398 },
    httpfs: { sha256: "10514b4ef19f80bf4ec4bf90c124f5d34625f2606263b40ae8ec7979905bb779", size: 16010974 },
    postgres_scanner: { sha256: "f39dd59bf57679d0242e19e180d90b4222e5cdb691ab67c7506658f3548c0e05", size: 30945398 },
  },
  osx_amd64: {
    ducklake: { sha256: "c7baf45b87f19cb3191c228b820857d573761d344c7855570dcc7eb3b8f1ff9e", size: 30396022 },
    httpfs: { sha256: "a2f48ae06834c165ae73db71f2320360a4b30e7acf4c87187b2241caa48a990d", size: 17543806 },
    postgres_scanner: { sha256: "0df780444ce04a75c5a4e7b89896eab5cebe1ca21163fc6c267f3365ffe4a3c1", size: 34052022 },
  },
  linux_amd64: {
    ducklake: { sha256: "e51bf9e8d933d0e83780ae096455501b542cf962569a2ce5613532d702c08302", size: 36436086 },
    httpfs: { sha256: "887c392b1e49128d11667c81e3698d8b00dfdeb456771acf66d05a0f74f7b7d8", size: 21570542 },
    postgres_scanner: { sha256: "b1ced4cfc6311313e117c2afb3eac76508718778dde0716421503c7dbfb5605c", size: 41696558 },
  },
  linux_arm64: {
    ducklake: { sha256: "d0b57c8e261b89a1ae367c7224f0857cfde72ab6cf2609f188e0de9b897b1088", size: 32143862 },
    httpfs: { sha256: "eba6e263e395a83966090f1f11ade63630b1b21422f0f2813858d179d42ea1e9", size: 19861758 },
    postgres_scanner: { sha256: "e2469cce1e855e8c842a1487dd8168cf27904c03baaf1f2c227529403315d819", size: 37305766 },
  },
};
