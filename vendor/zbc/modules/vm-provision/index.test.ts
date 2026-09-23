import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { type Exec, withExec } from '../host-exec'
import { type IncusTarget, guestRef, incusCommand } from '../incus-core'
import { MARKER_DIR } from '../provision-core'
import {
  findVmOutputs,
  provisionDigest,
  renderProvisionScript,
  resolveInstanceName,
  resolveVolatileEnv,
  shouldProvision,
  vmProvisionModule,
} from './index'

const base = { packages: ['git'], script: 'echo hi', env: { A: '1', B: '2' } }

describe('provisionDigest', () => {
  test('is stable regardless of env key order', () => {
    expect(provisionDigest(base)).toBe(provisionDigest({ ...base, env: { B: '2', A: '1' } }))
  })

  test('changes when the script changes', () => {
    expect(provisionDigest({ ...base, script: 'echo bye' })).not.toBe(provisionDigest(base))
  })

  test('changes when the package set changes', () => {
    expect(provisionDigest({ ...base, packages: ['git', 'jq'] })).not.toBe(provisionDigest(base))
  })

  test('changes when an env value changes, so a rotated secret re-provisions', () => {
    expect(provisionDigest({ ...base, env: { A: '1', B: '3' } })).not.toBe(provisionDigest(base))
  })

  test('is a hex sha256, safe to write inside the guest as a marker', () => {
    expect(provisionDigest(base)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('resolveInstanceName', () => {
  const vmOutputs = { name: 'agent-vm', type: 'container', sshUser: 'deploy', ipv4: '10.0.0.2' }

  test('prefers an explicit config value', () => {
    expect(resolveInstanceName('explicit', { 'agent-vm': vmOutputs })).toBe('explicit')
  })

  test('falls back to the single imported vm instance', () => {
    expect(resolveInstanceName(undefined, { 'agent-vm': vmOutputs })).toBe('agent-vm')
  })

  test('throws when there is nothing to resolve from', () => {
    expect(() => resolveInstanceName(undefined, {})).toThrow(/instance/i)
  })

  test('throws rather than guessing when imports are ambiguous', () => {
    expect(() =>
      resolveInstanceName(undefined, {
        'agent-vm': vmOutputs,
        'other-vm': { ...vmOutputs, name: 'other-vm' },
      }),
    ).toThrow(/ambiguous/i)
  })

  test('ignores imports that are not vm outputs', () => {
    expect(
      resolveInstanceName(undefined, {
        'agent-vm': vmOutputs,
        'some-file': { path: '/x', changed: false },
      }),
    ).toBe('agent-vm')
  })
})

describe('renderProvisionScript', () => {
  test('fails fast instead of limping past a broken step', () => {
    expect(renderProvisionScript({ packages: [], script: 'echo hi' })).toContain(
      'set -euo pipefail',
    )
  })

  test('installs packages before running the script body', () => {
    const out = renderProvisionScript({ packages: ['git', 'jq'], script: 'echo hi' })
    expect(out).toContain('git jq')
    expect(out.indexOf('apt-get')).toBeLessThan(out.indexOf('echo hi'))
  })

  test('runs apt non-interactively — there is no tty in the guest', () => {
    expect(renderProvisionScript({ packages: ['git'], script: '' })).toContain(
      'DEBIAN_FRONTEND=noninteractive',
    )
  })

  test('skips apt entirely when no packages are requested', () => {
    expect(renderProvisionScript({ packages: [], script: 'echo hi' })).not.toContain('apt-get')
  })

  test('exports volatile values too, so the script can use a just-minted key', () => {
    const out = renderProvisionScript({
      packages: [],
      script: 'echo hi',
      volatileEnv: { TS_AUTHKEY: 'tskey-auth-abc' },
    })
    expect(out).toContain("export TS_AUTHKEY='tskey-auth-abc'")
    expect(out.indexOf('TS_AUTHKEY')).toBeLessThan(out.indexOf('echo hi'))
  })
})

describe('volatile env is deliberately outside the digest', () => {
  // A key minted fresh on every apply would change the digest on every apply,
  // re-running apt-get and the whole toolchain install forever. The digest
  // covers what the guest should *be*; the key is only how it gets there.
  test('a different volatile value does not change the digest', () => {
    expect(provisionDigest({ ...base, volatileEnv: { TS_AUTHKEY: 'tskey-auth-one' } })).toBe(
      provisionDigest({ ...base, volatileEnv: { TS_AUTHKEY: 'tskey-auth-two' } }),
    )
  })

  test('and neither does its presence or absence', () => {
    expect(provisionDigest({ ...base, volatileEnv: { TS_AUTHKEY: 'tskey-auth-one' } })).toBe(
      provisionDigest(base),
    )
  })
})

describe('shouldProvision', () => {
  const digest = 'a'.repeat(64)

  test('skips when the marker already matches and nothing volatile is pending', () => {
    expect(shouldProvision({ current: digest, digest, volatileEnv: {}, force: false })).toBe(false)
  })

  test('runs when the marker is stale', () => {
    expect(shouldProvision({ current: 'stale', digest, volatileEnv: {}, force: false })).toBe(true)
  })

  test('runs on a matching marker when a volatile value is present', () => {
    // This is how a node that fell off the tailnet rejoins: the authkey module
    // mints only when the device is missing or offline, and that non-empty key
    // is the signal that there is work to do despite an unchanged digest.
    expect(
      shouldProvision({
        current: digest,
        digest,
        volatileEnv: { TS_AUTHKEY: 'tskey-auth-x' },
        force: false,
      }),
    ).toBe(true)
  })

  test('an empty volatile value is not a reason to run', () => {
    expect(
      shouldProvision({ current: digest, digest, volatileEnv: { TS_AUTHKEY: '' }, force: false }),
    ).toBe(false)
  })

  test('force always runs', () => {
    expect(shouldProvision({ current: digest, digest, volatileEnv: {}, force: true })).toBe(true)
  })
})

describe('resolveVolatileEnv', () => {
  const imports = { 'agent-vm-authkey': { key: 'tskey-auth-abc', minted: true } }

  test('reads instance.field out of the import outputs', () => {
    expect(resolveVolatileEnv({ TS_AUTHKEY: 'agent-vm-authkey.key' }, imports)).toEqual({
      TS_AUTHKEY: 'tskey-auth-abc',
    })
  })

  test('passes an empty value through — "nothing to do" is a real answer', () => {
    expect(
      resolveVolatileEnv(
        { TS_AUTHKEY: 'agent-vm-authkey.key' },
        { 'agent-vm-authkey': { key: '' } },
      ),
    ).toEqual({ TS_AUTHKEY: '' })
  })

  test('names the missing instance rather than exporting undefined', () => {
    expect(() => resolveVolatileEnv({ TS_AUTHKEY: 'nope.key' }, imports)).toThrow(/nope/)
  })

  test('names the missing field too', () => {
    expect(() => resolveVolatileEnv({ TS_AUTHKEY: 'agent-vm-authkey.nope' }, imports)).toThrow(
      /nope/,
    )
  })

  test('rejects a reference that is not instance.field', () => {
    expect(() => resolveVolatileEnv({ TS_AUTHKEY: 'agent-vm-authkey' }, imports)).toThrow(
      /instance\.field/,
    )
  })
})

// ── The machine, substituted ────────────────────────────────────────────────
//
// Everything above tests pure functions — the digest, the script text, how an
// instance name is resolved. None of it runs `apply`, and gutting `apply` to
// `return { instance: 'x', digest: 'y', changed: false }` left the whole suite
// green until this file was extended.

describe('the machine is reached through the seam', () => {
  const source = fs.readFileSync(`${import.meta.dir}/index.ts`, 'utf8')
  const imports = source.split('\n').filter((line) => /^import\b/.test(line))

  test('nothing here imports node:child_process any more', () => {
    expect(imports.filter((line) => line.includes('node:child_process'))).toEqual([])
  })

  test('and it reaches the machine through host-exec instead', () => {
    expect(imports.filter((line) => line.includes('../host-exec'))).toHaveLength(1)
  })
})

// ── An in-memory guest ──────────────────────────────────────────────────────
//
// A machine, not a call recorder. The whole of this module's effect
// is one script delivered on stdin, so the fake *executes* that script: it
// exports the variables, installs the packages, and writes the marker the
// script itself ends with. That last part is what makes the second apply
// meaningful — the marker the first pass wrote is what the second pass reads,
// through the same `cat` the module runs, so "unchanged" is a converge that
// settled rather than an apply that did nothing.
//
// Executing the payload is also the only way to assert the property the stdin
// delivery exists for: a secret reaches the guest's environment and never
// appears in a command line.

/**
 * How this guest is reached: the invocation for its endpoint, then the guest as
 * that endpoint names it.
 *
 * Read off the same two renderers the module uses, because "one answer
 * everywhere" is the property `incus-core` exists for. What pins the answer
 * itself is the byte-exact command lists below.
 */
const EXEC = (instance: string, endpoint?: IncusTarget) =>
  `${incusCommand(endpoint)} exec ${guestRef(endpoint, instance)}`

const BASH = (instance: string, endpoint?: IncusTarget) => `${EXEC(instance, endpoint)} -- bash -s`

/** POSIX single-quoting, undone — the inverse of provision-core's `sq`. */
const unquote = (value: string): string =>
  value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replaceAll("'\\''", "'") : value

interface FakeGuest {
  running: boolean
  /** `/var/lib/zbc-provision/<marker>` → digest. */
  markers: Record<string, string>
  /** What the last run exported, as the guest's environment saw it. */
  env: Record<string, string>
  installed: Set<string>
  /** Every line of script body that was neither an export nor an install. */
  ran: string[]
}

interface FakeOptions {
  running?: boolean
  markers?: Record<string, string>
  /** A step that fails, to prove `set -e` stops before the marker is written. */
  failsOn?: string
  /**
   * The address this guest's daemon answers to. Absent is the local socket,
   * which is every declaration in this repo.
   *
   * Enforced rather than tolerated: a command carrying the wrong invocation, or
   * naming the guest without this endpoint's scope, is refused — because that
   * is what a real misaddressed command does, and refusing is the only way a
   * test can tell "the remote form was rendered" from "a local command that
   * happened to work".
   */
  endpoint?: IncusTarget
}

function fakeGuest(instance: string, options: FakeOptions = {}) {
  const reach = EXEC(instance, options.endpoint)
  const guest: FakeGuest = {
    running: options.running ?? true,
    markers: { ...options.markers },
    env: {},
    installed: new Set(),
    ran: [],
  }
  const commands: string[] = []

  const refuse = (reason: string): never => {
    throw Object.assign(new Error('Command failed'), { status: 1, stdout: '', stderr: reason })
  }

  const exec: Exec = (command, options_) => {
    commands.push(command)
    if (!guest.running) refuse('Error: Instance is not running')

    if (!command.startsWith(`${reach} `)) {
      throw new Error(`fake guest: this guest is reached as \`${reach}\`, not: ${command}`)
    }

    const read = /-- sh -c 'cat (\S+) 2>\/dev\/null \|\| true'$/.exec(command)
    if (read) {
      // The guest's filesystem has exactly one directory in it. A read from
      // anywhere else is a miss, which is how a module that lost track of where
      // provision-core keeps its markers fails here rather than silently
      // re-provisioning every guest once.
      const marker = read[1]!.startsWith(`${MARKER_DIR}/`)
        ? read[1]!.slice(MARKER_DIR.length + 1)
        : refuse(`Error: cat: ${read[1]}: No such file or directory`)
      return `${guest.markers[marker] ?? ''}\n`
    }

    if (command !== BASH(instance, options.endpoint)) {
      throw new Error(`fake guest: refusing unrecognised command: ${command}`)
    }

    // `bash -s` reads the script from stdin. A payload that never arrived is a
    // guest that runs nothing, which is the failure the `input` option exists
    // to prevent — so it is a refusal here rather than a silent success.
    const payload = options_?.input
    if (payload === undefined) refuse('Error: bash: no script on stdin')

    // `set -euo pipefail`: the first failing step stops the run, and the marker
    // write is the last line, so a failure leaves the old marker in place.
    for (const line of payload!.split('\n')) {
      if (options.failsOn !== undefined && line.includes(options.failsOn)) {
        refuse(`Error: ${line}: command failed`)
      }
      const exported = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (exported) {
        guest.env[exported[1]!] = unquote(exported[2]!)
        continue
      }
      const installs = /^apt-get install -y -qq (.+)$/.exec(line)
      if (installs) {
        for (const name of installs[1]!.split(' ')) guest.installed.add(name)
        continue
      }
      const marker = /^printf '%s' '([0-9a-f]+)' > \S*\/([^/]+)$/.exec(line)
      if (marker) {
        guest.markers[marker[2]!] = marker[1]!
        continue
      }
      if (line.trim() !== '') guest.ran.push(line)
    }
    return ''
  }

  return {
    exec,
    guest,
    commands,
    /** Only the runs. Reading the marker is not a change to the guest. */
    get provisions() {
      return commands.filter((command) => command === BASH(instance, options.endpoint))
    },
  }
}

const VM_OUTPUTS = { name: 'agent-vm', type: 'container', sshUser: 'deploy', ipv4: '10.0.0.2' }

/** Everything the vm module reports for a guest it converged on a remote. */
const REMOTE: IncusTarget = { remote: 'build-host', project: 'zabaca' }
const REMOTE_VM_OUTPUTS = { ...VM_OUTPUTS, name: 'dev-ws', target: REMOTE }

const applyProvision = (
  daemon: { exec: Exec },
  config: Record<string, unknown>,
  ctx: { secrets?: Record<string, string>; imports?: Record<string, unknown> } = {},
) =>
  withExec(daemon.exec, () =>
    vmProvisionModule.apply(vmProvisionModule.configSchema.parse(config), {
      secrets: ctx.secrets ?? {},
      imports: ctx.imports ?? { 'agent-vm': VM_OUTPUTS },
      projectRoot: '/tmp',
    }),
  )

describe('the apply provisions the guest, and not only a digest of one', () => {
  test('an unprovisioned guest ends up with the packages and the script that were declared', async () => {
    const daemon = fakeGuest('agent-vm')

    const result = await applyProvision(daemon, {
      packages: ['git', 'jq'],
      script: 'install-the-toolchain',
      env: { NODE_VERSION: '22' },
    })

    // The guest's state, not the return value. `changed: true` is satisfied by
    // a module that returns it without running anything.
    expect(result.changed).toBe(true)
    expect([...daemon.guest.installed].sort()).toEqual(['git', 'jq'])
    expect(daemon.guest.ran).toContain('install-the-toolchain')
    expect(daemon.guest.env.NODE_VERSION).toBe('22')
    // And the marker the next apply will read, written by the script itself.
    expect(daemon.guest.markers.default).toBe(result.digest)
  })

  test('the script runs as the guest’s own ssh user, taken from the imported vm', async () => {
    const daemon = fakeGuest('agent-vm')

    await applyProvision(daemon, { script: 'whoami' })

    expect(daemon.guest.env.PROVISION_USER).toBe('deploy')
    expect(daemon.guest.env.PROVISION_HOME).toBe('/home/deploy')
  })

  test('with no vm to ask, it runs as root rather than guessing a user', async () => {
    const daemon = fakeGuest('standalone')

    await applyProvision(daemon, { instance: 'standalone', script: 'whoami' }, { imports: {} })

    expect(daemon.guest.env.PROVISION_USER).toBe('root')
    expect(daemon.guest.env.PROVISION_HOME).toBe('/root')
  })

  test('a secret reaches the guest’s environment and never a command line', async () => {
    // Why the payload goes over stdin at all. In argv it would be visible in
    // `ps` to every user on the guest for as long as the provision ran, which
    // for an apt install plus a toolchain build is minutes.
    const daemon = fakeGuest('agent-vm')

    await applyProvision(
      daemon,
      { script: 'use-the-token', envSecrets: { GH_TOKEN: 'github_pat' } },
      { secrets: { github_pat: 'ghp-not-a-real-token' } },
    )

    expect(daemon.guest.env.GH_TOKEN).toBe('ghp-not-a-real-token')
    expect(daemon.commands.some((command) => command.includes('ghp-not-a-real-token'))).toBe(false)
  })

  test('a secret the vault does not have stops the apply before anything runs', async () => {
    const daemon = fakeGuest('agent-vm')

    await expect(
      applyProvision(daemon, { script: 'x', envSecrets: { GH_TOKEN: 'absent_key' } }),
    ).rejects.toThrow(/absent_key/)
    expect(daemon.provisions).toEqual([])
  })
})

describe('a second apply is a no-op, having first provisioned', () => {
  const declaration = { packages: ['git'], script: 'install-the-toolchain' }

  test('the guest is not touched again', async () => {
    const daemon = fakeGuest('agent-vm')

    // Asserted, not assumed: "nothing happened" satisfies `changed: false` on
    // its own, so an idempotence test that only checks the second run was quiet
    // passes against an apply that never ran anything at all.
    const first = await applyProvision(daemon, declaration)
    expect(first.changed).toBe(true)
    expect(daemon.provisions).toHaveLength(1)

    const second = await applyProvision(daemon, declaration)

    expect(second.changed).toBe(false)
    expect(second.digest).toBe(first.digest)
    expect(daemon.provisions).toHaveLength(1)
  })

  test('a changed script re-provisions, because the marker no longer matches', async () => {
    const daemon = fakeGuest('agent-vm')
    const first = await applyProvision(daemon, declaration)

    const second = await applyProvision(daemon, { ...declaration, script: 'and-then-some' })

    expect(second.changed).toBe(true)
    expect(second.digest).not.toBe(first.digest)
    expect(daemon.guest.markers.default).toBe(second.digest)
    expect(daemon.guest.ran).toContain('and-then-some')
  })

  test('two markers in one guest are independent', async () => {
    // What `marker` is for: one guest carrying several provision instances,
    // each with its own digest. A single marker file would make the second
    // instance re-provision the first's work on every apply, forever.
    const daemon = fakeGuest('agent-vm')

    await applyProvision(daemon, { ...declaration, marker: 'base' })
    await applyProvision(daemon, { script: 'something-else', marker: 'extra' })
    const again = await applyProvision(daemon, { ...declaration, marker: 'base' })

    expect(again.changed).toBe(false)
    expect(Object.keys(daemon.guest.markers).sort()).toEqual(['base', 'extra'])
    expect(daemon.provisions).toHaveLength(2)
  })

  test('force runs anyway', async () => {
    const daemon = fakeGuest('agent-vm')
    await applyProvision(daemon, declaration)

    expect((await applyProvision(daemon, { ...declaration, force: true })).changed).toBe(true)
    expect(daemon.provisions).toHaveLength(2)
  })

  test('a pending volatile value runs on an unchanged digest', async () => {
    // How a node that fell off the tailnet rejoins. The authkey module mints
    // only when the device is missing or offline, so a non-empty key is the
    // signal that there is work the digest cannot see — and the key is never in
    // the digest, or every apply would re-run the whole toolchain install.
    const daemon = fakeGuest('agent-vm')
    const first = await applyProvision(
      daemon,
      { ...declaration, volatileEnvFrom: { TS_AUTHKEY: 'authkey.key' } },
      { imports: { 'agent-vm': VM_OUTPUTS, authkey: { key: '' } } },
    )
    expect(first.changed).toBe(true)

    const second = await applyProvision(
      daemon,
      { ...declaration, volatileEnvFrom: { TS_AUTHKEY: 'authkey.key' } },
      { imports: { 'agent-vm': VM_OUTPUTS, authkey: { key: 'tskey-auth-minted' } } },
    )

    expect(second.changed).toBe(true)
    expect(second.digest).toBe(first.digest)
    expect(daemon.guest.env.TS_AUTHKEY).toBe('tskey-auth-minted')
  })

  test('and an empty one does not — that is the steady state', async () => {
    const daemon = fakeGuest('agent-vm')
    await applyProvision(
      daemon,
      { ...declaration, volatileEnvFrom: { TS_AUTHKEY: 'authkey.key' } },
      { imports: { 'agent-vm': VM_OUTPUTS, authkey: { key: '' } } },
    )

    const second = await applyProvision(
      daemon,
      { ...declaration, volatileEnvFrom: { TS_AUTHKEY: 'authkey.key' } },
      { imports: { 'agent-vm': VM_OUTPUTS, authkey: { key: '' } } },
    )

    expect(second.changed).toBe(false)
    expect(daemon.provisions).toHaveLength(1)
  })
})

describe('the apply refuses to report success it did not have', () => {
  test('a guest that is not running is named as the problem', async () => {
    // The marker read is the first thing that touches the guest, so this is
    // where a stopped guest surfaces — with the daemon's own words, rather than
    // as a bare non-zero exit somewhere later.
    const daemon = fakeGuest('agent-vm', { running: false })

    await expect(applyProvision(daemon, { script: 'x' })).rejects.toThrow(
      /cannot exec into guest.*not running/s,
    )
    expect(daemon.provisions).toEqual([])
  })

  test('a failed step leaves the old marker, so the next apply retries', async () => {
    // The marker write is appended after the script under `set -e`, which is
    // the whole reason it is part of the payload rather than a second command.
    // Written the other way, a half-provisioned guest would be recorded as done
    // and no later apply would ever revisit it.
    const daemon = fakeGuest('agent-vm', {
      markers: { default: 'a'.repeat(64) },
      failsOn: 'install-the-toolchain',
    })

    await expect(
      applyProvision(daemon, { packages: ['git'], script: 'install-the-toolchain' }),
    ).rejects.toThrow()

    expect(daemon.guest.markers.default).toBe('a'.repeat(64))
    expect(daemon.provisions).toHaveLength(1)
    // The run really got inside the guest and stopped there. Without this the
    // test passes for the wrong reason: a module that never delivered the
    // payload at all also throws and also leaves the marker alone, and this was
    // measured — the mutation that drops `input` from the call site survived
    // every other assertion here.
    expect(daemon.guest.env.PROVISION_USER).toBe('deploy')
  })
})

// ── Absent means local, and "local" is these exact bytes ────────────────────
//
// The other half of the `target` safety property, in the module that
// inherits the target rather than declaring it. Written and made to pass
// against this module as it stood at `bbc2094`, before `target` existed
// anywhere, so it records what the command line was rather than restating what
// the implementation now builds.

describe('a declaration whose vm names no target renders exactly what it rendered before', () => {
  test('both commands of a full provision, byte for byte', async () => {
    const daemon = fakeGuest('agent-vm')

    await applyProvision(daemon, { packages: ['git'], script: 'install-the-toolchain' })

    expect(daemon.commands).toEqual([
      "sudo incus exec agent-vm -- sh -c 'cat /var/lib/zbc-provision/default 2>/dev/null || true'",
      'sudo incus exec agent-vm -- bash -s',
    ])
  })
})

// ── The target is inherited, never re-declared ─────────────────────────────
//
// The `target` property, in the module that does not own the declaration. A Guest
// states its endpoint once, on its vm, and this module reads it off the imported
// outputs exactly as it already reads `sshUser`. Two declarations of the same
// endpoint could disagree, and the one that disagreed would provision a guest on
// a machine the vm never touched.

describe('a guest declared on a remote is provisioned on that remote', () => {
  test('both commands of a full provision, byte for byte', async () => {
    const daemon = fakeGuest('dev-ws', { endpoint: REMOTE })

    await applyProvision(
      daemon,
      { packages: ['git'], script: 'install-the-toolchain' },
      { imports: { 'dev-ws': REMOTE_VM_OUTPUTS } },
    )

    // Against the local list above: no `sudo`, `--project zabaca` before the
    // subcommand, and the guest carrying `build-host:`.
    expect(daemon.commands).toEqual([
      "incus --project zabaca exec build-host:dev-ws -- sh -c 'cat /var/lib/zbc-provision/default 2>/dev/null || true'",
      'incus --project zabaca exec build-host:dev-ws -- bash -s',
    ])
  })

  test('the payload really reaches the guest — the strings alone prove nothing', async () => {
    const daemon = fakeGuest('dev-ws', { endpoint: REMOTE })

    const result = await applyProvision(
      daemon,
      { packages: ['jq'], script: 'install-the-toolchain', env: { NODE_VERSION: '22' } },
      { imports: { 'dev-ws': REMOTE_VM_OUTPUTS } },
    )

    expect([...daemon.guest.installed]).toEqual(['jq'])
    expect(daemon.guest.ran).toContain('install-the-toolchain')
    expect(daemon.guest.env.NODE_VERSION).toBe('22')
    expect(daemon.guest.markers.default).toBe(result.digest)
  })

  test('a second apply against the remote is a no-op, having first provisioned', async () => {
    const daemon = fakeGuest('dev-ws', { endpoint: REMOTE })
    const declaration = { packages: ['git'], script: 'install-the-toolchain' }
    const imports = { imports: { 'dev-ws': REMOTE_VM_OUTPUTS } }

    const first = await applyProvision(daemon, declaration, imports)
    expect(first.changed).toBe(true)
    expect(daemon.provisions).toHaveLength(1)

    const second = await applyProvision(daemon, declaration, imports)

    expect(second.changed).toBe(false)
    expect(daemon.provisions).toHaveLength(1)
  })

  test('the endpoint comes from the vm, and a target written here is not a second opinion', async () => {
    // Stated once per Guest. `target` is not in this module's schema, so zod
    // drops it — and this pins that the drop is the behaviour rather than an
    // accident waiting to be "fixed" into a field that overrides the vm.
    const daemon = fakeGuest('dev-ws', { endpoint: REMOTE })

    await applyProvision(
      daemon,
      { script: 'x', target: { remote: 'somewhere-else', project: 'wrong' } },
      { imports: { 'dev-ws': REMOTE_VM_OUTPUTS } },
    )

    expect(daemon.provisions).toHaveLength(1)
  })

  test('an instance named explicitly, with no vm to ask, is local', async () => {
    // Today's behaviour and it has to stay: `config.instance` without a
    // matching import is how a guest nobody declares here gets provisioned, and
    // there is nothing to inherit an endpoint from. Guessing a remote would aim
    // it at a machine no declaration mentions.
    const daemon = fakeGuest('standalone')

    await applyProvision(daemon, { instance: 'standalone', script: 'x' }, { imports: {} })

    expect(daemon.commands[0]).toContain('sudo incus exec standalone --')
  })
})

describe('the addressed fake would notice — controls for the tests above', () => {
  test('a local guest refuses the remote form', async () => {
    const daemon = fakeGuest('dev-ws')

    await expect(
      applyProvision(daemon, { script: 'x' }, { imports: { 'dev-ws': REMOTE_VM_OUTPUTS } }),
    ).rejects.toThrow(/reached as `sudo incus exec dev-ws`/)
  })

  test('a remote guest refuses the local form', async () => {
    const daemon = fakeGuest('agent-vm', { endpoint: REMOTE })

    await expect(applyProvision(daemon, { script: 'x' })).rejects.toThrow(
      /reached as `incus --project zabaca exec build-host:agent-vm`/,
    )
  })
})

describe('findVmOutputs', () => {
  test('still recognises a vm that reports no target — every existing one does', async () => {
    // The guard predates `target` and must not start rejecting outputs without
    // it, or every provision instance in this repo would lose its guest.
    expect(findVmOutputs({ 'agent-vm': VM_OUTPUTS })).toEqual([VM_OUTPUTS])
  })

  test('and carries the target through when there is one', async () => {
    expect(findVmOutputs({ 'dev-ws': REMOTE_VM_OUTPUTS })[0]?.target).toEqual(REMOTE)
  })
})
