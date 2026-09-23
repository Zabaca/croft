import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import { cf, type CfOptions } from '../cloudflare-api'

/**
 * r2 — provisions a Cloudflare R2 bucket via the REST API (turso-style:
 * token through ctx.secret, idempotent list→create, console.log progress).
 *
 * Exists so bucket lifecycle is owned by infra instead of being a side effect
 * of `wrangler deploy` prompting to create a missing bucket. A worker wires
 * the bucket in through the cloudflare module's `r2Bindings` config, typically
 * as a `{ binding, from, output }` reference into this instance's outputs.
 *
 * Token scope: CLOUDFLARE_API_TOKEN needs Account → Workers R2 Storage: Edit.
 */

/**
 * Named per-code guidance for this module's calls — the one genuinely
 * per-module part of a Cloudflare failure. Everything else about the envelope
 * (the base URL, the error shapes, the typed throw) is `../cloudflare-api`'s.
 */
const OPTS: CfOptions = {
  hints: {
    10000:
      `rejected the token (10000 Authentication error). ` +
      `CLOUDFLARE_API_TOKEN is likely missing the Account → Workers R2 Storage: Edit scope. ` +
      `Edit the token at https://dash.cloudflare.com/profile/api-tokens and re-run zbc apply.`,
  },
}

export const r2Module = defineModule({
  name: 'r2',
  configSchema: z.object({
    /** Cloudflare account id (not a secret — it's in the dashboard URL). */
    accountId: z.string(),
    /** Bucket name — account-scoped, so namespace it per project/env. */
    bucketName: z.string(),
    /**
     * Location hint for new buckets (e.g. 'wnam', 'enam', 'weur'). Only
     * applied at creation; Cloudflare doesn't support relocating a bucket.
     */
    locationHint: z.string().optional(),
  }),
  outputs: z.object({
    bucketName: z.string(),
  }),
  async apply(config, ctx) {
    const apiToken = ctx.secret('CLOUDFLARE_API_TOKEN')
    const base = `/accounts/${config.accountId}/r2/buckets`

    const listing = await cf<{ buckets: Array<{ name: string }> }>(
      apiToken,
      'GET',
      `${base}?per_page=1000`,
      undefined,
      OPTS,
    )
    const exists = listing.buckets.some((b) => b.name === config.bucketName)

    if (exists) {
      console.log(`  Bucket "${config.bucketName}" already exists`)
    } else {
      await cf(
        apiToken,
        'POST',
        base,
        {
          name: config.bucketName,
          ...(config.locationHint ? { locationHint: config.locationHint } : {}),
        },
        OPTS,
      )
      console.log(
        `  Created bucket "${config.bucketName}"${config.locationHint ? ` (${config.locationHint})` : ''}`,
      )
    }

    return { bucketName: config.bucketName }
  },
  /**
   * Delete the bucket. NOTE: the management API refuses to delete a NON-EMPTY
   * bucket and has no object purge, so this — and therefore an `ephemeral: true`
   * r2 instance, whose destroy+re-apply the engine drives — only comes out clean
   * for buckets whose objects the app itself removes, or that stay small enough
   * to purge by hand. A refusal is logged, not thrown: it is the ordinary
   * outcome for a bucket still holding data, and a `zbc destroy` that aborted
   * there would strand every instance behind it.
   */
  async destroy(config, ctx) {
    const apiToken = ctx.secret('CLOUDFLARE_API_TOKEN')
    try {
      await cf(
        apiToken,
        'DELETE',
        `/accounts/${config.accountId}/r2/buckets/${encodeURIComponent(config.bucketName)}`,
        undefined,
        OPTS,
      )
      console.log(`  Deleted bucket "${config.bucketName}"`)
    } catch (err) {
      // Most common cause: bucket not empty (the API refuses). Surface it —
      // silent skips here would strand storage.
      console.log(`  Bucket delete skipped: ${(err as Error).message}`)
    }
  },
})
