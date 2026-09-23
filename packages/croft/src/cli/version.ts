// The installed croft version and the Bun floor, both read from package.json so they cannot drift.
import pkg from "../../package.json" with { type: "json" };

export const CROFT_VERSION: string = pkg.version;
export const BUN_FLOOR: string = pkg.engines.bun.replace(/^>=\s*/, "");

/** True when version `have` (e.g. "1.3.14", "1.4.0-canary.2") is at least `floor`. */
export function versionAtLeast(have: string, floor: string): boolean {
  const parse = (v: string) => v.split(/[-+]/)[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(have);
  const b = parse(floor);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
