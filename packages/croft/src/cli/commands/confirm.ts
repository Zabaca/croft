// croft confirm <token> (DESIGN.md §4.2, §6 "How confirmation works"). Off a TTY a destructive command stops
// with exit 5 and a token instead of acting; the action then runs only through this command, which every
// Claude Code permission rule can gate with one prefix ("ask": ["Bash(croft confirm:*)"]).
//
// confirm looks the token up (safety/confirm.ts) and runs the stored command again, in this process, through
// the CLI dispatcher (main.ts), with a hidden `--confirm-token <token>` added. The command itself revalidates:
// it recomputes the impact and calls Confirmations.consume(), which spends the token and throws
// CONFIRMATION_STALE (with the new impact) when the token expired, was used, or the impact changed, e.g.
// because the scheduler added rows meanwhile. confirm never decides that on its own, so the check always runs
// against what the command is about to do.
//
// The command's output is the output: its human text passes straight through, and under --json its envelope's
// data becomes data.result (problems, next, confirmation and the exit code carry over).
import { CroftError } from "../../core/errors.ts";
import type { Confirmation, Envelope, Problem } from "../../core/types.ts";
import { Confirmations } from "../../safety/confirm.ts";
import type { CommandImpl, Ctx } from "../command.ts";
import { main, scanArgv } from "../main.ts";
import { openRunsDb } from "./status.ts";

/** The hidden option every destructive command declares so croft confirm can hand it the token. */
export const CONFIRM_TOKEN_OPTION = "confirm-token";

export interface ConfirmData {
  token: string;
  command: string;
  /** The confirmed command's data (--json); null in human mode, where its output was printed as is. */
  result: unknown;
}

/** Split a stored command line into words, as a POSIX shell would for the quoting croft writes: single
 *  quotes (literal), double quotes (\\ \" \$ \` escapes) and backslash escapes outside quotes. */
export function splitCommand(text: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw unterminated(text);
      cur += text.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length && /["\\$`\n]/.test(text[j + 1]!)) {
          j++;
          if (text[j] !== "\n") cur += text[j];
        } else cur += text[j];
      }
      if (j >= text.length) throw unterminated(text);
      i = j;
      inWord = true;
    } else if (c === "\\" && i + 1 < text.length) {
      i++;
      if (text[i] !== "\n") cur += text[i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

function unterminated(text: string): CroftError {
  return new CroftError("INTERNAL_ERROR", { message: `the stored command has an unterminated quote: ${text}`, hint: "report this croft bug" });
}

function notFound(token: string): CroftError {
  return new CroftError("USAGE_ERROR", {
    message: `no confirmation ${JSON.stringify(token)} exists in this project`,
    hint: "run the destructive command again to get a token; tokens look like c_7f3a9e",
  });
}

/** The stored command as argv for main(): without "croft", --json or an old token; with this token. */
export function confirmArgv(stored: string, token: string, json: boolean): string[] {
  const words = splitCommand(stored);
  if (words[0] !== "croft") {
    throw new CroftError("INTERNAL_ERROR", { message: `the stored command is not a croft command: ${stored}`, hint: "report this croft bug" });
  }
  const out: string[] = [];
  const rest = words.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") { out.push(...rest.slice(i)); break; }
    if (a === "--json") continue;
    if (a === `--${CONFIRM_TOKEN_OPTION}`) { i++; continue; }
    if (a.startsWith(`--${CONFIRM_TOKEN_OPTION}=`)) continue;
    out.push(a);
  }
  const dash = out.indexOf("--");
  const flags = [`--${CONFIRM_TOKEN_OPTION}`, token, ...(json ? ["--json"] : [])];
  if (dash === -1) out.push(...flags);
  else out.splice(dash, 0, ...flags);
  return out;
}

async function lookup(ctx: Ctx, token: string): Promise<Confirmation> {
  const db = openRunsDb(ctx.project.paths.stateDir);
  if (!db) throw notFound(token);
  try {
    const c = new Confirmations(db).get(token);
    if (!c) throw notFound(token);
    return c;
  } finally {
    db.close();
  }
}

function spent(ctx: Ctx, token: string): boolean {
  const db = openRunsDb(ctx.project.paths.stateDir);
  if (!db) return false;
  try {
    return new Confirmations(db).get(token)?.usedAt != null;
  } finally {
    db.close();
  }
}

export const confirm: CommandImpl<ConfirmData> = {
  async run(ctx) {
    const token = ctx.positionals[0];
    if (!token) {
      throw new CroftError("USAGE_ERROR", {
        message: "croft confirm needs the token a destructive command printed",
        hint: "usage: croft confirm <token> (tokens look like c_7f3a9e); run it only after the user said yes",
      });
    }
    const stored = await lookup(ctx, token);
    const argv = confirmArgv(stored.command, token, ctx.json);
    const name = scanArgv(argv).name;
    const cmd = ctx.commands.find((c) => c.name === name);
    if (!cmd || cmd.name === "confirm" || !(CONFIRM_TOKEN_OPTION in cmd.options)) {
      throw new CroftError("INTERNAL_ERROR", {
        message: `the stored command "${stored.command}" cannot be confirmed: ${cmd ? `croft ${cmd.name} takes no confirmation` : `there is no command ${name ?? "(none)"}`}`,
        hint: "report this croft bug",
        details: { command: stored.command },
      });
    }

    let captured = "";
    const exit = await main(argv, {
      env: ctx.processEnv,
      cwd: ctx.cwd,
      stdout: ctx.json ? (t) => void (captured += t) : (t) => ctx.render.outRaw(t),
      stderr: (t) => ctx.render.errRaw(t),
      stdinTTY: ctx.isTTY.stdin,
      stdoutTTY: ctx.isTTY.stdout,
      stderrTTY: ctx.render.errColor,
      commands: ctx.commands,
    });

    // A command that acted without spending the token skipped its revalidation: a croft bug to report.
    if (exit === 0 && !spent(ctx, token)) {
      throw new CroftError("INTERNAL_ERROR", {
        message: `croft ${cmd.name} ran without checking confirmation ${token}`,
        hint: "report this croft bug",
        details: { command: stored.command },
      });
    }

    const data: ConfirmData = { token, command: stored.command, result: null };
    if (!ctx.json) return { data, problems: [], next: [], ok: exit === 0, exit };
    let inner: Envelope<unknown>;
    try {
      inner = JSON.parse(captured) as Envelope<unknown>;
    } catch {
      throw new CroftError("INTERNAL_ERROR", { message: `croft ${cmd.name} did not print one JSON envelope`, hint: "report this croft bug" });
    }
    data.result = inner.data;
    return {
      data,
      problems: inner.problems as Problem[],
      next: inner.next,
      ok: inner.ok,
      exit,
      ...(inner.confirmation ? { confirmation: inner.confirmation } : {}),
    };
  },
  human() {
    return undefined;     // the confirmed command printed its own output
  },
};
