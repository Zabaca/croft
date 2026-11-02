// croft.json's `lake` block (DESIGN.md D138; option 07, slice 2): validated like every setting, so each message names the key, what was
// expected and what was found, and a lake that is whole comes out as the config the rest of croft reads. The schema file's agreement with this
// validator is project/config-schema.test.ts; this file is the messages and the rules a schema cannot say.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bucketPath, lakeLabel, lakeSecretNames, localLakePaths } from "./lake-config.ts";
import { parseConfig, validateConfig, type ConfigIssue } from "./root.ts";

const tz = { timezone: "UTC" };
const shared = (over: { catalog?: Record<string, unknown>; bucket?: Record<string, unknown> } = {}) => ({
  catalog: { kind: "postgres", host: "db.example.com", database: "croft_lake",
    writer: { user: "croft_writer", passwordSecret: "LAKE_WRITER_PASSWORD" }, reader: { user: "croft_reader", passwordSecret: "LAKE_READER_PASSWORD" }, ...over.catalog },
  bucket: { name: "my-bucket", folder: "croft/orders",
    writer: { keyIdSecret: "LAKE_WRITER_KEY_ID", secretKeySecret: "LAKE_WRITER_KEY" }, reader: { keyIdSecret: "LAKE_READER_KEY_ID", secretKeySecret: "LAKE_READER_KEY" }, ...over.bucket },
});
const local = { catalog: { kind: "sqlite", path: "lake/catalog.sqlite" }, dataPath: "lake/data" };

const issues = (config: Record<string, unknown>, place?: { root: string }): ConfigIssue[] => {
  const r = validateConfig({ ...tz, ...config }, () => undefined, place);
  return r.ok ? [] : r.issues;
};
const messages = (config: Record<string, unknown>): string[] => issues(config).map((i) => i.message);

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const folder = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "croft-lakecfg-")));
  made.push(d);
  mkdirSync(join(d, "files"), { recursive: true });
  return d;
};

describe("a shared lake", () => {
  test("is read into the config the rest of croft uses, with the defaults and the folder written the one way", () => {
    const r = validateConfig({ ...tz, lake: shared() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.lake).toEqual({
      kind: "postgres",
      catalog: { host: "db.example.com", port: 5432, database: "croft_lake",
        writer: { user: "croft_writer", passwordSecret: "LAKE_WRITER_PASSWORD" }, reader: { user: "croft_reader", passwordSecret: "LAKE_READER_PASSWORD" } },
      bucket: { name: "my-bucket", folder: "croft/orders/", urlStyle: "path", useSsl: true,
        writer: { keyIdSecret: "LAKE_WRITER_KEY_ID", secretKeySecret: "LAKE_WRITER_KEY" }, reader: { keyIdSecret: "LAKE_READER_KEY_ID", secretKeySecret: "LAKE_READER_KEY" } },
    });
    const lake = r.config.lake!;
    expect(bucketPath((lake as unknown as { bucket: never }).bucket)).toBe("s3://my-bucket/croft/orders/");
    expect(lakeSecretNames(lake).sort()).toEqual(["LAKE_READER_KEY", "LAKE_READER_KEY_ID", "LAKE_READER_PASSWORD", "LAKE_WRITER_KEY", "LAKE_WRITER_KEY_ID", "LAKE_WRITER_PASSWORD"]);
    expect(lakeLabel(lake, "/p")).toBe("lake s3://my-bucket/croft/orders/ (catalog db.example.com:5432/croft_lake)");
    // A trailing slash is the same folder; a session token, a region and an endpoint are kept.
    const full = validateConfig({ ...tz, lake: shared({ bucket: { folder: "croft/orders/", endpoint: "abc.r2.cloudflarestorage.com", region: "auto", urlStyle: "vhost", useSsl: false,
      reader: { keyIdSecret: "A", secretKeySecret: "B", sessionTokenSecret: "C" } } }) });
    expect(full.ok && full.config.lake?.kind === "postgres" ? full.config.lake.bucket : null).toMatchObject({
      folder: "croft/orders/", endpoint: "abc.r2.cloudflarestorage.com", region: "auto", urlStyle: "vhost", useSsl: false, reader: { sessionTokenSecret: "C" },
    });
  });

  test("a project with no lake has none, and everything else about croft.json is as it was", () => {
    const r = validateConfig(tz);
    expect(r.ok && r.config.lake).toBeNull();
  });

  test("each missing or wrong key is named, with what was expected and what to do", () => {
    const m = (c: Record<string, unknown>) => messages({ lake: c });
    expect(m({})).toEqual([expect.stringContaining('"lake" needs "catalog"')]);
    expect(m({ catalog: { kind: "mysql" } })).toEqual([expect.stringContaining('"lake.catalog.kind" must be "postgres"')]);
    expect(m(shared({ catalog: { host: undefined } }))).toEqual([expect.stringContaining('"lake.catalog.host" is required')]);
    expect(m(shared({ catalog: { host: "https://db.example.com" } }))).toEqual([expect.stringContaining("no scheme, no port")]);
    expect(m(shared({ catalog: { port: 0 } }))).toEqual([expect.stringContaining('"lake.catalog.port" must be a whole number from 1 to 65535')]);
    expect(m(shared({ catalog: { database: "a b" } }))).toEqual([expect.stringContaining("Postgres database name")]);
    expect(m(shared({ catalog: { writer: undefined } }))).toEqual([expect.stringContaining('"lake.catalog.writer" is required')]);
    expect(m(shared({ catalog: { reader: { user: "r" } } }))).toEqual([expect.stringContaining('"lake.catalog.reader.passwordSecret" is required')]);
    expect(m(shared({ bucket: { name: "My_Bucket" } }))).toEqual([expect.stringContaining('"lake.bucket.name" must be a bucket name')]);
    expect(m(shared({ bucket: { folder: undefined } }))).toEqual([expect.stringContaining("holds nothing but this lake")]);
    expect(m(shared({ bucket: { endpoint: "https://x.example.com/" } }))).toEqual([expect.stringContaining("host[:port]")]);
    expect(m(shared({ bucket: { urlStyle: "domain" } }))).toEqual([expect.stringContaining('"path" or "vhost"')]);
    expect(m(shared({ bucket: { useSsl: "no" } }))).toEqual([expect.stringContaining("must be true or false")]);
    expect(m({ ...shared(), bucket: undefined })).toEqual([expect.stringContaining('needs "bucket"')]);
  });

  test("the folder must be a folder inside the bucket: not its top, not an absolute path, no '..', no empty part", () => {
    for (const bad of ["", "/abs", "a//b", "../x", "a/../b", "a/./b", "a b", "/"]) {
      expect(messages({ lake: shared({ bucket: { folder: bad } }) }), JSON.stringify(bad)).toEqual([expect.stringContaining('"lake.bucket.folder"')]);
    }
  });

  test("a secret is named, never given: a value that is not a name is refused without being printed back as one", () => {
    const m = messages({ lake: shared({ catalog: { writer: { user: "w", passwordSecret: "hunter2 and more" } } }) });
    expect(m).toEqual([expect.stringContaining("must be the NAME of a secret")]);
    // The reader cannot be the writer: not the same login, not the same secret.
    expect(messages({ lake: shared({ catalog: { reader: { user: "croft_writer", passwordSecret: "OTHER" } } }) })).toEqual([expect.stringContaining("reader with the writer's login could write")]);
    expect(messages({ lake: shared({ catalog: { reader: { user: "r", passwordSecret: "LAKE_WRITER_PASSWORD" } } }) })).toEqual([expect.stringContaining("names the same secret as the writer's")]);
    expect(messages({ lake: shared({ bucket: { reader: { keyIdSecret: "LAKE_WRITER_KEY_ID", secretKeySecret: "X" } } }) })).toEqual([expect.stringContaining("names a secret the writer's key uses")]);
  });

  test("a key that is not one of its kind is a typo with a suggestion", () => {
    const m = messages({ lake: shared({ catalog: { hots: "x", host: undefined } }) });
    expect(m.join("\n")).toContain('did you mean "lake.catalog.host"?');
  });

  test("does not work with server mode or a read copy yet", () => {
    expect(messages({ lake: shared(), serverMode: { enabled: true } })).toEqual([expect.stringContaining("server mode over a lake")]);
    expect(messages({ lake: shared(), readCopy: true })).toEqual([expect.stringContaining('"readCopy" does not apply to a lake')]);
    expect(messages({ lake: local, serverMode: { enabled: false } })).toEqual([]);
  });
});

describe("a local lake", () => {
  test("is croft's own tests' alone: croft.json refuses it without the harness mark, as the log switch needs one (D137)", () => {
    const mark = process.env.CROFT_TEST_HARNESS;
    delete process.env.CROFT_TEST_HARNESS;
    try {
      const found = issues({ lake: local });
      expect(found.map((i) => i.path)).toEqual(["lake.catalog.kind"]);
      expect(found[0]!.message).toContain("for croft's own tests");
      expect(found[0]!.hint).toContain("Postgres");
    } finally {
      if (mark !== undefined) process.env.CROFT_TEST_HARNESS = mark;
    }
    expect(issues({ lake: local })).toEqual([]);
  });

  test("is a SQLite catalog and a folder, both as written", () => {
    const r = validateConfig({ ...tz, lake: local });
    expect(r.ok && r.config.lake).toEqual({ kind: "local", catalog: { path: "lake/catalog.sqlite" }, dataPath: "lake/data" });
    const root = "/p/proj";
    expect(localLakePaths(r.ok && r.config.lake?.kind === "local" ? r.config.lake : (null as never), root)).toEqual({ catalog: "/p/proj/lake/catalog.sqlite", data: "/p/proj/lake/data" });
    expect(lakeLabel(r.ok ? r.config.lake! : (null as never), root)).toBe("lake lake/catalog.sqlite");
  });

  test("takes no host, no bucket and no logins, and needs its folder", () => {
    const m = (c: Record<string, unknown>) => messages({ lake: c });
    expect(m({ catalog: { kind: "sqlite", path: "c.sqlite" } })).toEqual([expect.stringContaining('needs "dataPath"')]);
    expect(m({ catalog: { kind: "sqlite" }, dataPath: "d" })).toEqual([expect.stringContaining('"lake.catalog.path" is required')]);
    expect(m({ ...local, bucket: shared().bucket })).toEqual([expect.stringContaining('"lake.bucket" is for a lake with a Postgres catalog')]);
    expect(m({ catalog: { ...local.catalog, host: "x" }, dataPath: "d" })).toEqual([expect.stringContaining('"lake.catalog.host" is for a Postgres catalog')]);
    expect(m({ catalog: shared().catalog, bucket: shared().bucket, dataPath: "d" })).toEqual([expect.stringContaining('"lake.dataPath" is for a local lake')]);
  });

  test("its files are not where SQL or croft's own files are: not the project, files/, assets/, the state folder, or each other", () => {
    const root = folder();
    const at = (c: Record<string, unknown>): string[] => {
      const r = parseConfig(JSON.stringify({ ...tz, lake: c }), { root });
      return r.ok ? [] : r.issues.map((i) => i.message);
    };
    expect(at(local)).toEqual([]);
    expect(at({ ...local, dataPath: "." })).toContainEqual(expect.stringContaining("is or holds the project folder"));
    expect(at({ ...local, dataPath: "files/lake" })).toEqual([expect.stringContaining("inside files/")]);
    expect(at({ catalog: { kind: "sqlite", path: "files/c.sqlite" }, dataPath: "lake/data" })).toEqual([expect.stringContaining("inside files/")]);
    expect(at({ ...local, dataPath: ".croft/lake" })).toEqual([expect.stringContaining("the state folder")]);
    expect(at({ ...local, dataPath: "assets/x" })).toEqual([expect.stringContaining("assets/")]);
    expect(at({ catalog: { kind: "sqlite", path: "lake/data/catalog.sqlite" }, dataPath: "lake/data" })).toEqual([expect.stringContaining("inside \"lake.dataPath\"")]);
    expect(at({ ...local, dataPath: "~" })).toContainEqual(expect.stringContaining("home folder"));
  });
});
