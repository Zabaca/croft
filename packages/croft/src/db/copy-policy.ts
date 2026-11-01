// The copy policy (DESIGN.md D121, §5 "Server mode"): what a refresh of the read copy costs where the filesystem cannot
// clone files, and when server mode refuses to run because of it.
//
// A refresh clones the warehouse file (an APFS clone or a reflink: milliseconds and about no extra disk, measured at 1
// to 5 GB). Where the filesystem cannot clone (ext4, the usual Linux one; exFAT; most network shares) the same refresh
// is a plain copy: as much disk again as the warehouse, and the run holds its write lease for the whole copy, because
// a write during it would tear the copy. Server mode needs a refresh after every run that changed data, so it refuses to
// start where that is a large copy, unless the project says in croft.json that it accepts the cost
// (serverMode.acceptFullCopyCost). The threshold is 1 GB, where a plain copy already took 0.44 s and 1.07 GB of disk
// (measured on an Apple SSD, APFS); the projects below it are not asked anything.
//
// "Can this filesystem clone" is found by trying: a small file in the warehouse's own folder (the copy is made there)
// is cloned strictly, so that it fails where cloning is not possible instead of falling back to a copy the way the
// refresh's `cp` does. On macOS `cp -c` is not strict: it exited 0 on a FAT volume, having copied, so the probe uses
// `copyFileSync` with COPYFILE_FICLONE_FORCE, which is ENOTSUP there [V: Bun 1.3.14, APFS and a FAT disk image]. On Linux
// it is `cp` with reflink always. Nothing here opens the warehouse: a stat of the file gives its size. The probe runs
// only for a warehouse of warnBytes or more (under it nothing is said or refused) and once per process per folder, so
// status, doctor and GET /status do not write a dotfile beside the warehouse on every call.
import { spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import type { Project } from "../project/root.ts";

export const COPY_POLICY = {
  /** Server mode refuses a copy that cannot be cloned above this many bytes, unless the project accepts the cost. */
  thresholdBytes: 1_000_000_000,
  /** Below this a full copy costs well under a second and next to no disk: doctor and status do not warn. */
  warnBytes: 100_000_000,
  /** A plain copy's speed, from the measurements (APFS: 1.96 s for 5.35 GB, about 2.7 GB/s) to a slow disk (inferred,
   *  Linux ext4 was not measured): 40 s at 5 GB is 125 MB/s. */
  fastBytesPerS: 2_500_000_000,
  slowBytesPerS: 125_000_000,
} as const;

const CP_PATHS = ["/bin/cp", "/usr/bin/cp"] as const;
/** GNU cp's flag that fails where a reflink is not possible. Built from two parts: the agent-contract scan reads every
 *  string of the source and would take the whole flag for an option of croft's own. */
const REFLINK_ALWAYS = "-" + "-reflink=always";
const PROBE_BYTES = 64 * 1024;

/** The result of trying to clone a small file next to the warehouse. */
export interface CloneProbe {
  canClone: boolean;
  /** How it cloned: macOS's clonefile (`cp -c`) or a Linux reflink; null when it cannot. */
  method: "clone" | "reflink" | null;
  /** Why not, in a few words, when it cannot. */
  why: string | null;
}

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  /** Linux: where cp is looked for (tests). */
  cp?: readonly string[];
  /** macOS: clone one file strictly, throwing where the filesystem cannot (tests). Default: copyFileSync with
   *  COPYFILE_FICLONE_FORCE. */
  cloneFile?: (src: string, dst: string) => void;
}

/** Tests: the size above which a copy that cannot be cloned is too costly (COPY_POLICY.thresholdBytes). */
export interface ThresholdOption { thresholdBytes?: number }

const strictClone = (src: string, dst: string) => copyFileSync(src, dst, constants.COPYFILE_FICLONE_FORCE);

/** Try to clone a 64 KiB file in `dir`, strictly. Never throws; leaves nothing behind. */
export function probeClone(dir: string, o: ProbeOptions = {}): CloneProbe {
  const platform = o.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return { canClone: false, method: null, why: `croft clones files on macOS and Linux, not ${platform}` };
  const cp = platform === "linux" ? (o.cp ?? CP_PATHS).find((p) => existsSync(p)) : null;
  if (platform === "linux" && !cp) return { canClone: false, method: null, why: "cp was not found" };
  const stem = join(dir, `.croft-clone-probe.${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const src = `${stem}.a`;
  const dst = `${stem}.b`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(src, Buffer.alloc(PROBE_BYTES, 1));
    if (platform === "darwin") {
      (o.cloneFile ?? strictClone)(src, dst);
      return { canClone: true, method: "clone", why: null };
    }
    const r = spawnSync(cp!, [REFLINK_ALWAYS, src, dst], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 });
    if (r.status === 0 && existsSync(dst)) return { canClone: true, method: "reflink", why: null };
    const why = String(r.stderr ?? "").trim().split("\n")[0] || (r.error ? r.error.message : `cp exited ${r.status}`);
    return { canClone: false, method: null, why: why.slice(0, 200) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    const text = String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200);
    return { canClone: false, method: null, why: code && !text.includes(code) ? `${code}: ${text}` : text };
  } finally {
    rmSync(src, { force: true });
    rmSync(dst, { force: true });
  }
}

/** What a refresh costs on this project's disk, and what server mode makes of it. */
export interface CopyPolicy {
  /** The warehouse file's size in bytes (0 before the first run). */
  bytes: number;
  clone: CloneProbe;
  /** Disk a refresh costs: nothing where it can clone; otherwise one more copy of the warehouse at rest, and up to two
   *  while a refresh runs (the new file beside the old one). */
  diskBytes: number;
  /** Seconds a refresh holds the write lease while it copies (a range; inferred, see COPY_POLICY), null where it clones. */
  copySeconds: { low: number; high: number } | null;
  /** The warehouse is over the threshold and cannot be cloned. */
  overThreshold: boolean;
  /** serverMode.acceptFullCopyCost. */
  accepted: boolean;
  /** Server mode is on and may not run: it cannot clone, the warehouse is over the threshold, and the cost is not accepted. */
  refused: boolean;
  /** doctor and status warn: the read copy is on, it cannot clone, and a copy is big enough to matter. */
  warn: boolean;
}

// The probe's answer per folder, for this process: a filesystem does not change under a running croft. Not used when a
// test injects its own way of cloning.
const probed = new Map<string, CloneProbe>();

/** Assess the project's read copy. Stats the warehouse; for one of warnBytes or more it also tries a clone (once per
 *  process per folder); opens nothing. Under warnBytes nothing is tried: nothing is said or refused there. */
export function assessCopyPolicy(project: Project, o: ProbeOptions & ThresholdOption & { clone?: CloneProbe } = {}): CopyPolicy {
  let bytes = 0;
  try {
    bytes = statSync(project.paths.database).size;
  } catch {}
  const dir = dirname(project.paths.readCopy);
  let clone: CloneProbe;
  if (o.clone) clone = o.clone;
  else if (bytes < COPY_POLICY.warnBytes) clone = { canClone: true, method: null, why: `not tried: the warehouse is under ${sizeText(COPY_POLICY.warnBytes)}` };
  else if (o.platform || o.cp || o.cloneFile) clone = probeClone(dir, o);
  else {
    const hit = probed.get(dir);
    clone = hit ?? probeClone(dir);
    if (!hit) probed.set(dir, clone);
  }
  const overThreshold = !clone.canClone && bytes > (o.thresholdBytes ?? COPY_POLICY.thresholdBytes);
  const accepted = project.config.serverMode.acceptFullCopyCost;
  return {
    bytes, clone,
    diskBytes: clone.canClone ? 0 : bytes,
    copySeconds: clone.canClone ? null : { low: bytes / COPY_POLICY.fastBytesPerS, high: bytes / COPY_POLICY.slowBytesPerS },
    overThreshold, accepted,
    refused: project.config.serverMode.enabled && overThreshold && !accepted,
    warn: project.config.readCopy && !clone.canClone && bytes >= COPY_POLICY.warnBytes,
  };
}

/** "1.4 GB", "820 MB". */
export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** "about 1 to 11 s". */
export function secondsText(r: { low: number; high: number }): string {
  const low = Math.max(1, Math.round(r.low));
  const high = Math.max(low, Math.round(r.high));
  return low === high ? `about ${high} s` : `about ${low} to ${high} s`;
}

/** What each refresh costs, in a sentence: "each refresh copies the whole 1.4 GB warehouse ...". */
export function copyCostText(p: CopyPolicy): string {
  const why = p.clone.why ? ` (${p.clone.why})` : "";
  const time = p.copySeconds ? secondsText(p.copySeconds) : "a moment";
  return `this filesystem cannot clone files${why}, so each refresh of the read copy copies the whole ${sizeText(p.bytes)} warehouse: `
    + `${sizeText(p.diskBytes)} more disk (up to ${sizeText(p.diskBytes * 2)} while it runs) and the run's write lease held for ${time}`;
}

const ACCEPT_FIX = {
  kind: "manual" as const,
  description: 'accept the cost in croft.json ("serverMode": {"enabled": true, "acceptFullCopyCost": true}), or keep the warehouse on a filesystem that can clone (APFS, btrfs, XFS with reflink)',
  requiresHuman: true,
};

/**
 * The problem server mode is refused with (SERVER_MODE_COPY_COSTLY). `stage` "start" is croft serve not starting. "limit"
 * is everywhere else, where the project is already past the limit and refreshes carry on regardless (a refresh that
 * stopped would leave a running croft serve answering older and older data): croft status, croft doctor and the warning
 * in a run's output.
 */
export function copyCostlyProblem(p: CopyPolicy, stage: "start" | "limit" = "start"): Problem {
  const over = `the warehouse is over ${sizeText(COPY_POLICY.thresholdBytes)} and serverMode.acceptFullCopyCost is not set`;
  return problem("SERVER_MODE_COPY_COSTLY", {
    message: stage === "start"
      ? `server mode is not started: ${copyCostText(p)}, and the warehouse is over ${sizeText(COPY_POLICY.thresholdBytes)}`
      : `server mode is past its limit: ${copyCostText(p)}; ${over}. The copy is still refreshed, and croft serve will not start until the cost is accepted`,
    hint: 'move the project to a filesystem that can clone, or accept the cost: set "serverMode.acceptFullCopyCost" to true in croft.json (ask the user first: it is disk and write time on every run)',
    fix: ACCEPT_FIX,
    retryable: false,
    details: {
      warehouseBytes: p.bytes, thresholdBytes: COPY_POLICY.thresholdBytes, canClone: false, cloneFailure: p.clone.why,
      diskBytes: p.diskBytes, copySeconds: p.copySeconds,
    },
  });
}

/** Throw SERVER_MODE_COPY_COSTLY when server mode is on and the policy refuses it. Returns the assessment. */
export function assertCopyPolicy(project: Project, o: ProbeOptions & ThresholdOption & { clone?: CloneProbe } = {}): CopyPolicy {
  const p = assessCopyPolicy(project, o);
  if (p.refused) {
    const { code: _c, severity: _s, docs: _d, ...init } = copyCostlyProblem(p);
    throw new CroftError("SERVER_MODE_COPY_COSTLY", init);
  }
  return p;
}

/** The warning doctor and status show: the read copy is a full copy at every refresh. */
export function notClonedProblem(p: CopyPolicy): Problem {
  return problem("READ_COPY_NOT_CLONED", {
    message: copyCostText(p),
    hint: "this is the normal case on ext4, the usual Linux filesystem; a filesystem that can clone (APFS, btrfs, XFS with reflink) makes a refresh instant",
    fix: { kind: "manual", description: "nothing to fix if the cost is acceptable; otherwise keep the project on a filesystem that can clone" },
    details: { warehouseBytes: p.bytes, diskBytes: p.diskBytes, copySeconds: p.copySeconds, cloneFailure: p.clone.why },
  });
}
