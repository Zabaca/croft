import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { resolveApiToken } from '../cloudflare-api'
import {
  assertHostnamesInZone,
  buildIngress,
  cloudflareTunnelModule,
  ingressDiffers,
  planRecord,
  tunnelTarget,
} from './index'

/**
 * Tests for the cloudflare-tunnel module at the provisioning seam, in the
 * pattern `cloudflare-zone/index.test.ts` established: the REAL `apply` runs
 * against a stubbed `globalThis.fetch` backed by a tiny in-memory Cloudflare
 * that POST/PATCH/PUT actually mutate. That is what makes "the second apply is
 * a no-op" an honest assertion rather than a restatement of the stub.
 *
 * Nothing here touches the network.
 */

interface RecordedCall {
  method: string
  url: string
  body?: Record<string, unknown>
}

interface CfRecord {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
  ttl?: number
}

interface World {
  tunnels: Array<{ id: string; name: string; config_src?: string; deleted_at?: string | null }>
  ingress: Map<string, Array<Record<string, unknown>>>
  records: CfRecord[]
  calls: RecordedCall[]
}

const ACCOUNT = 'acct-1'
const ZONE_ID = 'zone-1'
const TUNNEL_ID = '11111111-2222-3333-4444-555555555555'

function emptyWorld(): World {
  return { tunnels: [], ingress: new Map(), records: [], calls: [] }
}

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 })

/** A stubbed Cloudflare covering only the endpoints this module calls. */
function installFetch(world: World): void {
  let nextRecordId = 1
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined
    world.calls.push({ method, url, body })
    const { pathname, searchParams } = new URL(url)

    // ── tunnels ──────────────────────────────────────────────────────────
    if (pathname === `/client/v4/accounts/${ACCOUNT}/cfd_tunnel`) {
      if (method === 'GET') {
        const name = searchParams.get('name')
        return ok(world.tunnels.filter((t) => !t.deleted_at && (!name || t.name === name)))
      }
      const created = {
        id: TUNNEL_ID,
        name: String(body?.name),
        config_src: String(body?.config_src),
        deleted_at: null,
      }
      world.tunnels.push(created)
      world.ingress.set(created.id, [])
      return ok(created)
    }
    const tunnelMatch = pathname.match(
      new RegExp(`^/client/v4/accounts/${ACCOUNT}/cfd_tunnel/([^/]+)(/.*)?$`),
    )
    if (tunnelMatch) {
      const [, tunnelId, tail] = tunnelMatch
      if (tail === '/configurations') {
        if (method === 'GET') return ok({ config: { ingress: world.ingress.get(tunnelId!) ?? [] } })
        const config = body?.config as { ingress: Array<Record<string, unknown>> }
        world.ingress.set(tunnelId!, config.ingress)
        return ok({ config })
      }
      if (tail === '/token') return ok(`run-token-for-${tunnelId}`)
      if (method === 'DELETE') {
        world.tunnels = world.tunnels.filter((t) => t.id !== tunnelId)
        return ok({ id: tunnelId })
      }
    }

    // ── zones and records ────────────────────────────────────────────────
    if (pathname === '/client/v4/zones') {
      return ok([{ id: ZONE_ID, name: searchParams.get('name') ?? 'cedarpad.com' }])
    }
    if (pathname === `/client/v4/zones/${ZONE_ID}/dns_records`) {
      if (method === 'GET') {
        const name = searchParams.get('name')?.toLowerCase()
        return ok(world.records.filter((r) => !name || r.name.toLowerCase() === name))
      }
      const created = { id: `rec-${nextRecordId++}`, ...(body as unknown as Omit<CfRecord, 'id'>) }
      world.records.push(created)
      return ok(created)
    }
    const recordMatch = pathname.match(
      new RegExp(`^/client/v4/zones/${ZONE_ID}/dns_records/([^/]+)$`),
    )
    if (recordMatch) {
      const record = world.records.find((r) => r.id === recordMatch[1])
      if (record) Object.assign(record, body)
      return ok(record)
    }

    throw new Error(`stub has no route for ${method} ${url}`)
  }) as typeof fetch

  // The stub records every call including the token fetch; nothing asserts on
  // the credential value beyond the file contents, so no scrubbing is needed.
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Fixtures go through the one helper, which owns their cleanup — see
 *  `scripts/tmp-fixture.ts` for the 169,000 stray directories that bought it. */
// One root per file, removed in `afterAll`. The contributing repo hangs this
// off a cross-run reaper its suite runner invokes — 169,000 stray directories
// bought that discipline — and core's `bun test` has no runner to hang one off,
// so the promoted copy owns its own root instead. Every call site is unchanged.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-tunnel-'))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const tempFile = (name: string) => path.join(fs.mkdtempSync(path.join(ROOT, 'cf-tunnel-')), name)

/** The instance under test, mirroring the shape dev-ws-tunnel will use. */
function instanceConfig(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT,
    tunnelName: 'dev-ws',
    apiToken: { from: 'dev-ws-token', output: 'tokenValue' },
    zone: 'cedarpad.com',
    ingress: [
      { hostname: 'ws.cedarpad.com', path: '^/__(boot|status)$', service: 'http://127.0.0.1:4599' },
      { hostname: 'ws.cedarpad.com', service: 'http://127.0.0.1:4510' },
    ],
    ...overrides,
  }
}

const ctx = { secrets: {}, imports: { 'dev-ws-token': { tokenValue: 'api-token' } } }

const apply = (config: Record<string, unknown>) =>
  cloudflareTunnelModule.apply(
    cloudflareTunnelModule.configSchema.parse(config) as never,
    ctx as never,
  )

// ── Pure helpers ──────────────────────────────────────────────────────────

describe('buildIngress', () => {
  test('appends the catch-all Cloudflare requires and preserves rule order', () => {
    const built = buildIngress([
      { hostname: 'ws.cedarpad.com', path: '^/__boot$', service: 'http://127.0.0.1:4599' },
      { hostname: 'ws.cedarpad.com', service: 'http://127.0.0.1:4510' },
    ])
    expect(built).toEqual([
      { hostname: 'ws.cedarpad.com', path: '^/__boot$', service: 'http://127.0.0.1:4599' },
      { hostname: 'ws.cedarpad.com', service: 'http://127.0.0.1:4510' },
      { service: 'http_status:404' },
    ])
  })

  test('the catch-all is a 404, not the last declared origin', () => {
    const last = buildIngress([{ hostname: 'a.cedarpad.com', service: 'http://127.0.0.1:1' }]).at(
      -1,
    )
    expect(last).toEqual({ service: 'http_status:404' })
  })
})

describe('ingressDiffers', () => {
  const desired = buildIngress([
    { hostname: 'ws.cedarpad.com', path: '^/x$', service: 'http://127.0.0.1:4599' },
  ])

  test('key order and absent-vs-undefined are not drift', () => {
    const actual = [
      { service: 'http://127.0.0.1:4599', path: '^/x$', hostname: 'ws.cedarpad.com' },
      { service: 'http_status:404', hostname: undefined },
    ]
    expect(ingressDiffers(desired, actual)).toBe(false)
  })

  test('a changed origin port is drift', () => {
    const actual = buildIngress([
      { hostname: 'ws.cedarpad.com', path: '^/x$', service: 'http://127.0.0.1:4510' },
    ])
    expect(ingressDiffers(desired, actual)).toBe(true)
  })

  test('reordered rules are drift — cloudflared takes the first match', () => {
    const two = buildIngress([
      { hostname: 'ws.cedarpad.com', path: '^/x$', service: 'http://127.0.0.1:4599' },
      { hostname: 'ws.cedarpad.com', service: 'http://127.0.0.1:4510' },
    ])
    const swapped = buildIngress([
      { hostname: 'ws.cedarpad.com', service: 'http://127.0.0.1:4510' },
      { hostname: 'ws.cedarpad.com', path: '^/x$', service: 'http://127.0.0.1:4599' },
    ])
    expect(ingressDiffers(two, swapped)).toBe(true)
  })
})

describe('assertHostnamesInZone', () => {
  test('accepts a subdomain and the apex', () => {
    expect(() =>
      assertHostnamesInZone(
        [
          { hostname: 'ws.cedarpad.com', service: 's' },
          { hostname: 'cedarpad.com', service: 's' },
        ],
        'cedarpad.com',
      ),
    ).not.toThrow()
  })

  test('rejects a hostname in another zone', () => {
    expect(() =>
      assertHostnamesInZone([{ hostname: 'ws.zabaca.com', service: 's' }], 'cedarpad.com'),
    ).toThrow(/not inside zone/)
  })

  test('rejects a suffix that is not a label boundary', () => {
    expect(() =>
      assertHostnamesInZone([{ hostname: 'notcedarpad.com', service: 's' }], 'cedarpad.com'),
    ).toThrow(/not inside zone/)
  })
})

describe('planRecord', () => {
  test('creates when the name is free', () => {
    expect(planRecord('ws.cedarpad.com', TUNNEL_ID, [])).toEqual({ kind: 'create' })
  })

  test('is unchanged when a proxied CNAME already points at this tunnel', () => {
    const existing = [
      {
        id: 'rec-1',
        type: 'CNAME',
        name: 'ws.cedarpad.com',
        content: tunnelTarget(TUNNEL_ID),
        proxied: true,
      },
    ]
    expect(planRecord('ws.cedarpad.com', TUNNEL_ID, existing)).toEqual({
      kind: 'unchanged',
      id: 'rec-1',
    })
  })

  test('updates a CNAME that points at a DIFFERENT tunnel', () => {
    const other = '99999999-8888-7777-6666-555555555555'
    const existing = [
      {
        id: 'rec-1',
        type: 'CNAME',
        name: 'ws.cedarpad.com',
        content: tunnelTarget(other),
        proxied: true,
      },
    ]
    expect(planRecord('ws.cedarpad.com', TUNNEL_ID, existing)).toEqual({
      kind: 'update',
      id: 'rec-1',
    })
  })

  test('updates an unproxied tunnel CNAME — unproxied does not resolve at all', () => {
    const existing = [
      {
        id: 'rec-1',
        type: 'CNAME',
        name: 'ws.cedarpad.com',
        content: tunnelTarget(TUNNEL_ID),
        proxied: false,
      },
    ]
    expect(planRecord('ws.cedarpad.com', TUNNEL_ID, existing)).toEqual({
      kind: 'update',
      id: 'rec-1',
    })
  })

  // The guard that lets this module share cedarpad.com with wrangler.
  test('REFUSES to overwrite a wrangler custom-domain style A record', () => {
    const existing = [
      { id: 'rec-1', type: 'A', name: 'app.cedarpad.com', content: '192.0.2.1', proxied: true },
    ]
    expect(() => planRecord('app.cedarpad.com', TUNNEL_ID, existing)).toThrow(
      /already holds A -> 192\.0\.2\.1/,
    )
  })

  test('REFUSES to overwrite a CNAME pointing somewhere other than a tunnel', () => {
    const existing = [
      {
        id: 'rec-1',
        type: 'CNAME',
        name: 'ws.cedarpad.com',
        content: 'origin.example.net',
        proxied: true,
      },
    ]
    expect(() => planRecord('ws.cedarpad.com', TUNNEL_ID, existing)).toThrow(/refusing to apply/)
  })

  test('REFUSES a name holding more than one record', () => {
    const existing = [
      { id: 'rec-1', type: 'A', name: 'ws.cedarpad.com', content: '192.0.2.1' },
      { id: 'rec-2', type: 'A', name: 'ws.cedarpad.com', content: '192.0.2.2' },
    ]
    expect(() => planRecord('ws.cedarpad.com', TUNNEL_ID, existing)).toThrow(/2 DNS records/)
  })
})

describe('resolveApiToken', () => {
  test('reads the named output off the named import', () => {
    expect(
      resolveApiToken({ from: 'tok', output: 'tokenValue' }, { tok: { tokenValue: 'v' } }),
    ).toBe('v')
  })

  test('names the missing import rather than returning undefined', () => {
    expect(() => resolveApiToken({ from: 'tok', output: 'tokenValue' }, {})).toThrow(
      /not in this instance's imports/,
    )
  })

  test('names the missing output', () => {
    expect(() =>
      resolveApiToken({ from: 'tok', output: 'nope' }, { tok: { tokenValue: 'v' } }),
    ).toThrow(/doesn't emit it/)
  })
})

// ── apply, against the in-memory Cloudflare ───────────────────────────────

describe('apply', () => {
  test('creates the tunnel remotely-managed, sets ingress, and creates the CNAME', async () => {
    const world = emptyWorld()
    installFetch(world)

    const out = await apply(instanceConfig())

    expect(out.tunnelId).toBe(TUNNEL_ID)
    expect(out.createdTunnel).toBe(true)
    expect(out.changed).toBe(true)
    expect(out.runToken).toBe(`run-token-for-${TUNNEL_ID}`)
    expect(out.hostnames).toEqual(['ws.cedarpad.com'])

    // config_src is what makes PUT /configurations authoritative at all.
    const create = world.calls.find((c) => c.method === 'POST' && c.url.endsWith('/cfd_tunnel'))
    expect(create?.body).toEqual({ name: 'dev-ws', config_src: 'cloudflare' })

    expect(world.ingress.get(TUNNEL_ID)).toEqual([
      { hostname: 'ws.cedarpad.com', path: '^/__(boot|status)$', service: 'http://127.0.0.1:4599' },
      { hostname: 'ws.cedarpad.com', service: 'http://127.0.0.1:4510' },
      { service: 'http_status:404' },
    ])
    expect(world.records).toEqual([
      {
        id: 'rec-1',
        type: 'CNAME',
        name: 'ws.cedarpad.com',
        content: tunnelTarget(TUNNEL_ID),
        proxied: true,
        ttl: 1,
      },
    ])
  })

  test('the second apply is a no-op — no mutating call at all', async () => {
    const world = emptyWorld()
    installFetch(world)

    await apply(instanceConfig())
    world.calls.length = 0
    const out = await apply(instanceConfig())

    expect(out.changed).toBe(false)
    expect(out.createdTunnel).toBe(false)
    const mutations = world.calls.filter((c) => c.method !== 'GET')
    expect(mutations).toEqual([])
  })

  test('an edited origin port rewrites ingress and leaves DNS alone', async () => {
    const world = emptyWorld()
    installFetch(world)

    await apply(instanceConfig())
    world.calls.length = 0
    const out = await apply(
      instanceConfig({
        ingress: [
          {
            hostname: 'ws.cedarpad.com',
            path: '^/__(boot|status)$',
            service: 'http://127.0.0.1:4599',
          },
          { hostname: 'ws.cedarpad.com', service: 'http://127.0.0.1:4600' },
        ],
      }),
    )

    expect(out.changed).toBe(true)
    expect(world.ingress.get(TUNNEL_ID)?.[1]).toEqual({
      hostname: 'ws.cedarpad.com',
      service: 'http://127.0.0.1:4600',
    })
    const dnsWrites = world.calls.filter((c) => c.method !== 'GET' && c.url.includes('dns_records'))
    expect(dnsWrites).toEqual([])
  })

  test('refuses to adopt a locally-managed tunnel instead of silently no-opping', async () => {
    const world = emptyWorld()
    world.tunnels.push({ id: TUNNEL_ID, name: 'dev-ws', config_src: 'local' })
    world.ingress.set(TUNNEL_ID, [])
    installFetch(world)

    await expect(apply(instanceConfig())).rejects.toThrow(/local-managed/)
  })

  test('a hostname outside the zone fails before anything is created', async () => {
    const world = emptyWorld()
    installFetch(world)

    await expect(
      apply(instanceConfig({ ingress: [{ hostname: 'ws.zabaca.com', service: 'http://x' }] })),
    ).rejects.toThrow(/not inside zone/)
    expect(world.calls).toEqual([])
    expect(world.tunnels).toEqual([])
  })

  test('a deleted tunnel of the same name is not adopted', async () => {
    const world = emptyWorld()
    world.tunnels.push({
      id: 'dead-tunnel',
      name: 'dev-ws',
      config_src: 'cloudflare',
      deleted_at: '2026-01-01T00:00:00Z',
    })
    installFetch(world)

    const out = await apply(instanceConfig())
    expect(out.tunnelId).toBe(TUNNEL_ID)
    expect(out.createdTunnel).toBe(true)
  })

  test('writes the run token to the credential file at mode 0600', async () => {
    const world = emptyWorld()
    installFetch(world)
    const target = tempFile('tunnel.env')

    const out = await apply(instanceConfig({ credentialFile: { path: target } }))

    expect(fs.readFileSync(target, 'utf8')).toBe(`TUNNEL_TOKEN=run-token-for-${TUNNEL_ID}\n`)
    expect(fs.statSync(target).mode & 0o777).toBe(0o600)
    expect(out.changed).toBe(true)
  })

  test('an unchanged credential file does not mark the apply changed', async () => {
    const world = emptyWorld()
    installFetch(world)
    const target = tempFile('tunnel.env')

    await apply(instanceConfig({ credentialFile: { path: target } }))
    const out = await apply(instanceConfig({ credentialFile: { path: target } }))

    expect(out.changed).toBe(false)
  })
})

describe('destroy', () => {
  test('deletes the tunnel and deliberately leaves DNS behind', async () => {
    const world = emptyWorld()
    installFetch(world)
    await apply(instanceConfig())
    world.calls.length = 0

    await cloudflareTunnelModule.destroy?.(
      cloudflareTunnelModule.configSchema.parse(instanceConfig()) as never,
      ctx as never,
    )

    expect(world.tunnels).toEqual([])
    // The CNAME survives: a record pointing at a dead tunnel fails closed
    // (Cloudflare 1033), a deleted record can fall through to a wildcard.
    expect(world.records).toHaveLength(1)
  })
})
