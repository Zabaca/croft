import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import { cf } from '../cloudflare-api'

/**
 * cloudflare-token — mints scoped Cloudflare API tokens from ONE root
 * credential, so per-purpose tokens (worker deploy, DNS, R2, email) never have
 * to be clicked together in the dashboard again.
 *
 * The root credential is an ACCOUNT-OWNED token (dash → Manage Account → API
 * Tokens) holding "Account API Tokens Write" — plus "Zone Read" if instances
 * use `zones`. It is the only Cloudflare secret at rest in secrets.yaml;
 * everything else is minted here and flows to dependents through imports.
 *
 * WHICH root is per-instance: `rootTokenSecret` names the secrets.yaml key,
 * defaulting to CLOUDFLARE_ROOT_TOKEN. One name serves a repo that mints into
 * one account; a repo that also deploys into a client's account keeps that
 * account's root under its own key and points those instances at it. "The only
 * secret at rest" is per ACCOUNT, not per repo.
 *
 * Converge semantics: the token is looked up by NAME. Missing → created (the
 * create response carries the value). Present → policies updated, then the
 * value is ROLLED. Rolling on every apply is deliberate: minted values live
 * only in memory during the apply, are persisted nowhere, and rotation is a
 * free side effect. Corollary: never hand a minted token to a human for local
 * use — it dies on the next apply. Mint a separate named token for that.
 *
 * R2 S3 credentials are a pure derivation of a token (access key id = token
 * id, secret = SHA-256 hex of the value), so instances holding R2 permissions
 * get working S3 credentials in their outputs with no extra API surface.
 *
 * Permissions are configured by permission-group NAME (exact match against
 * `GET /accounts/{id}/tokens/permission_groups`, e.g. "Workers Scripts
 * Write"). Groups scoped `com.cloudflare.api.account.zone` land on a zone
 * policy — restricted to `zones` when given (names resolved via GET /zones),
 * else all zones of the account. Account-scoped groups land on an account
 * policy. Unknown names/zones are hard errors before anything mutates.
 *
 * The REST envelope is `../cloudflare-api`'s, not this module's. The private
 * copy that lived here typed `errors` as `{message: string}` — the exact claim
 * the seam's header documents as false, and the reason a `{code, error}`
 * failure used to arrive as a bare `HTTP 403`. Note this module's token comes
 * from secrets.yaml rather than an import, so `resolveApiToken` does not apply
 * to it; only `cf` does.
 */

export interface PermissionGroup {
  id: string
  name: string
  scopes: string[]
}

interface Policy {
  effect: 'allow'
  permission_groups: Array<{ id: string }>
  resources: Record<string, unknown>
}

/**
 * Split resolved permission groups into an account policy and a zone policy.
 * Zone-scoped groups (scope `com.cloudflare.api.account.zone`) attach to the
 * given zone ids, or — with none given — to all zones of the account via the
 * nested resource form. Pure; exported for tests.
 */
export function buildPolicies(
  accountId: string,
  groups: PermissionGroup[],
  zoneIds: string[],
): Policy[] {
  const zoneScoped = groups.filter((g) => g.scopes.includes('com.cloudflare.api.account.zone'))
  const accountScoped = groups.filter((g) => !zoneScoped.includes(g))
  const policies: Policy[] = []
  if (accountScoped.length > 0) {
    policies.push({
      effect: 'allow',
      permission_groups: accountScoped.map((g) => ({ id: g.id })),
      resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
    })
  }
  if (zoneScoped.length > 0) {
    const resources: Record<string, unknown> =
      zoneIds.length > 0
        ? Object.fromEntries(zoneIds.map((id) => [`com.cloudflare.api.account.zone.${id}`, '*']))
        : {
            [`com.cloudflare.api.account.${accountId}`]: {
              'com.cloudflare.api.account.zone.*': '*',
            },
          }
    policies.push({
      effect: 'allow',
      permission_groups: zoneScoped.map((g) => ({ id: g.id })),
      resources,
    })
  }
  return policies
}

/**
 * R2's S3-compatible credentials are derived, not issued: access key id is the
 * token id, secret access key is the SHA-256 hex of the token value.
 */
export function deriveS3Credentials(
  tokenId: string,
  tokenValue: string,
): { s3AccessKeyId: string; s3SecretAccessKey: string } {
  return {
    s3AccessKeyId: tokenId,
    s3SecretAccessKey: createHash('sha256').update(tokenValue).digest('hex'),
  }
}

/**
 * A granted READ permission group, and the call that proves the minted token
 * may actually exercise it.
 *
 * Read groups only, and that is the whole design. leeandco's token carried
 * `D1 Read` and `D1 Write` and was refused by D1 with error 10000 about five
 * seconds after it was minted; write does not imply read on Cloudflare, so a
 * write-only grant has no safe probe here — asking anyway would fail forever on
 * a token that is working perfectly. What is left for that case is
 * the account-owned token verify (see `readinessProbes`), which is a weaker claim,
 * honestly weaker: measured across three trials on 2026-08-15 it answered 200
 * at 112/111/202 ms while the scope-gated call was still refusing at
 * 1621/610/808 ms.
 *
 * Only account-scoped groups are here. A zone-scoped probe needs a zone id, and
 * the zone ids this apply resolved are not in its outputs.
 *
 * Extending it is adding a line. A permission with no line simply contributes
 * no probe — the table is allowed to be incomplete, and never wrong.
 */
/*
 * A Map rather than an object literal, for one reason: a permission name is
 * untrusted input as far as this lookup is concerned, and `{}[name]` finds
 * `Object.prototype`'s keys. A permission called `constructor` would hit a real
 * function and probe a nonsense path — breaking the promise made just above,
 * that a permission with no entry contributes no probe. A Map has no prototype
 * chain to fall through, and its `get` returns `undefined` honestly, which is
 * also what `noUncheckedIndexedAccess` wants to see checked.
 */
const READ_PROBES = new Map<string, (accountId: string) => string>([
  ['D1 Read', (id) => `/accounts/${id}/d1/database`],
  ['Workers Scripts Read', (id) => `/accounts/${id}/workers/scripts`],
  ['Workers KV Storage Read', (id) => `/accounts/${id}/storage/kv/namespaces`],
  ['Workers R2 Storage Read', (id) => `/accounts/${id}/r2/buckets`],
  ['Account Settings Read', (id) => `/accounts/${id}`],
  ['Zone Read', () => `/zones?per_page=1`],
])

/**
 * The calls that prove a minted token usable, given what it was granted.
 *
 * Falls back to verifying the token when nothing granted has a probe — the
 * weakest honest proof, and still better than none: it catches a token id the
 * API does not yet acknowledge. Pure; exported for tests.
 */
export function readinessProbes(
  permissions: readonly string[],
  accountId: string,
): Array<{ permission: string; path: string }> {
  const probes = permissions.flatMap((permission) => {
    const build = READ_PROBES.get(permission)
    return build === undefined ? [] : [{ permission, path: build(accountId) }]
  })
  // `/accounts/{id}/tokens/verify`, not `/user/tokens/verify`: this module
  // creates ACCOUNT-owned tokens (`POST /accounts/{id}/tokens`), and the
  // user-scoped verify is a different endpoint for a different kind of token.
  return probes.length > 0
    ? probes
    : [{ permission: 'token authentication', path: `/accounts/${accountId}/tokens/verify` }]
}

/** Account-owned token with the given name, if any. Single page by design —
 * an account approaching 500 tokens has bigger problems than this lookup. */
async function findTokenByName(
  rootToken: string,
  accountId: string,
  name: string,
): Promise<{ id: string } | undefined> {
  const tokens = await cf<Array<{ id: string; name: string }>>(
    rootToken,
    'GET',
    `/accounts/${accountId}/tokens?per_page=500`,
  )
  return tokens.find((t) => t.name === name)
}

export const cloudflareTokenModule = defineModule({
  name: 'cloudflare-token',
  configSchema: z.object({
    /** Cloudflare account id (not a secret — it's in every dashboard URL). */
    accountId: z.string(),
    /** Token name — the converge identity. One instance per name. */
    tokenName: z.string(),
    /**
     * Permission-group names, exactly as the CF API lists them (e.g. "Workers
     * Scripts Write", "DNS Write"). Resolved to ids at apply; unknown names
     * are a hard error listing what the API actually offers.
     */
    permissions: z.array(z.string()).nonempty(),
    /**
     * Zone names restricting zone-scoped permission groups (resolved to zone
     * ids via GET /zones — the root token then also needs "Zone Read"). Omit
     * to grant zone-scoped groups on all zones of the account.
     */
    zones: z.array(z.string()).default([]),
    /**
     * Which secrets.yaml key holds the root credential this instance mints
     * from. Defaults to CLOUDFLARE_ROOT_TOKEN — one name is enough until a repo
     * has to mint into two Cloudflare accounts (its own and a client's), at
     * which point both roots live in the same environment under different keys
     * and each instance names the one it belongs to.
     */
    rootTokenSecret: z.string().default('CLOUDFLARE_ROOT_TOKEN'),
  }),
  outputs: z.object({
    tokenId: z.string(),
    /** The live token value. In memory only — rolled on every apply. */
    tokenValue: z.string(),
    /** R2 S3-compatible credentials derived from the token (meaningful only
     * when the token carries R2 permissions; harmless otherwise). */
    s3AccessKeyId: z.string(),
    s3SecretAccessKey: z.string(),
  }),
  /**
   * The two outputs that are credentials. `rotates: 'each-apply'` is this
   * module's whole discipline stated where the engine can act on it: the value
   * is rolled every apply, so it must reach its dependents in memory and land
   * nowhere else — not in an error the engine prints, not in `zbc apply
   * --json`.
   *
   * `tokenId` and `s3AccessKeyId` are deliberately absent: an id names the
   * credential, it is not the credential, and redacting it would cost the
   * operator the one field that lets them find the token in the dashboard.
   */
  secretOutputs: {
    tokenValue: { rotates: 'each-apply' },
    s3SecretAccessKey: { rotates: 'each-apply' },
  },
  async apply(config, ctx) {
    const rootToken = ctx.secret(config.rootTokenSecret)

    // 1. Resolve permission names → group ids. Fail fast before any mutation.
    const available = await cf<PermissionGroup[]>(
      rootToken,
      'GET',
      `/accounts/${config.accountId}/tokens/permission_groups`,
    )
    // A permission NAME can denote more than one group. Cloudflare publishes
    // several of them twice — "Access: Apps and Policies Write" exists both
    // account-scoped and zone-scoped — and `find` silently took whichever came
    // first in the API's ordering. That produced a token holding the permission
    // at the WRONG resource level: granted on every zone, absent at the account,
    // so `POST /accounts/{id}/access/apps` answered 403 while the dashboard
    // showed the permission plainly present. Cost an apply to find.
    //
    // Every match is granted. `buildPolicies` already splits them by scope, so
    // the account-scoped variant lands on the account policy and the zone-scoped
    // one on the zone policy — which is exactly what picking that permission in
    // the dashboard does. Naming a permission means naming it wherever it lives;
    // there is no way for an instance to express "only the zone-scoped half",
    // and no case yet where that distinction was the intent.
    const groups = config.permissions.flatMap((name) => {
      const matches = available.filter((g) => g.name === name)
      if (matches.length === 0) {
        throw new Error(
          `Permission group "${name}" not found. Available: ${available.map((g) => g.name).join(', ')}`,
        )
      }
      return matches
    })

    // 2. Resolve zone names → ids (only when zone scoping is requested).
    const zoneIds = await Promise.all(
      config.zones.map(async (zoneName) => {
        const zones = await cf<Array<{ id: string; name: string }>>(
          rootToken,
          'GET',
          `/zones?name=${encodeURIComponent(zoneName)}`,
        )
        const zone = zones[0]
        if (!zone) throw new Error(`Zone "${zoneName}" not found (root token needs "Zone Read")`)
        return zone.id
      }),
    )

    const policies = buildPolicies(config.accountId, groups, zoneIds)

    // 3. Converge by name: create (value comes back once, on creation) or
    //    update policies + roll the value so this apply holds a live secret.
    const existing = await findTokenByName(rootToken, config.accountId, config.tokenName)
    let tokenId: string
    let tokenValue: string
    if (!existing) {
      const created = await cf<{ id: string; value: string }>(
        rootToken,
        'POST',
        `/accounts/${config.accountId}/tokens`,
        { name: config.tokenName, policies },
      )
      tokenId = created.id
      tokenValue = created.value
      console.log(`  Created token "${config.tokenName}" (${tokenId})`)
    } else {
      tokenId = existing.id
      await cf(rootToken, 'PUT', `/accounts/${config.accountId}/tokens/${tokenId}`, {
        name: config.tokenName,
        policies,
      })
      tokenValue = await cf<string>(
        rootToken,
        'PUT',
        `/accounts/${config.accountId}/tokens/${tokenId}/value`,
        {},
      )
      console.log(`  Converged token "${config.tokenName}" (${tokenId}), value rolled`)
    }

    return { tokenId, tokenValue, ...deriveS3Credentials(tokenId, tokenValue) }
  },
  /**
   * A minted Cloudflare token authenticates before it can act, and the window
   * is seconds wide. The engine holds this token's outputs at every `imports`
   * edge until the probe below passes — so a dependent module's first call with
   * it is never the one that discovers this.
   *
   * The probe runs as the MINTED token, not as the root: the root's own
   * permissions are irrelevant to whether the new one works, and probing with
   * it would pass instantly and prove nothing.
   */
  ready: {
    proves: 'the minted token can exercise the read permissions it was granted',
    timeoutMs: 30_000,
    intervalMs: 2_000,
    async probe(outputs, config) {
      for (const { permission, path } of readinessProbes(config.permissions, config.accountId)) {
        try {
          await cf(outputs.tokenValue, 'GET', path)
        } catch (err) {
          // Which grant is still being refused is the fact the operator needs,
          // and `cf`'s message carries only the path. A token refused on one of
          // several grants is the interesting case: it reads as working.
          throw new Error(
            `"${permission}" refused: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          )
        }
      }
    },
  },
  async destroy(config, ctx) {
    const rootToken = ctx.secret(config.rootTokenSecret)
    const existing = await findTokenByName(rootToken, config.accountId, config.tokenName)
    if (!existing) {
      console.log(`  Token "${config.tokenName}" already absent`)
      return
    }
    await cf(rootToken, 'DELETE', `/accounts/${config.accountId}/tokens/${existing.id}`)
    console.log(`  Deleted token "${config.tokenName}" (${existing.id})`)
  },
})
