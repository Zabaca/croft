// The validator the golden tests use (tests/golden/validator.ts): the subset of JSON Schema draft 2020-12 that
// scripts/build-schemas.ts writes, and nothing silently ignored.
import { describe, expect, test } from "bun:test";
import { schemaKeywords, validate } from "./validator.ts";

const errors = (schema: object, value: unknown) => validate(schema as Record<string, unknown>, value);

describe("the golden validator", () => {
  test("type: each JSON type, integer, and a list of types", () => {
    expect(errors({ type: "string" }, "a")).toEqual([]);
    expect(errors({ type: "string" }, 1)).toEqual(["/: expected string, got number (1)"]);
    expect(errors({ type: "number" }, 1.5)).toEqual([]);
    expect(errors({ type: "integer" }, 2)).toEqual([]);
    expect(errors({ type: "integer" }, 2.5)).toEqual(["/: expected integer, got number (2.5)"]);
    expect(errors({ type: "boolean" }, false)).toEqual([]);
    expect(errors({ type: "null" }, null)).toEqual([]);
    expect(errors({ type: "null" }, undefined)).toEqual(["/: expected null, got undefined"]);
    expect(errors({ type: "object" }, [])).toEqual(["/: expected object, got array"]);
    expect(errors({ type: "array" }, {})).toEqual(["/: expected array, got object"]);
    expect(errors({ type: ["integer", "string"] }, "12345678901234567890")).toEqual([]);
    expect(errors({ type: ["integer", "string"] }, true)).toEqual(["/: expected integer or string, got boolean (true)"]);
  });

  test("const and enum compare JSON values deeply", () => {
    expect(errors({ const: 1 }, 1)).toEqual([]);
    expect(errors({ const: true }, false)).toEqual(["/: expected true, got false"]);
    expect(errors({ enum: ["a", "b", null] }, null)).toEqual([]);
    expect(errors({ enum: ["a", "b"] }, "c")).toEqual(['/: expected one of "a", "b", got "c"']);
    expect(errors({ const: { a: [1, 2] } }, { a: [1, 2] })).toEqual([]);
    expect(errors({ const: { a: [1, 2] } }, { a: [2, 1] })).toHaveLength(1);
  });

  test("objects: properties, required, additionalProperties false or a schema", () => {
    const s = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"], additionalProperties: false };
    expect(errors(s, { a: "x" })).toEqual([]);
    expect(errors(s, { a: "x", b: 2 })).toEqual([]);
    expect(errors(s, { b: 2 })).toEqual(["/: missing required property a"]);
    expect(errors(s, { a: 1 })).toEqual(["/a: expected string, got number (1)"]);
    expect(errors(s, { a: "x", c: 1 })).toEqual(["/c: property not allowed"]);
    const map = { type: "object", additionalProperties: { type: "number" } };
    expect(errors(map, { x: 1, y: 2 })).toEqual([]);
    expect(errors(map, { x: "1" })).toEqual(['/x: expected number, got string ("1")']);
    // No additionalProperties: anything else is allowed.
    expect(errors({ type: "object", properties: { a: { type: "string" } } }, { a: "x", z: [] })).toEqual([]);
  });

  test("a property named __proto__ is an ordinary key", () => {
    const value = JSON.parse('{"__proto__": 1}') as unknown;
    expect(errors({ type: "object", additionalProperties: false }, value)).toEqual(["/__proto__: property not allowed"]);
    expect(errors({ type: "object", additionalProperties: { type: "number" } }, value)).toEqual([]);
  });

  test("arrays: items, prefixItems, minItems and maxItems", () => {
    expect(errors({ type: "array", items: { type: "string" } }, ["a", "b"])).toEqual([]);
    expect(errors({ type: "array", items: { type: "string" } }, ["a", 2])).toEqual(["/1: expected string, got number (2)"]);
    const pair = { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], minItems: 2, maxItems: 2 };
    expect(errors(pair, ["a", 1])).toEqual([]);
    expect(errors(pair, [1, "a"])).toEqual(['/0: expected string, got number (1)', '/1: expected number, got string ("a")']);
    expect(errors(pair, ["a"])).toEqual(["/: expected at least 2 items, got 1"]);
    expect(errors(pair, ["a", 1, 2])).toEqual(["/: expected at most 2 items, got 3"]);
  });

  test("anyOf and oneOf; a failing anyOf reports its closest branch", () => {
    const nullable = { anyOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "null" }] };
    expect(errors(nullable, null)).toEqual([]);
    expect(errors(nullable, { a: "x" })).toEqual([]);
    expect(errors(nullable, { a: 1 })).toEqual(["/a: expected string, got number (1) (closest of 2 anyOf branches)"]);
    const one = { oneOf: [{ type: "number" }, { type: "integer" }] };
    expect(errors(one, 1.5)).toEqual([]);
    expect(errors(one, 1)).toEqual(["/: matches 2 oneOf branches, expected exactly one"]);
    expect(errors(one, "x")).toHaveLength(1);
  });

  test("$ref within the file, recursive ones too", () => {
    const tree = {
      $ref: "#/$defs/Node",
      $defs: { Node: { type: "object", properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/Node" } } }, required: ["name"], additionalProperties: false } },
    };
    expect(errors(tree, { name: "a", children: [{ name: "b", children: [] }] })).toEqual([]);
    expect(errors(tree, { name: "a", children: [{ children: [] }] })).toEqual(["/children/0: missing required property name"]);
    expect(() => errors({ $ref: "#/$defs/Missing" }, 1)).toThrow("unresolved $ref #/$defs/Missing");
    expect(() => errors({ $ref: "other.json#/x" }, 1)).toThrow("only $refs within the file");
  });

  test("{} allows anything, not: {} nothing; annotations are ignored", () => {
    expect(errors({}, { any: ["thing"] })).toEqual([]);
    expect(errors({ not: {} }, 1)).toEqual(["/: no value is allowed here"]);
    expect(errors({ title: "t", description: "d", $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }, "x")).toEqual([]);
  });

  test("a keyword outside the subset is an error, not silently ignored", () => {
    expect(() => errors({ type: "string", pattern: "^a" }, "a")).toThrow("unsupported JSON Schema keyword pattern");
    expect(() => errors({ type: "object", properties: { a: { minimum: 1 } } }, { a: 2 })).toThrow("unsupported JSON Schema keyword minimum");
  });

  test("schemaKeywords lists every keyword a schema uses", () => {
    const s = { type: "object", properties: { a: { anyOf: [{ const: 1 }, { enum: [2] }] } }, $defs: { X: { type: "array", items: {} } } };
    expect([...schemaKeywords(s)].sort()).toEqual(["$defs", "anyOf", "const", "enum", "items", "properties", "type"]);
  });
});
