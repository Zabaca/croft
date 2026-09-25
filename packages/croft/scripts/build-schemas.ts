#!/usr/bin/env bun
// Build the JSON Schemas (draft 2020-12) of croft's --json output (DESIGN.md §4.3): schemas/envelope.schema.json,
// and schemas/<command>.schema.json for every command of src/cli/schemas.ts CommandData.
//
// The schemas come from the TypeScript types, read with the compiler: the envelope is core/types.ts Envelope, and
// each command's data is the T its module declares (CommandImpl<T>). So a schema changes exactly when a data shape
// does, and src/cli/schemas.test.ts fails while the committed files differ from what this script writes.
//
// How types map (JSON.stringify decides what a value becomes):
// - string, number, boolean, null, and literals (const, or enum for a union of them); bigint → an integer or a
//   string (toJsonLine writes one beyond ±2^53 as a string); Date → a string; unknown and any → any value;
// - arrays → items; tuples → prefixItems;
// - an object → its properties, each required unless it is optional or may be undefined (JSON drops undefined),
//   and additionalProperties false unless it has an index signature (Record<string, T> → additionalProperties T);
//   functions are left out, as JSON.stringify leaves them out;
// - a union → anyOf (literals merged into one enum);
// - a named interface or type alias of an object (Problem, Fix, StepResult) → $defs, referenced with $ref, so a
//   type used in several places is written once.
// A command's data is the envelope's data, or null when the command failed before it had any. When output
// redaction changed a value in an object `data`, it carries redactedValues: true (cli/render.ts redactEnvelope).
//
// Usage: bun scripts/build-schemas.ts           writes schemas/
//        bun scripts/build-schemas.ts --check   exits 1 when schemas/ differs from what it would write
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMAS_OUT = join(PKG_ROOT, "schemas");
const SOURCE = join(PKG_ROOT, "src", "cli", "schemas.ts");
const DRAFT = "https://json-schema.org/draft/2020-12/schema";

export type JsonSchema = { [key: string]: unknown };

/** Every schema file, by file name (envelope.schema.json, status.schema.json, …), as the JSON text written. */
export function buildSchemas(): Map<string, string> {
  const program = ts.createProgram([SOURCE], compilerOptions());
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(SOURCE);
  if (!source) throw new Error(`build-schemas: cannot read ${SOURCE}`);
  const diagnostics = ts.getPreEmitDiagnostics(program, source);
  if (diagnostics.length) {
    throw new Error(`build-schemas: src/cli/schemas.ts does not type-check:\n${diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n")}`);
  }

  const envelopeType = exportedType(checker, source, "AnyEnvelope");
  const dataTypes = exportedType(checker, source, "CommandData");
  const out = new Map<string, string>();

  const envelope = new SchemaWriter(checker);
  out.set("envelope.schema.json", text(envelope.envelope(envelopeType, null, null)));

  for (const prop of checker.getPropertiesOfType(dataTypes)) {
    const command = prop.getName();
    const writer = new SchemaWriter(checker);
    out.set(`${command}.schema.json`, text(writer.envelope(envelopeType, command, checker.getTypeOfSymbol(prop))));
  }
  return out;
}

/** The JSON Schema of one exported type of `file`, with the $defs it uses: how the mapping above treats a type. */
export function typeSchema(file: string, name: string, options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ESNext }): JsonSchema {
  const program = ts.createProgram([file], options);
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`build-schemas: cannot read ${file}`);
  const checker = program.getTypeChecker();
  return new SchemaWriter(checker).standalone(exportedType(checker, source, name));
}

/** What differs between schemas/ and `files`: files to write, files to delete. */
export function staleSchemaFiles(files: Map<string, string>, dir = SCHEMAS_OUT): { changed: string[]; extra: string[] } {
  const present = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  const changed = [...files].filter(([name, body]) => !present.includes(name) || readFileSync(join(dir, name), "utf8") !== body).map(([name]) => name);
  const extra = present.filter((f) => !files.has(f));
  return { changed: changed.sort(), extra: extra.sort() };
}

export function writeSchemas(files: Map<string, string>, dir = SCHEMAS_OUT): { changed: string[]; extra: string[] } {
  const stale = staleSchemaFiles(files, dir);
  mkdirSync(dir, { recursive: true });
  for (const name of stale.changed) writeFileSync(join(dir, name), files.get(name)!);
  for (const name of stale.extra) rmSync(join(dir, name));
  return stale;
}

/** Schemas in the order of their JSON text. */
function sortSchemas(schemas: JsonSchema[]): JsonSchema[] {
  return schemas.map((s) => [JSON.stringify(s), s] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
}

/** Literals in a stable order: strings, then numbers, then booleans, then null. */
function compareLiterals(a: unknown, b: unknown): number {
  const rank = (v: unknown) => (typeof v === "string" ? 0 : typeof v === "number" ? 1 : typeof v === "boolean" ? 2 : 3);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return Number(a) - Number(b);
}

function text(schema: JsonSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

function compilerOptions(): ts.CompilerOptions {
  const file = join(PKG_ROOT, "tsconfig.json");
  const read = ts.readConfigFile(file, ts.sys.readFile);
  if (read.error) throw new Error(`build-schemas: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, PKG_ROOT);
  return { ...parsed.options, noEmit: true };
}

function exportedType(checker: ts.TypeChecker, source: ts.SourceFile, name: string): ts.Type {
  const module = checker.getSymbolAtLocation(source);
  const symbol = module && checker.getExportsOfModule(module).find((s) => s.getName() === name);
  if (!symbol) throw new Error(`build-schemas: ${source.fileName} exports no ${name}`);
  return checker.getDeclaredTypeOfSymbol(symbol);
}

/** One schema file: the types it meets, and the $defs they become. */
class SchemaWriter {
  readonly #checker: ts.TypeChecker;
  readonly #defs = new Map<string, JsonSchema>();
  readonly #names = new Map<ts.Type, string>();
  readonly #taken = new Map<string, ts.Type>();
  readonly #inProgress = new Set<ts.Type>();

  constructor(checker: ts.TypeChecker) {
    this.#checker = checker;
  }

  /** The envelope, with `command` and `data` narrowed to one command's (both null: the envelope of any command). */
  envelope(envelopeType: ts.Type, command: string | null, data: ts.Type | null): JsonSchema {
    const body = this.#object(envelopeType, { inline: true });
    const properties = body.properties as Record<string, JsonSchema>;
    if (command !== null && data !== null) {
      properties.command = { const: command };
      const own = this.#data(data);
      const variants = Array.isArray(own.anyOf) && Object.keys(own).length === 1 ? (own.anyOf as JsonSchema[]) : [own];
      properties.data = { anyOf: [...variants, { type: "null" }] };
    } else {
      properties.data = { description: "The command's own data (schemas/<command>.schema.json), or null when it failed before it had any." };
    }
    const head: JsonSchema = {
      $schema: DRAFT,
      title: command === null ? "croft --json envelope" : `croft ${command} --json`,
      description: command === null
        ? "The one JSON object every croft command prints on stdout with --json (DESIGN.md §4.3). Each command's schema narrows command and data."
        : `The envelope croft ${command} --json prints on stdout (DESIGN.md §4.3). data is null when the command failed before it had any.`,
    };
    const defs = [...this.#defs].sort(([a], [b]) => a.localeCompare(b));
    return { ...head, ...body, ...(defs.length ? { $defs: Object.fromEntries(defs) } : {}) };
  }

  /** One type, with the $defs it uses. */
  standalone(type: ts.Type): JsonSchema {
    const schema = this.schema(type);
    const defs = [...this.#defs].sort(([a], [b]) => a.localeCompare(b));
    return { ...schema, ...(defs.length ? { $defs: Object.fromEntries(defs) } : {}) };
  }

  /** A command's data: objects inline, each allowing redactedValues (added by output redaction). */
  #data(type: ts.Type): JsonSchema {
    const members = type.isUnion() && !(type.flags & ts.TypeFlags.Boolean) ? this.#ordered(type.types) : [type];
    const schemas = members.map((m) => {
      if (!this.#isPlainObject(m)) return this.schema(m);
      const s = this.#object(m, { inline: true });
      (s.properties as Record<string, JsonSchema>).redactedValues = { const: true };
      const name = this.#baseName(m);
      return name === null ? s : { title: name, ...s };
    });
    return schemas.length === 1 ? schemas[0]! : { anyOf: sortSchemas(schemas) };
  }

  schema(type: ts.Type): JsonSchema {
    const f = type.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (f & ts.TypeFlags.Never) return { not: {} };
    if (f & ts.TypeFlags.Null) return { type: "null" };
    if (f & ts.TypeFlags.StringLiteral) return { const: (type as ts.StringLiteralType).value };
    if (f & ts.TypeFlags.NumberLiteral) return { const: (type as ts.NumberLiteralType).value };
    if (f & ts.TypeFlags.BooleanLiteral) return { const: this.#checker.typeToString(type) === "true" };
    if (f & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) return { type: "string" };
    if (f & ts.TypeFlags.Number) return { type: "number" };
    if (f & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (f & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) return { type: ["integer", "string"] };
    if (type.isUnion()) {
      // A named union of objects (Fix) is a $def like a named interface.
      const name = type.types.some((t) => this.#isPlainObject(t)) ? this.#nameOf(type) : null;
      if (name === null) return this.#union(type);
      if (!this.#defs.has(name)) {
        this.#defs.set(name, {});
        this.#defs.set(name, this.#union(type));
      }
      return { $ref: `#/$defs/${name}` };
    }
    if (this.#checker.isTupleType(type)) {
      const items = this.#checker.getTypeArguments(type as ts.TypeReference).map((t) => this.schema(t));
      return { type: "array", prefixItems: items, minItems: items.length, maxItems: items.length };
    }
    if (this.#checker.isArrayType(type)) {
      return { type: "array", items: this.schema(this.#checker.getTypeArguments(type as ts.TypeReference)[0]!) };
    }
    if (type.getSymbol()?.getName() === "Date") return { type: "string" };
    if (f & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) return this.#object(type, { inline: false });
    throw new Error(`build-schemas: no JSON Schema for the type ${this.#checker.typeToString(type)}`);
  }

  #union(type: ts.UnionType): JsonSchema {
    let members = this.#ordered(type.types);
    const bools = members.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral);
    const boolean = bools.length === 2;
    if (boolean) members = members.filter((t) => !(t.flags & ts.TypeFlags.BooleanLiteral));
    const literals: unknown[] = [];
    const primitives: string[] = boolean ? ["boolean"] : [];
    const rest: JsonSchema[] = [];
    for (const m of members) {
      const s = this.schema(m);
      if ("const" in s && Object.keys(s).length === 1) literals.push(s.const);
      else if (typeof s.type === "string" && Object.keys(s).length === 1 && s.type !== "object" && s.type !== "array") primitives.push(s.type);
      else rest.push(s);
    }
    // A literal of a type already allowed adds nothing ("a" | string is string).
    const kept = literals.filter((v) => !primitives.includes(v === null ? "null" : typeof v));
    // null next to literals joins their enum ("a" | "b" | null).
    if (kept.length && primitives.includes("null")) {
      primitives.splice(primitives.indexOf("null"), 1);
      kept.push(null);
    }
    // The compiler orders a union's members by when it first met each type, which any other file can change: sort,
    // so a schema changes only when its type does.
    const parts = sortSchemas(rest);
    primitives.sort();
    kept.sort(compareLiterals);
    if (primitives.length) parts.push({ type: primitives.length === 1 ? primitives[0] : primitives });
    if (kept.length) parts.push(kept.length === 1 ? { const: kept[0] } : { enum: kept });
    if (parts.length === 0) return { not: {} };
    return parts.length === 1 ? parts[0]! : { anyOf: parts };
  }

  /** Whether `type` is an object JSON writes as {…} (not an array, a Date or a function). */
  #isPlainObject(type: ts.Type): boolean {
    if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return false;
    if (this.#checker.isArrayType(type) || this.#checker.isTupleType(type)) return false;
    return type.getSymbol()?.getName() !== "Date";
  }

  #object(type: ts.Type, o: { inline: boolean }): JsonSchema {
    const name = o.inline ? null : this.#nameOf(type);
    if (name === null) {
      if (this.#inProgress.has(type)) throw new Error(`build-schemas: ${this.#checker.typeToString(type)} refers to itself without a name`);
      this.#inProgress.add(type);
      try {
        return this.#objectBody(type);
      } finally {
        this.#inProgress.delete(type);
      }
    }
    if (!this.#defs.has(name)) {
      this.#defs.set(name, {});                                    // taken before its body: a self-reference resolves
      this.#defs.set(name, this.#objectBody(type));
    }
    return { $ref: `#/$defs/${name}` };
  }

  #objectBody(type: ts.Type): JsonSchema {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const prop of this.#checker.getPropertiesOfType(type)) {
      const t = this.#checker.getTypeOfSymbol(prop);
      if (this.#isFunction(t)) continue;
      const name = prop.getName();
      properties[name] = this.schema(this.#declaredAlias(prop) ?? t);
      const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0
        || (t.isUnion() && t.types.some((m) => m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)))
        || (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
      if (!optional) required.push(name);
    }
    const index = this.#checker.getIndexInfosOfType(type).find((i) => i.keyType.flags & ts.TypeFlags.String);
    const out: JsonSchema = { type: "object" };
    if (Object.keys(properties).length) out.properties = properties;
    if (required.length) out.required = required;
    if (index) {
      const values = this.schema(index.type);
      if (Object.keys(values).length) out.additionalProperties = values;
    } else {
      out.additionalProperties = false;
    }
    return out;
  }

  /** The members of a union without undefined, in an order that does not depend on the rest of the program. */
  #ordered(types: readonly ts.Type[]): ts.Type[] {
    const keyed = types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void))).map((t) => [this.#checker.typeToString(t), t] as const);
    return keyed.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, t]) => t);
  }

  /**
   * A property declared with a named, non-generic type alias (`fix?: Fix`): that alias's type. The property's own
   * type is a new union with undefined when it is optional, which has lost the name (and so its $def).
   */
  #declaredAlias(prop: ts.Symbol): ts.Type | null {
    const decl = prop.valueDeclaration;
    if (!decl || !(ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) || !decl.type) return null;
    const declared = this.#checker.getTypeFromTypeNode(decl.type);
    return declared.aliasSymbol && !declared.aliasTypeArguments?.length ? declared : null;
  }

  #isFunction(type: ts.Type): boolean {
    const members = type.isUnion() ? type.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void))) : [type];
    return members.length > 0 && members.every((t) => t.getCallSignatures().length > 0 && this.#checker.getPropertiesOfType(t).length === 0);
  }

  /** A type's own name: a non-generic interface's or type alias's; null for an anonymous or generic type. */
  #baseName(type: ts.Type): string | null {
    let base: string | null = null;
    if (type.aliasSymbol && !type.aliasTypeArguments?.length) base = type.aliasSymbol.getName();
    else {
      const symbol = type.getSymbol();
      const generic = ((type as ts.TypeReference).typeArguments?.length ?? 0) > 0;
      if (symbol && (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) && !generic) base = symbol.getName();
    }
    return base !== null && /^[A-Za-z_]\w*$/.test(base) ? base : null;
  }

  /** The $defs name of a named object type (an interface, or an alias of an object or a union of objects); null for
   *  an anonymous or generic one, which is written inline. Two types of one name are told apart by a number. */
  #nameOf(type: ts.Type): string | null {
    const known = this.#names.get(type);
    if (known) return known;
    const base = this.#baseName(type);
    if (base === null) return null;
    let name = base;
    for (let n = 2; this.#taken.has(name) && this.#taken.get(name) !== type; n++) name = `${base}${n}`;
    this.#taken.set(name, type);
    this.#names.set(type, name);
    return name;
  }
}

if (import.meta.main) {
  const files = buildSchemas();
  if (process.argv.includes("--check")) {
    const stale = staleSchemaFiles(files);
    if (stale.changed.length || stale.extra.length) {
      console.error(`build-schemas: schemas/ is out of date (${[...stale.changed, ...stale.extra.map((f) => `${f} (remove)`)].join(", ")}); run bun scripts/build-schemas.ts`);
      process.exit(1);
    }
    console.log(`build-schemas: schemas/ is up to date (${files.size} files)`);
  } else {
    const done = writeSchemas(files);
    console.log(`build-schemas: ${files.size} schemas; wrote ${done.changed.length}${done.extra.length ? `, removed ${done.extra.join(", ")}` : ""}`);
  }
}
