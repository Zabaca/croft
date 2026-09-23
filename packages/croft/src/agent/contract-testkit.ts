// The agent-contract scanner (agent/contract.test.ts): finds every `croft <command>` and `--flag` in a text
// that this build does not have, and reads the agent-facing strings (hints, fixes, next[] entries, docs todos
// and option descriptions) out of croft's source with the TypeScript parser. For tests only.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { COMMAND_PHASE, hasCommand, isCommandName, laterFlags, PHASE } from "../core/phase.ts";
import { GLOBAL_OPTIONS } from "../cli/commands/help.ts";
import { COMMANDS } from "../cli/commands/index.ts";

export const SRC = fileURLToPath(new URL("../", import.meta.url));

export const registered = new Map(COMMANDS.map((c) => [c.name, c]));
export const optionsOf = (name: string): Set<string> => new Set([
  ...Object.entries(registered.get(name)?.options ?? {}).filter(([, o]) => !o.hidden).map(([f]) => f),
  ...Object.keys(GLOBAL_OPTIONS),
]);
// Hidden options exist (a hint may say "leave --run-id out"); they are never valid in a suggested command.
const everyFlag = new Set([...COMMANDS.flatMap((c) => Object.keys(c.options)), ...Object.keys(GLOBAL_OPTIONS)]);

// Flags of other programs that croft's texts quote (bun, git, curl).
const FOREIGN_FLAGS = new Set(["no-env-file"]);

/** Where a command's span ends: the next backtick, arrow, clause break or command. */
const SPAN_END = /`|→|;|\n|\(|\)|, | then | and | or | with | until |: |\. |\.$|croft (?=[a-z])/;

export interface Finding { where: string; text: string; problem: string }

/** Every `croft <command>` and `--flag` in `text` that this build does not have. */
export function scan(where: string, text: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<number>();                          // flag positions checked inside a command span
  for (const m of text.matchAll(/\bcroft ([a-z][a-z-]*)/g)) {
    const word = m[1]!;
    if (!isCommandName(word)) continue;
    const line = text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index) === -1 ? undefined : text.indexOf("\n", m.index)).trim();
    if (!hasCommand(word)) {
      out.push({ where, text: line, problem: `croft ${word} is phase ${COMMAND_PHASE[word]}; this build is phase ${PHASE}` });
      continue;
    }
    const start = m.index! + m[0].length;
    const rest = text.slice(start);
    const end = rest.search(SPAN_END);
    const span = end === -1 ? rest : rest.slice(0, end);
    const allowed = optionsOf(word);
    for (const f of span.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)) {
      seen.add(start + f.index!);
      const flag = f[1]!;
      if (laterFlags(word).includes(flag)) out.push({ where, text: line, problem: `croft ${word} --${flag} comes in a later phase` });
      else if (!allowed.has(flag)) out.push({ where, text: line, problem: `croft ${word} has no option --${flag}` });
    }
  }
  for (const f of text.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)) {
    if (seen.has(f.index!) || FOREIGN_FLAGS.has(f[1]!)) continue;
    if (!everyFlag.has(f[1]!)) {
      const line = text.slice(text.lastIndexOf("\n", f.index) + 1).split("\n")[0]!.trim();
      out.push({ where, text: line, problem: `no command of this build has --${f[1]}` });
    }
  }
  return out;
}

/** croft's own source files: the .ts files under src/, without tests, test kits and fixtures. */
export function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "fixtures") out.push(...sourceFiles(p));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.includes("testkit")) {
      out.push(p);
    }
  }
  return out.sort();
}

const AGENT_KEYS = new Set(["hint", "command", "reason", "todo"]);

/** The text of every string in the hints, fixes, next[] entries, docs todos and command option descriptions
 *  (`options: { flag: { description } }`, shown by croft help) of one source file. A template literal's
 *  substitutions read as X ("croft run X --from"). */
export function agentStrings(file: string, text: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: { line: number; text: string }[] = [];
  const nameOf = (n: ts.PropertyAssignment) => (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : "");
  const strings = (node: ts.Node) => {
    const visit = (n: ts.Node) => {
      let s: string | null = null;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) s = n.text;
      else if (ts.isTemplateExpression(n)) s = n.head.text + n.templateSpans.map((sp) => `X${sp.literal.text}`).join("");
      if (s !== null) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: s });
      if (!ts.isTemplateExpression(n)) ts.forEachChild(n, visit);
      else n.templateSpans.forEach((sp) => visit(sp.expression));
    };
    visit(node);
  };
  const walk = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n)) {
      const name = nameOf(n);
      // The property that holds the object this one is in, and the one above that.
      const holder = (node: ts.Node): ts.PropertyAssignment | null =>
        ts.isObjectLiteralExpression(node.parent) && ts.isPropertyAssignment(node.parent.parent) ? node.parent.parent : null;
      const up = holder(n);
      const inFix = up !== null && nameOf(up) === "fix";
      const up2 = up && holder(up);
      const inOption = up2 !== null && nameOf(up2) === "options";
      if (AGENT_KEYS.has(name) || (name === "description" && (inFix || inOption))) {
        strings(n.initializer);
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

