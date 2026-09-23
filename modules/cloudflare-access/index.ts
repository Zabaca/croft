import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import { cf } from '../cloudflare-api'

// cloudflare-access — a Zero Trust application and the list of principals that
// may reach it, as repo state instead of dashboard state.
//
// What this exists for: `cloudflare-tunnel` puts a hostname on the internet,
// and a tunnel with no policy in front of it is an open door. Declaring the two
// together means "add the route and secure it after" is not a sequence anybody
// has to be trusted to finish.
//
// ── TWO KINDS OF PRINCIPAL, AND THEY DO NOT SHARE A POLICY ────────────────
// A person is admitted by their address, on a policy whose decision is `allow`.
// A machine is admitted by a service token, on a policy whose decision is
// `non_identity` — Service Auth in the dashboard. The two are NOT
// interchangeable: an `allow` policy demands an identity, so a service token on
// one is admitted by nothing while the policy looks perfectly configured, and
// an address on a `non_identity` policy is the mirror of that.
//
// So each declared policy is compared against its OWN idea of a match, and this
// is the property most easily lost by a later edit. Declaring a service-token
// policy makes a non-address rule a legitimate thing for SOME policy to carry,
// and the cheap way to permit that is to loosen the check for all of them —
// which would let an `everyone` rule sit beside the addresses on the people
// policy and read as unchanged. `planPolicies` is the seam that keeps it, and
// `index.test.ts` fails if anybody widens it.
//
// ── THE ORGANISATION IS NOT SCOPED TO THIS APPLICATION ────────────────────
// `teamDomain`, `orgName` and `identityProviders` are properties of the whole
// Zero Trust organisation, not of the application this instance declares. An
// instance pointed at an account converges the provider set behind EVERY
// application in it. That is why undeclared providers are reported and never
// removed, and why `identityProviders` defaults to empty: an instance that says
// nothing about providers converges nothing about them, so adding this module
// to an account cannot disturb it by omission.
//
// ── `auth_domain` IS COMPARED AND NEVER CHOSEN ───────────────────────────
// A consumer's Worker derives the issuer it verifies every assertion against
// from the team domain. An apply that could CHOOSE that value would turn the
// guard into the exact failure the guard exists to catch: edit the file, apply,
// and the issuer plus every live session break at once while the apply reports
// success. So the live value is compared first and only ever echoed back.
// `orgName` is cosmetic, and is the only organisation field this module decides.
//
// ── Deletion is opt-in, and here that is a sharper trade than usual ───────
// `allowDelete` defaults to false, matching cloudflare-zone. The asymmetry
// worth stating: an undeclared DNS record is inert, and an undeclared ALLOW
// policy on this application is an open door somebody added by hand. So an
// extra policy is reported at the top of its voice and counted into the
// outputs, and removing it is still a deliberate second edit rather than
// something a converge loop does on sight.
//
// ── The service token secret is NOT rolled on every apply ─────────────────
// `cloudflare-token` rolls its value every apply and persists nothing, which is
// the better discipline — a minted value that lives only in memory cannot go
// stale in a file somewhere. That does NOT work here, and the asymmetry looks
// like an oversight otherwise. A Cloudflare API token's consumer is this apply.
// An Access service token's consumer is somebody ELSE, deployed from a
// different repo on a different cadence, so rolling on every apply would
// invalidate the credential that consumer holds and take it down until it was
// redeployed. So: created once, thereafter REUSED, never rotated. `rotate: true`
// is the deliberate escape hatch for the day it leaks.
//
// There is deliberately no `destroy`. Destroying an Access application does not
// tidy anything up, it takes the lock off the door.

// ── Schema ────────────────────────────────────────────────────────────────

/** `<team>.cloudflareaccess.com`, bare. An issuer is derived from it. */
const TEAM_DOMAIN = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/

const configSchema = z
  .object({
    /** Cloudflare account id. Instance config, never a constant. */
    accountId: z.string(),
    /**
     * Where the credential comes from: `{ from, output }` into an imported
     * instance's outputs, normally a `cloudflare-token` instance's
     * `tokenValue`. Not a secrets.yaml key, so nothing that can edit who
     * reaches this application comes to rest in the consuming repo.
     *
     * Needs "Access: Apps and Policies Write", plus "Access: Service Tokens
     * Write" if `serviceTokenName` is declared, and "Access: Organizations" /
     * "Access: Identity Providers" for the organisation-level fields.
     */
    apiToken: z.object({ from: z.string(), output: z.string() }),
    /**
     * The Zero Trust team domain, bare, with no scheme and no path.
     *
     * OPTIONAL, and that is a deliberate widening over the module this was
     * promoted from. Where a Worker verifies an Access assertion, this is the
     * one value its issuer and JWKS URL are both derived from and it must be
     * declared. A machine-only application verifies nothing and derives
     * nothing, so requiring the field there would make a consumer write down a
     * value that plays no part — and a value nobody uses is a value nobody
     * keeps right.
     *
     * When declared it is COMPARED against the live organisation and never
     * written. See the header.
     */
    teamDomain: z
      .string()
      .regex(TEAM_DOMAIN, 'must be <team>.cloudflareaccess.com, bare')
      .optional(),
    /**
     * What the organisation is CALLED. A different field from `teamDomain`, on
     * the same endpoint, treated the opposite way: this one is the only
     * organisation field this module decides.
     *
     * Cloudflare seeds it with a generated name like
     * `plain-brook-fb33.cloudflareaccess.com`, and it is the string on the
     * sign-in screen, so on a customer-facing application the customer reads
     * it. Optional: an organisation whose name nobody reads is not worth a
     * required field, and omitting it leaves the name alone rather than
     * clearing it.
     */
    orgName: z.string().min(1).optional(),
    /**
     * The identity providers the ORGANISATION must offer. HOW people
     * authenticate, as against WHICH people the policies then admit.
     *
     * WHY THIS BELONGS HERE. An instance's claim is to be the list of who may
     * sign in, and that claim is false while the provider set lives only in the
     * dashboard: an application whose policy names exactly the right people
     * admits nobody if the organisation offers those people no way to
     * authenticate.
     *
     * ONLY `onetimepin`, deliberately. It is the one provider that takes no
     * configuration at all: Cloudflare emails a code and there is nothing to
     * store. Any real SSO provider needs a client id and a secret, which is a
     * credential at rest, which is a different module and a different argument.
     *
     * Undeclared providers are REPORTED, never removed. Not laziness: the
     * `cloudflare` provider beside this one is how an operator signs in, and a
     * converge loop that removed it on sight would lock out the person running
     * the apply — across every application in the account, not just this one.
     */
    identityProviders: z.array(z.enum(['onetimepin'])).default([]),
    /** The application's display name in the dashboard. */
    name: z.string().min(1),
    /**
     * What the application covers: `host/path`, with no scheme.
     *
     * Written down to the path deliberately. `example.com` without `/admin`
     * puts a sign-in wall in front of every public page the host serves.
     */
    domain: z.string().min(1),
    /**
     * Who may sign in. Lowercased and de-duplicated so the diff is about people
     * rather than about capitalisation.
     *
     * Empty means NO people policy is declared at all — not an empty one, which
     * would be a policy admitting nobody sitting on the application waiting for
     * somebody to fill it in. An application that then has one anyway is drift
     * and is reported.
     */
    emails: z
      .array(z.string().trim().toLowerCase().email())
      .default([])
      .transform((emails) => Array.from(new Set(emails)).sort()),
    /**
     * How long a sign-in lasts before Cloudflare asks again.
     *
     * `24h` for a person. A machine caller should say `0s`, which means every
     * request is evaluated and no cookie is ever issued: it presents its token
     * on each request anyway, and a cookie would let a leaked one outlive the
     * token. `0s` was the DEFAULT in the module this replaces, which is right
     * for a machine and is a fresh one-time-PIN email per navigation for a
     * person.
     */
    sessionDuration: z.string().default('24h'),
    /** The people policy this module owns, by name. Anything else on the app is drift. */
    policyName: z.string().min(1).default('allowed people'),
    /**
     * Service tokens minted ELSEWHERE that may reach this application without a
     * person. `{ from, output }` into an imported instance's outputs.
     *
     * A reference rather than a literal id for the same reason `apiToken` is
     * one: the id does not exist until the token is minted, and a hand-copied
     * one goes stale silently the first time the token is recreated.
     */
    serviceTokens: z.array(z.object({ from: z.string(), output: z.string() })).default([]),
    /**
     * A service token this module MINTS and owns, by name.
     *
     * Kept from the module this replaces, where it was required. Cloudflare
     * returns a service token's secret exactly once, at creation, so the apply
     * that creates it prints the pair and that is the only chance to capture it.
     */
    serviceTokenName: z.string().min(1).optional(),
    /**
     * Mint a NEW secret for the existing `serviceTokenName`. Off by default:
     * the consumer is separately deployed, and rotating without redeploying it
     * takes that consumer down. See the header.
     */
    rotate: z.boolean().default(false),
    /**
     * The Service Auth policy this module owns, by name.
     *
     * Defaulted rather than required, and the default is computed — see
     * `serviceTokenPolicyNameFor`. A minted token names its own policy exactly
     * as the module this replaces did, so a consumer migrating finds its
     * existing policy and converges it instead of creating a second one beside
     * it and reporting the first as drift.
     */
    serviceTokenPolicyName: z.string().min(1).optional(),
    /** Whether the application shows as a tile in the App Launcher. */
    /**
     * Whether the application shows as a tile in the App Launcher.
     *
     * DEFAULTS TO TRUE, which is Cloudflare's own default and therefore what
     * omitting the field has always meant. A PUT is a full replace, so "omit
     * it" and "send the default" are the same act and there is no third option
     * — which is why defaulting it to `false` (as this did until 2026-08-23)
     * made the first apply of every migrating consumer a change to live state.
     * An instance that wants the tile hidden says so.
     */
    appLauncherVisible: z.boolean().default(true),
    /**
     * Cloudflare's binding cookie. Off, matching Cloudflare's own default and
     * the module this replaces: a machine caller should never be handed one.
     */
    enableBindingCookie: z.boolean().default(false),
    /** `HttpOnly` on the Access cookie. On, matching Cloudflare's own default. */
    httpOnlyCookieAttribute: z.boolean().default(true),
    /**
     * Perform the deletions this module prints. False by default: an undeclared
     * policy is always reported, never removed, until an operator has read the
     * line and opted in.
     */
    allowDelete: z.boolean().default(false),
  })
  .superRefine((config, ctx) => {
    // An application with neither a person nor a machine on it is one nobody
    // can reach, and it should be deleted rather than emptied. The generalised
    // form of "refuse an empty allow list": emails are no longer the only kind
    // of principal, so the rule is about the union.
    if (
      config.emails.length === 0 &&
      config.serviceTokens.length === 0 &&
      config.serviceTokenName === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['emails'],
        message:
          'this application declares no way in — no emails, no serviceTokens and no ' +
          'serviceTokenName. An application nobody can reach should be deleted rather than ' +
          'emptied; declare a principal or remove the instance.',
      })
    }

    // The rename PUT must carry `auth_domain` (Cloudflare has no PATCH for the
    // resource), and what makes echoing it safe is that the value has already
    // been compared against a declared one. With nothing declared there is
    // nothing to compare, so the write would be CHOOSING the issuer — the exact
    // failure the comparison exists to prevent.
    if (config.orgName !== undefined && config.teamDomain === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orgName'],
        message:
          'orgName requires teamDomain: renaming the organisation is a full replace that must ' +
          'echo auth_domain, and echoing a value nothing has compared is choosing the issuer.',
      })
    }

    if (config.rotate && config.serviceTokenName === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rotate'],
        message:
          'rotate: true has nothing to rotate — this module only owns the token named by ' +
          'serviceTokenName. A token reached through serviceTokens is rotated where it is minted.',
      })
    }
  })

// ── The diff, which is pure and is where the thinking is ──────────────────

/** One `include` rule as Cloudflare stores it. */
export type IncludeRule = Record<string, unknown>

export interface AccessPolicy {
  id: string
  name: string
  decision: string
  include: IncludeRule[]
  exclude?: IncludeRule[]
  require?: IncludeRule[]
  /** Absent on a policy that inherits the application's. */
  session_duration?: string
}

/** The `include` list for a set of addresses. One rule per person. */
export function emailIncludes(emails: readonly string[]): Array<{ email: { email: string } }> {
  return emails.map((email) => ({ email: { email } }))
}

/**
 * The addresses a live policy admits, or NULL if it admits anything else.
 *
 * Null is the important half. An `include` list is a set of OR'd rules, so one
 * `{ everyone: {} }`, one `{ ip: … }` or one `{ email_domain: … }` beside the
 * addresses widens the policy to people nobody named, and it does it without
 * changing a single address. Returning null makes any such policy differ from
 * what is declared, so it is REWRITTEN rather than read as a match.
 *
 * That is a real failure mode and not a hypothetical: "let me just add everyone
 * for a minute to test something" is one click in the dashboard, and it leaves
 * a policy whose email list still looks exactly right.
 */
export function policyEmails(policy: Pick<AccessPolicy, 'include'>): string[] | null {
  const emails: string[] = []
  for (const rule of policy.include ?? []) {
    const keys = Object.keys(rule)
    if (keys.length !== 1 || keys[0] !== 'email') return null
    const value = (rule as { email?: { email?: unknown } }).email?.email
    if (typeof value !== 'string' || value.trim() === '') return null
    emails.push(value.trim().toLowerCase())
  }
  return Array.from(new Set(emails)).toSorted()
}

/** The `include` list for a set of service tokens. One rule per token. */
export function serviceTokenIncludes(
  tokenIds: readonly string[],
): Array<{ service_token: { token_id: string } }> {
  return tokenIds.map((token_id) => ({ service_token: { token_id } }))
}

/**
 * The service tokens a live policy admits, or NULL if it admits anything else.
 *
 * The exact counterpart of `policyEmails`, and it exists for exactly the same
 * reason: an `include` list is OR'd, so one extra rule beside the token widens
 * the policy without changing a single declared value.
 *
 * ⚠️ THE RULE THIS EXISTS TO CATCH IS `any_valid_service_token`. It is one
 * click in the dashboard, it reads like a small convenience, and it admits
 * EVERY service token in the account, including one somebody minted for
 * something else entirely. It is not the declared token id and never matches,
 * so a policy carrying it is rewritten.
 */
export function policyServiceTokens(policy: Pick<AccessPolicy, 'include'>): string[] | null {
  const tokens: string[] = []
  for (const rule of policy.include ?? []) {
    const keys = Object.keys(rule)
    if (keys.length !== 1 || keys[0] !== 'service_token') return null
    const value = (rule as { service_token?: { token_id?: unknown } }).service_token?.token_id
    if (typeof value !== 'string' || value.trim() === '') return null
    tokens.push(value.trim())
  }
  return Array.from(new Set(tokens)).toSorted()
}

/**
 * One policy this instance declares, and the whole of what it admits.
 *
 * TWO KINDS, and the difference between them is precisely the thing that must
 * not be blurred. A policy of addresses is `allow` and admits people by their
 * address, and a rule of any other shape on it is a hole. A policy of service
 * tokens is Service Auth and admits named tokens, and a rule of any other shape
 * on IT is a hole too. Each is checked against its own idea of a match, so
 * declaring the second could not loosen the first.
 */
export type DeclaredPolicy =
  | {
      name: string
      admits: 'emails'
      emails: readonly string[]
      sessionDuration?: string
    }
  | {
      name: string
      admits: 'service-tokens'
      tokenIds: readonly string[]
      sessionDuration?: string
    }

/**
 * What Cloudflare calls the action, per kind.
 *
 * `non_identity` is Service Auth in the dashboard, and it is not
 * interchangeable with `allow`: an allow policy demands an identity, so a
 * service token on one is admitted by nothing while the policy looks perfectly
 * configured. That is a failure with no visible cause, which is why the
 * decision is part of what is compared rather than something set once at
 * creation.
 */
export function decisionFor(declared: DeclaredPolicy): 'allow' | 'non_identity' {
  return declared.admits === 'emails' ? 'allow' : 'non_identity'
}

/** The `include` list a declared policy should carry. */
export function includesFor(declared: DeclaredPolicy): IncludeRule[] {
  return declared.admits === 'emails'
    ? emailIncludes(declared.emails)
    : serviceTokenIncludes(declared.tokenIds)
}

/**
 * The whole body written for a declared policy. Pure; exported for tests.
 *
 * `exclude` and `require` are sent EMPTY rather than omitted, because a PUT is
 * a full replace and an omitted field would leave whatever somebody added by
 * hand in place. A narrowing rule is not a hole, but a policy that silently
 * requires something nobody wrote down locks the right principal out with no
 * visible cause.
 */
export function policyBodyFor(declared: DeclaredPolicy): Record<string, unknown> {
  return {
    name: declared.name,
    decision: decisionFor(declared),
    include: includesFor(declared),
    exclude: [],
    require: [],
    ...(declared.sessionDuration === undefined
      ? {}
      : { session_duration: declared.sessionDuration }),
  }
}

/** What a declared policy admits, in words, for the apply log. */
function admits(entry: DeclaredPolicy): string {
  return entry.admits === 'emails' ? entry.emails.join(', ') : entry.tokenIds.join(', ')
}

export interface PolicyPlan {
  /** The declaration this plan is for. */
  declared: DeclaredPolicy
  action: 'create' | 'update' | 'unchanged'
  /** The live policy of that name, once it has been found. */
  mine?: AccessPolicy
  /** Why an update is needed, in words, for the apply log. */
  reason?: string
}

export interface PoliciesPlan {
  /** One plan per declared policy, in the order they were declared. */
  plans: PolicyPlan[]
  /** Every other policy on the application. Each one can let somebody in. */
  undeclared: AccessPolicy[]
}

/**
 * What to do with the application's policies. Pure; exported for tests.
 *
 * Each declared policy is found by NAME, and everything else on the application
 * is undeclared, whatever it is called and whichever way it decides.
 */
export function planPolicies(input: {
  declared: readonly DeclaredPolicy[]
  actual: AccessPolicy[]
}): PoliciesPlan {
  const claimed = new Set<AccessPolicy>()

  const plans = input.declared.map((declared): PolicyPlan => {
    const mine = input.actual.find(
      (policy) => policy.name === declared.name && !claimed.has(policy),
    )
    if (mine) claimed.add(mine)
    return planOne(declared, mine)
  })

  return { plans, undeclared: input.actual.filter((policy) => !claimed.has(policy)) }
}

function planOne(declared: DeclaredPolicy, mine: AccessPolicy | undefined): PolicyPlan {
  if (!mine) return { declared, action: 'create' }

  const decision = decisionFor(declared)
  if (mine.decision !== decision) {
    return {
      declared,
      action: 'update',
      mine,
      reason: `decision is "${mine.decision}" and should be "${decision}"`,
    }
  }

  // Each kind is read by its OWN reader, and each returns null the moment the
  // policy admits by anything else. That is what keeps "an everyone rule beside
  // the addresses is rewritten" true after a policy that admits by something
  // other than an address became a legitimate thing to declare.
  const current = declared.admits === 'emails' ? policyEmails(mine) : policyServiceTokens(mine)

  if (current === null) {
    return {
      declared,
      action: 'update',
      mine,
      reason:
        declared.admits === 'emails'
          ? 'it admits people by something other than their address'
          : 'it admits by something other than the declared service tokens',
    }
  }

  const wanted = (declared.admits === 'emails' ? declared.emails : declared.tokenIds).toSorted()
  if (current.join(',') !== wanted.join(',')) {
    return {
      declared,
      action: 'update',
      mine,
      reason: `admits ${current.join(', ') || '(nobody)'}`,
    }
  }

  // A narrowing rule is not a hole, but it is undeclared, and a policy that
  // silently requires something nobody wrote down is a policy that locks the
  // right principal out for no visible reason.
  if ((mine.exclude ?? []).length > 0 || (mine.require ?? []).length > 0) {
    return { declared, action: 'update', mine, reason: 'it carries exclude or require rules' }
  }

  // The cookie's lifetime is part of what the policy decides: a policy that
  // admits exactly the right people for a week when the file says an hour is
  // drift no address comparison can see.
  //
  // KNOWN LIMIT, stated rather than left to be discovered. Cloudflare OMITS the
  // field on a policy that inherits the application's, and an absent field is
  // read here as "not drift" — so a policy that has been reset to inherit is
  // indistinguishable from one that never declared a duration. Reading the
  // absence as a mismatch is the worse trade: it makes every apply a rewrite,
  // and a converge that always writes is one whose drift lines nobody reads.
  const live = mine.session_duration
  if (
    declared.sessionDuration !== undefined &&
    typeof live === 'string' &&
    live !== '' &&
    live !== declared.sessionDuration
  ) {
    return {
      declared,
      action: 'update',
      mine,
      reason: `its session lasts "${live}" and should last "${declared.sessionDuration}"`,
    }
  }

  return { declared, action: 'unchanged', mine }
}

/** One identity provider on the organisation, as Cloudflare stores it. */
export interface IdentityProvider {
  id: string
  /** `onetimepin`, `cloudflare`, `google`, and so on. The match key. */
  type: string
  name?: string
}

export interface IdentityProvidersPlan {
  /** Declared types the organisation does not offer yet. */
  create: string[]
  /** Declared types already there, so nothing is created twice. */
  present: IdentityProvider[]
  /** Everything else. Reported, never removed. */
  undeclared: IdentityProvider[]
}

/**
 * What the next apply does to the ORGANISATION's identity providers. Pure;
 * exported for tests.
 *
 * MATCHED BY TYPE, not by name. `onetimepin` carries no name at all
 * (Cloudflare returns `""`), so a name match would create a second one on every
 * apply forever. The question this answers is whether the organisation offers a
 * way in, not how many copies of it there are.
 *
 * Declaring nothing plans nothing and still reports everything, so an
 * organisation whose providers nobody has declared is described rather than
 * emptied. That is what makes this field safe to point at a shared account.
 */
export function planIdentityProviders(input: {
  declared: readonly string[]
  actual: readonly IdentityProvider[]
}): IdentityProvidersPlan {
  const declared = Array.from(new Set(input.declared))
  const has = (type: string) => input.actual.some((provider) => provider.type === type)
  return {
    create: declared.filter((type) => !has(type)),
    present: input.actual.filter((provider) => declared.includes(provider.type)),
    undeclared: input.actual.filter((provider) => !declared.includes(provider.type)),
  }
}

/**
 * What to call a provider this module creates. Cloudflare shows the name in the
 * dashboard and on the sign-in screen when more than one provider exists, so it
 * is worth being the same string a person would have typed.
 */
const IDENTITY_PROVIDER_NAMES: Record<string, string> = {
  onetimepin: 'One-time PIN',
}

/** `https://host/path/` and `host/path` are the same application. */
export function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
}

/**
 * What the Service Auth policy is called. Pure; exported for tests.
 *
 * The default is computed rather than constant, and that is a migration
 * decision rather than a stylistic one. The module this replaces named its
 * policy `"<serviceTokenName> service token"`, so a consumer moving to this one
 * finds its existing policy under the same name and converges it. A constant
 * default would create a second policy beside the live one and report the live
 * one as drift — on the application it is currently the only way into.
 */
export function serviceTokenPolicyNameFor(config: {
  serviceTokenName?: string
  serviceTokenPolicyName?: string
}): string {
  if (config.serviceTokenPolicyName !== undefined) return config.serviceTokenPolicyName
  if (config.serviceTokenName !== undefined) return `${config.serviceTokenName} service token`
  return 'service tokens'
}

/** The application body. Pure; exported for tests. `domain` is already normalized. */
export function appBody(config: {
  name: string
  domain: string
  sessionDuration: string
  appLauncherVisible: boolean
  enableBindingCookie: boolean
  httpOnlyCookieAttribute: boolean
}): Record<string, unknown> {
  return {
    name: config.name,
    domain: config.domain,
    type: 'self_hosted',
    session_duration: config.sessionDuration,
    app_launcher_visible: config.appLauncherVisible,
    enable_binding_cookie: config.enableBindingCookie,
    http_only_cookie_attribute: config.httpOnlyCookieAttribute,
  }
}

/**
 * Which fields of the body disagree with the live application. Pure; exported
 * for tests.
 *
 * ⚠️ EVERY KEY THE BODY CARRIES, and that is the whole point rather than a
 * detail. Until 2026-08-23 this comparison was three hand-listed fields — name,
 * domain, session duration — defended by a comment arguing that the module
 * "declares more of the application than it can read back reliably", so a
 * re-apply "reports honestly without silently accepting drift in a field nobody
 * looked at".
 *
 * That rationale is sound and it covers the wrong case. It defends not
 * comparing a field THE DASHBOARD might have changed. It says nothing about a
 * field THIS MODULE writes from its own default on every single apply — which
 * is not drift being accepted, it is a change being made and not reported. A
 * correct-sounding rationale covering the wrong case is harder to spot than no
 * rationale, and this one hid `app_launcher_visible` flipping a live
 * application while the apply printed `unchanged`.
 *
 * So the answer to "compare it or stop writing it" is COMPARE IT, and the
 * comparison is derived from the body rather than listed beside it: add a field
 * to `appBody` and it is compared, with no second place to remember.
 */
export function appDiffers(
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
): string[] {
  return Object.keys(desired).filter((key) => {
    const want = desired[key]
    const have = live[key]
    // The one field with an identity of its own: `https://Host/` and `host`
    // are the same application, and reading them as different would make every
    // apply a change.
    if (key === 'domain') {
      return normalizeDomain(String(want)) !== normalizeDomain(String(have ?? ''))
    }
    return JSON.stringify(want) !== JSON.stringify(have)
  })
}

/**
 * What the summary line says a person may sign in with. Pure; exported for
 * tests.
 *
 * DECLARED AND UNDECLARED BOTH, because the question this answers is "can a
 * person sign in", not "what did this instance declare". Reporting only the
 * declared set meant that an instance declaring none — the recommended
 * configuration when the organisation already offers what is needed, since
 * declaring one converges nothing and needs write access over state every other
 * application in the account shares — printed "nobody can sign in" three lines
 * under its own report that two providers were offered and kept.
 *
 * The empty case still says nobody can, and that half is not incidental: an
 * organisation really offering nothing must not be reassured by a fix aimed at
 * a false alarm.
 */
export function signInWith(providers: {
  declared: readonly string[]
  undeclared: readonly string[]
}): string {
  const all = [...providers.declared, ...providers.undeclared]
  return all.length > 0 ? all.join(', ') : '(nothing, so nobody can sign in)'
}

/**
 * The application this instance converges, and how it was recognised.
 *
 * TWO RULES, IN ORDER, and each is here because of a failure the other does not
 * catch. The DOMAIN is tried first: two applications on one hostname and path
 * is a configuration nobody can reason about, and creating the second one is
 * how it happens. The NAME is tried second: without it, editing `domain` in the
 * instance file would leave the live application standing with the old
 * hostname, unowned by anything, and build a second one beside it.
 *
 * Pure; exported for tests.
 */
export function findApp<T extends { id: string; name: string; domain: string }>(
  apps: readonly T[],
  want: { name: string; domain: string },
): { app: T; by: 'domain' | 'name' } | undefined {
  const byDomain = apps.find((app) => normalizeDomain(app.domain) === want.domain)
  if (byDomain) return { app: byDomain, by: 'domain' }
  const byName = apps.find((app) => app.name === want.name)
  return byName ? { app: byName, by: 'name' } : undefined
}

// ── Apply ─────────────────────────────────────────────────────────────────

/** The Zero Trust organisation. Two fields, deliberately handled apart. */
interface CfOrg {
  /** The issuer, and never written by this module. */
  auth_domain?: string
  /** The display name, and converged when `orgName` is declared. */
  name?: string
}

interface CfApp {
  id: string
  /** The audience tag: 64 hex characters, and what a verifying Worker checks. */
  aud?: string
  name: string
  domain: string
  type?: string
  session_duration?: string
}

interface ServiceToken {
  id: string
  name: string
  client_id: string
  client_secret?: string
}

/**
 * Surface a freshly-minted pair the moment it exists.
 *
 * Cloudflare returns a service token's secret exactly once, at creation. The
 * first version of this printed it at the END of apply, after the app and
 * policy were converged — and the very first real apply 403'd on the app, so
 * the secret was minted, never shown, and unrecoverable except by rotating.
 * Anything that can fail between minting a write-once value and showing it is a
 * chance to lose it, so nothing goes between.
 */
function announce(clientId: string, clientSecret: string): void {
  console.log(`\n  ── capture these now; the secret is never shown again ──`)
  console.log(`  CF_ACCESS_CLIENT_ID=${clientId}`)
  console.log(`  CF_ACCESS_CLIENT_SECRET=${clientSecret}\n`)
}

export const cloudflareAccessModule = defineModule({
  name: 'cloudflare-access',
  configSchema,
  outputs: z.object({
    appId: z.string(),
    /**
     * The application's audience tag, for a Worker that verifies assertions.
     * Empty when Cloudflare did not return one.
     */
    aud: z.string(),
    /** Passed on so a Worker derives its issuer and JWKS URL from one value. */
    teamDomain: z.string(),
    /** What the organisation is called after this apply. Cosmetic. */
    orgName: z.string(),
    /** How a person may authenticate after this apply. Empty means nobody can. */
    identityProviders: z.array(z.string()),
    /** Providers the organisation offers that nothing here declares. */
    undeclaredIdentityProviders: z.array(z.string()),
    appDomain: z.string(),
    /** Who the people policy admits, after this apply. */
    emails: z.array(z.string()),
    /** The people policy's id, or empty when no people are declared. */
    policyId: z.string(),
    /** Every policy this instance declares, by id, people first. */
    policyIds: z.array(z.string()),
    /** Every service token admitted without a person: referenced and minted. */
    serviceTokenIds: z.array(z.string()),
    /** The token this module MINTS, if one is declared. Empty otherwise. */
    serviceTokenId: z.string(),
    /** Safe to output — the id is not a secret. */
    clientId: z.string(),
    /** Only non-empty on the apply that CREATED or rotated the minted token. */
    clientSecret: z.string(),
    /** Whether the minted service token was created by this apply. */
    created: z.boolean(),
    /** Whether the application was created by this apply. */
    appCreated: z.boolean(),
    /** Policies on this application that nothing here declares, after this apply. */
    undeclared: z.array(z.string()),
    changed: z.boolean(),
  }),
  async apply(config, ctx) {
    const token = ctx.output(config.apiToken, 'apiToken')
    const account = `/accounts/${config.accountId}`
    const domain = normalizeDomain(config.domain)

    // Resolved before anything is called, so a service token instance that is
    // not imported fails while nothing has been touched.
    const referencedTokenIds = config.serviceTokens.map((ref, index) =>
      ctx.output(ref, `serviceTokens[${index}]`),
    )

    // 1. The organisation. Two fields off one endpoint, treated in OPPOSITE
    //    ways, and the asymmetry is the whole of this step.
    //
    //    `auth_domain` is COMPARED FIRST and only ever ECHOED BACK. A consumer
    //    Worker derives the issuer it verifies every assertion against from
    //    that string, so a rename in the dashboard that nobody wrote down here
    //    is a silent lockout and this is the only place it can be caught. The
    //    rename below cannot omit the field, because Cloudflare has no PATCH
    //    for this resource and refuses a partial write; what makes that safe is
    //    that the comparison has already thrown unless the value being echoed
    //    is the one live on the account.
    //
    //    Reading needs a scope this module can otherwise live without, so a
    //    failure to READ is a warning and the guard is skipped. A failure to
    //    WRITE is not a warning: somebody asked for that rename in a file.
    let orgName = ''
    let orgRenamed = false
    try {
      const org = await cf<CfOrg>(token, 'GET', `${account}/access/organizations`)
      const live = (org.auth_domain ?? '').trim()
      const normalized = live.toLowerCase()
      if (config.teamDomain === undefined) {
        console.log(
          `  Zero Trust organisation: ${normalized || '(no team domain)'} — this instance ` +
            `declares no teamDomain, so nothing is compared. Declare it if anything verifies ` +
            `an Access assertion issued by this organisation.`,
        )
      } else if (normalized !== '' && normalized !== config.teamDomain) {
        throw new Error(
          `refusing to apply: this instance declares teamDomain "${config.teamDomain}", but the ` +
            `Zero Trust organisation on account ${config.accountId} answers "${normalized}". A ` +
            `Worker derives the issuer it verifies every assertion against from that value, so ` +
            `applying over this would leave an application nobody can reach and nothing saying ` +
            `why. Somebody renamed the team: put the new name in this file.`,
        )
      } else {
        console.log(`  Zero Trust organisation: ${normalized} (matches this instance)`)
      }
      orgName = (org.name ?? '').trim()

      if (config.orgName !== undefined && orgName !== config.orgName) {
        // ⚠️ THE WRITE HAS TO CARRY `auth_domain`, and this is the one place in
        // this module where that is true. Measured on a live account on
        // 2026-08-18: `PUT /access/organizations` with `{name}` alone is
        // refused with `11004 access.api.error.invalid_auth_domain`. There is
        // no PATCH for this resource, so the update is a full replace and the
        // field cannot be left out.
        //
        // What keeps the guarantee is the ORDER, not the omission. The check
        // above has already run and has already thrown unless the live
        // `auth_domain` equals the declared `teamDomain`, so what goes back is
        // the value that was just read and verified. The apply can therefore
        // ECHO the team domain and can never CHANGE it, which is the property
        // the guard exists to hold. Read `live` here as "the verified value",
        // and never replace it with `config.teamDomain`: they are equal by the
        // time this line runs, and only one of them is a fact about the account
        // rather than a hope from a file.
        if (live === '') {
          throw new Error(
            `refusing to apply: this organisation reports no auth_domain, so renaming it would ` +
              `have to invent one, and a Worker's issuer is derived from that value. Set the ` +
              `team domain in the dashboard first, then apply.`,
          )
        }
        const was = orgName === '' ? '(unnamed)' : orgName
        await cf<CfOrg>(token, 'PUT', `${account}/access/organizations`, {
          name: config.orgName,
          auth_domain: live,
        })

        // Read it back with a FRESH GET rather than trusting the response to
        // the write. `name` and `auth_domain` are two fields on one object and
        // "does renaming the organisation move the team domain too" is not a
        // question to settle by assumption on an application somebody is signed
        // in to. If it ever does move, this is a hard error naming both values,
        // because the application is unreachable from that moment and no later
        // step would notice.
        const after = await cf<CfOrg>(token, 'GET', `${account}/access/organizations`)
        const domainAfter = (after.auth_domain ?? '').trim().toLowerCase()
        if (domainAfter !== '' && domainAfter !== config.teamDomain) {
          throw new Error(
            `refusing to apply: renaming the organisation to "${config.orgName}" also moved ` +
              `auth_domain from "${config.teamDomain}" to "${domainAfter}". A Worker's issuer is ` +
              `derived from that value, so the application is unreachable until one of the two ` +
              `is put back by hand in the dashboard.`,
          )
        }
        orgName = (after.name ?? '').trim()
        orgRenamed = true
        console.log(`    renamed the organisation: ${was} -> ${orgName}`)
      }
    } catch (cause) {
      if ((cause as Error).message.startsWith('refusing to apply')) throw cause
      // A read this instance can live without is a warning. A read it CANNOT is
      // not: `orgName` is a rename somebody asked for in a file, and warning
      // about it would leave the apply reporting success over a sign-in screen
      // that still says whatever it said before. Same rule as the identity
      // providers below, for the same reason.
      if (config.orgName !== undefined) throw cause
      console.log(
        `  ⚠️ Could not read the Zero Trust organisation (${(cause as Error).message}). Any ` +
          `declared teamDomain is therefore UNCHECKED this apply. Grant "Access: Organizations ` +
          `Read" to the token this instance imports to get the check back, and "Access: ` +
          `Organizations Write" as well if it declares an orgName.`,
      )
    }

    // 2. The identity providers: HOW a person authenticates, as against WHICH
    //    people the policies further down then admit. Both are required and
    //    neither is sufficient, which is why they live in one file.
    //
    //    ORGANISATION-LEVEL. Undeclared providers are reported and kept. An
    //    extra provider is NOT an open door the way an extra allow policy is,
    //    because the policies still decide who gets through; it is a way to
    //    authenticate that nobody wrote down, which is worth a line and not
    //    worth a deletion — least of all a deletion that reaches every other
    //    application in the account.
    const identityProviders: string[] = []
    const undeclaredIdps: string[] = []
    let idpsCreated = 0
    try {
      const actual = await cf<IdentityProvider[]>(
        token,
        'GET',
        `${account}/access/identity_providers`,
      )
      const plan = planIdentityProviders({ declared: config.identityProviders, actual })

      for (const type of plan.create) {
        await cf(token, 'POST', `${account}/access/identity_providers`, {
          type,
          name: IDENTITY_PROVIDER_NAMES[type] ?? type,
          config: {},
        })
        idpsCreated++
        identityProviders.push(type)
        console.log(`    + added the "${IDENTITY_PROVIDER_NAMES[type] ?? type}" way to sign in`)
      }
      for (const provider of plan.present) {
        identityProviders.push(provider.type)
      }
      for (const provider of plan.undeclared) {
        undeclaredIdps.push(provider.type)
        console.log(
          `    · "${provider.type}" is offered by this organisation and is declared nowhere. ` +
            `Kept: the policies still decide who gets through, so it is not an open door, and ` +
            `this list is shared with every other application in the account.`,
        )
      }
      if (
        config.emails.length > 0 &&
        config.identityProviders.length === 0 &&
        plan.undeclared.length === 0
      ) {
        console.log(
          `  ⚠️ This organisation offers NO way to sign in, and this instance declares none. ` +
            `Every person on the policy below will be refused. Add 'onetimepin' to ` +
            `identityProviders, or add a provider in the dashboard.`,
        )
      }
    } catch (cause) {
      if (config.identityProviders.length > 0) throw cause
      console.log(
        `  ⚠️ Could not read the identity providers (${(cause as Error).message}). This instance ` +
          `declares none, so nothing was going to change; grant "Access: Identity Providers ` +
          `Read" to see how people sign in.`,
      )
    }

    // 3. List before creating, always. An account with no Zero Trust
    //    organisation fails here, which is the right place for it to fail:
    //    creating the organisation is a console step and is nobody's apply.
    let apps: CfApp[]
    try {
      apps = await cf<CfApp[]>(token, 'GET', `${account}/access/apps?per_page=500`)
    } catch (cause) {
      throw new Error(
        `refusing to apply: could not list Access applications on account ${config.accountId}: ` +
          `${(cause as Error).message}. If this account has no Zero Trust organisation yet, that ` +
          `is a one-time step in the Cloudflare dashboard and nothing here can do it. If it has ` +
          `one, check the imported token holds "Access: Apps and Policies Read".`,
        { cause },
      )
    }

    const found = findApp(apps, { name: config.name, domain })
    const body = appBody({ ...config, domain })

    let app: CfApp
    let appChanged: boolean
    if (found) {
      // ALWAYS a PUT, even when everything agrees: a converge that skips the
      // write leaves whatever the dashboard did to the fields this module owns.
      // What it reports is now derived from the body it is about to send, so
      // every field it writes is a field it compares — see `appDiffers` for why
      // the previous three-field subset was worse than no comparison.
      const differing = appDiffers(body, found.app as unknown as Record<string, unknown>)
      appChanged = differing.length > 0
      app = await cf<CfApp>(token, 'PUT', `${account}/access/apps/${found.app.id}`, body)
      console.log(
        `  Converged Access application "${config.name}" on ${domain} (${app.id}, matched by ` +
          `${found.by})` +
          (appChanged ? ` — changed ${differing.join(', ')}` : ''),
      )
    } else {
      app = await cf<CfApp>(token, 'POST', `${account}/access/apps`, body)
      appChanged = true
      console.log(`  Created Access application "${config.name}" on ${domain} (${app.id})`)
    }

    // 4. The service token this module owns, if one is declared.
    //
    //    AFTER the application, deliberately. The measured failure that made
    //    `announce` exist was a 403 on creating the app, which — with the mint
    //    first — burned a write-once secret for an application that was never
    //    created. Minting after means the same 403 costs nothing, and the
    //    policy below is the only thing that needs the id.
    let mintedTokenId = ''
    let clientId = ''
    let clientSecret = ''
    let tokenCreated = false
    let rotated = false
    if (config.serviceTokenName !== undefined) {
      const tokens = await cf<ServiceToken[]>(token, 'GET', `${account}/access/service_tokens`)
      let svc = tokens.find((t) => t.name === config.serviceTokenName)
      if (!svc) {
        svc = await cf<ServiceToken>(token, 'POST', `${account}/access/service_tokens`, {
          name: config.serviceTokenName,
          duration: '8760h', // one year; Cloudflare's max, and expiry here is an outage
        })
        clientSecret = svc.client_secret ?? ''
        tokenCreated = true
        console.log(`  Created service token "${config.serviceTokenName}" (${svc.id})`)
        announce(svc.client_id, clientSecret)
      } else if (config.rotate) {
        const fresh = await cf<ServiceToken>(
          token,
          'POST',
          `${account}/access/service_tokens/${svc.id}/rotate`,
        )
        clientSecret = fresh.client_secret ?? ''
        rotated = true
        console.log(`  ROTATED service token "${config.serviceTokenName}" — the old secret is dead`)
        announce(svc.client_id, clientSecret)
      } else {
        console.log(`  Service token "${config.serviceTokenName}" (${svc.id}) exists, not rotated`)
      }
      mintedTokenId = svc.id
      clientId = svc.client_id
    }

    const serviceTokenIds = [...referencedTokenIds, ...(mintedTokenId ? [mintedTokenId] : [])]

    // 5. Converge the policies this instance owns, and report every other.
    //
    //    Up to TWO: the people, and the machines. They are planned separately
    //    and each is compared against its OWN idea of a match, so a Service Auth
    //    policy existing cannot make an `everyone` rule beside the addresses
    //    look acceptable.
    const declared: DeclaredPolicy[] = [
      ...(config.emails.length > 0
        ? [
            {
              name: config.policyName,
              admits: 'emails' as const,
              emails: config.emails,
              sessionDuration: config.sessionDuration,
            },
          ]
        : []),
      ...(serviceTokenIds.length > 0
        ? [
            {
              name: serviceTokenPolicyNameFor(config),
              admits: 'service-tokens' as const,
              tokenIds: serviceTokenIds,
              sessionDuration: config.sessionDuration,
            },
          ]
        : []),
    ]

    const actual = await cf<AccessPolicy[]>(
      token,
      'GET',
      `${account}/access/apps/${app.id}/policies`,
    )
    const plan = planPolicies({ declared, actual })

    const policyIds: string[] = []
    let rewrote = false
    for (const step of plan.plans) {
      const policyBody = policyBodyFor(step.declared)

      if (step.action === 'create') {
        const created = await cf<{ id: string }>(
          token,
          'POST',
          `${account}/access/apps/${app.id}/policies`,
          policyBody,
        )
        policyIds.push(created.id)
        rewrote = true
        console.log(
          `    + created policy "${step.declared.name}" admitting ${admits(step.declared)}`,
        )
      } else if (step.action === 'update') {
        policyIds.push(step.mine!.id)
        rewrote = true
        await cf(
          token,
          'PUT',
          `${account}/access/apps/${app.id}/policies/${step.mine!.id}`,
          policyBody,
        )
        console.log(
          `    ~ rewrote policy "${step.declared.name}" (${step.reason}) to admit ` +
            `${admits(step.declared)}`,
        )
      } else {
        policyIds.push(step.mine!.id)
        console.log(`    = policy "${step.declared.name}" already admits ${admits(step.declared)}`)
      }
    }

    // The people policy is first when it is declared at all; empty otherwise.
    const policyId = config.emails.length > 0 ? (policyIds[0] ?? '') : ''

    // 6. Anything else on this application. Loud, because unlike an undeclared
    //    DNS record, an undeclared policy is somebody's way in.
    //
    //    `remaining` is what is still there when this loop ends, and it is what
    //    the `undeclared` output reports. Reporting `plan.undeclared` instead
    //    would be reporting the policies this apply just deleted, which reads as
    //    drift that survived rather than drift that was fixed.
    const remaining: AccessPolicy[] = []
    let deleted = 0
    for (const policy of plan.undeclared) {
      const admittedBy =
        policyEmails(policy)?.join(', ') ??
        policyServiceTokens(policy)
          ?.map((id) => `service token ${id}`)
          .join(', ') ??
        'not by address or service token'
      const description = `"${policy.name}" (${policy.decision}, ${admittedBy})`
      if (config.allowDelete) {
        await cf(token, 'DELETE', `${account}/access/apps/${app.id}/policies/${policy.id}`)
        deleted++
        console.log(`    - deleted undeclared policy ${description}`)
      } else {
        remaining.push(policy)
        console.log(
          `    ‼️ DRIFT: policy ${description} is on this application and is declared nowhere. ` +
            `If it decides "allow", somebody can reach this application who is not in this ` +
            `file. Remove it in the dashboard, or set allowDelete: true on this instance.`,
        )
      }
    }

    // 7. What a verifying consumer needs, printed as well as returned: an apply
    //    nobody can read is an apply nobody can check.
    console.log(`  Access is now the way in to ${domain}:`)
    if (config.teamDomain !== undefined) console.log(`      team domain  ${config.teamDomain}`)
    if (app.aud) console.log(`      audience     ${app.aud}`)
    if (config.emails.length > 0) {
      console.log(
        `      sign in with ${signInWith({ declared: identityProviders, undeclared: undeclaredIdps })}`,
      )
      console.log(`      admits       ${config.emails.join(', ')}`)
    }
    if (serviceTokenIds.length > 0) {
      console.log(`      and          ${serviceTokenIds.length} service token(s), without a person`)
    }

    return {
      appId: app.id,
      aud: app.aud ?? '',
      teamDomain: config.teamDomain ?? '',
      orgName,
      identityProviders,
      undeclaredIdentityProviders: undeclaredIdps,
      appDomain: domain,
      emails: [...config.emails],
      policyId,
      policyIds,
      serviceTokenIds,
      serviceTokenId: mintedTokenId,
      clientId,
      clientSecret,
      created: tokenCreated,
      appCreated: found === undefined,
      // What is still undeclared AFTER this apply, not what was before it.
      undeclared: remaining.map((policy) => `${policy.name} (${policy.decision})`),
      changed:
        appChanged ||
        rewrote ||
        deleted > 0 ||
        orgRenamed ||
        idpsCreated > 0 ||
        tokenCreated ||
        rotated,
    }
  },
})
