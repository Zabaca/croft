import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'

// systemd-mask — a user unit that must never start, declared instead of
// remembered.
//
// **Why this exists.** `xdg-desktop-portal` and `xdg-desktop-portal-gtk` failed
// 291 times a day on this box. There is no monitor attached and James never logs
// in, so there is no graphical session: the GTK backend exits `cannot open
// display`, and the portal then waits out a 90s D-Bus timeout for a backend that
// cannot arrive. Something asks for a portal, two units fail, and the cycle
// repeats — measured at 145 activations a day.
//
// Chasing the requester was the wrong fix and I tried it first: a
// `GTK_USE_PORTAL=0` flag on the one Chrome launch I could find, which I
// reported as verified and which a controlled A/B afterwards would not
// reproduce. The requester is not the invariant. **The invariant is that these
// units cannot work on this host at all**, so they should not be startable, and
// then it does not matter who asks. D-Bus fails fast instead of after 120s.
//
// **A mask is a symlink to /dev/null and nothing else.** An empty regular file
// at the same path is a unit with no ExecStart, which systemd will try to start
// and fail — the opposite of masking, and indistinguishable from it by anything
// that only checks the path exists.
//
// **It refuses to replace a regular file.** A real unit file at that path is
// somebody's declared unit, possibly one of ours; overwriting it with /dev/null
// would delete a service and report success. A symlink pointing elsewhere *is*
// replaced — that is a unit the package manager enabled, and it is exactly the
// state this module is for.
//
// User scope only. A system-scope mask needs root and a different directory,
// and this box's problem units are all user units; a module that quietly
// handled both would make it easy to mask a system service by typo.

/** What a mask points at. The whole definition of the thing. */
export const MASK_TARGET = '/dev/null'

export interface MaskPlan {
  action: 'mask' | 'noop'
  /** What the link pointed at before, when there was one. Reported so an apply
   *  says what it displaced rather than only what it wrote. */
  replacing?: string
}

/**
 * What to do with the path as it is now.
 *
 * Throws on a regular file: that is a declared unit and not this module's to
 * destroy.
 */
export const maskPlan = (path: string): MaskPlan => {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return { action: 'mask' }
  }

  if (stat.isSymbolicLink()) {
    const current = readlinkSync(path)
    return current === MASK_TARGET ? { action: 'noop' } : { action: 'mask', replacing: current }
  }

  throw new Error(
    `${path} is a regular file, not a mask — refusing to replace a declared unit with ${MASK_TARGET}`,
  )
}

/**
 * Where a user unit of this name lives.
 *
 * Throws on a blank or relative `home` rather than joining it into a
 * plausible-looking path relative to the caller's cwd. `apply` would then
 * mkdir, symlink, daemon-reload and report `changed: true` against that path
 * while the real unit stayed live and unmasked — the same silent success this
 * module refuses for a regular file, reached through a bad home instead.
 */
export const userUnitPath = (name: string, home: string): string => {
  if (!isAbsolute(home)) {
    throw new Error(
      `a user unit mask needs an absolute home directory, got ${JSON.stringify(home)}`,
    )
  }
  return join(home, '.config', 'systemd', 'user', name)
}

export const systemdMaskModule = defineModule({
  name: 'systemd-mask',
  configSchema: z.object({
    // The unit to mask, including its suffix. Restricted for the reason
    // `systemd-unit` restricts its own: it reaches a shell below.
    unit: z
      .string()
      .regex(/^[A-Za-z0-9@._-]+\.(service|socket|timer|target)$/, 'not a plain unit name'),
    // Why. Required, and required to be a sentence rather than a word: a masked
    // unit is invisible until someone wonders why a thing does not start, and
    // the answer has to be here rather than in whoever remembers.
    reason: z.string().min(30, 'a mask needs a reason a stranger can act on'),
  }),
  outputs: z.object({ unit: z.string(), path: z.string(), changed: z.boolean() }),
  // No `destroy`. Unmasking is `systemctl --user unmask <unit>` and is a
  // deliberate two-step, like the other modules' absent teardown: delete the
  // instance file and run the command. An automated unmask would re-arm a unit
  // that was masked for a reason nobody is re-reading at that moment.
  apply: async (config) => {
    // The OS user database, not the environment. HOME goes missing in a
    // stripped environment — a unit invoked without a login shell, a
    // subprocess whose env was filtered — and `homedir()` falls back to the
    // passwd entry for the running user instead of going blank. It is the same
    // authority `git` and `ssh` ask. It is not a complete answer on its own: a
    // *relative* HOME is returned verbatim, which is what `userUnitPath`
    // refuses.
    const path = userUnitPath(config.unit, homedir())
    const plan = maskPlan(path)

    if (plan.action === 'noop') {
      console.log(`  ${config.unit} already masked (unchanged)`)
      return { unit: config.unit, path, changed: false }
    }

    mkdirSync(dirname(path), { recursive: true })
    // `force` because the symlink may exist pointing elsewhere; `maskPlan` has
    // already refused the only case where removing something would be wrong.
    rmSync(path, { force: true })
    symlinkSync(MASK_TARGET, path)

    // Or systemd keeps answering D-Bus activation from its loaded state and the
    // mask does nothing until the next login — which on this box is never.
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
    // A masked unit that is currently failed stays failed, and a failed unit is
    // what the watchdog and the unit-failures source both report. Clearing it
    // is part of the change, not a cosmetic afterthought.
    execFileSync('systemctl', ['--user', 'reset-failed', config.unit], { stdio: 'ignore' })

    const after = maskPlan(path)
    if (after.action !== 'noop')
      throw new Error(`${config.unit} did not mask: ${JSON.stringify(after)}`)

    console.log(
      `  ${config.unit} masked${plan.replacing === undefined ? '' : ` (was → ${plan.replacing})`} — ${config.reason}`,
    )
    return { unit: config.unit, path, changed: true }
  },
})
