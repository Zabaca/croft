import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import {
  CLOUD_PLATFORM_SCOPE,
  GcpError,
  IAM_API,
  accessToken,
  gcp,
  parseServiceAccountKey,
} from '../gcp-api'

/**
 * gcp-service-account — converges one Google service account and hands its
 * dependents a freshly minted key, in memory, for the length of the apply.
 *
 * This is the half of the consumer survey's `gcp` module that generalises. ceo
 * and foothill carry the same 182 lines, one lineage, and that module is two
 * welded together: a service account, and a Google Calendar provisioned by
 * acting AS the account it just minted. The Calendar half is one application's
 * need and is deliberately not here; a module that wants it imports this one
 * and reads `saKey`, which is the same ordering guarantee the welded version
 * bought by being a single module.
 *
 * Two things those consumers hand-rolled are declarations here rather than code:
 *
 * - **A fresh key every apply, pruned to `maxKeys`.** Not an optimisation — an
 *   in-flight preview Worker is still holding the key from the last apply, so
 *   the old ones cannot be revoked eagerly. `secretOutputs` (ADR-0016) is what
 *   makes minting-every-time safe to say out loud: the value crosses `imports`
 *   in memory and the engine keeps it out of every log line and out of `zbc
 *   apply --json`.
 * - **A retry around an account that 404s its own keys endpoint.** IAM answers
 *   the create call before the account is usable. That loop is now `ready`
 *   (ADR-0013), so the engine holds these outputs at every `imports` edge until
 *   the account answers, and an instance nothing imports never pays for it.
 *
 * Unlike the consumers' version this one HAS a `destroy`, which is what lets a
 * preview environment declare `ephemeral: true` and get its own account.
 * foothill's sharpest finding was that a preview apply's key rotation must not
 * invalidate production's credential — the answer is a separate account per
 * environment, and that is now one instance file each, not a convention to
 * rediscover.
 */

/** A user-managed key as the IAM list endpoint returns it. */
interface IamKey {
  /** `projects/{p}/serviceAccounts/{email}/keys/{id}` */
  name: string
  validAfterTime?: string
}

interface ServiceAccount {
  email: string
  displayName?: string
}

/** The id half of a key's full resource name. */
export function keyId(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1)
}

/**
 * The keys to delete BEFORE minting, so that the account has room for the new
 * one and holds at most `maxKeys` afterwards — oldest first.
 *
 * Oldest-first is the whole point: the newest keys are the ones an in-flight
 * deploy from a recent apply is still authenticating with. A key with no
 * `validAfterTime` sorts as oldest — absent creation time means it predates
 * anything this module minted.
 *
 * Pruning happens before the mint rather than after, and that ordering is
 * load-bearing: Google caps an account at 10 user-managed keys, so an account
 * already at the ceiling (`maxKeys: 10`, or keys created outside zbc, or a run
 * that died between mint and prune) would fail its mint forever if the prune
 * only ran afterwards.
 *
 * Pure; exported for tests.
 */
export function keysToPrune(keys: readonly IamKey[], maxKeys: number): IamKey[] {
  const oldestFirst = keys.toSorted((a, b) =>
    (a.validAfterTime ?? '').localeCompare(b.validAfterTime ?? ''),
  )
  // One slot has to be free for the key this apply is about to mint.
  const excess = oldestFirst.length - (maxKeys - 1)
  return excess > 0 ? oldestFirst.slice(0, excess) : []
}

/** The account's email, built the one way, so apply/destroy cannot drift. */
export function serviceAccountEmail(config: {
  serviceAccountId: string
  projectId: string
}): string {
  return `${config.serviceAccountId}@${config.projectId}.iam.gserviceaccount.com`
}

/**
 * Retry `attempt` while it fails with one of `statuses`, up to `timeoutMs`.
 *
 * The one place a retry loop still belongs in a module. `ready` covers the gap
 * between "this instance applied" and "a dependent may use it"; this covers a
 * gap INSIDE one apply — IAM returns from the account create before the account
 * can be acted on, and the very next call this module makes is the one that
 * discovers it. No engine hook sits between two statements of the same `apply`.
 */
async function retryOn<T>(
  statuses: readonly number[],
  timeoutMs: number,
  what: string,
  attempt: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await attempt()
    } catch (err) {
      const retryable = err instanceof GcpError && statuses.includes(err.status)
      if (!retryable || Date.now() >= deadline) throw err
      console.log(`  ${what} — retrying (${err.status})`)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
}

export const gcpServiceAccountModule = defineModule({
  name: 'gcp-service-account',
  configSchema: z.object({
    /** GCP project id (not the project NUMBER) the account lives in. */
    projectId: z.string(),
    /**
     * The account id — the local part of the email, 6-30 chars, lowercase
     * letters/digits/hyphens. This is the converge identity: one instance per
     * id, and a preview environment should use a different one from production
     * so that rotating here cannot invalidate the credential there.
     */
    serviceAccountId: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
        'serviceAccountId must be 6-30 chars, lowercase letters, digits and hyphens, starting with a letter',
      ),
    /** Human-facing name in the console. Converged on every apply. */
    displayName: z.string().optional(),
    /**
     * How many user-managed keys to keep, including the one this apply minted.
     * Google's own ceiling is 10. Above 1 because the previous apply's key is
     * still in the hands of whatever it deployed.
     */
    maxKeys: z.number().int().min(1).max(10).default(3),
    /** Which secrets.yaml key holds the BOOTSTRAP service-account key JSON —
     * the account that may administer service accounts in this project. */
    credentialSecret: z.string().default('GCP_SERVICE_ACCOUNT_KEY'),
  }),
  outputs: z.object({
    /** `<serviceAccountId>@<projectId>.iam.gserviceaccount.com`. */
    saEmail: z.string(),
    /** The minted key file, decoded — the JSON a consumer feeds to
     * GOOGLE_APPLICATION_CREDENTIALS or a worker secret. In memory only. */
    saKey: z.string(),
    /** The minted key's id. Names the credential without being it, so it stays
     * readable in logs and in `zbc apply --json`. */
    saKeyId: z.string(),
  }),
  /**
   * `saKey` is a credential this apply mints, and `'each-apply'` is the literal
   * truth about it: a new one is issued every run and reaches dependents in
   * memory. `saEmail` and `saKeyId` name it and are not it.
   */
  secretOutputs: {
    saKey: { rotates: 'each-apply' },
  },
  async apply(config, ctx) {
    const credential = parseServiceAccountKey(
      ctx.secret(config.credentialSecret, { field: 'the bootstrap service-account key' }),
      config.credentialSecret,
    )
    const token = await accessToken(credential, [CLOUD_PLATFORM_SCOPE])
    const email = serviceAccountEmail(config)
    const accountUrl = `${IAM_API}/projects/${config.projectId}/serviceAccounts/${email}`

    // 1. Converge the account itself. A 404 means "create"; anything else is a
    //    real failure (403 = the bootstrap credential lacks
    //    roles/iam.serviceAccountAdmin) and must not be swallowed into a create.
    let account: ServiceAccount | undefined
    try {
      account = await gcp<ServiceAccount>(token, 'GET', accountUrl)
    } catch (err) {
      if (!(err instanceof GcpError) || err.status !== 404) throw err
    }
    if (!account) {
      try {
        account = await gcp<ServiceAccount>(
          token,
          'POST',
          `${IAM_API}/projects/${config.projectId}/serviceAccounts`,
          {
            accountId: config.serviceAccountId,
            ...(config.displayName === undefined
              ? {}
              : { serviceAccount: { displayName: config.displayName } }),
          },
        )
        console.log(`  Created service account ${account.email}`)
      } catch (err) {
        // IAM DELETE is a soft delete: the account is purged 30 days later, and
        // until then its id is taken — a create answers 409 and the only way
        // back is `:undelete`. That is exactly the shape a destroyed-and-
        // re-applied ephemeral instance takes on its second run, so it is
        // handled rather than reported.
        if (!(err instanceof GcpError) || err.status !== 409) throw err
        console.log(`  ${email} was soft-deleted — undeleting`)
        await gcp(token, 'POST', `${accountUrl}:undelete`, {})
        account = await gcp<ServiceAccount>(token, 'GET', accountUrl)
        console.log(`  Restored service account ${account.email}`)
      }
      if (account.email !== email) {
        // Only reachable if IAM ever stopped deriving the email from accountId.
        throw new Error(`IAM created ${account.email}, expected ${email}`)
      }
    } else if (config.displayName !== undefined && account.displayName !== config.displayName) {
      // The mask is a BODY field on this method, not a query parameter — one of
      // the handful of Google methods that spell it that way. Sent as a query
      // parameter it is ignored, and the patch silently converges nothing.
      await gcp(token, 'PATCH', accountUrl, {
        serviceAccount: { displayName: config.displayName },
        updateMask: 'displayName',
      })
      console.log(`  Converged display name of ${account.email}`)
    }

    // 2. Prune first — see `keysToPrune` for why this is not the last step.
    //    A just-created account 404s its own keys collection for a few seconds;
    //    that window is inside this apply, so it is retried here (`ready`
    //    guards the edge to OTHER instances, which is a different gap).
    const listed = await retryOn(
      [403, 404],
      60_000,
      `${email}'s keys endpoint not answering yet`,
      () => gcp<{ keys?: IamKey[] }>(token, 'GET', `${accountUrl}/keys?keyTypes=USER_MANAGED`),
    )
    for (const stale of keysToPrune(listed.keys ?? [], config.maxKeys)) {
      await gcp(token, 'DELETE', `${IAM_API}/${stale.name}`)
      console.log(`  Deleted stale key ${keyId(stale.name)}`)
    }

    // 3. Mint this apply's key.
    const minted = await gcp<{ name?: string; privateKeyData?: string }>(
      token,
      'POST',
      `${accountUrl}/keys`,
      { privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' },
    )
    if (typeof minted.name !== 'string' || typeof minted.privateKeyData !== 'string') {
      throw new Error(
        `key create for ${email} returned no privateKeyData — got keys ${Object.keys(minted).join(', ')}`,
      )
    }
    const mintedId = keyId(minted.name)
    console.log(`  Minted key ${mintedId} for ${account.email}`)

    return {
      saEmail: account.email,
      saKey: Buffer.from(minted.privateKeyData, 'base64').toString('utf8'),
      saKeyId: mintedId,
    }
  },
  /**
   * The probe asks for exactly what a dependent will do with these outputs:
   * exchange the minted key for an access token. (The other half of the same
   * provider's laziness — an account that 404s its own keys collection seconds
   * after being created — is retried inside `apply`, because it happens before
   * `apply` returns and no engine hook reaches in there.)
   */
  ready: {
    proves: 'the minted key can obtain an access token as the service account',
    timeoutMs: 60_000,
    intervalMs: 2_000,
    async probe(outputs) {
      // As the MINTED key, not the bootstrap one. The bootstrap credential's
      // health is irrelevant to a dependent — it authenticates as this account,
      // and a key takes seconds to propagate to the token endpoint after IAM
      // hands it over. Probing with the bootstrap credential would pass
      // instantly and prove nothing about the thing crossing the edge.
      await accessToken(parseServiceAccountKey(outputs.saKey, 'saKey'), [CLOUD_PLATFORM_SCOPE])
    },
  },
  /**
   * Deleting the account deletes its keys with it — which is why an
   * `ephemeral: true` instance is only ever right for an environment that owns
   * its own account. The consumers' version had no destroy at all, and so had
   * no way to say "this preview's account is the preview's".
   *
   * IAM's delete is a SOFT delete with a 30-day purge, so the id stays taken
   * and a re-apply of the same id has to undelete it — which `apply` does. A
   * per-PR `serviceAccountId` avoids the round trip entirely, at the cost of
   * fitting inside IAM's 30-character limit.
   */
  async destroy(config, ctx) {
    const credential = parseServiceAccountKey(
      ctx.secret(config.credentialSecret),
      config.credentialSecret,
    )
    const token = await accessToken(credential, [CLOUD_PLATFORM_SCOPE])
    const email = serviceAccountEmail(config)
    try {
      await gcp(token, 'DELETE', `${IAM_API}/projects/${config.projectId}/serviceAccounts/${email}`)
    } catch (err) {
      if (err instanceof GcpError && err.status === 404) {
        console.log(`  Service account ${email} already absent`)
        return
      }
      throw err
    }
    console.log(`  Deleted service account ${email}`)
  },
})
