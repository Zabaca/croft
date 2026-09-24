// The agent-contract scanner (agent/contract.test.ts): finds every `croft <command>` and `--flag` in a text
// that this build does not have, and reads every string and template literal out of croft's source with the
// TypeScript parser (any of them can reach an agent: a hint, a fix, a next[] entry, a message, a docs page).
// For tests only.
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

// Flags of other programs that croft's texts quote (bun, git, curl). A camelCase flag (tsc --noEmit) is never
// croft's: FLAG matches only whole lower-case kebab words.
const FOREIGN_FLAGS = new Set(["no-env-file"]);
const FLAG = /(?<![\w-])--([a-z][a-z-]*)(?![\w])/g;

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
    for (const f of span.matchAll(FLAG)) {
      seen.add(start + f.index!);
      const flag = f[1]!;
      if (laterFlags(word).includes(flag)) out.push({ where, text: line, problem: `croft ${word} --${flag} comes in a later phase` });
      else if (!allowed.has(flag)) out.push({ where, text: line, problem: `croft ${word} has no option --${flag}` });
    }
  }
  for (const f of text.matchAll(FLAG)) {
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

/** Files whose strings name later-phase commands on purpose: the phase manifest lists every command of every
 *  phase, and renders the "not in this version" notes (whose own text a test checks). Root-relative to src/. */
export const EXEMPT = new Set(["core/phase.ts"]);

/**
 * The text of every string literal and template literal in one source file: hints, fixes, next[] entries,
 * docs, option descriptions, messages, and anything else that can end up in front of an agent. A template
 * literal's substitutions read as X ("croft run X --from"); strings inside a substitution are read on their
 * own. Property names and literal types are not text anyone reads, so they are left out.
 */
export function sourceStrings(file: string, text: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: { line: number; text: string }[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isLiteralTypeNode(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const p = n.parent;
      const isName = (ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)
        || ts.isMethodDeclaration(p) || ts.isEnumMember(p)) && p.name === n;
      const isModule = ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p);
      if (!isName && !isModule) out.push({ line: at(n), text: n.text });
      return;
    }
    if (ts.isTemplateExpression(n)) {
      out.push({ line: at(n), text: n.head.text + n.templateSpans.map((sp) => `X${sp.literal.text}`).join("") });
      for (const sp of n.templateSpans) visit(sp.expression);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
