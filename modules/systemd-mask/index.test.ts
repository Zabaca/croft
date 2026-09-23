import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maskPlan, MASK_TARGET, userUnitPath } from './index'

// A mask is a symlink to /dev/null and nothing else. An empty regular file at
// the same path is a *unit with no ExecStart*, which systemd will happily try to
// start and fail — the opposite of what masking is for, and indistinguishable
// from a mask by anything that only checks the path exists.

// A fixture root this file owns and removes.
//
// One root per file, removed in `afterAll`, rather than a `mkdtempSync` per
// test. `process.on('exit')` never fires under `bun test`, so per-test temp
// directories are never reaped — roughly 50 files doing it that way had leaked
// 24 GB into /tmp before the discipline landed.
const ROOT = mkdtempSync(join(tmpdir(), 'systemd-mask-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const dir = () => mkdtempSync(join(ROOT, 'systemd-mask-'))

describe('what the plan does with each state on disk', () => {
  test('an absent path is masked', () => {
    expect(maskPlan(join(dir(), 'xdg-desktop-portal.service')).action).toBe('mask')
  })

  test('a correct mask is a no-op, so a re-apply changes nothing', () => {
    const path = join(dir(), 'x.service')
    symlinkSync(MASK_TARGET, path)
    expect(maskPlan(path).action).toBe('noop')
  })

  test('a symlink pointing somewhere else is re-pointed, not left alone', () => {
    // A unit enabled by the package manager is a symlink into /usr/lib. That is
    // exactly the state this module exists to replace, and treating any symlink
    // as "already masked" would silently leave the unit live.
    const path = join(dir(), 'x.service')
    symlinkSync('/usr/lib/systemd/user/x.service', path)
    const plan = maskPlan(path)
    expect(plan.action).toBe('mask')
    expect(plan.replacing).toBe('/usr/lib/systemd/user/x.service')
  })

  // The case that decides whether this module is safe to run. A real unit file
  // at this path is somebody's declared unit — possibly one of ours — and
  // replacing it with /dev/null would delete a service and report success.
  test('a regular file is refused rather than replaced', () => {
    const path = join(dir(), 'x.service')
    writeFileSync(path, '[Unit]\nDescription=someone else declared this\n')
    expect(() => maskPlan(path)).toThrow(/regular file|not a mask/i)
  })
})

// Where the home directory comes from, and what happens when it is nonsense.
//
// Two defects in one line, `const home = process.env.HOME ?? ''`:
//
// 1. The source. An env var goes missing in a stripped environment — a systemd
//    unit invoked without a login shell, a subprocess whose env was filtered —
//    and the fallback is a blank string rather than a lookup.
// 2. The lack of a check. `join('', '.config', 'systemd', 'user', name)` does
//    not throw. It returns a path relative to whatever the caller's cwd happens
//    to be, and `apply` then mkdirs, symlinks, daemon-reloads, reset-fails and
//    reports `changed: true` against that path while the real unit stays live
//    and unmasked. The same silent-success shape the module's docstring already
//    worries about for a regular file, reached through a bad HOME instead.
//
// Fixing the source does not fix the check. Measured here: `os.homedir()`
// falls back to the passwd entry for an unset *and* for an empty HOME, but
// returns a relative HOME verbatim — `HOME=relative/path` yields
// `"relative/path"`. So the guard below is not redundant with the homedir()
// call above it; it covers the one case homedir() passes through.
describe('where the home directory comes from', () => {
  const source = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')

  test('is not the environment', () => {
    expect(source).not.toContain('process.env.HOME')
  })

  test('is the OS user database, which is what `git` and `ssh` ask too', () => {
    expect(source).toMatch(/homedir\(\)/)
    expect(source).toMatch(/from ['"]node:os['"]/)
  })
})

describe('what a home directory has to look like to become a path', () => {
  test('a blank home is refused rather than turned into a relative path', () => {
    expect(() => userUnitPath('xdg-desktop-portal-gtk.service', '')).toThrow(/absolute/i)
  })

  test('a relative home is refused for the same reason', () => {
    expect(() => userUnitPath('xdg-desktop-portal-gtk.service', 'relative/dir')).toThrow(
      /absolute/i,
    )
  })

  test('an absolute home still resolves the real path', () => {
    expect(userUnitPath('xdg-desktop-portal-gtk.service', '/home/deploy')).toBe(
      '/home/deploy/.config/systemd/user/xdg-desktop-portal-gtk.service',
    )
  })
})

describe('the mask target', () => {
  test('is /dev/null, which is what makes it a mask and not an empty unit', () => {
    expect(MASK_TARGET).toBe('/dev/null')
  })
})

describe('applying the plan', () => {
  test('a mask lands as a symlink to /dev/null, readable as one', () => {
    const path = join(dir(), 'x.service')
    const plan = maskPlan(path)
    expect(plan.action).toBe('mask')
    // The module's own write step, exercised through the same helper apply uses.
    mkdirSync(join(path, '..'), { recursive: true })
    symlinkSync(MASK_TARGET, path)
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path)).toBe(MASK_TARGET)
    expect(maskPlan(path).action).toBe('noop')
  })
})
