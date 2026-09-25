#!/bin/sh
':' //; command -v bun >/dev/null 2>&1 && exec bun "$0" "$@"; case " $* " in *" --hook "*) printf '%s\n' 'error NEEDS_BUN  croft validate --hook did not run: bun is not on the PATH Claude Code gives its hooks, so this edit was not checked' '      fix: if Bun is installed, start Claude Code from a terminal where bun works, or add the folder that holds bun (~/.bun/bin) to the PATH Claude Code starts with; otherwise install Bun: curl -fsSL https://bun.sh/install | bash' >&2; exit 1;; esac; command -v node >/dev/null 2>&1 && exec node "$0" "$@"; printf '%s\n' 'error NEEDS_BUN  croft runs on Bun, not Node or another runtime' '      fix: curl -fsSL https://bun.sh/install | bash (ask the user to run it in their terminal)' >&2; exit 2
//
// The croft bin (package.json "bin"; DESIGN.md §2 "Install-time failures"). Plain JavaScript on purpose:
// croft is TypeScript that Bun runs, and Node cannot even parse it, so this file checks the runtime
// before anything else is imported and answers NEEDS_BUN the way the launcher does (launcher.ts
// needsBun(); bin.test.ts keeps the two identical).
//
// Line 2 is for sh, which the #! line starts; to JavaScript it is a string and a comment. It runs this
// file with bun when bun is on PATH, with node otherwise (which gets NEEDS_BUN below), and prints the
// problem itself when neither is there (`npx croft` on a machine without Bun). The launcher starts a
// project's pinned copy as `bun --no-env-file <this file>`, which does not go through sh.
//
// `croft validate --hook` (the Claude Code hook, src/agent/hook.ts) without bun gets its own NEEDS_BUN, from sh
// or from node alike: Bun is usually installed but missing from the PATH of an app started from the Dock or an
// IDE, and exit 1 shows the user a notice where exit 2 would block Claude after every edit.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Through node_modules/.bin or ~/.bun/bin this file is reached by a symlink; src/ is next to the real file.
const self = pathToFileURL(realpathSync(fileURLToPath(import.meta.url)));

if (typeof globalThis.Bun === "undefined") {
  process.exitCode = needsBun(process.argv.slice(2));
} else {
  const { cli } = await import(new URL("../src/cli/main.ts", self).href);
  // exitCode, not process.exit(): exit() cuts piped stdout off at 64 KB in Bun.
  process.exitCode = await cli();
}

/** Print NEEDS_BUN (one envelope with --json, else the problem block on stderr) and return exit code 2; 1 for
 *  `croft validate --hook`, which Claude Code shows the user without blocking Claude (src/agent/hook.ts). */
function needsBun(argv) {
  let name;
  let json = false;
  let version = false;
  let hook = false;
  for (const a of argv) {
    if (a === "--") break;
    if (a === "--json") json = true;
    else if (a === "--version" || a === "-V") version = true;
    else if (a === "--hook") hook = true;
    else if (name === undefined && !a.startsWith("-")) name = a;
  }
  const install = "curl -fsSL https://bun.sh/install | bash";
  const problem = hook ? {
    // Run by the Claude Code hook: Bun is usually installed but missing from the PATH of an app started from the
    // Dock or an IDE. Line 2 prints the same two lines when there is no node either (bin.test.ts).
    severity: "error",
    code: "NEEDS_BUN",
    message: "croft validate --hook did not run: bun is not on the PATH Claude Code gives its hooks, so this edit was not checked",
    hint: `if Bun is installed, start Claude Code from a terminal where bun works, or add the folder that holds bun (~/.bun/bin) to the PATH Claude Code starts with; otherwise install Bun: ${install}`,
    docs: "croft docs NEEDS_BUN",
    fix: { kind: "manual", description: "put bun on the PATH Claude Code starts with, or install Bun", requiresHuman: true },
  } : {
    severity: "error",
    code: "NEEDS_BUN",
    message: "croft runs on Bun, not Node or another runtime",
    hint: `install Bun (${install}), then run croft again`,
    docs: "croft docs NEEDS_BUN",
    fix: { kind: "command", description: "install Bun", command: install, requiresHuman: true },
  };
  if (json) {
    let croftVersion = "";
    try {
      croftVersion = JSON.parse(readFileSync(new URL("../package.json", self), "utf8")).version ?? "";
    } catch { /* unreadable: the envelope still goes out */ }
    const envelope = {
      schemaVersion: 1, ok: false, command: version ? "version" : name ?? "help", croftVersion, database: "",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", durationMs: 0,
      data: null, problems: [problem], next: [],
    };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else if (hook) {
    process.stderr.write(`error ${problem.code}  ${problem.message}\n      fix: ${problem.hint}\n`);
  } else {
    process.stderr.write(`error ${problem.code}  ${problem.message}\n      fix: ${install} (ask the user to run it in their terminal)\n`);
  }
  return hook ? 1 : 2;
}
