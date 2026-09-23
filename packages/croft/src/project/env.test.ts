import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWithOptions, inspect } from "node:util";
import { CroftError } from "../core/errors.ts";
import { ProjectEnv, parseDotenv } from "./env.ts";

const base = mkdtempSync(join(tmpdir(), "croft-env-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function parse(text: string): Record<string, string> {
  return Object.fromEntries(parseDotenv(text).values);
}

describe("parseDotenv", () => {
  test("comments, blank lines, export prefix and spacing", () => {
    expect(parse([
      "# a comment",
      "",
      "   # indented comment",
      "A=1",
      "export B=two",
      "C = spaced value  ",
      "\tD=tabbed",
      "E=",
      "F=value # trailing comment",
      "G=#only a comment",
      "H=pa#ss",
      "dotted.key-name=ok",
    ].join("\n"))).toEqual({
      A: "1", B: "two", C: "spaced value", D: "tabbed", E: "", F: "value", G: "", H: "pa#ss", "dotted.key-name": "ok",
    });
  });

  test("single quotes are literal, double quotes expand escapes, backticks are literal", () => {
    const v = parse([
      String.raw`S='raw \n $HOME "dq"'`,
      String.raw`D="line\nnext\ttab \"quoted\" back\\slash \x"`,
      "B=`it's \"both\"`",
      String.raw`Q='it\'s'`,
      `H="hash # inside" # outside`,
      `SP="  padded  "`,
    ].join("\n"));
    expect(v.S).toBe(String.raw`raw \n $HOME "dq"`);
    expect(v.D).toBe('line\nnext\ttab "quoted" back\\slash \\x');
    expect(v.B).toBe(`it's "both"`);
    expect(v.Q).toBe(String.raw`it\'s`);
    expect(v.H).toBe("hash # inside");
    expect(v.SP).toBe("  padded  ");
  });

  test("multi-line quoted values, and line counting continues after them", () => {
    const r = parseDotenv([
      'KEY="-----BEGIN KEY-----',
      "abc",
      '-----END KEY-----"',
      "SINGLE='a",
      "b'",
      "AFTER=yes",
      "not a pair",
    ].join("\n"));
    expect(r.values.get("KEY")).toBe("-----BEGIN KEY-----\nabc\n-----END KEY-----");
    expect(r.values.get("SINGLE")).toBe("a\nb");
    expect(r.values.get("AFTER")).toBe("yes");
    expect(r.issues).toEqual([{ line: 7, message: "line 7 is not KEY=value and was skipped" }]);
  });

  test("an unclosed quote uses the rest of the line and does not swallow later keys", () => {
    const r = parseDotenv('A="unterminated\nB=after');
    expect(Object.fromEntries(r.values)).toEqual({ A: '"unterminated', B: "after" });
    expect(r.issues[0]!.message).toContain("never closed");
  });

  test("text after a closing quote makes the value unquoted, like dotenv", () => {
    expect(parse('L="x" trailing')).toEqual({ L: '"x" trailing' });
  });

  test("CRLF line endings, a BOM, duplicates and no ${} expansion", () => {
    expect(parse('﻿A=1\r\nB="x\r\ny"\r\nA=2\r\nC=${A}')).toEqual({ A: "2", B: "x\ny", C: "${A}" });
  });

  test("invalid keys are skipped", () => {
    const r = parseDotenv("1BAD=x\nGOOD=y\n=novalue");
    expect(Object.fromEntries(r.values)).toEqual({ GOOD: "y" });
    expect(r.issues.map((i) => i.line)).toEqual([1, 3]);
  });
});

describe("ProjectEnv", () => {
  function projectWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(base, "p-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  test("the shell environment wins over .env; empty shell values do not", () => {
    const root = projectWith({ ".env": "STRIPE_KEY=from_file\nGITHUB_TOKEN=ghp_file\nEMPTY_IN_SHELL=file_value\n" });
    const env = ProjectEnv.load(root, { GITHUB_TOKEN: "ghp_shell", EMPTY_IN_SHELL: "" });
    expect(env.lookup("STRIPE_KEY")).toEqual({ value: "from_file", source: ".env" });
    expect(env.lookup("GITHUB_TOKEN")).toEqual({ value: "ghp_shell", source: "env" });
    expect(env.lookup("EMPTY_IN_SHELL")).toEqual({ value: "file_value", source: ".env" });
    expect(env.lookup("NOPE")).toBeNull();
  });

  test("a missing .env is fine; no root means shell only", () => {
    const root = projectWith({});
    expect(ProjectEnv.load(root, {}).lookup("X")).toBeNull();
    expect(ProjectEnv.load(null, { X: "shell" }).lookup("X")).toEqual({ value: "shell", source: "env" });
  });

  test("secret() exposes only declared names", () => {
    const env = new ProjectEnv({ root: null, fileValues: new Map([["STRIPE_KEY", "sk_live_123"], ["OTHER", "x"]]) });
    expect(env.secret("STRIPE_KEY", ["STRIPE_KEY"], "stripe_charges")).toBe("sk_live_123");

    let err: unknown;
    try { env.secret("OTHER", ["STRIPE_KEY"], "stripe_charges"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).code).toBe("SECRET_MISSING");
    expect((err as CroftError).message).toBe('secret "OTHER" is not declared (asset stripe_charges); only names listed in the asset\'s secrets can be read');
    expect((err as CroftError).problem.hint).toBe('add secrets: ["STRIPE_KEY", "OTHER"] to the asset');
  });

  test("secret() throws SECRET_MISSING with the .env instruction when the value is absent", () => {
    const env = new ProjectEnv({ root: null, fileValues: new Map([["EMPTY", ""]]) });
    for (const name of ["MISSING", "EMPTY"]) {
      let err: unknown;
      try { env.secret(name, [name], "a"); } catch (e) { err = e; }
      expect((err as CroftError).code).toBe("SECRET_MISSING");
      expect((err as CroftError).problem).toMatchObject({
        message: `secret ${name} is not set (used by a)`,
        hint: `add ${name}=... to .env (or run \`croft secrets set ${name}\` in your terminal)`,
        asset: "a",
        fix: { kind: "manual", requiresHuman: true },
      });
    }
  });

  test("listSecrets reports status, source and users", () => {
    const env = new ProjectEnv({ root: null, fileValues: new Map([["GITHUB_TOKEN", "ghp_1234"]]), shell: { OPENAI_KEY: "sk-shell" } });
    expect(env.listSecrets({
      stripe_charges: ["STRIPE_KEY"], github_issues: ["GITHUB_TOKEN"], issue_triage: ["OPENAI_KEY", "GITHUB_TOKEN"],
    })).toEqual([
      { name: "GITHUB_TOKEN", status: "set", source: ".env", usedBy: ["github_issues", "issue_triage"] },
      { name: "OPENAI_KEY", status: "set", source: "env", usedBy: ["issue_triage"] },
      { name: "STRIPE_KEY", status: "missing", source: null, usedBy: ["stripe_charges"] },
    ]);
  });

  test(".env.local and .env.* are reported as ENV_FILE_IGNORED; templates are not", () => {
    const root = projectWith({ ".env": "A=1", ".env.local": "A=2", ".env.production": "A=3", ".env.example": "A=", ".envrc": "x" });
    const env = ProjectEnv.load(root, {});
    expect(env.ignoredFiles).toEqual([".env.local", ".env.production"]);
    expect(env.lookup("A")).toEqual({ value: "1", source: ".env" });
    const ps = env.problems();
    expect(ps).toHaveLength(2);
    expect(ps[0]).toMatchObject({
      severity: "warning", code: "ENV_FILE_IGNORED", file: ".env.local",
      message: ".env.local is ignored: croft reads secrets only from .env", docs: "croft docs ENV_FILE_IGNORED",
    });
  });

  test("values never show up when the object is logged or serialized", () => {
    const env = new ProjectEnv({ root: "/p", fileValues: new Map([["TOKEN", "supersecretvalue"]]) });
    expect(JSON.stringify(env)).not.toContain("supersecretvalue");
    expect(inspect(env, { depth: 5 })).not.toContain("supersecretvalue");
    expect(String(Bun.inspect(env))).not.toContain("supersecretvalue");
  });
});

describe("redact", () => {
  const env = new ProjectEnv({
    root: null,
    fileValues: new Map([
      ["STRIPE_KEY", "sk_live_abc123"], ["SHORT", "abc"], ["PREFIX", "sk_live"], ["PASS", "p@ss word/+"],
      ["REGEX", "a.b*c"], ["DEBUG", "true"],
    ]),
    shell: { SHELL_TOKEN: "shell-secret-1" },
  });

  test("replaces every .env value of 4+ characters with its name", () => {
    expect(env.redact("key=sk_live_abc123 short=abc")).toBe("key=[redacted:STRIPE_KEY] short=abc");
    expect(env.redact("sk_live_abc123sk_live_abc123")).toBe("[redacted:STRIPE_KEY][redacted:STRIPE_KEY]");
  });

  test("longer values win over values they contain", () => {
    expect(env.redact("sk_live and sk_live_abc123")).toBe("[redacted:PREFIX] and [redacted:STRIPE_KEY]");
  });

  test("regex characters are literal and URL-encoded forms are caught", () => {
    expect(env.redact("a.b*c axbbc")).toBe("[redacted:REGEX] axbbc");
    expect(env.redact("https://x.test/?p=p%40ss%20word%2F%2B")).toBe("https://x.test/?p=[redacted:PASS]");
  });

  test("short values are left alone; 4-character values are not", () => {
    expect(env.redact("abc true")).toBe("abc [redacted:DEBUG]");
  });

  test("shell values are redacted once handed out by secret()", () => {
    expect(env.redact("shell-secret-1")).toBe("shell-secret-1");
    expect(env.secret("SHELL_TOKEN", ["SHELL_TOKEN"])).toBe("shell-secret-1");
    expect(env.redact("got shell-secret-1")).toBe("got [redacted:SHELL_TOKEN]");
  });

  test("redactDeep walks objects and arrays, keeping keys and non-strings", () => {
    expect(env.redactDeep({ sk_live_abc123: ["sk_live_abc123", 5, null, { url: "x?k=sk_live_abc123" }], ok: true }))
      .toEqual({ sk_live_abc123: ["[redacted:STRIPE_KEY]", 5, null, { url: "x?k=[redacted:STRIPE_KEY]" }], ok: true });
  });

  test("an empty env redacts nothing", () => {
    const empty = new ProjectEnv({ root: null });
    expect(empty.redact("anything")).toBe("anything");
    const obj = { a: "b" };
    expect(empty.redactDeep(obj)).toBe(obj);
    expect(empty.redactData("anything")).toBe("anything");
  });
});

describe("redactData (query rows and other command data)", () => {
  const values = new Map([
    ["PORT", "5432"], ["LOG_LEVEL", "info"], ["NODE_ENV", "production"], ["STRIPE_KEY", "sk_live_abc123"],
    ["ACCOUNT", "1234567890"], ["DB_PASS", "hunter2x"], ["PIN", "hunter"], ["API_URL", "https://api.example.test/v1"],
  ]);

  test("only credential-looking values: 8+ characters, not only letters, not only digits", () => {
    const env = new ProjectEnv({ root: null, fileValues: values });
    const row = "customer info: production order #5432 acct 1234567890 key sk_live_abc123 pass hunter2x via https://api.example.test/v1";
    expect(env.redactData(row)).toBe(
      "customer info: production order #5432 acct 1234567890 key [redacted:STRIPE_KEY] pass [redacted:DB_PASS] via [redacted:API_URL]");
    // Free text (messages, logs) still hides every .env value of 4+ characters.
    expect(env.redact("customer info: production order #5432")).toBe("customer [redacted:LOG_LEVEL]: [redacted:NODE_ENV] order #[redacted:PORT]");
  });

  test("declared secrets are always redacted from data", () => {
    const env = new ProjectEnv({ root: null, fileValues: values });
    expect(env.redactData("pin hunter, account 1234567890")).toBe("pin hunter, account 1234567890");
    env.declare(["PIN"]);
    expect(env.redactData("pin hunter, account 1234567890")).toBe("pin [redacted:PIN], account 1234567890");
    // secret() declares the asset's whole secrets list.
    expect(env.secret("PORT", ["PORT", "ACCOUNT"])).toBe("5432");
    expect(env.redactData("pin hunter, account 1234567890, port 5432")).toBe("pin [redacted:PIN], account [redacted:ACCOUNT], port [redacted:PORT]");
    // URL-encoded forms are caught in data too.
    expect(env.redactData("u=https%3A%2F%2Fapi.example.test%2Fv1")).toBe("u=[redacted:API_URL]");
  });

  test("shell values handed out by secret() count as declared", () => {
    const env = new ProjectEnv({ root: null, shell: { SHELL_PIN: "4242" } });
    expect(env.secret("SHELL_PIN", ["SHELL_PIN"])).toBe("4242");
    expect(env.redactData("pin 4242")).toBe("pin [redacted:SHELL_PIN]");
  });

  test("declare() registers a declared name's shell value without handing it out", () => {
    const env = new ProjectEnv({ root: null, fileValues: new Map([["FROM_FILE", "file-value-9"]]),
      shell: { SHELL_PIN: "4242", OTHER: "not-a-secret", FROM_FILE: "" } });
    expect(env.redactData("pin 4242")).toBe("pin 4242");
    env.declare(["SHELL_PIN", "FROM_FILE", "UNSET"]);
    expect(env.redactData("pin 4242, other not-a-secret")).toBe("pin [redacted:SHELL_PIN], other not-a-secret");
    expect(env.redact("got 4242")).toBe("got [redacted:SHELL_PIN]");
    // An empty shell value does not win over .env, so the .env value is the one hidden.
    expect(env.redactData("f file-value-9")).toBe("f [redacted:FROM_FILE]");
  });
});

// §9.6 / D54: every rendering of a .env value is redacted, not only its raw text. Asset code prints values inside
// objects (util.inspect escapes them), serializes them (JSON.stringify), and APIs echo them back escaped (PHP's
// json_encode writes "/" as "\/") or base64-encoded (a Basic auth header).
describe("redact: escaped and encoded renderings", () => {
  const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretline1\nZZsecretline2abcdef\nAw==\n-----END RSA PRIVATE KEY-----\n";
  const AWS = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const QUOTED = `it's "q" \`t\` back\\slash\tTab-9x`;
  const UNI = "pässwörd-€-日本-x1";
  const env = new ProjectEnv({
    root: null,
    fileValues: new Map([["GH_APP_KEY", PEM], ["AWS_SECRET", AWS], ["QUOTED", QUOTED], ["UNI", UNI], ["BASIC_PASS", "hunter2hunter2"]]),
  });
  const fragments = ["MIIEowIBAAKCAQEAsecretline1", "secretline1", "secretline2", "ZZsecretline2abcdef", "bPxRfiCYEXAMPLEKEY", "K7MDENG", "hunter2"];
  const clean = (text: string) => {
    const out = env.redact(text);
    for (const f of fragments) expect(out, `${f} in ${out}`).not.toContain(f);
    return out;
  };
  const fmt = (...args: unknown[]) => formatWithOptions({ colors: false, depth: 4 }, ...args);

  test("a multi-line key inside an object printed like ctx.log / console.log (util.inspect splits it into lines)", () => {
    const out = clean(fmt("auth config", { appId: 123, privateKey: PEM }));
    expect(out).toContain("[redacted:GH_APP_KEY]");
    expect(out).toContain("appId: 123");
    // The whole value, with inspect's ' +\n  ' continuations, becomes one marker: not even the short "Aw==" line is left.
    expect(out).not.toContain("Aw==");
    clean(inspect(PEM));
    clean(inspect([PEM], { breakLength: Infinity }));
  });

  test("JSON.stringify of a multi-line key, and each of its lines (8+ characters) printed on its own", () => {
    const out = clean(JSON.stringify({ appId: 123, privateKey: PEM }));
    expect(out).toBe('{"appId":123,"privateKey":"[redacted:GH_APP_KEY]"}');
    clean(JSON.stringify(JSON.stringify({ k: PEM })));   // escaped twice
    const lines = PEM.split("\n");
    expect(clean(`line: ${lines[1]}`)).toBe("line: [redacted:GH_APP_KEY]");
    expect(clean(`${lines[2]}!`)).toBe("[redacted:GH_APP_KEY]!");
    // A value with Windows line endings is split the same way.
    const crlf = new ProjectEnv({ root: null, fileValues: new Map([["K", "first-line-abc\r\nsecond-line-xyz"]]) });
    expect(crlf.redact("a second-line-xyz b")).toBe("a [redacted:K] b");
  });

  test("an HTTP error body that JSON-escapes '/' as '\\/' (PHP json_encode), and plain JSON escaping", () => {
    const body = JSON.stringify({ error: `invalid key ${AWS}` }).replaceAll("/", "\\/");
    expect(body).toContain("wJalrXUtnFEMI\\/K7MDENG\\/bPxRfiCYEXAMPLEKEY");
    expect(clean(body)).toBe('{"error":"invalid key [redacted:AWS_SECRET]"}');
    expect(env.redact(JSON.stringify({ q: QUOTED }))).toBe('{"q":"[redacted:QUOTED]"}');
    // An HTTP_ERROR message quoting the body, then stored as JSON (runs.sqlite, events.ndjson).
    expect(clean(JSON.stringify({ message: `GET /x failed with 403: ${body}` }))).toContain("[redacted:AWS_SECRET]");
  });

  test("util.inspect quoting: single quotes with \\' escapes, double quotes and backticks", () => {
    expect(env.redact(inspect(QUOTED))).toBe("'[redacted:QUOTED]'");
    expect(env.redact(fmt({ q: QUOTED }))).toBe("{ q: '[redacted:QUOTED]' }");
    expect(env.redact(inspect({ s: "it's " + AWS }))).toBe(`{ s: "it's [redacted:AWS_SECRET]" }`);
    // Control characters are escaped as \x.. by inspect and \u00.. by JSON.
    const ctl = new ProjectEnv({ root: null, fileValues: new Map([["CTL", "abc\x01def\x7fghi"]]) });
    expect(ctl.redact(inspect("abc\x01def\x7fghi"))).toBe("'[redacted:CTL]'");
    expect(ctl.redact(JSON.stringify("abc\x01def\x7fghi"))).toBe('"[redacted:CTL]"');
  });

  test("non-ASCII values, raw and \\u-escaped (json_encode, Python's json.dumps)", () => {
    expect(env.redact(`x ${UNI} y`)).toBe("x [redacted:UNI] y");
    const ascii = JSON.stringify(UNI).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    expect(ascii).toContain("\\u00e4");
    expect(env.redact(ascii)).toBe('"[redacted:UNI]"');
    const upper = ascii.replace(/\\u([0-9a-f]{4})/g, (_, h: string) => `\\u${h.toUpperCase()}`);
    expect(env.redact(upper)).toBe('"[redacted:UNI]"');
  });

  test("URL-encoded forms, whatever the case of the percent escapes, and form encoding (space as +)", () => {
    expect(env.redact(`?k=${encodeURIComponent(AWS)}`)).toBe("?k=[redacted:AWS_SECRET]");
    const lower = encodeURIComponent(AWS).replace(/%([0-9A-F]{2})/g, (_, h: string) => `%${h.toLowerCase()}`);
    expect(lower).toContain("%2f");
    expect(env.redact(`?k=${lower}`)).toBe("?k=[redacted:AWS_SECRET]");
    expect(env.redact(new URLSearchParams({ k: QUOTED }).toString())).toBe("k=[redacted:QUOTED]");
  });

  test("base64: of the whole value, and of the value inside a longer credential (Basic auth)", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    expect(env.redact(`x ${b64(AWS)} y`)).toBe("x [redacted:AWS_SECRET] y");
    for (const header of [b64(`user:${AWS}`), b64(`${AWS}:`), b64(`ab:${AWS}`), b64(`abc:hunter2hunter2`), b64(`hunter2hunter2:x`)]) {
      const out = env.redact(`Authorization: Basic ${header}`);
      expect(out, out).toContain("[redacted:");
      // At most the base64 characters of a few bytes at each edge are left.
      expect(out.replace(/\[redacted:\w+\]/g, "").length, out).toBeLessThanOrEqual("Authorization: Basic ".length + 16);
    }
    // base64url too (JWT-style encoders).
    const url = b64(`u:${AWS}`).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(env.redact(url)).toContain("[redacted:AWS_SECRET]");
    // A base64 text with "/" and "+", echoed in a JSON body that escapes "/" as "\/".
    const odd = new ProjectEnv({ root: null, fileValues: new Map([["TOKEN", "tok>>>en???secret-9"]]) });
    const header = b64("user:tok>>>en???secret-9");
    expect(header).toContain("/");
    expect(header).toContain("+");
    const echoed = JSON.stringify({ got: `Basic ${header}` }).replaceAll("/", "\\/");
    const out = odd.redact(echoed);
    expect(out, out).toContain("[redacted:TOKEN]");
    expect(out.replace(/\[redacted:\w+\]/g, "").length, out).toBeLessThanOrEqual('{"got":"Basic "}'.length + 16);
  });

  test("short values are not matched in base64 or line form, so ordinary text is left alone", () => {
    const small = new ProjectEnv({ root: null, fileValues: new Map([["LEVEL", "info"], ["ML", "ab\ncd"]]) });
    expect(small.redact("aW5mbw== and ab and cd")).toBe("aW5mbw== and ab and cd");
    expect(small.redact("level info; ml ab\ncd")).toBe("level [redacted:LEVEL]; ml [redacted:ML]");
  });

  test("redactData catches the same renderings of a declared secret", () => {
    const d = new ProjectEnv({ root: null, fileValues: new Map([["AWS_SECRET", AWS]]) });
    expect(d.redactData(JSON.stringify({ e: AWS }).replaceAll("/", "\\/"))).toBe('{"e":"[redacted:AWS_SECRET]"}');
  });

  test("a large text with many values is redacted quickly", () => {
    const many = new ProjectEnv({
      root: null,
      fileValues: new Map([...Array.from({ length: 40 }, (_, i) => [`K${i}`, `secret-value-${i}-/+=abcdef${i}`] as [string, string]), ["GH_APP_KEY", PEM]]),
    });
    const text = "lorem ipsum dolor sit amet, consectetur adipiscing elit 0123456789 {\"a\":\"b\\/c\"}\n".repeat(12_000);
    const started = performance.now();
    expect(many.redact(`${text}secret-value-7-/+=abcdef7`)).toEndWith("[redacted:K7]");
    expect(many.redact(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a text of many backslashes does not make redaction backtrack for long", () => {
    const bs = new ProjectEnv({ root: null, fileValues: new Map([["BS", "a\\\\\\\\\\b/c\\d"], ["P", "x/y/z/w/v"]]) });
    const started = performance.now();
    const text = `${"\\".repeat(5000)}/${"\\".repeat(5000)}u002f`;
    expect(bs.redact(text)).toBe(text);
    expect(bs.redact(`${"\\".repeat(3000)}a${"\\".repeat(10)}b\\/c\\\\d`)).toEndWith("[redacted:BS]");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a long text is redacted the same way, including values with no letters or digits", () => {
    const odd = new ProjectEnv({ root: null, fileValues: new Map([["GH_APP_KEY", PEM], ["AWS_SECRET", AWS], ["PUNCT", "!@#$%^&*()"]]) });
    const filler = "x".repeat(20_000);
    const text = `${filler} ${JSON.stringify({ k: PEM })} ${filler} ${JSON.stringify(AWS).replaceAll("/", "\\/")} !@#$%^&*() ${filler}`;
    const out = odd.redact(text);
    expect(out).toBe(`${filler} {"k":"[redacted:GH_APP_KEY]"} ${filler} "[redacted:AWS_SECRET]" [redacted:PUNCT] ${filler}`);
    expect(odd.redact(`${filler}${Buffer.from(`user:${AWS}`).toString("base64")}`)).toContain("[redacted:AWS_SECRET]");
  });
});
