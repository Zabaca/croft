// croft.schema.json, the JSON Schema that croft init points croft.json's "$schema" at (DESIGN.md §2), must
// agree with the hand-written validator in root.ts. Editors use the schema for completion and red
// squiggles; croft itself only ever uses the validator.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { croftJson } from "../agent/templates.ts";
import { CONFIG_KEYS, DEFAULTS, validateConfig } from "./root.ts";

type Schema = {
  type?: string | string[]; properties?: Record<string, Schema>; additionalProperties?: boolean; required?: string[];
  minimum?: number; maximum?: number; minLength?: number; pattern?: string; items?: Schema; default?: unknown;
  description?: string; $schema?: string; $id?: string; title?: string;
};

const SCHEMA_PATH = fileURLToPath(new URL("../../croft.schema.json", import.meta.url));
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Schema;

const SUPPORTED = new Set(["type", "properties", "additionalProperties", "required", "minimum", "maximum", "minLength", "pattern",
  "items", "default", "description", "$schema", "$id", "title", "markdownDescription"]);

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
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) return false;
    if (s.maximum !== undefined && v > s.maximum) return false;
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && [...v].length < s.minLength) return false;
    if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(v)) return false;
  }
  if (Array.isArray(v) && s.items) return v.every((x) => valid(s.items!, x));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) return false;
    for (const [k, x] of Object.entries(o)) {
      const sub = s.properties?.[k];
      if (sub) { if (!valid(sub, x)) return false; } else if (s.additionalProperties === false) return false;
    }
  }
  return true;
}

const tz = { timezone: "UTC" };
const VALID: unknown[] = [
  { database: "warehouse.duckdb", timezone: "UTC" },
  { $schema: "./node_modules/@zabaca/croft/croft.schema.json", database: "warehouse.duckdb", timezone: "America/Los_Angeles" },
  { timezone: "Asia/Tokyo" },
  { ...tz, database: "/Users/ada/.local/share/croft/sales-1a2b3c4d/warehouse.duckdb", stateDir: "~/.local/share/croft/sales-1a2b3c4d/.croft" },
  { ...tz, database: "~/.local/share/croft/sales-1a2b3c4d/warehouse.duckdb" },
  { ...tz, readCopy: true, concurrency: 1, notify: { desktop: false, webhook: null } },
  { ...tz, concurrency: 64, notify: { webhook: "https://hooks.slack.com/services/T0/B0/x" } },
  { ...tz, serve: { port: 7447, host: "127.0.0.1", queryTimeoutMs: 100, maxConcurrent: 64, maxBytes: 1024, allowOrigins: ["http://localhost:3000", "https://app.example.com"] } },
  { ...tz, serve: { port: 1, host: "0.0.0.0", queryTimeoutMs: 3_600_000, maxConcurrent: 1, maxBytes: Number.MAX_SAFE_INTEGER, allowOrigins: [] } },
  { ...tz, serve: { port: 65535 }, notify: {}, stateDir: null },
];
const INVALID: unknown[] = [
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
  { ...tz, serve: { tls: true } },
  { ...tz, stateDir: "" }, { ...tz, stateDir: 5 },
];

/** Meaning the schema cannot express; croft reports these (croft validate, doctor) and editors do not. */
const SCHEMA_ACCEPTS_VALIDATOR_REJECTS: unknown[] = [
  { timezone: "Pacific" },                                            // not an IANA zone
  { timezone: "+07:00" },                                             // an offset, not a zone
  { timezone: "america/los_angeles" },                                // not the canonical spelling
  { ...tz, serve: { allowOrigins: ["http://LOCALHOST:3000"] } },      // origins must be written normalized
  { ...tz, serve: { allowOrigins: ["http://localhost:80"] } },
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
