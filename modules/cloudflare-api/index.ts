// The parts of "talk to the Cloudflare API" that no module should own twice:
// the base URL, the envelope Cloudflare wraps every response in, and the two
// names its modules call to read a credential out of an imported instance's
// outputs (the rule itself is the engine's, in `../../src/context`).
//
// Extracted the way `provision-core` was extracted, and for the same reason its
// header gives. `cloudflare-zone` wrote these first; `cloudflare-tunnel` needed
// the identical four, and the duplication was caught on the apply
// that introduced it — which is the whole point of that test, since the
// previous convention was a comment asking a human to notice, and by the time
// anybody counted the Cloudflare resolver was at four copies.
//
// The base URL below is the load-bearing one. Its `client/v4` is a version
// pin, not a protocol constant: the day it moves, it moves once — a promise
// that holds only while the string is written down in exactly one place, so it
// is deliberately absent from every comment in `modules/`, this one included.
//
// `cloudflare-email`, `cloudflare-token` and `r2` predated the extraction and
// carried private copies until 2026-09-02. Two of the copies knew things this
// file did not — that a body is not always JSON, and that a caller sometimes
// has to branch on the status — so they were folded in here (`CfError`, the
// non-JSON guard, `!res.ok`) rather than dropped on the way over. The only
// genuinely per-module part was naming which token scope was missing, and that
// is `CfOptions.hints`. `c9s/src/cf.ts` is a fifth copy and stays: it lives in
// a separate package and cannot import a template.

import { resolveOutput } from '../../src/context'

export const API = 'https://api.cloudflare.com/client/v4'

/**
 * One entry of the envelope's `errors` array.
 *
 * EVERY FIELD IS OPTIONAL, and that is the point. Cloudflare does not send one
 * shape: the documented one is `{code, message}`, and the Access endpoints
 * answer `{code, error}`. Typing this as `{message: string}` — which it was
 * until 2026-08-23 — is a claim about the API that the API does not honour, and
 * it reads as true because the field is simply absent rather than wrong.
 */
export interface CfApiError {
  code?: number | string
  message?: string
  error?: string
  [field: string]: unknown
}

/**
 * Cloudflare answers every call with this envelope, including failures — the
 * HTTP status is frequently 200 on an error, so `success` is the only field
 * that says whether anything happened.
 */
export interface CfEnvelope<T> {
  success: boolean
  errors: CfApiError[]
  result: T
  result_info?: { page: number; total_pages: number }
}

/** A field that is a non-empty string once trimmed, or nothing. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** One error entry as text, using whatever fields it actually carries. */
function describeCfError(entry: unknown): string {
  if (entry === null || entry === undefined) return ''
  if (typeof entry !== 'object') return String(entry)
  const fields = entry as CfApiError
  const code =
    typeof fields.code === 'number' || typeof fields.code === 'string'
      ? String(fields.code)
      : undefined
  const text = nonEmpty(fields.message) ?? nonEmpty(fields.error) ?? nonEmpty(fields.detail)
  if (text !== undefined) return code === undefined ? text : `${code}: ${text}`
  if (code !== undefined) {
    const { code: _code, ...rest } = fields
    const extra = JSON.stringify(rest)
    return extra === '{}' ? code : `${code}: ${extra}`
  }
  const all = JSON.stringify(fields)
  return all === '{}' ? '' : all
}

/**
 * Everything Cloudflare said about a failure, whichever shape it said it in.
 *
 * ⚠️ THE ACCESS ENDPOINTS ARE THE ONES THAT ANSWER IN THE UNDOCUMENTED SHAPE.
 * On 2026-08-15 `POST /accounts/{id}/access/apps` returned
 * `[{"code":1010,"error":"auth.forbidden"}]`. The line here read `e.message`
 * only, so it mapped to `[undefined]`, joined to the empty string, fell through
 * `||` to a bare `HTTP 403`, and the one fact in the response was thrown away.
 * Recovering `1010 auth.forbidden` took three throwaway diagnostic scripts, and
 * it was the whole answer: a token minted with zone-scoped grants.
 *
 * Pure; exported for tests, and exported because a module that has to describe
 * a failure Cloudflare reported outside `cf` — a batch call, a probe — must not
 * grow its own copy. That copying is what this file was extracted to end.
 */
export function describeCfErrors(errors: unknown, status: number): string {
  const entries = Array.isArray(errors) ? errors : []
  const parts = entries.map(describeCfError).filter((part) => part !== '')
  return parts.length > 0 ? parts.join('; ') : `HTTP ${status}`
}

/**
 * A failed Cloudflare call, with the two facts a caller may need to branch on:
 * the HTTP status, and every error code the envelope carried.
 *
 * `cloudflare-email` is why this is a class and not a bare `Error`: one of its
 * routing endpoints answers 404 on a shape the module then retries as a POST,
 * and `err.status === 404` is the only way to tell that apart from a real
 * failure. Everything thrown from `cfRaw`/`cf` is a `CfError`, so `instanceof`
 * is a safe narrowing at any call site — including the non-JSON case, where
 * `codes` is empty because there was no envelope to read codes out of.
 */
export class CfError extends Error {
  constructor(
    readonly status: number,
    readonly codes: number[],
    message: string,
  ) {
    super(message)
    this.name = 'CfError'
  }

  /** Did the envelope carry this error code? */
  has(code: number): boolean {
    return this.codes.includes(code)
  }
}

/** Per-call options for `cf`/`cfRaw`. */
export interface CfOptions {
  /**
   * Per-code replacements for the thrown message — the module's scope hint.
   *
   * A 10000 "Authentication error" is the same fact for every module and a
   * different instruction for each: `cloudflare-email` needs five token scopes
   * named, `r2` needs one. That naming is the only genuinely per-module part of
   * a Cloudflare failure, so it is the only hook here — the seam still throws
   * `CfError` with the same status and codes, and only the text changes.
   *
   * When an envelope carries several hinted codes, the LOWEST code wins —
   * deliberately, because the alternative is the order Cloudflare happened to
   * list its errors in, and a module's operator-facing text must not depend on
   * that. It also reproduces the copies this replaced, which tested their codes
   * in a fixed order (`cloudflare-email` checked 10000 before 10105).
   */
  hints?: Record<number, string>
}

/**
 * Every error code the envelope carried, as numbers.
 *
 * `code` is typed `number | string` because Cloudflare sends both spellings; a
 * numeric string is the same code and is coerced, and anything else — a
 * non-numeric string, a missing field, an entry that is not an object at all —
 * is not a code and is dropped rather than surfaced as `NaN`.
 *
 * Pure; exported for tests.
 */
export function collectCfCodes(errors: unknown): number[] {
  const entries = Array.isArray(errors) ? errors : []
  const codes: number[] = []
  for (const entry of entries) {
    const raw = (entry as CfApiError | null | undefined)?.code
    const code =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : Number.NaN
    if (Number.isFinite(code)) codes.push(code)
  }
  return codes
}

/**
 * Call the API and return the WHOLE envelope; throw a `CfError` on failure.
 * Callers that paginate need `result_info`, which is why this exists alongside
 * `cf` rather than under it.
 *
 * Two things it refuses to assume, both learned from the private copies this
 * replaced:
 *
 * - **The body is JSON.** A 5xx from Cloudflare's edge is an HTML page, and
 *   `res.json()` on it throws a parse error that names neither the call nor the
 *   status — the one moment a stack trace is least useful.
 * - **`success` is the whole verdict.** It usually is, which is why the field
 *   exists; but a body that says `success: true` under a 4xx did not succeed,
 *   and returning its `result` hands the caller a shape it never checked.
 */
export async function cfRaw<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  opts?: CfOptions,
): Promise<CfEnvelope<T>> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let payload: CfEnvelope<T> | null
  try {
    payload = (await res.json()) as CfEnvelope<T> | null
  } catch {
    throw new CfError(
      res.status,
      [],
      `Cloudflare API ${method} ${path}: HTTP ${res.status} (non-JSON body)`,
    )
  }
  if (!res.ok || !payload?.success) {
    const codes = collectCfCodes(payload?.errors)
    // Scanned over the hints rather than over `codes`, so which one wins is the
    // module's own ordering and not the API's — see `CfOptions.hints`.
    const hinted = Object.keys(opts?.hints ?? {})
      .map(Number)
      .find((code) => codes.includes(code))
    const hint = hinted === undefined ? undefined : opts?.hints?.[hinted]
    throw new CfError(
      res.status,
      codes,
      hint === undefined
        ? `Cloudflare API ${method} ${path} failed: ${describeCfErrors(payload?.errors, res.status)}`
        : `Cloudflare API ${method} ${path} ${hint}`,
    )
  }
  return payload
}

/** The common case: the envelope's `result`, or a throw. */
export async function cf<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  opts?: CfOptions,
): Promise<T> {
  return (await cfRaw<T>(token, method, path, body, opts)).result
}

/**
 * Resolve a `{ from, output }` credential reference against an instance's
 * imports, failing fast and by name.
 *
 * Every Cloudflare module takes its token this way rather than from
 * secrets.yaml, because `cloudflare-token` rolls minted values on every apply
 * and persists none of them — a copy at rest is a copy that is already stale.
 * The two error messages matter more than the happy path: a missing import and
 * a missing output are both silently `undefined` otherwise, and an apply that
 * carries `Bearer undefined` fails much later, at a Cloudflare 403 that reads
 * like a permissions problem.
 */
export function resolveApiToken(
  ref: { from: string; output: string },
  imports: Record<string, unknown>,
): string {
  return resolveRef(ref, imports, 'apiToken')
}

/**
 * The same resolution, for a reference that is NOT the API token.
 *
 * `apiToken` was the only `{from, output}` a Cloudflare module took until
 * `cloudflare-access` grew a list of service-token references. The field name
 * is a parameter because the error message is the whole value of this function:
 * one that says `apiToken` for the third entry of `serviceTokens` sends the
 * reader to the wrong line of an instance file.
 *
 * Both are now one line over `resolveOutput` — the rule and its three messages
 * live in `../../src/context`, and a module inside an `apply`/`destroy` should
 * say `ctx.output(ref, field)` instead, which every Cloudflare module in core
 * now does. These stay because they take a raw imports record rather than a
 * context, which is the only thing a caller outside an apply has, and because
 * removing an exported name from a vendored library breaks whoever wrote their
 * own Cloudflare module against it.
 *
 * Prefer `ctx.output` where you have a context: during a `destroy` it is the
 * call that can still answer. `cloudflare-tunnel`'s teardown read `ctx.imports`
 * through here and reported "which is not in this instance's imports" about an
 * instance that WAS imported — the engine simply had not applied it.
 */
export function resolveRef(
  ref: { from?: string; output?: string },
  imports: Record<string, unknown>,
  field: string,
): string {
  return resolveOutput(ref, imports, field)
}
