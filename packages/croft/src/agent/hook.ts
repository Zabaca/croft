// The opt-in Claude Code hook (DESIGN.md §9 item 7): `croft init --claude --with-hook` adds a PostToolUse hook that
// runs `croft validate --hook` after edits under assets/. Phase 5 contract stub: its builder (HK) replaces this.
import { phaseStub } from "../core/phase.ts";

/** The hook entry merged into .claude/settings.json. */
export function hookSettings(): Record<string, unknown> {
  return phaseStub("hookSettings()");
}

/** The asset file a hook invocation is about, from the hook's JSON on stdin; null when it is not under assets/. */
export function hookTarget(stdin: string, root: string): string | null {
  return phaseStub(`hookTarget(${stdin.length}, ${root})`);
}
