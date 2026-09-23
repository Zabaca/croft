import { afterEach, describe, expect, test } from 'bun:test'
import { createTestContext } from '../../src/testing'
import { d1Module } from './index'

/**
 * The real `apply`/`destroy`/`ready.probe` driven against a stubbed
 * `globalThis.fetch`, the way `../r2/index.test.ts` drives its module: what is
 * asserted is what reached the Cloudflare API.
 */

interface RecordedCall {
  method: string
  path: string
  query: string
  body?: Record<string, unknown>
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Stub the API with a fixed set of existing databases, recording every call. */
function installFetchStub(opts: {
  /** Existing databases, in listing order, as `[name, uuid]`. */
  databases?: Array<[string, string]>
  /** Page size the stub pretends to enforce, so pagination is exercised. */
  perPage?: number
  /** First-match override: `[payload, status]` short-circuits a route. */
  override?: (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => [unknown, number] | undefined
}): RecordedCall[] {
  const calls: RecordedCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = init?.method ?? 'GET'
    const call: RecordedCall = { method, path: url.pathname, query: url.search }
    if (init?.body) call.body = JSON.parse(init.body as string)
    calls.push(call)

    const respond = (result: unknown, extra: Record<string, unknown> = {}) =>
      new Response(JSON.stringify({ success: true, errors: [], result, ...extra }), { status: 200 })

    const overridden = opts.override?.(method, url.pathname, call.body)
    if (overridden) return new Response(JSON.stringify(overridden[0]), { status: overridden[1] })

    if (method === 'GET' && url.pathname.endsWith('/d1/database')) {
      const all = (opts.databases ?? []).map(([name, uuid]) => ({ name, uuid }))
      const perPage = opts.perPage ?? 100
      const page = Number(url.searchParams.get('page') ?? '1')
      const slice = all.slice((page - 1) * perPage, page * perPage)
      return respond(slice, {
        result_info: { page, total_pages: Math.max(1, Math.ceil(all.length / perPage)) },
      })
    }
    if (method === 'POST' && url.pathname.endsWith('/d1/database')) {
      return respond({ name: (call.body as { name: string }).name, uuid: 'new-uuid' })
    }
    return respond(null)
  }) as typeof fetch
  return calls
}

const ctx = () => createTestContext({ secrets: { CLOUDFLARE_API_TOKEN: 'tok' } })
const config = (over: Record<string, unknown> = {}) =>
  d1Module.configSchema.parse({ accountId: 'acct-1', databaseName: 'proj-prod', ...over })

const creates = (calls: RecordedCall[]) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith('/d1/database'))

describe('apply converges', () => {
  test('an existing database is left alone, and its uuid is the output', async () => {
    const calls = installFetchStub({
      databases: [
        ['other', 'uuid-other'],
        ['proj-prod', 'uuid-1'],
      ],
    })
    const out = await d1Module.apply(config(), ctx())

    expect(out).toEqual({ databaseName: 'proj-prod', databaseId: 'uuid-1' })
    expect(creates(calls)).toHaveLength(0)
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  test('a missing database is created, with the location hint when one is given', async () => {
    const calls = installFetchStub({ databases: [['other', 'uuid-other']] })
    const out = await d1Module.apply(config({ primaryLocationHint: 'wnam' }), ctx())

    expect(creates(calls)).toHaveLength(1)
    expect(creates(calls)[0]!.body).toEqual({ name: 'proj-prod', primary_location_hint: 'wnam' })
    expect(out).toEqual({ databaseName: 'proj-prod', databaseId: 'new-uuid' })
  })
})

/** The SQL of every query call the stub saw, in order. */
const sql = (calls: RecordedCall[]) =>
  calls.filter((c) => c.path.endsWith('/query')).map((c) => (c.body as { sql: string }).sql)

describe('schema convergence', () => {
  test('statements run in order against the database that apply just resolved', async () => {
    const calls = installFetchStub({ databases: [['proj-prod', 'uuid-1']] })
    await d1Module.apply(
      config({
        statements: [
          'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)',
          'CREATE INDEX IF NOT EXISTS users_id ON users (id)',
        ],
      }),
      ctx(),
    )

    expect(sql(calls)).toEqual([
      'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)',
      'CREATE INDEX IF NOT EXISTS users_id ON users (id)',
    ])
    expect(calls.find((c) => c.path.endsWith('/query'))!.path).toBe(
      '/client/v4/accounts/acct-1/d1/database/uuid-1/query',
    )
  })

  test('additiveColumns issue ALTER TABLE … ADD COLUMN', async () => {
    const calls = installFetchStub({ databases: [['proj-prod', 'uuid-1']] })
    await d1Module.apply(
      config({ additiveColumns: [{ table: 'users', column: 'nickname', definition: 'TEXT' }] }),
      ctx(),
    )

    expect(sql(calls)).toEqual(['ALTER TABLE users ADD COLUMN nickname TEXT'])
  })

  test('a column that is already there is the success case — SQLite has no ADD COLUMN IF NOT EXISTS', async () => {
    installFetchStub({
      databases: [['proj-prod', 'uuid-1']],
      override: (method, path) =>
        method === 'POST' && path.endsWith('/query')
          ? [
              {
                success: false,
                result: null,
                errors: [{ code: 7500, message: 'duplicate column name: nickname' }],
              },
              400,
            ]
          : undefined,
    })

    const out = await d1Module.apply(
      config({ additiveColumns: [{ table: 'users', column: 'nickname', definition: 'TEXT' }] }),
      ctx(),
    )
    expect(out).toEqual({ databaseName: 'proj-prod', databaseId: 'uuid-1' })
  })

  test('any OTHER error from an additive column still fails the apply', async () => {
    installFetchStub({
      databases: [['proj-prod', 'uuid-1']],
      override: (method, path) =>
        method === 'POST' && path.endsWith('/query')
          ? [
              {
                success: false,
                result: null,
                errors: [{ code: 7500, message: 'no such table: users' }],
              },
              400,
            ]
          : undefined,
    })

    let error: Error | undefined
    try {
      await d1Module.apply(
        config({ additiveColumns: [{ table: 'users', column: 'nickname', definition: 'TEXT' }] }),
        ctx(),
      )
    } catch (e) {
      error = e as Error
    }
    expect(error?.message).toContain('no such table: users')
  })
})

describe('listing', () => {
  test('a database on the second page is found, not re-created', async () => {
    const many: Array<[string, string]> = Array.from({ length: 150 }, (_, i) => [
      `db-${i}`,
      `uuid-${i}`,
    ])
    many[120] = ['proj-prod', 'uuid-120']
    const calls = installFetchStub({ databases: many, perPage: 100 })

    const out = await d1Module.apply(config(), ctx())

    expect(out.databaseId).toBe('uuid-120')
    expect(creates(calls)).toHaveLength(0)
  })
})

describe('destroy', () => {
  test('deletes the database by the uuid it looked up', async () => {
    const calls = installFetchStub({ databases: [['proj-prod', 'uuid-1']] })
    await d1Module.destroy!(config(), ctx())

    const deletes = calls.filter((c) => c.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.path).toBe('/client/v4/accounts/acct-1/d1/database/uuid-1')
  })

  test('an absent database is reported, not thrown', async () => {
    const calls = installFetchStub({ databases: [['other', 'uuid-other']] })
    await d1Module.destroy!(config(), ctx())
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  test('a lookup that FAILS still throws — only the delete itself is forgiven', async () => {
    // Reporting "already gone" off the back of a 403 is the failure mode this
    // pins: the database is still there, and `zbc destroy` moved on.
    installFetchStub({
      override: (method, path) =>
        method === 'GET' && path.endsWith('/d1/database')
          ? [
              {
                success: false,
                result: null,
                errors: [{ code: 10000, message: 'Authentication error' }],
              },
              403,
            ]
          : undefined,
    })

    expect(d1Module.destroy!(config(), ctx())).rejects.toThrow('Account → D1: Edit')
  })
})

describe('a statement that fails inside a 200 envelope', () => {
  /**
   * D1 answers `/query` with an ARRAY of per-statement results, and a statement
   * can fail inside an envelope whose own `success` is true. Reading only the
   * envelope reports a converged schema that was never applied.
   */
  const perStatementFailure = (message: string) => ({
    databases: [['proj-prod', 'uuid-1'] as [string, string]],
    override: (method: string, path: string) =>
      method === 'POST' && path.endsWith('/query')
        ? ([
            {
              success: true,
              errors: [],
              result: [{ success: false, error: message, results: [] }],
            },
            200,
          ] as [unknown, number])
        : undefined,
  })

  test('fails the apply, naming what SQLite said', async () => {
    installFetchStub(perStatementFailure('no such table: users'))

    let error: Error | undefined
    try {
      await d1Module.apply(config({ statements: ['CREATE INDEX i ON users (id)'] }), ctx())
    } catch (e) {
      error = e as Error
    }
    expect(error?.message).toContain('no such table: users')
  })

  test('is still the duplicate-column success case when that is what it says', async () => {
    installFetchStub(perStatementFailure('duplicate column name: nickname'))

    const out = await d1Module.apply(
      config({ additiveColumns: [{ table: 'users', column: 'nickname', definition: 'TEXT' }] }),
      ctx(),
    )
    expect(out).toEqual({ databaseName: 'proj-prod', databaseId: 'uuid-1' })
  })
})

describe('readiness', () => {
  const outputs = { databaseName: 'proj-prod', databaseId: 'uuid-1' }

  test('a database that refuses a query is not ready', async () => {
    installFetchStub({
      databases: [['proj-prod', 'uuid-1']],
      override: (method, path) =>
        method === 'POST' && path.endsWith('/query')
          ? [{ success: false, result: null, errors: [{ code: 7400, message: 'not found' }] }, 404]
          : undefined,
    })

    let error: Error | undefined
    try {
      await d1Module.ready!.probe(outputs, config(), ctx())
    } catch (e) {
      error = e as Error
    }
    expect(error).toBeDefined()
  })

  test('a database that answers a query is ready, and the probe is the query the caller will make', async () => {
    const calls = installFetchStub({ databases: [['proj-prod', 'uuid-1']] })
    await d1Module.ready!.probe(outputs, config(), ctx())

    expect(sql(calls)).toEqual(['SELECT 1'])
    expect(calls[0]!.path).toBe('/client/v4/accounts/acct-1/d1/database/uuid-1/query')
  })
})
