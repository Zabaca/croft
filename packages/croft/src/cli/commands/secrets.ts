// croft secrets [set NAME [--stdin]] (DESIGN.md §4.1, §4.2, §9.8 "Secrets", "Secrets without a TTY").
//
// `croft secrets` lists every secret the assets declare (their `secrets` lists, read by importing each asset
// as validate does), whether it is set, where the value comes from (.env, or the shell environment, which
// wins), and which assets use it. It never prints a value: an agent confirms a secret exists without reading
// it. `--json` data is [{name, status: "set"|"missing", source: ".env"|"env"|null, usedBy}].
//
// `croft secrets set NAME` writes NAME to <project>/.env with mode 0600, keeping every other line (comments,
// order, other keys) as it was. The value comes from a hidden prompt on a TTY, or from stdin with --stdin
// (for piping from a password manager). Off a TTY without --stdin it stops with REQUIRES_HUMAN (exit 5):
// inside Claude Code the user usually has no terminal, so the answer is "add NAME=… to .env in your editor".
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CroftError, problem } from "../../core/errors.ts";
import type { Problem } from "../../core/types.ts";
import { parseDotenv, type SecretStatus } from "../../project/env.ts";
import { discoverAssets } from "../../project/discover.ts";
import type { CommandImpl, Ctx } from "../command.ts";
import { table } from "../render.ts";
import { loadConfigs, secretsByAsset } from "./describe.ts";

export interface SecretSetData {
  name: string;
  status: "set";
  source: ".env";
  file: string;
  created: boolean;                  // .env did not exist before
  replaced: boolean;                 // NAME had a line in .env before
  usedBy: string[];
  /** A non-empty shell variable of the same name wins over .env (ProjectEnv.lookup). */
  shadowedByShell: boolean;
}

export type SecretsData = SecretStatus[] | SecretSetData;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------------------------------------
// .env editing

/** A value written so parseDotenv reads it back exactly: bare when it is plain, in single quotes when that
 *  needs no escapes, and otherwise in double quotes with \\ \" \n \r \t escapes. */
export function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  // A single-quoted body is literal, but parseDotenv's closing-quote scan skips the character after a
  // backslash, so a value ending in "\" (or holding "'") needs double quotes; so does a carriage return, which
  // parseDotenv reads as a line end anywhere in the file.
  if (!value.includes("'") && !value.endsWith("\\") && !value.includes("\r")) return `'${value}'`;
  const escaped = value.replace(/[\\"\n\r\t]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c]!);
  return `"${escaped}"`;
}

interface Entry { key: string; start: number; end: number; prefix: string }

/** The assignments of a .env text with their extents, found exactly as parseDotenv walks the file (quoted
 *  values may span lines), so a line inside another key's multi-line value is never mistaken for a key. */
function entries(src: string): Entry[] {
  const out: Entry[] = [];
  const restOfLine = (from: number) => {
    const e = src.indexOf("\n", from);
    return e === -1 ? src.length : e;
  };
  let i = 0;
  while (i < src.length) {
    const eol = restOfLine(i);
    const raw = src.slice(i, eol);
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) { i = eol + 1; continue; }
    const m = /^(\s*(?:export\s+)?)([^=\s]+)\s*=[ \t]*/.exec(raw);
    if (!m) { i = eol + 1; continue; }
    const valueStart = i + m[0].length;
    const quote = src[valueStart];
    let end = eol;
    if (quote === '"' || quote === "'" || quote === "`") {
      let close = -1;
      for (let j = valueStart + 1; j < src.length; j++) {
        if (src[j] === "\\" && j + 1 < src.length) { j++; continue; }
        if (src[j] === quote) { close = j; break; }
      }
      if (close !== -1 && /^\s*(?:#.*)?$/.test(src.slice(close + 1, restOfLine(close + 1)))) end = restOfLine(close + 1);
    }
    out.push({ key: m[2]!, start: i, end, prefix: m[1]!.replace(/^\s+/, "") });
    i = end + 1;
  }
  return out;
}

/** .env text with NAME set to `value`: its first assignment rewritten in place, later duplicates removed, or a
 *  new line appended. Every other line is kept byte for byte. */
export function upsertDotenv(text: string, name: string, value: string): { text: string; replaced: boolean } {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  let src = bom ? text.slice(1) : text;
  const crlf = src.includes("\r\n");
  if (crlf) src = src.replace(/\r\n/g, "\n");
  const line = `${name}=${quoteEnvValue(value)}`;
  const mine = entries(src).filter((e) => e.key === name);
  let out: string;
  if (mine.length === 0) {
    out = src === "" ? `${line}\n` : `${src}${src.endsWith("\n") ? "" : "\n"}${line}\n`;
  } else {
    out = src;
    // Work from the end so earlier offsets stay valid; the first entry is rewritten, the others removed.
    for (const e of [...mine].reverse()) {
      if (e === mine[0]) out = out.slice(0, e.start) + e.prefix + line + out.slice(e.end);
      else out = out.slice(0, e.start) + out.slice(e.end < out.length ? e.end + 1 : e.end);
    }
  }
  if (crlf) out = out.replace(/\n/g, "\r\n");
  return { text: bom + out, replaced: mine.length > 0 };
}

/** Write .env with mode 0600, atomically (a temp file renamed over it). A symlinked .env is written where it
 *  points. The result is parsed back first: the value must read back exactly, or nothing is written. */
export function writeSecret(envFile: string, name: string, value: string): { created: boolean; replaced: boolean } {
  let target = envFile;
  try {
    if (lstatSync(envFile).isSymbolicLink()) target = realpathSync(envFile);
  } catch {}
  const created = !existsSync(target);
  const before = created ? "" : readFileSync(target, "utf8");
  const { text, replaced } = upsertDotenv(before, name, value);
  if (parseDotenv(text).values.get(name) !== value) {
    throw new CroftError("INTERNAL_ERROR", {
      message: `croft could not write ${name} so that it reads back unchanged; .env was not modified`,
      hint: `add ${name}=... to .env in your editor, and report this croft bug`,
    });
  }
  const tmp = join(dirname(target), `.croft-env-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  chmodSync(target, 0o600);
  return { created, replaced };
}

// ---------------------------------------------------------------------------------------------------------
// Reading the value

/** How `secrets set` gets a value; tests replace these. */
export const SECRETS_IO = {
  /** All of stdin, as text. */
  readStdin: async (): Promise<string> => await Bun.stdin.text(),
  /** A hidden prompt on the terminal: nothing typed is echoed. */
  promptHidden: (label: string): Promise<string> => promptHidden(label),
};

function promptHidden(label: string): Promise<string> {
  const stdin = process.stdin;
  // Echo goes off before the prompt appears, so nothing typed right after it is shown.
  stdin.setRawMode?.(true);
  process.stderr.write(label);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (err?: Error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") {
          return finish(new CroftError("INTERRUPTED", { message: "stopped at the prompt; .env was not changed", hint: "run the command again" }));
        }
        if (ch === "\u007f" || ch === "\b") value = Array.from(value).slice(0, -1).join("");
        else value += ch;
      }
    };
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

function requiresHuman(name: string): CroftError {
  return new CroftError("REQUIRES_HUMAN", {
    message: `croft secrets set ${name} needs a person at a terminal (a hidden prompt), or the value on stdin with --stdin`,
    hint: `ask the user to add ${name}=... to .env in their editor, or to run \`croft secrets set ${name}\` in their own terminal`,
    fix: { kind: "manual", description: `ask the user to add ${name}=... to .env (or run croft secrets set ${name} in their terminal)`, requiresHuman: true },
    effect: ".env was not changed",
    details: { name },
  });
}

async function readValue(ctx: Ctx, name: string): Promise<string> {
  let value: string;
  if (ctx.values.stdin === true) {
    value = await SECRETS_IO.readStdin();
    value = value.replace(/\r?\n$/, "");       // the newline `echo` or a password manager adds
  } else if (ctx.isTTY.stdin) {
    value = await SECRETS_IO.promptHidden(`Value for ${name} (typing is hidden): `);
  } else {
    throw requiresHuman(name);
  }
  if (value === "") {
    throw new CroftError("USAGE_ERROR", {
      message: `no value for ${name}${ctx.values.stdin === true ? " on stdin" : ""}; .env was not changed`,
      hint: ctx.values.stdin === true ? `pipe the value in: <password manager command> | croft secrets set ${name} --stdin` : "type the value, then Enter",
    });
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------
// The command

function envProblems(ctx: Ctx): Problem[] {
  const env = ctx.env;
  return [
    ...env.problems(),
    ...env.issues.map((i) => problem("ENV_FILE_INVALID", {
      message: `.env: ${i.message}`, hint: "fix that line of .env (KEY=value)", file: ".env", line: i.line,
    })),
  ];
}

export const secrets: CommandImpl<SecretsData> = {
  async run(ctx) {
    const [sub, name, ...extra] = ctx.positionals;
    if (sub !== undefined && sub !== "set") {
      throw new CroftError("USAGE_ERROR", {
        message: `croft secrets has no subcommand ${JSON.stringify(sub)}`,
        hint: "croft secrets lists the secrets; croft secrets set NAME sets one",
        fix: { kind: "command", description: "list the secrets", command: "croft secrets" },
      });
    }
    if (sub === undefined && ctx.values.stdin === true) {
      throw new CroftError("USAGE_ERROR", { message: "--stdin goes with croft secrets set NAME", hint: "croft secrets set NAME --stdin" });
    }
    const project = ctx.project;
    const discovery = await discoverAssets(project.root, { assetsDir: project.paths.assetsDir });
    const configs = await loadConfigs(project, discovery.assets, { importTimeoutMs: 5000 });
    const declared = secretsByAsset(configs);

    if (sub === undefined) {
      const list = ctx.env.listSecrets(declared);
      return { data: list, problems: envProblems(ctx), next: [] };
    }

    if (name === undefined || extra.length > 0 || !NAME.test(name)) {
      throw new CroftError("USAGE_ERROR", {
        message: name === undefined ? "croft secrets set needs a secret name"
          : extra.length ? `croft secrets set takes one name; got ${[name, ...extra].join(" ")}`
          : `${JSON.stringify(name)} is not a secret name: use letters, digits and _, starting with a letter or _`,
        hint: "usage: croft secrets set NAME [--stdin]",
        fix: { kind: "manual", description: "run croft secrets set NAME, e.g. croft secrets set STRIPE_KEY" },
      });
    }
    const value = await readValue(ctx, name);
    const { created, replaced } = writeSecret(project.paths.envFile, name, value);
    const usedBy = Object.entries(declared).filter(([, names]) => names.includes(name)).map(([a]) => a).sort();
    const shell = ctx.processEnv[name];
    const data: SecretSetData = {
      name, status: "set", source: ".env", file: ".env", created, replaced, usedBy, shadowedByShell: shell !== undefined && shell !== "",
    };
    return { data, problems: [], next: [] };
  },
  human(result) {
    const d = result.data;
    if (!Array.isArray(d)) {
      const notes: string[] = [];
      notes.push(`${d.name} ${d.replaced ? "updated" : "added"} in .env (mode 0600${d.created ? ", new file" : ""})`);
      notes.push(d.usedBy.length ? `used by ${d.usedBy.join(", ")}` : "no asset declares it yet (add it to an asset's secrets)");
      if (d.shadowedByShell) notes.push(`note: ${d.name} is also set in your shell, and the shell value wins over .env`);
      return notes.join("\n");
    }
    if (d.length === 0) return "No asset declares a secret. Declare one with secrets: [\"NAME\"] in the asset.";
    const rows = d.map((s) => [
      s.name,
      s.status === "set" ? `set (${s.source === "env" ? "environment" : ".env"})` : "missing",
      `used by ${s.usedBy.join(", ")}${s.status === "missing" ? ` → add ${s.name}=... to .env` : ""}`,
    ]);
    return table(["NAME", "STATUS", "USED BY"], rows, { limit: Infinity, maxWidth: 200 }).text.split("\n").slice(1).join("\n");
  },
};
