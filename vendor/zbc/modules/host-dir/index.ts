import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import { exec } from '../host-exec'

// host-dir — a directory that exists because this repo says so.
//
// **Why the existing modules are all the wrong one.** Every module here that
// creates a directory creates a *specific kind* of thing —
// `incus-storage-pool` creates a pool, not a directory you asked for. `host-file` comes closest and is the
// dangerous near-miss — it calls `mkdirSync(dirname(config.path))` only on the
// way to writing file **contents**, so declaring a database's directory through
// it would make every apply overwrite the database. That is worse than no
// declaration at all.
//
// **What it is for.** An application's data store lives outside the git tree at a
// declared path. A directory that exists because some program's `mkdir -p` ran
// first is hand-configured state: it survives a reboot, nothing in this tree
// declares it, and a rebuilt box comes back without it. The rows in the
// database are work state and are not machine configuration; the directory,
// its mode and its owner are.
//
// **No `destroy`** — removing something stays a
// human act — and sharper here than there. `apt-get remove` takes reverse
// dependencies with it; removing this directory deletes the only copy of the
// store. A teardown path would be code nothing exercises until the day
// it matters, and on that day it deletes the thing it was written to manage.
//
// **Contents are not managed.** The mode and owner converged here are the
// directory's own, never its tree's. That is not a simplification: on this box
// A data directory can already hold gigabytes of state written
// by the application that owns it, so a recursive converge would rewrite every one of
// those modes as a side effect of declaring the directory above them.
//
// **Two seams, because the machine has two shapes here.** Creating a directory
// and setting its mode are filesystem calls against the absolute path the
// config names, and a filesystem has temp directories — so those run for real
// in tests, the way `host-symlink` does. Ownership is the
// half a test cannot duplicate: a non-root process cannot chown to another
// user, so there is no temp-directory equivalent. That half goes through
// `host-exec` and is substituted instead.

export type DirPlan =
  | { action: 'noop' }
  | { action: 'create' }
  /** `from` is the mode it had, so an apply says what it changed and not only
   *  that it changed something. */
  | { action: 'chmod'; from: string }

/**
 * A directory's permission bits, in the four-digit octal a declaration spells.
 *
 * Setuid, setgid and the sticky bit are masked off. This module does not manage
 * them — `mkdirSync` cannot even set them — so including them would make an
 * apply report a drift on a directory it will never converge.
 */
export const modeOf = (path: string): string =>
  `0${(statSync(path).mode & 0o777).toString(8).padStart(3, '0')}`

/**
 * What to do with the path as it is now.
 *
 * Throws on two states, both of which look like success to anything that only
 * asks `existsSync(path)`:
 *
 * - **A regular file at the path.** `mkdirSync` would throw `EEXIST` here on
 *   its own, but with an errno nobody can act on; the refusal says what is
 *   actually wrong, which is that this path holds somebody else's data.
 * - **A symlink at the path.** This is the one worth the check.
 *   `mkdirSync(…, { recursive: true })` no-ops on a link to a directory and
 *   `chmodSync` follows it, so an apply would report a converged directory
 *   having modified one somewhere else that this repo does not declare — and
 *   the store would then be written through a pointer nobody declared. It is
 *   the same defect `host-symlink`'s header describes in the other direction,
 *   where `readFileSync` follows a link and reports `unchanged` having
 *   converged nothing.
 */
export const dirPlan = (path: string, mode: string): DirPlan => {
  let entry: ReturnType<typeof lstatSync>
  try {
    entry = lstatSync(path)
  } catch {
    return { action: 'create' }
  }

  if (entry.isSymbolicLink()) {
    throw new Error(
      `${path} is a symlink, not a directory — refusing to converge whatever it points at, ` +
        'which every check here would pass while the declared path stayed a pointer',
    )
  }

  if (!entry.isDirectory()) {
    throw new Error(
      `${path} is a regular file, not a directory — ` +
        'refusing to replace something this repo does not declare',
    )
  }

  const current = modeOf(path)
  return current === mode ? { action: 'noop' } : { action: 'chmod', from: current }
}

/**
 * Ask the machine who owns the path, in exactly the form a declaration spells.
 *
 * `stat -c '%U:%G'` rather than `statSync().uid` plus a uid→name lookup: one
 * call, and its answer is already the string the config carries, so neither
 * side has to resolve anything and there is no second representation to get
 * wrong.
 */
export const renderOwnerQuery = (path: string): string => `stat -c '%U:%G' ${path}`

/**
 * Take ownership of the path.
 *
 * Through `sudo`, matching the vm, systemd-unit and incus-storage-pool
 * convention on this host (passwordless sudo is set up
 * deliberately). Without it the one state a chown exists to fix — a directory
 * left owned by root, by a `mkdir` under sudo or by a restore — is the one
 * state it cannot fix.
 */
export const renderChownCommand = (owner: string, path: string): string =>
  `sudo chown ${owner} ${path}`

export const hostDirModule = defineModule({
  name: 'host-dir',
  configSchema: z.object({
    path: z
      .string()
      // Absolute, because a relative one is resolved against whatever cwd the
      // apply ran in — and an apply that creates the store's directory inside a
      // worktree succeeds, reports a change, and leaves the real path
      // untouched.
      .refine(isAbsolute, 'a directory path must be absolute')
      // Interpolated into `stat` and `chown`, so anything outside this set is
      // an injection seam rather than a typo — the same reason every module
      // here that interpolates config into a command validates it first.
      .refine(
        (path) => /^[A-Za-z0-9/._-]+$/.test(path),
        'a directory path is interpolated into a shell command, so it may hold only [A-Za-z0-9/._-] — refusing shell characters',
      ),
    // `user:group`, the form `chown` takes and `stat -c '%U:%G'` returns.
    owner: z.string().regex(/^[a-z_][a-z0-9_-]*:[a-z_][a-z0-9_-]*$/, 'owner must be user:group'),
    // Four digits, not three. `'755'` parses fine and reads right, which is
    // exactly why it is refused: the leading zero is what tells a reader the
    // string is octal, and a mode that looks decimal is a mode nobody checks.
    mode: z
      .string()
      .regex(/^0[0-7]{3}$/, 'mode must be a four-digit octal string, e.g. 0755')
      .default('0755'),
  }),
  outputs: z.object({
    path: z.string(),
    mode: z.string(),
    owner: z.string(),
    changed: z.boolean(),
  }),
  // No `destroy`, matching `host-symlink` and `systemd-mask`.
  // See the header: here it would delete the only copy of the store.
  apply: async (config) => {
    const plan = dirPlan(config.path, config.mode)
    const mode = parseInt(config.mode, 8)

    if (plan.action === 'create') mkdirSync(config.path, { recursive: true, mode })
    // Unconditional after a create, not only after a `chmod` plan: `mkdirSync`'s
    // `mode` is masked by the process umask, so a create alone lands at
    // whatever the umask allows and the declaration silently does not hold.
    // 0755 under umask 027 creates 0750. `host-file` converges the same way and
    // for the same reason.
    if (plan.action !== 'noop') chmodSync(config.path, mode)

    // Read it back rather than trust the calls. Same reason `host-symlink`
    // re-reads: this is the step whose result nothing else in
    // the apply checks.
    const after = dirPlan(config.path, config.mode)
    if (after.action !== 'noop') {
      throw new Error(`${config.path} did not converge to ${config.mode}: ${JSON.stringify(after)}`)
    }

    // Owner last, and asked for before it is set — the query is what makes a
    // no-op a measurement rather than an assumption, and it is what keeps a
    // second apply from shelling out at all.
    const owner = exec(renderOwnerQuery(config.path)).trim()
    const chowned = owner !== config.owner
    if (chowned) {
      exec(renderChownCommand(config.owner, config.path))
      const afterOwner = exec(renderOwnerQuery(config.path)).trim()
      if (afterOwner !== config.owner) {
        throw new Error(
          `${config.path} did not change owner: asked for ${config.owner}, still ${afterOwner}`,
        )
      }
    }

    const changed = plan.action !== 'noop' || chowned
    const what =
      plan.action === 'create' ? 'created' : plan.action === 'chmod' ? 'remoded' : 'unchanged'
    const took = chowned ? `, chowned from ${owner}` : ''
    console.log(`  ${config.path} ${config.mode} ${config.owner} ${what}${took}`)
    return { path: config.path, mode: config.mode, owner: config.owner, changed }
  },
})
