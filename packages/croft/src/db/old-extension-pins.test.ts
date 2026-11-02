// The pins of the DuckDB 1.5.5 extension files (old-extension-pins.ts): complete for the four platforms, well formed, and the ones for the
// platform this runs on match files already fetched into the folder named by CROFT_TEST_OLD_EXTENSIONS, when it is set (the CI job that reads a
// lake with DuckDB 1.5.5 sets it, after scripts/fetch-old-duckdb.ts checked them against the repository).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hostPlatform } from "./extension-files.ts";
import { PLATFORMS } from "./extension-names.ts";
import { OLD_EXTENSION_PINS } from "./old-extension-pins.ts";

describe("the pins of the DuckDB 1.5.5 extension files", () => {
  test("every platform has the three files, each with a sha256 and a size", () => {
    expect(Object.keys(OLD_EXTENSION_PINS).sort()).toEqual([...PLATFORMS].sort());
    for (const platform of PLATFORMS) {
      expect(Object.keys(OLD_EXTENSION_PINS[platform]).sort(), platform).toEqual(["ducklake", "httpfs", "postgres_scanner"]);
      for (const [name, pin] of Object.entries(OLD_EXTENSION_PINS[platform])) {
        expect(pin.sha256, `${platform}/${name}`).toMatch(/^[0-9a-f]{64}$/);
        expect(pin.size, `${platform}/${name}`).toBeGreaterThan(1_000_000);
      }
    }
  });

  const dir = process.env.CROFT_TEST_OLD_EXTENSIONS;
  (dir && existsSync(dir) && hostPlatform() ? test : test.skip)("the files fetched here are the pinned ones", () => {
    const platform = hostPlatform()!;
    for (const [name, pin] of Object.entries(OLD_EXTENSION_PINS[platform])) {
      const path = join(dir!, `${name}.duckdb_extension`);
      expect(statSync(path).size, name).toBe(pin.size);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex"), name).toBe(pin.sha256);
    }
  });
});
