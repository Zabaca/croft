// The JSON Schemas of croft's --json output (DESIGN.md §4.3 "Data shapes are frozen by golden tests and published as
// JSON Schemas"): schemas/ holds exactly what scripts/build-schemas.ts writes from the TypeScript types, one per
// command the registry has, and schemaFor() serves them. How the generator maps a type is checked on small types
// here; tests/golden runs every command's --json and validates it against these files.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSchemas, type JsonSchema, SCHEMAS_OUT, staleSchemaFiles, typeSchema, writeSchemas } from "../../scripts/build-schemas.ts";
import { schemaKeywords, validate } from "../../tests/golden/validator.ts";
import { CroftError } from "../core/errors.ts";
import { COMMANDS } from "./commands/index.ts";
import { envelopeSchema, isSchemaCommand, SCHEMA_COMMANDS, schemaFile, schemaFor, SCHEMAS_DIR } from "./schemas.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "croft-schemas-"));
  made.push(d);
  return d;
}

const built = buildSchemas();
const SUPPORTED = new Set([
  "$schema", "title", "description", "$defs", "type", "const", "enum", "properties", "required", "additionalProperties",
  "items", "prefixItems", "minItems", "maxItems", "anyOf", "oneOf", "not", "$ref",
]);

describe("schemas/", () => {
  test("holds exactly what scripts/build-schemas.ts writes (run it after changing a data type)", () => {
    const stale = staleSchemaFiles(built);
    const message = `schemas/ is out of date: ${[...stale.changed, ...stale.extra.map((f) => `${f} (not generated)`)].join(", ")}. `
      + "A command's data type changed: from packages/croft, run bun scripts/build-schemas.ts and commit schemas/.";
    expect(stale, message).toEqual({ changed: [], extra: [] });
  });

  test("one schema per command the registry has (tick, internal, aside), plus the envelope", () => {
    const registered = COMMANDS.filter((c) => !c.hidden).map((c) => c.name).sort();
    expect(([...SCHEMA_COMMANDS] as string[]).sort()).toEqual(registered);
    expect([...built.keys()].sort()).toEqual([...SCHEMA_COMMANDS.map((c) => `${c}.schema.json`), "envelope.schema.json"].sort());
    expect(readdirSync(SCHEMAS_OUT).sort()).toEqual([...built.keys()].sort());
    expect(SCHEMAS_DIR.replace(/\/$/, "")).toBe(SCHEMAS_OUT);
  });

  test("every schema is draft 2020-12, uses only the keywords the golden validator knows, and every $ref resolves", () => {
    for (const [file, body] of built) {
      const schema = JSON.parse(body) as JsonSchema;
      expect(schema.$schema, file).toBe("https://json-schema.org/draft/2020-12/schema");
      expect([...schemaKeywords(schema)].filter((k) => !SUPPORTED.has(k)), file).toEqual([]);
      const defs = (schema.$defs ?? {}) as Record<string, unknown>;
      for (const m of body.matchAll(/"\$ref": "#\/\$defs\/([^"]+)"/g)) expect(Object.hasOwn(defs, m[1]!), `${file}: ${m[0]}`).toBe(true);
      // Every $def is used.
      for (const name of Object.keys(defs)) expect(body.includes(`"#/$defs/${name}"`), `${file}: $defs/${name}`).toBe(true);
    }
  });

  test("the envelope: §4.3's keys in order, schemaVersion 1, and data any value", () => {
    const s = envelopeSchema();
    expect(Object.keys(s.properties as object)).toEqual([
      "schemaVersion", "ok", "command", "croftVersion", "database", "timezone", "durationMs", "data", "problems", "next", "confirmation",
    ]);
    expect(s.required).toEqual(["schemaVersion", "ok", "command", "croftVersion", "database", "timezone", "durationMs", "data", "problems", "next"]);
    expect((s.properties as Record<string, JsonSchema>).schemaVersion).toEqual({ const: 1 });
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.$defs as object).sort()).toEqual(["Confirmation", "Fix", "Impact", "Problem"]);
  });

  test("a problem is §4.3's: severity, code, message, hint, docs, then the optional fields; fix is one of three kinds", () => {
    const defs = envelopeSchema().$defs as Record<string, JsonSchema>;
    expect(defs.Problem!.required).toEqual(["severity", "code", "message", "hint", "docs"]);
    expect(Object.keys(defs.Problem!.properties as object)).toEqual([
      "severity", "code", "message", "hint", "docs", "asset", "file", "line", "column", "runId", "fix", "effect", "retryable", "details",
    ]);
    expect((defs.Problem!.properties as Record<string, JsonSchema>).severity).toEqual({ enum: ["error", "info", "warning"] });
    const kinds = (defs.Fix!.anyOf as JsonSchema[]).map((f) => ((f.properties as Record<string, JsonSchema>).kind as JsonSchema).const);
    expect(kinds.sort()).toEqual(["command", "edit", "manual"]);
  });
});

describe("schemaFor", () => {
  test("each command's schema: its envelope, with command and data narrowed", () => {
    for (const command of SCHEMA_COMMANDS) {
      const s = schemaFor(command);
      expect(s).toEqual(JSON.parse(readFileSync(join(SCHEMAS_OUT, `${command}.schema.json`), "utf8")));
      expect(s.title).toBe(`croft ${command} --json`);
      const props = s.properties as Record<string, JsonSchema>;
      expect(props.command).toEqual({ const: command });
      expect(props.schemaVersion).toEqual({ const: 1 });
      expect((props.data!.anyOf as JsonSchema[]).at(-1)).toEqual({ type: "null" });
      expect(schemaFile(command)).toBe(`schemas/${command}.schema.json`);
      expect(isSchemaCommand(command)).toBe(true);
    }
  });

  test("a name that is not a command with --json output: USAGE_ERROR with a hint and a fix", () => {
    for (const [name, hint] of [["stauts", 'did you mean "status"?'], ["tick", "the commands with a schema: init, "], ["nope", "the commands with a schema: "]] as const) {
      let err: unknown;
      try {
        schemaFor(name);
      } catch (e) {
        err = e;
      }
      expect(err, name).toBeInstanceOf(CroftError);
      const p = (err as CroftError).problem;
      expect(p.code).toBe("USAGE_ERROR");
      expect(p.hint, name).toContain(hint);
      expect(p.fix?.kind).toBe("manual");
    }
  });
});

describe("the schemas catch a changed shape", () => {
  const envelope = <T>(command: string, data: T) => ({
    schemaVersion: 1, ok: true, command, croftVersion: "0.1.0", database: "warehouse.duckdb", timezone: "UTC", durationMs: 3,
    data, problems: [], next: [],
  });

  test("an extra or missing field, a wrong type, an unknown enum value, a missing schemaVersion", () => {
    const version = schemaFor("version");
    const good = envelope("version", { version: "0.1.0", bun: "1.3.14", platform: "darwin-arm64" });
    expect(validate(version, good)).toEqual([]);
    expect(validate(version, { ...good, data: null, ok: false })).toEqual([]);
    expect(validate(version, { ...good, data: { ...good.data, redactedValues: true } })).toEqual([]);
    expect(validate(version, { ...good, data: { ...good.data, arch: "arm64" } })).toEqual(["/data/arch: property not allowed (closest of 2 anyOf branches)"]);
    expect(validate(version, { ...good, data: { version: "0.1.0", bun: "1.3.14" } })).toEqual(["/data: missing required property platform (closest of 2 anyOf branches)"]);
    const { schemaVersion: _, ...unversioned } = good;
    expect(validate(version, unversioned)).toEqual(["/: missing required property schemaVersion"]);
    expect(validate(version, { ...good, schemaVersion: 2 })).toEqual(["/schemaVersion: expected 1, got 2"]);
    expect(validate(version, { ...good, command: "status" })).toEqual(['/command: expected "version", got "status"']);

    const problem = { severity: "fatal", code: "X", message: "m", hint: "h", docs: "croft docs X" };
    expect(validate(version, { ...good, problems: [problem] })).toEqual(['/problems/0/severity: expected one of "error", "info", "warning", got "fatal"']);
    const fix = { kind: "command", description: "d" };
    expect(validate(version, { ...good, problems: [{ ...problem, severity: "error", fix }] })[0]).toContain("/problems/0/fix: missing required property command");
  });

  test("the status of an asset takes only §4.3's words", () => {
    const status = schemaFor("status");
    const asset = {
      asset: "a", kind: "ingest", file: "assets/a.ts", status: "ok", rows: 1, lastRun: null, next: { at: null, reason: "manual" },
      stale: false, staleReasons: [], held: false, edited: false,
    };
    const data = { healthy: true, running: [], assets: [asset], scheduling: { state: "off", via: null, lastTickAt: null } };
    expect(validate(status, envelope("status", data))).toEqual([]);
    const bad = validate(status, envelope("status", { ...data, assets: [{ ...asset, status: "sleeping" }] }));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toStartWith('/data/assets/0/status: expected one of "crashed", "failed", "interrupted", "never_run", "no_asset_file", "ok", "running", "skipped", "unknown", got "sleeping"');
  });
});

describe("scripts/build-schemas.ts", () => {
  test("maps TypeScript types to JSON Schema as its header says", () => {
    const dir = temp();
    const file = join(dir, "types.ts");
    writeFileSync(file, `
export type Kind = "b" | "a";
export type Fix = { kind: "x"; n: number } | { kind: "y" };
export interface Inner { name: string; fix?: Fix }
export interface Shape {
  kind: Kind;
  count: number;
  big: bigint;
  when: Date;
  flag: boolean;
  maybe?: boolean;
  gone: string | undefined;
  nullable: string | null;
  literal: 1;
  either: Kind | null;
  list: Inner[];
  pair: [string, number];
  map: Record<string, number>;
  anything: unknown;
  nested: { inner: Inner };
  run(): void;
}
`);
    const s = typeSchema(file, "Shape");
    expect(s.$ref).toBe("#/$defs/Shape");
    const defs = s.$defs as Record<string, JsonSchema>;
    expect(Object.keys(defs)).toEqual(["Fix", "Inner", "Shape"]);
    const shape = defs.Shape!;
    expect(shape.required).toEqual(["kind", "count", "big", "when", "flag", "nullable", "literal", "either", "list", "pair", "map", "anything", "nested"]);
    expect(shape.additionalProperties).toBe(false);
    expect(shape.properties).toEqual({
      kind: { enum: ["a", "b"] },
      count: { type: "number" },
      big: { type: ["integer", "string"] },
      when: { type: "string" },
      flag: { type: "boolean" },
      maybe: { type: "boolean" },
      gone: { type: "string" },
      nullable: { type: ["null", "string"] },
      literal: { const: 1 },
      either: { enum: ["a", "b", null] },
      list: { type: "array", items: { $ref: "#/$defs/Inner" } },
      pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], minItems: 2, maxItems: 2 },
      map: { type: "object", additionalProperties: { type: "number" } },
      anything: {},
      nested: { type: "object", properties: { inner: { $ref: "#/$defs/Inner" } }, required: ["inner"], additionalProperties: false },
    });
    expect(defs.Inner).toEqual({
      type: "object", properties: { name: { type: "string" }, fix: { $ref: "#/$defs/Fix" } }, required: ["name"], additionalProperties: false,
    });
    expect((defs.Fix!.anyOf as JsonSchema[]).length).toBe(2);
    expect(validate(s, {
      kind: "a", count: 1, big: "12345678901234567890", when: "2026-01-01T00:00:00Z", flag: true, nullable: null, literal: 1, either: null,
      list: [{ name: "n", fix: { kind: "x", n: 1 } }], pair: ["a", 1], map: { a: 1 }, anything: [1], nested: { inner: { name: "m" } },
    })).toEqual([]);
  });

  test("writes only what changed, and removes a schema no command has", () => {
    const dir = temp();
    const files = new Map([["a.schema.json", "{}\n"], ["b.schema.json", "{\"x\": 1}\n"]]);
    writeFileSync(join(dir, "a.schema.json"), "{}\n");
    writeFileSync(join(dir, "old.schema.json"), "{}\n");
    expect(staleSchemaFiles(files, dir)).toEqual({ changed: ["b.schema.json"], extra: ["old.schema.json"] });
    expect(writeSchemas(files, dir)).toEqual({ changed: ["b.schema.json"], extra: ["old.schema.json"] });
    expect(readdirSync(dir).sort()).toEqual(["a.schema.json", "b.schema.json"]);
    expect(staleSchemaFiles(files, dir)).toEqual({ changed: [], extra: [] });
  });

  test("--check exits 0 while schemas/ is current", () => {
    const r = Bun.spawnSync([process.execPath, join(SCHEMAS_OUT, "..", "scripts", "build-schemas.ts"), "--check"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(r.stdout.toString()).toContain("schemas/ is up to date");
  }, 30_000);
});

describe("the golden tests", () => {
  test("run every command with a schema", () => {
    const dir = join(SCHEMAS_OUT, "..", "tests", "golden");
    const text = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    const covered = new Set([...text.matchAll(/\bgolden\("([a-z]+)"/g)].map((m) => m[1]!));
    expect(SCHEMA_COMMANDS.filter((c) => !covered.has(c))).toEqual([]);
  });
});
