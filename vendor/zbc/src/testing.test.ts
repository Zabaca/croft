import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createTestContext, defineModule } from './index'

/**
 * The harness is exercised the way a module author would: define a module,
 * call its `apply` with a test context, assert on what came back — no engine,
 * no provider, no hand-built context literal.
 */

const probe = defineModule({
  name: 'probe',
  configSchema: z.object({ label: z.string().default('x') }),
  outputs: z.object({ token: z.string(), db: z.string() }),
  async apply(config, ctx) {
    return {
      token: `${config.label}:${ctx.secret('API_TOKEN')}`,
      db: ctx.output({ from: 'main-db', output: 'databaseUrl' }, 'config.db'),
    }
  },
})

/**
 * A module reading a NON-string output. varnick's `client-account` emits
 * `nameServers: string[]` for its sibling to consume, and until `outputValue`
 * that value could not cross an imports edge at all.
 */
const delegator = defineModule({
  name: 'delegator',
  configSchema: z.object({}),
  outputs: z.object({ first: z.string(), count: z.number() }),
  async apply(_config, ctx) {
    const servers = ctx.outputValue(
      { from: 'acct', output: 'nameServers' },
      'nameServers',
    ) as string[]
    return { first: servers[0]!, count: servers.length }
  },
})

describe('createTestContext', () => {
  test('a non-string output crosses the edge through outputValue, and is recorded', async () => {
    const ctx = createTestContext({
      imports: { acct: { nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] } },
    })

    expect(await delegator.apply({}, ctx)).toEqual({ first: 'ada.ns.cloudflare.com', count: 2 })
    expect(ctx.outputsRead).toEqual(['acct.nameServers'])
  })

  test('ctx.output on that same output refuses, and says to use outputValue', async () => {
    const ctx = createTestContext({
      imports: { acct: { nameServers: ['ada.ns.cloudflare.com'] } },
    })

    expect(() =>
      ctx.output({ from: 'acct', output: 'nameServers' }, 'workerVars entry "NS"'),
    ).toThrow(
      'workerVars entry "NS" references output "nameServers" on instance "acct", which emits an array, not a string — read it with ctx.outputValue instead',
    )
  })

  test('an apply can be run against stubbed secrets and imports alone', async () => {
    const ctx = createTestContext({
      secrets: { API_TOKEN: 'tok-1' },
      imports: { 'main-db': { databaseUrl: 'libsql://test' } },
    })

    const outputs = await probe.apply({ label: 'p' }, ctx)

    expect(outputs).toEqual({ token: 'p:tok-1', db: 'libsql://test' })
  })

  test('a secret the test forgot to stub fails, naming the key', async () => {
    const ctx = createTestContext({ imports: { 'main-db': { databaseUrl: 'libsql://test' } } })

    await expect(probe.apply({ label: 'p' }, ctx)).rejects.toThrow('API_TOKEN')
  })

  test('an import the test forgot to stub fails, naming the instance', async () => {
    const ctx = createTestContext({ secrets: { API_TOKEN: 'tok-1' } })

    await expect(probe.apply({ label: 'p' }, ctx)).rejects.toThrow('main-db')
  })

  test('it records what the module asked for, so a test can assert the module reads its declared secret', async () => {
    const ctx = createTestContext({
      secrets: { API_TOKEN: 'tok-1' },
      imports: { 'main-db': { databaseUrl: 'libsql://test' } },
    })

    await probe.apply({ label: 'p' }, ctx)

    expect(ctx.secretsRead).toEqual(['API_TOKEN'])
    expect(ctx.outputsRead).toEqual(['main-db.databaseUrl'])
  })

  test('projectRoot defaults to something, and an override reaches the module', async () => {
    const seen: string[] = []
    const reader = defineModule({
      name: 'reader',
      configSchema: z.object({}),
      outputs: z.object({}),
      async apply(_config, ctx) {
        seen.push(ctx.projectRoot)
        return {}
      },
    })

    await reader.apply({}, createTestContext())
    await reader.apply({}, createTestContext({ projectRoot: '/somewhere' }))

    expect(seen[0]).toBeTruthy()
    expect(seen[1]).toBe('/somewhere')
  })
})
