// croft.schema.json, the JSON Schema that croft init points croft.json's "$schema" at (DESIGN.md §2), must
// agree with the hand-written validator in root.ts. Editors use the schema for completion and red
// squiggles; croft itself only ever uses the validator.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { croftJson } from "../agent/templates.ts";
import { CONFIG_KEYS, DEFAULTS, validateConfig } from "./root.ts";

type Schema = {
  type?: string | string[]; properties?: Record<string, Schema>; additionalProperties?: boolean | Schema; required?: string[];
  propertyNames?: Schema; minProperties?: number;
  minimum?: number; maximum?: number; minLength?: number; minItems?: number; pattern?: string; items?: Schema; default?: unknown;
  description?: string; $schema?: string; $id?: string; title?: string; enum?: unknown[];
};

const SCHEMA_PATH = fileURLToPath(new URL("../../croft.schema.json", import.meta.url));
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Schema;

const SUPPORTED = new Set(["type", "properties", "additionalProperties", "required", "minimum", "maximum", "minLength", "minItems", "pattern",
  "items", "default", "description", "$schema", "$id", "title", "markdownDescription", "propertyNames", "minProperties", "enum"]);

function typeOf(v: unknown): string[] {
  if (v === null) return ["null"];
  if (Array.isArray(v)) return ["array"];
  if (typeof v === "number") return Number.isInteger(v) ? ["integer", "number"] : ["number"];
  return [typeof v];
}

/** Just enough JSON Schema (draft-07) for this schema; an unknown keyword fails the test instead of being ignored. */
function valid(s: Schema, v: unknown): boolean {
  for (const k of Object.keys(s)) if (!SUPPORTED.has(k)) throw new Error(`the test validator does not know "${k}"`);
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!typeOf(v).some((t) => types.includes(t))) return false;
  }
  if (s.enum !== undefined && !s.enum.includes(v)) return false;
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) return false;
    if (s.maximum !== undefined && v > s.maximum) return false;
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && [...v].length < s.minLength) return false;
    if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(v)) return false;
  }
  if (Array.isArray(v) && s.minItems !== undefined && v.length < s.minItems) return false;
  if (Array.isArray(v) && s.items) return v.every((x) => valid(s.items!, x));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) return false;
    for (const [k, x] of Object.entries(o)) {
      const sub = s.properties?.[k];
      if (sub) { if (!valid(sub, x)) return false; } else if (s.additionalProperties === false) return false;
      else if (typeof s.additionalProperties === "object" && !valid(s.additionalProperties, x)) return false;
      if (s.propertyNames && !valid(s.propertyNames, k)) return false;
    }
    if (s.minProperties !== undefined && Object.keys(o).length < s.minProperties) return false;
  }
  return true;
}

const tz = { timezone: "UTC" };
/** A shared lake, whole: a Postgres catalog with two logins, a bucket folder with two keys. */
const sharedLake = (over: Record<string, unknown> = {}) => ({
  catalog: { kind: "postgres", host: "db.example.com", port: 5432, database: "croft_lake",
    writer: { user: "croft_writer", passwordSecret: "LAKE_WRITER_PASSWORD" }, reader: { user: "croft_reader", passwordSecret: "LAKE_READER_PASSWORD" } },
  bucket: { name: "my-bucket", folder: "croft/orders/", endpoint: "abc123.r2.cloudflarestorage.com", region: "auto", urlStyle: "path", useSsl: true,
    writer: { keyIdSecret: "LAKE_WRITER_KEY_ID", secretKeySecret: "LAKE_WRITER_KEY" }, reader: { keyIdSecret: "LAKE_READER_KEY_ID", secretKeySecret: "LAKE_READER_KEY", sessionTokenSecret: "LAKE_READER_TOKEN" } },
  ...over,
});
const localLake = (over: Record<string, unknown> = {}) => ({ catalog: { kind: "sqlite", path: "lake/catalog.sqlite" }, dataPath: "lake/data", ...over });
const VALID: unknown[] = [
  { ...tz, lake: sharedLake() }, { ...tz, lake: localLake() }, { ...tz, lake: localLake({ catalog: { kind: "sqlite", path: "/var/croft/catalog.sqlite" }, dataPath: "~/croft/data/" }) },
  { ...tz, lake: sharedLake({ catalog: { ...sharedLake().catalog, sslMode: "verify-full", sslRootCert: "certs/neon-root.pem" } }) },
  { ...tz, lake: sharedLake({ catalog: { ...sharedLake().catalog, sslMode: "disable" } }) },
  { ...tz, lake: sharedLake({ bucket: { name: "b-1", folder: "a", writer: { keyIdSecret: "A1", secretKeySecret: "B1" }, reader: { keyIdSecret: "A2", secretKeySecret: "B2" } } }) },
  { database: "warehouse.duckdb", timezone: "UTC" },
  { $schema: "./node_modules/@zabaca/croft/croft.schema.json", database: "warehouse.duckdb", timezone: "America/Los_Angeles" },
  { timezone: "Asia/Tokyo" },
  { ...tz, database: "/Users/ada/.local/share/croft/sales-1a2b3c4d/warehouse.duckdb", stateDir: "~/.local/share/croft/sales-1a2b3c4d/.croft" },
  { ...tz, database: "~/.local/share/croft/sales-1a2b3c4d/warehouse.duckdb" },
  { ...tz, readCopy: true, concurrency: 1, notify: { desktop: false, webhook: null } },
  { ...tz, concurrency: 64, notify: { webhook: "https://hooks.slack.com/services/T0/B0/x" } },
  { ...tz, serve: { port: 7447, host: "127.0.0.1", queryTimeoutMs: 100, maxConcurrent: 64, maxBytes: 1024, maxRows: 1, allowOrigins: ["http://localhost:3000", "https://app.example.com"], sharedTables: ["orders", "customers_2"] } },
  { ...tz, serve: { port: 1, host: "0.0.0.0", queryTimeoutMs: 3_600_000, maxConcurrent: 1, maxBytes: Number.MAX_SAFE_INTEGER, maxRows: 10_000_000, allowOrigins: [] } },
  { ...tz, serve: { port: 65535 }, notify: {}, stateDir: null },
  { ...tz, secretsFrom: { command: ["sops", "-d", "--output-type", "dotenv", "secrets.enc.yaml"] } },
  { ...tz, secretsFrom: { command: ["/opt/homebrew/bin/sops"] } }, { ...tz, secretsFrom: null },
  { ...tz, http: {} }, { ...tz, http: { budgets: {} } },
  { ...tz, serverMode: {} }, { ...tz, serverMode: { enabled: true } }, { ...tz, serverMode: { enabled: true, acceptFullCopyCost: true }, readCopy: false },
  { ...tz, serverMode: { quackHost: "0.0.0.0", quackPort: 0 } }, { ...tz, serverMode: { quackHost: "::1", quackPort: 65535 } },
  { ...tz, serverMode: { quackPlaintextOnNetwork: true, quackMaxConcurrent: 64 } },
  { ...tz, http: { budgets: { "api.example.com": { perHour: 50, perDay: 125 }, "127.0.0.1:8080": { perMinute: 1 }, "[::1]:9000": { perDay: 1_000_000_000 } } } },
];
const sharedCatalog = sharedLake().catalog;
const sharedBucket = sharedLake().bucket;
const INVALID: unknown[] = [
  { ...tz, lake: true }, { ...tz, lake: [] }, { ...tz, lake: {} }, { ...tz, lake: { dataPath: "lake/data" } }, { ...tz, lake: { catalog: {} } },
  { ...tz, lake: { catalog: { kind: "mysql" } } }, { ...tz, lake: { catalog: { kind: "postgres", host: "x y" } } },
  { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, host: "https://db.example.com" } }) }, { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, port: 0 } }) },
  { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, port: "5432" } }) }, { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, database: "a b" } }) },
  { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, writer: { user: "w" } } }) }, { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, reader: { passwordSecret: "A" } } }) },
  { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, writer: { user: "w", passwordSecret: "has space" } } }) },
  { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, writer: { user: "w", passwordSecret: "A", password: "hunter2" } } }) },
  { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, password: "hunter2" } }) },
  { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, name: "A" } }) }, { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, name: "s3://my-bucket" } }) },
  { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, folder: "/abs" } }) }, { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, folder: "a//b" } }) },
  { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, folder: "" } }) },
  { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, endpoint: "https://x.example.com" } }) }, { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, urlStyle: "domain" } }) },
  { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, useSsl: "yes" } }) }, { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, writer: { keyIdSecret: "A" } } }) },
  { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, writer: { keyIdSecret: "A", secretKeySecret: "B", secret: "sk" } } }) },
  { ...tz, lake: localLake({ dataPath: "" }) }, { ...tz, lake: localLake({ catalog: { kind: "sqlite", path: "" } }) },
  { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, sslMode: "verify" } }) }, { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, sslMode: true } }) },
  { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, sslRootCert: "" } }) }, { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, sslRootCert: 7 } }) },
  { ...tz, lake: { ...sharedLake(), extra: 1 } },
  [], "croft", null, 42,
  {},
  { database: "warehouse.duckdb" },
  { timezone: 5 },
  { ...tz, database: "warehouse.db" },
  { ...tz, database: "" },
  { ...tz, database: 5 },
  { ...tz, database: ":memory:" },
  { ...tz, databse: "x.duckdb" },
  { ...tz, schedule: "daily" },
  { ...tz, readCopy: "true" },
  { ...tz, serverMode: true }, { ...tz, serverMode: [] }, { ...tz, serverMode: { enabled: "true" } }, { ...tz, serverMode: { acceptFullCopyCost: 1 } },
  { ...tz, serverMode: { enable: true } }, { ...tz, serverMode: { tables: ["orders"] } },
  { ...tz, serverMode: { quackPort: 65536 } }, { ...tz, serverMode: { quackPort: -1 } }, { ...tz, serverMode: { quackPort: "9494" } }, { ...tz, serverMode: { quackHost: 5 } },
  { ...tz, serverMode: { quackHost: "http://host" } }, { ...tz, serverMode: { quackHost: "a b" } },
  { ...tz, serverMode: { quackMaxConcurrent: 0 } }, { ...tz, serverMode: { quackMaxConcurrent: 65 } }, { ...tz, serverMode: { quackPlaintextOnNetwork: "true" } },
  { ...tz, concurrency: 0 }, { ...tz, concurrency: 65 }, { ...tz, concurrency: 1.5 }, { ...tz, concurrency: "4" },
  { ...tz, notify: [] }, { ...tz, notify: true },
  { ...tz, notify: { desktop: "yes" } },
  { ...tz, notify: { webhook: "ftp://example.com/x" } },
  { ...tz, notify: { webhook: 5 } },
  { ...tz, notify: { sms: true } },
  { ...tz, serve: 7447 },
  { ...tz, serve: { port: 0 } }, { ...tz, serve: { port: 65536 } }, { ...tz, serve: { port: "7447" } },
  { ...tz, serve: { host: "" } }, { ...tz, serve: { host: 127 } },
  { ...tz, serve: { queryTimeoutMs: 99 } }, { ...tz, serve: { queryTimeoutMs: 3_600_001 } },
  { ...tz, serve: { maxConcurrent: 0 } }, { ...tz, serve: { maxBytes: 1023 } },
  { ...tz, serve: { allowOrigins: "*" } }, { ...tz, serve: { allowOrigins: ["*"] } },
  { ...tz, serve: { allowOrigins: ["http://localhost:3000/app"] } }, { ...tz, serve: { allowOrigins: [3000] } },
  { ...tz, serve: { allowOrigins: ["localhost:3000"] } },
  { ...tz, serve: { sharedTables: "orders" } }, { ...tz, serve: { sharedTables: [3] } }, { ...tz, serve: { sharedTables: ["Orders"] } },
  { ...tz, serve: { sharedTables: ["_croft"] } }, { ...tz, serve: { sharedTables: ["main.orders"] } }, { ...tz, serve: { sharedTables: [""] } },
  { ...tz, serve: { tls: true } },
  { ...tz, stateDir: "" }, { ...tz, stateDir: 5 },
  { ...tz, secretsFrom: "sops -d secrets.yaml" }, { ...tz, secretsFrom: {} }, { ...tz, secretsFrom: { command: [] } },
  { ...tz, secretsFrom: { command: "sops" } }, { ...tz, secretsFrom: { command: ["sops", ""] } }, { ...tz, secretsFrom: { command: ["sops", 1] } },
  { ...tz, secretsFrom: { command: ["sops"], format: "json" } },
  { ...tz, http: [] }, { ...tz, http: { budget: {} } }, { ...tz, http: { budgets: [] } }, { ...tz, http: { budgets: 50 } },
  { ...tz, http: { budgets: { "https://api.example.com": { perHour: 5 } } } },
  { ...tz, http: { budgets: { "api.example.com/v1": { perHour: 5 } } } },
  { ...tz, http: { budgets: { "API.example.com": { perHour: 5 } } } },
  { ...tz, http: { budgets: { "api.example.com": 50 } } }, { ...tz, http: { budgets: { "api.example.com": {} } } },
  { ...tz, http: { budgets: { "api.example.com": { perHour: 0 } } } }, { ...tz, http: { budgets: { "api.example.com": { perHour: 1.5 } } } },
  { ...tz, http: { budgets: { "api.example.com": { perHour: "50" } } } }, { ...tz, http: { budgets: { "api.example.com": { perWeek: 5 } } } },
];

/** Meaning the schema cannot express; croft reports these (croft validate, doctor) and editors do not. */
const SCHEMA_ACCEPTS_VALIDATOR_REJECTS: unknown[] = [
  { timezone: "Pacific" },                                            // not an IANA zone
  { timezone: "+07:00" },                                             // an offset, not a zone
  { timezone: "america/los_angeles" },                                // not the canonical spelling
  { ...tz, serve: { allowOrigins: ["http://LOCALHOST:3000"] } },      // origins must be written normalized
  { ...tz, serve: { allowOrigins: ["http://localhost:80"] } },
  { ...tz, serve: { sharedTables: ["orders", "orders"] } },            // a table listed twice
  { ...tz, secretsFrom: { command: ["sops -d secrets.yaml"] } },        // a command line in one string: no shell splits it
  // What lake mode needs of the combination of keys, which a draft-07 schema without conditionals cannot say:
  { ...tz, lake: { catalog: sharedCatalog } },                                                  // a Postgres catalog needs its bucket
  { ...tz, lake: { catalog: sharedCatalog, dataPath: "lake/data", bucket: sharedBucket } },     // not a bucket and a local folder both
  { ...tz, lake: { ...localLake(), bucket: sharedBucket } }, { ...tz, lake: { catalog: { kind: "sqlite" }, dataPath: "d" } }, // a SQLite catalog is a path and a folder
  { ...tz, lake: localLake({ catalog: { kind: "sqlite", path: "c.sqlite", host: "x" } }) },     // a SQLite catalog has no host
  { ...tz, lake: { catalog: { kind: "postgres", host: "h" }, bucket: sharedBucket } },          // a Postgres catalog needs its database and logins
  { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, reader: sharedCatalog.writer } }) }, // the read-only login is not the writer's
  { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, reader: sharedBucket.writer } }) },    // nor is the read-only bucket key
  { ...tz, lake: sharedLake({ catalog: { ...sharedCatalog, sslMode: "require", sslRootCert: "ca.pem" } }) },  // a root certificate is for verify-full
  { ...tz, lake: localLake({ catalog: { kind: "sqlite", path: "c.sqlite", sslMode: "disable" } }) },          // a SQLite catalog has no TLS
  { ...tz, lake: sharedLake({ bucket: { ...sharedBucket, folder: "../other/" } }) },            // the folder stays inside the bucket
  { ...tz, lake: sharedLake(), serverMode: { enabled: true } }, { ...tz, lake: sharedLake(), readCopy: true }, // server mode over a lake is a later slice; no read copy of a lake
];

describe("croft.schema.json", () => {
  test("is a draft-07 schema (what editors support best) for an object that needs a timezone", () => {
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["timezone"] });
  });

  test("describes exactly the keys croft docs config lists, with the same defaults", () => {
    const leaves: string[] = [];
    const walk = (s: Schema, prefix: string) => {
      for (const [k, sub] of Object.entries(s.properties ?? {})) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (sub.properties) walk(sub, path);
        else leaves.push(path);
        expect(sub.description, `${path} has a description`).toBeString();
      }
    };
    walk(schema, "");
    expect(leaves.filter((k) => k !== "$schema").sort()).toEqual(CONFIG_KEYS.map((k) => k.key).sort());
    const p = schema.properties!;
    expect(p.database!.default).toBe(DEFAULTS.database);
    expect(p.readCopy!.default).toBe(DEFAULTS.readCopy);
    expect(p.concurrency!.default).toBe(DEFAULTS.concurrency);
    expect(p.notify!.properties!.desktop!.default).toBe(DEFAULTS.notify.desktop);
    for (const [k, v] of Object.entries(DEFAULTS.serve)) expect(p.serve!.properties![k]!.default).toEqual(v);
  });

  test("accepts what the validator accepts", () => {
    for (const c of VALID) {
      expect(validateConfig(c).ok, JSON.stringify(c)).toBe(true);
      expect(valid(schema, c), JSON.stringify(c)).toBe(true);
    }
  });

  test("rejects what the validator rejects", () => {
    for (const c of INVALID) {
      expect(validateConfig(c).ok, JSON.stringify(c)).toBe(false);
      expect(valid(schema, c), JSON.stringify(c)).toBe(false);
    }
  });

  test("known gaps: zone names and origin spelling are checked by croft, not by the schema", () => {
    for (const c of SCHEMA_ACCEPTS_VALIDATOR_REJECTS) {
      expect(validateConfig(c).ok, JSON.stringify(c)).toBe(false);
      expect(valid(schema, c), JSON.stringify(c)).toBe(true);
    }
  });

  test("the croft.json croft init writes points at this file and passes it, relocated or not", () => {
    for (const relocated of [null, { reason: "iCloud Drive", dir: "/x", database: "~/.local/share/croft/p-1/warehouse.duckdb", stateDir: "~/.local/share/croft/p-1/.croft" }]) {
      const config = JSON.parse(croftJson({ timezone: "America/Los_Angeles", relocated }));
      expect(config.$schema).toBe("./node_modules/@zabaca/croft/croft.schema.json");
      expect(valid(schema, config)).toBe(true);
      expect(validateConfig(config).ok).toBe(true);
    }
    // ./node_modules/@zabaca/croft/ is the package root, where this file ships (package.json "files").
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
    expect(pkg.files).toContain("croft.schema.json");
  });
});
