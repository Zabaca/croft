import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import type { ApplyContext } from '../../src/types'
import { CfError, cf, type CfOptions } from '../cloudflare-api'

/**
 * cloudflare-email — provisions Cloudflare Email Service (public beta) for a
 * domain: outbound sending (SPF/DKIM/DMARC/bounce-MX auto-provisioned) and/or
 * inbound routing (literal rules + catch-all → forward / worker / drop).
 *
 * Unlike the `cloudflare` module (which shells out to wrangler), this module
 * calls the Cloudflare REST API directly — wrangler has no surface for Email
 * Routing / Email Sending onboarding. Same turso-style shape: token from
 * ctx.secret, idempotent list→create everywhere, console.log progress.
 *
 * Operational caveats (beta):
 * - Email Sending requires a Workers Paid plan (403/10105 = not entitled).
 * - The API token needs Email Routing Rules Edit + Zone Settings Edit (the
 *   routing enable/settings/DNS endpoints live under generic Zone Settings) +
 *   DNS Edit on the zone, and Email Sending Edit + Email Routing Addresses
 *   Edit on the account (10000 "Authentication error" = missing scope).
 * - `forward` targets must be verified destination addresses; verification is
 *   a manual email click. apply creates the address (which sends the email)
 *   and fails with instructions — click the link, re-run apply.
 * - Outbound cap 5 MiB per message; rate limits are unpublished. Pilot before
 *   pointing high-volume projects at it.
 * - Sending onboarding adds an SPF record; if the (sub)domain already has one,
 *   merge them manually — two SPF records break SPF evaluation entirely.
 */

/**
 * Named per-code guidance for this module's calls — the one genuinely
 * per-module part of a Cloudflare failure, and the reason `CfOptions.hints`
 * exists. Everything else about the envelope (the base URL, the error shapes,
 * the non-JSON guard, the typed throw) is `../cloudflare-api`'s.
 */
const OPTS: CfOptions = {
  hints: {
    10000:
      `rejected the token (10000 Authentication error). ` +
      `CLOUDFLARE_API_TOKEN is likely missing a scope — it needs: ` +
      `Zone → Email Routing Rules: Edit, Zone → Zone Settings: Edit (the routing ` +
      `enable/settings/DNS endpoints live under generic Zone Settings), Zone → DNS: Edit, ` +
      `Account → Email Sending: Edit, Account → Email Routing Addresses: Edit. Edit the token at ` +
      `https://dash.cloudflare.com/profile/api-tokens and re-run zbc apply.`,
    10105:
      `failed: the account is not entitled to Email Sending (10105). ` +
      `Email Sending requires a Workers Paid plan — upgrade the account, then re-run zbc apply.`,
  },
}

/**
 * A worker name: either a literal script name, or a `{ from, output }`
 * reference into an imported instance's outputs (e.g. the cloudflare module
 * emits `workerName`). References make the coupling refactor-safe — a rename
 * in wrangler.jsonc flows through automatically, and a typo'd instance or
 * output is a hard error at apply time instead of a dangling routing rule.
 */
const workerRefSchema = z.union([
  z.string(),
  z.object({
    /** Instance name — must be listed in this instance's `imports`. */
    from: z.string(),
    /** Which output of that instance holds the worker name. */
    output: z.string(),
  }),
])

type WorkerRef = z.infer<typeof workerRefSchema>

/** Resolve a worker-name entry to its literal string. */
function resolveWorkerName(ref: WorkerRef, ctx: ApplyContext, fieldName: string): string {
  if (typeof ref === 'string') return ref
  return ctx.output(ref, fieldName)
}

/** A routing rule action target. */
const addressSchema = z.object({
  /** Local part only — the domain comes from config.domain. */
  localPart: z.string(),
  action: z.enum(['forward', 'worker']),
  /** forward: a verified destination address (email). */
  destination: z.string().optional(),
  /** worker: the script name, literal or `{ from, output }` import reference. */
  workerName: workerRefSchema.optional(),
})

const catchAllSchema = z.object({
  action: z.enum(['worker', 'forward', 'drop']),
  /** worker: the script name, literal or `{ from, output }` import reference. */
  workerName: workerRefSchema.optional(),
  destination: z.string().optional(),
})

interface RoutingRule {
  id: string
  name?: string
  enabled: boolean
  matchers: Array<{ type: string; field?: string; value?: string }>
  actions: Array<{ type: string; value?: string[] }>
}

interface SendingSubdomain {
  tag: string
  name: string
  enabled: boolean
}

/** Managed-rule marker so destroy only removes rules this module created. */
const RULE_PREFIX = 'zbc:'

function ruleAction(
  entry: { action: string; destination?: string; workerName?: WorkerRef },
  ctx: ApplyContext,
  fieldName: string,
): { type: string; value?: string[] } {
  if (entry.action === 'forward') {
    if (!entry.destination) throw new Error(`${fieldName}: action "forward" requires a destination`)
    return { type: 'forward', value: [entry.destination] }
  }
  if (entry.action === 'worker') {
    if (!entry.workerName) throw new Error(`${fieldName}: action "worker" requires a workerName`)
    return { type: 'worker', value: [resolveWorkerName(entry.workerName, ctx, fieldName)] }
  }
  return { type: 'drop' }
}

/**
 * Ensure a forward destination exists and is verified. Creating an address
 * triggers Cloudflare's verification email; verification itself is a manual
 * click we cannot automate — so fail with instructions and let the operator
 * re-run apply.
 */
async function ensureDestinationVerified(
  token: string,
  accountId: string,
  email: string,
): Promise<void> {
  const addresses = await cf<Array<{ email: string; verified?: string | null }>>(
    token,
    'GET',
    `/accounts/${accountId}/email/routing/addresses?per_page=50`,
    undefined,
    OPTS,
  )
  const existing = addresses.find((a) => a.email.toLowerCase() === email.toLowerCase())
  if (existing?.verified) return
  if (!existing) {
    await cf(token, 'POST', `/accounts/${accountId}/email/routing/addresses`, { email }, OPTS)
    console.log(`  Created destination address ${email} — verification email sent`)
  }
  throw new Error(
    `Destination address ${email} is not verified yet. Cloudflare has emailed it a ` +
      `verification link — click it, then re-run zbc apply.`,
  )
}

/** Recorded in outputs when the API carried no status for a record. */
const UNREPORTED = 'unreported'

/** One record as the Sending API returned it, plus how it should be labelled. */
export interface SendingDnsReading {
  /** `MX cf-bounce.example.com` — what a warning prints. */
  key: string
  /** The status Cloudflare reported, or `null` when it reported none. */
  status: string | null
}

/**
 * Read one Sending DNS record.
 *
 * The API is beta and its field names have moved, so this reads defensively —
 * but the defensiveness stops at the LABEL. `type` and `name` fall back to
 * placeholders because a wrong guess there only mislabels a line. `status` does
 * not fall back at all: it returns `null` when the API carried none, because the
 * previous `?? 'unknown'` produced a string the caller then compared against
 * active|verified|locked, failed, and printed as `Sending DNS pending`.
 *
 * That turned "I could not find the field" into a claim about the customer's
 * DNS. On one zone it fired on all four records — MX, SPF, DKIM, DMARC — every
 * apply, while every record resolved correctly and the domain published
 * `p=reject`, under which unaligned mail is refused rather than delivered. Mail
 * was flowing the whole time. Absence and failure are different answers and only
 * one of them is about DNS.
 */
export function readSendingDnsRecord(
  record: Record<string, unknown>,
  domain: string,
): SendingDnsReading {
  const reported = record.status ?? record.state
  return {
    key: `${String(record.type ?? 'record')} ${String(record.name ?? domain)}`,
    status: reported === undefined || reported === null ? null : String(reported),
  }
}

/** A status Cloudflare reports for a record that is live and serving. */
const LIVE = new Set(['active', 'verified', 'locked'])

export interface SendingDnsVerdict {
  /** Reported as something other than live. A real warning. */
  pending: SendingDnsReading[]
  /** Carried no status. The module's blind spot, not a fact about the zone. */
  unreported: SendingDnsReading[]
}

export function classifySendingDns(readings: SendingDnsReading[]): SendingDnsVerdict {
  return {
    pending: readings.filter((r) => r.status !== null && !LIVE.has(r.status)),
    unreported: readings.filter((r) => r.status === null),
  }
}

export const cloudflareEmailModule = defineModule({
  name: 'cloudflare-email',
  configSchema: z.object({
    /** Cloudflare account id (dashboard URL — not a secret). */
    accountId: z.string(),
    /** Zone id of the apex zone (e.g. cedarpad.com's zone). */
    zoneId: z.string(),
    /** Email domain — the zone apex or a subdomain of it (e.g. mail.cedarpad.com). */
    domain: z.string(),
    /** Onboard the domain for outbound sending (SPF/DKIM/DMARC/bounce-MX). */
    enableSending: z.boolean().default(true),
    /** Enable inbound routing (MX records) + rules below. */
    enableRouting: z.boolean().default(false),
    /** Catch-all rule for the domain. Omit to leave catch-all untouched. */
    catchAll: catchAllSchema.optional(),
    /** Literal-address rules (localPart @ domain). */
    addresses: z.array(addressSchema).default([]),
  }),
  outputs: z.object({
    sendingEnabled: z.boolean(),
    routingEnabled: z.boolean(),
    /** DNS record name+type → status (e.g. "MX mail.cedarpad.com": "active"). */
    dnsStatus: z.record(z.string()),
    /** Full email addresses with literal rules. */
    addresses: z.array(z.string()),
    accountId: z.string(),
    domain: z.string(),
  }),
  async apply(config, ctx) {
    const token = ctx.secret('CLOUDFLARE_API_TOKEN')

    const { accountId, zoneId, domain } = config
    const dnsStatus: Record<string, string> = {}
    let sendingEnabled = false
    let routingEnabled = false

    // ── 1. Outbound sending: onboard the (sub)domain, surface DNS status ────
    if (config.enableSending) {
      const subdomains = await cf<SendingSubdomain[]>(
        token,
        'GET',
        `/zones/${zoneId}/email/sending/subdomains`,
        undefined,
        OPTS,
      )
      let sub = subdomains.find((s) => s.name === domain)
      if (sub) {
        console.log(`  Sending: ${domain} already onboarded`)
      } else {
        sub = await cf<SendingSubdomain>(
          token,
          'POST',
          `/zones/${zoneId}/email/sending/subdomains`,
          { name: domain },
          OPTS,
        )
        console.log(`  Sending: onboarded ${domain} (SPF/DKIM/DMARC/bounce-MX auto-provisioned)`)
      }
      sendingEnabled = true

      // DNS record verification status. Field names are beta-era; read
      // defensively and record whatever type/name/status the API returns.
      try {
        const dns = await cf<unknown>(
          token,
          'GET',
          `/zones/${zoneId}/email/sending/subdomains/${sub.tag}/dns`,
          undefined,
          OPTS,
        )
        const records: Array<Record<string, unknown>> = Array.isArray(dns)
          ? (dns as Array<Record<string, unknown>>)
          : (((dns as Record<string, unknown>)?.['records'] as Array<Record<string, unknown>>) ??
            [])
        const readings = records.map((r) => readSendingDnsRecord(r, domain))
        const verdict = classifySendingDns(readings)
        for (const r of readings) dnsStatus[r.key] = r.status ?? UNREPORTED
        for (const r of verdict.pending) {
          console.log(`  ⚠ Sending DNS pending: ${r.key} → ${r.status}`)
        }
        if (verdict.unreported.length > 0) {
          // Said once, and not as a warning: the records may be perfectly fine.
          console.log(
            `  Sending DNS: the API reported no status for ${verdict.unreported.length} record(s) ` +
              `— not a claim about the zone; check them with dig if in doubt`,
          )
        }
      } catch (err) {
        console.log(`  ⚠ Could not read sending DNS status: ${(err as Error).message}`)
      }
    }

    // ── 2. Inbound routing: enable, subdomain DNS, rules, catch-all ─────────
    if (config.enableRouting) {
      const settings = await cf<{ enabled?: boolean; status?: string }>(
        token,
        'GET',
        `/zones/${zoneId}/email/routing`,
        undefined,
        OPTS,
      )
      if (settings.enabled || settings.status === 'ready') {
        console.log(`  Routing: already enabled on zone`)
      } else {
        await cf(token, 'POST', `/zones/${zoneId}/email/routing/enable`, undefined, OPTS)
        console.log(`  Routing: enabled on zone (MX/SPF records locked in)`)
      }
      routingEnabled = true

      // Subdomain routing: provision routing DNS for the subdomain itself
      // (POST /email/routing/dns with the subdomain name). Idempotent: check
      // first via the subdomain query param.
      const zone = await cf<{ name: string }>(token, 'GET', `/zones/${zoneId}`, undefined, OPTS)
      if (domain !== zone.name) {
        try {
          const dns = await cf<Array<Record<string, unknown>>>(
            token,
            'GET',
            `/zones/${zoneId}/email/routing/dns?subdomain=${encodeURIComponent(domain)}`,
            undefined,
            OPTS,
          )
          const hasMx = Array.isArray(dns) && dns.some((r) => r.type === 'MX')
          if (!hasMx) {
            await cf(token, 'POST', `/zones/${zoneId}/email/routing/dns`, { name: domain }, OPTS)
            console.log(`  Routing: provisioned DNS for subdomain ${domain}`)
          } else {
            console.log(`  Routing: subdomain ${domain} DNS already provisioned`)
          }
        } catch (err) {
          // Some API versions only expose subdomain enrollment via POST; try it.
          if (err instanceof CfError && err.status === 404) {
            await cf(token, 'POST', `/zones/${zoneId}/email/routing/dns`, { name: domain }, OPTS)
            console.log(`  Routing: provisioned DNS for subdomain ${domain}`)
          } else {
            throw err
          }
        }
      }

      // Routing DNS status for the domain
      try {
        const routingDns = await cf<Array<Record<string, unknown>>>(
          token,
          'GET',
          `/zones/${zoneId}/email/routing/dns${domain !== zone.name ? `?subdomain=${encodeURIComponent(domain)}` : ''}`,
          undefined,
          OPTS,
        )
        for (const r of routingDns ?? []) {
          dnsStatus[`${String(r.type ?? 'record')} ${String(r.name ?? domain)}`] = String(
            r.status ?? 'unknown',
          )
        }
      } catch {
        // status endpoint variance — non-fatal
      }

      // Pre-verify every forward destination before touching rules.
      const forwardTargets = new Set<string>()
      for (const a of config.addresses) {
        if (a.action === 'forward' && a.destination) forwardTargets.add(a.destination)
      }
      if (config.catchAll?.action === 'forward' && config.catchAll.destination) {
        forwardTargets.add(config.catchAll.destination)
      }
      for (const dest of forwardTargets) {
        await ensureDestinationVerified(token, accountId, dest)
      }

      // Upsert literal rules for each address.
      const existingRules = await cf<RoutingRule[]>(
        token,
        'GET',
        `/zones/${zoneId}/email/routing/rules?per_page=50`,
        undefined,
        OPTS,
      )
      for (const entry of config.addresses) {
        const email = `${entry.localPart}@${domain}`
        const ruleName = `${RULE_PREFIX}${email}`
        const body = {
          name: ruleName,
          enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: email }],
          actions: [ruleAction(entry, ctx, `addresses[${entry.localPart}]`)],
        }
        const existing = existingRules.find(
          (r) =>
            r.name === ruleName ||
            r.matchers.some((m) => m.type === 'literal' && m.value === email),
        )
        if (existing) {
          await cf(token, 'PUT', `/zones/${zoneId}/email/routing/rules/${existing.id}`, body, OPTS)
          console.log(`  Routing: updated rule for ${email} → ${entry.action}`)
        } else {
          await cf(token, 'POST', `/zones/${zoneId}/email/routing/rules`, body, OPTS)
          console.log(`  Routing: created rule for ${email} → ${entry.action}`)
        }
      }

      // Catch-all.
      if (config.catchAll) {
        await cf(
          token,
          'PUT',
          `/zones/${zoneId}/email/routing/rules/catch_all`,
          {
            name: `${RULE_PREFIX}catch-all`,
            enabled: true,
            matchers: [{ type: 'all' }],
            actions: [ruleAction(config.catchAll, ctx, 'catchAll')],
          },
          OPTS,
        )
        console.log(`  Routing: catch-all → ${config.catchAll.action}`)
      }
    }

    const pending = Object.entries(dnsStatus).filter(
      ([, s]) => s !== UNREPORTED && s !== 'active' && s !== 'verified' && s !== 'locked',
    )
    if (pending.length > 0) {
      console.log(
        `  ⚠ ${pending.length} DNS record(s) not yet verified — mail may not flow until they are:`,
      )
      for (const [k, s] of pending) console.log(`      ${k}: ${s}`)
    }

    return {
      sendingEnabled,
      routingEnabled,
      dnsStatus,
      addresses: config.addresses.map((a) => `${a.localPart}@${domain}`),
      accountId,
      domain,
    }
  },
  async destroy(config, ctx) {
    const token = ctx.secret('CLOUDFLARE_API_TOKEN')
    const { zoneId, domain } = config

    console.log(`  ⚠ DESTROYING email config for ${domain} — mail for this domain WILL STOP.`)

    // Remove managed rules (only ones this module named).
    try {
      const rules = await cf<RoutingRule[]>(
        token,
        'GET',
        `/zones/${zoneId}/email/routing/rules?per_page=50`,
        undefined,
        OPTS,
      )
      for (const r of rules) {
        if (r.name?.startsWith(RULE_PREFIX)) {
          await cf(token, 'DELETE', `/zones/${zoneId}/email/routing/rules/${r.id}`, undefined, OPTS)
          console.log(`  Deleted rule ${r.name}`)
        }
      }
    } catch (err) {
      console.log(`  Rule cleanup skipped: ${(err as Error).message}`)
    }

    // Reset catch-all to drop (catch_all can't be deleted, only redefined).
    if (config.catchAll) {
      try {
        await cf(
          token,
          'PUT',
          `/zones/${zoneId}/email/routing/rules/catch_all`,
          {
            name: `${RULE_PREFIX}catch-all`,
            enabled: false,
            matchers: [{ type: 'all' }],
            actions: [{ type: 'drop' }],
          },
          OPTS,
        )
        console.log(`  Catch-all disabled`)
      } catch (err) {
        console.log(`  Catch-all reset skipped: ${(err as Error).message}`)
      }
    }

    if (config.enableRouting) {
      try {
        await cf(token, 'POST', `/zones/${zoneId}/email/routing/disable`, undefined, OPTS)
        console.log(`  Routing disabled on zone`)
      } catch (err) {
        console.log(`  Routing disable skipped: ${(err as Error).message}`)
      }
    }

    if (config.enableSending) {
      try {
        const subdomains = await cf<SendingSubdomain[]>(
          token,
          'GET',
          `/zones/${zoneId}/email/sending/subdomains`,
          undefined,
          OPTS,
        )
        const sub = subdomains.find((s) => s.name === domain)
        if (sub) {
          await cf(
            token,
            'DELETE',
            `/zones/${zoneId}/email/sending/subdomains/${sub.tag}`,
            undefined,
            OPTS,
          )
          console.log(`  Sending subdomain ${domain} deleted`)
        }
      } catch (err) {
        console.log(`  Sending teardown skipped: ${(err as Error).message}`)
      }
    }
  },
})
