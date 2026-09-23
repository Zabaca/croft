import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { type Exec, withExec } from '../host-exec'
import { type IncusTarget, guestRef, incusCommand } from '../incus-core'
import {
  type ConfigArgForm,
  formShape,
  parseConfigSetForms,
  readConfigSetHelp,
} from '../incus-core/config-set-help'
import {
  buildDesiredConfig,
  buildInitFlags,
  findGuestInAnotherProject,
  parseKeyFile,
  pickIpv4,
  planConfigChanges,
  planDeviceAdds,
  renderCloudInit,
  renderConfigPair,
  renderCrossProjectRefusal,
  renderDeviceArgs,
  renderRootSizeArgs,
  vmModule,
} from './index'

const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyA james@mac'
const KEY_B = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABExampleKeyB deploy@build-host'

const parse = (s: string) => Bun.YAML.parse(s) as Record<string, any>

describe('renderCloudInit', () => {
  test('leads with the #cloud-config header cloud-init requires', () => {
    const out = renderCloudInit({ sshUser: 'deploy', authorizedKeys: [KEY_A] })
    expect(out.split('\n')[0]).toBe('#cloud-config')
  })

  test('injects every authorized key onto the ssh user', () => {
    const parsed = parse(renderCloudInit({ sshUser: 'deploy', authorizedKeys: [KEY_A, KEY_B] }))
    expect(parsed.users).toHaveLength(1)
    expect(parsed.users[0].name).toBe('deploy')
    expect(parsed.users[0].ssh_authorized_keys).toEqual([KEY_A, KEY_B])
  })

  test('grants the ssh user passwordless sudo', () => {
    const parsed = parse(renderCloudInit({ sshUser: 'deploy', authorizedKeys: [KEY_A] }))
    expect(parsed.users[0].sudo).toContain('NOPASSWD')
  })

  test('never sets ssh_pwauth — it writes a stub sshd_config that breaks key auth', () => {
    // cloud-init's ssh_pwauth handler rewrites /etc/ssh/sshd_config during the
    // config stage, before `packages:` has installed openssh-server. The result
    // is a 26-byte file containing only `PasswordAuthentication no`, so every
    // other setting falls back to OpenSSH's compiled-in default — including
    // `UsePAM no`, under which sshd refuses any account whose shadow field is
    // `!`. That is exactly what cloud-init's own password locking produces, so
    // the guest ends up unreachable. Use a drop-in instead.
    const parsed = parse(renderCloudInit({ sshUser: 'deploy', authorizedKeys: [KEY_A] }))
    expect(parsed.ssh_pwauth).toBeUndefined()
  })

  test('disables password auth through an sshd drop-in that keeps PAM on', () => {
    const parsed = parse(renderCloudInit({ sshUser: 'deploy', authorizedKeys: [KEY_A] }))
    const dropIn = parsed.write_files.find((f: { path: string }) =>
      f.path.startsWith('/etc/ssh/sshd_config.d/'),
    )
    expect(dropIn).toBeDefined()
    expect(dropIn.content).toContain('PasswordAuthentication no')
    expect(dropIn.content).toContain('UsePAM yes')
  })

  test('guarantees the drop-in is actually read, then restarts sshd', () => {
    const parsed = parse(renderCloudInit({ sshUser: 'deploy', authorizedKeys: [KEY_A] }))
    const runcmd = JSON.stringify(parsed.runcmd)
    expect(runcmd).toContain('Include /etc/ssh/sshd_config.d/')
    expect(runcmd).toContain('restart')
  })

  test('merges extraUserData, concatenating array keys rather than clobbering', () => {
    const parsed = parse(
      renderCloudInit({
        sshUser: 'deploy',
        authorizedKeys: [KEY_A],
        extraUserData: 'packages:\n  - htop\n',
      }),
    )
    expect(parsed.packages).toContain('openssh-server')
    expect(parsed.packages).toContain('htop')
  })

  test('lets extraUserData override a scalar key outright', () => {
    const parsed = parse(
      renderCloudInit({
        sshUser: 'deploy',
        authorizedKeys: [KEY_A],
        extraUserData: 'package_update: false\n',
      }),
    )
    expect(parsed.package_update).toBe(false)
  })

  test('emits block-style yaml, so the seed is readable when debugging in the guest', () => {
    const out = renderCloudInit({ sshUser: 'deploy', authorizedKeys: [KEY_A] })
    expect(out).toContain('\nusers:')
    expect(out).not.toContain('{users:')
  })

  test('survives a key comment containing a comma', () => {
    const tricky = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyC james, personal laptop'
    const parsed = parse(renderCloudInit({ sshUser: 'deploy', authorizedKeys: [tricky] }))
    expect(parsed.users[0].ssh_authorized_keys).toEqual([tricky])
  })

  test('rejects an empty key set — a VM with no keys is unreachable', () => {
    expect(() => renderCloudInit({ sshUser: 'deploy', authorizedKeys: [] })).toThrow()
  })
})

describe('planConfigChanges', () => {
  test('returns only the keys whose values drifted', () => {
    expect(
      planConfigChanges(
        { 'limits.cpu': '4', 'limits.memory': '8GiB' },
        { 'limits.cpu': '8', 'limits.memory': '8GiB' },
      ),
    ).toEqual({ 'limits.cpu': '8' })
  })

  test('is a no-op when nothing drifted', () => {
    expect(planConfigChanges({ 'limits.cpu': '4' }, { 'limits.cpu': '4' })).toEqual({})
  })

  test('treats an absent key as a change', () => {
    expect(planConfigChanges({}, { 'limits.cpu': '4' })).toEqual({ 'limits.cpu': '4' })
  })

  test('never proposes converging create-only cloud-init keys', () => {
    // cloud-init runs once, on first boot. Re-setting user-data on a live
    // instance changes nothing inside it, so surfacing it as a pending change
    // would report drift that no apply can ever close.
    expect(
      planConfigChanges(
        { 'cloud-init.user-data': 'old' },
        { 'cloud-init.user-data': 'new', 'limits.cpu': '4' },
      ),
    ).toEqual({ 'limits.cpu': '4' })
  })
})

describe('buildDesiredConfig', () => {
  test('maps cpu and memory to incus limits', () => {
    expect(buildDesiredConfig({ cpu: 6, memory: '8GiB', incusConfig: {} })).toEqual({
      'limits.cpu': '6',
      'limits.memory': '8GiB',
    })
  })

  test('passes arbitrary incus config keys through, e.g. nesting for docker-in-container', () => {
    expect(buildDesiredConfig({ incusConfig: { 'security.nesting': 'true' } })).toEqual({
      'security.nesting': 'true',
    })
  })

  test('the dedicated cpu/memory fields win over duplicate incusConfig keys', () => {
    expect(
      buildDesiredConfig({
        cpu: 6,
        incusConfig: { 'limits.cpu': '2', 'security.nesting': 'true' },
      }),
    ).toEqual({ 'limits.cpu': '6', 'security.nesting': 'true' })
  })

  test('unset fields do not appear at all', () => {
    expect(buildDesiredConfig({ incusConfig: {} })).toEqual({})
  })
})

describe('buildInitFlags', () => {
  test('a container gets no --vm', () => {
    expect(buildInitFlags({ type: 'container', desired: {} })).toBe('')
  })

  test('a virtual machine gets --vm', () => {
    expect(buildInitFlags({ type: 'virtual-machine', desired: {} })).toBe('--vm')
  })

  test('storagePool pins the instance to a pool with -s', () => {
    expect(buildInitFlags({ type: 'container', storagePool: 'sessions', desired: {} })).toBe(
      '-s sessions',
    )
  })

  test('without storagePool incus falls back to the profile pool, so nothing is emitted', () => {
    expect(buildInitFlags({ type: 'container', desired: { 'limits.cpu': '4' } })).toBe(
      `--config 'limits.cpu=4'`,
    )
  })

  test('config pairs are quoted as wholes, after the structural flags', () => {
    expect(
      buildInitFlags({
        type: 'virtual-machine',
        storagePool: 'sessions',
        desired: { 'limits.cpu': '4', 'limits.memory': '8GiB' },
      }),
    ).toBe(`--vm -s sessions --config 'limits.cpu=4' --config 'limits.memory=8GiB'`)
  })

  test('the pool is create-only — it never reaches the config incus can converge', () => {
    // -s writes an instance-local root device at init. There is no config key
    // to diff, so a pool change on a live guest must be a delete-and-recreate,
    // never a silent no-op that leaves the guest on the old pool.
    expect(buildDesiredConfig({ cpu: 4, incusConfig: {} })).toEqual({ 'limits.cpu': '4' })
  })
})

describe('renderRootSizeArgs', () => {
  // Everything after `incus`; the invocation is applied by the daemon wrapper,
  // which is what stops a call site aiming a command at the wrong machine. The
  // full command lines both branches produce are pinned byte-for-byte by the
  // create tests further down.
  //
  // `override` copies an *inherited* device down onto the instance and fails
  // with "The device already exists" once one is instance-local — which is
  // exactly what `-s <pool>` creates at init.
  test('a pooled guest already owns its root device, so the size is set on it', () => {
    expect(renderRootSizeArgs({ name: 'agent-base', disk: '20GiB', storagePool: 'sessions' })).toBe(
      'config device set agent-base root size=20GiB',
    )
  })

  test('a guest whose root comes from the profile has to override first', () => {
    expect(renderRootSizeArgs({ name: 'agent-vm', disk: '50GiB' })).toBe(
      'config device override agent-vm root size=50GiB',
    )
  })

  test('a remote guest is named to the remote, in either branch', () => {
    // The verb is about where the root device came from; the name is about
    // which daemon holds it. Neither decides the other.
    expect(
      renderRootSizeArgs({ name: 'ws', disk: '40GiB', target: { remote: 'build-host' } }),
    ).toBe('config device override build-host:ws root size=40GiB')
    expect(
      renderRootSizeArgs({
        name: 'ws',
        disk: '40GiB',
        storagePool: 'sessions',
        target: { remote: 'build-host' },
      }),
    ).toBe('config device set build-host:ws root size=40GiB')
  })
})

describe('renderConfigPair', () => {
  test('quotes the whole key=value so spaced values survive the shell', () => {
    // e.g. raw.apparmor rules contain spaces
    expect(renderConfigPair('raw.apparmor', 'deny mount fstype=binfmt_misc,')).toBe(
      `'raw.apparmor=deny mount fstype=binfmt_misc,'`,
    )
  })

  test('escapes embedded single quotes', () => {
    expect(renderConfigPair('user.note', "it's")).toBe(`'user.note=it'\\''s'`)
  })
})

describe('parseKeyFile', () => {
  test('reads a single-key .pub file', () => {
    expect(parseKeyFile(`${KEY_A}\n`)).toEqual([KEY_A])
  })

  test('reads every key from a multi-key authorized_keys file', () => {
    // Pointing authorizedKeyFiles at ~/.ssh/authorized_keys is the natural way
    // to give a guest the same key set that already reaches the host, so this
    // must not collapse the file into one bogus key.
    expect(parseKeyFile(`${KEY_A}\n${KEY_B}\n`)).toEqual([KEY_A, KEY_B])
  })

  test('skips blank lines and comments', () => {
    expect(parseKeyFile(`# my keys\n\n${KEY_A}\n\n`)).toEqual([KEY_A])
  })

  test('tolerates CRLF line endings', () => {
    expect(parseKeyFile(`${KEY_A}\r\n${KEY_B}\r\n`)).toEqual([KEY_A, KEY_B])
  })
})

describe('renderDeviceArgs', () => {
  test('emits the device type positionally, as incus expects', () => {
    expect(renderDeviceArgs('tun', { type: 'unix-char', path: '/dev/net/tun' })).toBe(
      'tun unix-char path=/dev/net/tun',
    )
  })

  test('carries every remaining key as key=value', () => {
    const out = renderDeviceArgs('data', { type: 'disk', source: '/srv/data', path: '/data' })
    expect(out.startsWith('data disk ')).toBe(true)
    expect(out).toContain('source=/srv/data')
    expect(out).toContain('path=/data')
  })

  test('throws when type is missing rather than emitting a broken command', () => {
    expect(() => renderDeviceArgs('tun', { path: '/dev/net/tun' })).toThrow(/type/i)
  })
})

describe('planDeviceAdds', () => {
  const tun = { type: 'unix-char', path: '/dev/net/tun' }

  test('adds a device the guest does not have', () => {
    expect(planDeviceAdds({}, { tun })).toEqual({ tun })
  })

  test('leaves an already-attached device alone', () => {
    expect(planDeviceAdds({ tun }, { tun })).toEqual({})
  })

  test('ignores unrelated devices the guest already carries', () => {
    expect(planDeviceAdds({ root: { type: 'disk' } }, { tun })).toEqual({ tun })
  })
})

describe('pickIpv4', () => {
  const onIface = (iface: string, addresses: unknown[]) => ({
    state: { network: { [iface]: { addresses } } },
  })

  test('finds the guest global IPv4', () => {
    expect(
      pickIpv4(
        onIface('eth0', [
          { family: 'inet6', address: 'fd42:3250:38ba:b3f7::1', scope: 'global' },
          { family: 'inet', address: '10.196.88.42', scope: 'global' },
        ]),
      ),
    ).toBe('10.196.88.42')
  })

  test('ignores loopback', () => {
    expect(
      pickIpv4(onIface('lo', [{ family: 'inet', address: '127.0.0.1', scope: 'local' }])),
    ).toBeNull()
  })

  test('ignores link-local autoconfiguration addresses', () => {
    expect(
      pickIpv4(onIface('eth0', [{ family: 'inet', address: '169.254.10.1', scope: 'link' }])),
    ).toBeNull()
  })

  test('returns null before a VM agent has reported state', () => {
    // `incus list` returns state: null for a VM until incus-agent is up, which
    // is why apply has to poll rather than read once.
    expect(pickIpv4({ state: null })).toBeNull()
    expect(pickIpv4({})).toBeNull()
  })
})

// ── The machine, substituted ────────────────────────────────────────────────
//
// Everything above tests the half of this module that *decides* — what
// cloud-init to render, which config keys drifted, how a flag is spelled. None
// of it runs `apply`, and until this file was extended nothing in the suite did:
// gutting `apply` to `return { name: config.name, type: config.type, sshUser:
// config.sshUser, ipv4: null, created: false, changed: false }` left the whole
// suite green. That is the audit finding this seam was built for, and the
// module could not be fixed the way `host-symlink`'s was — there is one incus
// daemon on this box and a test that ran the real thing would create guests.

describe('the machine is reached through the seam', () => {
  const source = fs.readFileSync(`${import.meta.dir}/index.ts`, 'utf8')
  const imports = source.split('\n').filter((line) => /^import\b/.test(line))

  test('nothing here imports node:child_process any more', () => {
    // The ticket's first done-when, and the property every test below rests
    // on: `withExec` can only stand in front of a module that goes through
    // `exec`. A module still calling `execSync` would run `sudo incus init`
    // against the real daemon from a unit test and the fake would never be
    // reached.
    expect(imports.filter((line) => line.includes('node:child_process'))).toEqual([])
  })

  test('and it reaches the machine through host-exec instead', () => {
    expect(imports.filter((line) => line.includes('../host-exec'))).toHaveLength(1)
  })
})

// ── The argv incus documents, read out of the binary ────────────────────────
//
// `incus-core/incus-config-set.help.txt` is `incus config set --help` captured
// verbatim from incus 6.0.0 on build-host on 2026-08-18: stdout, exit 0, no daemon
// and no sudo, and byte-identical at `COLUMNS=40`, at `COLUMNS=200` and through
// a pipe, so it is a transcript rather than a rendering of this terminal. It
// It sits next to the parsers it anchors, so that when a second module asks
// the binary the same question there is one transcript and two renderers
// cannot drift from it separately.
//
// It is here because this repo has already shipped a module and its fake wrong
// **together**. `incus config trust list-tokens` marshals an untagged Go struct
// and therefore answers PascalCase; the module read snake_case and the fake
// *rendered* snake_case, so every test passed and the defect surfaced only when
// a real apply reached the live daemon. Structural mutation cannot catch that —
// mutating either side is caught by the other being right.
//
// So the expected side of the guard at the bottom of this file is not a literal
// anyone can edit alongside the renderer. It is computed from this transcript,
// which says in its own words which form incus documents and which it keeps
// "for backward compatibility". Reverting the renderer fails the guard, and
// making the guard pass again means editing a verbatim transcript of a binary
// that `the transcript still matches this box` re-derives on every run.
//
// The honest limit, stated rather than left to be discovered: an author who
// edits the renderer *and* the transcript still passes, on a box with no incus.
// The anchor raises the cost of co-drift and makes it visible in a diff; it does
// not make it impossible, and nothing in a unit test can.

const CONFIG_SET_HELP = readConfigSetHelp()

/**
 * What incus does with the config arguments of a `config set`, i.e. everything
 * after the instance reference.
 *
 * Measured on build-host, incus 6.0.0, 2026-08-18, against an instance that does
 * not exist — so every probe below failed and none of them changed anything.
 * The point of using a missing instance is that the two failures are
 * *distinguishable*: `Invalid key=value configuration` is raised while parsing
 * argv, `Failed to fetch instance … Instance not found` only after the parse
 * has succeeded, so which one comes back says whether the form was accepted.
 *
 *   `set <gone> limits.cpu=2`                 → Instance not found  (accepted)
 *   `set <gone> limits.cpu 2`                 → Instance not found  (accepted)
 *   `set <gone> limits.cpu=2 limits.memory=1GiB`
 *                                             → Instance not found  (accepted)
 *   `set <gone> limits.cpu a=b`               → Instance not found  (accepted)
 *   `set <gone> limits.cpu=2 limits.memory`   → Invalid key=value configuration:
 *                                               limits.memory
 *   `set <gone> limits.cpu 2 3`               → Invalid key=value configuration:
 *                                               limits.cpu
 *   `set <gone> cloud-init.user-data=<the real 717-byte seed>`
 *                                             → Instance not found  (accepted)
 *
 * That last one is the measurement that matters, and it retires a claim this
 * file used to make. The seed carries newlines *and* an `=` of its own
 * (`sudo: ALL=(ALL) NOPASSWD:ALL`), and incus splits on the **first** `=` only,
 * so a multi-KB YAML value survives the modern form intact. The comment that
 * stood here before said it could not, and nothing had asked the binary.
 *
 * One shape is deliberately not modelled, because the module cannot emit it and
 * probing it further would have written to the daemon: with exactly two argv
 * words and no `=` in either, `incus config set <a> <b>` does not name an
 * instance at all — it is the legacy form applied to the **server**, which
 * `set <gone> limits.cpu` proved by answering `cannot set
 * '<gone>' to 'limits.cpu': unknown key`. Every call this module makes names an
 * instance, so the ambiguity is out of reach here.
 */
export function readConfigArgs(args: string[]): { key: string; value: string }[] {
  if (args.length === 2 && !args[0]!.includes('=')) return [{ key: args[0]!, value: args[1]! }]

  return args.map((arg) => {
    // incus raises this before it fetches the instance, so a fake that checked
    // the guest first would answer the wrong error for a wrong command.
    if (!arg.includes('=')) incusError(`Error: Invalid key=value configuration: ${arg}`)
    const [key, ...value] = arg.split('=')
    return { key: key!, value: value.join('=') }
  })
}

// ── An in-memory incus ──────────────────────────────────────────────────────
//
// A machine, not a call recorder. It answers `incus list --format
// json` from its own state and it *mutates* that state on `init`, `start`,
// `config set` and `config device add`, so the second apply sees the world the
// first one left behind and "no-op" is a claim about a converge that settled
// rather than about an apply that did nothing.
//
// It also performs the one piece of shell the module relies on: `config set …
// cloud-init.user-data="$(cat /tmp/…)"` is a command substitution, and a fake
// that stored the literal `$(cat …)` would let a broken seed pass. Reading the
// file is what a shell does, and it is what makes the guest's stored seed
// assertable — which is the only end-to-end path from a declaration's
// `authorizedKeys` to what the guest boots with.
//
// A recorder would have to be told which arguments are correct, which is the
// assertion restating the implementation.

interface FakeGuest {
  name: string
  type: 'container' | 'virtual-machine'
  status: 'Stopped' | 'Running'
  pool: string | undefined
  config: Record<string, string>
  devices: Record<string, Record<string, string>>
  ipv4: string | null
}

/**
 * `sudo incus …` split the way a shell would.
 *
 * Single quotes are how `renderConfigPair` protects a value with spaces in it,
 * and `'\''` is how it protects a quote, so both have to be understood here or
 * a config value would arrive at the guest with its quoting still attached.
 *
 * `readFile` is what the shell does with `$(cat …)`, and it is a parameter for
 * one caller: the argv-form guard at the bottom of this file runs after the
 * apply has unlinked the seed's temp file, and asks a question the contents
 * cannot answer anyway. Substituting an opaque word there is not a weakening —
 * it is the stricter reading, because the `=` incus splits a `key=value` on has
 * to be in the argv *the module wrote*, and an `=` arriving out of the YAML
 * would be the wrong one.
 */
function tokenise(
  command: string,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf8'),
): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | null = null

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }
    if (command.startsWith('$(cat ', i)) {
      // The substitution the module uses to hand over multi-KB of YAML without
      // escaping it into argv. A shell reads the file here; so does this.
      const close = command.indexOf(')', i)
      current += readFile(command.slice(i + '$(cat '.length, close).trim())
      started = true
      i = close
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }
    if (ch === '\\') {
      current += command[++i] ?? ''
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started || current !== '') tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }
  if (started || current !== '') tokens.push(current)
  return tokens
}

/** How incus reports a failure: a non-zero exit with the reason on stderr. */
const incusError = (reason: string): never => {
  throw Object.assign(new Error('Command failed'), { status: 1, stdout: '', stderr: reason })
}

interface FakeOptions {
  /**
   * The address this daemon answers to. Absent is the local unix socket, which
   * is every declaration in this repo.
   *
   * It is enforced rather than tolerated: a command carrying the wrong
   * invocation, or naming a guest without this endpoint's scope, is refused.
   * That is what a real misaddressed command does — it goes to a *different*
   * daemon — and refusing here is the only way a test can tell "the remote form
   * was rendered" from "a local command happened to work".
   */
  endpoint?: IncusTarget
  /** Guests already on the daemon before the first apply, in this endpoint's project. */
  guests?: Partial<FakeGuest>[]
  /**
   * Guests this daemon holds in **other** incus projects.
   *
   * Invisible to the scoped `incus list` — which is the whole point, and what
   * makes the trap silent — and visible only to `--all-projects`. Modelled as a
   * separate list rather than by giving every fake guest a project, because
   * "the scoped read cannot see it" is the property under test and a shared map
   * with a filter would let a wrong filter pass for the wrong reason.
   */
  elsewhere?: { name: string; project: string }[]
  /** `incus list` itself fails — a daemon that is down, not a missing guest. */
  listFails?: string
  /** Nothing can be exec'd into: the guest boots but never answers. */
  neverExecutable?: boolean
  /** What `cloud-init status --wait` exits with. 0 is done, 2 is done-with-warnings. */
  cloudInitCode?: number
}

function fakeIncus(options: FakeOptions = {}) {
  // How this daemon expects to be addressed. Read off the same two renderers
  // the module uses — not because the test may restate the implementation, but
  // because "the same answer everywhere" is the property incus-core exists for,
  // and the byte-exact command lists below are what pin the answer itself.
  const invocation = incusCommand(options.endpoint)
  // The same endpoint with the project stripped — the only form incus accepts
  // beside `--all-projects`, and identical to `invocation` when no project is
  // named, which is why the local tests below are unaffected by any of this.
  const across = incusCommand(
    options.endpoint?.remote === undefined ? undefined : { remote: options.endpoint.remote },
  )
  const scope = guestRef(options.endpoint, '')
  /** What this endpoint's own guests report as their project on an `--all-projects` row. */
  const ownProject = options.endpoint?.project ?? 'default'

  const guests = new Map<string, FakeGuest>()
  for (const guest of options.guests ?? []) {
    const name = guest.name!
    guests.set(name, {
      name,
      type: 'container',
      status: 'Stopped',
      pool: undefined,
      config: {},
      devices: {},
      ipv4: null,
      ...guest,
    })
  }
  const commands: string[] = []
  const mutations: string[] = []
  let addresses = 0

  /**
   * Resolve a guest *as this endpoint was asked for it*.
   *
   * A reference without this endpoint's scope is a reference to somewhere else,
   * so it is a miss here rather than a hit — which is the whole point. `incus
   * --project zabaca start dev-ws` is well-formed and acts on the local
   * daemon; a fake that shrugged the scope off would let that pass.
   */
  const guestOr404 = (ref: string): FakeGuest =>
    (ref.startsWith(scope) ? guests.get(ref.slice(scope.length)) : undefined) ??
    incusError(`Error: Instance not found: ${ref}`)

  const render = (): string =>
    JSON.stringify(
      [...guests.values()].map((guest) => ({
        name: guest.name,
        status: guest.status,
        config: guest.config,
        devices: guest.devices,
        // A stopped guest, and a VM whose agent has not come up, report no
        // state at all — which is why the module polls instead of reading once.
        state:
          guest.status === 'Running' && guest.ipv4 !== null
            ? {
                network: {
                  lo: { addresses: [{ family: 'inet', address: '127.0.0.1', scope: 'local' }] },
                  eth0: { addresses: [{ family: 'inet', address: guest.ipv4, scope: 'global' }] },
                },
              }
            : null,
      })),
    )

  const renderAcrossProjects = (): string =>
    JSON.stringify([
      ...[...guests.values()].map((guest) => ({
        name: guest.name,
        project: ownProject,
        status: guest.status,
        config: guest.config,
      })),
      ...(options.elsewhere ?? []).map((guest) => ({
        name: guest.name,
        project: guest.project,
        status: 'Running',
        config: {},
      })),
    ])

  const exec: Exec = (command) => {
    commands.push(command)

    // The invocation is checked before anything is parsed. A command addressed
    // to another daemon never reaches this one, so it cannot be answered here.
    const addressedBy = (prefix: string) => command === prefix || command.startsWith(`${prefix} `)
    // `across` is the same endpoint without `--project`, and it is accepted for
    // exactly one question — see the `list` branch, which refuses it for any
    // other. Tried second, so a projected command is still read as projected.
    const used = addressedBy(invocation) ? invocation : addressedBy(across) ? across : null
    if (used === null) {
      throw new Error(`fake incus: this daemon answers to \`${invocation}\`, not: ${command}`)
    }
    const argv = tokenise(command.slice(used.length).trim())
    const [verb, ...rest] = argv

    // Listing and probing are reads; everything else changes the daemon.
    const tail = rest.slice(1).join(' ')
    const reads =
      verb === 'list' ||
      (verb === 'exec' && (tail === '-- true' || tail === '-- cloud-init status --wait'))
    if (!reads) mutations.push(command)

    if (verb === 'list') {
      if (options.listFails !== undefined) incusError(options.listFails)
      // `incus list [<remote>:] --format json`. The optional positional is the
      // remote scope, and it is parsed rather than string-matched so that a
      // list aimed at the wrong endpoint fails the way a real one would.
      const given = rest[0] === undefined || rest[0].startsWith('--') ? '' : rest[0]
      if (given !== scope) incusError(`Error: remote "${given.replace(/:$/, '')}" doesn't exist`)
      const flags = (given === '' ? rest : rest.slice(1)).join(' ')
      const projectless = used === across && across !== invocation
      if (flags === '--format json') {
        // A projectless scoped list is a different question from the one the
        // module asks, and answering it would let an implementation that forgot
        // `--project` read the wrong project's guests and look correct.
        if (projectless)
          throw new Error(`fake incus: a scoped list must name its project: ${command}`)
        return render()
      }
      if (flags === '--all-projects --format json') {
        // Measured on build-host, incus 6.0.0, 2026-08-18: the two flags are
        // mutually exclusive and incus says so rather than ignoring one.
        if (!projectless && across !== invocation)
          incusError(`Error: Can't specify --project with --all-projects`)
        return renderAcrossProjects()
      }
      throw new Error(`fake incus: refusing unrecognised list: ${command}`)
    }

    if (verb === 'init') {
      const [image, ref, ...flags] = rest
      if (!ref!.startsWith(scope)) incusError(`Error: remote for "${ref}" doesn't exist`)
      const name = ref!.slice(scope.length)
      if (guests.has(name)) incusError(`Error: Instance already exists: ${name}`)
      const config: Record<string, string> = { 'image.source': image! }
      let pool: string | undefined
      let type: FakeGuest['type'] = 'container'
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '--vm') type = 'virtual-machine'
        else if (flags[i] === '-s') pool = flags[++i]
        else if (flags[i] === '--config') {
          const [key, ...value] = flags[++i]!.split('=')
          config[key!] = value.join('=')
        } else incusError(`Error: unknown flag ${flags[i]}`)
      }
      guests.set(name, {
        name,
        type,
        status: 'Stopped',
        pool,
        config,
        // `-s <pool>` writes an instance-local root device at creation; without
        // it the guest inherits one from the profile and has none of its own.
        devices: pool === undefined ? {} : { root: { type: 'disk', pool } },
        ipv4: null,
      })
      return ''
    }

    if (verb === 'config' && rest[0] === 'set') {
      // Parsed before the instance is fetched, because that is the order incus
      // does it in — `Invalid key=value configuration` comes back for a guest
      // that does not exist, where `Instance not found` would if the argv had
      // been accepted. See `readConfigArgs`, which holds those measurements.
      //
      // Both forms, because incus accepts both, and **this module now emits
      // only one**. That asymmetry is the point: the fake is anchored to the
      // binary rather than mirrored off the renderer, so it cannot be the thing
      // that makes a reverted renderer look correct. What catches a revert is
      // `every config set the module emits is the form incus documents`, whose
      // expected side is the binary's own help text.
      const pairs = readConfigArgs(rest.slice(2))
      const guest = guestOr404(rest[1]!)
      for (const { key, value } of pairs) guest.config[key] = value
      return ''
    }

    if (verb === 'config' && rest[0] === 'device') {
      const [action, name, device, ...props] = rest.slice(1)
      const guest = guestOr404(name!)
      if (action === 'add') {
        if (guest.devices[device!]) incusError(`Error: The device already exists: ${device}`)
        const [type, ...pairs] = props
        guest.devices[device!] = { type: type! }
        for (const pair of pairs) {
          const [key, ...value] = pair.split('=')
          guest.devices[device!]![key!] = value.join('=')
        }
        return ''
      }
      // `override` pulls a profile-inherited device down onto the instance and
      // fails once one is instance-local; `set` edits the one already there.
      // Getting these the wrong way round is the bug renderRootSizeArgs
      // exists to avoid, so the fake refuses both wrong orders.
      const existing = guest.devices[device!]
      if (action === 'override' && existing)
        incusError(`Error: The device already exists: ${device}`)
      if (action === 'set' && !existing) incusError(`Error: The device doesn't exist: ${device}`)
      const target = (guest.devices[device!] ??= { type: 'disk' })
      for (const pair of props) {
        const [key, ...value] = pair.split('=')
        target[key!] = value.join('=')
      }
      return ''
    }

    if (verb === 'start') {
      const guest = guestOr404(rest[0]!)
      guest.status = 'Running'
      guest.ipv4 = `10.196.88.${++addresses}`
      return ''
    }

    if (verb === 'exec') {
      const guest = guestOr404(rest[0]!)
      if (guest.status !== 'Running') incusError('Error: Instance is not running')
      if (options.neverExecutable === true) incusError('Error: VM agent is not currently running')
      if (rest.slice(1).join(' ') === '-- cloud-init status --wait') {
        const code = options.cloudInitCode ?? 0
        if (code !== 0) {
          throw Object.assign(new Error('Command failed'), {
            status: code,
            stdout: 'status: error',
            stderr: '',
          })
        }
        return 'status: done\n'
      }
      return ''
    }

    if (verb === 'delete') {
      const guest = guestOr404(rest[rest.length - 1]!)
      guests.delete(guest.name)
      return ''
    }

    throw new Error(`fake incus: refusing unrecognised command: ${command}`)
  }

  return {
    exec,
    guests,
    /** Everything run, in order. */
    commands,
    /** Only what changed the daemon — listing and probing a guest are not changes. */
    mutations,
  }
}

const APPLY_CTX = { secrets: {}, imports: {}, projectRoot: '/tmp' }

// ── the seed is a create-time input, and is read only when creating ─────────
//
// `authorizedKeyFiles` names files on the machine running the apply, and the
// cloud-init seed built from them is used on exactly one path: creating the
// guest. Reading them for a guest that already exists makes every converge
// depend on the operator's own `~/.ssh`, which is fine while one machine
// converges and wrong the moment the Owner repo does it from anywhere
//
// Found by applying an unchanged declaration from a second machine: the guest
// was RUNNING and had been for days, and the apply died with
// `ENOENT: ~/.ssh/authorized_keys` — a file the seed would not have been used
// for even if it had existed.
describe('a converge of an existing guest reads no key files', () => {
  test('a missing authorizedKeyFiles path is not touched when the guest is there', async () => {
    const daemon = fakeIncus({
      guests: [{ name: 'already-here', status: 'Running', ipv4: '10.196.88.9' }],
    })
    const result = await applyVm(daemon, {
      name: 'already-here',
      sshUser: 'deploy',
      authorizedKeys: [KEY_A],
      authorizedKeyFiles: ['/definitely/not/a/path/authorized_keys'],
    })
    expect(result.created).toBe(false)
    // And it really was the existing guest, not a silently created second one.
    expect(daemon.mutations.some((c) => c.includes('init'))).toBe(false)
  })

  test('and the same missing path still fails when the guest must be created', async () => {
    // The other direction, so this is not "stop reading key files": on the
    // create path the seed is the only way a key reaches the guest, and a
    // declaration naming a file that is not there is a broken declaration.
    const daemon = fakeIncus({ guests: [] })
    expect(
      applyVm(daemon, {
        name: 'brand-new',
        sshUser: 'deploy',
        authorizedKeys: [KEY_A],
        authorizedKeyFiles: ['/definitely/not/a/path/authorized_keys'],
      }),
    ).rejects.toThrow(/ENOENT|no such file/i)
  })
})

const applyVm = (daemon: { exec: Exec }, config: Record<string, unknown>) =>
  withExec(daemon.exec, () => vmModule.apply(vmModule.configSchema.parse(config), APPLY_CTX))

const destroyVm = (daemon: { exec: Exec }, config: Record<string, unknown>) =>
  withExec(daemon.exec, () => vmModule.destroy!(vmModule.configSchema.parse(config), APPLY_CTX))

/** The smallest declaration the schema accepts, plus a name per test. */
const declare = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  sshUser: 'deploy',
  authorizedKeys: [KEY_A],
  ...extra,
})

describe('the apply creates the guest, and not only a plan of one', () => {
  test('an undeclared guest ends up existing, running and reachable', async () => {
    const daemon = fakeIncus()

    const result = await applyVm(daemon, declare('apply-creates', { type: 'virtual-machine' }))

    // The daemon's state, not the return value. `created: true` is satisfied by
    // a module that returns it without running anything.
    const guest = daemon.guests.get('apply-creates')!
    expect(guest.status).toBe('Running')
    expect(guest.type).toBe('virtual-machine')
    expect(result).toMatchObject({ created: true, changed: true, sshUser: 'deploy' })
    // Read back off the daemon, which is why apply polls rather than composing
    // an address from config.
    expect(result.ipv4).toBe(guest.ipv4)
  })

  test('the guest is seeded with the keys the declaration named', async () => {
    // The only end-to-end path from `authorizedKeys` to what the guest boots
    // with. Every test above this one stops at the rendered YAML string.
    const daemon = fakeIncus()

    await applyVm(daemon, declare('apply-seeds', { authorizedKeys: [KEY_A, KEY_B] }))

    const seed = parse(daemon.guests.get('apply-seeds')!.config['cloud-init.user-data']!)
    expect(seed.users[0].ssh_authorized_keys).toEqual([KEY_A, KEY_B])
    expect(seed.users[0].name).toBe('deploy')
  })

  test('the seed is handed over through a temp file that does not outlive the apply', async () => {
    // It is multi-KB of YAML and it carries every key that reaches the guest,
    // so it goes via a file rather than argv — and the file is removed in a
    // `finally`, which nothing else here would notice.
    const daemon = fakeIncus()
    const seedFile = path.join(os.tmpdir(), 'zbc-cloud-init-apply-tmpfile.yaml')

    await applyVm(daemon, declare('apply-tmpfile'))

    expect(daemon.guests.get('apply-tmpfile')!.config['cloud-init.user-data']).toContain(
      '#cloud-config',
    )
    expect(fs.existsSync(seedFile)).toBe(false)
  })

  test('a declared disk quota is applied to the guest’s own root device', async () => {
    const daemon = fakeIncus()

    await applyVm(daemon, declare('apply-disk', { disk: '20GiB', storagePool: 'sessions' }))

    // `-s sessions` made the root device instance-local at init, so the size is
    // `set` on it. The fake refuses an `override` of a device that already
    // exists, exactly as incus does, so the wrong verb fails the apply here.
    expect(daemon.guests.get('apply-disk')!.devices.root).toEqual({
      type: 'disk',
      pool: 'sessions',
      size: '20GiB',
    })
  })

  test('a declared device is attached at creation', async () => {
    const daemon = fakeIncus()

    await applyVm(
      daemon,
      declare('apply-device', { devices: { tun: { type: 'unix-char', path: '/dev/net/tun' } } }),
    )

    expect(daemon.guests.get('apply-device')!.devices.tun).toEqual({
      type: 'unix-char',
      path: '/dev/net/tun',
    })
  })
})

describe('a second apply is a no-op, having first changed something', () => {
  test('nothing is sent to the daemon the second time', async () => {
    const daemon = fakeIncus()

    // Asserted, not assumed. "Nothing happened" satisfies `changed: false` on
    // its own, so an idempotence test whose only claim is that the second run
    // was quiet passes against an apply that never ran anything at all.
    const first = await applyVm(daemon, declare('twice', { cpu: 4 }))
    expect(first.created).toBe(true)
    const afterFirst = daemon.mutations.length
    expect(afterFirst).toBeGreaterThan(0)

    const second = await applyVm(daemon, declare('twice', { cpu: 4 }))

    expect(second).toMatchObject({ created: false, changed: false })
    expect(daemon.mutations).toHaveLength(afterFirst)
    expect(daemon.guests.get('twice')!.status).toBe('Running')
  })

  test('a cloud-init key the declaration carries is never converged on a live guest', async () => {
    // cloud-init runs once, on first boot. Re-setting one of its keys on a live
    // guest changes nothing inside it, so proposing it would be drift no apply
    // can ever close — the guest would report a change on every single run,
    // forever. This is the one path where such a key reaches the *desired*
    // config at all, which is what makes the create-only skip reachable: the
    // seed below is written straight out in the creation branch and never
    // diffed.
    const daemon = fakeIncus()
    const seeded = { 'cloud-init.network-config': 'version: 2' }

    await applyVm(daemon, declare('cloud-init-frozen', { incusConfig: seeded }))
    const afterFirst = daemon.mutations.length

    const second = await applyVm(
      daemon,
      declare('cloud-init-frozen', { incusConfig: { 'cloud-init.network-config': 'version: 3' } }),
    )

    expect(second.changed).toBe(false)
    expect(daemon.mutations).toHaveLength(afterFirst)
    expect(daemon.guests.get('cloud-init-frozen')!.config['cloud-init.network-config']).toBe(
      'version: 2',
    )
  })

  test('a changed userData is not re-seeded, because the seed is written only at creation', async () => {
    const daemon = fakeIncus()

    await applyVm(daemon, declare('seed-frozen'))
    const seeded = daemon.guests.get('seed-frozen')!.config['cloud-init.user-data']
    const afterFirst = daemon.mutations.length

    const second = await applyVm(
      daemon,
      declare('seed-frozen', { userData: 'packages:\n  - htop\n' }),
    )

    expect(second.changed).toBe(false)
    expect(daemon.mutations).toHaveLength(afterFirst)
    expect(daemon.guests.get('seed-frozen')!.config['cloud-init.user-data']).toBe(seeded)
  })

  test('a changed storage pool is not acted on either — it is a delete-and-recreate', async () => {
    // `-s` writes an instance-local root device at creation and there is no
    // config key to diff, so a live guest cannot be moved between pools by an
    // apply. Pinned because the silence is the surprising part: the guest stays
    // where it was and the apply reports no change.
    const daemon = fakeIncus()

    await applyVm(daemon, declare('pool-frozen', { storagePool: 'sessions' }))
    const afterFirst = daemon.mutations.length

    const second = await applyVm(daemon, declare('pool-frozen', { storagePool: 'other' }))

    expect(second.changed).toBe(false)
    expect(daemon.mutations).toHaveLength(afterFirst)
    expect(daemon.guests.get('pool-frozen')!.pool).toBe('sessions')
  })
})

describe('the apply converges a guest that already exists', () => {
  test('a drifted limit is set on the live guest', async () => {
    const daemon = fakeIncus()
    await applyVm(daemon, declare('drifted', { cpu: 4 }))

    const result = await applyVm(daemon, declare('drifted', { cpu: 8, memory: '16GiB' }))

    expect(result).toMatchObject({ created: false, changed: true })
    expect(daemon.guests.get('drifted')!.config).toMatchObject({
      'limits.cpu': '8',
      'limits.memory': '16GiB',
    })
  })

  test('a value with spaces in it survives the shell', async () => {
    // raw.apparmor rules contain spaces, which is why config pairs are quoted
    // as a whole. Unquoted, the daemon would see three arguments and the guest
    // would end up with a truncated rule or none at all.
    const daemon = fakeIncus()
    await applyVm(daemon, declare('spaced'))

    await applyVm(
      daemon,
      declare('spaced', { incusConfig: { 'raw.apparmor': 'deny mount fstype=binfmt_misc,' } }),
    )

    expect(daemon.guests.get('spaced')!.config['raw.apparmor']).toBe(
      'deny mount fstype=binfmt_misc,',
    )
  })

  test('a device declared later is attached to the running guest', async () => {
    const daemon = fakeIncus()
    await applyVm(daemon, declare('late-device'))

    const result = await applyVm(
      daemon,
      declare('late-device', { devices: { tun: { type: 'unix-char', path: '/dev/net/tun' } } }),
    )

    expect(result.changed).toBe(true)
    expect(daemon.guests.get('late-device')!.devices.tun).toEqual({
      type: 'unix-char',
      path: '/dev/net/tun',
    })
  })

  test('a stopped guest is started rather than left down', async () => {
    const daemon = fakeIncus({ guests: [{ name: 'stopped', status: 'Stopped' }] })

    const result = await applyVm(daemon, declare('stopped'))

    expect(result).toMatchObject({ created: false, changed: true })
    expect(daemon.guests.get('stopped')!.status).toBe('Running')
    // Created once, and not a second time: an apply that re-ran `incus init`
    // here would fail against the real daemon and this fake alike.
    expect(daemon.mutations).toEqual(['sudo incus start stopped'])
  })
})

describe('the apply refuses to report success it did not have', () => {
  test('a daemon that will not answer is surfaced, not read as an empty guest list', async () => {
    // The failure `execStatus` exists for, in the direction that matters: a
    // module reading a failed `incus list` as "no such guest" would go on to
    // create a second copy of a guest that is already there.
    const daemon = fakeIncus({ listFails: 'Error: cannot connect to incus daemon' })

    await expect(applyVm(daemon, declare('unreachable'))).rejects.toThrow(
      /incus list failed.*cannot connect/s,
    )
    expect(daemon.mutations).toEqual([])
  })

  test('a guest that never becomes executable fails the apply', async () => {
    // The barrier that makes it safe for a vm-provision instance to start work
    // without racing cloud-init. Reporting ready here would move the failure to
    // a later instance with a much worse error.
    const daemon = fakeIncus({ neverExecutable: true })

    await expect(applyVm(daemon, declare('never-ready', { readyTimeoutMs: 0 }))).rejects.toThrow(
      /never became executable/,
    )
  })

  test('cloud-init finishing with warnings is finished', async () => {
    // Exit 2 is "done, with recoverable warnings" and is the normal outcome for
    // a guest whose apt mirror hiccuped. Treating it as a failure would make
    // every such apply red for something that did work.
    const daemon = fakeIncus({ cloudInitCode: 2 })

    expect((await applyVm(daemon, declare('warned'))).created).toBe(true)
  })

  test('cloud-init failing outright is not', async () => {
    // Usually means no SSH access, so it is surfaced here rather than left for
    // a provision step to fail on with a much more confusing error.
    const daemon = fakeIncus({ cloudInitCode: 1 })

    await expect(applyVm(daemon, declare('seed-failed'))).rejects.toThrow(
      /cloud-init did not complete cleanly/,
    )
  })
})

describe('destroy', () => {
  test('removes the guest it created', async () => {
    const daemon = fakeIncus()
    await applyVm(daemon, declare('doomed'))

    await destroyVm(daemon, declare('doomed'))

    expect(daemon.guests.has('doomed')).toBe(false)
  })

  test('a guest that is already gone is not an error', async () => {
    // zbc calls destroy on an instance whose declaration was deleted, which may
    // well have been removed by hand first.
    const daemon = fakeIncus()

    await destroyVm(daemon, declare('never-existed'))

    expect(daemon.mutations).toEqual([])
  })
})

// ── Absent means local, and "local" is these exact bytes ────────────────────
//
// `target` is what lets this module name a remote endpoint, and the whole
// safety property of it is the *absent* case: eight dev-ws instances
// plus agent-vm, ci-runner and agent-base declare no target and are running
// production surfaces, so a declaration without one has to keep issuing the
// commands it issued before the option existed.
//
// A test that only exercised the remote form would prove nothing about that.
// This one freezes the local form byte-for-byte, and it was written and made to
// pass against the module as it stood at `bbc2094` — before `target` existed at
// all — which is what makes it a record of "today" rather than a restatement of
// whatever the implementation now does.

// ── The guest that is already here, in another incus project ───────────────
//
// A trap found in practice, and not hypothetical: `dev-ws`
// was moved into the `zabaca` project by hand on 2026-08-18 and its declaration
// still said nothing, so an apply would have looked in `default`, found nothing,
// and built a second empty guest of the same name beside a production surface.
// `incus init` would have reported success.

describe('findGuestInAnotherProject', () => {
  const rows = [
    { name: 'agent-vm', project: 'default' },
    { name: 'dev-ws', project: 'zabaca' },
  ]

  test('answers with the project holding a guest of that name', () => {
    expect(findGuestInAnotherProject(rows, 'dev-ws')).toBe('zabaca')
  })

  test('a name nothing on the daemon carries is no finding', () => {
    // The control that keeps every decline below meaningful: this daemon has
    // guests, and the answer is still null. A function that always answered
    // null would pass an empty-list test and nothing else.
    expect(findGuestInAnotherProject(rows, 'brand-new')).toBeNull()
  })

  test('a daemon with no guests at all is no finding', () => {
    expect(findGuestInAnotherProject([], 'brand-new')).toBeNull()
  })

  test('a matching row with no project is a failed read, not a miss', () => {
    // The direction that makes findings disappear: read as "no clash", a moved
    // incus JSON shape would retire this guard in silence and put the create
    // path straight back where it was.
    expect(() => findGuestInAnotherProject([{ name: 'dev-ws' }], 'dev-ws')).toThrow(
      /shape has moved/,
    )
    expect(() => findGuestInAnotherProject([{ name: 'dev-ws', project: '  ' }], 'dev-ws')).toThrow(
      /shape has moved/,
    )
  })

  test('but an unrelated row with no project is not this guard’s business', () => {
    // Deliberate scope: a name that cannot match cannot produce a finding
    // either way, and failing every create over some other guest's shape is
    // what gets a guard switched off.
    expect(findGuestInAnotherProject([{ name: 'agent-vm' }], 'dev-ws')).toBeNull()
  })
})

describe('renderCrossProjectRefusal', () => {
  test('names the guest, where it is, and where the declaration was looking', () => {
    const message = renderCrossProjectRefusal({
      name: 'dev-ws',
      found: 'zabaca',
      declared: 'default',
      verb: 'create',
    })
    expect(message).toContain('dev-ws')
    expect(message).toContain('`zabaca`')
    expect(message).toContain('`default`')
  })

  test('offers the declaration change, spelled as the field it goes in', () => {
    // The usual right answer: the guest is the fact and the file is stale.
    expect(
      renderCrossProjectRefusal({
        name: 'ws',
        found: 'zabaca',
        declared: 'default',
        verb: 'create',
      }),
    ).toContain("target: { project: 'zabaca' }")
  })

  test('and the move, in the order incus requires — stop, move, start', () => {
    const lines = renderCrossProjectRefusal({
      name: 'ws',
      found: 'zabaca',
      declared: 'default',
      verb: 'create',
    }).split('\n')
    const moves = lines.filter((line) => /incus (stop|move|start)/.test(line))
    expect(moves.map((line) => line.trim().split(' ')[1])).toEqual(['stop', 'move', 'start'])
    expect(moves[1]).toContain('--project zabaca --target-project default')
  })

  test('with no project declared, it offers no move commands at all', () => {
    // The destination would be "whatever this endpoint defaults to", which is
    // not a `--target-project` value. Printing one would be inventing a command
    // rather than quoting one, and the reader would run it.
    const message = renderCrossProjectRefusal({ name: 'ws', found: 'zabaca', verb: 'create' })
    expect(message).not.toContain('incus move')
    expect(message).toContain("target: { project: 'zabaca' }")
  })

  test('the delete case says what did not happen, not what would not have', () => {
    const message = renderCrossProjectRefusal({ name: 'ws', found: 'zabaca', verb: 'delete' })
    expect(message).toContain('Nothing was deleted')
    expect(message).not.toContain('second, empty')
  })
})

describe('the apply refuses to create a guest that already exists elsewhere', () => {
  test('the exact case: the declaration says default, the guest is in zabaca', async () => {
    const daemon = fakeIncus({ elsewhere: [{ name: 'dev-ws', project: 'zabaca' }] })

    await expect(applyVm(daemon, declare('dev-ws'))).rejects.toThrow(/holds a guest called/)

    // The claim that matters is not the throw — it is that nothing was built.
    // `mutations` excludes reads, so an empty one means no init, no config set,
    // no start reached the daemon.
    expect(daemon.mutations).toEqual([])
    expect(daemon.guests.has('dev-ws')).toBe(false)
  })

  test('and the message is the one that names both ways out', async () => {
    const daemon = fakeIncus({
      endpoint: { project: 'zabaca' },
      elsewhere: [{ name: 'dev-ws', project: 'default' }],
    })

    await expect(
      applyVm(daemon, declare('dev-ws', { target: { project: 'zabaca' } })),
    ).rejects.toThrow(/incus move dev-ws dev-ws --project default --target-project zabaca/)
  })

  test('a guest of that name in THIS project is a converge, not a clash', async () => {
    // The false positive that would matter, and the one that would get this
    // switched off. It cannot happen by construction: the cross-project read is
    // only reached once the scoped read came back empty.
    const daemon = fakeIncus({
      endpoint: { project: 'zabaca' },
      guests: [{ name: 'dev-ws', status: 'Running', ipv4: '10.196.88.9' }],
    })

    const result = await applyVm(daemon, declare('dev-ws', { target: { project: 'zabaca' } }))

    expect(result.created).toBe(false)
    expect(daemon.commands.filter((c) => c.includes('--all-projects'))).toEqual([])
  })

  test('a daemon holding other guests still creates a new one — the control', async () => {
    // Without this, the refusals above are equally satisfied by a guard that
    // refuses every create. The daemon here holds a guest in another project;
    // it is simply not this one.
    const daemon = fakeIncus({ elsewhere: [{ name: 'somebody-else', project: 'zabaca' }] })

    const result = await applyVm(daemon, declare('brand-new'))

    expect(result.created).toBe(true)
    expect(daemon.guests.has('brand-new')).toBe(true)
  })

  test('the cross-project question is asked of the remote too, without --project', async () => {
    // incus refuses `--project` beside `--all-projects` (measured, incus 6.0.0),
    // and the fake refuses it the same way — so a module that asked through the
    // projected invocation would fail here rather than quietly skipping the
    // guard.
    const daemon = fakeIncus({
      endpoint: REMOTE,
      elsewhere: [{ name: 'remote-clash', project: 'default' }],
    })

    await expect(applyVm(daemon, declare('remote-clash', { target: REMOTE }))).rejects.toThrow(
      /holds a guest called remote-clash in `default`/,
    )
    expect(daemon.mutations).toEqual([])
  })
})

describe('destroy refuses to report a deletion it did not make', () => {
  test('a guest sitting in another project is not silently “already gone”', async () => {
    const daemon = fakeIncus({ elsewhere: [{ name: 'dev-ws', project: 'zabaca' }] })

    await expect(destroyVm(daemon, declare('dev-ws'))).rejects.toThrow(/Nothing was deleted/)
    expect(daemon.mutations).toEqual([])
  })

  test('a guest that really is gone everywhere is still a quiet no-op', async () => {
    // The control. destroy has always been idempotent and must stay so, or
    // every teardown of an already-removed instance becomes a failure.
    const daemon = fakeIncus({ elsewhere: [{ name: 'somebody-else', project: 'zabaca' }] })

    await destroyVm(daemon, declare('long-gone'))

    expect(daemon.mutations).toEqual([])
  })
})

// `target` landed on the promise that these three lists were byte-identical
// to what they had been before it existed. A later change
// spends exactly one byte of that, on purpose and in a separate change: the `=`
// that joins `cloud-init.user-data` to its value, replacing the space that
// spelled the same call in the form incus documents as backward compatibility.
// Nothing else moved, and the point of a list this literal is that the diff for
// this ticket is three characters wide and every other line held.
//
// The seed's *content* is untouched, which is not an assumption — `the guest is
// seeded with the keys the declaration named` reads the YAML back out of the
// fake's guest, and it stayed green through this change without being edited.
describe('a declaration with no target renders what it rendered before, but for the seed’s `=`', () => {
  test('every command of a full create, byte for byte', async () => {
    const daemon = fakeIncus()

    await applyVm(
      daemon,
      declare('byte-identical', {
        type: 'virtual-machine',
        cpu: 8,
        memory: '12GiB',
        disk: '40GiB',
        storagePool: 'sessions',
        devices: { tun: { type: 'unix-char', path: '/dev/net/tun' } },
      }),
    )

    expect(daemon.commands).toEqual([
      'sudo incus list --format json',
      // The create path asks a second question before it creates anything: is
      // there already a guest of this name in another incus project, where the
      // scoped list above could not see it? Projectless because incus refuses
      // `--project` beside `--all-projects`, and it is a read, so it never
      // appears in `mutations`.
      'sudo incus list --all-projects --format json',
      "sudo incus init images:ubuntu/noble/cloud byte-identical --vm -s sessions --config 'limits.cpu=8' --config 'limits.memory=12GiB'",
      'sudo incus config set byte-identical cloud-init.user-data="$(cat /tmp/zbc-cloud-init-byte-identical.yaml)"',
      'sudo incus config device set byte-identical root size=40GiB',
      'sudo incus config device add byte-identical tun unix-char path=/dev/net/tun',
      'sudo incus start byte-identical',
      'sudo incus exec byte-identical -- true',
      'sudo incus exec byte-identical -- true',
      'sudo incus exec byte-identical -- cloud-init status --wait',
      'sudo incus list --format json',
    ])
  })

  test('and the other root-device branch, which the create above does not reach', async () => {
    // A guest with a quota but no pool inherits its root device from the
    // profile, so the size is applied with `override` rather than `set`. The
    // two branches produce different commands and only one of them is above.
    const daemon = fakeIncus()

    await applyVm(daemon, declare('byte-identical-override', { disk: '50GiB' }))

    // The trailing space after the guest name is not a typo and not new: with
    // no flags to emit, `init ${image} ${name} ${flags}` has always produced
    // one. It is here because this list is a record of the bytes, and quietly
    // tidying it would be the test asserting what the implementation ought to
    // do rather than what it did.
    expect(daemon.commands).toEqual([
      'sudo incus list --format json',
      'sudo incus list --all-projects --format json',
      'sudo incus init images:ubuntu/noble/cloud byte-identical-override ',
      'sudo incus config set byte-identical-override cloud-init.user-data="$(cat /tmp/zbc-cloud-init-byte-identical-override.yaml)"',
      'sudo incus config device override byte-identical-override root size=50GiB',
      'sudo incus start byte-identical-override',
      'sudo incus exec byte-identical-override -- true',
      'sudo incus exec byte-identical-override -- true',
      'sudo incus exec byte-identical-override -- cloud-init status --wait',
      'sudo incus list --format json',
    ])
  })
})

// ── A declaration that names a target renders the remote form ───────────────
//
// The other half of the `target` property. `sudo` is *substituted away* rather
// than added to: the local socket is root-owned and needs it, a TLS endpoint
// authenticates by client certificate and does not. Getting that backwards
// produces a command that works by accident on this box — sudo here is
// passwordless — and fails on every machine the feature exists for.
//
// The fake is addressed, so these tests cannot pass by rendering a local
// command that happened to work: a daemon that answers to `incus --project
// zabaca` refuses `sudo incus`, and one that answers to `build-host:` refuses a
// bare guest name. The two controls at the end are what prove that.

const REMOTE: IncusTarget = { remote: 'build-host', project: 'zabaca' }

describe('a declaration that names a target reaches that endpoint instead', () => {
  test('every command of a full create, byte for byte', async () => {
    const daemon = fakeIncus({ endpoint: REMOTE })

    await applyVm(
      daemon,
      declare('remote-create', {
        target: REMOTE,
        type: 'virtual-machine',
        cpu: 8,
        memory: '12GiB',
        disk: '40GiB',
        storagePool: 'sessions',
        devices: { tun: { type: 'unix-char', path: '/dev/net/tun' } },
      }),
    )

    // Compare against the local list at the top of this file: no `sudo`
    // anywhere, `--project zabaca` before the subcommand, and every guest name
    // carrying `build-host:` — including the bare `build-host:` that `incus list`
    // takes positionally.
    expect(daemon.commands).toEqual([
      'incus --project zabaca list build-host: --format json',
      // Projectless, and still remote and still without `sudo`: the project is
      // dropped because incus refuses it beside `--all-projects`, and nothing
      // else about the endpoint changes.
      'incus list build-host: --all-projects --format json',
      "incus --project zabaca init images:ubuntu/noble/cloud build-host:remote-create --vm -s sessions --config 'limits.cpu=8' --config 'limits.memory=12GiB'",
      'incus --project zabaca config set build-host:remote-create cloud-init.user-data="$(cat /tmp/zbc-cloud-init-remote-create.yaml)"',
      'incus --project zabaca config device set build-host:remote-create root size=40GiB',
      'incus --project zabaca config device add build-host:remote-create tun unix-char path=/dev/net/tun',
      'incus --project zabaca start build-host:remote-create',
      'incus --project zabaca exec build-host:remote-create -- true',
      'incus --project zabaca exec build-host:remote-create -- true',
      'incus --project zabaca exec build-host:remote-create -- cloud-init status --wait',
      'incus --project zabaca list build-host: --format json',
    ])
  })

  test('the guest really ends up on that daemon, seeded and running', async () => {
    // The daemon's state, not the command list. A module that rendered the
    // right strings and drove nothing satisfies the test above on its own.
    const daemon = fakeIncus({ endpoint: REMOTE })

    const result = await applyVm(daemon, declare('remote-real', { target: REMOTE }))

    const guest = daemon.guests.get('remote-real')!
    expect(guest.status).toBe('Running')
    expect(result).toMatchObject({ created: true, changed: true })
    // Read back off the remote daemon — `incus list <remote>:` reports bare
    // names, which is why inspect() still matches on config.name.
    expect(result.ipv4).toBe(guest.ipv4)
    expect(parse(guest.config['cloud-init.user-data']!).users[0].ssh_authorized_keys).toEqual([
      KEY_A,
    ])
  })

  test('the seed is still read from a local file, because `$(cat …)` runs client-side', async () => {
    // Not obvious and worth pinning: the command substitution is performed by
    // the shell on the machine running `incus`, so the multi-KB of YAML is read
    // here and travels as an argument. Nothing has to put a file on the remote.
    const daemon = fakeIncus({ endpoint: REMOTE })
    const seedFile = path.join(os.tmpdir(), 'zbc-cloud-init-remote-seed.yaml')

    await applyVm(daemon, declare('remote-seed', { target: REMOTE }))

    expect(daemon.commands.some((c) => c.includes(`$(cat ${seedFile})`))).toBe(true)
    expect(daemon.guests.get('remote-seed')!.config['cloud-init.user-data']).toContain(
      '#cloud-config',
    )
    expect(fs.existsSync(seedFile)).toBe(false)
  })

  test('a second apply against the remote is a no-op, having first created', async () => {
    const daemon = fakeIncus({ endpoint: REMOTE })

    const first = await applyVm(daemon, declare('remote-twice', { target: REMOTE, cpu: 4 }))
    expect(first.created).toBe(true)
    const afterFirst = daemon.mutations.length
    expect(afterFirst).toBeGreaterThan(0)

    const second = await applyVm(daemon, declare('remote-twice', { target: REMOTE, cpu: 4 }))

    expect(second).toMatchObject({ created: false, changed: false })
    expect(daemon.mutations).toHaveLength(afterFirst)
  })

  test('destroy names the guest on the remote too', async () => {
    const daemon = fakeIncus({ endpoint: REMOTE })
    await applyVm(daemon, declare('remote-doomed', { target: REMOTE }))

    await destroyVm(daemon, declare('remote-doomed', { target: REMOTE }))

    expect(daemon.guests.has('remote-doomed')).toBe(false)
    expect(daemon.commands).toContain(
      'incus --project zabaca delete --force build-host:remote-doomed',
    )
  })

  test('the target is reported back, because that is how vm-provision inherits it', async () => {
    // The join between the two modules. `vm-provision` reads the endpoint off
    // its imported vm's *outputs* — a vm that converged a remote guest and then
    // reported nothing would leave every provision instance importing it
    // talking to the local daemon, with no declaration anywhere that was wrong.
    const daemon = fakeIncus({ endpoint: REMOTE })

    const result = await applyVm(daemon, declare('remote-outputs', { target: REMOTE }))

    expect(result.target).toEqual(REMOTE)
  })

  test('and a guest with no target reports none, rather than an empty one', async () => {
    // `{}` and absent behave the same through incusCommand, but they do not
    // read the same: an empty object in the outputs says an endpoint was
    // considered, which for every guest in this repo is not what happened.
    const daemon = fakeIncus()

    const result = await applyVm(daemon, declare('local-outputs'))

    expect(result.target).toBeUndefined()
    expect('target' in result).toBe(false)
  })

  test('a project without a remote is local, projected, and still needs sudo', async () => {
    // The two halves are independent. `--project` scopes what an endpoint
    // shows; `sudo` is about which socket is opened. Foundry converging its own
    // guest inside `zabaca` is this case, and dropping sudo here would make
    // every such apply fail on a socket it may not read.
    const daemon = fakeIncus({ endpoint: { project: 'zabaca' } })

    await applyVm(daemon, declare('projected', { target: { project: 'zabaca' } }))

    expect(daemon.commands[0]).toBe('sudo incus --project zabaca list --format json')
    expect(daemon.commands).toContain('sudo incus --project zabaca start projected')
  })
})

describe('the addressed fake would notice — controls for the two tests above', () => {
  test('a local daemon refuses a remote-form command', async () => {
    // Without this, "the remote form was rendered" is unfalsifiable: a fake
    // that ignored the invocation would answer a local command just as happily.
    const daemon = fakeIncus()

    await expect(applyVm(daemon, declare('wrong-way', { target: REMOTE }))).rejects.toThrow(
      /answers to `sudo incus`/,
    )
  })

  test('a remote daemon refuses the local form', async () => {
    const daemon = fakeIncus({ endpoint: REMOTE })

    await expect(applyVm(daemon, declare('wrong-way-back'))).rejects.toThrow(
      /answers to `incus --project zabaca`/,
    )
  })

  test('a remote daemon refuses a guest named without its scope', async () => {
    // The silent one. `incus --project zabaca start dev-ws` is well-formed
    // and acts on the LOCAL daemon, so a call site that applied the invocation
    // and forgot `guestRef` would act on the wrong machine and report success.
    const daemon = fakeIncus({ endpoint: REMOTE, guests: [{ name: 'unqualified' }] })

    await withExec(daemon.exec, async () => {
      expect(() => daemon.exec('incus --project zabaca start unqualified')).toThrow()
      expect(() => daemon.exec('incus --project zabaca start build-host:unqualified')).not.toThrow()
    })
  })
})

// ── The seed's argv, anchored to the binary rather than to the renderer ─────

describe('every `config set` the module emits is the form incus documents', () => {
  const forms = parseConfigSetForms(CONFIG_SET_HELP)

  test('the transcript names one form as documented and the other as legacy', () => {
    // The parse itself, asserted before anything leans on it. Both specs come
    // out of the file, and the two shapes must differ — a parser that found the
    // same line twice would make the sweep below agree with any renderer.
    expect(forms.documented).toBe('[<remote>:][<instance>] <key>=<value>...')
    expect(forms.backwardCompatible).toBe('[<remote>:][<instance>] <key> <value>')
    expect(formShape(forms.documented)).toBe('pairs')
    expect(formShape(forms.backwardCompatible)).toBe('positional')
  })

  /**
   * Every `config set` a full pass over this module produces, across the three
   * call sites that emit one: the cloud-init seed written at creation, the
   * limits converged on a guest that already exists, and the same two against a
   * remote endpoint, whose invocation and guest reference are both different.
   */
  const everyConfigSet = async (): Promise<string[]> => {
    const local = fakeIncus()
    await applyVm(
      local,
      declare('argv-create', {
        type: 'virtual-machine',
        cpu: 8,
        memory: '12GiB',
        disk: '40GiB',
        storagePool: 'sessions',
        devices: { tun: { type: 'unix-char', path: '/dev/net/tun' } },
      }),
    )
    await applyVm(local, declare('argv-create', { cpu: 16, memory: '24GiB' }))

    const remote = fakeIncus({ endpoint: REMOTE })
    await applyVm(remote, declare('argv-remote', { target: REMOTE }))
    await applyVm(remote, declare('argv-remote', { target: REMOTE, cpu: 2 }))

    return [...local.commands, ...remote.commands].filter((c) => / config set /.test(c))
  }

  test('the sweep has subjects, and they are the two call sites', async () => {
    // The census. A sweep over a computed set reports success when it computes
    // an empty one, and both numbers below moved when this was written: three
    // is the seed on each of the two guests plus one limits update, and four is
    // that again with the second endpoint's limits update.
    const emitted = await everyConfigSet()

    expect(emitted).toHaveLength(4)
    expect(emitted.filter((c) => c.includes('cloud-init.user-data'))).toHaveLength(2)
    expect(emitted.filter((c) => c.includes('limits.'))).toHaveLength(2)
  })

  test('and every one of them uses the documented form, not the legacy one', async () => {
    const emitted = await everyConfigSet()

    for (const command of emitted) {
      // The fake's own shell, so quoting is read the way the daemon would read
      // it — with the seed's `$(cat …)` standing in as one opaque word, which
      // deliberately carries no `=` of its own. See `tokenise`.
      const argv = tokenise(command, () => '<the seed>')
      const at = argv.indexOf('set')
      const args = argv.slice(at + 2) // past `set` and the instance reference

      expect(args.length).toBeGreaterThan(0)
      const shape: ConfigArgForm = args.every((arg) => arg.includes('=')) ? 'pairs' : 'positional'

      // Not `toBe('pairs')`. The expectation is whichever form the transcript
      // documents, so the day incus promotes the positional form this flips
      // rather than going quiet — and today it is the assertion that a renderer
      // reverted to `<key> <value>` cannot satisfy.
      expect(shape).toBe(formShape(forms.documented))
    }
  })

  test('the transcript still matches this box', () => {
    // The other half of the anchor, and the reason the fixture is not merely a
    // frozen record: without this, editing the renderer and the transcript
    // together would pass here forever.
    //
    // No `sudo` and no daemon — `--help` is client-side, prints on stdout and
    // exits 0, measured on this box. So unlike the live tests in
    // `environments/`, "the daemon is unreachable" is not one of the outcomes
    // and there is no version probe to classify: either the binary is on PATH,
    // in which case every failure of the question is a real finding, or it is
    // not, which is the one skip. A blanket `catch` would have collapsed a
    // renamed subcommand into that skip, so the absence is asked about by name.
    const incus = Bun.which('incus')
    if (incus === null) return

    const probe = Bun.spawnSync([incus, 'config', 'set', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })

    expect(probe.exitCode).toBe(0)
    expect(probe.stdout.toString()).toBe(CONFIG_SET_HELP)
  })
})

// ── The fake answers as the binary does, including where the module never goes ─

/** The reason an `incusError` carries, which is on stderr and not in the message. */
const reasonOf = (body: () => unknown): string => {
  try {
    body()
  } catch (error) {
    return (error as { stderr?: string }).stderr ?? `no stderr: ${String(error)}`
  }
  throw new Error('expected a refusal, and nothing was thrown')
}

describe('the fake parses `config set` the way incus 6.0.0 does', () => {
  // A fake written off the renderer would accept exactly what the renderer
  // emits and nothing else, and would therefore be unable to tell a correct
  // command from the only command it had ever seen. These cases are the
  // measurements in `readConfigArgs`, replayed — three of them are shapes this
  // module cannot produce, and that is what makes them worth having.

  test('it takes the documented form, splitting on the first `=` only', () => {
    expect(readConfigArgs(['limits.cpu=2'])).toEqual([{ key: 'limits.cpu', value: '2' }])
    expect(readConfigArgs(['limits.cpu=2', 'limits.memory=1GiB'])).toEqual([
      { key: 'limits.cpu', value: '2' },
      { key: 'limits.memory', value: '1GiB' },
    ])
    // The seed's own shape: a value with newlines and an `=` inside it. incus
    // splits once, so the YAML arrives whole — measured, and the reason this
    // ticket could move the seed to the documented form at all.
    expect(
      readConfigArgs(['cloud-init.user-data=#cloud-config\nusers:\n  - sudo: ALL=(ALL)\n']),
    ).toEqual([
      { key: 'cloud-init.user-data', value: '#cloud-config\nusers:\n  - sudo: ALL=(ALL)\n' },
    ])
  })

  test('it still takes the backward-compatible form, because incus still does', () => {
    // Not aspiration. Removing this would make the fake stricter than the
    // binary, and a fake stricter than the machine fails a correct command —
    // which is how a guard earns being switched off.
    expect(readConfigArgs(['limits.cpu', '2'])).toEqual([{ key: 'limits.cpu', value: '2' }])
    // Two args where the *second* carries an `=` is still the legacy form: the
    // discriminator incus uses is the first arg, not the pair.
    expect(readConfigArgs(['limits.cpu', 'a=b'])).toEqual([{ key: 'limits.cpu', value: 'a=b' }])
  })

  test('and it refuses an argument with no `=` that is not that form', () => {
    // `Error: Invalid key=value configuration: limits.memory`, verbatim off the
    // binary — exit 1 with the reason on **stderr**, which is measured too, and
    // is why this reads `stderr` rather than the message. A thrown `Error`
    // whose message carried the reason would be a shape `host-exec` never
    // produces, so `toThrow(/…/)` here would have been asserting against the
    // test's own invention. The fake used to set such a key to the empty string
    // in silence, which is a machine this daemon is not.
    expect(() => readConfigArgs(['limits.cpu=2', 'limits.memory'])).toThrow('Command failed')
    expect(reasonOf(() => readConfigArgs(['limits.cpu=2', 'limits.memory']))).toBe(
      'Error: Invalid key=value configuration: limits.memory',
    )
    expect(reasonOf(() => readConfigArgs(['limits.cpu', '2', '3']))).toBe(
      'Error: Invalid key=value configuration: limits.cpu',
    )
  })

  test('the refusal happens before the guest is looked up, as it does on the daemon', () => {
    // The ordering is observable, and it is what makes the probes in
    // `readConfigArgs` readable at all: against an instance that does not
    // exist, a well-formed command answers `Instance not found` and a
    // malformed one answers `Invalid key=value configuration`. A fake that
    // checked the guest first would answer 404 to both and lose the signal.
    const daemon = fakeIncus()

    expect(reasonOf(() => daemon.exec('sudo incus config set nobody-here limits.cpu=2'))).toBe(
      'Error: Instance not found: nobody-here',
    )
    expect(
      reasonOf(() => daemon.exec('sudo incus config set nobody-here limits.cpu=2 limits.memory')),
    ).toBe('Error: Invalid key=value configuration: limits.memory')
  })
})
