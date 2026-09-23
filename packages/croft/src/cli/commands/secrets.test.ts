import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDotenv } from "../../project/env.ts";
import { CHARGES_TS, cleanup, cli, ISSUES_TS, makeProject, SRC } from "./inspect-testkit.ts";
import { quoteEnvValue, SECRETS_IO, upsertDotenv, writeSecret } from "./secrets.ts";

afterAll(() => cleanup());

const original = { ...SECRETS_IO };
afterEach(() => Object.assign(SECRETS_IO, original));

const FILES = { "assets/github_issues.ts": ISSUES_TS, "assets/stripe_charges.ts": CHARGES_TS };
const mode = (path: string) => statSync(path).mode & 0o777;

describe("croft secrets (list)", () => {
  test("golden: [{name, status, source, usedBy}], values never printed", async () => {
    const p = makeProject({ files: { ...FILES, ".env": "GITHUB_TOKEN=ghp_abcdefghijkl\n" } });
    const r = await cli(["secrets", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data).toEqual([
      { name: "GITHUB_TOKEN", status: "set", source: ".env", usedBy: ["github_issues"] },
      { name: "STRIPE_KEY", status: "missing", source: null, usedBy: ["stripe_charges"] },
    ]);
    expect(r.stdout).not.toContain("ghp_abcdefghijkl");
  });

  test("a shell variable wins over .env and is reported as env", async () => {
    const p = makeProject({ files: { ...FILES, ".env": "STRIPE_KEY=from_file_123\n" } });
    const r = await cli(["secrets", "--json"], { cwd: p.root, env: { STRIPE_KEY: "sk_from_shell_1" } });
    expect(r.json.data.find((s: { name: string }) => s.name === "STRIPE_KEY")).toEqual({ name: "STRIPE_KEY", status: "set", source: "env", usedBy: ["stripe_charges"] });
    expect(r.stdout).not.toContain("sk_from_shell_1");
    expect(r.stdout).not.toContain("from_file_123");
  });

  test("human output as in §4.2", async () => {
    const p = makeProject({ files: { ...FILES, ".env": "GITHUB_TOKEN=ghp_abcdefghijkl\n" } });
    const r = await cli(["secrets"], { cwd: p.root });
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      "GITHUB_TOKEN   set (.env)   used by github_issues",
      "STRIPE_KEY     missing      used by stripe_charges → add STRIPE_KEY=... to .env",
    ]);
  });

  test("an asset that does not import still has its secrets listed; ignored .env files are warned about", async () => {
    const broken = `import { ingest } from "@zabaca/croft";\nthrow new Error("x");\nexport default ingest({ secrets: ["OTHER_KEY"], async *rows() {} });\n`;
    const p = makeProject({ files: { "assets/broken.ts": broken, ".env.local": "X=1\n" } });
    const r = await cli(["secrets", "--json"], { cwd: p.root });
    expect(r.json.data).toEqual([{ name: "OTHER_KEY", status: "missing", source: null, usedBy: ["broken"] }]);
    expect(r.json.problems.map((x: { code: string }) => x.code)).toEqual(["ENV_FILE_IGNORED"]);
    expect(r.exit).toBe(0);
  });

  test("no declared secrets", async () => {
    const p = makeProject();
    expect((await cli(["secrets", "--json"], { cwd: p.root })).json.data).toEqual([]);
    expect((await cli(["secrets"], { cwd: p.root })).stdout).toContain("No asset declares a secret");
  });
});

describe("croft secrets set", () => {
  test("--stdin writes .env with mode 0600, keeps every other line, and never prints the value", async () => {
    const p = makeProject({ files: { ...FILES, ".env": "# my secrets\nGITHUB_TOKEN=ghp_abcdefghijkl\n\nOTHER='a b'\n" } });
    SECRETS_IO.readStdin = async () => "sk_live_new_value_9\n";
    const r = await cli(["secrets", "set", "STRIPE_KEY", "--stdin", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data).toEqual({
      name: "STRIPE_KEY", status: "set", source: ".env", file: ".env", created: false, replaced: false, usedBy: ["stripe_charges"], shadowedByShell: false,
    });
    expect(r.stdout + r.stderr).not.toContain("sk_live_new_value_9");
    const env = join(p.root, ".env");
    expect(readFileSync(env, "utf8")).toBe("# my secrets\nGITHUB_TOKEN=ghp_abcdefghijkl\n\nOTHER='a b'\nSTRIPE_KEY=sk_live_new_value_9\n");
    expect(mode(env)).toBe(0o600);
    const list = await cli(["secrets", "--json"], { cwd: p.root });
    expect(list.json.data.find((s: { name: string }) => s.name === "STRIPE_KEY").status).toBe("set");
  });

  test("an existing value is replaced in place; a new .env is created with mode 0600", async () => {
    const p = makeProject({ files: FILES });
    const env = join(p.root, ".env");
    SECRETS_IO.readStdin = async () => "first";
    const a = await cli(["secrets", "set", "STRIPE_KEY", "--stdin", "--json"], { cwd: p.root });
    expect(a.json.data).toMatchObject({ created: true, replaced: false });
    expect(mode(env)).toBe(0o600);
    writeFileSync(env, "A=1\nSTRIPE_KEY=first # old\nB=2\n");
    SECRETS_IO.readStdin = async () => "second value";
    const b = await cli(["secrets", "set", "STRIPE_KEY", "--stdin", "--json"], { cwd: p.root });
    expect(b.json.data).toMatchObject({ created: false, replaced: true });
    expect(readFileSync(env, "utf8")).toBe("A=1\nSTRIPE_KEY='second value'\nB=2\n");
    expect(mode(env)).toBe(0o600);
  });

  test("the value is read from real stdin (a child process with a pipe)", async () => {
    const p = makeProject({ files: FILES });
    const harness = join(p.root, "harness.ts");
    writeFileSync(harness, `import { main } from ${JSON.stringify(join(SRC, "cli", "main.ts"))};\nprocess.exitCode = await main(process.argv.slice(2));\n`);
    const r = Bun.spawnSync([process.execPath, "--no-env-file", harness, "secrets", "set", "STRIPE_KEY", "--stdin", "--json"], {
      cwd: p.root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: p.root }, stdin: Buffer.from("sk_piped_value_42\n"), stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString();
    expect(JSON.parse(out).data).toMatchObject({ name: "STRIPE_KEY", status: "set", created: true });
    expect(out).not.toContain("sk_piped_value_42");
    expect(parseDotenv(readFileSync(join(p.root, ".env"), "utf8")).values.get("STRIPE_KEY")).toBe("sk_piped_value_42");
    expect(mode(join(p.root, ".env"))).toBe(0o600);
  });

  test("off a TTY without --stdin: REQUIRES_HUMAN, exit 5, .env untouched", async () => {
    const p = makeProject({ files: { ...FILES, ".env": "A=1\n" } });
    SECRETS_IO.readStdin = async () => { throw new Error("must not read stdin"); };
    SECRETS_IO.promptHidden = async () => { throw new Error("must not prompt"); };
    const r = await cli(["secrets", "set", "STRIPE_KEY", "--json"], { cwd: p.root });
    expect(r.exit).toBe(5);
    expect(r.json.ok).toBe(false);
    expect(r.json.problems[0]).toMatchObject({
      code: "REQUIRES_HUMAN", effect: ".env was not changed",
      fix: { kind: "manual", requiresHuman: true },
    });
    expect(r.json.problems[0].hint).toContain("add STRIPE_KEY=... to .env");
    expect(readFileSync(join(p.root, ".env"), "utf8")).toBe("A=1\n");
    const human = await cli(["secrets", "set", "STRIPE_KEY"], { cwd: p.root });
    expect(human.exit).toBe(5);
    expect(human.stderr).toContain("error REQUIRES_HUMAN");
  });

  test("on a TTY it asks with a hidden prompt", async () => {
    const p = makeProject({ files: FILES });
    let asked = "";
    SECRETS_IO.promptHidden = async (label) => {
      asked = label;
      return "typed_secret_77";
    };
    const r = await cli(["secrets", "set", "STRIPE_KEY"], { cwd: p.root, stdinTTY: true });
    expect(r.exit).toBe(0);
    expect(asked).toBe("Value for STRIPE_KEY (typing is hidden): ");
    expect(r.stdout).toBe("STRIPE_KEY added in .env (mode 0600, new file)\nused by stripe_charges\n");
    expect(parseDotenv(readFileSync(join(p.root, ".env"), "utf8")).values.get("STRIPE_KEY")).toBe("typed_secret_77");
  });

  // A real pseudo-terminal (python3's pty module drives it): Bun's raw mode must hide every typed character,
  // including ones typed the instant the prompt appears, and handle backspace, Enter and Ctrl-C.
  const PYTHON = Bun.which("python3");
  const PTY_DRIVER = `import os, pty, select, sys, time
keys = sys.argv[1].encode().decode("unicode_escape").encode("latin-1")
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
out = b""
typed = False
deadline = time.time() + 20
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        out += data
    if not typed and b"hidden): " in out:
        os.write(fd, keys)
        typed = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(str(os.waitstatus_to_exitcode(status)) + "\\n" + out.decode("utf-8", "replace"))
`;
  function onTerminal(root: string, keys: string): { exit: number; output: string } {
    const driver = join(root, "pty_driver.py");
    const harness = join(root, "harness.ts");
    writeFileSync(driver, PTY_DRIVER);
    writeFileSync(harness, `import { main } from ${JSON.stringify(join(SRC, "cli", "main.ts"))};\nprocess.exitCode = await main(process.argv.slice(2));\n`);
    const r = Bun.spawnSync([PYTHON!, driver, keys, process.execPath, "--no-env-file", harness, "secrets", "set", "STRIPE_KEY"], {
      cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, ...rest] = r.stdout.toString().split("\n");
    return { exit: Number(code), output: rest.join("\n") };
  }

  test.skipIf(!PYTHON)("on a real terminal the hidden prompt echoes nothing; backspace edits; Ctrl-C changes nothing", () => {
    const p = makeProject({ files: FILES });
    const typed = onTerminal(p.root, "sk_typed_secret_9x\\x7f\\r");
    expect(typed.exit).toBe(0);
    expect(typed.output).toContain("Value for STRIPE_KEY (typing is hidden): ");
    expect(typed.output).not.toContain("sk_typed");
    expect(typed.output).toContain("STRIPE_KEY added in .env");
    expect(parseDotenv(readFileSync(join(p.root, ".env"), "utf8")).values.get("STRIPE_KEY")).toBe("sk_typed_secret_9");
    const stopped = onTerminal(p.root, "abc\\x03");
    expect(stopped.exit).toBe(130);
    expect(stopped.output).toContain("INTERRUPTED");
    expect(parseDotenv(readFileSync(join(p.root, ".env"), "utf8")).values.get("STRIPE_KEY")).toBe("sk_typed_secret_9");
  });

  test("a shell variable of the same name is pointed out", async () => {
    const p = makeProject({ files: FILES });
    SECRETS_IO.readStdin = async () => "v1_abcdef";
    const r = await cli(["secrets", "set", "STRIPE_KEY", "--stdin"], { cwd: p.root, env: { STRIPE_KEY: "shell" } });
    expect(r.stdout).toContain("the shell value wins over .env");
  });

  test("usage errors: empty value, bad name, extra words, unknown subcommand, --stdin without set", async () => {
    const p = makeProject({ files: FILES });
    SECRETS_IO.readStdin = async () => "\n";
    const empty = await cli(["secrets", "set", "STRIPE_KEY", "--stdin", "--json"], { cwd: p.root });
    expect(empty.exit).toBe(2);
    expect(empty.json.problems[0].code).toBe("USAGE_ERROR");
    expect(existsSync(join(p.root, ".env"))).toBe(false);
    for (const argv of [["secrets", "set", "bad-name"], ["secrets", "set"], ["secrets", "sett", "X"], ["secrets", "--stdin"]]) {
      const r = await cli([...argv, "--json"], { cwd: p.root });
      expect(r.exit).toBe(2);
      expect(r.json.problems[0].code).toBe("USAGE_ERROR");
    }
  });
});

describe(".env editing", () => {
  test("quoteEnvValue round-trips through parseDotenv", () => {
    const values = [
      "plain", "sk_live_123", "with space", "a#b", "a #b", "it's", `say "hi"`, "back\\slash", "ends\\", "'quoted'", '"dq"',
      "multi\nline", "tab\there", "cr\rhere", "$HOME", "`tick`", "=eq", " lead", "trail ", "ünï©ødé", "x".repeat(300), "#start",
      "a\\'b", "\\", "'", '"', "\\n literal",
    ];
    for (const v of values) {
      const text = `${"K"}=${quoteEnvValue(v)}\n`;
      expect(parseDotenv(text).values.get("K")).toBe(v);
      const edited = upsertDotenv("A=1\nK=old\nB=2\n", "K", v).text;
      const parsed = parseDotenv(edited).values;
      expect(parsed.get("K")).toBe(v);
      expect(parsed.get("A")).toBe("1");
      expect(parsed.get("B")).toBe("2");
    }
  });

  test("upsert: first assignment rewritten, duplicates dropped, export kept, other keys' multi-line values untouched", () => {
    const text = `export K=one\nNOTE="line1\nK=not a key\nline3"\nK=two\n# K=comment\n`;
    const { text: out, replaced } = upsertDotenv(text, "K", "new");
    expect(replaced).toBe(true);
    expect(out).toBe(`export K=new\nNOTE="line1\nK=not a key\nline3"\n# K=comment\n`);
    expect(parseDotenv(out).values.get("NOTE")).toBe("line1\nK=not a key\nline3");
  });

  test("upsert keeps CRLF line ends and a byte-order mark; appends a newline when the file lacks one", () => {
    expect(upsertDotenv("﻿A=1\r\nK=x\r\n", "K", "y").text).toBe("﻿A=1\r\nK=y\r\n");
    expect(upsertDotenv("A=1", "K", "y").text).toBe("A=1\nK=y\n");
    expect(upsertDotenv("", "K", "y").text).toBe("K=y\n");
    expect(upsertDotenv("K='multi\nline'\nB=2\n", "K", "z").text).toBe("K=z\nB=2\n");
  });

  test("writeSecret follows a symlinked .env and leaves no temp file behind", () => {
    const p = makeProject({ files: { "real.env": "A=1\n" } });
    symlinkSync(join(p.root, "real.env"), join(p.root, ".env"));
    writeSecret(join(p.root, ".env"), "K", "v");
    expect(readFileSync(join(p.root, "real.env"), "utf8")).toBe("A=1\nK=v\n");
    expect(mode(join(p.root, "real.env"))).toBe(0o600);
    expect(require("node:fs").readdirSync(p.root).filter((f: string) => f.includes(".tmp"))).toEqual([]);
  });
});
