import { describe, expect, test } from 'bun:test'
import { type Exec, withExec } from '../host-exec'
import {
  EXPIRY_EXPRESSION,
  INCUS_TIMEOUT_MS,
  guestRef,
  incus,
  incusCommand,
  incusJson,
  namesAnExpiry,
} from './index'

/** Records what it was asked, answers what it was told. */
function recorder(answers: Record<string, string> = {}) {
  const seen: Array<{ command: string; timeout?: number }> = []
  const fake: Exec = (command, options) => {
    seen.push({ command, timeout: options?.timeout })
    return answers[command] ?? ''
  }
  return { seen, fake }
}

describe('incus', () => {
  test('reaches the daemon through sudo, because the invoking user is not in incus-admin', async () => {
    // Measured 2026-08-18: `incus version` as an unprivileged user reports "Server version:
    // unreachable" while `sudo incus version` reports 6.0.0. The socket is
    // root:incus-admin and this user is in neither.
    const { seen, fake } = recorder()
    await withExec(fake, async () => incus('project list --format json'))
    expect(seen.map((call) => call.command)).toEqual(['sudo incus project list --format json'])
  })

  test('every call carries a timeout, so a wedged daemon cannot hang an apply', async () => {
    const { seen, fake } = recorder()
    await withExec(fake, async () => incus('project list'))
    expect(seen[0]?.timeout).toBe(INCUS_TIMEOUT_MS)
  })

  test('a caller that needs longer says so', async () => {
    const { seen, fake } = recorder()
    await withExec(fake, async () => incus('project list', { timeout: 5_000 }))
    expect(seen[0]?.timeout).toBe(5_000)
  })
})

describe('incusJson', () => {
  test('reads a list the daemon printed', async () => {
    const { fake } = recorder({ 'sudo incus project list --format json': '[{"name":"default"}]' })
    const parsed = await withExec(fake, async () =>
      incusJson<Array<{ name: string }>>('project list --format json'),
    )
    expect(parsed).toEqual([{ name: 'default' }])
  })

  test('an empty list is an empty list', async () => {
    const { fake } = recorder({ 'sudo incus config trust list-tokens --format json': '[]' })
    expect(
      await withExec(fake, async () =>
        incusJson<unknown[]>('config trust list-tokens --format json'),
      ),
    ).toEqual([])
  })

  test('`null` is the empty list, which is how incus prints an empty result in some versions', async () => {
    const { fake } = recorder({ 'sudo incus project list --format json': 'null' })
    expect(
      await withExec(fake, async () => incusJson<unknown[]>('project list --format json')),
    ).toEqual([])
  })

  // The parseServeStatus lesson, one module over: reading a parse failure as
  // "nothing is there" makes every apply create what already exists.
  test('output that is not JSON is an error, not an empty result', async () => {
    const { fake } = recorder({
      'sudo incus project list --format json': 'Error: permission denied',
    })
    expect(
      withExec(fake, async () => incusJson<unknown[]>('project list --format json')),
    ).rejects.toThrow(/project list --format json/)
  })

  test('JSON that is not a list is an error, because every caller here lists', async () => {
    const { fake } = recorder({ 'sudo incus project list --format json': '{"name":"default"}' })
    expect(
      withExec(fake, async () => incusJson<unknown[]>('project list --format json')),
    ).rejects.toThrow(/list/)
  })
})

// ── Addressing one endpoint ────────────────────────────────────────────────
//
// The second form this file's header predicted: a vm
// declaration a `target`, and these two functions are the whole of what that
// changes about a command line: which `incus` is invoked, and how a guest is
// named to it. They live here rather than in `vm` because the answer must be
// the same one everywhere — a module that reached the daemon its own way is
// precisely the drift this directory exists to prevent.

describe('incusCommand', () => {
  test('with no target it is the local socket, and the local socket needs sudo', () => {
    // The absent case, which every declaration in this repo is. Byte-identical
    // to what every module here has always emitted.
    expect(incusCommand()).toBe('sudo incus')
    expect(incusCommand({})).toBe('sudo incus')
  })

  test('a remote drops sudo, because a TLS endpoint authenticates as an ordinary user', () => {
    // The substitution that is easy to get backwards. `sudo` is not decoration
    // on the local form, it is what the root-owned unix socket requires; a
    // remote endpoint authenticates by client certificate as whoever holds the
    // key, and a remote command that still said `sudo` would work by accident
    // on this box — where the invoking user has passwordless sudo — and fail
    // on every machine that is the actual point of the feature.
    expect(incusCommand({ remote: 'build-host' })).toBe('incus')
  })

  test('an incus project is a global flag, and it is orthogonal to where the daemon is', () => {
    // Two independent facts, not one. `sudo` is decided by *remote*, because
    // that is what decides which socket is opened; the project only scopes what
    // the endpoint shows. Foundry converging its own guest inside `zabaca`
    // would be local-and-projected, and it would still need root.
    expect(incusCommand({ project: 'zabaca' })).toBe('sudo incus --project zabaca')
    expect(incusCommand({ remote: 'build-host', project: 'zabaca' })).toBe('incus --project zabaca')
  })
})

describe('guestRef', () => {
  test('a guest on the local daemon is named bare', () => {
    expect(guestRef(undefined, 'dev-ws')).toBe('dev-ws')
    expect(guestRef({ project: 'zabaca' }, 'dev-ws')).toBe('dev-ws')
  })

  test('a guest on a remote carries the remote, or the command hits the wrong daemon', () => {
    // The silent half of the substitution. `incus --project zabaca start
    // dev-ws` is a valid command that runs against the LOCAL daemon,
    // because an unqualified name means the default remote — so a call site
    // that applied the invocation and forgot the name would act on the wrong
    // machine and report success.
    expect(guestRef({ remote: 'build-host' }, 'dev-ws')).toBe('build-host:dev-ws')
    expect(guestRef({ remote: 'build-host', project: 'zabaca' }, 'dev-ws')).toBe(
      'build-host:dev-ws',
    )
  })

  test('with no name it is the bare scope, which is how `incus list` takes one', () => {
    // `incus list <remote>:` is the one place the remote appears without a
    // guest after it. Empty locally, so a caller can drop it and keep the
    // command it had.
    expect(guestRef({ remote: 'build-host' }, '')).toBe('build-host:')
    expect(guestRef(undefined, '')).toBe('')
  })
})

describe('EXPIRY_EXPRESSION — what incus itself accepts', () => {
  // Anchored to the binary, not to a man page: `incusd` 6.0.0 on this box holds
  // exactly one `^(\d+)(S|M|H|d|w|m|y)$` and one `Invalid expiry expression`,
  // and a `config set core.remote_token_expiry zzz` is rejected with that
  // message (probed 2026-08-18 with a value no parser accepts, so the daemon
  // refused it and nothing was written).

  test('takes every unit the daemon names, in the daemon’s casing', () => {
    for (const value of ['30S', '15M', '1H', '7d', '2w', '3m', '1y'])
      expect(EXPIRY_EXPRESSION.test(value), value).toBe(true)
  })

  test('the casing is the load-bearing part, so the near-misses are refused', () => {
    // `H` is hours and `m` is *months*, so `1h` and `1M` are both things a
    // reader would write meaning something else. Neither is accepted, which is
    // why this is copied from the binary rather than guessed.
    for (const value of ['1h', '1D', '1W', '1Y', '1s'])
      expect(EXPIRY_EXPRESSION.test(value), value).toBe(false)
  })

  test('refuses Go durations and anything with a second unit', () => {
    for (const value of ['1h30m', '90', 'H', '', '1H ', ' 1H', '1H1H', 'zzz'])
      expect(EXPIRY_EXPRESSION.test(value), value).toBe(false)
  })
})

describe('namesAnExpiry — whether what the daemon reports is a real deadline', () => {
  test('a positive count in a unit incus accepts is one', () => {
    for (const value of ['1H', '30S', '  1H\n', '10d'])
      expect(namesAnExpiry(value), JSON.stringify(value)).toBe(true)
  })

  test('what an unset key prints is not one', () => {
    // `core.remote_token_expiry` unset prints an empty line, and incus's own
    // documented default for it is "no expiry".
    for (const value of [undefined, '', '  ', '\n'])
      expect(namesAnExpiry(value), JSON.stringify(value)).toBe(false)
  })

  test('a zero count is not one either', () => {
    // `0H` parses and is not an expiry policy: it is every token being dead
    // before it can be handed over. Refused from the other end for the same
    // reason the empty string is.
    for (const value of ['0H', '0S', '00d']) expect(namesAnExpiry(value), value).toBe(false)
  })

  test('anything the daemon would reject outright is not one', () => {
    for (const value of ['zzz', '1h', '1h30m', '90'])
      expect(namesAnExpiry(value), value).toBe(false)
  })
})
