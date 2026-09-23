// A small strict JSON scanner used only for error positions. Bun's JSON.parse reports no line or
// column ("JSON Parse error: Unexpected token '}'"), and config errors should point at the line.
// JSON.parse stays the source of truth for values; this only finds where things are.

export interface JsonPosition { offset: number; line: number; column: number }
export type JsonScan =
  | { ok: true; paths: Map<string, JsonPosition> }                 // path → position of its key (or array element)
  | { ok: false; message: string; at: JsonPosition };

const LITERAL = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class ScanError extends Error {
  constructor(message: string, readonly offset: number) { super(message); }
}

/** 1-based line and column of an offset. */
export function positionAt(text: string, offset: number): JsonPosition {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
  }
  return { offset, line, column: offset - lineStart + 1 };
}

/** Join a path the way config messages print it: serve.port, serve.allowOrigins[0]. */
export function joinPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return parent ? `${parent}.${key}` : key;
}

export function scanJson(text: string): JsonScan {
  const paths = new Map<string, JsonPosition>();
  let i = 0;

  const describe = (at: number): string => {
    if (at >= text.length) return "the end of the file";
    const ch = text[at]!;
    return /\s/.test(ch) ? "whitespace" : `"${ch}"`;
  };
  const skipWs = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const fail = (message: string, at = i): never => { throw new ScanError(message, at); };

  const scanString = (): string => {
    const start = i;
    i++;                                                               // opening quote
    let out = "";
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '"') { i++; return out; }
      if (ch === "\\") {
        const esc = text[i + 1];
        if (esc === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail("invalid \\u escape in a string", i);
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        if (esc === undefined || !'"\\/bfnrt'.includes(esc)) fail(`invalid escape "\\${esc ?? ""}" in a string`, i);
        out += esc;
        i += 2;
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) fail(ch === "\n" ? "a string runs past the end of the line (missing closing \")" : "control character in a string", i);
      out += ch;
      i++;
    }
    return fail("a string is never closed (missing \")", start);
  };

  const scanValue = (path: string): void => {
    skipWs();
    const ch = text[i];
    if (ch === "{") return scanObject(path);
    if (ch === "[") return scanArray(path);
    if (ch === '"') { scanString(); return; }
    LITERAL.lastIndex = i;
    const literal = LITERAL.exec(text);
    if (literal && !/[\w.]/.test(text[i + literal[0].length] ?? "")) { i += literal[0].length; return; }
    if (ch === "'") fail("strings need double quotes in JSON");
    if (ch === "}" || ch === "]" || ch === undefined) fail(`expected a value, found ${describe(i)}`);
    fail(`expected a value (a string in double quotes, number, true, false, null, object or array), found ${describe(i)}`);
  };

  const scanObject = (path: string): void => {
    i++;
    skipWs();
    if (text[i] === "}") { i++; return; }
    for (;;) {
      skipWs();
      if (text[i] !== '"') {
        if (text[i] === "}") fail('trailing comma before "}" is not allowed in JSON');
        fail(`expected a property name in double quotes, found ${describe(i)}`);
      }
      const keyAt = i;
      const key = scanString();
      const childPath = joinPath(path, key);
      paths.set(childPath, positionAt(text, keyAt));
      skipWs();
      if (text[i] !== ":") fail(`expected ":" after "${key}", found ${describe(i)}`);
      i++;
      scanValue(childPath);
      skipWs();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return; }
      fail(`expected "," or "}" after the value of "${key}", found ${describe(i)}`);
    }
  };

  const scanArray = (path: string): void => {
    i++;
    skipWs();
    if (text[i] === "]") { i++; return; }
    for (let index = 0; ; index++) {
      skipWs();
      if (text[i] === "]") fail('trailing comma before "]" is not allowed in JSON');
      paths.set(joinPath(path, index), positionAt(text, i));
      scanValue(joinPath(path, index));
      skipWs();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return; }
      fail(`expected "," or "]" in a list, found ${describe(i)}`);
    }
  };

  try {
    if (text.charCodeAt(0) === 0xfeff) i = 1;                           // BOM
    skipWs();
    if (i >= text.length) fail("the file is empty; it needs a JSON object");
    scanValue("");
    skipWs();
    if (i < text.length) fail(`unexpected ${describe(i)} after the end of the JSON value`);
    return { ok: true, paths };
  } catch (e) {
    if (!(e instanceof ScanError)) throw e;
    return { ok: false, message: e.message, at: positionAt(text, e.offset) };
  }
}
