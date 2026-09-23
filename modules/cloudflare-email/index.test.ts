import { afterEach, describe, expect, test } from 'bun:test'
import { classifySendingDns, cloudflareEmailModule, readSendingDnsRecord } from './index'

// Cloudflare's Email Sending API is beta and the module reads its record
// objects defensively, which is right. What was wrong is where the defensive
// value went: `String(r.status ?? r.state ?? 'unknown')` produced the literal
// 'unknown' when NEITHER field was present, and that string was then compared
// against active|verified|locked and reported as `Sending DNS pending`.
//
// So "I could not find the field" was printed as a claim about the customer's
// DNS. On cedarpad.com it fired on all four records — MX, SPF, DKIM, DMARC —
// every apply, while every one of them resolved correctly and `_dmarc` was
// `p=reject`, under which unaligned mail is refused rather than delivered. The
// passwordless login emails arriving were proof the records were fine.
//
// Absence and failure are different answers and only one of them is about DNS.

const rec = (over: Record<string, unknown> = {}) => ({
  type: 'TXT',
  name: '_dmarc.example.com',
  ...over,
})

describe('readSendingDnsRecord', () => {
  test('reads the status Cloudflare reported', () => {
    expect(readSendingDnsRecord(rec({ status: 'active' }), 'example.com').status).toBe('active')
  })

  test('accepts `state` as well, since the beta API has used both', () => {
    expect(readSendingDnsRecord(rec({ state: 'pending' }), 'example.com').status).toBe('pending')
  })

  // The defect, at its source: no status field must read as "not reported",
  // never as a status string that downstream comparisons can fail.
  test('reports null — not "unknown" — when the API carried no status', () => {
    expect(readSendingDnsRecord(rec(), 'example.com').status).toBeNull()
  })

  test('labels the record by type and name, as the warning prints it', () => {
    expect(readSendingDnsRecord(rec({ type: 'MX', name: 'cf-bounce.example.com' }), 'x').key).toBe(
      'MX cf-bounce.example.com',
    )
  })

  test('falls back on the label only, where a wrong guess costs nothing', () => {
    const r = readSendingDnsRecord({}, 'example.com')
    expect(r.key).toBe('record example.com')
    expect(r.status).toBeNull()
  })
})

describe('classifySendingDns', () => {
  const read = (rs: Array<Record<string, unknown>>) =>
    classifySendingDns(rs.map((r) => readSendingDnsRecord(r, 'example.com')))

  test.each(['active', 'verified', 'locked'])('%s is live: neither pending nor unreported', (s) => {
    const v = read([rec({ status: s })])
    expect(v.pending).toEqual([])
    expect(v.unreported).toEqual([])
  })

  test('a reported status outside that set is pending — the real warning survives', () => {
    const v = read([rec({ status: 'initializing' })])
    expect(v.pending.map((p) => p.status)).toEqual(['initializing'])
    expect(v.unreported).toEqual([])
  })

  // The whole point. Four records with no status is not four broken records.
  test('records with no reported status are unreported, never pending', () => {
    const v = read([rec({ type: 'MX' }), rec({ type: 'TXT' })])
    expect(v.pending).toEqual([])
    expect(v.unreported).toHaveLength(2)
  })

  test('a mixed answer separates the two rather than merging them', () => {
    const v = read([rec({ status: 'active' }), rec({ status: 'initializing' }), rec()])
    expect(v.pending).toHaveLength(1)
    expect(v.unreported).toHaveLength(1)
  })

  test('no records at all is not a problem to report', () => {
    const v = classifySendingDns([])
    expect(v.pending).toEqual([])
    expect(v.unreported).toEqual([])
  })
})

// ── the envelope this module no longer owns ─────────────────────────────────
//
// Until 2026-09-02 this file carried a private `cfFetch` with its own error
// types and its own copy of the base URL. It now calls `../cloudflare-api`, and
// the two things the copy did that the seam did not — a typed error carrying
// the status, and per-code scope guidance — moved into the seam as `CfError`
// and `CfOptions.hints` rather than being dropped.
//
// The scope hint is the operator-facing half: a 10000 means the token is short
// a scope, and which five scopes it needs is the only thing this module knows
// that the seam does not.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const CONFIG = {
  accountId: 'acct-1',
  zoneId: 'zone-1',
  domain: 'mail.example.com',
  enableSending: true,
}

async function applyAgainst(body: unknown, status: number): Promise<Error> {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
  try {
    await cloudflareEmailModule.apply(cloudflareEmailModule.configSchema.parse(CONFIG), {
      secrets: { CLOUDFLARE_API_TOKEN: 'tok' },
      imports: {},
      projectRoot: '/tmp',
    })
  } catch (e) {
    return e as Error
  }
  throw new Error('expected apply to throw')
}

describe('a failure Cloudflare reported', () => {
  test('the undocumented `{code, error}` shape surfaces its code', async () => {
    // The 2026-08-15 shape. The old copy read `e.message` only, so this
    // arrived as `…failed (HTTP 403): undefined: undefined`.
    const err = await applyAgainst(
      { success: false, result: null, errors: [{ code: 1010, error: 'auth.forbidden' }] },
      403,
    )
    expect(err.message).toContain('1010')
    expect(err.message).toContain('auth.forbidden')
  })

  test('a 10000 still names all five token scopes the operator has to grant', async () => {
    const err = await applyAgainst(
      { success: false, result: null, errors: [{ code: 10000, message: 'Authentication error' }] },
      403,
    )
    expect(err.message).toContain('Zone → Email Routing Rules: Edit')
    expect(err.message).toContain('Zone → Zone Settings: Edit')
    expect(err.message).toContain('Zone → DNS: Edit')
    expect(err.message).toContain('Account → Email Sending: Edit')
    expect(err.message).toContain('Account → Email Routing Addresses: Edit')
    expect(err.message).toContain('https://dash.cloudflare.com/profile/api-tokens')
  })

  test('a 10105 says the account needs a Workers Paid plan, not "authentication"', async () => {
    const err = await applyAgainst(
      { success: false, result: null, errors: [{ code: 10105, message: 'not entitled' }] },
      403,
    )
    expect(err.message).toContain('Workers Paid plan')
    expect(err.message).not.toContain('Email Routing Rules')
  })
})
