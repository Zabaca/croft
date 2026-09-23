import { afterEach, describe, expect, test } from 'bun:test'
import { r2Module } from './index'

/**
 * The r2 module had no test until 2026-09-02, which is how it kept a private
 * copy of the Cloudflare envelope long after `../cloudflare-api` existed: there
 * was nothing to notice that the copy and the seam had drifted.
 *
 * These drive the REAL apply/destroy against a stubbed `globalThis.fetch`, so
 * what is asserted is what reached the API — a converge that creates nothing
 * when the bucket is already there, a create when it is not, the scope hint on
 * a 10000, and a destroy that reports rather than throws.
 */

interface RecordedCall {
  method: string
  path: string
  body?: Record<string, unknown>
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Stub the API with a fixed set of existing buckets, recording every call. */
function installFetchStub(opts: {
  buckets?: string[]
  /** First-match override: `[payload, status]` short-circuits a route. */
  override?: (method: string, path: string) => [unknown, number] | undefined
}): RecordedCall[] {
  const calls: RecordedCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = init?.method ?? 'GET'
    const call: RecordedCall = { method, path: url.pathname }
    if (init?.body) call.body = JSON.parse(init.body as string)
    calls.push(call)

    const respond = (result: unknown, status = 200) =>
      new Response(JSON.stringify({ success: true, errors: [], result }), { status })

    const overridden = opts.override?.(method, url.pathname)
    if (overridden) return new Response(JSON.stringify(overridden[0]), { status: overridden[1] })

    if (method === 'GET' && url.pathname.endsWith('/r2/buckets')) {
      return respond({ buckets: (opts.buckets ?? []).map((name) => ({ name })) })
    }
    return respond(null)
  }) as typeof fetch
  return calls
}

const CTX = { secrets: { CLOUDFLARE_API_TOKEN: 'tok' }, imports: {}, projectRoot: '/tmp' }
const config = (over: Record<string, unknown> = {}) =>
  r2Module.configSchema.parse({ accountId: 'acct-1', bucketName: 'proj-prod', ...over })

const creates = (calls: RecordedCall[]) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith('/r2/buckets'))

describe('apply converges', () => {
  test('an existing bucket is left alone — no create, no delete', async () => {
    const calls = installFetchStub({ buckets: ['proj-prod', 'other'] })
    const out = await r2Module.apply(config(), CTX)

    expect(out).toEqual({ bucketName: 'proj-prod' })
    expect(creates(calls)).toHaveLength(0)
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  test('a missing bucket is created, with the location hint when one is given', async () => {
    const calls = installFetchStub({ buckets: ['other'] })
    await r2Module.apply(config({ locationHint: 'wnam' }), CTX)

    expect(creates(calls)).toHaveLength(1)
    expect(creates(calls)[0]!.body).toEqual({ name: 'proj-prod', locationHint: 'wnam' })
  })

  test('a rejected token names the one scope this module needs', async () => {
    const calls = installFetchStub({
      override: () => [
        {
          success: false,
          result: null,
          errors: [{ code: 10000, message: 'Authentication error' }],
        },
        403,
      ],
    })

    let error: Error | undefined
    try {
      await r2Module.apply(config(), CTX)
    } catch (e) {
      error = e as Error
    }

    expect(error).toBeDefined()
    expect(error!.message).toContain('Account → Workers R2 Storage: Edit')
    expect(error!.message).toContain('https://dash.cloudflare.com/profile/api-tokens')
    // Nothing was created off the back of a failed listing.
    expect(creates(calls)).toHaveLength(0)
  })
})

describe('destroy', () => {
  test('deletes the bucket', async () => {
    const calls = installFetchStub({ buckets: ['proj-prod'] })
    await r2Module.destroy!(config(), CTX)

    const deletes = calls.filter((c) => c.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.path).toBe('/client/v4/accounts/acct-1/r2/buckets/proj-prod')
  })

  test('an absent (or non-empty) bucket is reported, not thrown', async () => {
    // A throw here would abort the rest of a `zbc destroy`, and the most common
    // cause — a bucket that still has objects — is something an operator has to
    // read about rather than have retried.
    installFetchStub({
      override: (method) =>
        method === 'DELETE'
          ? [{ success: false, result: null, errors: [{ code: 10006, message: 'not found' }] }, 404]
          : undefined,
    })

    expect(await r2Module.destroy!(config(), CTX)).toBeUndefined()
  })
})
