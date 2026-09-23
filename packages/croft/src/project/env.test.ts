import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
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
});
