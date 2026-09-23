import { afterEach, describe, expect, test } from 'bun:test'
import {
  type AccessPolicy,
  appBody,
  cloudflareAccessModule,
  type DeclaredPolicy,
  emailIncludes,
  type IdentityProvider,
  normalizeDomain,
  planIdentityProviders,
  planPolicies,
  policyBodyFor,
  policyEmails,
  policyServiceTokens,
  serviceTokenIncludes,
  serviceTokenPolicyNameFor,
  signInWith,
  appDiffers,
} from './index'

/**
 * The diff this module computes, without a network.
 *
 * What is worth testing here is not "does it call the API". It is the ways a
 * policy can be wrong while looking right: a live policy that has grown a rule
 * admitting people nobody named, a second policy on the same application that
 * nothing declares, and a service-token policy left on `allow` where it admits
 * nothing at all. Every one of those leaves the declared config untouched, so
 * none of them is visible in a diff of the consuming repo.
 */

const forName = (plan: ReturnType<typeof planPolicies>, name: string) =>
  plan.plans.find((entry) => entry.declared.name === name)!

const idp = (type: string, over: Partial<IdentityProvider> = {}): IdentityProvider => ({
  id: `idp-${type}`,
  type,
  name: '',
  ...over,
})

const policy = (over: Partial<AccessPolicy> = {}): AccessPolicy => ({
  id: 'pol-1',
  name: 'allowed people',
  decision: 'allow',
  include: [{ email: { email: 'james@zabaca.com' } }],
  ...over,
})

describe('who a live policy actually admits', () => {
  test('a policy of addresses reads back as those addresses, sorted and lowercased', () => {
    expect(
      policyEmails({
        include: [
          { email: { email: 'Zoe@example.com' } },
          { email: { email: 'james@zabaca.com' } },
          { email: { email: 'james@zabaca.com' } },
        ],
      }),
    ).toEqual(['james@zabaca.com', 'zoe@example.com'])
  })

  test('a policy admitting anyone by anything else reads back as null', () => {
    // The failure this function exists for. An `include` list is OR'd, so ONE
    // extra rule beside the addresses widens the policy to people nobody named
    // while every address in it still looks exactly right. Null makes the
    // policy differ, so it is rewritten rather than read as a match.
    for (const include of [
      [{ everyone: {} }],
      [{ email: { email: 'james@zabaca.com' } }, { everyone: {} }],
      [{ email: { email: 'james@zabaca.com' } }, { email_domain: { domain: 'zabaca.com' } }],
      [{ email: { email: 'james@zabaca.com' } }, { ip: { ip: '0.0.0.0/0' } }],
      [{ login_method: { id: 'x' } }],
      // A rule that names two things is not an email rule, whatever else it says.
      [{ email: { email: 'james@zabaca.com' }, everyone: {} }],
      [{ email: { email: '' } }],
      [{ email: {} }],
    ]) {
      expect(policyEmails({ include }), JSON.stringify(include)).toBeNull()
    }
  })

  test('an empty include list is an empty list, not an open door', () => {
    expect(policyEmails({ include: [] })).toEqual([])
  })
})

describe('what the next apply does to the policies', () => {
  const emails = ['chris@example.com', 'james@zabaca.com']
  const people: DeclaredPolicy = { name: 'allowed people', admits: 'emails', emails }

  /** The plan for the people policy, which is what nearly every case is about. */
  const planFor = (actual: AccessPolicy[], declared: DeclaredPolicy[] = [people]) =>
    planPolicies({ declared, actual })
  test('no policy at all is created', () => {
    const plan = planFor([])
    expect(forName(plan, 'allowed people').action).toBe('create')
    expect(plan.undeclared).toEqual([])
  })

  test('the declared people, already admitted, is a no-op', () => {
    const plan = planFor([policy({ include: emailIncludes(emails) })])
    expect(forName(plan, 'allowed people').action).toBe('unchanged')
  })

  test('order and capitalisation are not a change, so an apply is not a rewrite', () => {
    const plan = planFor([
      policy({
        include: [
          { email: { email: 'James@Zabaca.com' } },
          { email: { email: 'chris@example.com' } },
        ],
      }),
    ])
    expect(forName(plan, 'allowed people').action).toBe('unchanged')
  })

  test('a person added in the dashboard is removed again, because this file is the list', () => {
    const plan = planFor([policy({ include: emailIncludes([...emails, 'stranger@example.com']) })])
    expect(forName(plan, 'allowed people').action).toBe('update')
    expect(forName(plan, 'allowed people').reason).toContain('stranger@example.com')
  })

  test('a policy that has grown an `everyone` rule is rewritten, not left alone', () => {
    // The whole point of policyEmails returning null. Every declared address is
    // still on this policy, so an email-set comparison alone would call it
    // unchanged and leave the application open to the internet.
    const plan = planFor([policy({ include: [...emailIncludes(emails), { everyone: {} }] })])
    expect(forName(plan, 'allowed people').action).toBe('update')
    expect(forName(plan, 'allowed people').reason).toContain('other than their address')
  })

  test('the everyone check survives a second declared policy being added beside it', () => {
    // THE PROPERTY THAT MUST NOT BE WEAKENED BY SERVICE TOKENS' ARRIVAL.
    // Declaring a service-token policy means a non-address rule is now a
    // legitimate thing for SOME policy to carry, and the cheap way to allow
    // that is to loosen the check for all of them. This is the case that fails
    // if anybody does.
    const plan = planFor(
      [
        policy({ include: [...emailIncludes(emails), { everyone: {} }] }),
        policy({
          id: 'pol-2',
          name: 'the CLI',
          decision: 'non_identity',
          include: serviceTokenIncludes(['tok-1']),
        }),
      ],
      [people, { name: 'the CLI', admits: 'service-tokens', tokenIds: ['tok-1'] }],
    )
    expect(forName(plan, 'allowed people').action).toBe('update')
    expect(forName(plan, 'allowed people').reason).toContain('other than their address')
  })

  test('a policy flipped from allow to deny or bypass is rewritten', () => {
    for (const decision of ['deny', 'bypass', 'non_identity']) {
      const plan = planFor([policy({ decision, include: emailIncludes(emails) })])
      expect(forName(plan, 'allowed people').action, decision).toBe('update')
    }
  })

  test('an undeclared exclude or require is rewritten away', () => {
    // Not a hole, but not written down either, and a policy that silently
    // requires something nobody declared locks the right person out with no
    // visible cause.
    for (const extra of [{ exclude: [{ everyone: {} }] }, { require: [{ everyone: {} }] }]) {
      const plan = planFor([policy({ include: emailIncludes(emails), ...extra })])
      expect(forName(plan, 'allowed people').action, JSON.stringify(extra)).toBe('update')
    }
  })

  test('a session duration the live policy disagrees with is rewritten', () => {
    // The cookie's lifetime is part of what the policy decides. A policy that
    // admits exactly the right people for a week when the file says an hour is
    // drift that no address comparison can see.
    const plan = planPolicies({
      declared: [{ ...people, sessionDuration: '1h' }],
      actual: [policy({ include: emailIncludes(emails), session_duration: '168h' })],
    })
    expect(plan.plans[0]!.action).toBe('update')
    expect(plan.plans[0]!.reason).toContain('168h')
  })

  test('a live policy that reports no session duration is not a spurious rewrite', () => {
    // Cloudflare omits the field on a policy that inherits the application's.
    // Reading an absent field as a mismatch would make every apply a rewrite,
    // which is how the drift lines below it stop being read.
    const plan = planPolicies({
      declared: [{ ...people, sessionDuration: '24h' }],
      actual: [policy({ include: emailIncludes(emails) })],
    })
    expect(plan.plans[0]!.action).toBe('unchanged')
  })

  test('every other policy on the application is reported, whatever it is called', () => {
    // A second allow policy is somebody's way in, and it does not touch the
    // one this module owns, so nothing in a diff of the consuming repo shows it.
    const mine = policy({ include: emailIncludes(emails) })
    const sneaky = policy({ id: 'pol-2', name: 'temporary', include: [{ everyone: {} }] })
    const plan = planFor([mine, sneaky])

    expect(forName(plan, 'allowed people').action).toBe('unchanged')
    expect(plan.undeclared.map((p) => p.id)).toEqual(['pol-2'])
  })
})

/**
 * THE MACHINE'S WAY IN, and the half of this module that is easiest to get
 * dangerously wrong.
 *
 * A service token is admitted by a rule that is not an address, on a policy
 * whose decision is not `allow`. Both of those are exactly what the checks
 * above exist to catch on the people policy, so the two have to be told apart
 * by WHICH policy is being planned, never by loosening what counts as a match.
 */
describe('a service token is declared, and everything else still is not', () => {
  const cli: DeclaredPolicy = {
    name: 'the CLI',
    admits: 'service-tokens',
    tokenIds: ['tok-1'],
  }
  const livePolicy = (over: Partial<AccessPolicy> = {}): AccessPolicy => ({
    id: 'pol-cli',
    name: 'the CLI',
    // Service Auth. NOT `allow`: an allow policy still demands an identity, so
    // a service token on one is admitted by nothing and the caller gets a login
    // page it cannot read.
    decision: 'non_identity',
    include: serviceTokenIncludes(['tok-1']),
    ...over,
  })

  test('the tokens a live policy admits read back, or null for anything else', () => {
    expect(policyServiceTokens({ include: serviceTokenIncludes(['tok-2', 'tok-1']) })).toEqual([
      'tok-1',
      'tok-2',
    ])

    for (const include of [
      // The one that matters most: `any valid service token` admits EVERY token
      // in the account, including one somebody minted for something else.
      [{ any_valid_service_token: {} }],
      [...serviceTokenIncludes(['tok-1']), { any_valid_service_token: {} }],
      [...serviceTokenIncludes(['tok-1']), { everyone: {} }],
      [...serviceTokenIncludes(['tok-1']), { email: { email: 'james@zabaca.com' } }],
      [{ service_token: { token_id: '' } }],
      [{ service_token: {} }],
      [{ service_token: { token_id: 'tok-1' }, everyone: {} }],
    ]) {
      expect(policyServiceTokens({ include }), JSON.stringify(include)).toBeNull()
    }
  })

  test('a declared service-token policy that matches is left alone', () => {
    // Not rewritten on every apply. A converge that always writes is a converge
    // nobody reads the output of, and the drift lines below it are the point of
    // reading it.
    const plan = planPolicies({ declared: [cli], actual: [livePolicy()] })
    expect(plan.plans[0]!.action).toBe('unchanged')
  })

  test('a service-token policy that has grown an everyone rule is still rewritten', () => {
    const plan = planPolicies({
      declared: [cli],
      actual: [livePolicy({ include: [...serviceTokenIncludes(['tok-1']), { everyone: {} }] })],
    })
    expect(plan.plans[0]!.action).toBe('update')
    expect(plan.plans[0]!.reason).toContain('other than the declared service token')
  })

  test('a service-token policy left on `allow` is rewritten to Service Auth', () => {
    // A service token needs the Service Auth action, and an `allow` policy
    // carrying one admits nothing while looking perfectly configured.
    const plan = planPolicies({ declared: [cli], actual: [livePolicy({ decision: 'allow' })] })
    expect(plan.plans[0]!.action).toBe('update')
  })

  test('a different token on the policy is replaced by the declared one', () => {
    const plan = planPolicies({
      declared: [cli],
      actual: [livePolicy({ include: serviceTokenIncludes(['tok-someone-elses']) })],
    })
    expect(plan.plans[0]!.action).toBe('update')
    expect(plan.plans[0]!.reason).toContain('tok-someone-elses')
  })

  test('declaring no service tokens declares no policy, and one on the app is drift', () => {
    // An instance that names no service token wants no way in for one. A live
    // policy admitting one is then undeclared, and undeclared is reported.
    const plan = planPolicies({
      declared: [{ name: 'allowed people', admits: 'emails', emails: ['james@zabaca.com'] }],
      actual: [livePolicy()],
    })
    expect(plan.plans).toHaveLength(1)
    expect(plan.undeclared.map((p) => p.id)).toEqual(['pol-cli'])
  })
})

describe('the application is one application, however its domain is written', () => {
  test('a scheme, a trailing slash and capitals are the same application', () => {
    for (const written of [
      'app.example.com/admin',
      'https://app.example.com/admin',
      'http://App.Example.com/admin/',
      '  app.example.com/admin  ',
    ]) {
      expect(normalizeDomain(written), written).toBe('app.example.com/admin')
    }
  })

  test('the path is part of the identity, because it is what is protected', () => {
    // `app.example.com` and `app.example.com/admin` are very different
    // applications: the first puts a sign-in wall in front of every public page
    // the host serves.
    expect(normalizeDomain('app.example.com')).not.toBe(normalizeDomain('app.example.com/admin'))
  })
})

describe('what the schema refuses before an apply can run', () => {
  const base = {
    accountId: 'acc',
    teamDomain: 'zabaca.cloudflareaccess.com',
    name: 'Admin',
    domain: 'app.example.com/admin',
    emails: ['james@zabaca.com'],
    apiToken: { from: 'token', output: 'tokenValue' },
  }

  test('an application that declares no way in at all', () => {
    // The generalised form of leeandco's "an empty allow list". Emails alone
    // are no longer the only principal, so the rule is about the UNION: an
    // application with neither a person nor a machine on it is one nobody can
    // reach, and it should be deleted rather than emptied.
    expect(() => cloudflareAccessModule.configSchema.parse({ ...base, emails: [] })).toThrow(
      /no way in/,
    )
    expect(() => cloudflareAccessModule.configSchema.parse({ ...base, emails: undefined })).toThrow(
      /no way in/,
    )
  })

  test('a machine-only application is accepted, because a service token is a principal', () => {
    // The shape the module this replaces could express and nothing else could:
    // no people at all, and a machine caller that the module mints a token for.
    expect(() =>
      cloudflareAccessModule.configSchema.parse({
        ...base,
        emails: [],
        serviceTokenName: 'edge-worker',
      }),
    ).not.toThrow()
    expect(() =>
      cloudflareAccessModule.configSchema.parse({
        ...base,
        emails: [],
        serviceTokens: [{ from: 'tok', output: 'tokenId' }],
      }),
    ).not.toThrow()
  })

  test('a team domain that is not one, because an issuer is derived from it', () => {
    // A scheme or a path here produces an issuer that matches no assertion ever
    // minted, and an application that refuses everybody for no visible reason.
    for (const teamDomain of [
      'https://zabaca.cloudflareaccess.com',
      'zabaca.cloudflareaccess.com/',
      'zabaca',
      'example.com',
      '',
    ]) {
      expect(
        () => cloudflareAccessModule.configSchema.parse({ ...base, teamDomain }),
        teamDomain || '(empty)',
      ).toThrow()
    }

    // And the real one is accepted, so the rule is not just "refuse things".
    expect(cloudflareAccessModule.configSchema.parse(base).teamDomain).toBe(
      'zabaca.cloudflareaccess.com',
    )
  })

  test('teamDomain is OPTIONAL, because a machine-only application has no issuer', () => {
    // leeandco requires it: its Worker verifies an assertion and derives the
    // issuer from that string. A service-token application verifies nothing and
    // derives nothing, so requiring the field would make consumers write down a
    // value that plays no part — and a value nobody uses is a value nobody
    // keeps right.
    const parsed = cloudflareAccessModule.configSchema.parse({
      accountId: 'acc',
      name: 'ws',
      domain: 'ws.example.com',
      serviceTokenName: 'edge-worker',
      apiToken: { from: 'token', output: 'tokenValue' },
    })
    expect(parsed.teamDomain).toBeUndefined()
  })

  test('an orgName without a teamDomain is refused, because the rename echoes it', () => {
    // The rename PUT must carry `auth_domain` (Cloudflare has no PATCH for the
    // resource), and what makes that safe is that the value echoed has already
    // been compared against a declared one. With nothing declared there is
    // nothing to compare, so the write would be choosing the issuer — the exact
    // failure the comparison exists to prevent.
    expect(() =>
      cloudflareAccessModule.configSchema.parse({
        accountId: 'acc',
        name: 'ws',
        domain: 'ws.example.com',
        serviceTokenName: 'edge-worker',
        orgName: 'Zabaca',
        apiToken: { from: 'token', output: 'tokenValue' },
      }),
    ).toThrow(/teamDomain/)
  })

  test('rotate without a service token to rotate is refused', () => {
    expect(() => cloudflareAccessModule.configSchema.parse({ ...base, rotate: true })).toThrow(
      /serviceTokenName/,
    )
  })

  test('addresses are normalized and de-duplicated, so a diff is about people', () => {
    const config = cloudflareAccessModule.configSchema.parse({
      ...base,
      emails: [' James@Zabaca.com ', 'james@zabaca.com', 'chris@example.com'],
    })
    expect(config.emails).toEqual(['chris@example.com', 'james@zabaca.com'])
  })

  test('deletion is off unless somebody turns it on', () => {
    expect(cloudflareAccessModule.configSchema.parse(base).allowDelete).toBe(false)
  })

  test('a session lasts 24h unless the instance says otherwise', () => {
    // The default the vendored module got wrong for a human: it defaulted `0s`,
    // meaning every request is evaluated and no cookie is ever issued, which is
    // right for a machine and is a fresh one-time-PIN email per navigation for
    // a person.
    expect(cloudflareAccessModule.configSchema.parse(base).sessionDuration).toBe('24h')
  })
})

describe('the policy a service token gets is named after the token by default', () => {
  // Not a cosmetic choice. The module this replaces named its policy
  // `"<serviceTokenName> service token"`, so a consumer migrating to this one
  // finds its existing policy by name and converges it, rather than creating a
  // second policy and reporting the first as drift.
  test('a minted token names its own policy, exactly as the module this replaces did', () => {
    expect(serviceTokenPolicyNameFor({ serviceTokenName: 'cedarpad-edge-worker' })).toBe(
      'cedarpad-edge-worker service token',
    )
  })

  test('an explicit name always wins', () => {
    expect(
      serviceTokenPolicyNameFor({ serviceTokenName: 'edge', serviceTokenPolicyName: 'the CLI' }),
    ).toBe('the CLI')
  })

  test('referenced tokens with no minted one fall back to a general name', () => {
    expect(serviceTokenPolicyNameFor({})).toBe('service tokens')
  })
})

describe('the bodies that get written', () => {
  test('an email policy is `allow` and carries no leftover exclude or require', () => {
    expect(
      policyBodyFor({
        name: 'allowed people',
        admits: 'emails',
        emails: ['james@zabaca.com'],
        sessionDuration: '24h',
      }),
    ).toEqual({
      name: 'allowed people',
      decision: 'allow',
      include: [{ email: { email: 'james@zabaca.com' } }],
      exclude: [],
      require: [],
      session_duration: '24h',
    })
  })

  test('a service-token policy is Service Auth, and lists the token under include', () => {
    const body = policyBodyFor({
      name: 'edge service token',
      admits: 'service-tokens',
      tokenIds: ['svc-1'],
      sessionDuration: '0s',
    })
    // `include` is an OR, so a person added later does not have to satisfy the
    // token rule too. `require` would be an AND, which no browser can pass.
    expect(body).toMatchObject({
      decision: 'non_identity',
      include: [{ service_token: { token_id: 'svc-1' } }],
      session_duration: '0s',
    })
    expect(body.require).toEqual([])
  })

  test('the application body keeps the machine-caller flags the old module set', () => {
    expect(
      appBody({
        name: 'cedarpad workspace',
        domain: 'ws.cedarpad.com',
        sessionDuration: '0s',
        appLauncherVisible: false,
        enableBindingCookie: false,
        httpOnlyCookieAttribute: true,
      }),
    ).toEqual({
      name: 'cedarpad workspace',
      domain: 'ws.cedarpad.com',
      type: 'self_hosted',
      session_duration: '0s',
      app_launcher_visible: false,
      enable_binding_cookie: false,
      http_only_cookie_attribute: true,
    })
  })
})

describe('how people sign in, which is the half the policies cannot supply', () => {
  test('a declared provider the organisation does not offer is created', () => {
    const plan = planIdentityProviders({ declared: ['onetimepin'], actual: [idp('cloudflare')] })
    expect(plan.create).toEqual(['onetimepin'])
  })

  test('the provider that IS offered is left alone, so an apply is not a rebuild', () => {
    const plan = planIdentityProviders({
      declared: ['onetimepin'],
      actual: [idp('onetimepin'), idp('cloudflare')],
    })
    expect(plan.create).toEqual([])
    expect(plan.present.map((p) => p.type)).toEqual(['onetimepin'])
  })

  test('matched by type, because One-time PIN has no name to match on', () => {
    // Cloudflare returns `""` for it. A name match would create a second one on
    // every apply, forever, and each would work, so nothing would fail.
    const plan = planIdentityProviders({
      declared: ['onetimepin'],
      actual: [idp('onetimepin', { name: '' })],
    })
    expect(plan.create).toEqual([])
  })

  test('an undeclared provider is reported and NOT scheduled for removal', () => {
    // THE ORGANISATION-LEVEL PROPERTY. This module is the only one here whose
    // subject is not scoped to one application: identity providers belong to
    // the whole Zero Trust organisation, so an instance declaring one for a new
    // application is pointed at the provider set every other application in the
    // account already depends on. A converge loop that removed on sight would
    // take the `cloudflare` provider — how an operator signs in — away from all
    // of them, and would lock out whoever ran the apply.
    const plan = planIdentityProviders({ declared: ['onetimepin'], actual: [idp('cloudflare')] })
    expect(plan.undeclared.map((p) => p.type)).toEqual(['cloudflare'])
    expect(plan).not.toHaveProperty('delete')
  })

  test('declaring none manages none, and still reports what is there', () => {
    // Why the field is defaulted-empty rather than required: an instance that
    // says nothing about providers converges nothing about them, so adding this
    // module to an account cannot disturb the organisation by omission.
    const plan = planIdentityProviders({ declared: [], actual: [idp('cloudflare'), idp('google')] })
    expect(plan.create).toEqual([])
    expect(plan.present).toEqual([])
    expect(plan.undeclared.map((p) => p.type)).toEqual(['cloudflare', 'google'])
  })

  test('the same provider declared twice is created once', () => {
    const plan = planIdentityProviders({ declared: ['onetimepin', 'onetimepin'], actual: [] })
    expect(plan.create).toEqual(['onetimepin'])
  })
})

describe('what the schema says about the organisation and its providers', () => {
  const base = {
    accountId: 'acct-1',
    teamDomain: 'zabaca.cloudflareaccess.com',
    name: 'Admin',
    domain: 'app.example.com/admin',
    emails: ['james@zabaca.com'],
    apiToken: { from: 'access-token', output: 'tokenValue' },
  }

  test('declaring no providers is the default, so the organisation is opt-in', () => {
    expect(cloudflareAccessModule.configSchema.parse(base).identityProviders).toEqual([])
  })

  test('a provider that would need a client secret is refused at the schema', () => {
    // Not an oversight: an SSO provider needs a credential at rest, which is a
    // different module and a different argument. Refused where it is cheap.
    for (const type of ['google', 'okta', 'azureAD', 'github']) {
      expect(() =>
        cloudflareAccessModule.configSchema.parse({ ...base, identityProviders: [type] }),
      ).toThrow()
    }
  })

  test('the organisation name is optional, and omitting it leaves the name alone', () => {
    expect(cloudflareAccessModule.configSchema.parse(base).orgName).toBeUndefined()
    expect(() => cloudflareAccessModule.configSchema.parse({ ...base, orgName: '' })).toThrow()
  })
})

// ── The apply, against a whole account that actually mutates ───────────────

const ACCOUNT = 'acct-1'

interface World {
  org: { name?: string; auth_domain?: string }
  providers: IdentityProvider[]
  tokens: Array<{ id: string; name: string; client_id: string }>
  apps: Array<{
    id: string
    aud: string
    name: string
    domain: string
    session_duration?: string
    [field: string]: unknown
  }>
  policies: Array<AccessPolicy & { appId: string }>
  calls: Array<{ method: string; url: string; body?: Record<string, unknown> }>
  rotations: number
  /** Simulate a rename that also moves the team domain. */
  renameMovesAuthDomain?: string
  /** Simulate a token without the Organizations Read scope. */
  orgUnreadable?: boolean
}

const emptyWorld = (over: Partial<World> = {}): World => ({
  org: { name: 'Zabaca', auth_domain: 'zabaca.cloudflareaccess.com' },
  providers: [],
  tokens: [],
  apps: [],
  policies: [],
  calls: [],
  rotations: 0,
  ...over,
})

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 })

function installFetch(world: World): void {
  let n = 1
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined
    world.calls.push({ method, url, body })
    const { pathname } = new URL(url)
    const B = `/client/v4/accounts/${ACCOUNT}`

    if (pathname === `${B}/access/organizations`) {
      if (world.orgUnreadable) {
        return new Response(
          JSON.stringify({
            success: false,
            result: null,
            errors: [{ code: 1010, error: 'auth.forbidden' }],
          }),
          { status: 403 },
        )
      }
      if (method === 'PUT') {
        if (typeof body?.name === 'string') world.org.name = body.name
        if (world.renameMovesAuthDomain) world.org.auth_domain = world.renameMovesAuthDomain
      }
      return ok({ ...world.org })
    }

    if (pathname === `${B}/access/identity_providers`) {
      if (method === 'POST') {
        const made = { id: `idp-${n++}`, type: String(body?.type), name: String(body?.name) }
        world.providers.push(made)
        return ok(made)
      }
      return ok(world.providers)
    }

    if (pathname === `${B}/access/service_tokens`) {
      if (method === 'GET') return ok(world.tokens)
      const t = {
        id: `svc-${n++}`,
        name: String(body?.name),
        client_id: 'cid.access',
        client_secret: 'SECRET-1',
      }
      world.tokens.push({ id: t.id, name: t.name, client_id: t.client_id })
      return ok(t)
    }
    const rot = pathname.match(new RegExp(`^${B}/access/service_tokens/([^/]+)/rotate$`))
    if (rot) {
      world.rotations++
      const t = world.tokens.find((x) => x.id === rot[1])!
      return ok({ ...t, client_secret: 'SECRET-2' })
    }

    // THE WHOLE BODY IS STORED, because the real API answers with every field
    // it was sent. A stub that kept only name, domain and session duration was
    // fine while the module compared only those three — and the moment the
    // comparison was derived from the body instead, four "the second apply
    // changes nothing" tests went red against a fixture that could never have
    // matched. The stub was less faithful than the thing it models, and the
    // assertions it carried were weaker than they read.
    if (pathname === `${B}/access/apps`) {
      if (method === 'GET') return ok(world.apps)
      const a = { id: `app-${n++}`, aud: 'a'.repeat(64), ...body } as (typeof world.apps)[number]
      world.apps.push(a)
      return ok(a)
    }
    const appOne = pathname.match(new RegExp(`^${B}/access/apps/([^/]+)$`))
    if (appOne) {
      const a = world.apps.find((x) => x.id === appOne[1])!
      Object.assign(a, body)
      return ok(a)
    }

    const pol = pathname.match(new RegExp(`^${B}/access/apps/([^/]+)/policies$`))
    if (pol) {
      if (method === 'GET') return ok(world.policies.filter((p) => p.appId === pol[1]))
      const p = {
        id: `pol-${n++}`,
        appId: pol[1]!,
        name: String(body?.name),
        decision: String(body?.decision),
        include: (body?.include ?? []) as AccessPolicy['include'],
        exclude: (body?.exclude ?? []) as AccessPolicy['include'],
        require: (body?.require ?? []) as AccessPolicy['include'],
        session_duration: body?.session_duration as string | undefined,
      }
      world.policies.push(p)
      return ok(p)
    }
    const polOne = pathname.match(new RegExp(`^${B}/access/apps/([^/]+)/policies/([^/]+)$`))
    if (polOne) {
      const i = world.policies.findIndex((x) => x.id === polOne[2])
      if (method === 'DELETE') {
        world.policies.splice(i, 1)
        return ok(null)
      }
      Object.assign(world.policies[i]!, {
        name: body?.name,
        decision: body?.decision,
        include: body?.include,
        exclude: body?.exclude,
        require: body?.require,
        session_duration: body?.session_duration,
      })
      return ok(world.policies[i])
    }

    throw new Error(`stub has no route for ${method} ${url}`)
  }) as typeof fetch
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const ctx = { secrets: {}, imports: { tok: { tokenValue: 'api-token' } }, projectRoot: '/tmp' }
const apply = (over: Record<string, unknown> = {}, context: unknown = ctx) =>
  cloudflareAccessModule.apply(
    cloudflareAccessModule.configSchema.parse({
      accountId: ACCOUNT,
      apiToken: { from: 'tok', output: 'tokenValue' },
      name: 'Admin',
      domain: 'app.example.com/admin',
      emails: ['james@zabaca.com'],
      ...over,
    }) as never,
    context as never,
  )

/**
 * THE SHAPE THIS MODULE REPLACES, pinned so the promotion cannot become a
 * replacement.
 *
 * `cloudflare-access` before this change built exactly one policy — always
 * `non_identity`, always including a service token it minted itself, with
 * `serviceTokenName` required and `sessionDuration` defaulting to `0s`. One
 * consumer runs on it today. If the general module cannot express that config
 * exactly, migrating is a redesign rather than a config edit, and the old
 * module has to stay behind for it.
 */
describe('the machine-only shape the vendored module could express', () => {
  const machine = {
    name: 'cedarpad workspace (ryzen-9)',
    domain: 'ws.cedarpad.com',
    emails: [],
    serviceTokenName: 'cedarpad-edge-worker',
    sessionDuration: '0s',
  }

  test('one Service Auth policy, the minted token, no cookie and no people', async () => {
    const world = emptyWorld()
    installFetch(world)
    const out = await apply(machine)

    expect(world.tokens).toHaveLength(1)
    expect(world.tokens[0]!.name).toBe('cedarpad-edge-worker')
    expect(out.clientId).toBe('cid.access')
    expect(out.clientSecret).toBe('SECRET-1')
    expect(out.created).toBe(true)

    // Exactly one policy, and it admits the token that was just minted.
    expect(world.policies).toHaveLength(1)
    expect(world.policies[0]).toMatchObject({
      name: 'cedarpad-edge-worker service token',
      decision: 'non_identity',
      session_duration: '0s',
      include: [{ service_token: { token_id: out.serviceTokenId } }],
    })
    // No people policy at all — not an empty one, which would be a policy
    // admitting nobody sitting on the application waiting to be filled in.
    expect(world.policies.some((p) => p.decision === 'allow')).toBe(false)
    expect(out.emails).toEqual([])
    expect(out.policyId).toBe('')

    // A machine caller presents its token on every request; a cookie would let
    // a leaked one outlive the token.
    const appCreate = world.calls.find((c) => c.method === 'POST' && c.url.endsWith('/access/apps'))
    expect(appCreate?.body).toMatchObject({
      session_duration: '0s',
      enable_binding_cookie: false,
      http_only_cookie_attribute: true,
    })
  })

  test('the second apply does NOT rotate — the caller keeps the secret it holds', async () => {
    // The asymmetry with `cloudflare-token`, which rolls its value every apply.
    // An Access service token's consumer is somebody ELSE, deployed from a
    // different repo on a different cadence, so rolling on every apply would
    // take that consumer down until it was redeployed.
    const world = emptyWorld()
    installFetch(world)
    await apply(machine)
    const out = await apply(machine)

    expect(world.rotations).toBe(0)
    expect(out.created).toBe(false)
    expect(out.clientSecret).toBe('') // nothing to capture; the live one is unchanged
    expect(world.tokens).toHaveLength(1)
    expect(world.apps).toHaveLength(1)
    expect(world.policies).toHaveLength(1)
    expect(out.changed).toBe(false)
  })

  test('rotate: true mints a new secret, deliberately', async () => {
    const world = emptyWorld()
    installFetch(world)
    await apply(machine)
    const out = await apply({ ...machine, rotate: true })

    expect(world.rotations).toBe(1)
    expect(out.clientSecret).toBe('SECRET-2')
    expect(out.changed).toBe(true)
  })

  test('a changed domain updates the app in place rather than making a second one', async () => {
    const world = emptyWorld()
    installFetch(world)
    await apply(machine)
    const out = await apply({ ...machine, domain: 'ws2.cedarpad.com' })

    expect(world.apps).toHaveLength(1)
    expect(world.apps[0]!.domain).toBe('ws2.cedarpad.com')
    expect(out.changed).toBe(true)
  })

  test('an application already on the domain is converged, not duplicated', async () => {
    // The two modules being merged here disagreed on the converge identity: the
    // vendored one found its application by NAME, and leeandco's by DOMAIN. Each
    // is right about a different failure — a rename in the file must not orphan
    // the live application, and two applications on one hostname and path is a
    // configuration nobody can reason about. So the domain is tried first and
    // the name second, and this is the half that would be lost by keeping only
    // the vendored rule.
    const world = emptyWorld()
    installFetch(world)
    await apply(machine)
    const out = await apply({ ...machine, name: 'cedarpad workspace' })

    expect(world.apps).toHaveLength(1)
    expect(world.apps[0]!.name).toBe('cedarpad workspace')
    expect(out.changed).toBe(true)
  })

  test('a machine-only application needs no team domain and no identity provider', async () => {
    // Nothing signs in here, so nothing derives an issuer and nobody needs a
    // way to authenticate. The apply must not refuse, and must not warn its way
    // into looking broken.
    const world = emptyWorld()
    installFetch(world)
    const out = await apply(machine)
    expect(out.teamDomain).toBe('')
    expect(
      world.calls.some((c) => c.method === 'POST' && c.url.includes('identity_providers')),
    ).toBe(false)
  })
})

describe('both shapes at once, which is what makes this one module', () => {
  test('people and a machine get separate policies with separate decisions', async () => {
    const world = emptyWorld()
    installFetch(world)
    const out = await apply({
      teamDomain: 'zabaca.cloudflareaccess.com',
      emails: ['james@zabaca.com'],
      serviceTokenName: 'agent-lab-cli',
      serviceTokenPolicyName: 'the CLI',
    })

    expect(world.policies).toHaveLength(2)
    const [people, cli] = world.policies
    expect(people).toMatchObject({
      name: 'allowed people',
      decision: 'allow',
      include: [{ email: { email: 'james@zabaca.com' } }],
    })
    expect(cli).toMatchObject({
      name: 'the CLI',
      decision: 'non_identity',
      include: [{ service_token: { token_id: out.serviceTokenId } }],
    })
    expect(out.policyIds).toEqual([people!.id, cli!.id])
    expect(out.policyId).toBe(people!.id)
  })

  test('a referenced token and a minted one both reach the same policy', async () => {
    const world = emptyWorld()
    installFetch(world)
    const out = await apply(
      {
        emails: [],
        serviceTokenName: 'minted-here',
        serviceTokens: [{ from: 'other', output: 'tokenId' }],
      },
      { ...ctx, imports: { ...ctx.imports, other: { tokenId: 'svc-elsewhere' } } },
    )

    expect(out.serviceTokenIds.toSorted()).toEqual(['svc-elsewhere', out.serviceTokenId].toSorted())
    expect(policyServiceTokens(world.policies[0]!)).toEqual(
      ['svc-elsewhere', out.serviceTokenId].toSorted(),
    )
  })

  test('a service token reference that is not imported fails before anything is written', async () => {
    const world = emptyWorld()
    installFetch(world)
    let error: Error | undefined
    try {
      await apply({ serviceTokens: [{ from: 'nope', output: 'tokenId' }] })
    } catch (e) {
      error = e as Error
    }
    expect(error!.message).toContain('serviceTokens[0]')
    expect(world.calls).toEqual([])
  })
})

describe('the second apply of the people shape changes nothing', () => {
  test('idempotent across the organisation, the providers, the app and the policy', async () => {
    const world = emptyWorld({ providers: [{ id: 'idp-cf', type: 'cloudflare', name: '' }] })
    installFetch(world)
    const config = {
      teamDomain: 'zabaca.cloudflareaccess.com',
      orgName: 'Zabaca',
      identityProviders: ['onetimepin'],
      emails: ['james@zabaca.com'],
    }
    const first = await apply(config)
    expect(first.changed).toBe(true)

    const second = await apply(config)
    expect(second.changed).toBe(false)
    expect(world.apps).toHaveLength(1)
    expect(world.policies).toHaveLength(1)
    expect(world.providers.map((p) => p.type).toSorted()).toEqual(['cloudflare', 'onetimepin'])
    expect(
      world.calls.filter((c) => c.method === 'POST' && c.url.includes('identity_providers')),
    ).toHaveLength(1)
  })
})

describe('drift on the application is reported, and removed only on request', () => {
  const withStranger = async (over: Record<string, unknown> = {}) => {
    const world = emptyWorld()
    installFetch(world)
    await apply({ emails: ['james@zabaca.com'] })
    world.policies.push({
      id: 'pol-sneaky',
      appId: world.apps[0]!.id,
      name: 'temporary',
      decision: 'allow',
      include: [{ everyone: {} }],
    })
    const out = await apply({ emails: ['james@zabaca.com'], ...over })
    return { world, out }
  }

  test('an undeclared allow policy is reported and left standing by default', async () => {
    const { world, out } = await withStranger()
    expect(out.undeclared).toEqual(['temporary (allow)'])
    expect(world.policies.some((p) => p.id === 'pol-sneaky')).toBe(true)
    expect(out.changed).toBe(false)
  })

  test('allowDelete: true removes it, and the output reports what SURVIVED', async () => {
    // Reporting the plan's undeclared list instead would name the policies this
    // apply just deleted, which reads as drift that survived rather than drift
    // that was fixed.
    const { world, out } = await withStranger({ allowDelete: true })
    expect(world.policies.some((p) => p.id === 'pol-sneaky')).toBe(false)
    expect(out.undeclared).toEqual([])
    expect(out.changed).toBe(true)
  })
})

describe('the organisation: `name` is converged, `auth_domain` never is', () => {
  test('a generated organisation name is renamed to the declared one', async () => {
    const world = emptyWorld({
      org: {
        name: 'plain-brook-fb33.cloudflareaccess.com',
        auth_domain: 'zabaca.cloudflareaccess.com',
      },
    })
    installFetch(world)
    const out = await apply({ teamDomain: 'zabaca.cloudflareaccess.com', orgName: 'Zabaca Inc' })

    const put = world.calls.find(
      (c) => c.method === 'PUT' && c.url.includes('/access/organizations'),
    )
    expect(put).toBeDefined()
    expect(out.orgName).toBe('Zabaca Inc')
    expect(out.changed).toBe(true)
  })

  test('the rename echoes the auth_domain it just read, and never chooses one', async () => {
    // Cloudflare has no PATCH for this resource and refuses a body without
    // auth_domain (measured: `11004 access.api.error.invalid_auth_domain`), so
    // the field cannot be omitted. What keeps the guard a guard is that the
    // value written is the one read and verified a moment earlier, so an apply
    // can echo the team domain and can never move it.
    const world = emptyWorld({
      org: {
        name: 'plain-brook-fb33.cloudflareaccess.com',
        auth_domain: 'zabaca.cloudflareaccess.com',
      },
    })
    installFetch(world)
    await apply({ teamDomain: 'zabaca.cloudflareaccess.com', orgName: 'Zabaca Inc' })

    const put = world.calls.find(
      (c) => c.method === 'PUT' && c.url.includes('/access/organizations'),
    )
    expect(put!.body).toEqual({ name: 'Zabaca Inc', auth_domain: 'zabaca.cloudflareaccess.com' })
    expect(world.org.auth_domain).toBe('zabaca.cloudflareaccess.com')
  })

  test('the echoed value comes from the ACCOUNT, not from the file', async () => {
    // If these two are ever allowed to differ, the one that reaches the write
    // must be the account's. A file that disagrees is refused above rather than
    // applied, so the only way to observe the difference is a live value that
    // differs in case, which the compare normalizes and the write must not.
    const world = emptyWorld({ org: { name: 'old', auth_domain: 'ZABACA.cloudflareaccess.com' } })
    installFetch(world)
    await apply({ teamDomain: 'zabaca.cloudflareaccess.com', orgName: 'Zabaca Inc' })
    const put = world.calls.find(
      (c) => c.method === 'PUT' && c.url.includes('/access/organizations'),
    )
    expect((put!.body as { auth_domain: string }).auth_domain).toBe('ZABACA.cloudflareaccess.com')
  })

  test('an organisation with no auth_domain is never renamed, because that would invent one', async () => {
    const world = emptyWorld({ org: { name: 'old', auth_domain: '' } })
    installFetch(world)
    let error: Error | undefined
    try {
      await apply({ teamDomain: 'zabaca.cloudflareaccess.com', orgName: 'Zabaca Inc' })
    } catch (e) {
      error = e as Error
    }
    expect(error!.message).toContain('refusing to apply')
    expect(
      world.calls.some((c) => c.method === 'PUT' && c.url.includes('/access/organizations')),
    ).toBe(false)
  })

  test('a name that already matches is not written at all', async () => {
    const world = emptyWorld({
      org: { name: 'Zabaca Inc', auth_domain: 'zabaca.cloudflareaccess.com' },
    })
    installFetch(world)
    await apply({ teamDomain: 'zabaca.cloudflareaccess.com', orgName: 'Zabaca Inc' })
    expect(
      world.calls.some((c) => c.method === 'PUT' && c.url.includes('/access/organizations')),
    ).toBe(false)
  })

  test('a rename that moves the team domain is caught and refused, not reported as success', async () => {
    // If Cloudflare ever couples the two fields, the application is unreachable
    // from that moment. Nothing later in the apply would notice, so this is
    // checked with a fresh read straight after the write.
    const world = emptyWorld({
      org: {
        name: 'plain-brook-fb33.cloudflareaccess.com',
        auth_domain: 'zabaca.cloudflareaccess.com',
      },
      renameMovesAuthDomain: 'zabaca-inc.cloudflareaccess.com',
    })
    installFetch(world)

    let error: Error | undefined
    try {
      await apply({ teamDomain: 'zabaca.cloudflareaccess.com', orgName: 'Zabaca Inc' })
    } catch (e) {
      error = e as Error
    }
    expect(error).toBeDefined()
    expect(error!.message).toContain('refusing to apply')
    expect(error!.message).toContain('zabaca-inc.cloudflareaccess.com')
  })

  test('a team domain that disagrees still refuses before anything is written', async () => {
    const world = emptyWorld({
      org: { name: 'whatever', auth_domain: 'someone-else.cloudflareaccess.com' },
    })
    installFetch(world)
    let error: Error | undefined
    try {
      await apply({ teamDomain: 'zabaca.cloudflareaccess.com', orgName: 'Zabaca Inc' })
    } catch (e) {
      error = e as Error
    }
    expect(error!.message).toContain('refusing to apply')
    expect(world.calls.every((c) => c.method === 'GET')).toBe(true)
  })

  test('a declared rename is never silently skipped by an unreadable organisation', async () => {
    // The soft-failure this closes: the read is a warning, so an apply that
    // could not see the organisation would report success while the sign-in
    // screen went on saying whatever it said before. A rename asked for in a
    // file is not something to warn about.
    const world = emptyWorld({ orgUnreadable: true })
    installFetch(world)
    let error: Error | undefined
    try {
      await apply({ teamDomain: 'zabaca.cloudflareaccess.com', orgName: 'Zabaca Inc' })
    } catch (e) {
      error = e as Error
    }
    expect(error).toBeDefined()
    expect(error!.message).toContain('auth.forbidden')
  })

  test('an instance declaring no orgName still only warns, so the guard stays optional', async () => {
    const world = emptyWorld({ orgUnreadable: true })
    installFetch(world)
    const out = await apply({ teamDomain: 'zabaca.cloudflareaccess.com' })
    expect(out.orgName).toBe('')
  })
})

describe('identity providers, converged against a live organisation', () => {
  test('One-time PIN is added, and the existing Cloudflare login survives it', async () => {
    const world = emptyWorld({ providers: [{ id: 'idp-cf', type: 'cloudflare', name: '' }] })
    installFetch(world)
    const out = await apply({
      teamDomain: 'zabaca.cloudflareaccess.com',
      identityProviders: ['onetimepin'],
    })

    expect(world.providers.map((p) => p.type).toSorted()).toEqual(['cloudflare', 'onetimepin'])
    expect(out.identityProviders).toContain('onetimepin')
    expect(out.undeclaredIdentityProviders).toEqual(['cloudflare'])
    expect(
      world.calls.some((c) => c.method === 'DELETE' && c.url.includes('identity_providers')),
    ).toBe(false)
  })

  test('a provider already offered is never created a second time', async () => {
    // Matched by TYPE. `onetimepin` carries no name at all, so a name match
    // would create a second one on every apply, forever — and each would work,
    // so nothing would fail and nothing would report it.
    const world = emptyWorld({ providers: [{ id: 'idp-otp', type: 'onetimepin', name: '' }] })
    installFetch(world)
    const config = {
      teamDomain: 'zabaca.cloudflareaccess.com',
      identityProviders: ['onetimepin'],
    }
    await apply(config)
    const out = await apply(config)

    expect(
      world.calls.some((c) => c.method === 'POST' && c.url.includes('identity_providers')),
    ).toBe(false)
    expect(world.providers).toHaveLength(1)
    // The second apply against an account that already offered it changes
    // nothing at all — which is only an honest assertion because the first
    // apply above already created the application.
    expect(out.changed).toBe(false)
  })

  test('declaring a provider makes an unreadable provider list a hard failure', async () => {
    // The mirror of the organisation rule. An instance that declares a way to
    // sign in and cannot see whether it exists has not converged anything, and
    // reporting success would leave people locked out with nothing saying why.
    const world = emptyWorld()
    installFetch(world)
    const realInstall = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('identity_providers')) {
        return new Response(
          JSON.stringify({
            success: false,
            result: null,
            errors: [{ code: 1010, error: 'auth.forbidden' }],
          }),
          { status: 403 },
        )
      }
      return realInstall(input, init)
    }) as typeof fetch

    let error: Error | undefined
    try {
      await apply({ teamDomain: 'zabaca.cloudflareaccess.com', identityProviders: ['onetimepin'] })
    } catch (e) {
      error = e as Error
    }
    expect(error!.message).toContain('auth.forbidden')
  })
})

/**
 * THE ONE THING THIS MODULE MUST NEVER DO, guarded statically as well as
 * behaviourally.
 *
 * Identity providers are ORGANISATION-level. An instance declaring one for a
 * new application is pointed at the provider set every other Access application
 * in the account already depends on, so a DELETE here does not affect this
 * application — it removes a way to sign in from all of them, including the
 * `cloudflare` provider that is how the operator running the apply gets back in.
 *
 * The test above covers the path a fake account exercises. This one covers the
 * paths it does not: a delete added behind a new flag, in a branch no fixture
 * reaches, or in a cleanup limb. A source scan is a blunt instrument and is
 * worth it here because the failure is account-wide and silent — and because
 * this property could NOT be confirmed against the live Zabaca organisation:
 * the only Cloudflare credential at rest holds "Account API Tokens Write" and
 * nothing else, and a list endpoint answers a scopeless token with `[]` rather
 * than a 403, so a read there proves nothing.
 */
describe('identity providers are never deleted, on any path', () => {
  test('the module contains no DELETE against identity_providers', async () => {
    const source = await Bun.file(new URL('./index.ts', import.meta.url)).text()
    const deletes = source
      .split('\n')
      .filter((line) => line.includes("'DELETE'") || line.includes('"DELETE"'))
    // There IS one delete in this module — an undeclared POLICY, behind
    // allowDelete — so an assertion of "no DELETE at all" would be wrong as
    // well as brittle. What must hold is that none of them names a provider.
    expect(deletes.length).toBeGreaterThan(0)
    for (const line of deletes) {
      expect(line, line.trim()).not.toContain('identity_providers')
    }
    // And the endpoint is reached only by GET and POST.
    const providerCalls = source.split('\n').filter((line) => line.includes('identity_providers'))
    expect(providerCalls.length).toBeGreaterThan(0)
    for (const line of providerCalls) {
      expect(line, line.trim()).not.toContain('DELETE')
    }
  })
})

/**
 * TWO REPORTING DEFECTS IN ONE FAMILY: the module saying something untrue about
 * what it just did. Neither misconfigures anything, and that is exactly why
 * both survived a release — nothing fails, somebody just reads a wrong line.
 */
describe('what the apply says about signing in', () => {
  test('an instance declaring no provider reports the ones a person can use', () => {
    // The line answers "can a person sign in", not "what did this instance
    // declare". Declaring none is the RECOMMENDED configuration when the
    // organisation already offers what is needed — declaring one converges
    // nothing and needs write access over state four other applications share —
    // so the recommended case was the one that read as an open contradiction of
    // the two lines printed just above it.
    expect(signInWith({ declared: [], undeclared: ['onetimepin', 'cloudflare'] })).toBe(
      'onetimepin, cloudflare',
    )
  })

  test('a declared provider and an undeclared one are both ways in', () => {
    expect(signInWith({ declared: ['onetimepin'], undeclared: ['cloudflare'] })).toBe(
      'onetimepin, cloudflare',
    )
  })

  test('an organisation offering nothing still says so', () => {
    // The mirror case, and the reason this is not just "print more". If the
    // organisation really offers no provider, the line must still say nobody
    // can sign in — otherwise the fix trades a false alarm for a false
    // reassurance, which is the worse of the two.
    expect(signInWith({ declared: [], undeclared: [] })).toBe('(nothing, so nobody can sign in)')
  })
})

describe('the summary line an apply actually prints', () => {
  // Exporting a correct helper and not calling it would leave every apply as
  // wrong as it was, so this drives the REAL apply and reads what it printed.
  // The module's own history has this failure in it twice over — `announce`
  // and `describeCfErrors` both needed a test at the call site rather than at
  // the function — and a mutation that reverts the call site is otherwise
  // invisible.
  const printed: string[] = []
  const realLog = console.log
  afterEach(() => {
    console.log = realLog
    printed.length = 0
  })
  const capture = () => {
    console.log = (...args: unknown[]) => void printed.push(args.join(' '))
  }

  test('names the providers the organisation offers, declared or not', async () => {
    const world = emptyWorld({
      providers: [
        { id: 'idp-otp', type: 'onetimepin', name: '' },
        { id: 'idp-cf', type: 'cloudflare', name: '' },
      ],
    })
    installFetch(world)
    capture()
    await apply({ emails: ['james@zabaca.com'] })
    console.log = realLog

    const line = printed.find((l) => l.includes('sign in with'))
    expect(line).toBeDefined()
    expect(line).toContain('onetimepin')
    expect(line).toContain('cloudflare')
    expect(line).not.toContain('nobody can sign in')
  })

  test('an organisation offering nothing is still reported as offering nothing', async () => {
    const world = emptyWorld({ providers: [] })
    installFetch(world)
    capture()
    await apply({ emails: ['james@zabaca.com'] })
    console.log = realLog

    expect(printed.find((l) => l.includes('sign in with'))).toContain('nobody can sign in')
  })

  test('the apply names the fields it changed, rather than a bare "changed"', async () => {
    const world = emptyWorld()
    installFetch(world)
    await apply({ emails: ['james@zabaca.com'], appLauncherVisible: true })
    capture()
    const out = await apply({ emails: ['james@zabaca.com'], appLauncherVisible: false })
    console.log = realLog

    expect(out.changed).toBe(true)
    expect(printed.find((l) => l.includes('Converged Access application'))).toContain(
      'app_launcher_visible',
    )
  })
})

describe('what the apply reports as changed about the application', () => {
  const live = {
    name: 'app',
    domain: 'app.example.com',
    type: 'self_hosted',
    session_duration: '24h',
    app_launcher_visible: true,
    enable_binding_cookie: false,
    http_only_cookie_attribute: true,
  }

  test('a body identical to the live application differs in nothing', () => {
    expect(appDiffers(live, live)).toEqual([])
  })

  test('EVERY field the body writes is compared, not a chosen three', () => {
    // The defect this replaces compared name, domain and session_duration and
    // nothing else. `app_launcher_visible` is written on every apply from a
    // default, so flipping it was a change being MADE and not reported — which
    // is a different thing from drift being accepted, and the comment defending
    // the old subset only ever argued the latter.
    for (const [field, value] of [
      ['name', 'other'],
      ['domain', 'other.example.com'],
      ['type', 'ssh'],
      ['session_duration', '0s'],
      ['app_launcher_visible', false],
      ['enable_binding_cookie', true],
      ['http_only_cookie_attribute', false],
    ] as Array<[string, unknown]>) {
      expect(appDiffers({ ...live, [field]: value }, live), field).toEqual([field])
    }
  })

  test('the guard is not vacuous — it compares every key the body carries', () => {
    // Without this, a comparison that looked at nothing would pass every case
    // above by reporting `[]`, and the case above would only prove it reports
    // `[]` for a match.
    const desired = appBody({
      name: 'app',
      domain: 'app.example.com',
      sessionDuration: '24h',
      appLauncherVisible: true,
      enableBindingCookie: false,
      httpOnlyCookieAttribute: true,
    })
    expect(Object.keys(desired).toSorted()).toEqual(Object.keys(live).toSorted())
  })

  test('the domain is compared normalized, so a scheme is not a change', () => {
    expect(appDiffers(live, { ...live, domain: 'https://App.Example.com/' })).toEqual([])
  })

  test('a field the live application does not carry at all reads as a difference', () => {
    // An application created before a field existed answers without it. Once,
    // that reports changed and the PUT settles it; reading absence as a match
    // would mean the module never converged the field at all.
    const { app_launcher_visible: _gone, ...older } = live
    expect(appDiffers(live, older)).toEqual(['app_launcher_visible'])
  })
})

describe('app_launcher_visible defaults to what omitting it has always meant', () => {
  const base = {
    accountId: 'acc',
    name: 'Admin',
    domain: 'app.example.com',
    emails: ['james@zabaca.com'],
    apiToken: { from: 'token', output: 'tokenValue' },
  }

  test('an instance declaring nothing leaves it as Cloudflare would', () => {
    // A PUT is a full replace, so "omit the field" and "send Cloudflare's own
    // default" are the same act and the module has no third option. Defaulting
    // to `false` therefore made every migrating consumer's first apply a change
    // — silently, since the field was not compared.
    expect(cloudflareAccessModule.configSchema.parse(base).appLauncherVisible).toBe(true)
  })

  test('an instance that wants it hidden still says so', () => {
    expect(
      cloudflareAccessModule.configSchema.parse({ ...base, appLauncherVisible: false })
        .appLauncherVisible,
    ).toBe(false)
  })
})

describe('the measured 403, the whole way through apply', () => {
  test('creating the application is refused, and the apply says 1010 auth.forbidden', async () => {
    // The module reads the API through `../cloudflare-api`, so this is what
    // makes the shared reader's fix reachable from here rather than merely
    // exported. Measured against a live account on 2026-08-15: the Access
    // endpoints answer `{code, error}` and carry no `message` at all.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.includes('/access/organizations')) {
        return ok({ auth_domain: 'zabaca.cloudflareaccess.com', name: 'Zabaca' })
      }
      if (method === 'GET' && url.includes('/access/apps')) return ok([])
      if (method === 'POST' && url.includes('/access/apps')) {
        // Verbatim, including the absent `message`.
        return new Response(
          JSON.stringify({
            result: null,
            success: false,
            errors: [{ code: 1010, error: 'auth.forbidden' }],
          }),
          { status: 403 },
        )
      }
      return ok(null)
    }) as typeof fetch

    let error: Error | undefined
    try {
      await apply({ teamDomain: 'zabaca.cloudflareaccess.com' })
    } catch (e) {
      error = e as Error
    }

    expect(error).toBeDefined()
    expect(error!.message).toContain('1010')
    expect(error!.message).toContain('auth.forbidden')
  })

  test('an account with no Zero Trust organisation is named as the cause', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.includes('/access/organizations')) return ok({ auth_domain: '', name: '' })
      if (method === 'GET' && url.includes('/access/apps')) {
        return new Response(
          JSON.stringify({
            success: false,
            result: null,
            errors: [{ code: 12109, error: 'no org' }],
          }),
          { status: 404 },
        )
      }
      return ok(null)
    }) as typeof fetch

    let error: Error | undefined
    try {
      await apply()
    } catch (e) {
      error = e as Error
    }
    expect(error!.message).toContain('Zero Trust organisation')
    expect(error!.message).toContain('no org')
  })
})
