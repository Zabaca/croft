import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'

// host-symlink — a pointer on this host into the checkout, declared instead of
// remembered.
//
// **Why a link and not a copy.** `host-file` materialises content, and for
// anything a tool reads out of this repo that is the wrong shape twice over.
// It leaves two copies of one file, so an edit to the live one is drift that
// nothing reports until the next apply silently reverts it. And it cannot
// converge a link at all: `readFileSync` follows one, so a link already at the
// path reads as content and compares *equal* — the module reports `unchanged`
// having converged nothing — while a differing declaration makes `writeFileSync`
// write **through** the link and clobber the repo's own source file.
//
// The pattern this serves is already in CLAUDE.md: `services/claude-hooks` and
// `watchdog.sh` are executed out of the checkout by absolute path, so the repo
// is the single copy and editing one needs no apply — only the wiring is
// applied. A hook's wiring is an entry in `settings.json`. For a file a tool
// finds by scanning a fixed directory, the wiring *is* a symlink.
//
// **Not a general file-placement tool.** If the content on the box does not
// have to be the same bytes as the repo's copy, use `host-file`; a link makes
// the two inseparable, which is a promise worth making only when they are
// meant to be one file.

export type LinkPlan =
  | { action: 'noop' }
  /** `replacing` is what the link pointed at before, when there was one — so an
   *  apply says what it displaced and not only what it wrote. */
  | { action: 'link'; replacing?: string }

/**
 * What to do with the path as it is now.
 *
 * Throws on two states, both of which look like success to anything that only
 * asks `existsSync(path)`:
 *
 * - **A regular file or directory at the path.** That is somebody else's file.
 *   `~/.claude/agents/` holds hand-written definitions belonging to other
 *   tooling, and replacing one with a link would delete it and report a change.
 * - **A target that does not exist.** A dangling link is worse than no link:
 *   the path exists, `ls` shows it, and whatever reads the directory simply
 *   finds nothing there — no error, no apply that reports it.
 */
export const linkPlan = (path: string, target: string): LinkPlan => {
  // Checked first, and on every run rather than only when writing: a link and a
  // declaration can agree with each other and both point at a file that has
  // since been renamed. That state converges to `noop` on the path check alone.
  if (!existsSync(target)) {
    throw new Error(
      `symlink target ${target} does not exist — refusing to leave a dangling link at ${path}, ` +
        'which reads as present to a directory listing and as absent to everything that opens it',
    )
  }

  let entry: ReturnType<typeof lstatSync>
  try {
    entry = lstatSync(path)
  } catch {
    return { action: 'link' }
  }

  if (!entry.isSymbolicLink()) {
    throw new Error(
      `${path} is a ${entry.isDirectory() ? 'directory' : 'regular file'}, not a symlink — ` +
        `refusing to replace something this repo does not declare with a link to ${target}`,
    )
  }

  const current = readlinkSync(path)
  return current === target ? { action: 'noop' } : { action: 'link', replacing: current }
}

export const hostSymlinkModule = defineModule({
  name: 'host-symlink',
  configSchema: z.object({
    // Where the link goes. Absolute, because a relative one is resolved against
    // whatever cwd the apply ran in — and an apply that writes the link into a
    // worktree instead of `$HOME` succeeds, reports a change, and leaves the
    // real path untouched.
    path: z.string().refine(isAbsolute, 'a symlink path must be absolute'),
    // What it points at. Absolute for a different reason: a link stores its
    // target verbatim and resolves it against the *link's* directory, so a
    // relative target means one more rule to hold in your head for no gain.
    target: z.string().refine(isAbsolute, 'a symlink target must be absolute'),
  }),
  outputs: z.object({ path: z.string(), target: z.string(), changed: z.boolean() }),
  // No `destroy`, matching `systemd-mask`. Removing one
  // is `rm <path>` plus deleting the instance file, deliberately by hand: the
  // engine prunes nothing, so a teardown here would be a code path nothing
  // exercises until the day it matters.
  apply: async (config) => {
    const plan = linkPlan(config.path, config.target)

    if (plan.action === 'noop') {
      console.log(`  ${config.path} → ${config.target} already linked (unchanged)`)
      return { path: config.path, target: config.target, changed: false }
    }

    mkdirSync(dirname(config.path), { recursive: true })
    // `force` because the path may hold a link pointing elsewhere; `linkPlan`
    // has already refused every case where removing something would be wrong.
    rmSync(config.path, { force: true })
    symlinkSync(config.target, config.path)

    // Read it back rather than trust the call. Same reason the other converging
    // re-reads: this is the step whose result nothing else in the apply checks.
    const after = linkPlan(config.path, config.target)
    if (after.action !== 'noop') {
      throw new Error(`${config.path} → ${config.target} did not link: ${JSON.stringify(after)}`)
    }

    const displaced = plan.replacing === undefined ? '' : ` (was → ${plan.replacing})`
    console.log(`  ${config.path} → ${config.target} linked${displaced}`)
    return { path: config.path, target: config.target, changed: true }
  },
})
