import { generateKeyPairSync } from 'node:crypto'
import { afterEach, expect, test } from 'bun:test'
import { createTestContext } from '../../src/testing'
import { gcpServiceAccountModule } from './index'

/**
 * End-to-end tests for gcp-service-account.
 *
 * They call the REAL `apply`/`destroy`/`ready.probe` through a `createTestContext`
 * over a stubbed `globalThis.fetch` that implements the IAM endpoints from
 * declarative per-test state — the pattern `cloudflare-token` established. Every
 * call is recorded, so the assertions are about what actually reached Google.
 */

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function keyFile(clientEmail: string, id = 'bootstrap'): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'my-project',
    private_key_id: id,
    client_email: clientEmail,
    private_key: PEM,
  })
}

const BOOTSTRAP_KEY = keyFile('bootstrap@my-project.iam.gserviceaccount.com')
const EMAIL = 'scheduler@my-project.iam.gserviceaccount.com'

interface RecordedCall {
  method: string
  url: string
  body?: Record<string, unknown>
  authorization?: string
}

interface StubKey {
  /** Full resource name, as IAM returns it. */
  name: string
  validAfterTime: string
  keyType: 'USER_MANAGED' | 'SYSTEM_MANAGED'
}

interface StubState {
  /** Existing service accounts by email. */
  accounts?: Record<string, { email: string; displayName?: string }>
  keys?: StubKey[]
  /** Answer the keys LIST with this status instead of the list (the window a
   * just-created account spends 404ing its own keys collection). */
  keysListStatus?: number
  /** Soft-deleted account ids: create answers 409 until `:undelete`. */
  softDeleted?: Set<string>
  /** Refuse the token grant for these client emails (a key not yet live). */
  tokenRefusedFor?: Set<string>
}

function userKey(id: string, validAfterTime: string): StubKey {
  return {
    name: `projects/my-project/serviceAccounts/${EMAIL}/keys/${id}`,
    validAfterTime,
    keyType: 'USER_MANAGED',
  }
}

function respond(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function installFetchStub(state: StubState): { calls: RecordedCall[]; state: StubState } {
  const calls: RecordedCall[] = []
  state.accounts ??= {}
  state.keys ??= []
  let minted = 0

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: RecordedCall = { method, url, authorization: headers.Authorization }
    if (init?.body && typeof init.body === 'string' && init.body.startsWith('{')) {
      call.body = JSON.parse(init.body)
    }
    calls.push(call)

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      // The assertion carries the client_email of whoever is authenticating —
      // which is how a test can refuse the MINTED key while the bootstrap key
      // still works.
      const assertion = new URLSearchParams(init?.body as string).get('assertion') ?? ''
      const claims = JSON.parse(
        Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as { iss?: string }
      if (state.tokenRefusedFor?.has(claims.iss ?? '')) {
        return new Response('{"error":"invalid_grant"}', { status: 400 })
      }
      return respond({ access_token: `token-for-${claims.iss}`, expires_in: 3600 })
    }

    const u = new URL(url)
    const path = u.pathname

    // .../serviceAccounts/{email}/keys
    const keysMatch = path.match(/\/serviceAccounts\/([^/]+)\/keys$/)
    if (keysMatch && method === 'GET') {
      if (state.keysListStatus) {
        return respond(
          { error: { code: state.keysListStatus, message: 'not found' } },
          state.keysListStatus,
        )
      }
      // IAM returns SYSTEM_MANAGED keys too unless the filter says otherwise,
      // and those must never be pruning candidates: they cannot be deleted.
      const wanted = u.searchParams.get('keyTypes')
      const keys = wanted ? state.keys?.filter((k) => k.keyType === wanted) : state.keys
      return respond({ keys })
    }
    if (keysMatch && method === 'POST') {
      minted += 1
      const id = `minted-${minted}`
      state.keys?.push(userKey(id, `2026-01-0${minted}T00:00:00Z`))
      return respond({
        name: `${path.slice(1)}/${id}`,
        privateKeyData: Buffer.from(keyFile(EMAIL, id)).toString('base64'),
      })
    }
    const keyMatch = path.match(/\/serviceAccounts\/([^/]+)\/keys\/([^/]+)$/)
    if (keyMatch && method === 'DELETE') {
      state.keys = state.keys?.filter((k) => !k.name.endsWith(`/keys/${keyMatch[2]}`))
      return respond({})
    }

    if (method === 'POST' && path.endsWith(':undelete')) {
      const email = path.slice(path.lastIndexOf('/') + 1).replace(':undelete', '')
      state.softDeleted?.delete(email)
      if (state.accounts) state.accounts[email] = { email }
      return respond({ restoredAccount: { email } })
    }

    const accountMatch = path.match(/\/serviceAccounts\/([^/]+)$/)
    if (accountMatch && (method === 'GET' || method === 'PATCH')) {
      const existing = state.accounts?.[accountMatch[1] as string]
      if (!existing) return respond({ error: { code: 404, message: 'not found' } }, 404)
      if (method === 'PATCH') {
        // The mask is a body field on this method; a patch that does not carry
        // one changes nothing, which is the bug this branch exists to expose.
        if (call.body?.updateMask === 'displayName') {
          const patch = call.body?.serviceAccount as { displayName?: string } | undefined
          existing.displayName = patch?.displayName
        }
      }
      return respond(existing)
    }
    if (path.endsWith('/serviceAccounts') && method === 'POST') {
      const accountId = (call.body?.accountId ?? '') as string
      const project = path.split('/')[3]
      const email = `${accountId}@${project}.iam.gserviceaccount.com`
      if (state.softDeleted?.has(email)) {
        return respond({ error: { code: 409, message: 'ALREADY_EXISTS' } }, 409)
      }
      const account = {
        email,
        displayName: (call.body?.serviceAccount as { displayName?: string } | undefined)
          ?.displayName,
      }
      if (state.accounts) state.accounts[email] = account
      return respond(account)
    }
    if (accountMatch && method === 'DELETE') {
      const key = accountMatch[1] as string
      if (!state.accounts?.[key])
        return respond({ error: { code: 404, message: 'not found' } }, 404)
      delete state.accounts[key]
      return respond({})
    }

    return respond({ error: { code: 404, message: `unstubbed ${method} ${path}` } }, 404)
  }) as typeof fetch

  return { calls, state }
}

const CONFIG = {
  projectId: 'my-project',
  serviceAccountId: 'scheduler',
  displayName: 'Scheduler',
}

function ctx() {
  return createTestContext({ secrets: { GCP_SERVICE_ACCOUNT_KEY: BOOTSTRAP_KEY } })
}

function existingAccount(displayName?: string): StubState['accounts'] {
  return { [EMAIL]: { email: EMAIL, ...(displayName ? { displayName } : {}) } }
}

test('creates the service account when absent and mints a key for this apply', async () => {
  const { calls } = installFetchStub({})
  const config = gcpServiceAccountModule.configSchema.parse(CONFIG)
  const outputs = await gcpServiceAccountModule.apply(config, ctx())

  expect(outputs.saEmail).toBe(EMAIL)
  // The key is the DECODED key file, not the base64 IAM returns: a consumer
  // pipes it straight into GOOGLE_APPLICATION_CREDENTIALS or a worker secret.
  expect(JSON.parse(outputs.saKey).private_key_id).toBe('minted-1')
  expect(outputs.saKeyId).toBe('minted-1')

  const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/serviceAccounts'))
  expect(created?.body).toEqual({
    accountId: 'scheduler',
    serviceAccount: { displayName: 'Scheduler' },
  })
  // Every IAM call goes out as the bootstrap credential.
  const iamCalls = calls.filter((c) => c.url.startsWith('https://iam.googleapis.com'))
  expect(iamCalls.length).toBeGreaterThan(0)
  for (const call of iamCalls) {
    expect(call.authorization).toBe('Bearer token-for-bootstrap@my-project.iam.gserviceaccount.com')
  }
  // Only user-managed keys are pruning candidates.
  const listed = iamCalls.find((c) => c.method === 'GET' && c.url.includes('/keys'))
  expect(listed?.url).toContain('keyTypes=USER_MANAGED')
})

test('mints a new key on every apply and prunes to maxKeys, oldest first', async () => {
  const { calls, state } = installFetchStub({
    accounts: existingAccount('Scheduler'),
    // Two keys already there: one from the last apply, one older still — plus a
    // system-managed key IAM will not let anyone delete.
    keys: [
      userKey('old', '2025-01-01T00:00:00Z'),
      userKey('previous', '2025-06-01T00:00:00Z'),
      {
        name: `projects/my-project/serviceAccounts/${EMAIL}/keys/google-managed`,
        validAfterTime: '2024-01-01T00:00:00Z',
        keyType: 'SYSTEM_MANAGED',
      },
    ],
  })
  const config = gcpServiceAccountModule.configSchema.parse({ ...CONFIG, maxKeys: 2 })

  const first = await gcpServiceAccountModule.apply(config, ctx())
  const second = await gcpServiceAccountModule.apply(config, ctx())

  expect(first.saKeyId).toBe('minted-1')
  expect(second.saKeyId).toBe('minted-2')
  expect(second.saKey).not.toBe(first.saKey)

  // maxKeys: 2 leaves room for the key about to be minted, so each apply drops
  // exactly one: the first saw {old, previous} and dropped `old`, the second saw
  // {previous, minted-1} and dropped `previous` — oldest first, so the key the
  // previous apply handed out survives a full cycle. The system-managed key is
  // never a candidate.
  const deleted = calls
    .filter((c) => c.method === 'DELETE')
    .map((c) => c.url.slice(c.url.lastIndexOf('/') + 1))
  expect(deleted).toEqual(['old', 'previous'])
  expect(state.keys?.map((k) => k.name.slice(k.name.lastIndexOf('/') + 1))).toEqual([
    'google-managed',
    'minted-1',
    'minted-2',
  ])

  // The account already existed: no create call, and no display-name PATCH
  // since it already matches.
  expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/serviceAccounts'))).toBe(false)
  expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
})

test('converges a drifted display name with the mask IAM reads', async () => {
  const { calls, state } = installFetchStub({ accounts: existingAccount('Old name') })
  const config = gcpServiceAccountModule.configSchema.parse(CONFIG)

  await gcpServiceAccountModule.apply(config, ctx())

  const patch = calls.find((c) => c.method === 'PATCH')
  // The mask is a BODY field on serviceAccounts.patch. Sent as a query
  // parameter it is ignored and the name silently never converges.
  expect(patch?.body).toEqual({
    serviceAccount: { displayName: 'Scheduler' },
    updateMask: 'displayName',
  })
  expect(patch?.url).not.toContain('updateMask')
  expect(state.accounts?.[EMAIL]?.displayName).toBe('Scheduler')
})

test('retries the keys endpoint while a just-created account 404s it', async () => {
  const stub = installFetchStub({ keysListStatus: 404 })
  // The window ceo and foothill each hand-rolled a retry loop around — it is
  // inside apply, before `ready` is ever consulted.
  setTimeout(() => {
    stub.state.keysListStatus = undefined
  }, 2_500)

  const config = gcpServiceAccountModule.configSchema.parse(CONFIG)
  const outputs = await gcpServiceAccountModule.apply(config, ctx())

  expect(outputs.saKeyId).toBe('minted-1')
  const listCalls = stub.calls.filter((c) => c.method === 'GET' && c.url.includes('/keys?'))
  expect(listCalls.length).toBeGreaterThan(1)
}, 20_000)

test('a permanent failure on the keys endpoint is not retried forever', async () => {
  installFetchStub({ keysListStatus: 401 })
  const config = gcpServiceAccountModule.configSchema.parse(CONFIG)
  await expect(gcpServiceAccountModule.apply(config, ctx())).rejects.toThrow(/401/)
})

test('undeletes a soft-deleted account rather than failing the re-apply', async () => {
  const { calls, state } = installFetchStub({ softDeleted: new Set([EMAIL]) })
  const config = gcpServiceAccountModule.configSchema.parse(CONFIG)

  // IAM's delete is a 30-day soft delete, so the second apply of an ephemeral
  // instance meets its own tombstone.
  const outputs = await gcpServiceAccountModule.apply(config, ctx())

  expect(outputs.saEmail).toBe(EMAIL)
  expect(calls.some((c) => c.url.endsWith(':undelete'))).toBe(true)
  expect(state.accounts?.[EMAIL]).toBeDefined()
})

test('readiness holds until the minted key can obtain a token', async () => {
  const stub = installFetchStub({
    accounts: existingAccount(),
    tokenRefusedFor: new Set([EMAIL]),
  })
  const config = gcpServiceAccountModule.configSchema.parse(CONFIG)
  const probe = gcpServiceAccountModule.ready?.probe
  if (!probe) throw new Error('gcp-service-account must declare a readiness probe')

  const outputs = await gcpServiceAccountModule.apply(config, ctx())
  // What a dependent does with these outputs is authenticate AS the account —
  // and a key is not live at the token endpoint the instant IAM hands it over.
  await expect(probe(outputs, config, ctx())).rejects.toThrow(/token grant refused/)

  stub.state.tokenRefusedFor?.delete(EMAIL)
  await probe(outputs, config, ctx())
})

test('declares saKey as a per-apply credential, and ships no Calendar half', () => {
  expect(gcpServiceAccountModule.secretOutputs?.saKey?.rotates).toBe('each-apply')
  // An id names the credential and is not it; redacting it would cost the
  // operator the field that finds the key in the console.
  expect(gcpServiceAccountModule.secretOutputs?.saKeyId).toBeUndefined()

  // The welded consumer module's interface, verbatim, is the thing this module
  // deliberately is not: its outputs were {saKey, saEmail, calendarId} over a
  // config carrying calendarSummary/calendarTimeZone.
  expect(Object.keys(gcpServiceAccountModule.outputsSchema.shape).toSorted()).toEqual([
    'saEmail',
    'saKey',
    'saKeyId',
  ])
  expect(Object.keys(gcpServiceAccountModule.configSchema.shape).toSorted()).toEqual([
    'credentialSecret',
    'displayName',
    'maxKeys',
    'projectId',
    'serviceAccountId',
  ])
})

test('destroy deletes the account, and is a no-op when it is already gone', async () => {
  const { calls, state } = installFetchStub({ accounts: existingAccount() })
  const config = gcpServiceAccountModule.configSchema.parse(CONFIG)
  if (!gcpServiceAccountModule.destroy) throw new Error('gcp-service-account must define destroy')

  await gcpServiceAccountModule.destroy(config, ctx())
  expect(state.accounts).toEqual({})
  expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)

  // Second run: IAM answers 404 and destroy must still succeed, which is what
  // makes `zbc destroy` re-runnable after a partial teardown.
  await gcpServiceAccountModule.destroy(config, ctx())
  expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2)
})

test('a 403 on the account read is not swallowed into a create', async () => {
  installFetchStub({
    accounts: existingAccount(),
  })
  const inner = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if ((init?.method ?? 'GET') === 'GET' && url.endsWith(`/serviceAccounts/${EMAIL}`)) {
      // The bootstrap credential lacking roles/iam.serviceAccountAdmin reads as
      // a 403 here, and creating on top of it would report a confusing failure.
      return respond({ error: { code: 403, message: 'permission denied' } }, 403)
    }
    return inner(input as never, init)
  }) as typeof fetch

  const config = gcpServiceAccountModule.configSchema.parse(CONFIG)
  await expect(gcpServiceAccountModule.apply(config, ctx())).rejects.toThrow(/403/)
})

test('names the secret when the bootstrap credential is not a key file', async () => {
  installFetchStub({})
  const config = gcpServiceAccountModule.configSchema.parse(CONFIG)
  const bad = createTestContext({ secrets: { GCP_SERVICE_ACCOUNT_KEY: '{"client_email":"a@b"}' } })
  await expect(gcpServiceAccountModule.apply(config, bad)).rejects.toThrow(
    /GCP_SERVICE_ACCOUNT_KEY.*private_key/s,
  )
})
