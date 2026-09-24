// The real Node binary for tests, or null. Bun's Docker images put a `node` on PATH that is Bun itself
// (bun-node-fallback-bin), which would make "under Node" tests test Bun; those tests are skipped then.
import { spawnSync } from "node:child_process";

export function realNode(): string | null {
  const node = Bun.which("node");
  if (!node) return null;
  const r = spawnSync(node, ["-p", "typeof Bun === 'undefined' && process.release.name === 'node' ? 'node' : 'other'"],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  return r.status === 0 && r.stdout.trim() === "node" ? node : null;
}
