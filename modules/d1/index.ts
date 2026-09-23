import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import { CfError, type CfOptions, cf, cfRaw } from '../cloudflare-api'

/**
 * d1 — provisions a Cloudflare D1 database via the REST API (r2-style:
 * token through ctx.secret, idempotent list→create, console.log progress).
 *
 * Five zbc consumers wrote this module before it existed here, and all five
 * agreed on the interface: config `{accountId, databaseName}`, outputs
 * `{databaseName, databaseId}`. What none of them closed is the gap AFTER the
 * module: every one still hardcoded `database_id` in its `wrangler.jsonc`,
 * because there was no way for an output to reach a provider config file. There
 * is now — the `cloudflare` module's `bindings` key (ADR-0014) — so a worker
 * wires the database in as `{ type: 'd1_databases', binding: 'DB', field:
 * 'database_id', from: '<this instance>', output: 'databaseId' }` and the
 * placeholder id in the checked-in wrangler config is never read.
 *
 * Token scope: CLOUDFLARE_API_TOKEN needs Account → D1: Edit.
 */

/** Named per-code guidance for this module's calls — see `../cloudflare-api`. */
const OPTS: CfOptions = {
  hints: {
    10000:
      `rejected the token (10000 Authentication error). ` +
      `CLOUDFLARE_API_TOKEN is likely missing the Account → D1: Edit scope. ` +
      `Edit the token at https://dash.cloudflare.com/profile/api-tokens and re-run zbc apply.`,
  },
}

interface D1Database {
  uuid: string
  name: string
}

/**
 * Every database in the account.
 *
 * Paginated rather than asked for in one oversized page: D1's list endpoint
 * caps `per_page`, so a `per_page=1000` that "worked" on a small account is a
 * silent wrong answer on a large one — the database exists, the listing does
 * not show it, and apply creates a second one under a name that is already
 * taken.
 */
async function listDatabases(token: string, accountId: string): Promise<D1Database[]> {
  const all: D1Database[] = []
  // Bounded: `total_pages` is the provider's number, and a loop whose only exit
  // is the provider agreeing to stop hangs rather than failing when it does not.
  for (let page = 1; page <= 100; page++) {
    const envelope = await cfRaw<D1Database[]>(
      token,
      'GET',
      `/accounts/${accountId}/d1/database?per_page=100&page=${page}`,
      undefined,
      OPTS,
    )
    all.push(...(envelope.result ?? []))
    const info = envelope.result_info
    if (!info || page >= (info.total_pages ?? 1)) return all
  }
  throw new Error(
    `Cloudflare D1 listing did not terminate after 100 pages for account ${accountId}`,
  )
}

/** One entry of `/query`'s result array — D1 reports per STATEMENT, not per call. */
interface D1StatementResult {
  success?: boolean
  error?: string
}

/**
 * Run one SQL statement against the database.
 *
 * The envelope's `success` is NOT the whole verdict here, which is the one
 * thing this endpoint does differently from every other Cloudflare call:
 * `/query` answers with an array of per-statement results, and a statement can
 * fail inside an envelope that reports success. Reading only the envelope makes
 * a schema that was never applied look converged — and, worse, hides the
 * "duplicate column name" that `isDuplicateColumn` exists to recognise.
 *
 * A per-statement failure is re-thrown as a `CfError` carrying SQLite's own
 * text, so both callers below branch on one error type.
 */
async function query(
  token: string,
  accountId: string,
  databaseId: string,
  sql: string,
): Promise<void> {
  const results = await cf<D1StatementResult[] | null>(
    token,
    'POST',
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    { sql },
    OPTS,
  )
  const failed = (results ?? []).find((entry) => entry?.success === false)
  if (failed) {
    throw new CfError(200, [], `D1 statement failed: ${failed.error ?? 'no error reported'}`)
  }
}

/**
 * Did this failure say the column is already there?
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so "duplicate column name" is the
 * SUCCESS case of a replayed additive column — the only one. Matched on the
 * message rather than on a code because D1 answers every SQL error with the
 * same code (7500); the message is where SQLite's own text survives.
 */
function isDuplicateColumn(err: unknown): boolean {
  // Matched on the message, which `CfOptions.hints` would REPLACE for a hinted
  // code. Only 10000 (a rejected token) is hinted here, and a rejected token is
  // not a duplicate column, so the two cannot collide today — if a hint is ever
  // added for a SQL-level code, this has to be revisited with it.
  return err instanceof CfError && /duplicate column name/i.test(err.message)
}

export const d1Module = defineModule({
  name: 'd1',
  configSchema: z.object({
    /** Cloudflare account id (not a secret — it's in the dashboard URL). */
    accountId: z.string(),
    /** Database name — account-scoped, so namespace it per project/env. */
    databaseName: z.string(),
    /**
     * Location hint for new databases (e.g. 'wnam', 'enam', 'weur'). Only
     * applied at creation; D1 has no relocation.
     */
    primaryLocationHint: z.string().optional(),
    /**
     * End-state DDL, replayed in order on EVERY apply — so every statement has
     * to be idempotent on its own (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX
     * IF NOT EXISTS`). This is not a migration runner and keeps no ledger: it
     * converges a schema the same way the rest of a module converges a
     * resource. A versioned migrations directory needs somewhere to run after
     * the deploy, which the engine does not have yet.
     */
    statements: z.array(z.string()).default([]),
    /**
     * Columns added to an existing table, applied after `statements`. Separate
     * from them because `ALTER TABLE … ADD COLUMN` is the one thing SQLite
     * gives no `IF NOT EXISTS` spelling, so replaying it needs the
     * already-there failure treated as success — see `isDuplicateColumn`.
     */
    additiveColumns: z
      .array(z.object({ table: z.string(), column: z.string(), definition: z.string() }))
      .default([]),
  }),
  outputs: z.object({
    databaseName: z.string(),
    databaseId: z.string(),
  }),
  async apply(config, ctx) {
    const apiToken = ctx.secret('CLOUDFLARE_API_TOKEN')
    const { accountId, databaseName } = config

    const existing = (await listDatabases(apiToken, accountId)).find((d) => d.name === databaseName)

    let databaseId: string
    if (existing) {
      console.log(`  Database "${databaseName}" already exists`)
      databaseId = existing.uuid
    } else {
      const created = await cf<D1Database>(
        apiToken,
        'POST',
        `/accounts/${accountId}/d1/database`,
        {
          name: databaseName,
          ...(config.primaryLocationHint
            ? { primary_location_hint: config.primaryLocationHint }
            : {}),
        },
        OPTS,
      )
      if (!created?.uuid) {
        throw new Error(`Cloudflare returned no id for the created database "${databaseName}"`)
      }
      databaseId = created.uuid
      console.log(
        `  Created database "${databaseName}" (${databaseId})${config.primaryLocationHint ? ` [${config.primaryLocationHint}]` : ''}`,
      )
    }

    for (const statement of config.statements) {
      await query(apiToken, accountId, databaseId, statement)
    }
    if (config.statements.length > 0) {
      console.log(`  Applied ${config.statements.length} statement(s)`)
    }

    for (const { table, column, definition } of config.additiveColumns) {
      const sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
      try {
        await query(apiToken, accountId, databaseId, sql)
        console.log(`  Added column ${table}.${column}`)
      } catch (err) {
        if (!isDuplicateColumn(err)) throw err
        console.log(`  Column ${table}.${column} already present`)
      }
    }

    return { databaseName, databaseId }
  },
  /**
   * Delete the database. An already-absent one is reported, not thrown: it is
   * the ordinary outcome of a destroy that already ran, and a throw here would
   * strand every instance behind it in a `zbc destroy`.
   */
  async destroy(config, ctx) {
    const apiToken = ctx.secret('CLOUDFLARE_API_TOKEN')
    const { accountId, databaseName } = config
    // The lookup is deliberately OUTSIDE the try: the forgiving case is
    // "already gone", and that is the `!existing` branch. A listing that failed
    // — a rejected token, a 5xx — proves nothing about whether the database is
    // there, and reporting it as a skipped delete leaves the resource standing.
    const existing = (await listDatabases(apiToken, accountId)).find((d) => d.name === databaseName)
    if (!existing) {
      console.log(`  Database "${databaseName}" is already gone`)
      return
    }
    try {
      await cf(
        apiToken,
        'DELETE',
        `/accounts/${accountId}/d1/database/${existing.uuid}`,
        undefined,
        OPTS,
      )
      console.log(`  Deleted database "${databaseName}"`)
    } catch (err) {
      console.log(`  Database delete skipped: ${(err as Error).message}`)
    }
  },
  /**
   * A fresh D1 database is returned by the create call before it will answer a
   * query, and the caller of `databaseId` is a Worker whose first act is to
   * query it. So the probe is that query (ADR-0013: readiness is proved
   * against the capability the caller will use, not against a generic liveness
   * endpoint), and the engine holds the outputs at every `imports` edge —
   * including the `bindings` edge into a wrangler config — until it answers.
   */
  ready: {
    proves: 'the database answers a query',
    async probe(outputs, config, ctx) {
      const apiToken = ctx.secret('CLOUDFLARE_API_TOKEN')
      await query(apiToken, config.accountId, outputs.databaseId, 'SELECT 1')
    },
  },
})
