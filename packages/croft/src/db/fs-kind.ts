// Which filesystem holds the warehouse (DESIGN.md §5 "Same kernel only"). DuckDB's lock is a POSIX fcntl
// lock, which only holds between processes of one kernel: on a VM or container share (virtiofs, Docker
// Desktop's grpcfuse and fakeowner, 9p, which is also WSL's drives) or a network filesystem (NFS, SMB, AFP,
// sshfs) a process on the other side neither sees nor honors it. croft serve holds the file for hours and
// hands it over by that lock, so it refuses such a mount with SERVE_UNSAFE_FILESYSTEM.
//
// - Linux: the longest mount point in /proc/self/mounts that holds the folder, which names FUSE subtypes
//   (fuse.sshfs, fuse.grpcfuse) and virtiofs; without /proc, the statfs magic number, where every FUSE mount
//   looks alike and so is not refused.
// - macOS: the mount point `df -P` names for the folder (it resolves firmlinks such as /Users), and its type
//   in `mount`'s table; without df, the longest mount point that holds the path.
// - Nothing here opens the warehouse: it looks at folders, and df and mount run in child processes. Closing
//   any descriptor on the file would drop this process's DuckDB lock (§5, hazard 3).
// The probe is injectable, so tests describe any machine.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, statfsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CroftError } from "../core/errors.ts";
import { physicalPath, relocationDir } from "../project/root.ts";

export interface FsProbe {
  platform: NodeJS.Platform;
  /** Linux: the text of /proc/self/mounts, or null. */
  procMounts(): string | null;
  /** statfs f_type of an existing folder, or null. */
  statfsType(dir: string): number | null;
  /** macOS: the output of `mount`, or null. */
  mountTable(): string | null;
  /** macOS: the mount point `df -P` names for an existing folder, or null. */
  mountPointOf(dir: string): string | null;
}

export interface Mount { source: string; point: string; type: string }

export interface FsKind {
  /** The filesystem type ("apfs", "ext4", "fuse.grpcfuse", "nfs"), or null when it could not be told. */
  type: string | null;
  mountPoint: string | null;
  source: "mounts" | "statfs" | "none";
  /** Why DuckDB's lock cannot be trusted there, in words ("NFS, a network filesystem"), or null. */
  unsafe: string | null;
}

// A fixed environment for df and mount: absolute tools, C locale.
const TOOL_ENV = { PATH: "/usr/sbin:/sbin:/usr/bin:/bin", LC_ALL: "C" };

function tool(cmd: string, args: string[]): string | null {
  try {
    const out = spawnSync(cmd, args, { encoding: "utf8", env: TOOL_ENV, timeout: 5000 });
    return out.status === 0 && typeof out.stdout === "string" ? out.stdout : null;
  } catch {
    return null;
  }
}

export const realProbe: FsProbe = {
  platform: process.platform,
  procMounts() {
    for (const f of ["/proc/self/mounts", "/proc/mounts"]) {
      try {
        return readFileSync(f, "utf8");
      } catch {}
    }
    return null;
  },
  statfsType(dir) {
    try {
      return statfsSync(dir).type;
    } catch {
      return null;
    }
  },
  mountTable() {
    return tool("/sbin/mount", []);
  },
  mountPointOf(dir) {
    const out = tool("/bin/df", ["-P", dir]);
    // "Filesystem 512-blocks Used Available Capacity Mounted on": the mount point follows the capacity, and
    // it (like the device) may contain spaces.
    const last = out?.trim().split("\n").at(-1) ?? "";
    return /\s\d+%\s+(\/.*)$/.exec(last)?.[1] ?? null;
  },
};

/** /proc/mounts: "source point type options 0 0", with spaces and tabs in names written as octal escapes. */
export function parseProcMounts(text: string): Mount[] {
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
  const out: Mount[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    out.push({ source: unescape(f[0]!), point: unescape(f[1]!), type: f[2]! });
  }
  return out;
}

/** macOS `mount`: "<source> on <point> (<type>, <options…>)". */
export function parseMacMounts(text: string): Mount[] {
  const out: Mount[] = [];
  for (const line of text.split("\n")) {
    const m = /^(.+?) on (\/.*) \(([^,()]+)(?:,[^()]*)?\)\s*$/.exec(line);
    if (m) out.push({ source: m[1]!, point: m[2]!, type: m[3]!.trim() });
  }
  return out;
}

// Linux statfs f_type magic numbers.
const MAGIC: Record<number, string> = {
  0x6969: "nfs", 0x517b: "smbfs", 0xff534d42: "cifs", 0xfe534d42: "smb2", 0x01021997: "9p", 0x65735546: "fuse",
  0xef53: "ext4", 0x58465342: "xfs", 0x9123683e: "btrfs", 0x01021994: "tmpfs", 0x794c7630: "overlay", 0x2fc12fc1: "zfs",
};

const DOCKER = "Docker Desktop's file sharing";
const UNSAFE: Record<string, string> = {
  virtiofs: "virtiofs, a VM or container file share",
  grpcfuse: `grpcfuse, ${DOCKER}`,
  "fuse.grpcfuse": `grpcfuse, ${DOCKER}`,
  fakeowner: `fakeowner, ${DOCKER}`,
  "9p": "9p, a VM share or a WSL drive",
  nfs: "NFS, a network filesystem",
  nfs4: "NFS, a network filesystem",
  smbfs: "SMB, a network share",
  cifs: "SMB (cifs), a network share",
  smb2: "SMB, a network share",
  smb3: "SMB, a network share",
  afpfs: "AFP, a network share",
  "fuse.sshfs": "sshfs, a folder on another machine",
  sshfs: "sshfs, a folder on another machine",
  webdav: "WebDAV, a network folder",
};

/** Why a filesystem type (and mount source) cannot hold DuckDB's lock, or null when it can. */
export function unsafeLabel(type: string, source: string): string | null {
  const known = UNSAFE[type.toLowerCase()];
  if (known) return known;
  // macFUSE shows every FUSE mount under one type; sshfs is the one whose source is user@host:path.
  if (/^(macfuse|osxfuse|fuse)$/i.test(type) && /^[^\s/@]+@[^\s/:]+:/.test(source)) return UNSAFE.sshfs!;
  return null;
}

const holds = (point: string, dir: string) => dir === point || dir.startsWith(point.endsWith("/") ? point : `${point}/`);

/** The mount a folder is on: the longest mount point that holds it; of mounts on one point, the last. */
function mountOf(mounts: Mount[], dir: string): Mount | null {
  let best: Mount | null = null;
  for (const m of mounts) if (holds(m.point, dir) && (!best || m.point.length >= best.point.length)) best = m;
  return best;
}

/** The nearest folder of `dir` that exists (the database's folder may not be created yet). */
function existing(dir: string): string {
  for (let d = dir; ; d = dirname(d)) {
    try {
      if (lstatSync(d).isDirectory()) return d;
    } catch {}
    if (dirname(d) === d) return d;
  }
}

function fromMount(m: Mount): FsKind {
  return { type: m.type, mountPoint: m.point, source: "mounts", unsafe: unsafeLabel(m.type, m.source) };
}

const UNKNOWN: FsKind = { type: null, mountPoint: null, source: "none", unsafe: null };

/** The filesystem of a folder. */
export function folderKind(folder: string, probe: FsProbe = realProbe): FsKind {
  const dir = physicalPath(resolve(folder)).path; // symlinks followed with lstat/readlink: nothing is opened
  if (probe.platform === "linux") {
    const text = probe.procMounts();
    const m = text ? mountOf(parseProcMounts(text), dir) : null;
    if (m) return fromMount(m);
    const magic = probe.statfsType(existing(dir));
    if (magic === null) return UNKNOWN;
    const type = MAGIC[magic] ?? `0x${magic.toString(16)}`;
    return { type, mountPoint: null, source: "statfs", unsafe: unsafeLabel(type, "") };
  }
  if (probe.platform === "darwin" || probe.platform === "freebsd" || probe.platform === "openbsd") {
    const text = probe.mountTable();
    if (!text) return UNKNOWN;
    const mounts = parseMacMounts(text);
    const point = probe.mountPointOf(existing(dir));
    const onPoint = point === null ? null : mounts.filter((x) => x.point === point).at(-1) ?? null;
    const m = onPoint ?? mountOf(mounts, dir);
    return m ? fromMount(m) : UNKNOWN;
  }
  return UNKNOWN;
}

/** The filesystem a file is (or will be) on: its folder's. */
export function filesystemKind(path: string, probe: FsProbe = realProbe): FsKind {
  return folderKind(dirname(resolve(path)), probe);
}

/**
 * Throw SERVE_UNSAFE_FILESYSTEM when the database or the state folder (its write intents) is on a filesystem
 * whose locks do not hold across machines.
 */
export function assertSafeFilesystem(p: { root: string; database: string; stateDir: string }, probe: FsProbe = realProbe): void {
  const checks: { what: string; path: string; kind: FsKind }[] = [
    { what: "the database", path: p.database, kind: filesystemKind(p.database, probe) },
    { what: "the state folder", path: p.stateDir, kind: folderKind(p.stateDir, probe) },
  ];
  const bad = checks.find((c) => c.kind.unsafe !== null);
  if (!bad) return;
  const dir = relocationDir(p.root);
  throw new CroftError("SERVE_UNSAFE_FILESYSTEM", {
    message: `${bad.what} ${bad.path} is on ${bad.kind.unsafe}, where DuckDB's file lock does not hold across machines: `
      + "croft serve could not hand the file to runs safely, and writes could be lost",
    hint: "keep the database and .croft/ on a disk of the machine (or container) that runs every croft command, "
      + `such as ${dir}, and run croft serve and croft run there`,
    fix: {
      kind: "manual", requiresHuman: true,
      description: `with no croft command running, move ${p.database} and ${p.stateDir} to ${dir}, then set `
        + `"database": "${join(dir, "warehouse.duckdb")}" and "stateDir": "${join(dir, ".croft")}" in croft.json`,
    },
    details: { path: bad.path, filesystem: bad.kind.type, mountPoint: bad.kind.mountPoint, detectedBy: bad.kind.source },
  });
}
