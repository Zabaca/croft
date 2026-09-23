import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Exec, withExec } from '../host-exec'
import { dirPlan, hostDirModule, modeOf, renderChownCommand, renderOwnerQuery } from './index'

// A directory that exists because a declaration says so, rather than because
// some program's `mkdir -p` ran first.
//
// The states the path can be found in have to be told apart, and two of them
// look like success to anything that only asks `existsSync(path)`: a regular
// file somebody else wrote, and a **symlink** to a directory somewhere else.
// The symlink is the dangerous one here for the same reason `host-symlink`'s
// header gives about `host-file` — `mkdirSync(…, { recursive: true })` no-ops
// on a link to a directory and `chmodSync` follows it, so an apply would report
// a converged directory having modified somebody else's.

// A fixture root this file owns and removes.
//
// One root per file, removed in `afterAll`, rather than a `mkdtempSync` per
// test. `process.on('exit')` never fires under `bun test`, so per-test temp
// directories are never reaped — roughly 50 files doing it that way had leaked
// 24 GB into /tmp before the discipline landed.
const ROOT = mkdtempSync(join(tmpdir(), 'host-dir-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const dir = () => mkdtempSync(join(ROOT, 'host-dir-'))

const OWNER = 'deploy:deploy'

/**
 * A small in-memory machine, not a call recorder: it answers queries from
 * modelled state, so a test asserts on behaviour rather than on call order.
 *
 * It renders `stat -c '%U:%G'` from state and it *parses* the `chown` back into
 * that state, so a second apply sees the world the first one left behind and
 * "no-op" means the converge really settled. A recorder would have to be told
 * which arguments are correct, which is the assertion restating the
 * implementation.
 */
function fakeMachine(options: { owner?: string; silent?: boolean } = {}) {
  let owner = options.owner ?? OWNER
  const commands: string[] = []

  const exec: Exec = (command) => {
    commands.push(command)
    const query = /^stat -c '%U:%G' (\S+)$/.exec(command)
    if (query !== null) return `${owner}\n`
    const chown = /^sudo chown ([\w-]+:[\w-]+) (\S+)$/.exec(command)
    // An unrecognised command is a failure rather than a silent success: a real
    // shell would reject it, and a fake that shrugged would let a malformed
    // command pass as a converge.
    if (chown === null) throw new Error(`fake machine: refusing unrecognised command: ${command}`)
    // `silent` is the exit-0-and-change-nothing failure that the module's own
    // re-read exists to catch, and the one an exit code cannot see.
    if (options.silent !== true) owner = chown[1]!
    return ''
  }

  return { exec, commands, current: () => owner }
}

const apply = (machine: { exec: Exec }, config: { path: string; owner?: string; mode?: string }) =>
  withExec(machine.exec, () =>
    hostDirModule.apply(
      hostDirModule.configSchema.parse({ owner: OWNER, ...config }),
      // `apply` touches exactly the absolute path its own config names, and
      // reaches the machine only through the seam the caller just replaced. No
      // test here can reach `~/.local/share`.
      { secrets: {}, imports: {}, projectRoot: '/tmp' },
    ),
  )

describe('what the plan does with each state on disk', () => {
  test('an absent path is created', () => {
    expect(dirPlan(join(dir(), 'store'), '0755')).toEqual({ action: 'create' })
  })

  test('a directory already at the declared mode is a no-op, so a re-apply changes nothing', () => {
    // The assertion the whole "confirm the re-apply is a no-op" discipline
    // rests on. A module that reports `changed: true` every run cannot tell
    // convergence from drift.
    const path = join(dir(), 'store')
    mkdirSync(path, { mode: 0o755 })
    chmodSync(path, 0o755)
    expect(dirPlan(path, '0755')).toEqual({ action: 'noop' })
  })

  test('a directory at some other mode is re-moded, and the plan says what it displaced', () => {
    const path = join(dir(), 'store')
    mkdirSync(path)
    chmodSync(path, 0o700)
    // Compared whole rather than field by field: `from` is what an apply prints
    // to say what it changed, and a plan that re-modes without reporting the
    // old mode is a silent overwrite.
    expect(dirPlan(path, '0755')).toEqual({ action: 'chmod', from: '0700' })
  })

  test('a regular file is refused rather than replaced', () => {
    // `mkdirSync` would throw EEXIST here anyway, but with an errno nobody can
    // act on. The refusal names what is actually wrong: this path holds
    // somebody else's data.
    const path = join(dir(), 'store')
    writeFileSync(path, 'somebody else wrote this\n')
    expect(() => dirPlan(path, '0755')).toThrow(/not a directory|regular file/i)
  })

  test('a symlink to a directory is refused, not followed', () => {
    // The case that decides whether this module is safe to point at a path in
    // `$HOME`. `mkdirSync(…, { recursive: true })` no-ops on a link to a
    // directory and `chmodSync` follows it, so every other assertion here would
    // pass while the apply modified a directory this repo does not declare —
    // and the store would then be written through a pointer nobody declared.
    const base = dir()
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere, { mode: 0o700 })
    const path = join(base, 'store')
    symlinkSync(elsewhere, path)
    expect(() => dirPlan(path, '0755')).toThrow(/symlink/i)
  })
})

describe('what a declaration has to look like', () => {
  const parse = (config: Record<string, unknown>) => hostDirModule.configSchema.parse(config)

  test('the module converges under the name instances name it by', () => {
    expect(hostDirModule.name).toBe('host-dir')
  })

  test('an absolute path with an owner is accepted, and the mode has a default', () => {
    const parsed = parse({ path: '/home/deploy/.local/share/app', owner: OWNER })
    expect(parsed.path).toBe('/home/deploy/.local/share/app')
    expect(parsed.owner).toBe(OWNER)
    expect(parsed.mode).toBe('0755')
  })

  test('a relative path is refused', () => {
    // It would be resolved against whatever cwd the apply happens to run in,
    // and an apply that creates the store's directory inside a worktree
    // succeeds, reports a change, and leaves the real path untouched — the same
    // shape `host-symlink` refuses.
    expect(() => parse({ path: '.local/share/app', owner: OWNER })).toThrow(/absolute/i)
  })

  test('a path carrying shell metacharacters is refused', () => {
    // The path is interpolated into `stat` and `chown`, so anything outside the
    // allowed set is an injection seam rather than a typo — the reason
    // refuses metacharacters in a target.
    for (const path of [
      '/home/deploy/store; rm -rf /',
      '/home/deploy/$(id)',
      '/home/deploy/two words',
      '/home/deploy/store`id`',
    ])
      expect(() => parse({ path, owner: OWNER }), path).toThrow(/shell|characters/i)
  })

  test('an owner that is not user:group is refused', () => {
    for (const owner of ['deploy', 'deploy:', ':deploy', 'deploy:deploy; id', '1000:1000 '])
      expect(() => parse({ path: '/home/deploy/store', owner }), owner).toThrow(/user:group/i)
  })

  test('a mode that is not a four-digit octal string is refused', () => {
    // `'755'` is the dangerous one: `parseInt` would read it happily and the
    // declaration would look right, so the refusal is about the shape a reader
    // sees, not only about what the runtime can parse.
    for (const mode of ['755', '0999', 'rwxr-xr-x', '07555', ''])
      expect(() => parse({ path: '/home/deploy/store', owner: OWNER, mode }), mode).toThrow(
        /octal/i,
      )
  })
})

// Everything above tests the half that *decides*. Nothing above runs the half
// that writes — so gutting `apply` to `return { ...config, changed: false }`
// would leave it green, and a module whose effect no test invokes is an effect
// nobody has checked.
describe('the apply creates the directory, and not only a plan of one', () => {
  test('an absent path becomes a directory at the declared mode, through parents that did not exist', async () => {
    const machine = fakeMachine()
    // Nested on purpose. `recursive: true` is a step no test above reaches, and
    // a missing parent is exactly the state a rebuilt box starts in.
    const path = join(dir(), 'a', 'b', 'store')

    const result = await apply(machine, { path, mode: '0750' })

    expect(result.changed).toBe(true)
    expect(lstatSync(path).isDirectory()).toBe(true)
    expect(modeOf(path)).toBe('0750')
  })

  test('a second apply reports unchanged, having left the directory it made', async () => {
    const machine = fakeMachine()
    const path = join(dir(), 'store')

    // The first half is asserted, not assumed. "Nothing happened" satisfies
    // `changed: false` on its own, so an idempotence test whose only claim is
    // that the second run was quiet passes against an apply that never wrote.
    const first = await apply(machine, { path })
    expect(first.changed).toBe(true)
    expect(modeOf(path)).toBe('0755')

    const second = await apply(machine, { path })

    expect(second.changed).toBe(false)
    expect(modeOf(path)).toBe('0755')
  })

  test('a directory at the wrong mode is re-moded on disk', async () => {
    const machine = fakeMachine()
    const path = join(dir(), 'store')
    mkdirSync(path)
    chmodSync(path, 0o700)

    const result = await apply(machine, { path })

    expect(result.changed).toBe(true)
    expect(modeOf(path)).toBe('0755')
  })

  test('the mode survives a umask that would have clipped it at create time', async () => {
    // `mkdirSync`'s `mode` is masked by the process umask, so a create alone
    // lands at whatever the umask allows and the declaration silently does not
    // hold. Measured rather than reasoned about: 0755 under umask 027 creates
    // 0750.
    const machine = fakeMachine()
    const path = join(dir(), 'store')
    const previous = process.umask(0o027)
    try {
      await apply(machine, { path })
    } finally {
      process.umask(previous)
    }
    expect(modeOf(path)).toBe('0755')
  })

  test('what is already inside the directory is left exactly as it was', async () => {
    // The declared path is not empty on this box: `~/.local/share/app`
    // already holds gigabytes of state that the owning application
    // writes. A recursive chmod would rewrite every one of those modes as a
    // side effect of declaring the directory that contains them.
    const machine = fakeMachine()
    const path = join(dir(), 'store')
    mkdirSync(path)
    chmodSync(path, 0o700)
    const nested = join(path, 'sessions')
    mkdirSync(nested)
    chmodSync(nested, 0o700)
    const file = join(nested, 'session.jsonl')
    writeFileSync(file, 'a synced session\n')
    chmodSync(file, 0o600)

    await apply(machine, { path })

    expect(modeOf(path)).toBe('0755')
    expect(modeOf(nested)).toBe('0700')
    expect(modeOf(file)).toBe('0600')
    expect(readFileSync(file, 'utf8')).toBe('a synced session\n')
  })

  test('a regular file at the path survives the refusal byte for byte', async () => {
    // The refusal is `dirPlan`'s and is tested above. What is untested above is
    // that `apply` propagates it instead of catching it, and that it has not
    // already written by the time it does.
    const machine = fakeMachine()
    const path = join(dir(), 'store')
    writeFileSync(path, 'somebody else wrote this\n')

    await expect(apply(machine, { path })).rejects.toThrow(/not a directory|regular file/i)

    expect(lstatSync(path).isDirectory()).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('somebody else wrote this\n')
    // And it did not reach the machine at all — a refused plan must not have
    // already run a `chown` against the path it is refusing.
    expect(machine.commands).toEqual([])
  })
})

describe('the owner is converged through the one exec seam', () => {
  test('a directory owned by somebody else is chowned', async () => {
    // The failure this closes: a store directory left owned by root — by a
    // `mkdir` under sudo, or by a restore — is a store the user cannot write,
    // and nothing about `existsSync` says so.
    const machine = fakeMachine({ owner: 'root:root' })
    const path = join(dir(), 'store')

    const result = await apply(machine, { path })

    expect(result.changed).toBe(true)
    expect(machine.current()).toBe(OWNER)
    expect(machine.commands).toContain(renderChownCommand(OWNER, path))
  })

  test('an owner that already matches is not chowned, so the apply stays a no-op', async () => {
    const machine = fakeMachine()
    const path = join(dir(), 'store')
    mkdirSync(path, { mode: 0o755 })
    chmodSync(path, 0o755)

    const result = await apply(machine, { path })

    expect(result.changed).toBe(false)
    // Asked, and then not acted on. The query is what makes the no-op a
    // measurement rather than an assumption.
    expect(machine.commands).toEqual([renderOwnerQuery(path)])
  })

  test('an ownership fix on its own is a change, even when the filesystem half is a no-op', async () => {
    // The one path where `changed` can only come from the chown. Without it,
    // dropping the owner from what `changed` reports survives every other test
    // here — measured, because every other apply test that chowns is also
    // creating or re-moding, so its `changed: true` is already earned by the
    // filesystem half.
    const machine = fakeMachine({ owner: 'root:root' })
    const path = join(dir(), 'store')
    mkdirSync(path, { mode: 0o755 })
    chmodSync(path, 0o755)

    const result = await apply(machine, { path })

    expect(result.changed).toBe(true)
    expect(machine.current()).toBe(OWNER)
  })

  test('a chown that exits 0 and changes nothing is caught by the read-back', async () => {
    // An exit code says the command ran, not that it worked. This is the same
    // failure the read-back exists for, and the only thing that can see
    // it is asking the machine again.
    const machine = fakeMachine({ owner: 'root:root', silent: true })
    const path = join(dir(), 'store')

    await expect(apply(machine, { path })).rejects.toThrow(/root:root|did not/i)
  })

  test('a wrong mode and a wrong owner are both converged in one apply', async () => {
    const machine = fakeMachine({ owner: 'root:root' })
    const path = join(dir(), 'store')
    mkdirSync(path)
    chmodSync(path, 0o700)

    const result = await apply(machine, { path })

    expect(result.changed).toBe(true)
    expect(modeOf(path)).toBe('0755')
    expect(machine.current()).toBe(OWNER)
  })
})

describe('the commands sent to the machine', () => {
  test('the owner is asked for in exactly the form a declaration spells it', () => {
    // `stat -c '%U:%G'` rather than `statSync().uid` and a uid→name lookup:
    // one call, and the answer is already the string the config carries, so
    // neither side has to resolve anything.
    expect(renderOwnerQuery('/home/deploy/store')).toBe("stat -c '%U:%G' /home/deploy/store")
  })

  test('the chown goes through sudo, because the case that needs it is a root-owned directory', () => {
    // Matching the vm, systemd-unit and incus-storage-pool
    // convention on this host. Without it the one state a chown exists to fix
    // is the one state it cannot fix.
    expect(renderChownCommand(OWNER, '/home/deploy/store')).toBe(
      'sudo chown deploy:deploy /home/deploy/store',
    )
  })
})

describe('there is no destroy', () => {
  test('removing the directory is a human act', () => {
    // the same reasoning, and sharper here: this directory holds the
    // only copy of the store, so a `destroy` would be a code
    // path nothing exercises until the day it deletes the thing it was written
    // to manage.
    expect(hostDirModule.destroy).toBeUndefined()
  })
})

describe('modeOf', () => {
  test('reports four octal digits, so it compares against a declaration directly', () => {
    const path = join(dir(), 'store')
    mkdirSync(path)
    for (const mode of [0o700, 0o755, 0o775]) {
      chmodSync(path, mode)
      expect(modeOf(path)).toBe(`0${mode.toString(8)}`)
    }
  })

  test('a directory somebody set setgid on is still at its declared mode', () => {
    // Setuid/setgid/sticky are outside the comparison on purpose: this module
    // does not manage them, so counting them would make an apply report a drift
    // on a directory it will never converge.
    //
    // Set through a real `chmod`, and that is not incidental. `chmodSync`
    // **cannot set these bits in this runtime** — `0o2755`, `0o755 | 0o2000`
    // and the string `'2755'` all land at `40755`, measured. An earlier version
    // of this test used `chmodSync(path, 0o2755)` and was therefore a
    // byte-identical repeat of the `0o755` case above: it asserted the mask
    // while never producing a mode the mask applied to, and dropping the mask
    // did not fail it.
    const path = join(dir(), 'store')
    mkdirSync(path)
    execFileSync('chmod', ['2755', path])
    expect(statSync(path).mode & 0o7777).toBe(0o2755)

    expect(modeOf(path)).toBe('0755')
    expect(dirPlan(path, '0755')).toEqual({ action: 'noop' })
  })
})
