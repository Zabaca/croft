import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import {
  assertSafeFilesystem, filesystemKind, folderKind, type FsProbe, parseMacMounts, parseProcMounts, realProbe, unsafeLabel,
} from "./fs-kind.ts";

const PROC_MOUNTS = `overlay / overlay rw,relatime,lowerdir=/x,upperdir=/y,workdir=/z 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
/dev/vda1 /data ext4 rw,relatime 0 0
grpcfuse /data/proj fuse.grpcfuse rw,nosuid,nodev,relatime,user_id=0,group_id=0,allow_other,max_read=1048576 0 0
mount0 /mnt/vfs virtiofs rw,relatime 0 0
/run/host_mark/Users /Users fakeowner rw,nosuid,nodev,relatime,fakeowner 0 0
drvfs /mnt/c 9p rw,noatime,dirsync,aname=drvfs;path=C:\\;uid=1000;gid=1000,trans=virtio 0 0
nas:/export /mnt/nfs nfs4 rw,relatime,vers=4.2 0 0
//nas/share /mnt/my\\040share cifs rw,relatime,vers=3.1.1 0 0
user@host:/srv /mnt/ssh fuse.sshfs rw,nosuid,nodev,relatime,user_id=1000 0 0
tmpfs /data/proj/tmp tmpfs rw 0 0
/dev/vdb1 /data/proj/tmp ext4 rw 0 0
`;

const MAC_MOUNT = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)
map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
//me@nas._smb._tcp.local/share on /Volumes/share (smbfs, nodev, nosuid, mounted by me)
afp_0TQ2f10000 on /Volumes/Time Machine (afpfs, nodev, nosuid, mounted by me)
nas:/export on /Users/me/nfs (nfs, nodev, nosuid, mounted by me)
OrbStack:/OrbStack on /Users/me/OrbStack (nfs, nodev, nosuid, noatime, mounted by me)
me@host:/srv on /Users/me/ssh (macfuse, nodev, nosuid, synchronous, mounted by me)
/dev/disk4s1 on /Volumes/Fredrin 1 (hfs, local, nodev, nosuid, read-only, noowners, quarantine, mounted by me)
`;

function linux(o: Partial<FsProbe> = {}): FsProbe {
  return { platform: "linux", procMounts: () => PROC_MOUNTS, statfsType: () => null, mountTable: () => null, mountPointOf: () => null, ...o };
}

function mac(o: Partial<FsProbe> = {}): FsProbe {
  return { platform: "darwin", procMounts: () => null, statfsType: () => null, mountTable: () => MAC_MOUNT, mountPointOf: () => null, ...o };
}

describe("parsing mount tables", () => {
  test("/proc/mounts: octal escapes in mount points", () => {
    const m = parseProcMounts(PROC_MOUNTS);
    expect(m.find((x) => x.type === "cifs")).toEqual({ source: "//nas/share", point: "/mnt/my share", type: "cifs" });
    expect(m).toHaveLength(12);
  });

  test("macOS mount: mount points with spaces, the type is the first option", () => {
    const m = parseMacMounts(MAC_MOUNT);
    expect(m.find((x) => x.point === "/Volumes/Time Machine")?.type).toBe("afpfs");
    expect(m.find((x) => x.point === "/Volumes/Fredrin 1")?.type).toBe("hfs");
    expect(m.find((x) => x.point === "/System/Volumes/Data/home")?.source).toBe("map auto_home");
  });
});

describe("filesystemKind on Linux", () => {
  test.each([
    ["/data/proj/warehouse.duckdb", "fuse.grpcfuse", "/data/proj"],
    ["/mnt/vfs/p/warehouse.duckdb", "virtiofs", "/mnt/vfs"],
    ["/Users/me/p/warehouse.duckdb", "fakeowner", "/Users"],
    ["/mnt/c/Users/me/p/warehouse.duckdb", "9p", "/mnt/c"],
    ["/mnt/nfs/p/warehouse.duckdb", "nfs4", "/mnt/nfs"],
    ["/mnt/my share/warehouse.duckdb", "cifs", "/mnt/my share"],
    ["/mnt/ssh/warehouse.duckdb", "fuse.sshfs", "/mnt/ssh"],
  ])("%s is on %s: unsafe", (path, type, point) => {
    const k = filesystemKind(path, linux());
    expect(k).toMatchObject({ type, mountPoint: point, source: "mounts" });
    expect(k.unsafe).toBeString();
  });

  test("local filesystems are safe; the longest mount point wins, and the last mount on a point hides earlier ones", () => {
    expect(filesystemKind("/data/other/warehouse.duckdb", linux())).toMatchObject({ type: "ext4", mountPoint: "/data", unsafe: null });
    expect(filesystemKind("/home/me/p/warehouse.duckdb", linux())).toMatchObject({ type: "overlay", mountPoint: "/", unsafe: null });
    expect(filesystemKind("/data/proj/tmp/warehouse.duckdb", linux())).toMatchObject({ type: "ext4", mountPoint: "/data/proj/tmp", unsafe: null });
    // /data/project is not inside /data/proj.
    expect(filesystemKind("/data/project/warehouse.duckdb", linux())).toMatchObject({ type: "ext4", mountPoint: "/data" });
  });

  test("without /proc/mounts, the statfs magic number decides", () => {
    const at = (magic: number) => filesystemKind("/x/warehouse.duckdb", linux({ procMounts: () => null, statfsType: () => magic }));
    expect(at(0x6969)).toMatchObject({ type: "nfs", source: "statfs" });
    expect(at(0x6969).unsafe).toBeString();
    expect(at(0xff534d42)).toMatchObject({ type: "cifs" });
    expect(at(0xfe534d42)).toMatchObject({ type: "smb2" });
    expect(at(0x517b)).toMatchObject({ type: "smbfs" });
    expect(at(0x01021997)).toMatchObject({ type: "9p" });
    expect(at(0x01021997).unsafe).toBeString();
    // FUSE hides its subtype (sshfs, grpcfuse, a local encrypted folder): not refused on the magic alone.
    expect(at(0x65735546)).toMatchObject({ type: "fuse", unsafe: null });
    expect(at(0xef53)).toMatchObject({ type: "ext4", unsafe: null });
    expect(at(0x12345)).toMatchObject({ type: "0x12345", unsafe: null });
    expect(filesystemKind("/x/warehouse.duckdb", linux({ procMounts: () => null }))).toMatchObject({ type: null, source: "none", unsafe: null });
  });
});

describe("filesystemKind on macOS", () => {
  test("df's mount point picks the mount; network and VM shares are unsafe", () => {
    const k = filesystemKind("/Volumes/share/p/warehouse.duckdb", mac({ mountPointOf: () => "/Volumes/share" }));
    expect(k).toMatchObject({ type: "smbfs", mountPoint: "/Volumes/share", source: "mounts" });
    expect(k.unsafe).toBeString();
    expect(filesystemKind("/Volumes/Time Machine/p/w.duckdb", mac({ mountPointOf: () => "/Volumes/Time Machine" })).unsafe).toBeString();
    expect(filesystemKind("/Users/me/OrbStack/p/w.duckdb", mac({ mountPointOf: () => "/Users/me/OrbStack" }))).toMatchObject({ type: "nfs" });
  });

  test("the home folder reached through a firmlink is the Data volume (apfs)", () => {
    const k = filesystemKind("/Users/me/p/warehouse.duckdb", mac({ mountPointOf: () => "/System/Volumes/Data" }));
    expect(k).toMatchObject({ type: "apfs", mountPoint: "/System/Volumes/Data", unsafe: null });
  });

  test("without df, the longest mount point that holds the path decides", () => {
    expect(filesystemKind("/Users/me/nfs/p/warehouse.duckdb", mac())).toMatchObject({ type: "nfs", mountPoint: "/Users/me/nfs" });
    expect(filesystemKind("/Users/me/p/warehouse.duckdb", mac())).toMatchObject({ type: "apfs", mountPoint: "/", unsafe: null });
  });

  test("sshfs through macFUSE is recognized by its user@host: source", () => {
    const k = filesystemKind("/Users/me/ssh/warehouse.duckdb", mac({ mountPointOf: () => "/Users/me/ssh" }));
    expect(k).toMatchObject({ type: "macfuse" });
    expect(k.unsafe).toContain("sshfs");
  });

  test("no mount table: unknown, not refused", () => {
    expect(filesystemKind("/x/warehouse.duckdb", mac({ mountTable: () => null }))).toMatchObject({ type: null, source: "none", unsafe: null });
  });
});

describe("unsafeLabel", () => {
  test("names every filesystem whose lock cannot be trusted", () => {
    for (const t of ["virtiofs", "grpcfuse", "fuse.grpcfuse", "fakeowner", "9p", "nfs", "nfs4", "smbfs", "cifs", "smb3", "afpfs", "fuse.sshfs", "sshfs", "webdav"]) {
      expect(unsafeLabel(t, "")).toBeString();
    }
    for (const t of ["apfs", "hfs", "ext4", "xfs", "btrfs", "zfs", "overlay", "tmpfs", "fuse", "fuseblk", "macfuse"]) {
      expect(unsafeLabel(t, "")).toBeNull();
    }
  });

  // One row per filesystem: VM shares, cluster and network filesystems, FUSE cloud and network mounts.
  test.each([
    ["vboxsf", "VirtualBox"], ["vmhgfs", "VMware"], ["fuse.vmhgfs-fuse", "VMware"], ["prl_fs", "Parallels"],
    ["osxfs", "Docker"], ["fuse.osxfs", "Docker"],
    ["ceph", "CephFS"], ["fuse.ceph", "CephFS"], ["fuse.ceph-fuse", "CephFS"], ["glusterfs", "GlusterFS"], ["fuse.glusterfs", "GlusterFS"],
    ["lustre", "Lustre"], ["gpfs", "GPFS"], ["beegfs", "BeeGFS"], ["ocfs2", "OCFS2"], ["gfs2", "GFS2"], ["afs", "AFS"],
    ["fuse.juicefs", "JuiceFS"],
    ["davfs", "WebDAV"], ["fuse.davfs", "WebDAV"], ["fuse.davfs2", "WebDAV"],
    ["fuse.rclone", "rclone"], ["fuse.s3fs", "s3fs"], ["fuse.gcsfuse", "gcsfuse"], ["fuse.goofys", "goofys"],
    ["fuse.mountpoint-s3", "Mountpoint for Amazon S3"], ["fuse.blobfuse", "blobfuse"], ["fuse.blobfuse2", "blobfuse"],
    ["fuse.curlftpfs", "FTP"], ["fuse.gvfsd-fuse", "GVfs"],
  ])("%s is unsafe (%s)", (type, name) => {
    expect(unsafeLabel(type, "")).toContain(name);
    expect(unsafeLabel(type.toUpperCase(), "")).toContain(name);
  });

  test("a FUSE mount of a remote source is unsafe whatever its type: host:path, remote:, or a URL", () => {
    for (const type of ["fuse", "macfuse", "osxfuse", "fuse.anything"]) {
      expect(unsafeLabel(type, "https://dav.example.com/remote.php/webdav")).toContain("network");
      expect(unsafeLabel(type, "ftp://files.example.com/")).toContain("network");
      expect(unsafeLabel(type, "gdrive:")).toContain("network");
      expect(unsafeLabel(type, "s3remote:bucket/path")).toContain("network");
      expect(unsafeLabel(type, "files.example.com:/srv")).toContain("network");
    }
    expect(unsafeLabel("fuse", "ada@host:/srv")).toContain("sshfs");
    // Local FUSE mounts: a folder or a device as the source, or just the program's name.
    for (const source of ["/home/ada/.cipher", "/dev/sdb1", "encfs", "portal", "bindfs", ""]) {
      expect(unsafeLabel("fuse", source), source).toBeNull();
      expect(unsafeLabel("fuse.gocryptfs", source), source).toBeNull();
    }
    // A remote-looking source on a kernel filesystem proves nothing (NFS names are already in the table).
    expect(unsafeLabel("ext4", "host:/x")).toBeNull();
  });

  test("the review's /proc/mounts lines are all refused", () => {
    const lines = [
      "data /work vboxsf rw,nodev,relatime 0 0",
      "vmhgfs-fuse /work fuse.vmhgfs-fuse rw,nosuid,nodev 0 0",
      "prl_fs /work prl_fs rw,nosuid,nodev 0 0",
      "osxfs /work fuse.osxfs rw,nosuid,nodev 0 0",
      "10.0.0.1:6789:/ /work ceph rw,relatime,name=admin 0 0",
      "gl1:/vol /work fuse.glusterfs rw,relatime 0 0",
      "10.0.0.2@tcp:/lfs /work lustre rw 0 0",
      "remote: /work fuse.rclone rw,nosuid,nodev 0 0",
      "s3fs /work fuse.s3fs rw,nosuid,nodev 0 0",
      "https://dav.example.com /work fuse rw,nosuid,nodev 0 0",
    ];
    for (const line of lines) {
      const k = folderKind("/work/project", linux({ procMounts: () => `/dev/sda1 / ext4 rw 0 0\n${line}\n` }));
      expect(k.unsafe, line).toBeString();
      expect(k.mountPoint).toBe("/work");
    }
  });
});

describe("assertSafeFilesystem", () => {
  test("SERVE_UNSAFE_FILESYSTEM names the file system, with a hint and a manual fix", () => {
    let caught: unknown;
    try {
      assertSafeFilesystem({ root: "/data/proj", database: "/data/proj/warehouse.duckdb", stateDir: "/data/proj/.croft" }, linux());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CroftError);
    const p = (caught as CroftError).problem;
    expect(p.code).toBe("SERVE_UNSAFE_FILESYSTEM");
    expect(p.message).toContain("grpcfuse");
    expect(p.message).toContain("/data/proj/warehouse.duckdb");
    expect(p.hint.length).toBeGreaterThan(20);
    expect(p.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(p.details).toMatchObject({ path: "/data/proj/warehouse.duckdb", filesystem: "fuse.grpcfuse", mountPoint: "/data/proj" });
  });

  test("a state folder on an unsafe mount is refused too", () => {
    expect(() => assertSafeFilesystem({ root: "/data/other", database: "/data/other/warehouse.duckdb", stateDir: "/mnt/nfs/state" }, linux()))
      .toThrow(/state folder/);
  });

  test("local disks pass", () => {
    expect(() => assertSafeFilesystem({ root: "/data/other", database: "/data/other/warehouse.duckdb", stateDir: "/data/other/.croft" }, linux())).not.toThrow();
  });

  test("the real probe on this machine's temp folder: a known, safe file system", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-fskind-")));
    const k = filesystemKind(join(dir, "warehouse.duckdb"), realProbe);
    expect(k.unsafe).toBeNull();
    if (process.platform === "darwin" || process.platform === "linux") expect(k.type).toBeString();
  });
});
