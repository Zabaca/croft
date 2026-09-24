// croft confirm <token> (DESIGN.md §4.2, §6 "How confirmation works"). Off a TTY a destructive command stops
// with exit 5 and a token instead of acting; the action then runs only through this command, which every
// Claude Code permission rule can gate with one prefix ("ask": ["Bash(croft confirm:*)"]). The cost guard
// (§5, LARGE_REPROCESS) works the same way: its token is for `croft run <transform>`, the one transform named.
//
// confirm refuses a token that does not exist (USAGE_ERROR), was used or has expired (CONFIRMATION_STALE)
// before anything runs. Otherwise it runs the stored command again, in this process, through the CLI
// dispatcher (main.ts), and hands it the token through the Dispatch. No command line can carry a token, so
// this command is the only way to act on one. The command revalidates where it acts: it recomputes the impact
// and calls Confirmations.consume(), which spends the token and throws CONFIRMATION_STALE (with the new
// impact) when the impact changed, e.g. because the scheduler added rows meanwhile.
//
// The command's output is the output: its human text passes straight through, and under --json its envelope's
// data becomes data.result (problems, next, confirmation and the exit code carry over). data.outcome says what
// became of the token:
// - "used": the command reached the confirmation and spent it, whether it then acted or found it stale;
// - "not_needed": the command ended without reaching it, because nothing destructive was left to do (the
//   source recovered, say), so it ran as a plain command. The token is spent anyway, so it can never run the
//   command a second time; data.note (printed in human mode too) says so;
// - "unused": the command failed before it got there; the token stays valid until it expires;
// - "running": a detached run is still going (exit 6); it spends the token when it reaches it or ends.
// A destructive step that ran without spending the token would be croft's bug, reported as INTERNAL_ERROR.
import { CroftError, EXIT } from "../../core/errors.ts";
import type { Confirmation, Envelope, Problem } from "../../core/types.ts";
import { Confirmations } from "../../safety/confirm.ts";
import type { CommandImpl, CommandResult, Ctx } from "../command.ts";
import { type Dispatch, main, scanArgv } from "../main.ts";
import { openRunsDb } from "./status.ts";

/** The commands that carry out a confirmation: they read the token from dispatchOf(ctx) and spend it where
 *  they act. rename needs no confirmation (§6). */
export const CONFIRMABLE = new Set<string>(["run", "delete", "restore"]);

export type ConfirmOutcome = "used" | "not_needed" | "unused" | "running";

export interface ConfirmData {
  token: string;
  command: string;
  /** The confirmed command's data (--json); null in human mode, where its output was printed as is. */
  result: unknown;
  outcome: ConfirmOutcome;
  /** Why the token was not used as a confirmation, when it was not. */
  note?: string;
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

/** The stored command as argv for main(): without "croft" or --json (added back when confirm has it). The
 *  token is not in it: the command gets it through the Dispatch. */
export function confirmArgv(stored: string, json: boolean): string[] {
  const words = splitCommand(stored);
  if (words[0] !== "croft") {
    throw new CroftError("INTERNAL_ERROR", { message: `the stored command is not a croft command: ${stored}`, hint: "report this croft bug" });
  }
  const out: string[] = [];
  const rest = words.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") { out.push(...rest.slice(i)); break; }
    if (a !== "--json") out.push(a);
  }
  if (!json) return out;
  const dash = out.indexOf("--");
  if (dash === -1) out.push("--json");
  else out.splice(dash, 0, "--json");
  return out;
}

function confirmations<T>(ctx: Ctx, token: string, fn: (c: Confirmations) => T): T {
  const db = openRunsDb(ctx.project.paths.stateDir);
  if (!db) throw notFound(token);
  try {
    return fn(new Confirmations(db));
  } finally {
    db.close();
  }
}

/** A step that trashed rows: the destructive part of a confirmed run, which must have spent the token. */
function destructiveStepRan(result: CommandResult | undefined): boolean {
  const steps = (result?.data as { steps?: unknown } | null | undefined)?.steps;
  return Array.isArray(steps) && steps.some((s) => typeof s === "object" && s !== null && "trashed" in s && !!s.trashed);
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
    // Unknown, used or expired: refused here, before the stored command runs at all (tokens are single-use).
    const stored: Confirmation = confirmations(ctx, token, (c) => c.usable(token));
    const argv = confirmArgv(stored.command, ctx.json);
    const name = scanArgv(argv).name;
    const cmd = ctx.commands.find((c) => c.name === name);
    if (!cmd || cmd.name === "confirm" || !CONFIRMABLE.has(cmd.name)) {
      throw new CroftError("INTERNAL_ERROR", {
        message: `the stored command "${stored.command}" cannot be confirmed: ${cmd ? `croft ${cmd.name} takes no confirmation` : `there is no command ${name ?? "(none)"}`}`,
        hint: "report this croft bug",
        details: { command: stored.command },
      });
    }

    let captured = "";
    const dispatch: Dispatch = { confirmToken: token };
    const exit = await main(argv, {
      env: ctx.processEnv,
      cwd: ctx.cwd,
      stdout: ctx.json ? (t) => void (captured += t) : (t) => ctx.render.outRaw(t),
      stderr: (t) => ctx.render.errRaw(t),
      stdinTTY: ctx.isTTY.stdin,
      stdoutTTY: ctx.isTTY.stdout,
      stderrTTY: ctx.render.errColor,
      commands: ctx.commands,
      dispatch,
    });

    const spent = confirmations(ctx, token, (c) => c.get(token)?.usedAt != null);
    if (!spent && destructiveStepRan(dispatch.result)) {
      throw new CroftError("INTERNAL_ERROR", {
        message: `croft ${cmd.name} acted without spending confirmation ${token}`,
        hint: "report this croft bug",
        details: { command: stored.command },
      });
    }
    const ok = dispatch.result ? dispatch.result.ok ?? exit === 0 : false;
    let outcome: ConfirmOutcome;
    let note: string | undefined;
    if (dispatch.confirmationNotNeeded || (!spent && ok && exit === EXIT.OK)) {
      // Nothing destructive was left to do: a plain run. Spend the token anyway (single use).
      if (!spent) confirmations(ctx, token, (c) => c.spendUnused(token));
      outcome = "not_needed";
      note = `${stored.command} did not need confirmation ${token}: nothing destructive was left to do, so it ran as a plain command. The token is spent.`;
    } else if (spent) {
      outcome = "used";
    } else if (exit === EXIT.STILL_RUNNING) {
      outcome = "running";
      note = `the run is still going; it spends confirmation ${token} when it gets to it, or when it ends without needing it`;
    } else {
      outcome = "unused";
      note = `${stored.command} stopped before it reached confirmation ${token}, so nothing destructive happened; the token was not used and stays valid until ${stored.expiresAt}`;
    }

    const data: ConfirmData = { token, command: stored.command, result: null, outcome, ...(note ? { note } : {}) };
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
  human(result) {
    // The confirmed command printed its own output; only a note about the token is added.
    return result.data.note ? `note: ${result.data.note}` : undefined;
  },
};
