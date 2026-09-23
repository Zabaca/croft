import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import { cf } from '../cloudflare-api'

// cloudflare-tunnel — a remotely-managed Cloudflare Tunnel as repo state: the
// tunnel itself, its ingress rules, the DNS records that point at it, and the
// runtime credential the local `cloudflared` needs to dial out.
//
// ── Why "remotely-managed" ────────────────────────────────────────────────
// A tunnel is created either LOCALLY-managed (`cloudflared tunnel create`,
// which needs `cloudflared tunnel login` — a browser OAuth round-trip that
// writes a cert.pem, and ingress then lives in a YAML file on the box) or
// REMOTELY-managed (`config_src: 'cloudflare'`, created over the API, ingress
// stored by Cloudflare, run with nothing but `cloudflared tunnel run --token`).
//
// This module only ever creates the second kind, and REFUSES to adopt the
// first. That is the whole reason it can exist: a locally-managed tunnel
// ignores `PUT /configurations` entirely — the API accepts the call, returns
// success, and the running cloudflared keeps serving whatever its YAML says.
// An IaC module that silently no-ops is worse than one that isn't there, so
// adopting a locally-managed tunnel is a hard error rather than a best effort.
//
// ── Why this module also writes DNS ───────────────────────────────────────
// `packages/infra/modules/cloudflare-zone` is the module for DNS, and it is
// deliberately not used for tunnel hostnames. cloudflare-zone is AUTHORITATIVE
// over a whole zone — it diffs every record and reports everything undeclared
// as drift. That is exactly right for varnick.com, which nothing else writes
// to, and exactly wrong for a zone that another system also manages: cedarpad
// deploys `app.cedarpad.com` and `poc.cedarpad.com` as wrangler
// `custom_domain: true` routes, which make Cloudflare provision managed DNS
// records server-side. varnick-zone's own docstring names this failure — a
// zone module and wrangler's custom domains argue forever, each seeing the
// other's records as drift.
//
// So this module owns exactly the records it creates and nothing else. It
// converges a CNAME per ingress hostname and never looks at the rest of the
// zone, which means it composes with wrangler, with cloudflare-email, and with
// records that were clicked in the dashboard in 2023 by someone who has left.
//
// The guard that makes that safe is `assertAdoptable`: a name that already
// holds something which is NOT a CNAME into `cfargotunnel.com` is a hard error,
// never an overwrite. Pointing `ws.cedarpad.com` at a tunnel is routine;
// silently repointing `app.cedarpad.com` away from production because someone
// fat-fingered a hostname is not a mistake worth being able to make.
//
// ── Why this module writes a local file ───────────────────────────────────
// `vendor/zbc/modules/host-file` writes files, and takes content either inline
// or from a SOPS key — it has no way to take content from an imported
// instance's output. The run token has no business in SOPS (it is derived from
// the tunnel, which this module creates, so a copy in secrets.yaml is a second
// source of truth that drifts the moment a tunnel is recreated) and it cannot
// be inline (nobody knows it until the tunnel exists). Teaching host-file an
// import ref would be the general fix, but vendor/zbc is a git subtree of
// Zabaca/zbc — its README forbids mixing vendor and non-vendor paths in one
// commit, so that is an upstream change, not a line in this file.
//
// Writing it here is defensible on its own terms regardless: the credential is
// this module's own artifact, produced by the same converge that produces the
// tunnel, and `credentialFile` is optional for the case where cloudflared runs
// somewhere this apply cannot reach.
//
// ── What this module does NOT do ──────────────────────────────────────────
// It does not run cloudflared. That is a `systemd-unit` instance importing
// this one — same split as agent-tunnel.ts/agent-tunnel-env.ts, and the reason
// is that restarting the tunnel and reconfiguring it are different blast
// radii. Note the seam's one sharp edge: systemd-unit restarts on UNIT content
// change only, so a credential file that changed underneath a running unit
// does not restart it. That is survivable here because a tunnel's run token is
// stable for the life of the tunnel — unlike `cloudflare-token`, this module
// has no roll-on-every-apply behaviour. If the tunnel is ever recreated, the
// unit needs a manual restart, and the apply says so.

// ── Schema ────────────────────────────────────────────────────────────────

/**
 * One ingress rule. Order is significant and preserved: cloudflared matches
 * top to bottom and takes the first hit, so a `path`-bearing rule must be
 * declared before the bare-hostname rule it narrows.
 */
const ingressRuleSchema = z
  .object({
    /** FQDN. Must sit inside this instance's `zone` — checked at apply. */
    hostname: z.string().min(1),
    /**
     * Go regexp matched against the request path. Omit to match every path.
     * NOT a prefix or a glob: `/__boot` matches any path CONTAINING that
     * substring unless anchored, so write `^/__boot$` when that is the intent.
     */
    path: z.string().optional(),
    /** Origin, as cloudflared spells it: `http://127.0.0.1:4599`, `http_status:404`. */
    service: z.string().min(1),
  })
  .strict()

export type IngressRule = z.infer<typeof ingressRuleSchema>

const configSchema = z.object({
  /** Cloudflare account id. Instance config, never a constant: one zbc project
   *  may span accounts, and a constant would silently converge into the wrong one. */
  accountId: z.string(),
  /** Tunnel name — the converge identity. One instance per name. */
  tunnelName: z.string().min(1),
  /**
   * Where the API credential comes from: `{ from, output }` into an imported
   * `cloudflare-token` instance's `tokenValue`. Same shape cloudflare-zone and
   * vendor/zbc/modules/cloudflare use. Needs "Cloudflare Tunnel Write" for the
   * tunnel, plus "Zone Read" and "DNS Write" for the hostname records.
   */
  apiToken: z.object({ from: z.string(), output: z.string() }),
  /** Zone apex every ingress hostname must live under, e.g. `cedarpad.com`. */
  zone: z.string().min(1),
  /** Ordered ingress rules. The catch-all is appended automatically. */
  ingress: z.array(ingressRuleSchema).nonempty(),
  /**
   * Where to write `TUNNEL_TOKEN=<value>` for a local cloudflared. Omit when
   * cloudflared runs somewhere this apply cannot reach.
   */
  credentialFile: z
    .object({ path: z.string().min(1), mode: z.string().default('0600') })
    .optional(),
})

// ── Pure helpers (exported for tests) ─────────────────────────────────────

/** `<tunnel id>.cfargotunnel.com` — the only legal CNAME target for a tunnel. */
export const tunnelTarget = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`

const CFARGO = /^[0-9a-f-]{36}\.cfargotunnel\.com$/i

/**
 * The ingress array cloudflared is to be given: the declared rules in order,
 * then a catch-all.
 *
 * The catch-all is appended rather than declared because Cloudflare REQUIRES a
 * final rule with no hostname and no path and rejects the PUT without one — so
 * asking each instance to remember it buys nothing but a failed apply. It is
 * `http_status:404`, not a service: a request that matched no rule reached a
 * hostname this tunnel serves and asked for something nobody routed, and
 * answering it from whichever origin happens to be last is how a tunnel starts
 * serving a host it was never told about.
 */
export function buildIngress(rules: IngressRule[]): Array<Record<string, string>> {
  return [
    ...rules.map((rule) => ({
      hostname: rule.hostname,
      ...(rule.path === undefined ? {} : { path: rule.path }),
      service: rule.service,
    })),
    { service: 'http_status:404' },
  ]
}

/** Comparable form: field order and absent-vs-undefined must not read as drift. */
const ingressKey = (rules: Array<Record<string, unknown>>) =>
  JSON.stringify(rules.map((r) => [r.hostname ?? '', r.path ?? '', r.service ?? '']))

export function ingressDiffers(
  desired: Array<Record<string, unknown>>,
  actual: Array<Record<string, unknown>>,
): boolean {
  return ingressKey(desired) !== ingressKey(actual)
}

/** Every hostname must sit inside the declared zone — apex included. */
export function assertHostnamesInZone(rules: IngressRule[], zone: string): void {
  const apex = zone.toLowerCase().replace(/\.$/, '')
  for (const rule of rules) {
    const host = rule.hostname.toLowerCase().replace(/\.$/, '')
    if (host !== apex && !host.endsWith(`.${apex}`)) {
      throw new Error(
        `ingress hostname "${rule.hostname}" is not inside zone "${zone}" — this module only ` +
          `writes DNS in the zone it declares, and a hostname it cannot create a record for is ` +
          `a tunnel route nothing will ever reach.`,
      )
    }
  }
}

export interface ExistingRecord {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
}

export type RecordAction =
  | { kind: 'create' }
  | { kind: 'update'; id: string }
  | { kind: 'unchanged'; id: string }

/**
 * What to do with the name a tunnel hostname wants — and, crucially, when to
 * refuse.
 *
 * Anything at that name which is not a CNAME into `cfargotunnel.com` belongs
 * to someone else: a wrangler custom domain, an email record, a live A record
 * for production. Adopting it would repoint a working hostname at this tunnel
 * on the strength of a typo, and the value it replaced is not recoverable from
 * anything in this repo. Refusing costs one edit; adopting costs an outage.
 *
 * Pure; exported for tests.
 */
export function planRecord(
  hostname: string,
  tunnelId: string,
  existing: ExistingRecord[],
): RecordAction {
  const wanted = tunnelTarget(tunnelId)
  const atName = existing.filter((r) => r.name.toLowerCase() === hostname.toLowerCase())
  if (atName.length === 0) return { kind: 'create' }
  if (atName.length > 1) {
    throw new Error(
      `refusing to apply: ${hostname} has ${atName.length} DNS records (${atName
        .map((r) => `${r.type} -> ${r.content}`)
        .join(', ')}). A tunnel hostname is a single CNAME; resolve this by hand.`,
    )
  }
  const record = atName[0] as ExistingRecord
  const isTunnelCname =
    record.type === 'CNAME' && CFARGO.test(record.content.trim().replace(/\.$/, ''))
  if (!isTunnelCname) {
    throw new Error(
      `refusing to apply: ${hostname} already holds ${record.type} -> ${record.content}, which ` +
        `this module did not create. Tunnel hostnames are only ever adopted from a CNAME into ` +
        `cfargotunnel.com — anything else is another system's record (a wrangler custom domain, ` +
        `an email record, a live origin) and overwriting it is not recoverable from this repo. ` +
        `Delete it deliberately, or point this instance at a name nobody is using.`,
    )
  }
  const sameTarget = record.content.trim().replace(/\.$/, '').toLowerCase() === wanted.toLowerCase()
  return sameTarget && record.proxied === true
    ? { kind: 'unchanged', id: record.id }
    : { kind: 'update', id: record.id }
}

// ── Module ────────────────────────────────────────────────────────────────

interface CfTunnel {
  id: string
  name: string
  config_src?: string
  deleted_at?: string | null
}

export const cloudflareTunnelModule = defineModule({
  name: 'cloudflare-tunnel',
  configSchema,
  outputs: z.object({
    tunnelId: z.string(),
    /** `TUNNEL_TOKEN` for `cloudflared tunnel run`. Stable for the tunnel's life. */
    runToken: z.string(),
    hostnames: z.array(z.string()),
    /** True when this apply created the tunnel — the unit needs a restart. */
    createdTunnel: z.boolean(),
    changed: z.boolean(),
  }),
  async apply(config, ctx) {
    const token = ctx.output(config.apiToken, 'apiToken')
    assertHostnamesInZone(config.ingress, config.zone)

    // 1. Converge the tunnel by name. `is_deleted=false` matters: Cloudflare
    //    keeps deleted tunnels in the list, and adopting one is an apply that
    //    reports success against a tunnel that can never connect.
    const found = await cf<CfTunnel[]>(
      token,
      'GET',
      `/accounts/${config.accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(config.tunnelName)}`,
    )
    const existing = found.find((t) => t.name === config.tunnelName && !t.deleted_at)

    let tunnelId: string
    let createdTunnel = false
    if (!existing) {
      const created = await cf<CfTunnel>(
        token,
        'POST',
        `/accounts/${config.accountId}/cfd_tunnel`,
        {
          name: config.tunnelName,
          config_src: 'cloudflare',
        },
      )
      tunnelId = created.id
      createdTunnel = true
      console.log(`  Created tunnel "${config.tunnelName}" (${tunnelId})`)
    } else {
      tunnelId = existing.id
      // See the header: a locally-managed tunnel accepts PUT /configurations
      // and ignores it. Refuse rather than converge into a lie.
      if (existing.config_src && existing.config_src !== 'cloudflare') {
        throw new Error(
          `refusing to apply: tunnel "${config.tunnelName}" (${tunnelId}) is ${existing.config_src}-managed, ` +
            `so its ingress lives in a cloudflared config file on some host and the API's ` +
            `configuration endpoint is a no-op against it. This module manages ingress remotely ` +
            `or not at all. Delete the tunnel and let this instance recreate it, or take the ` +
            `hostname off this module.`,
        )
      }
      console.log(`  Tunnel "${config.tunnelName}" (${tunnelId}) exists`)
    }

    // 2. Ingress, written only when it actually differs.
    const desiredIngress = buildIngress(config.ingress)
    const current = await cf<{ config?: { ingress?: Array<Record<string, unknown>> } }>(
      token,
      'GET',
      `/accounts/${config.accountId}/cfd_tunnel/${tunnelId}/configurations`,
    )
    const actualIngress = current.config?.ingress ?? []
    let ingressChanged = false
    if (ingressDiffers(desiredIngress, actualIngress)) {
      await cf(
        token,
        'PUT',
        `/accounts/${config.accountId}/cfd_tunnel/${tunnelId}/configurations`,
        {
          config: { ingress: desiredIngress },
        },
      )
      ingressChanged = true
      for (const rule of desiredIngress) {
        console.log(
          `    → ${rule.hostname ?? '(catch-all)'}${rule.path ? ` ${rule.path}` : ''} => ${rule.service}`,
        )
      }
    } else {
      console.log(`    = ingress unchanged (${config.ingress.length} rules)`)
    }

    // 3. One CNAME per distinct hostname. Records this module did not create
    //    are never touched — see planRecord.
    const zones = await cf<Array<{ id: string; name: string }>>(
      token,
      'GET',
      `/zones?name=${encodeURIComponent(config.zone)}`,
    )
    const zone = zones.find((z) => z.name.toLowerCase() === config.zone.toLowerCase())
    if (!zone) {
      throw new Error(
        `Zone "${config.zone}" not found — either it is not in this Cloudflare account, or the ` +
          `imported token lacks "Zone Read".`,
      )
    }

    const hostnames = [...new Set(config.ingress.map((r) => r.hostname.toLowerCase()))]
    let dnsChanged = false
    for (const hostname of hostnames) {
      const atName = await cf<ExistingRecord[]>(
        token,
        'GET',
        `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`,
      )
      const action = planRecord(hostname, tunnelId, atName)
      const body = {
        type: 'CNAME',
        name: hostname,
        content: tunnelTarget(tunnelId),
        // Required, not a preference: an unproxied CNAME to cfargotunnel.com
        // does not resolve at all — the tunnel is reachable only through
        // Cloudflare's edge, which is also where Access enforces.
        proxied: true,
        ttl: 1,
      }
      if (action.kind === 'create') {
        await cf(token, 'POST', `/zones/${zone.id}/dns_records`, body)
        dnsChanged = true
        console.log(`    + ${hostname} -> ${body.content} (proxied)`)
      } else if (action.kind === 'update') {
        await cf(token, 'PATCH', `/zones/${zone.id}/dns_records/${action.id}`, body)
        dnsChanged = true
        console.log(`    ~ ${hostname} -> ${body.content} (proxied)`)
      } else {
        console.log(`    = ${hostname} unchanged`)
      }
    }

    // 4. The run token, and optionally the env file cloudflared reads it from.
    const runToken = await cf<string>(
      token,
      'GET',
      `/accounts/${config.accountId}/cfd_tunnel/${tunnelId}/token`,
    )

    let credentialChanged = false
    if (config.credentialFile) {
      const desired = `TUNNEL_TOKEN=${runToken}\n`
      const target = config.credentialFile.path
      const mode = parseInt(config.credentialFile.mode, 8)
      const onDisk = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
      credentialChanged = onDisk !== desired
      if (credentialChanged) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        // mode at create time — a default-umask write followed by chmod leaves
        // a window where a credential file is world-readable. host-file's own
        // comment; the same window exists here.
        fs.writeFileSync(target, desired, { mode })
      }
      fs.chmodSync(target, mode)
      console.log(`  ${target} ${credentialChanged ? 'written' : 'unchanged'}`)
    }

    if (createdTunnel && config.credentialFile) {
      console.log(
        `  NOTE: tunnel was created this apply, so its run token is new. systemd-unit restarts ` +
          `on unit-content change only — restart the cloudflared unit by hand.`,
      )
    }

    return {
      tunnelId,
      runToken,
      hostnames,
      createdTunnel,
      changed: createdTunnel || ingressChanged || dnsChanged || credentialChanged,
    }
  },
  async destroy(config, ctx) {
    const token = ctx.output(config.apiToken, 'apiToken')
    const found = await cf<CfTunnel[]>(
      token,
      'GET',
      `/accounts/${config.accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(config.tunnelName)}`,
    )
    const existing = found.find((t) => t.name === config.tunnelName && !t.deleted_at)
    if (!existing) {
      console.log(`  Tunnel "${config.tunnelName}" already absent`)
      return
    }
    // DNS records are deliberately left behind. A CNAME to a dead tunnel fails
    // closed (Cloudflare answers 1033), whereas deleting the record frees the
    // name for whatever wildcard or catch-all sits above it — failing OPEN onto
    // some other origin is the worse of the two.
    await cf(token, 'DELETE', `/accounts/${config.accountId}/cfd_tunnel/${existing.id}`)
    console.log(
      `  Deleted tunnel "${config.tunnelName}" (${existing.id}); DNS records left in place`,
    )
  },
})
