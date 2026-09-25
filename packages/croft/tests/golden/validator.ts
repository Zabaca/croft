// A small JSON Schema validator for the golden tests: the subset of draft 2020-12 that scripts/build-schemas.ts
// writes (type, const, enum, properties, required, additionalProperties, items, prefixItems, minItems, maxItems,
// anyOf, oneOf, not, and $ref within the file), with the annotations ($schema, title, description, $defs) read or
// skipped. Any other keyword throws, so a schema can never rely on a rule this validator would silently skip.
//
// validate() returns every error as "<JSON pointer>: <what was wrong>"; an empty list means the value matches.
// For tests only (croft itself never validates its output at run time).

export type Schema = Record<string, unknown>;

const ASSERTIONS = new Set([
  "type", "const", "enum", "properties", "required", "additionalProperties", "items", "prefixItems", "minItems", "maxItems",
  "anyOf", "oneOf", "not", "$ref",
]);
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$defs", "$comment"]);

/** Every keyword `schema` uses, at any depth (property and $defs names are not keywords). */
export function schemaKeywords(schema: unknown, out = new Set<string>()): Set<string> {
  if (!isObject(schema)) return out;
  for (const [key, value] of Object.entries(schema)) {
    out.add(key);
    if (key === "properties" || key === "$defs") {
      for (const sub of Object.values(value as Schema)) schemaKeywords(sub, out);
    } else if (key === "anyOf" || key === "oneOf" || key === "prefixItems") {
      for (const sub of value as unknown[]) schemaKeywords(sub, out);
    } else if (key === "items" || key === "not" || (key === "additionalProperties" && isObject(value))) {
      schemaKeywords(value, out);
    }
  }
  return out;
}

/** The errors of `value` against `schema` (whose $refs resolve within `root`, by default the schema itself). */
export function validate(schema: Schema, value: unknown, root: Schema = schema): string[] {
  return check(schema, value, "", root);
}

function check(schema: Schema, value: unknown, at: string, root: Schema): string[] {
  for (const key of Object.keys(schema)) {
    if (!ASSERTIONS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`unsupported JSON Schema keyword ${key} (at ${at || "/"})`);
  }
  const where = at || "/";
  const out: string[] = [];

  if (schema.$ref !== undefined) out.push(...check(resolve(String(schema.$ref), root), value, at, root));

  if (schema.not !== undefined) {
    const not = schema.not as Schema;
    if (Object.keys(not).length !== 0) throw new Error(`only not: {} is supported (at ${where})`);
    out.push(`${where}: no value is allowed here`);
  }

  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some((t) => hasType(value, t))) out.push(`${where}: expected ${types.join(" or ")}, got ${describe(value)}`);
  }

  if ("const" in schema && !equal(schema.const, value)) out.push(`${where}: expected ${JSON.stringify(schema.const)}, got ${show(value)}`);

  if (schema.enum !== undefined) {
    const options = schema.enum as unknown[];
    if (!options.some((o) => equal(o, value))) out.push(`${where}: expected one of ${options.map((o) => JSON.stringify(o)).join(", ")}, got ${show(value)}`);
  }

  if (isObject(value) && !Array.isArray(value)) {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const name of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(value, name)) out.push(`${where}: missing required property ${name}`);
    }
    for (const [name, v] of Object.entries(value)) {
      const path = `${at}/${pointer(name)}`;
      if (Object.hasOwn(properties, name)) out.push(...check(properties[name]!, v, path, root));
      else if (schema.additionalProperties === false) out.push(`${path}: property not allowed`);
      else if (isObject(schema.additionalProperties)) out.push(...check(schema.additionalProperties as Schema, v, path, root));
    }
  }

  if (Array.isArray(value)) {
    const prefix = (schema.prefixItems ?? []) as Schema[];
    value.forEach((item, i) => {
      if (i < prefix.length) out.push(...check(prefix[i]!, item, `${at}/${i}`, root));
      else if (schema.items !== undefined) out.push(...check(schema.items as Schema, item, `${at}/${i}`, root));
    });
    if (typeof schema.minItems === "number" && value.length < schema.minItems) out.push(`${where}: expected at least ${schema.minItems} items, got ${value.length}`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) out.push(`${where}: expected at most ${schema.maxItems} items, got ${value.length}`);
  }

  if (schema.anyOf !== undefined) {
    const branches = (schema.anyOf as Schema[]).map((b) => check(b, value, at, root));
    if (!branches.some((e) => e.length === 0)) {
      const closest = branches.reduce((a, b) => (b.length < a.length ? b : a));
      out.push(...closest.map((e) => `${e} (closest of ${branches.length} anyOf branches)`));
    }
  }

  if (schema.oneOf !== undefined) {
    const branches = (schema.oneOf as Schema[]).map((b) => check(b, value, at, root));
    const matching = branches.filter((e) => e.length === 0).length;
    if (matching === 0) {
      const closest = branches.reduce((a, b) => (b.length < a.length ? b : a));
      out.push(...closest.map((e) => `${e} (closest of ${branches.length} oneOf branches)`));
    } else if (matching > 1) {
      out.push(`${where}: matches ${matching} oneOf branches, expected exactly one`);
    }
  }
  return out;
}

function resolve(ref: string, root: Schema): Schema {
  if (!ref.startsWith("#/")) throw new Error(`only $refs within the file are supported, not ${ref}`);
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    node = isObject(node) && Object.hasOwn(node, key) ? (node as Schema)[key] : undefined;
  }
  if (!isObject(node)) throw new Error(`unresolved $ref ${ref}`);
  return node as Schema;
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "array": return Array.isArray(value);
    case "object": return isObject(value) && !Array.isArray(value);
    default: throw new Error(`unknown JSON Schema type ${type}`);
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return `${typeof value} (${show(value)})`;
}

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function pointer(name: string): string {
  return name.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}
