// The parts of "talk to a Google API" that no module should own twice: reading
// a service-account key out of secrets.yaml, turning it into a bearer token via
// the RS256 JWT grant, and unwrapping the error shape every Google API answers
// with.
//
// Extracted for the reason `cloudflare-api` was: ceo and foothill each carry a
// `gcp` module whose first sixty lines are this file, hand-rolled, twice. It is
// deliberately raw REST rather than `googleapis` or a shelled-out `gcloud` —
// the grant is twenty lines, an SDK is a hundred megabytes and a second auth
// story, and `gcloud` is a binary a CI runner does not have.

import { createSign } from 'node:crypto'

/** Google's OAuth2 token endpoint — the JWT bearer grant's audience. */
export const TOKEN_URI = 'https://oauth2.googleapis.com/token'
/** The IAM API root, where service accounts and their keys live. */
export const IAM_API = 'https://iam.googleapis.com/v1'

/** The scope that covers every call these modules make. */
export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/**
 * The fields of a downloaded service-account key JSON that anything here uses.
 * The file carries a dozen more (`type`, `private_key_id`, the x509 URLs); none
 * of them are read, and none are required to be present.
 */
export interface GcpCredential {
  client_email: string
  private_key: string
  project_id?: string
  token_uri?: string
}

/**
 * A service-account key JSON as a credential, or a hard error naming what is
 * missing.
 *
 * The failure this guards is the one a consumer actually hits: a key pasted
 * into secrets.yaml through a YAML scalar that ate the newlines, so
 * `private_key` is one long line and `createSign` fails much later with
 * something about DECODER routines. Both fields are checked here, at the edge,
 * where the message can name the secret.
 */
export function parseServiceAccountKey(raw: string, secretName: string): GcpCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `${secretName} is not valid JSON — it must be the whole service-account key file, verbatim`,
      { cause: err },
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${secretName} must be a service-account key JSON object`)
  }
  const fields = parsed as Record<string, unknown>
  const clientEmail = fields.client_email
  const privateKey = fields.private_key
  if (typeof clientEmail !== 'string' || clientEmail === '') {
    throw new Error(`${secretName} has no "client_email" — is it a service-account key file?`)
  }
  if (typeof privateKey !== 'string') {
    throw new Error(`${secretName} has no "private_key" — is it a service-account key file?`)
  }
  // The `\n` form is what a key survives as when it is pasted through a JSON
  // string; unescape FIRST so the PEM check below judges the bytes that will
  // actually be signed with, not the escaped ones.
  const pem = privateKey.replace(/\\n/g, '\n')
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]*\n/.test(pem)) {
    throw new Error(
      `${secretName}'s "private_key" is not a PEM block with real newlines — a key whose newlines were eaten by a YAML scalar looks exactly like this, and would fail much later inside the signer`,
    )
  }
  return {
    client_email: clientEmail,
    private_key: pem,
    project_id: typeof fields.project_id === 'string' ? fields.project_id : undefined,
    token_uri: typeof fields.token_uri === 'string' ? fields.token_uri : undefined,
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * The signed assertion the JWT bearer grant trades for an access token.
 * Exported for tests: it is the one piece here that is pure given a clock.
 */
export function signAssertion(
  credential: GcpCredential,
  scopes: readonly string[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const audience = credential.token_uri ?? TOKEN_URI
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(
    JSON.stringify({
      iss: credential.client_email,
      scope: scopes.join(' '),
      aud: audience,
      iat: nowSeconds,
      // One hour is Google's maximum for this grant; anything larger is
      // rejected as invalid rather than clamped.
      exp: nowSeconds + 3600,
    }),
  )
  const signingInput = `${header}.${claims}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(credential.private_key)
  return `${signingInput}.${base64url(signature)}`
}

/** An OAuth2 access token for this credential, good for an hour. */
export async function accessToken(
  credential: GcpCredential,
  scopes: readonly string[] = [CLOUD_PLATFORM_SCOPE],
): Promise<string> {
  const res = await fetch(credential.token_uri ?? TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signAssertion(credential, scopes),
    }).toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new GcpError(res.status, `token grant refused: ${text.slice(0, 400)}`)
  }
  const body = JSON.parse(text) as { access_token?: string }
  if (typeof body.access_token !== 'string') {
    throw new GcpError(res.status, 'token grant returned no access_token')
  }
  return body.access_token
}

/**
 * A failed Google call, carrying the HTTP status.
 *
 * The status is the field callers branch on and the reason this is a class
 * rather than a message: a 404 from the keys endpoint seconds after the account
 * was created means "not ready yet", and a 403 from the same endpoint means the
 * bootstrap credential is missing a role. Only the status tells them apart.
 */
export class GcpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Google API ${status}: ${message}`)
    this.name = 'GcpError'
  }
}

/**
 * One authenticated Google REST call, unwrapped.
 *
 * Google answers a failure with `{ error: { code, message, status } }` and a
 * matching HTTP status — unlike Cloudflare it does not lie about the status
 * line, so `res.ok` is the whole test. An empty body comes back as `undefined`.
 */
export async function gcp<T>(
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new GcpError(res.status, `${method} ${url} — ${describeError(text)}`)
  }
  // An empty body — some IAM mutations answer 200 with `{}`, others 204 with
  // nothing at all. Neither carries a result any caller here reads.
  if (text.trim() === '') return undefined as T
  return JSON.parse(text) as T
}

/** The `error.message` Google sends, or the raw body when it sent something else. */
function describeError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } }
    const message = parsed.error?.message
    if (typeof message === 'string' && message !== '') {
      return parsed.error?.status ? `${parsed.error.status}: ${message}` : message
    }
  } catch {
    // Not JSON — an HTML error page from a proxy, most often. Fall through.
  }
  return text.slice(0, 400)
}
