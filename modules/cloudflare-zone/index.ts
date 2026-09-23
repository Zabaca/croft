import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import { cf, cfRaw } from '../cloudflare-api'

// cloudflare-zone — a DNS zone's records as repo state instead of dashboard
// state. CLAUDE.md names Cloudflare DNS as off-box state we own; `cloudflare-token`
// closed the token half of that gap in 2026-08 and this closes the records half.
//
// The module is AUTHORITATIVE over the zone: it computes the full
// desired-vs-actual diff, creates what is missing, updates what has moved, and
// reports everything present that nobody declared. What it does NOT do by
// default is delete — `allowDelete` defaults to false, so the first thing a new
// zone tells you is what it already contains, and removing any of it is a
// second, deliberate edit. An authoritative module that deletes on sight is one
// forgotten record away from taking a live service down on its first apply.
//
// One module owns the zone AND its records, rather than a zone module plus a
// record module. Drift is only computable against the whole set: "this record
// is undeclared" is a statement about the zone, not about a record, and a
// per-record module can never make it.
//
// ── Records this module must never touch ──────────────────────────────────
// `vendor/zbc/modules/cloudflare-email` onboards a domain for sending and
// Cloudflare then provisions SPF, DKIM, DMARC and a bounce MX **server-side**.
// Those records exist in the zone and appear in no instance file, so to an
// authoritative zone module they look exactly like drift — and deleting them
// silently stops outbound mail. They are matched STRUCTURALLY (see
// `emailPurpose`) rather than by a hardcoded list of names, because Cloudflare
// picks the DKIM selector labels itself and they differ per domain and per
// onboarding.
//
// Matched records are excluded from the diff entirely — not merely from
// deletion. If they were only exempt from deletion they would still be in the
// pairing pool, and a declared `google-site-verification=…` TXT at the apex
// could pair against the SPF record and rewrite it. cloudflare-email's own
// docstring records why that is catastrophic rather than annoying: two SPF
// records break SPF evaluation entirely.
//
// The rule cannot be "never touch anything email-shaped", though: a zone with
// no cloudflare-email instance behind it may legitimately declare its own SPF,
// and once created that record is structurally identical to a provisioned one,
// so a blanket exclusion would make its second apply diverge forever. So a
// declared record of a given email purpose CLAIMS the live record of that
// purpose at that name — identical values converge as unchanged, differing
// values are a hard error. See `planZone`.
//
// ── `proxied` is required, and only where it means something ──────────────
// A, AAAA and CNAME must state `proxied` explicitly; there is no default. The
// flag decides whether traffic passes through Cloudflare at all, and a guessed
// default is how a record silently starts or stops being proxied on a refactor
// — the exact failure the 2026-07-27 zabaca.com zone migration hit, where
// Cloudflare's own importer flipped three records to Proxied and nothing said
// so. Other record types reject the flag outright (the schemas are `.strict()`)
// so `proxied: false` on a TXT can never read as a considered choice.
//
// ── ZONE SETTINGS ARE FORWARD-ONLY, AND THAT IS NOT THE RECORD RULE ───────
// `settings` converges zone-level settings — `always_use_https` and its
// neighbours. It lives here rather than in the deploying module because it is
// state about the ZONE, and a Worker that happens to sit on a hostname in it is
// not the thing that owns it (see ADR-0016).
//
// The rule is deliberately NOT the record rule. A zone carries every setting at
// all times, so "present in Cloudflare, declared nowhere" — the sentence the
// whole `allowDelete` design exists to answer — cannot be said about a setting.
// So: what is declared is converged, what is not declared is not read, not
// reported and not touched. There is nothing to opt into and nothing to delete.
//
// What the settings converge CAN do is fail, and it does so before writing
// anything at all. A setting the zone reports as `editable: false` is gated on
// the account's plan; one absent from the zone's own list is an id Cloudflare
// does not offer. Both refuse in the plan, ahead of the first record write —
// discovering either from a half-applied PATCH would leave the zone in a state
// neither the file nor the previous apply describes.
//
// ── Account-parameterised ─────────────────────────────────────────────────
// `accountId` is instance config, never a constant: each client's
// zone in that Client's own Cloudflare account. Apply refuses outright if the
// looked-up zone belongs to a different account than the one declared — the
// cheapest possible guard against converging the right records into the wrong
// tenant.
//
// There is deliberately no `destroy`. Deleting a zone detaches a live domain
// from its nameservers and is registrar-adjacent; it is a human action with a
// human's attention on it, not something a converge loop should be able to do.

// ── Schema ────────────────────────────────────────────────────────────────

/** TTL 1 is Cloudflare's "automatic"; it is the only legal TTL for a proxied record. */
const AUTO_TTL = 1

const ttlField = z.number().int().min(1).max(86400).default(AUTO_TTL)

/**
 * A record type that can pass through Cloudflare's proxy. `proxied` is
 * REQUIRED — see the header. `.strict()` so a typo'd field is an error rather
 * than a silently ignored intention.
 */
const proxiableRecord = <T extends 'A' | 'AAAA' | 'CNAME'>(type: T) =>
  z
    .object({
      type: z.literal(type),
      /** `@` or the zone name for the apex; anything else is taken relative to the zone. */
      name: z.string(),
      content: z.string(),
      /** Required. No default is guessed — this decides whether Cloudflare is in the path. */
      proxied: z.boolean(),
      ttl: ttlField,
    })
    .strict()

const recordSchema = z.discriminatedUnion('type', [
  proxiableRecord('A'),
  proxiableRecord('AAAA'),
  proxiableRecord('CNAME'),
  z
    .object({
      type: z.literal('TXT'),
      name: z.string(),
      content: z.string(),
      ttl: ttlField,
    })
    .strict(),
  z
    .object({
      type: z.literal('MX'),
      name: z.string(),
      content: z.string(),
      /** Required: an MX with no preference is not a record Cloudflare will take. */
      priority: z.number().int().min(0).max(65535),
      ttl: ttlField,
    })
    .strict(),
  z
    .object({
      type: z.literal('NS'),
      name: z.string(),
      content: z.string(),
      ttl: ttlField,
    })
    .strict(),
])

export type RecordConfig = z.infer<typeof recordSchema>

/**
 * The zone settings this module can converge, with the values Cloudflare
 * accepts for each. A closed list rather than an open `Record<string, string>`:
 * every one of these is a string enum in the API with its own legal values, and
 * a typo in either half is rejected at the boundary instead of at the PATCH.
 *
 * `.partial()` because a declared setting is the unit — an instance says
 * `always_use_https: 'on'` and says nothing about TLS, and that silence is
 * meaningful. `.strict()` so a setting nobody taught this module is a config
 * error rather than a key silently dropped and never applied.
 */
const settingsSchema = z
  .object({
    /**
     * The setting behind the recorded outage: with it off, `http://` is served
     * as-is, the page is a non-secure context, and the browser APIs gated on
     * one (Geolocation, among others) are simply absent.
     */
    always_use_https: z.enum(['on', 'off']),
    automatic_https_rewrites: z.enum(['on', 'off']),
    ssl: z.enum(['off', 'flexible', 'full', 'strict']),
    min_tls_version: z.enum(['1.0', '1.1', '1.2', '1.3']),
  })
  .partial()
  .strict()
  .default({})

export type ZoneSettings = z.infer<typeof settingsSchema>

const configSchema = z
  .object({
    /** Cloudflare account id. Instance config, never a constant. */
    accountId: z.string(),
    /** Zone apex, e.g. `varnick.com`. The converge identity. */
    zone: z.string(),
    /**
     * Where the DNS credential comes from: `{ from, output }` into an imported
     * instance's outputs — a `cloudflare-token` instance's `tokenValue`. Same
     * shape `vendor/zbc/modules/cloudflare` uses. Deliberately not optional and
     * deliberately not a secrets.yaml key: a zone credential that sits at rest
     * is a zone credential nobody rotates.
     */
    apiToken: z.object({
      /** Instance name — must be listed in this instance's `imports`. */
      from: z.string(),
      /** Which output of that instance holds the token value. */
      output: z.string(),
    }),
    /** The full declared record set for the zone. */
    records: z.array(recordSchema).default([]),
    /**
     * Zone-level settings this instance converges. See the header: declared
     * settings are converged, undeclared ones are not read and not reported,
     * and nothing here is ever turned back off.
     */
    settings: settingsSchema,
    /**
     * Perform the deletions this module prints. Defaults to false: undeclared
     * records are always reported, never removed, until an operator opts in.
     */
    allowDelete: z.boolean().default(false),
  })
  .superRefine((config, ctx) => {
    config.records.forEach((record, index) => {
      if ('proxied' in record && record.proxied && record.ttl !== AUTO_TTL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['records', index, 'ttl'],
          message:
            `records[${index}] (${record.type} ${record.name}): a proxied record is always served ` +
            `with Cloudflare's automatic TTL, so an explicit ttl of ${record.ttl} is a lie the API ` +
            `will reject. Drop the ttl, or set proxied: false.`,
        })
      }
    })
  })

// ── Names, contents, and what counts as the same record ───────────────────

/** `@`, `''` and the bare zone all mean the apex; anything else is relative to it. */
export function fqdn(name: string, zone: string): string {
  const trimmed = name.trim().replace(/\.$/, '').toLowerCase()
  const apex = zone.toLowerCase()
  if (trimmed === '' || trimmed === '@' || trimmed === apex) return apex
  if (trimmed.endsWith(`.${apex}`)) return trimmed
  return `${trimmed}.${apex}`
}

/**
 * Comparable form of a record's content. Cloudflare round-trips TXT values
 * with surrounding quotes in some API versions and normalises hostname targets
 * to lowercase without a trailing dot; neither difference is a change.
 */
export function normalizeContent(type: string, content: string): string {
  const value = content.trim()
  if (type === 'TXT') {
    return value.length > 1 && value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value
  }
  if (type === 'CNAME' || type === 'MX' || type === 'NS' || type === 'AAAA') {
    return value.replace(/\.$/, '').toLowerCase()
  }
  return value
}

export interface DesiredRecord {
  type: string
  /** Always an FQDN by the time it gets here. */
  name: string
  content: string
  ttl: number
  proxied?: boolean
  priority?: number
}

export interface ActualRecord extends DesiredRecord {
  id: string
}

export type EmailPurpose = 'SPF' | 'DMARC' | 'DKIM' | 'bounce-MX' | 'routing-MX'

/**
 * Is this one of the records `cloudflare-email` had Cloudflare provision?
 *
 * Structural, not a name list: Cloudflare chooses the DKIM selector labels
 * itself and they differ per domain and per onboarding, so a hardcoded list
 * would protect the domain it was written against and quietly fail to protect
 * the next one. Each rule below names an unambiguous shape:
 *
 *   - a `_domainkey` label anywhere in the name is a DKIM selector, whatever
 *     the record type (Cloudflare has used both TXT and CNAME for it);
 *   - a TXT whose value opens `v=spf1` is an SPF policy — the one record where
 *     a duplicate is worse than a wrong value, because two SPF records make
 *     SPF evaluation fail outright rather than fall back;
 *   - a TXT at a `_dmarc` label, or opening `v=DMARC1`, is the DMARC policy;
 *   - an MX at a `_bounce` label is Email Sending's bounce handler, and an MX
 *     pointing into `mx.cloudflare.net` is Email Routing's inbound path.
 */
export function emailPurpose(record: {
  type: string
  name: string
  content: string
}): EmailPurpose | undefined {
  const labels = record.name.toLowerCase().split('.')
  if (labels.includes('_domainkey')) return 'DKIM'
  if (record.type === 'TXT') {
    const value = normalizeContent('TXT', record.content).toLowerCase()
    if (value.startsWith('v=spf1')) return 'SPF'
    if (value.startsWith('v=dmarc1') || labels[0] === '_dmarc') return 'DMARC'
  }
  if (record.type === 'MX') {
    if (labels[0] === '_bounce') return 'bounce-MX'
    if (normalizeContent('MX', record.content).endsWith('.mx.cloudflare.net')) return 'routing-MX'
  }
  return undefined
}

const PROXIABLE = new Set(['A', 'AAAA', 'CNAME'])

/** Records are grouped by (type, name); several may legitimately share one key. */
const groupKey = (record: { type: string; name: string }) => `${record.type}\0${record.name}`

/** Same value at the same name — the strongest pairing signal available. */
function sameValue(a: DesiredRecord, b: DesiredRecord): boolean {
  return (
    normalizeContent(a.type, a.content) === normalizeContent(b.type, b.content) &&
    (a.priority ?? 0) === (b.priority ?? 0)
  )
}

/** Would applying `desired` over `actual` change anything Cloudflare stores? */
function differs(desired: DesiredRecord, actual: DesiredRecord): boolean {
  if (!sameValue(desired, actual)) return true
  if (desired.ttl !== actual.ttl) return true
  if (PROXIABLE.has(desired.type) && (desired.proxied ?? false) !== (actual.proxied ?? false)) {
    return true
  }
  return false
}

export const describeRecord = (r: DesiredRecord) => `${r.type} ${r.name} -> ${r.content}`

export interface ZonePlan {
  create: DesiredRecord[]
  update: Array<{ actual: ActualRecord; desired: DesiredRecord }>
  unchanged: ActualRecord[]
  /** Present in Cloudflare, declared nowhere. Deleted only with `allowDelete`. */
  undeclared: ActualRecord[]
  /** Present in Cloudflare, owned by cloudflare-email. Never touched. */
  emailProvisioned: Array<{ record: ActualRecord; purpose: EmailPurpose }>
}

/**
 * The whole diff, computed before anything mutates. Pure; exported for tests.
 *
 * Email-provisioned records are settled first (see the block below), then
 * pairing within a (type, name) group is two-pass: identical values pair first,
 * then whatever is left pairs in declaration order. That ordering is what makes
 * a changed value an UPDATE rather than a delete-then-create, and it keeps
 * round-robin sets stable — with two A records at the apex and one of them
 * edited, the untouched one still pairs with itself instead of being rewritten
 * and its neighbour deleted.
 */
export function planZone(input: { desired: DesiredRecord[]; actual: ActualRecord[] }): ZonePlan {
  const create: DesiredRecord[] = []
  const update: ZonePlan['update'] = []
  const unchanged: ActualRecord[] = []

  const emailProvisioned: ZonePlan['emailProvisioned'] = []
  const candidates: ActualRecord[] = []
  for (const record of input.actual) {
    const purpose = emailPurpose(record)
    if (purpose) emailProvisioned.push({ record, purpose })
    else candidates.push(record)
  }

  // A record can look email-provisioned and still be ours — a zone with no
  // cloudflare-email instance behind it may declare its own SPF or DMARC, and
  // once created that record is structurally indistinguishable from one
  // Cloudflare provisioned. So a declared record of some email purpose CLAIMS
  // the record of the same purpose at the same name:
  //
  //   - identical      → unchanged, and the second apply is a clean no-op;
  //   - different      → hard error. Rewriting an SPF/DKIM/DMARC/bounce-MX in
  //                      place is the same harm as deleting it, and a second
  //                      one alongside is worse (two SPF records make SPF
  //                      evaluation fail outright rather than fall back).
  //
  // Anything left in `emailProvisioned` after this pass is claimed by nobody,
  // and is excluded from the pairing pools below — not merely exempted from
  // deletion. Exemption alone would leave it in the pool, where a declared
  // `google-site-verification=…` TXT at the apex could pair against the SPF
  // record and rewrite it.
  const unclaimedDesired: DesiredRecord[] = []
  for (const desired of input.desired) {
    const purpose = emailPurpose(desired)
    const claimIndex = purpose
      ? emailProvisioned.findIndex((e) => e.purpose === purpose && e.record.name === desired.name)
      : -1
    if (claimIndex < 0) {
      unclaimedDesired.push(desired)
      continue
    }
    const [claimed] = emailProvisioned.splice(claimIndex, 1) as [
      { record: ActualRecord; purpose: EmailPurpose },
    ]
    if (differs(desired, claimed.record)) {
      throw new Error(
        `refusing to apply: ${describeRecord(desired)} declares a ${purpose} record where one ` +
          `already exists with a different value (${describeRecord(claimed.record)}). Records of ` +
          `this shape are provisioned server-side by the cloudflare-email module when a domain is ` +
          `onboarded for sending, and rewriting one in place breaks mail exactly as deleting it ` +
          `would — two SPF records do not merge, they fail. Copy the live value into this ` +
          `instance if it is yours to keep, or take the domain off cloudflare-email first.`,
      )
    }
    unchanged.push(claimed.record)
  }

  const pools = new Map<string, ActualRecord[]>()
  for (const record of candidates) {
    const key = groupKey(record)
    const pool = pools.get(key)
    if (pool) pool.push(record)
    else pools.set(key, [record])
  }

  const groups = new Map<string, DesiredRecord[]>()
  for (const record of unclaimedDesired) {
    const key = groupKey(record)
    const group = groups.get(key)
    if (group) group.push(record)
    else groups.set(key, [record])
  }

  for (const [key, group] of groups) {
    const pool = pools.get(key) ?? []
    const pending: DesiredRecord[] = []

    // Pass 1 — identical values pair with themselves, wherever they sit.
    for (const desired of group) {
      const index = pool.findIndex((actual) => sameValue(desired, actual))
      if (index < 0) {
        pending.push(desired)
        continue
      }
      const [actual] = pool.splice(index, 1) as [ActualRecord]
      if (differs(desired, actual)) update.push({ actual, desired })
      else unchanged.push(actual)
    }

    // Pass 2 — what is left is an edit of what is left, in declaration order.
    for (const desired of pending) {
      const actual = pool.shift()
      if (actual) update.push({ actual, desired })
      else create.push(desired)
    }

    pools.set(key, pool)
  }

  const undeclared = [...pools.values()].flat()
  return { create, update, unchanged, undeclared, emailProvisioned }
}

/** One setting as `GET /zones/:id/settings` reports it. */
export interface ActualSetting {
  id: string
  value: unknown
  editable?: boolean
}

export interface SettingsPlan {
  /** Declared, editable, and not what the zone currently holds. */
  change: Array<{ id: string; from: string; to: string }>
  /** Declared and already correct. */
  unchanged: string[]
  /** Declared, present, and the zone says it cannot be written. */
  notEditable: string[]
  /** Declared and absent from the zone's own list of settings. */
  missing: string[]
}

/**
 * What the next apply does to the zone's settings. Pure; exported for tests.
 *
 * The asymmetry with `planZone` is the whole design and is worth stating: a
 * zone carries EVERY setting at all times, so there is no such thing as a
 * setting that is "present and undeclared". Drift, `allowDelete` and the
 * report-then-opt-in dance that records need have no meaning here. What is
 * declared is converged; what is not declared is not read, not reported, and
 * not touched.
 *
 * `notEditable` and `missing` are separated because they are different
 * mistakes with different fixes. A setting Cloudflare reports with
 * `editable: false` is gated on the account's plan. A setting absent from the
 * list is one Cloudflare does not offer under that id at all, and PATCHing it
 * would 404 halfway through a converge. Both refuse, and neither is inferred
 * from a failed write.
 *
 * ⚠️ The value is compared BEFORE `editable` is consulted, and the order is
 * load-bearing. Cloudflare reports the effective value of a plan-gated setting
 * alongside `editable: false`, so a zone that already holds the declared value
 * is converged — there is nothing to write, and refusing would make the whole
 * instance permanently un-appliable (records included) over a no-op. Only a
 * setting that must actually MOVE and cannot is a refusal.
 */
export function planSettings(input: {
  desired: Record<string, string>
  actual: readonly ActualSetting[]
}): SettingsPlan {
  const plan: SettingsPlan = { change: [], unchanged: [], notEditable: [], missing: [] }
  for (const [id, want] of Object.entries(input.desired)) {
    const live = input.actual.find((setting) => setting.id === id)
    if (!live) {
      plan.missing.push(id)
      continue
    }
    const have = String(live.value)
    if (have === want) {
      plan.unchanged.push(id)
      continue
    }
    if (live.editable === false) {
      plan.notEditable.push(id)
      continue
    }
    plan.change.push({ id, from: have, to: want })
  }
  return plan
}

export const describeSettingChange = (c: { id: string; from: string; to: string }) =>
  `${c.id}: ${c.from} => ${c.to}`

// ── Apply ─────────────────────────────────────────────────────────────────

interface CfDnsRecord {
  id: string
  type: string
  name: string
  content: string
  ttl: number
  proxied?: boolean
  priority?: number
}

/**
 * Every record in the zone. Paginated deliberately rather than "one big page":
 * a truncated list reads as "these records are missing" and the next apply
 * happily creates duplicates of them.
 */
async function listRecords(token: string, zoneId: string): Promise<ActualRecord[]> {
  const out: ActualRecord[] = []
  for (let page = 1; page <= 50; page++) {
    const envelope = await cfRaw<CfDnsRecord[]>(
      token,
      'GET',
      `/zones/${zoneId}/dns_records?per_page=100&page=${page}`,
    )
    for (const r of envelope.result) {
      out.push({
        id: r.id,
        type: r.type,
        name: r.name.toLowerCase(),
        content: r.content,
        ttl: r.ttl,
        proxied: r.proxied,
        priority: r.priority,
      })
    }
    const totalPages = envelope.result_info?.total_pages ?? 1
    if (page >= totalPages || envelope.result.length === 0) return out
  }
  throw new Error('refusing to apply: more than 5000 DNS records in the zone — read them by hand')
}

/** The request body Cloudflare wants for one declared record. */
function recordBody(record: DesiredRecord): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl,
  }
  // `proxied` is sent only where it exists as a concept — see the header.
  if (PROXIABLE.has(record.type)) body.proxied = record.proxied ?? false
  if (record.type === 'MX') body.priority = record.priority ?? 0
  return body
}

export const cloudflareZoneModule = defineModule({
  name: 'cloudflare-zone',
  configSchema,
  outputs: z.object({
    zoneId: z.string(),
    zoneName: z.string(),
    /** Cloudflare's assigned nameservers — what the registrar must be pointing at. */
    nameServers: z.array(z.string()),
    created: z.number(),
    updated: z.number(),
    deleted: z.number(),
    /** Records present in Cloudflare that this instance does not declare. */
    undeclared: z.array(z.string()),
    /** Records left alone because cloudflare-email owns them. */
    emailProvisioned: z.array(z.string()),
    /** Settings this apply moved, as `id: from => to`. Empty when none did. */
    settingsChanged: z.array(z.string()),
    changed: z.boolean(),
  }),
  async apply(config, ctx) {
    const token = ctx.output(config.apiToken, 'apiToken')

    // 1. Resolve the zone, and refuse a zone that lives somewhere else.
    const zones = await cf<
      Array<{ id: string; name: string; account?: { id: string }; name_servers?: string[] }>
    >(token, 'GET', `/zones?name=${encodeURIComponent(config.zone)}`)
    const zone = zones.find((z) => z.name.toLowerCase() === config.zone.toLowerCase())
    if (!zone) {
      throw new Error(
        `Zone "${config.zone}" not found — either it is not in this Cloudflare account, or the ` +
          `imported token lacks "Zone Read".`,
      )
    }
    if (zone.account && zone.account.id !== config.accountId) {
      throw new Error(
        `refusing to apply: zone "${config.zone}" lives in Cloudflare account ${zone.account.id}, ` +
          `but this instance declares ${config.accountId}. Each zone belongs to exactly one ` +
          `account; converging the right records into the wrong tenant is not a ` +
          `mistake worth being able to make.`,
      )
    }

    // 2. Diff the whole zone before mutating any of it.
    const desired = config.records.map((record) => ({
      type: record.type,
      name: fqdn(record.name, config.zone),
      content: record.content,
      ttl: record.ttl,
      ...('proxied' in record ? { proxied: record.proxied } : {}),
      ...('priority' in record ? { priority: record.priority } : {}),
    }))
    const actual = await listRecords(token, zone.id)
    const plan = planZone({ desired, actual })

    console.log(
      `  Zone ${config.zone} (${zone.id}): ${desired.length} declared, ${actual.length} present`,
    )
    for (const { record, purpose } of plan.emailProvisioned) {
      console.log(`    · ${describeRecord(record)} — left alone (cloudflare-email ${purpose})`)
    }

    // 3. Plan the settings BEFORE any record is written. A settings refusal
    //    that arrived after half the records had been created would leave the
    //    zone in a state neither the file nor the previous apply describes.
    // `undefined` values are dropped rather than declared. `.partial()` keeps an
    // explicitly-undefined key in zod's output, and an instance written in the
    // environment-conditional style this repo uses elsewhere
    // (`always_use_https: process.env.X ? 'on' : undefined`) would otherwise
    // reach Cloudflare as a PATCH with an empty body — after the records had
    // already been written, which is the one thing the plan-first order exists
    // to prevent.
    const desiredSettings: Record<string, string> = {}
    for (const [id, value] of Object.entries(config.settings)) {
      if (value !== undefined) desiredSettings[id] = value
    }
    let settingsPlan: SettingsPlan = { change: [], unchanged: [], notEditable: [], missing: [] }
    if (Object.keys(desiredSettings).length > 0) {
      const actualSettings = await cf<ActualSetting[]>(token, 'GET', `/zones/${zone.id}/settings`)
      settingsPlan = planSettings({ desired: desiredSettings, actual: actualSettings })
      if (settingsPlan.notEditable.length > 0 || settingsPlan.missing.length > 0) {
        const parts: string[] = []
        if (settingsPlan.notEditable.length > 0) {
          parts.push(
            `${settingsPlan.notEditable.join(', ')} — these must move and the zone reports them ` +
              `as not editable, which on Cloudflare means the setting is gated on the account's ` +
              `plan`,
          )
        }
        if (settingsPlan.missing.length > 0) {
          parts.push(
            `${settingsPlan.missing.join(', ')} — Cloudflare does not offer a setting under ` +
              `these ids on this zone`,
          )
        }
        throw new Error(
          `refusing to apply: zone "${config.zone}" cannot converge every declared setting. ` +
            `${parts.join('; ')}. Nothing was written — not the settings that could be, and not ` +
            `the records — so this zone is exactly as the last apply left it.`,
        )
      }
    }

    // 4. Creates and updates always apply.
    for (const record of plan.create) {
      await cf(token, 'POST', `/zones/${zone.id}/dns_records`, recordBody(record))
      console.log(`    + created ${describeRecord(record)}`)
    }
    for (const { actual: current, desired: wanted } of plan.update) {
      // PATCH, not PUT: a PUT overwrites the record wholesale and would wipe
      // fields this module does not manage (a dashboard comment, tags).
      await cf(token, 'PATCH', `/zones/${zone.id}/dns_records/${current.id}`, recordBody(wanted))
      console.log(`    ~ updated ${describeRecord(current)} => ${describeRecord(wanted)}`)
    }

    // 5. Deletions are printed always, performed only on opt-in.
    let deleted = 0
    for (const record of plan.undeclared) {
      if (config.allowDelete) {
        await cf(token, 'DELETE', `/zones/${zone.id}/dns_records/${record.id}`)
        deleted++
        console.log(`    - deleted ${describeRecord(record)} (undeclared)`)
      } else {
        console.log(
          `    ! drift: ${describeRecord(record)} exists in Cloudflare and is declared nowhere ` +
            `— set allowDelete: true on this instance to remove it`,
        )
      }
    }

    // 6. Settings last: a record that does not resolve yet is a smaller
    //    problem than a zone whose HTTPS posture moved and whose records did
    //    not, and only this order can fail before both.
    for (const change of settingsPlan.change) {
      await cf(token, 'PATCH', `/zones/${zone.id}/settings/${change.id}`, { value: change.to })
      console.log(`    ~ setting ${describeSettingChange(change)}`)
    }
    for (const id of settingsPlan.unchanged) {
      console.log(`    · setting ${id} already ${desiredSettings[id]}`)
    }

    const changed =
      plan.create.length + plan.update.length + deleted + settingsPlan.change.length > 0
    if (!changed && plan.undeclared.length === 0) {
      console.log(`    = no changes`)
    }

    return {
      zoneId: zone.id,
      zoneName: zone.name,
      nameServers: zone.name_servers ?? [],
      created: plan.create.length,
      updated: plan.update.length,
      deleted,
      undeclared: plan.undeclared.map(describeRecord),
      settingsChanged: settingsPlan.change.map(describeSettingChange),
      emailProvisioned: plan.emailProvisioned.map(
        ({ record, purpose }) => `${describeRecord(record)} (${purpose})`,
      ),
      changed,
    }
  },
})
