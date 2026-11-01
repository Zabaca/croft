// The copy policy (db/copy-policy.ts, DESIGN.md D121): where the filesystem cannot clone, a refresh of the read copy is a full
// copy, doctor and status say what it costs, and server mode refuses a warehouse over 1 GB unless the project accepts it.
// The filesystem is simulated by the `cp` the probe runs: a script that refuses the clone flags, or one that accepts them.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { loadProject } from "../project/root.ts";
import { assertCopyPolicy, assessCopyPolicy, copyCostlyProblem, copyCostText, COPY_POLICY, notClonedProblem, probeClone, secondsText, sizeText } from "./copy-policy.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "croft-policy-")));
  dirs.push(d);
  return d;
}

/** A `cp` that cannot clone (what ext4 gives): it refuses the clone flags and otherwise copies. */
function cpWithoutClone(): string {
  const f = join(temp(), "cp");
  writeFileSync(f, '#!/bin/sh\nfor a in "$@"; do case "$a" in -c|--reflink=always) echo "failed to clone: Operation not supported" >&2; exit 1;; esac; done\nexec /bin/cp "$@"\n');
  chmodSync(f, 0o755);
  return f;
}

/** A `cp` that clones whatever it is asked to (APFS, btrfs): it copies the last two arguments and ignores the flag. */
function cpThatClones(): string {
  const f = join(temp(), "cp");
  writeFileSync(f, '#!/bin/sh\nfor a in "$@"; do src="$dst"; dst="$a"; done\nexec /bin/cp "$src" "$dst"\n');
  chmodSync(f, 0o755);
  return f;
}

/** A project whose warehouse file is `bytes` big: a sparse file, since the policy only looks at its size. */
function sized(bytes: number, serverMode: Record<string, unknown> = { enabled: true }, readCopy?: boolean) {
  const root = temp();
  mkdirSync(join(root, ".croft"));
  writeFileSync(join(root, "croft.json"), JSON.stringify({ timezone: "UTC", serverMode, ...(readCopy === undefined ? {} : { readCopy }) }));
  const project = loadProject({ root });
  writeFileSync(project.paths.database, "");
  truncateSync(project.paths.database, bytes);
  return project;
}

const GB = 1_000_000_000;
const noClone = (platform: NodeJS.Platform = "linux") => ({ platform, cp: [cpWithoutClone()] });
const clones = (platform: NodeJS.Platform = "darwin") => ({ platform, cp: [cpThatClones()] });

describe("probeClone", () => {
  test("tries the platform's strict flag on a small file beside the warehouse, and leaves nothing behind", () => {
    const dir = temp();
    expect(probeClone(dir, clones("darwin"))).toEqual({ canClone: true, method: "clone", why: null });
    expect(probeClone(dir, clones("linux"))).toEqual({ canClone: true, method: "reflink", why: null });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a filesystem that refuses the clone says why", () => {
    const dir = temp();
    for (const platform of ["linux", "darwin"] as const) {
      const r = probeClone(dir, noClone(platform));
      expect(r).toMatchObject({ canClone: false, method: null });
      expect(r.why).toContain("failed to clone");
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a platform croft does not clone on, a missing cp and a missing folder cannot clone, and never throw", () => {
    const dir = temp();
    expect(probeClone(dir, { platform: "win32" })).toMatchObject({ canClone: false, why: expect.stringContaining("win32") });
    expect(probeClone(dir, { platform: "linux", cp: ["/nonexistent/cp"] })).toMatchObject({ canClone: false, why: "cp was not found" });
    const gone = join(dir, "a", "b");
    expect(probeClone(gone, clones()).canClone).toBe(true); // the folder is made for the probe
    expect(existsSync(gone)).toBe(true);
  });

  test("on this machine it answers (macOS and btrfs clone, ext4 does not) and leaves nothing behind", () => {
    const dir = temp();
    const r = probeClone(dir);
    expect(typeof r.canClone).toBe("boolean");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("what a refresh costs", () => {
  test("where it clones, nothing: no disk and no time, and no warning at any size", () => {
    const p = assessCopyPolicy(sized(5 * GB), clones());
    expect(p).toMatchObject({ bytes: 5 * GB, diskBytes: 0, copySeconds: null, overThreshold: false, refused: false, warn: false });
  });

  test("where it cannot clone, a full copy of the warehouse: disk, and the seconds the write lease is held (a range)", () => {
    const p = assessCopyPolicy(sized(5 * GB), noClone());
    expect(p.diskBytes).toBe(5 * GB);
    expect(p.copySeconds!.low).toBeCloseTo(2, 0);
    expect(p.copySeconds!.high).toBeCloseTo(40, 0);
    expect(copyCostText(p)).toContain("cannot clone files");
    expect(copyCostText(p)).toContain("5.0 GB more disk (up to 10.0 GB while it runs)");
    expect(copyCostText(p)).toContain("about 2 to 40 s");
  });

  test("sizes and times are written for people", () => {
    expect(sizeText(1_400_000_000)).toBe("1.4 GB");
    expect(sizeText(820_000_000)).toBe("820 MB");
    expect(sizeText(1)).toBe("1 MB");
    expect(secondsText({ low: 0.2, high: 3.2 })).toBe("about 1 to 3 s");
    expect(secondsText({ low: 2, high: 2 })).toBe("about 2 s");
  });
});

describe("server mode and the 1 GB threshold", () => {
  test("a warehouse over 1 GB on a filesystem that cannot clone is refused, with a hint that names the setting", () => {
    const project = sized(1.5 * GB);
    const err = (() => {
      try {
        assertCopyPolicy(project, noClone());
      } catch (e) {
        return e as CroftError;
      }
      throw new Error("expected a refusal");
    })();
    expect(err.code).toBe("SERVER_MODE_COPY_COSTLY");
    expect(err.problem.message).toContain("1.5 GB");
    expect(err.problem.hint).toContain("serverMode.acceptFullCopyCost");
    expect(err.problem.retryable).toBe(false);
    expect(err.problem.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(err.problem.details).toMatchObject({ warehouseBytes: 1.5 * GB, thresholdBytes: COPY_POLICY.thresholdBytes, canClone: false });
  });

  test("the threshold is 1 GB: at it and below it server mode runs, above it only where the copy clones or the cost is accepted", () => {
    expect(COPY_POLICY.thresholdBytes).toBe(GB);
    expect(assessCopyPolicy(sized(GB), noClone()).refused).toBe(false);
    expect(assessCopyPolicy(sized(GB + 1), noClone()).refused).toBe(true);
    expect(assessCopyPolicy(sized(50 * GB), clones()).refused).toBe(false);
    const accepted = assessCopyPolicy(sized(2 * GB, { enabled: true, acceptFullCopyCost: true }), noClone());
    expect(accepted).toMatchObject({ overThreshold: true, accepted: true, refused: false });
    expect(() => assertCopyPolicy(sized(2 * GB, { enabled: true, acceptFullCopyCost: true }), noClone())).not.toThrow();
  });

  test("without server mode nothing is refused, however big the warehouse, and the plain read copy only warns", () => {
    const off = assessCopyPolicy(sized(3 * GB, { enabled: false }, true), noClone());
    expect(off).toMatchObject({ overThreshold: true, refused: false, warn: true });
    expect(() => assertCopyPolicy(sized(3 * GB, { enabled: false }, true), noClone())).not.toThrow();
  });

  test("a warning only where a copy is big enough to matter, and only with the read copy on", () => {
    expect(assessCopyPolicy(sized(COPY_POLICY.warnBytes - 1), noClone()).warn).toBe(false);
    expect(assessCopyPolicy(sized(COPY_POLICY.warnBytes), noClone()).warn).toBe(true);
    expect(assessCopyPolicy(sized(5 * GB, { enabled: false }, false), noClone()).warn).toBe(false);
  });

  test("the problems carry codes with docs pages, and the numbers", () => {
    const p = assessCopyPolicy(sized(1.5 * GB), noClone());
    const refusal = copyCostlyProblem(p);
    expect(refusal).toMatchObject({ code: "SERVER_MODE_COPY_COSTLY", severity: "error", docs: "croft docs SERVER_MODE_COPY_COSTLY" });
    const warning = notClonedProblem(p);
    expect(warning).toMatchObject({ code: "READ_COPY_NOT_CLONED", severity: "warning" });
    expect(warning.message).toContain("1.5 GB");
  });

  test("a warehouse that does not exist yet costs nothing", () => {
    const project = sized(0);
    rmSync(project.paths.database);
    expect(assessCopyPolicy(project, noClone())).toMatchObject({ bytes: 0, refused: false, warn: false });
  });
});
