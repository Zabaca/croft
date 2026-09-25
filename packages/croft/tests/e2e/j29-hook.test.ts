// Journey 29: the opt-in Claude Code hook (DESIGN.md §9 item 7, D27), through the real CLI and the real shell.
//   a. `croft init --claude --with-hook` merges the PostToolUse hook into a .claude/settings.json the user already
//      has (their permissions, model, other hooks and indentation stay); a second run changes nothing, and init
//      without --with-hook never touches the file. A new project, and an app's data/ project, get it too; until
//      data/ is installed, the app's hook does nothing (exit 0, silent), for app files and data/ assets alike.
//   b. The hook command from settings.json runs exactly as Claude Code runs it (`sh -c`, CLAUDE_PROJECT_DIR set,
//      the PostToolUse JSON on stdin), with node_modules/.bin/croft as `bun install` links it:
//      - an asset edit with an error: exit 2, stdout empty, stderr names the file, the code and the fix;
//      - an SQL edit that breaks the asset reading it: exit 2, and stderr says the reader was checked too;
//      - a TS asset that does not compile, and a second file for one asset name: exit 2; a path through a symlink
//        (macOS's /var) is the same file;
//      - a clean edit: exit 0, nothing printed;
//      - an edit whose only findings are warnings (a secret not set yet; a full-refresh transform that pays for
//        every row on every rebuild): exit 0, stderr empty, one line of PostToolUse JSON on stdout whose
//        hookSpecificOutput.additionalContext carries them to Claude without blocking it;
//      - a file outside assets/ (README, a CSV, croft.json, a script, a file outside the project), even while an
//        asset is broken: exit 0, nothing printed;
//      - a lib/ edit that breaks the asset importing it: exit 2 naming that asset; fixed: exit 0, silent;
//      - --json: the same finding as an envelope that matches schemas/validate.schema.json.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { golden } from "../golden/kit.ts";
import {
  type CliResult, cleanupAll, croftIn, hookShell, initProject, linkCroftBin, PKG, postToolUse, Project, show, tempDir,
} from "./harness.ts";

afterAll(cleanupAll);

const HOOK_COMMAND = 'cd "$CLAUDE_PROJECT_DIR" && test -x ./node_modules/.bin/croft || exit 0; ./node_modules/.bin/croft validate --hook';
const CROFT_GROUP = { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 120 }] };

/** A user's own settings, written with four-space indentation. */
const USER_SETTINGS = {
  model: "opus",
  permissions: { allow: ["Bash(croft status:*)", "Bash(croft validate:*)"], deny: ["Read(./.env)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo checked" }] }],
    PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo formatted" }] }],
  },
};

describe("a. croft init --with-hook writes the hook into .claude/settings.json", () => {
  test("merged into the user's settings, which stay as they were; a second run changes nothing", async () => {
    const { project: p } = await initProject("merged");
    p.write(".claude/settings.json", `${JSON.stringify(USER_SETTINGS, null, 4)}\n`);

    // Without --with-hook, init never writes the settings.
    const plain = golden("init", await p.croft(["init", "--claude", "--json"]));
    expect(plain.data.files.map((f: { path: string }) => f.path)).not.toContain(".claude/settings.json");
    expect(JSON.parse(p.read(".claude/settings.json"))).toEqual(USER_SETTINGS);

    const r = await p.croft(["init", "--claude", "--with-hook", "--json"]);
    const env = golden("init", r);
    expect(env.data.files).toContainEqual(expect.objectContaining({ path: ".claude/settings.json", action: "merged" }));
    const text = p.read(".claude/settings.json");
    const settings = JSON.parse(text);
    expect(settings).toEqual({
      ...USER_SETTINGS,
      hooks: { ...USER_SETTINGS.hooks, PostToolUse: [...USER_SETTINGS.hooks.PostToolUse, CROFT_GROUP] },
    });
    expect(text.split("\n")[1]).toStartWith('    "model"');

    // Again: unchanged, byte for byte, and the hook is not doubled.
    const again = golden("init", await p.croft(["init", "--claude", "--with-hook", "--json"]));
    expect(again.data.files).toContainEqual(expect.objectContaining({ path: ".claude/settings.json", action: "unchanged" }));
    expect(p.read(".claude/settings.json")).toBe(text);

    // For people, init says what the hook does.
    const human = await p.croft(["init", "--claude", "--with-hook"]);
    expect(human.code, show(human)).toBe(0);
    expect(human.stdout).toContain("croft validate --hook");
    expect(p.read(".claude/settings.json")).toBe(text);

    // Without --claude in an existing project, init refuses, and its fix keeps the hook flag.
    const refused = golden("init", await p.croft(["init", "--with-hook", "--json"]), { failed: true, exit: 2 });
    expect(refused.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { command: "croft init --claude --with-hook" } });
  }, 120_000);

  test("a new project, and an app's data/ project (the app's settings cd into data/)", async () => {
    const base = tempDir();
    const fresh = golden("init", await croftIn(base, ["init", join(base, "fresh"), "--no-install", "--with-hook", "--json"]));
    expect(fresh.data.files).toContainEqual(expect.objectContaining({ action: "created", path: expect.stringMatching(/(^|\/)\.claude\/settings\.json$/) }));
    expect(JSON.parse(readFileSync(join(base, "fresh", ".claude", "settings.json"), "utf8"))).toEqual({ hooks: { PostToolUse: [CROFT_GROUP] } });

    const app = join(base, "shop");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "shop", private: true }));
    const made = golden("init", await croftIn(app, ["init", "--no-install", "--with-hook", "--json"]));
    expect(made.data.mode).toBe("app");
    const appSettings = JSON.parse(readFileSync(join(app, ".claude", "settings.json"), "utf8"));
    const dataSettings = JSON.parse(readFileSync(join(app, "data", ".claude", "settings.json"), "utf8"));
    expect(dataSettings).toEqual({ hooks: { PostToolUse: [CROFT_GROUP] } });
    const appCommand = appSettings.hooks.PostToolUse[0].hooks[0].command as string;
    expect(appCommand).toBe('cd "$CLAUDE_PROJECT_DIR"/data && test -x ./node_modules/.bin/croft || exit 0; ./node_modules/.bin/croft validate --hook');

    // Until data/ is installed, the app's hook does nothing: no "hook error" after every edit of the app.
    const data = new Project(join(app, "data"));
    data.write("assets/broken.sql", "-- key: id\nSELECT id FROM no_such_asset\n");
    writeFileSync(join(app, "page.ts"), "export const x = 1;\n");
    for (const file of [join(app, "page.ts"), join(data.root, "assets/broken.sql")]) {
      const before = await hookShell(app, appCommand, { env: { CLAUDE_PROJECT_DIR: app }, stdin: postToolUse({ tool: "Edit", file, cwd: app }) });
      expect({ code: before.code, stdout: before.stdout, stderr: before.stderr }, show(before)).toEqual({ code: 0, stdout: "", stderr: "" });
    }

    // The app's hook, run from the app folder (where Claude Code started), checks the data/ project's assets.
    mkdirSync(join(data.root, "node_modules", "@zabaca"), { recursive: true });
    symlinkSync(PKG, join(data.root, "node_modules", "@zabaca", "croft"));
    linkCroftBin(data);
    const r = await hookShell(app, appCommand, { env: { CLAUDE_PROJECT_DIR: app }, stdin: postToolUse({ tool: "Write", file: join(data.root, "assets/broken.sql"), cwd: app }) });
    expect(r.code, show(r)).toBe(2);
    expect(r.stderr).toContain("assets/broken.sql");
    expect(r.stdout).toBe("");
  }, 120_000);
});

describe("b. the hook, run as Claude Code runs it", () => {
  let p: Project;
  let command: string;
  beforeAll(async () => {
    p = (await initProject("hooked")).project;
    linkCroftBin(p);
    golden("init", await p.croft(["init", "--claude", "--with-hook", "--json"]));
    command = JSON.parse(p.read(".claude/settings.json")).hooks.PostToolUse[0].hooks[0].command;
    // The bind check binds SQL against the columns of built tables.
    golden("run", await p.croft(["run", "example_sales", "--json"]));
  }, 120_000);

  /** The hook after `tool` wrote `rel` (a path in the project, or absolute), with Claude in `cwd`. */
  const hook = (rel: string, o: { tool?: "Edit" | "Write" | "MultiEdit"; cwd?: string } = {}): Promise<CliResult> => {
    const file = rel.startsWith("/") ? rel : join(p.root, rel);
    const cwd = o.cwd ?? p.root;
    return hookShell(cwd, command, { env: { CLAUDE_PROJECT_DIR: p.root }, stdin: postToolUse({ tool: o.tool ?? "Edit", file, cwd }) });
  };
  const silent = (r: CliResult) => {
    expect(r.code, show(r)).toBe(0);
    expect(r.stdout, show(r)).toBe("");
    expect(r.stderr, show(r)).toBe("");
  };

  const BIG_ORDERS = (column: string) => `-- description: orders over 100
-- key: order_id
SELECT order_id, region, ${column} FROM example_sales WHERE amount > 100
`;

  test("an asset edit with an error: exit 2, stderr names the file, the problem and its fix; stdout stays empty", async () => {
    p.write("assets/big_orders.sql", BIG_ORDERS("amont"));
    const r = await hook("assets/big_orders.sql", { tool: "Write" });
    expect(r.code, show(r)).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toStartWith("croft validate --hook: 1 error after the edit to assets/big_orders.sql");
    expect(r.stderr).toContain("UNKNOWN_COLUMN");
    expect(r.stderr).toContain("assets/big_orders.sql:3");
    expect(r.stderr).toContain("amount");

    // The same finding as a --json envelope (what an agent would parse), against schemas/validate.schema.json.
    const j = await p.croft(["validate", "--hook", "--json"], { stdin: postToolUse({ tool: "Write", file: join(p.root, "assets/big_orders.sql"), cwd: p.root }) });
    const env = golden("validate", j, { exit: 2 });
    expect(env.problems.map((x: { code: string }) => x.code)).toEqual(["UNKNOWN_COLUMN"]);
    expect(env.problems[0]).toMatchObject({ asset: "big_orders", file: "assets/big_orders.sql", line: 3 });
  }, 60_000);

  test("a file outside assets/ checks nothing, even while an asset is broken, and neither does a clean edit of another asset: exit 0, silent", async () => {
    p.write("README.md", "# notes\n");
    p.write("scripts/broken.ts", "export const x: number = ;\n");
    const outside = join(tempDir(), "elsewhere.ts");
    writeFileSync(outside, "export const y = ;\n");
    silent(await hook("README.md", { tool: "Write" }));
    silent(await hook("files/example_sales.csv"));
    silent(await hook("croft.json"));
    silent(await hook("scripts/broken.ts", { tool: "Write" }));
    silent(await hook(".claude/settings.json"));
    silent(await hook(outside, { tool: "Write" }));
    // Another asset, clean, while big_orders is broken: the hook checks the edit, not the whole project.
    silent(await hook("assets/example_sales.ts"));
  }, 60_000);

  test("the fix: exit 0, silent; Claude's current folder does not matter", async () => {
    p.write("assets/big_orders.sql", BIG_ORDERS("amount"));
    silent(await hook("assets/big_orders.sql", { cwd: join(p.root, "assets") }));
    silent(await hook("assets/big_orders.sql", { tool: "MultiEdit" }));
  }, 60_000);

  test("an SQL edit that breaks the asset reading it: exit 2, and the reader is named", async () => {
    p.write("assets/big_regions.sql", "-- key: region\nSELECT region, count(*) AS orders FROM big_orders GROUP BY region\n");
    silent(await hook("assets/big_regions.sql", { tool: "Write" }));
    // region is dropped upstream: big_orders itself is fine, big_regions no longer binds.
    p.write("assets/big_orders.sql", "-- key: order_id\nSELECT order_id, amount FROM example_sales WHERE amount > 100\n");
    const r = await hook("assets/big_orders.sql");
    expect(r.code, show(r)).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("also checked the assets that read it: big_regions");
    expect(r.stderr).toContain("assets/big_regions.sql");
    expect(r.stderr).toContain("UNKNOWN_COLUMN");
    p.write("assets/big_orders.sql", BIG_ORDERS("amount"));
    silent(await hook("assets/big_orders.sql"));
  }, 60_000);

  test("a TS asset that does not compile, a second file for one asset name, a path through a symlink", async () => {
    p.write("assets/broken.ts", 'import { ingest } from "@zabaca/croft";\nexport default ingest({ key: "id", async *rows() { yield [{ id: 1 }]; } ;\n');
    const broken = await hook("assets/broken.ts", { tool: "Write" });
    expect(broken.code, show(broken)).toBe(2);
    expect(broken.stderr).toContain("ASSET_INVALID");
    expect(broken.stderr).toContain("assets/broken.ts:2");
    p.remove("assets/broken.ts");

    p.write("assets/big_orders.ts", 'import { ingest } from "@zabaca/croft";\nexport default ingest({ key: "id", async *rows() { yield [{ id: 1 }]; } });\n');
    const twin = await hook("assets/big_orders.ts", { tool: "Write" });
    expect(twin.code, show(twin)).toBe(2);
    expect(twin.stderr).toContain("NAME_CONFLICT");
    expect(twin.stderr).toContain("assets/big_orders.sql and assets/big_orders.ts");
    p.remove("assets/big_orders.ts");
    silent(await hook("assets/big_orders.sql"));

    // macOS: the temp folder is /var/folders/…, a symlink to /private/var/folders/…; Claude Code may name either.
    if (p.root.startsWith("/private/var/")) {
      const viaVar = p.root.slice("/private".length);
      const r = await hookShell(viaVar, command, { env: { CLAUDE_PROJECT_DIR: viaVar }, stdin: postToolUse({ tool: "Edit", file: join(viaVar, "assets/big_orders.sql"), cwd: viaVar }) });
      silent(r);
      p.write("assets/big_orders.sql", BIG_ORDERS("amont"));
      const bad = await hookShell(viaVar, command, { env: { CLAUDE_PROJECT_DIR: viaVar }, stdin: postToolUse({ tool: "Edit", file: join(viaVar, "assets/big_orders.sql"), cwd: viaVar }) });
      expect(bad.code, show(bad)).toBe(2);
      expect(bad.stderr).toContain("UNKNOWN_COLUMN");
      p.write("assets/big_orders.sql", BIG_ORDERS("amount"));
    }
  }, 60_000);

  /** The context a warnings-only edit hands Claude: exit 0, stderr empty, one line of PostToolUse JSON on stdout. */
  const context = (r: CliResult): string => {
    expect(r.code, show(r)).toBe(0);
    expect(r.stderr, show(r)).toBe("");
    expect(r.stdout.trimEnd().split("\n"), show(r)).toHaveLength(1);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    return out.hookSpecificOutput.additionalContext as string;
  };

  test("an edit whose only finding is a warning (a secret not set yet): exit 0, the warning reaches Claude as context", async () => {
    p.write("assets/partners.ts", `import { ingest } from "@zabaca/croft";

export default ingest({
  secrets: ["PARTNER_KEY"],
  key: "id",
  async *rows({ secret }) {
    yield [{ id: 1, key_length: secret("PARTNER_KEY").length }];
  },
});
`);
    const text = context(await hook("assets/partners.ts", { tool: "Write" }));
    expect(text).toStartWith("croft validate --hook: 1 warning after the edit to assets/partners.ts\n");
    expect(text).toContain("SECRET_MISSING");
    expect(text).toContain("PARTNER_KEY");
    const v = golden("validate", await p.croft(["validate", "partners", "--json"]));
    expect(v.problems.map((x: { code: string }) => x.code)).toEqual(["SECRET_MISSING"]);
    p.remove("assets/partners.ts");
  }, 60_000);

  test("a full-refresh transform that makes requests (pays for every row on every rebuild): TRANSFORM_MAKES_REQUESTS reaches Claude", async () => {
    p.write(".env", "API_TOKEN=tok-abc-123456\n");
    p.write("assets/paid_full.ts", `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["example_sales"], key: "order_id", secrets: ["API_TOKEN"],
  async *rows({ rows, http, secret }) {
    for await (const r of rows("example_sales")) {
      const res = await http.post("https://api.example.com/v1/classify", { text: String(r.product) }, { headers: { Authorization: \`Bearer \${secret("API_TOKEN")}\` } });
      yield { order_id: r.order_id, label: res.json<{ label: string }>().label };
    }
  },
});
`);
    const text = context(await hook("assets/paid_full.ts", { tool: "Write" }));
    expect(text).toStartWith("croft validate --hook: 1 warning after the edit to assets/paid_full.ts\n");
    expect(text).toContain("TRANSFORM_MAKES_REQUESTS  assets/paid_full.ts:");
    expect(text).toContain("every rebuild pays for every row again");
    expect(text).not.toContain("tok-abc-123456");
    p.remove("assets/paid_full.ts");
  }, 60_000);

  test("a lib/ edit: exit 2 naming the asset that imports it while it is broken; exit 0, silent, once fixed", async () => {
    p.write("lib/money.ts", "export const cents = (x: number): number => Math.round(x * 100);\n");
    p.write("assets/order_cents.ts", `import { ingest } from "@zabaca/croft";
import { cents } from "../lib/money.ts";

export default ingest({
  key: "id",
  async *rows() {
    yield [{ id: 1, cents: cents(1.5) }];
  },
});
`);
    silent(await hook("assets/order_cents.ts", { tool: "Write" }));
    silent(await hook("lib/money.ts", { tool: "Write" }));

    p.write("lib/money.ts", "export const cents = (x: number): number => Math.round(x * 100;\n");
    const broken = await hook("lib/money.ts");
    expect(broken.code, show(broken)).toBe(2);
    expect(broken.stdout).toBe("");
    expect(broken.stderr).toContain("after the edit to lib/money.ts");
    expect(broken.stderr).toContain("order_cents");

    p.write("lib/money.ts", "export const cents = (x: number): number => Math.round(x * 100);\n");
    silent(await hook("lib/money.ts"));
    // A lib file nothing imports checks nothing.
    p.write("lib/unused.ts", "export const nothing = ;\n");
    silent(await hook("lib/unused.ts", { tool: "Write" }));
  }, 60_000);
});
