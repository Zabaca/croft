import { z } from 'zod'
import { defineModule } from '../../src/define-module'

/**
 * Retry `probe` until it stops throwing.
 *
 * WHY, stated carefully, because THREE confident explanations for this have
 * already been wrong (two mine, one a reviewer's). On 2026-08-01 a preview
 * deploy 404'd connecting to a database created 326ms earlier. The root cause
 * was never established. What IS established, each checked rather than
 * reasoned:
 *
 *   - Only the fastest run failed. Four creates, by create-to-connect gap:
 *     326ms 404, 662ms OK, 1263ms OK, 1414ms OK.
 *   - The `<db>-<org>.turso.io` URL the old code built was NOT the cause. It
 *     still answers 200, and two earlier previews created databases and
 *     migrated through it fine.
 *   - A create-then-connect race did NOT reproduce from a workstation: three
 *     fresh databases answered at ~140ms. That rules it out from here, not
 *     from CI, which runs on a different network.
 *
 * So: a bounded retry for a transient failure whose mechanism is unknown, not
 * a fix for a diagnosed bug. If it fires, capture the timing and the response
 * body, because that is the evidence nobody has yet. Do not write a cause into
 * this comment without evidence that survives someone trying to break it.
 *
 * Probes reachability rather than retrying migrate() itself, so a genuine
 * migration error still fails on the first try instead of being attempted
 * `attempts` times and reported as a timeout.
 */
export async function waitUntilReachable(
  probe: () => Promise<unknown>,
  {
    attempts = 10,
    delayMs = 2000,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await probe()
      return
    } catch (err) {
      if (attempt >= attempts) {
        throw new Error(`still unreachable after ${attempt} attempts: ${err}`, { cause: err })
      }
      if (attempt === 1) console.log('  Waiting for the database endpoint to come up...')
      await sleep(delayMs)
    }
  }
}

/**
 * `@libsql/client` and `drizzle-orm` are turso's OPTIONAL dependencies, and this
 * is the seam that keeps them optional.
 *
 * Only the `migrationsDir` branch of `apply` touches them, so `registry.json`
 * lists them under `optionalDependencies` and `zbc add turso` does not pull
 * drizzle into a repository that has no migrations to run. A plain
 * `await import('@libsql/client')` contradicts that: it is a module TypeScript
 * must resolve at compile time, so every consumer that took the module at its
 * word and skipped them compiles three unresolvable imports — `modules/` is the
 * tree they vendor, so the errors are theirs, not just ours.
 *
 * Going through a specifier the compiler cannot fold to a literal moves that
 * resolution to runtime, where the branch has already established the package is
 * installed. The types below are the price: the surface used is written out here
 * rather than read off the real package, so it has to be kept honest by hand.
 * Both are small and neither is on a version we pin.
 */
const importOptional = <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>

/** The one function this module calls in `@libsql/client`, and the two it calls on the result. */
interface LibsqlClientModule {
  createClient(config: { url: string; authToken?: string }): LibsqlClient
}

interface LibsqlClient {
  execute(sql: string): Promise<unknown>
  close(): void
}

/** The handle is opaque here — it is created and then handed straight to `migrate`. */
interface DrizzleLibsqlModule {
  drizzle(client: LibsqlClient): unknown
}

interface DrizzleMigratorModule {
  migrate(db: unknown, config: { migrationsFolder: string }): Promise<void>
}

export const tursoModule = defineModule({
  name: 'turso',
  configSchema: z.object({
    orgName: z.string(),
    dbName: z.string(),
    group: z.string().default('default'),
    primaryLocation: z.string().default('iad'),
    /**
     * Path to a Drizzle migrations folder, relative to the monorepo root
     * (resolved via ctx.projectRoot). When provided, apply() runs migrations
     * after database creation. Idempotent.
     */
    migrationsDir: z.string().optional(),
  }),
  outputs: z.object({
    databaseUrl: z.string(),
    authToken: z.string(),
  }),
  async apply(config, ctx) {
    const apiToken = ctx.secret('TURSO_API_TOKEN')

    // Imported here rather than at the top of the file, the way the migration
    // dependencies below already are: a consumer that vendors zbc-core but
    // declares no turso instance never installs `@tursodatabase/api`, and an
    // eager import makes merely *loading* this module throw for them — which
    // took `reachable.test.ts` down with it, a test that touches no client at
    // all. Nothing needs the API client until an apply actually runs.
    const { createClient } = await import('@tursodatabase/api')
    const turso = createClient({ org: config.orgName, token: apiToken })

    // Check if database already exists
    const databases = await turso.databases.list()
    const existing = databases.find((db) => db.name === config.dbName)
    let hostname = existing?.hostname

    if (existing) {
      console.log(`  Database "${config.dbName}" already exists`)

      if (existing.group && existing.group !== config.group) {
        console.warn(`  ⚠ Drift: group is "${existing.group}" but config says "${config.group}"`)
      }
      if (existing.primaryRegion && existing.primaryRegion !== config.primaryLocation) {
        console.warn(
          `  ⚠ Drift: location is "${existing.primaryRegion}" but config says "${config.primaryLocation}"`,
        )
      }
    } else {
      // Ensure group exists
      try {
        const groups = await turso.groups.list()
        const groupExists = groups.some((g) => g.name === config.group)
        if (!groupExists) {
          await turso.groups.create(config.group, config.primaryLocation)
          console.log(`  Created group "${config.group}" at ${config.primaryLocation}`)
        }
      } catch {
        // Group may already exist — continue
      }

      const created = await turso.databases.create(config.dbName, { group: config.group })
      // Use the hostname the API RETURNS rather than rebuilding it. The old
      // code guessed `<db>-<org>.turso.io`; the API hands back a
      // region-qualified name (`...-zabaca.aws-us-west-2.turso.io`).
      //
      // HYGIENE, NOT A FIX. Both forms currently answer 200, so the guess did
      // not cause the 2026-08-01 failure; an earlier version of this comment
      // said it did and was wrong. The reason to stop guessing is that the
      // format is not ours to depend on, not that it is broken today.
      hostname = created.hostname
      console.log(`  Created database "${config.dbName}" in group "${config.group}"`)
    }
    if (!hostname) throw new Error(`Turso returned no hostname for "${config.dbName}"`)

    // Generate an auth token
    const tokenResponse = await turso.databases.createToken(config.dbName, {
      authorization: 'full-access',
    })

    const databaseUrl = `libsql://${hostname}`

    if (config.migrationsDir) {
      const { resolve } = await import('node:path')
      const { createClient: createLibsqlClient } =
        await importOptional<LibsqlClientModule>('@libsql/client')
      const { drizzle } = await importOptional<DrizzleLibsqlModule>('drizzle-orm/libsql')
      const { migrate } = await importOptional<DrizzleMigratorModule>('drizzle-orm/libsql/migrator')

      const folder = resolve(ctx.projectRoot, config.migrationsDir)
      const migrationClient = createLibsqlClient({
        url: databaseUrl,
        authToken: tokenResponse.jwt,
      })
      const migrationDb = drizzle(migrationClient)

      await waitUntilReachable(() => migrationClient.execute('select 1'))

      console.log(`  Applying migrations from ${folder}`)
      await migrate(migrationDb, { migrationsFolder: folder })
      console.log(`  ✓ Migrations applied`)

      migrationClient.close()
    }

    return {
      databaseUrl,
      authToken: tokenResponse.jwt,
    }
  },
  async destroy(config, ctx) {
    const apiToken = ctx.secret('TURSO_API_TOKEN')

    const { createClient } = await import('@tursodatabase/api')
    const turso = createClient({ org: config.orgName, token: apiToken })

    try {
      await turso.databases.delete(config.dbName)
      console.log(`  Deleted database "${config.dbName}"`)
    } catch {
      console.log(`  Database "${config.dbName}" not found — skipping`)
    }
  },
})
