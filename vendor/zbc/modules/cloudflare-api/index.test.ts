import { afterEach, describe, expect, test } from 'bun:test'
import { CfError, cf, collectCfCodes, describeCfErrors, resolveApiToken, resolveRef } from './index'

/**
 * What Cloudflare said, when Cloudflare did not say it in the documented shape.
 *
 * This library exists so the envelope is unwrapped once. It was unwrapped once
 * and WRONGLY: `errors?.map((e) => e.message)` reads the documented field and
 * nothing else, and the Access endpoints answer in a different shape entirely.
 * Measured on 2026-08-15 against a live account:
 *
 *     POST /accounts/{id}/access/apps
 *       -> 403 {"result":null,"success":false,
 *               "errors":[{"code":1010,"error":"auth.forbidden"}]}
 *
 * There is no `message` in that. The map produced `[undefined]`, the join
 * produced the empty string, `||` fell through, and the caller was told a bare
 * `HTTP 403`. The one fact in the response was the one field never read, and
 * recovering `1010 auth.forbidden` took three throwaway diagnostic scripts. It
 * was also the whole answer: a token minted with zone-scoped grants.
 *
 * Fixed here rather than in the module that hit it, because every Cloudflare
 * module calls through this file and a per-module copy is the duplication this
 * file was extracted to end.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('describeCfErrors', () => {
  test('the measured Access response: code and error, both surfaced', () => {
    expect(describeCfErrors([{ code: 1010, error: 'auth.forbidden' }], 403)).toBe(
      '1010: auth.forbidden',
    )
  })

  test('the documented shape still reads the way it always did', () => {
    expect(describeCfErrors([{ message: 'quota exceeded' }], 400)).toBe('quota exceeded')
    expect(describeCfErrors([{ code: 10000, message: 'Authentication error' }], 401)).toBe(
      '10000: Authentication error',
    )
  })

  test('a shape nobody anticipated is printed rather than dropped', () => {
    expect(describeCfErrors([{ code: 7003, reason: 'no route' }], 404)).toBe(
      '7003: {"reason":"no route"}',
    )
  })

  test('several errors are joined, not reduced to the first', () => {
    expect(
      describeCfErrors([{ code: 1010, error: 'auth.forbidden' }, { message: 'and also' }], 403),
    ).toBe('1010: auth.forbidden; and also')
  })

  test('the status is the last resort, not the first', () => {
    expect(describeCfErrors([], 502)).toBe('HTTP 502')
    expect(describeCfErrors([{}], 502)).toBe('HTTP 502')
    expect(describeCfErrors(undefined, 502)).toBe('HTTP 502')
    expect(describeCfErrors('not an array', 502)).toBe('HTTP 502')
  })
})

describe('cf() carries what the API said, all the way to the caller', () => {
  test('the undocumented shape reaches the thrown message', async () => {
    // Exporting a correct reader and not calling it would leave every caller
    // exactly as mute as before, so this drives the real `cf`.
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          result: null,
          success: false,
          errors: [{ code: 1010, error: 'auth.forbidden' }],
        }),
        { status: 403 },
      )) as typeof fetch

    let error: Error | undefined
    try {
      await cf('tok', 'POST', '/accounts/a/access/apps', {})
    } catch (e) {
      error = e as Error
    }

    expect(error).toBeDefined()
    expect(error!.message).toContain('1010')
    expect(error!.message).toContain('auth.forbidden')
    // What it used to say, and all it used to say.
    expect(error!.message).not.toBe('Cloudflare API POST /accounts/a/access/apps failed: HTTP 403')
  })

  test('a success envelope is unwrapped to its result', async () => {
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, errors: [], result: { id: 'x' } }), {
        status: 200,
      })) as typeof fetch
    expect(await cf<{ id: string }>('tok', 'GET', '/whatever')).toEqual({ id: 'x' })
  })
})

/** Answer any call with this body and status. */
function answer(body: unknown, status: number, raw = false) {
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(raw ? (body as string) : JSON.stringify(body), { status })) as typeof fetch
}

/** Run `cf` and hand back whatever it threw, typed. */
async function thrown(opts?: Parameters<typeof cf>[4]): Promise<CfError> {
  try {
    await cf('tok', 'GET', '/zones/z/email/routing', undefined, opts)
  } catch (e) {
    return e as CfError
  }
  throw new Error('expected cf to throw')
}

/**
 * The two things the private copies knew and the seam did not.
 *
 * `cloudflare-email` and `r2` each carried a `cfFetch` of their own, and each
 * guarded a case this file did not: a body that is not JSON, and a `success`
 * that disagrees with the status. Folding the copies in meant absorbing both,
 * not just deleting them — a "shared" helper that loses a guard on the way over
 * is a regression wearing a refactor's clothes.
 */
describe('a failure the envelope could not describe', () => {
  test('an HTML 502 names the call and the status instead of a JSON parse error', async () => {
    // Cloudflare's edge answers 5xx with an HTML page. `res.json()` on that
    // throws `SyntaxError: Unexpected token '<'`, which says nothing about
    // which call died.
    answer('<html><body>502 Bad Gateway</body></html>', 502, true)
    const err = await thrown()
    expect(err).toBeInstanceOf(CfError)
    expect(err.status).toBe(502)
    expect(err.codes).toEqual([])
    expect(err.message).toContain('non-JSON body')
    expect(err.message).toContain('GET /zones/z/email/routing')
  })

  test('`success: true` under a 4xx is a failure, not a result', async () => {
    // `success` is normally the whole verdict — but a 4xx body claiming
    // success did not succeed, and unwrapping its `result` hands the caller a
    // shape it never checked.
    answer({ success: true, errors: [], result: { id: 'x' } }, 404)
    const err = await thrown()
    expect(err.status).toBe(404)
    expect(err.message).toContain('HTTP 404')
  })

  test('everything thrown is a CfError, including the ordinary failure', async () => {
    // `cloudflare-email` branches on `err.status === 404`, so a bare `Error`
    // from any path would silently take the wrong branch.
    answer({ success: false, errors: [{ code: 7003, message: 'no route' }], result: null }, 404)
    const err = await thrown()
    expect(err).toBeInstanceOf(CfError)
    expect(err.status).toBe(404)
    expect(err.has(7003)).toBe(true)
    expect(err.has(10000)).toBe(false)
  })
})

describe('hints name the scope, and nothing else changes', () => {
  const scope = { hints: { 10000: 'rejected the token — it needs R2 Storage: Edit.' } }
  const authFailure = {
    success: false,
    errors: [{ code: 10000, message: 'Authentication error' }],
    result: null,
  }

  test("a matching code replaces the message with the module's instruction", async () => {
    answer(authFailure, 403)
    const err = await thrown(scope)
    expect(err.message).toBe(
      'Cloudflare API GET /zones/z/email/routing rejected the token — it needs R2 Storage: Edit.',
    )
    // Only the text is per-module: the status and codes are still the API's.
    expect(err.status).toBe(403)
    expect(err.codes).toEqual([10000])
  })

  test('without the hint, the same failure reads as the API described it', async () => {
    answer(authFailure, 403)
    expect((await thrown()).message).toBe(
      'Cloudflare API GET /zones/z/email/routing failed: 10000: Authentication error',
    )
  })

  test('two hinted codes resolve the same way whatever order the API listed them', async () => {
    // The copies this replaced tested 10000 before 10105 unconditionally. A
    // scan over the errors array would instead hand the operator whichever
    // Cloudflare happened to put first — a different instruction for the same
    // failure, decided by nothing.
    const both = {
      hints: { 10000: 'needs a scope.', 10105: 'needs a paid plan.' },
    }
    const errors = [{ code: 10105 }, { code: 10000 }]

    answer({ success: false, errors, result: null }, 403)
    expect((await thrown(both)).message).toContain('needs a scope.')

    answer({ success: false, errors: errors.toReversed(), result: null }, 403)
    expect((await thrown(both)).message).toContain('needs a scope.')
  })

  test('a hint for a code the envelope did not carry is not applied', async () => {
    answer(
      { success: false, errors: [{ code: 10105, message: 'not entitled' }], result: null },
      403,
    )
    const err = await thrown(scope)
    expect(err.message).toContain('10105: not entitled')
    expect(err.message).not.toContain('R2 Storage')
  })
})

describe('collectCfCodes', () => {
  test('numbers and numeric strings are the same code', () => {
    // `CfApiError.code` is `number | string` because Cloudflare sends both.
    expect(collectCfCodes([{ code: 10000 }, { code: '10105' }])).toEqual([10000, 10105])
  })

  test('anything that is not a code is dropped, never surfaced as NaN', () => {
    expect(
      collectCfCodes([{ code: 'auth.forbidden' }, { message: 'no code' }, 'a string']),
    ).toEqual([])
    expect(collectCfCodes(undefined)).toEqual([])
  })
})

describe('resolveApiToken fails by name, not with `Bearer undefined`', () => {
  test('an instance that is not imported', () => {
    expect(() => resolveApiToken({ from: 'tok', output: 'tokenValue' }, {})).toThrow(/not in this/)
  })

  test('an output the instance does not emit', () => {
    expect(() => resolveApiToken({ from: 'tok', output: 'tokenValue' }, { tok: {} })).toThrow(
      /doesn't emit it/,
    )
  })

  test('the happy path', () => {
    expect(
      resolveApiToken({ from: 'tok', output: 'tokenValue' }, { tok: { tokenValue: 'v' } }),
    ).toBe('v')
  })

  test('resolveRef names the FIELD, so a module with several references says which', () => {
    // `apiToken` is no longer the only `{from, output}` a Cloudflare module
    // takes — cloudflare-access resolves a list of service tokens the same way.
    // A failure that says "apiToken" for the third service token sends the
    // reader to the wrong line of the instance.
    expect(() => resolveRef({ from: 'x', output: 'y' }, {}, 'serviceTokens[2]')).toThrow(
      /serviceTokens\[2\] references instance "x"/,
    )
    expect(() => resolveRef({ from: 'x', output: 'y' }, { x: {} }, 'serviceTokens[2]')).toThrow(
      /serviceTokens\[2\] references output "y"/,
    )
  })

  test('a reference missing half of itself is refused by name', () => {
    expect(() => resolveRef({ from: 'x' }, { x: { y: 'v' } }, 'serviceTokens[0]')).toThrow(
      /must name both/,
    )
  })
})
