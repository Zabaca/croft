import { afterEach, describe, expect, test } from 'bun:test'
import { cloudflareZoneModule } from './index'

/**
 * End-to-end tests for the cloudflare-zone module, at the provisioning seam:
 * given a declared zone and a recorded API surface, the right calls are made.
 *
 * Same pattern as `vendor/zbc/modules/cloudflare-token/index.test.ts` — the
 * REAL `apply` runs against a stubbed `globalThis.fetch`. The difference is
 * that this stub is a tiny in-memory Cloudflare DNS: POST/PATCH/DELETE mutate
 * its record store. That is what makes the no-op assertion honest — apply
 * twice against one stub and the second pass sees the world the first pass
 * left behind, so "zero mutating calls" means the converge really settled.
 *
 * Nothing here touches the network (spec: "nothing in the test suite may
 * require network access to Cloudflare").
 */

interface RecordedCall {
  method: string
  url: string
  body?: Record<string, unknown>
  authorization?: string
}

interface CfRecord {
  id: string
  type: string
  name: string
  content: string
  ttl: number
  proxied?: boolean
  priority?: number
}

interface CfSetting {
  id: string
  value: string
  editable?: boolean
}

interface StubState {
  /** zone name → the zone as the API would report it. */
  zones?: Record<string, { id: string; accountId: string; nameServers?: string[] }>
  /** zone id → its records. Mutated in place by POST/PATCH/DELETE. */
  records?: Record<string, CfRecord[]>
  /** zone id → its settings, as `GET /zones/:id/settings` reports them. */
  settings?: Record<string, CfSetting[]>
  /** First-match override: return a CF envelope to short-circuit a route. */
  override?: (method: string, url: string) => unknown | undefined
}

const realFetch = globalThis.fetch
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function installFetchStub(state: StubState): { calls: RecordedCall[]; state: StubState } {
  const calls: RecordedCall[] = []
  const envelope = (result: unknown, extra: Record<string, unknown> = {}) => ({
    success: true,
    errors: [],
    result,
    ...extra,
  })
  let nextId = 1

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: RecordedCall = { method, url, authorization: headers['Authorization'] }
    if (init?.body) call.body = JSON.parse(init.body as string)
    calls.push(call)

    const respond = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status })

    const overridden = state.override?.(method, url)
    if (overridden !== undefined) return respond(overridden)

    const u = new URL(url)
    const path = u.pathname

    if (method === 'GET' && path === '/client/v4/zones') {
      const name = u.searchParams.get('name') ?? ''
      const zone = state.zones?.[name]
      return respond(
        envelope(
          zone
            ? [
                {
                  id: zone.id,
                  name,
                  account: { id: zone.accountId },
                  name_servers: zone.nameServers ?? ['ns1.example', 'ns2.example'],
                },
              ]
            : [],
        ),
      )
    }

    const listMatch = /^\/client\/v4\/zones\/([^/]+)\/dns_records$/.exec(path)
    if (listMatch && method === 'GET') {
      const zoneId = listMatch[1]!
      const all = state.records?.[zoneId] ?? []
      return respond(
        envelope(all, {
          result_info: { page: 1, per_page: 100, count: all.length, total_pages: 1 },
        }),
      )
    }
    if (listMatch && method === 'POST') {
      const zoneId = listMatch[1]!
      const body = call.body as Record<string, unknown>
      const created: CfRecord = {
        id: `rec-new-${nextId++}`,
        type: String(body.type),
        name: String(body.name),
        content: String(body.content),
        ttl: Number(body.ttl ?? 1),
        proxied: body.proxied as boolean | undefined,
        priority: body.priority as number | undefined,
      }
      state.records ??= {}
      ;(state.records[zoneId] ??= []).push(created)
      return respond(envelope(created))
    }

    const oneMatch = /^\/client\/v4\/zones\/([^/]+)\/dns_records\/([^/]+)$/.exec(path)
    if (oneMatch) {
      const [, zoneId, recordId] = oneMatch as unknown as [string, string, string]
      const list = state.records?.[zoneId] ?? []
      const index = list.findIndex((r) => r.id === recordId)
      if (index < 0) {
        return respond({
          success: false,
          errors: [{ message: `record ${recordId} not found` }],
          result: null,
        })
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = call.body as Record<string, unknown>
        const updated: CfRecord = {
          ...list[index]!,
          type: String(body.type ?? list[index]!.type),
          name: String(body.name ?? list[index]!.name),
          content: String(body.content ?? list[index]!.content),
          ttl: Number(body.ttl ?? list[index]!.ttl),
          proxied: 'proxied' in body ? (body.proxied as boolean) : list[index]!.proxied,
          priority: 'priority' in body ? (body.priority as number) : list[index]!.priority,
        }
        list[index] = updated
        return respond(envelope(updated))
      }
      if (method === 'DELETE') {
        list.splice(index, 1)
        return respond(envelope({ id: recordId }))
      }
    }

    const settingsMatch = /^\/client\/v4\/zones\/([^/]+)\/settings$/.exec(path)
    if (settingsMatch && method === 'GET') {
      return respond(envelope(state.settings?.[settingsMatch[1]!] ?? []))
    }

    const oneSettingMatch = /^\/client\/v4\/zones\/([^/]+)\/settings\/([^/]+)$/.exec(path)
    if (oneSettingMatch && method === 'PATCH') {
      const [, zoneId, settingId] = oneSettingMatch as unknown as [string, string, string]
      const setting = (state.settings?.[zoneId] ?? []).find((s) => s.id === settingId)
      if (!setting) {
        return respond({
          success: false,
          errors: [{ message: `setting ${settingId} not found` }],
          result: null,
        })
      }
      setting.value = String((call.body as Record<string, unknown>).value)
      return respond(envelope(setting))
    }

    return respond({
      success: false,
      errors: [{ message: `no stub route: ${method} ${path}` }],
      result: null,
    })
  }) as typeof fetch

  return { calls, state }
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const ZONE = 'example.test'
const ZONES = { [ZONE]: { id: 'zone-1', accountId: 'acct-1' } }

const ctx = (imports?: Record<string, unknown>) => ({
  secrets: {},
  imports: imports ?? { 'zone-token': { tokenValue: 'dns-tok' } },
  projectRoot: '/tmp',
})

function parseConfig(overrides: Record<string, unknown> = {}) {
  return cloudflareZoneModule.configSchema.parse({
    accountId: 'acct-1',
    zone: ZONE,
    apiToken: { from: 'zone-token', output: 'tokenValue' },
    records: [],
    ...overrides,
  })
}

async function runApply(opts: {
  config?: Record<string, unknown>
  state?: StubState
  imports?: Record<string, unknown>
  stub?: { calls: RecordedCall[]; state: StubState }
}): Promise<{ result?: Record<string, unknown>; error?: Error; calls: RecordedCall[] }> {
  const stub = opts.stub ?? installFetchStub({ zones: ZONES, ...opts.state })
  const before = stub.calls.length
  let result: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    result = (await cloudflareZoneModule.apply(
      parseConfig(opts.config),
      ctx(opts.imports),
    )) as Record<string, unknown>
  } catch (e) {
    error = e as Error
  }
  return { result, error, calls: stub.calls.slice(before) }
}

const mutations = (calls: RecordedCall[]) => calls.filter((c) => MUTATING.has(c.method))
const byMethod = (calls: RecordedCall[], method: string) => calls.filter((c) => c.method === method)

/** Capture console.log for the duration of `fn`. */
async function captureLog(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const realLog = console.log
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  try {
    await fn()
  } finally {
    console.log = realLog
  }
  return lines.join('\n')
}

const APEX_AAAA = { type: 'AAAA', name: '@', content: '100::', proxied: true }
const WWW_AAAA = { type: 'AAAA', name: 'www', content: '100::', proxied: true }

describe('cloudflare-zone apply — create path', () => {
  test('declared records absent from the zone are created, and nothing else is called', async () => {
    const { result, error, calls } = await runApply({
      config: {
        records: [
          APEX_AAAA,
          WWW_AAAA,
          { type: 'TXT', name: '_proof', content: 'hello', ttl: 300 },
          { type: 'MX', name: '@', content: 'mx.example.net', priority: 10 },
        ],
      },
      state: { records: { 'zone-1': [] } },
    })
    expect(error).toBeUndefined()

    const posts = byMethod(calls, 'POST')
    expect(posts).toHaveLength(4)
    expect(byMethod(calls, 'PATCH')).toHaveLength(0)
    expect(byMethod(calls, 'DELETE')).toHaveLength(0)

    // Relative names are expanded to FQDNs; `@` means the apex.
    expect(posts[0]!.body).toEqual({
      type: 'AAAA',
      name: 'example.test',
      content: '100::',
      ttl: 1,
      proxied: true,
    })
    expect(posts[1]!.body).toEqual({
      type: 'AAAA',
      name: 'www.example.test',
      content: '100::',
      ttl: 1,
      proxied: true,
    })
    // A TXT record must not carry `proxied` at all — Cloudflare has no such
    // concept for it, and sending `false` would look like a deliberate choice.
    expect(posts[2]!.body).toEqual({
      type: 'TXT',
      name: '_proof.example.test',
      content: 'hello',
      ttl: 300,
    })
    expect(posts[3]!.body).toEqual({
      type: 'MX',
      name: 'example.test',
      content: 'mx.example.net',
      ttl: 1,
      priority: 10,
    })

    expect(result?.zoneId).toBe('zone-1')
    expect(result?.zoneName).toBe(ZONE)
    expect(result?.created).toBe(4)
    expect(result?.updated).toBe(0)
    expect(result?.deleted).toBe(0)
    expect(result?.changed).toBe(true)
    expect(result?.undeclared).toEqual([])
  })

  test('every call carries the imported instance’s token as a Bearer', async () => {
    const { calls } = await runApply({
      config: { records: [APEX_AAAA] },
      state: { records: { 'zone-1': [] } },
    })
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.authorization).toBe('Bearer dns-tok')
  })
})

describe('cloudflare-zone apply — the no-op criterion', () => {
  test('a second converge with no changes issues ZERO mutating calls and reports no drift', async () => {
    const stub = installFetchStub({ zones: ZONES, records: { 'zone-1': [] } })
    const config = {
      records: [
        APEX_AAAA,
        WWW_AAAA,
        // Deliberately an SPF record: once created it is structurally
        // indistinguishable from one cloudflare-email provisioned, so this is
        // the case where a naive "never touch anything SPF-shaped" rule would
        // make the second apply diverge forever.
        { type: 'TXT', name: '@', content: 'v=spf1 -all', ttl: 300 },
        { type: 'MX', name: '@', content: 'mx.example.net', priority: 10 },
      ],
    }

    const first = await runApply({ config, stub })
    expect(first.error).toBeUndefined()
    expect(mutations(first.calls)).toHaveLength(4)

    const second = await runApply({ config, stub })
    expect(second.error).toBeUndefined()
    expect(mutations(second.calls)).toHaveLength(0)
    expect(second.result?.changed).toBe(false)
    expect(second.result?.created).toBe(0)
    expect(second.result?.updated).toBe(0)
    expect(second.result?.undeclared).toEqual([])
  })
})

describe('cloudflare-zone apply — updates, not delete-then-create', () => {
  test('a changed record value produces a PATCH on the same record id', async () => {
    const { error, calls, result } = await runApply({
      config: { records: [{ type: 'A', name: 'www', content: '203.0.113.9', proxied: true }] },
      state: {
        records: {
          'zone-1': [
            {
              id: 'rec-www',
              type: 'A',
              name: 'www.example.test',
              content: '203.0.113.1',
              ttl: 1,
              proxied: true,
            },
          ],
        },
      },
    })
    expect(error).toBeUndefined()
    const patches = byMethod(calls, 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0]!.url).toContain('/dns_records/rec-www')
    expect(patches[0]!.body).toMatchObject({ content: '203.0.113.9' })
    expect(byMethod(calls, 'POST')).toHaveLength(0)
    expect(byMethod(calls, 'DELETE')).toHaveLength(0)
    expect(result?.updated).toBe(1)
  })

  test('a flipped `proxied` is an update, not a recreate', async () => {
    const { calls } = await runApply({
      config: {
        records: [{ type: 'CNAME', name: 'www', content: 'origin.example.net', proxied: false }],
      },
      state: {
        records: {
          'zone-1': [
            {
              id: 'rec-www',
              type: 'CNAME',
              name: 'www.example.test',
              content: 'origin.example.net',
              ttl: 1,
              proxied: true,
            },
          ],
        },
      },
    })
    expect(byMethod(calls, 'PATCH')).toHaveLength(1)
    expect(byMethod(calls, 'DELETE')).toHaveLength(0)
    expect(byMethod(calls, 'POST')).toHaveLength(0)
  })

  test('round-robin: an unchanged sibling is left alone and only the changed one is patched', async () => {
    const { calls } = await runApply({
      config: {
        records: [
          { type: 'A', name: '@', content: '203.0.113.1', proxied: false },
          { type: 'A', name: '@', content: '203.0.113.9', proxied: false },
        ],
      },
      state: {
        records: {
          'zone-1': [
            { id: 'rec-a1', type: 'A', name: ZONE, content: '203.0.113.1', ttl: 1, proxied: false },
            { id: 'rec-a2', type: 'A', name: ZONE, content: '203.0.113.2', ttl: 1, proxied: false },
          ],
        },
      },
    })
    const patches = byMethod(calls, 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0]!.url).toContain('rec-a2')
    expect(byMethod(calls, 'POST')).toHaveLength(0)
    expect(byMethod(calls, 'DELETE')).toHaveLength(0)
  })
})

describe('cloudflare-zone apply — drift and deletion gating', () => {
  const strayState = (): StubState => ({
    zones: ZONES,
    records: {
      'zone-1': [
        {
          id: 'rec-www',
          type: 'A',
          name: 'www.example.test',
          content: '203.0.113.1',
          ttl: 1,
          proxied: true,
        },
        {
          id: 'rec-stray',
          type: 'A',
          name: 'stray.example.test',
          content: '198.51.100.7',
          ttl: 1,
          proxied: false,
        },
      ],
    },
  })
  const declared = { records: [{ type: 'A', name: 'www', content: '203.0.113.1', proxied: true }] }

  test('a record present in Cloudflare but not declared is reported as drift', async () => {
    const { result, error } = await runApply({ config: declared, state: strayState() })
    expect(error).toBeUndefined()
    expect(result?.undeclared).toEqual(['A stray.example.test -> 198.51.100.7'])
  })

  test('with allowDelete false (the default) the undeclared record is PRINTED and not deleted', async () => {
    const stub = installFetchStub(strayState())
    const log = await captureLog(() => runApply({ config: declared, stub }))
    expect(log).toContain('stray.example.test')
    expect(log.toLowerCase()).toContain('allowdelete')
    expect(byMethod(mutations(stub.calls), 'DELETE')).toHaveLength(0)
    expect(stub.state.records!['zone-1']).toHaveLength(2)
  })

  test('with allowDelete true the undeclared record is deleted', async () => {
    const stub = installFetchStub(strayState())
    const { result, error } = await runApply({
      config: { ...declared, allowDelete: true },
      stub,
    })
    expect(error).toBeUndefined()
    const deletes = byMethod(stub.calls, 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.url).toContain('/dns_records/rec-stray')
    expect(result?.deleted).toBe(1)
    expect(stub.state.records!['zone-1']).toHaveLength(1)
  })
})

describe('cloudflare-zone apply — email-provisioned records are never deleted', () => {
  // Exactly what `vendor/zbc/modules/cloudflare-email` provisions server-side
  // when a domain is onboarded for sending. None of it is declared here, and
  // an authoritative zone module that deleted undeclared records would take
  // outbound mail with it.
  const emailRecords = (): CfRecord[] => [
    {
      id: 'rec-spf',
      type: 'TXT',
      name: ZONE,
      content: 'v=spf1 include:_spf.mx.cloudflare.net ~all',
      ttl: 1,
    },
    { id: 'rec-dmarc', type: 'TXT', name: `_dmarc.${ZONE}`, content: 'v=DMARC1; p=none;', ttl: 1 },
    {
      id: 'rec-dkim',
      type: 'TXT',
      name: `cf2024-1._domainkey.${ZONE}`,
      content: 'v=DKIM1; p=MIGf',
      ttl: 1,
    },
    {
      id: 'rec-dkim-cname',
      type: 'CNAME',
      name: `cf2a._domainkey.${ZONE}`,
      content: 'cf2a.dkim.cloudflare.net',
      ttl: 1,
      proxied: false,
    },
    {
      id: 'rec-bounce',
      type: 'MX',
      name: `_bounce.${ZONE}`,
      content: 'route1.mx.cloudflare.net',
      ttl: 1,
      priority: 10,
    },
    {
      id: 'rec-mx',
      type: 'MX',
      name: ZONE,
      content: 'route2.mx.cloudflare.net',
      ttl: 1,
      priority: 20,
    },
  ]

  test('with allowDelete TRUE, every email-provisioned record survives', async () => {
    const stub = installFetchStub({
      zones: ZONES,
      records: {
        'zone-1': [
          ...emailRecords(),
          {
            id: 'rec-stray',
            type: 'A',
            name: `x.${ZONE}`,
            content: '198.51.100.7',
            ttl: 1,
            proxied: false,
          },
        ],
      },
    })
    const { result, error } = await runApply({
      config: { allowDelete: true, records: [] },
      stub,
    })
    expect(error).toBeUndefined()

    const deleted = byMethod(stub.calls, 'DELETE').map((c) => c.url)
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toContain('rec-stray')

    const survivors = stub.state.records!['zone-1']!.map((r) => r.id).sort()
    expect(survivors).toEqual([
      'rec-bounce',
      'rec-dkim',
      'rec-dkim-cname',
      'rec-dmarc',
      'rec-mx',
      'rec-spf',
    ])
    expect(result?.emailProvisioned).toHaveLength(6)
    // The email records are not even reported as drift — they have an owner,
    // it is just not this module. Only the genuinely stray record is.
    expect(result?.undeclared).toEqual(['A x.example.test -> 198.51.100.7'])
  })

  test('email-provisioned records are never rewritten, only left alone', async () => {
    const stub = installFetchStub({ zones: ZONES, records: { 'zone-1': emailRecords() } })
    // A declared TXT at the apex must not be paired against the SPF record.
    await runApply({
      config: {
        allowDelete: true,
        records: [{ type: 'TXT', name: '@', content: 'google-site-verification=abc', ttl: 1 }],
      },
      stub,
    })
    expect(byMethod(stub.calls, 'PATCH')).toHaveLength(0)
    const spf = stub.state.records!['zone-1']!.find((r) => r.id === 'rec-spf')
    expect(spf?.content).toBe('v=spf1 include:_spf.mx.cloudflare.net ~all')
  })

  test('a declared record matching the live email-provisioned one converges as unchanged', async () => {
    // The CLAUDE.md import workflow: copy what exists into the repo, apply,
    // confirm the re-apply is a no-op. It must work for these records too, or
    // an SPF can only ever be dashboard state.
    const stub = installFetchStub({ zones: ZONES, records: { 'zone-1': emailRecords() } })
    const { error, calls } = await runApply({
      config: {
        allowDelete: true,
        records: [
          { type: 'TXT', name: '@', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
        ],
      },
      stub,
    })
    expect(error).toBeUndefined()
    expect(mutations(calls)).toHaveLength(0)
  })

  test('declaring a second SPF beside the email module’s is refused before any mutation', async () => {
    const stub = installFetchStub({ zones: ZONES, records: { 'zone-1': emailRecords() } })
    const { error } = await runApply({
      config: {
        records: [
          { type: 'TXT', name: '@', content: 'v=spf1 include:_spf.google.com ~all', ttl: 1 },
        ],
      },
      stub,
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('SPF')
    expect(error!.message).toContain('cloudflare-email')
    expect(mutations(stub.calls)).toHaveLength(0)
  })
})

describe('cloudflare-zone configSchema — `proxied` is required, and only where it means something', () => {
  for (const type of ['A', 'AAAA', 'CNAME'] as const) {
    test(`${type} without \`proxied\` is rejected`, () => {
      expect(() =>
        parseConfig({ records: [{ type, name: 'www', content: 'x.example.net' }] }),
      ).toThrow()
    })

    test(`${type} with \`proxied\` parses`, () => {
      expect(() =>
        parseConfig({ records: [{ type, name: 'www', content: 'x.example.net', proxied: false }] }),
      ).not.toThrow()
    })
  }

  test('TXT with `proxied` is rejected — the flag has no meaning there', () => {
    expect(() =>
      parseConfig({ records: [{ type: 'TXT', name: '@', content: 'hi', proxied: true }] }),
    ).toThrow()
  })

  test('MX without a priority is rejected', () => {
    expect(() =>
      parseConfig({ records: [{ type: 'MX', name: '@', content: 'mx.example.net' }] }),
    ).toThrow()
  })

  test('a proxied record with an explicit non-auto TTL is rejected', () => {
    expect(() =>
      parseConfig({
        records: [{ type: 'A', name: 'www', content: '203.0.113.1', proxied: true, ttl: 300 }],
      }),
    ).toThrow(/ttl/i)
  })
})

describe('cloudflare-zone apply — hard errors are fail-fast', () => {
  test('the token reference must resolve; a bad one throws before any call', async () => {
    const stub = installFetchStub({ zones: ZONES })
    const { error } = await runApply({ imports: {}, stub })
    expect(error).toBeDefined()
    expect(error!.message).toContain('zone-token')
    expect(stub.calls).toHaveLength(0)
  })

  test('an unknown zone is a hard error naming it, with no mutation', async () => {
    const { error, calls } = await runApply({
      config: { zone: 'ghost.example' },
      state: { zones: {} },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('ghost.example')
    expect(mutations(calls)).toHaveLength(0)
  })

  test('a zone owned by another account is refused — zones are per account', async () => {
    const { error, calls } = await runApply({
      config: { accountId: 'acct-other' },
      state: { zones: ZONES },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('acct-other')
    expect(error!.message).toContain('acct-1')
    expect(mutations(calls)).toHaveLength(0)
  })

  test('a CF error envelope surfaces the API message', async () => {
    const { error } = await runApply({
      config: { records: [APEX_AAAA] },
      state: {
        records: { 'zone-1': [] },
        override: (method, url) =>
          method === 'POST' && url.includes('/dns_records')
            ? { success: false, errors: [{ message: 'record already exists' }], result: null }
            : undefined,
      },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('record already exists')
  })
})

describe('cloudflare-zone apply — zone settings', () => {
  const insecure = (): StubState => ({
    zones: ZONES,
    records: { 'zone-1': [] },
    settings: {
      'zone-1': [
        { id: 'always_use_https', value: 'off', editable: true },
        { id: 'ssl', value: 'full', editable: true },
      ],
    },
  })

  test('a declared setting whose live value differs is patched, and nothing else is', async () => {
    const { error, calls } = await runApply({
      config: { settings: { always_use_https: 'on' } },
      state: insecure(),
    })
    expect(error).toBeUndefined()

    const patches = byMethod(calls, 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0]!.url).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-1/settings/always_use_https',
    )
    expect(patches[0]!.body).toEqual({ value: 'on' })
    expect(byMethod(calls, 'POST')).toHaveLength(0)
    expect(byMethod(calls, 'DELETE')).toHaveLength(0)
  })

  test('a second apply over the settled zone mutates nothing', async () => {
    const stub = installFetchStub(insecure())
    const first = await runApply({ config: { settings: { always_use_https: 'on' } }, stub })
    expect(first.error).toBeUndefined()
    const second = await runApply({ config: { settings: { always_use_https: 'on' } }, stub })
    expect(second.error).toBeUndefined()
    expect(mutations(second.calls)).toHaveLength(0)
  })

  test('a setting the zone reports as not editable refuses before anything is written', async () => {
    const state = insecure()
    state.settings!['zone-1']!.push({ id: 'min_tls_version', value: '1.0', editable: false })
    const { error, calls } = await runApply({
      config: {
        records: [APEX_AAAA],
        settings: { always_use_https: 'on', min_tls_version: '1.2' },
      },
      state,
    })
    expect(error?.message).toContain('min_tls_version')
    expect(error?.message).toContain('editable')
    // Nothing was written — not the setting that WAS editable, and not the record.
    expect(mutations(calls)).toHaveLength(0)
  })

  test('a setting Cloudflare does not report at all refuses rather than guessing', async () => {
    const state = insecure()
    state.settings!['zone-1'] = [{ id: 'ssl', value: 'full', editable: true }]
    const { error, calls } = await runApply({
      config: { settings: { always_use_https: 'on' } },
      state,
    })
    expect(error?.message).toContain('always_use_https')
    expect(mutations(calls)).toHaveLength(0)
  })

  test('a not-editable setting that is ALREADY the declared value converges rather than refusing', async () => {
    const state = insecure()
    // Cloudflare reports the effective value of a plan-gated setting alongside
    // `editable: false`. Nothing needs writing, so nothing should refuse.
    state.settings!['zone-1']!.push({ id: 'min_tls_version', value: '1.2', editable: false })
    const { result, error, calls } = await runApply({
      config: { records: [APEX_AAAA], settings: { min_tls_version: '1.2' } },
      state,
    })
    expect(error).toBeUndefined()
    expect(byMethod(calls, 'PATCH')).toHaveLength(0)
    expect(result!.settingsChanged).toEqual([])
    // The record half of the same instance still applied.
    expect(byMethod(calls, 'POST')).toHaveLength(1)
  })

  test('a setting whose declared value is undefined is not a declaration', async () => {
    // The environment-conditional style this repo already uses:
    // `always_use_https: process.env.X ? 'on' : undefined`.
    const { result, error, calls } = await runApply({
      config: { settings: { always_use_https: undefined } },
      state: insecure(),
    })
    expect(error).toBeUndefined()
    expect(mutations(calls)).toHaveLength(0)
    expect(calls.filter((c) => c.url.includes('/settings'))).toHaveLength(0)
    expect(result!.settingsChanged).toEqual([])
  })

  test('an instance declaring no settings never asks the settings API anything', async () => {
    const { error, calls } = await runApply({
      config: { records: [APEX_AAAA] },
      state: insecure(),
    })
    expect(error).toBeUndefined()
    expect(calls.filter((c) => c.url.includes('/settings'))).toHaveLength(0)
  })

  test('outputs name the settings that changed, and leave the rest out', async () => {
    const { result, error } = await runApply({
      config: { settings: { always_use_https: 'on', ssl: 'full' } },
      state: insecure(),
    })
    expect(error).toBeUndefined()
    expect(result!.settingsChanged).toEqual(['always_use_https: off => on'])
    expect(result!.changed).toBe(true)
  })
})
