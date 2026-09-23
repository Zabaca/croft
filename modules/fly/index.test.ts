import { describe, expect, test } from 'bun:test'
import { certsToRequest, machineCount, machinesConverged, resolveFlyValue } from './index'

/**
 * The four sentences flyctl uses to say "the machines are up".
 *
 * The guard this covers knew three of them. The fourth — the rolling-update
 * line — is what every deploy after an app's first one prints, so the guard
 * was green exactly until walgit was deployed a second time, then red on a
 * deploy that had converged. The transcripts below are copied from real
 * flyctl output rather than paraphrased, because a paraphrase would have
 * passed the old regex too.
 */
describe('machinesConverged', () => {
  test('accepts a rolling update of an existing machine', () => {
    // Verbatim from Production run 32881480843 (zbc-walgit, 2026-08-25).
    expect(
      machinesConverged(`Updating existing machines in 'zbc-walgit' with rolling strategy
> Acquiring lease for 28792d7b453948
> Updating machine config for 28792d7b453948
> Waiting for machine 28792d7b453948 to reach a good state
> Machine 28792d7b453948 reached stopped state
✔ Machine 28792d7b453948 is now in a good state
> Clearing lease for 28792d7b453948`),
    ).toBe(true)
  })

  test('accepts the three first-launch confirmations it already knew', () => {
    expect(machinesConverged('Finished launching new machines')).toBe(true)
    expect(machinesConverged('update finished: success')).toBe(true)
    expect(machinesConverged('No machines in group app')).toBe(true)
  })

  test('rejects a build that never mentions a machine', () => {
    // flyctl exits 0 here. This is the whole reason the guard exists.
    expect(
      machinesConverged(`==> Verifying app config
--> Verified app config
==> Building image with Depot
#15 [11/11] RUN chmod +x /entrypoint.sh
Visit your newly deployed app at https://zbc-walgit.fly.dev/`),
    ).toBe(false)
  })

  test('a stopped machine alone is not convergence', () => {
    // Printed both by an auto-stopped machine on its way to a good state and
    // by one that stopped because it died. Only the good-state line settles it.
    expect(machinesConverged('> Machine 28792d7b453948 reached stopped state')).toBe(false)
  })
})

/**
 * The four shapes a `flySecrets` entry can take.
 *
 * The alias form exists because an app's env var name and the secrets.yaml key
 * holding its value are set by different people: the app declares what it
 * reads, and the environment decides what a credential is called. walgit reads
 * `WALGIT_S3_ACCESS_KEY_ID`; the R2 credential it needs is filed under
 * `WAREHOUSE_R2_ACCESS_KEY_ID`, because Cloudflare derives one S3 credential
 * per API token and both apps share the account's. Without the alias the only
 * way to bridge those is a second copy of the credential under a second name —
 * which stays correct exactly until someone rotates one of them.
 */
describe('resolveFlyValue', () => {
  const ctx = {
    secrets: { WAREHOUSE_R2_ACCESS_KEY_ID: 'akid-123', PLAIN: 'plain-value' },
    imports: { 'walgit-wal': { bucketName: 'zbc-walgit-wal' } },
  }

  test('a plain name takes the secret and its own spelling', () => {
    expect(resolveFlyValue('PLAIN', ctx, 'flySecrets')).toEqual({
      name: 'PLAIN',
      value: 'plain-value',
    })
  })

  test('an alias exposes one secret under a different env var name', () => {
    expect(
      resolveFlyValue(
        { name: 'WALGIT_S3_ACCESS_KEY_ID', secret: 'WAREHOUSE_R2_ACCESS_KEY_ID' },
        ctx,
        'flySecrets',
      ),
    ).toEqual({ name: 'WALGIT_S3_ACCESS_KEY_ID', value: 'akid-123' })
  })

  test('an alias to a missing secret names both halves', () => {
    // The message has to say which env var wanted it AND which key was looked
    // up: with an alias those are different strings, and an error naming only
    // one sends the reader to the wrong file.
    expect(() =>
      resolveFlyValue({ name: 'WALGIT_S3_ACCESS_KEY_ID', secret: 'NOPE' }, ctx, 'flySecrets'),
    ).toThrow(/WALGIT_S3_ACCESS_KEY_ID.*NOPE/)
  })

  test('a literal and an import still resolve', () => {
    expect(resolveFlyValue({ name: 'ENDPOINT', value: 'https://x' }, ctx, 'flySecrets')).toEqual({
      name: 'ENDPOINT',
      value: 'https://x',
    })
    expect(
      resolveFlyValue(
        { name: 'WALGIT_S3_BUCKET', from: 'walgit-wal', output: 'bucketName' },
        ctx,
        'flySecrets',
      ),
    ).toEqual({ name: 'WALGIT_S3_BUCKET', value: 'zbc-walgit-wal' })
  })
})

/**
 * Real `fly certs list` output. The header row matters: its first field is
 * "Host", which must not be mistaken for a hostname that already has a
 * certificate — a made-up sample without one would let that bug through.
 */
const CERTS_LIST = `Host                    Added                    Status
git.zabaca.com          2026-08-28T22:00:00Z     Ready
old.zabaca.com          2026-01-02T10:00:00Z     Ready
`

describe('certsToRequest', () => {
  test('asks only for hostnames the app does not already have', () => {
    expect(certsToRequest(CERTS_LIST, ['git.zabaca.com'])).toEqual([])
    expect(certsToRequest(CERTS_LIST, ['new.zabaca.com'])).toEqual(['new.zabaca.com'])
    expect(certsToRequest(CERTS_LIST, ['git.zabaca.com', 'new.zabaca.com'])).toEqual([
      'new.zabaca.com',
    ])
  })

  test('an empty list asks for everything', () => {
    // A brand-new app: flyctl prints a header and nothing else.
    expect(certsToRequest('Host Added Status\n', ['git.zabaca.com'])).toEqual(['git.zabaca.com'])
    expect(certsToRequest('', ['git.zabaca.com'])).toEqual(['git.zabaca.com'])
  })

  test('a longer hostname containing a listed one is still requested', () => {
    // Substring matching would skip this and leave it without a certificate,
    // which no error anywhere would report.
    expect(certsToRequest(CERTS_LIST, ['www.git.zabaca.com'])).toEqual(['www.git.zabaca.com'])
  })
})

/** Verbatim `fly scale show` output, box-drawing characters and all. */
const SCALE_SHOW = `Groups
 NAME │ COUNT │ KIND   │ CPUS │ MEMORY │ REGIONS
 app  │ 1     │ shared │ 1    │ 512 MB │ sjc
`

describe('machineCount', () => {
  test('reads the app process group count', () => {
    expect(machineCount(SCALE_SHOW)).toBe(1)
    expect(machineCount(SCALE_SHOW.replace('│ 1     │ shared', '│ 2     │ shared'))).toBe(2)
  })

  test('output it cannot read means do not scale, never scale to zero', () => {
    // A flyctl that reworded the table, or a call that failed outright.
    // Returning 0 here would destroy every machine the app has.
    expect(machineCount('')).toBeUndefined()
    expect(machineCount('Error: no access to this app\n')).toBeUndefined()
    expect(machineCount('NAME COUNT KIND\napp 1 shared\n')).toBeUndefined()
  })

  test('a non-app process group is not mistaken for the app', () => {
    const withWorker = SCALE_SHOW + ' worker │ 7     │ shared │ 1    │ 512 MB │ sjc\n'
    expect(machineCount(withWorker)).toBe(1)
  })
})
