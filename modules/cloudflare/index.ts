import * as path from 'node:path'
import * as fs from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import type { ApplyContext } from '../../src/types'

/**
 * cloudflare — deploys a Cloudflare Worker (optionally with static assets, a
 * Durable Object, and a Container) via `wrangler deploy`.
 *
 * This is a THIN orchestrator, the same shape as the turso module: `apply` runs
 * on the operator machine, reads CF creds through `ctx.secret`, runs an optional
 * local build, then shells `wrangler deploy` in the package's own directory. The
 * Worker TOPOLOGY (name, assets binding, durable_objects, containers,
 * migrations) lives in that package's `wrangler.jsonc` — wrangler is the source
 * of truth for it, not this module. That keeps the module reusable for both
 * plain assets Workers (e.g. a static Astro/Next site) and container-backed
 * payloads (e.g. a DO-bound NATS server).
 *
 * Auth is non-interactive: wrangler reads `CLOUDFLARE_API_TOKEN` +
 * `CLOUDFLARE_ACCOUNT_ID` from the environment, so no `wrangler login` is
 * needed. Worker secrets (e.g. CLAUDE_CODE_OAUTH_TOKEN) are pushed via
 * `wrangler secret put`, piped through stdin so no secret value is ever
 * interpolated into a command string.
 *
 * NOTE on containers (Phase B): `wrangler deploy` builds the container image
 * with Docker, so Docker must be running locally at apply time, and the account
 * must be on a Workers Paid plan with Containers enabled. A plain assets Worker
 * (Phase A) has neither requirement.
 *
 * Two config knobs shape WHICH worker a given apply targets:
 *   - `wranglerEnv` selects a named `env.<name>` block in the package's
 *     wrangler.jsonc (`--env`), so one package can ship distinct workers per zbc
 *     environment from a single config file.
 *   - `workerName` renames the deployed worker (`--name`), which is what powers
 *     per-PR preview workers (`zbc-<app>-pr-<N>`). The `*.workers.dev` deploy-URL
 *     regex still matches a renamed worker's URL.
 * Setting both is legal and targets the `--name` worker: `deploy` and `delete`
 * honour `--name` on its own, and the secret push passes `--name` ALONE for the
 * same target — wrangler's secret commands would otherwise concatenate the two
 * into a `<workerName>-<wranglerEnv>` script nothing deployed (see step 4).
 *
 * IMPORT SYNC: `workerSecrets` and `workerVars` entries can be either a plain
 * name (resolved from this environment's secrets.yaml, exactly as before) or a
 * `{ name, from, output }` reference into an imported instance's outputs
 * (`ctx.output({ from, output }, field)`, resolved by the engine from that
 * instance's validated outputs). Secrets are pushed via `wrangler secret put`, piped
 * through stdin; vars are passed as `wrangler deploy --var KEY:VALUE`. The two
 * are deliberately separate fields — a var is visible in `wrangler.jsonc`/the
 * dashboard, a secret is not — so an imported value's exposure is an explicit
 * per-entry choice, never inferred. Referencing an instance not listed in this
 * instance's `imports`, or an output key that instance doesn't emit, is a hard
 * error naming both.
 */

/** Resolve the wrangler binary: prefer the package-local one, else `bunx`. */
function resolveWrangler(workdir: string): { cmd: string; pre: string[] } {
  const local = path.join(workdir, 'node_modules', '.bin', 'wrangler')
  if (fs.existsSync(local)) return { cmd: local, pre: [] }
  // Fall back to bunx on the NODE runtime. Never pass --bun: wrangler under
  // the bun runtime exits 0 after uploading the version but silently skips the
  // deploy/trigger step (2026-07-12 lov incident in Zabaca/ceo: three green
  // applies, zero code deployed).
  return { cmd: 'bunx', pre: ['wrangler'] }
}

/** Run wrangler in `workdir` with CF creds in the env; return captured stdout. */
function wrangler(workdir: string, args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  const { cmd, pre } = resolveWrangler(workdir)
  // spawnSync (not execFileSync) so BOTH streams are captured on success too:
  // wrangler splits its human output across stdout/stderr, and parsing only
  // stdout is how the 2026-07-12 silent-no-deploy went unnoticed.
  const res = spawnSync(cmd, [...pre, ...args], {
    cwd: workdir,
    env,
    input,
    maxBuffer: 64 * 1024 * 1024,
  })
  const combined = `${res.stdout?.toString() ?? ''}\n${res.stderr?.toString() ?? ''}`
  if (res.status !== 0 || res.error) {
    throw new Error(
      `wrangler ${args.join(' ')} failed (exit ${res.status}):\n${combined.trim() || res.error?.message}`,
    )
  }
  return combined
}

/**
 * Which deploy this is, as a value the deployed code can be told.
 *
 * `GITHUB_SHA` in CI, `git rev-parse HEAD` locally. A dirty working tree gets a
 * distinct id rather than the bare commit: a local apply builds the image from
 * the working tree, so the same commit with edits is a different image, and
 * handing it the commit's id would be the staleness this exists to prevent. The
 * timestamp makes each such apply its own deploy, which is the honest answer
 * when the content is whatever happened to be on disk.
 *
 * Absence is a hard error rather than a silent skip — see `deployIdVar`.
 */
function resolveDeployId(projectRoot: string, varName: string): string {
  const fromCi = process.env.GITHUB_SHA?.trim()
  if (fromCi) return fromCi

  let head: string
  try {
    head = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new Error(
      `deployIdVar is set (${varName}) but this deploy has no id: GITHUB_SHA is unset and \`git rev-parse HEAD\` failed in ${projectRoot}. ` +
        `Deploy from CI, from a git checkout, or drop deployIdVar.`,
    )
  }

  let dirty = false
  try {
    dirty =
      execSync('git status --porcelain', {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() !== ''
  } catch {
    // A repository whose status cannot be read still has a HEAD worth
    // reporting; treating that as clean is the same answer as before this
    // check existed.
  }
  return dirty ? `${head}-dirty-${Date.now()}` : head
}

const buildSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
})

/**
 * The origin a route pattern answers on, for `deployUrl` when there is no
 * workers.dev URL to report.
 *
 * Only a pattern whose host is a concrete hostname qualifies. A wildcard host
 * (`*.example.com/*`) names a set rather than an address, and emitting
 * `https://*.example.com` would hand a dependent a string that looks like a URL
 * and resolves to nothing.
 */
export function routeUrl(routes: string[]): string {
  for (const route of routes) {
    const host = route.split('/')[0]
    if (host && !host.includes('*') && host.includes('.')) return `https://${host}`
  }
  return ''
}

/**
 * A worker secret/var entry: a plain name (resolved from this environment's
 * secrets.yaml), a `{ name, value }` literal (vars that are per-instance
 * config rather than secrets — e.g. DEFAULT_FROM — so a generic wrangler.jsonc
 * needs no editing), a `{ name, from, output }` reference into an imported
 * instance's outputs (`ctx.output`), or a `{ name, secret }`
 * pair that exposes a secrets.yaml key under a different env var name.
 */
const workerValueSchema = z.union([
  z.string(),
  z.object({
    /** Env var name inside the Worker. */
    name: z.string(),
    /** Literal value, straight from this instance's config file. */
    value: z.string(),
  }),
  z.object({
    /** Env var name inside the Worker. */
    name: z.string(),
    /** Instance name — must be listed in this instance's `imports`. */
    from: z.string(),
    /** Which output of that instance to read. */
    output: z.string(),
  }),
  z.object({
    /** Env var name inside the Worker. */
    name: z.string(),
    /**
     * A key in this environment's secrets.yaml, exposed under `name`.
     *
     * The plain-string form already reads a secret, but it forces the Worker's
     * env var to be spelled exactly like the secret. An app whose interface
     * says `WALGIT_S3_ACCESS_KEY_ID` cannot then read a credential filed as
     * `WAREHOUSE_R2_ACCESS_KEY_ID` — and the alternative is a second copy of
     * the same credential under a second name, which is one more thing to
     * forget when it rotates. Same form, same reason, as the `fly` module's.
     */
    secret: z.string(),
  }),
])

type WorkerValueEntry = z.infer<typeof workerValueSchema>

/** Resolve a workerSecrets/workerVars entry to its `{ name, value }` pair. */
function resolveWorkerValue(
  entry: WorkerValueEntry,
  ctx: ApplyContext,
  fieldName: string,
): { name: string; value: string } {
  if (typeof entry === 'string') {
    return { name: entry, value: ctx.secret(entry, { field: fieldName }) }
  }

  if ('value' in entry) {
    return { name: entry.name, value: entry.value }
  }

  const field = `${fieldName} entry "${entry.name}"`

  if ('secret' in entry) {
    return { name: entry.name, value: ctx.secret(entry.secret, { field }) }
  }

  return { name: entry.name, value: ctx.output(entry, field) }
}

/**
 * A binding override: which resource the named binding in the package's
 * wrangler config attaches to.
 *
 * `workerSecrets`/`workerVars` carry an imported output into the worker's ENV.
 * Neither can reach a BINDING, because a binding is a field inside the wrangler
 * config file and wrangler has no CLI flag for it — which is why four consumers
 * wrote a `d1` module and every one of them still hardcoded `database_id` in
 * `wrangler.jsonc`. So the module patches a generated copy of that file and
 * deploys with `--config`.
 *
 * The entry is generic on purpose: `type` is the wrangler config key holding
 * the binding array (`d1_databases`, `kv_namespaces`, `vectorize`, and dotted
 * for nested ones like `queues.producers`), and `field` is the key on the
 * matched entry to set (`database_id`, `id`, `bucket_name`, …). A new
 * Cloudflare resource type therefore needs no new key on this module — the
 * alternative was `cloudflare` absorbing one config key per resource type, and
 * per-type keys are how it started absorbing whole modules.
 *
 * Wrangler stays the source of truth for TOPOLOGY: the binding must already be
 * DECLARED in the package's own config (with any placeholder id), and this only
 * fills in the identifier the provisioning module just produced. A binding no
 * declaration matches is a hard error before wrangler runs.
 */
const bindingSchema = z.union([
  z.object({
    /** Wrangler config key holding the binding array, dotted for nested ones. */
    type: z.string(),
    /** The entry's `binding` (or, for arrays that use it, `name`) value. */
    binding: z.string(),
    /** Which key on that entry to set. */
    field: z.string(),
    /** Literal value, straight from this instance's config file. */
    value: z.string(),
  }),
  z.object({
    type: z.string(),
    binding: z.string(),
    field: z.string(),
    /** Instance name — must be listed in this instance's `imports`. */
    from: z.string(),
    /** Which output of that instance holds the value. */
    output: z.string(),
  }),
])

type BindingEntry = z.infer<typeof bindingSchema>

interface ResolvedBinding {
  type: string
  binding: string
  field: string
  value: string
  /** Which config key this came from — `bindings` or `r2Bindings` — so an
   * error points the operator at a key their instance file actually has. */
  label: string
}

function resolveBinding(entry: BindingEntry, ctx: ApplyContext): ResolvedBinding {
  const { type, binding, field } = entry
  const common = { type, binding, field, label: 'bindings' }
  if ('value' in entry) return { ...common, value: entry.value }
  return {
    ...common,
    value: ctx.output(entry, `bindings entry "${type}.${binding}.${field}"`),
  }
}

/**
 * The R2 shorthand for the above: `{ binding, bucketName }` or `{ binding,
 * from, output }`, desugared to `{ type: 'r2_buckets', field: 'bucket_name' }`.
 * It predates the general form and stays because instance files use it; it is
 * the only per-resource-type key, and no second one is coming.
 */
const r2BindingSchema = z.union([
  z.object({
    /** Binding name inside the Worker (the `binding` field in r2_buckets). */
    binding: z.string(),
    /** Literal bucket name. */
    bucketName: z.string(),
  }),
  z.object({
    binding: z.string(),
    /** Instance name — must be listed in this instance's `imports`. */
    from: z.string(),
    /** Which output of that instance holds the bucket name. */
    output: z.string(),
  }),
])

type R2BindingEntry = z.infer<typeof r2BindingSchema>

function resolveR2Binding(entry: R2BindingEntry, ctx: ApplyContext): ResolvedBinding {
  const common = {
    type: 'r2_buckets',
    binding: entry.binding,
    field: 'bucket_name',
    label: 'r2Bindings',
  }
  if ('bucketName' in entry) return { ...common, value: entry.bucketName }
  return { ...common, value: ctx.output(entry, `r2Bindings entry "${entry.binding}"`) }
}

/** Strip line and block comments from JSONC, string-aware. */
function stripJsoncComments(src: string): string {
  let out = ''
  let i = 0
  let inStr = false
  while (i < src.length) {
    const c = src[i]!
    if (inStr) {
      out += c
      if (c === '\\') {
        out += src[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** Remove trailing commas (`,}` / `,]`), string-aware — JSONC allows them. */
function stripTrailingCommas(src: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (inStr) {
      out += c
      if (c === '\\') {
        out += src[i + 1] ?? ''
        i++
        continue
      }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < src.length && /\s/.test(src[j]!)) j++
      if (src[j] === '}' || src[j] === ']') continue
    }
    out += c
  }
  return out
}

type BindingArrayEntry = Record<string, unknown>

/** Read a dotted path (`queues.producers`) out of one wrangler config block. */
function bindingArrayAt(
  block: Record<string, unknown>,
  type: string,
): BindingArrayEntry[] | undefined {
  let node: unknown = block
  for (const segment of type.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return Array.isArray(node) ? (node as BindingArrayEntry[]) : undefined
}

/**
 * Set each resolved binding's field on the declaration the deploy will
 * actually use.
 *
 * Which block that is turns on `wranglerEnv`, and it is not "both": wrangler's
 * binding keys (`d1_databases`, `r2_buckets`, `kv_namespaces`, `queues`,
 * `durable_objects`, …) are NOT inheritable, so a `--env preview` deploy reads
 * `env.preview`'s arrays and ignores the top-level ones entirely. Patching a
 * top-level declaration and reporting the binding as wired would ship a worker
 * with no such binding at all — wrangler only warns — which is the failure this
 * whole config key exists to prevent. So with `wranglerEnv` set, only that
 * env block is searched.
 *
 * Wrangler's binding arrays key on `binding`; `durable_objects.bindings` and
 * friends key on `name`, so an entry with no `binding` key is matched by
 * `name` instead. A binding no declaration matches is a hard config error.
 */
function patchBindings(
  config: Record<string, unknown>,
  resolved: ResolvedBinding[],
  wranglerEnv?: string,
): void {
  const envBlock = wranglerEnv
    ? (config.env as Record<string, Record<string, unknown>> | undefined)?.[wranglerEnv]
    : undefined
  const block = wranglerEnv ? envBlock : config
  const where = wranglerEnv
    ? `the "env.${wranglerEnv}" block of the package's wrangler config (binding keys are not inherited from the top level)`
    : `the package's wrangler config`
  for (const { type, binding, field, value, label } of resolved) {
    const entry = block
      ? bindingArrayAt(block, type)?.find(
          (e) => e.binding === binding || (e.binding === undefined && e.name === binding),
        )
      : undefined
    if (!entry) {
      throw new Error(`${label} entry "${binding}" has no matching ${type} binding in ${where}`)
    }
    entry[field] = value
  }
}

export const cloudflareModule = defineModule({
  name: 'cloudflare',
  configSchema: z.object({
    /** Package dir (relative to projectRoot) that holds wrangler.jsonc. */
    workdir: z.string(),
    /**
     * Cloudflare account id. Not a secret (it appears in the dashboard URL), so
     * it lives in config — only the API token is held in secrets.yaml.
     */
    accountId: z.string(),
    /**
     * Where the deploy credential comes from. Omit to read
     * `CLOUDFLARE_API_TOKEN` from this environment's secrets.yaml (the
     * original behavior). Set `{ from, output }` to pull it from an imported
     * instance's outputs instead — e.g. a `cloudflare-token` instance's
     * `tokenValue` — so a minted, per-apply-rolled deploy token flows straight
     * to wrangler and never sits at rest. `destroy` resolves it the same way:
     * the engine applies the imported instance on demand when a teardown asks
     * for its output, so an environment that destroys workers — an ephemeral
     * instance, or `zbc destroy preview` — needs no secrets.yaml fallback.
     */
    apiToken: z.object({ from: z.string(), output: z.string() }).optional(),
    /** Optional local build run before deploy (e.g. `vite build` for assets). */
    build: buildSchema.optional(),
    /**
     * Worker secrets to push after deploy. Each entry is either a plain name
     * — a key in this environment's secrets.yaml, becoming a Worker secret
     * binding of the same name (read at runtime as `env.<NAME>`) — a
     * `{ name, secret }` pair exposing a secrets.yaml key under a different
     * name, or a `{ name, from, output }` reference into an imported
     * instance's outputs.
     * Pushed via `wrangler secret put` with the value piped through stdin.
     */
    workerSecrets: z.array(workerValueSchema).default([]),
    /**
     * Worker vars to set at deploy time (`wrangler deploy --var KEY:VALUE`).
     * Same entry shape as `workerSecrets` — plain name (from secrets.yaml) or
     * `{ name, from, output }` — but for non-secret, publicly-visible config.
     * Unlike secrets, var values are passed on the command line, so never
     * route sensitive values through this field.
     */
    workerVars: z.array(workerValueSchema).default([]),
    /**
     * Override which R2 bucket each named `r2_buckets` binding attaches to.
     * Entries are `{ binding, bucketName }` literals or `{ binding, from,
     * output }` references into an imported instance's outputs (the r2 module
     * emits `bucketName`). Lets the package's wrangler config stay generic —
     * the per-project bucket lives here, next to the other identifiers.
     *
     * Shorthand for `bindings` below, which does the same for any binding
     * type; both go through one resolver, and a new resource type wants
     * `bindings`, not a second key like this one.
     */
    r2Bindings: z.array(r2BindingSchema).default([]),
    /**
     * Fill in a binding's identifier in the package's wrangler config from an
     * imported instance's outputs (or a literal), for ANY binding type:
     * `{ type: 'd1_databases', binding: 'DB', field: 'database_id', from:
     * 'app-db', output: 'databaseId' }`. `type` is the wrangler config key
     * holding the binding array (dotted for nested ones — `queues.producers`),
     * `field` the key on the matched entry to set.
     *
     * This is what `workerSecrets`/`workerVars` cannot do: those reach the
     * worker's ENV, and a binding lives in the config file wrangler reads. The
     * binding must already be DECLARED there (placeholder id and all) — only
     * the identifier comes from here, so wrangler keeps owning topology and a
     * typo'd binding is a hard error rather than a silently-added binding.
     */
    bindings: z.array(bindingSchema).default([]),
    /**
     * Name a Worker var after the deploy itself: the deployed commit
     * (`GITHUB_SHA` in CI, `git rev-parse HEAD` locally, `<sha>-dirty-<ms>` on
     * a working tree with changes), passed as `--var <name>:<id>` like any
     * other var. Unset — the default — injects nothing.
     *
     * It is worth a key of its own because a var is the ONLY channel a Worker
     * has for telling a container-backed payload that a deploy happened at all.
     * `immediateContainerRollout` below rolls the container application to the
     * new image and does not replace a running instance; a payload that reacts
     * to its environment (walgit fingerprints it in a Durable Object and
     * destroys the container when it moves) has nothing to react to when a
     * deploy changed only code. This gives it something: every deploy from a
     * new commit changes this value, and no deploy from the same commit does.
     *
     * Also the only place the deployed commit is written down — Cloudflare
     * numbers container versions itself (v50, v51) and nothing else in a deploy
     * names the code inside one.
     *
     * A var, so never a secret: it is a commit id, visible in the dashboard
     * beside every other var, which is half the point.
     *
     * A HARD ERROR when no id can be resolved (not CI, not a git checkout).
     * Silently omitting it would deploy the payload with no deploy marker,
     * which is exactly the invisible staleness the key exists to prevent. An
     * entry of the same name in `workerVars` takes precedence — the instance
     * pinning a value outranks the module deriving one.
     */
    deployIdVar: z.string().optional(),
    /**
     * For container-backed Workers: roll the CONTAINER APPLICATION to the new
     * image on deploy (`--containers-rollout immediate`) instead of wrangler's
     * gradual default. Set true whenever the image matters at deploy time.
     * No-op for asset-only Workers.
     *
     * WHAT IT DOES NOT DO — and the reason this paragraph exists — is replace a
     * RUNNING instance. It rolls the application to a new version; a single
     * always-warm, DO-bound instance is not drained by that rollout, and keeps
     * serving the old image until it idle-sleeps, which under sustained traffic
     * is never. Observed on walgit's 0.16.1 deploy (2026-09-14): the
     * application moved to v51 with a new image, the rollout reported
     * `completed`, and the instance answering git was the one started an hour
     * earlier — the fix in that release was not live.
     *
     * It also has nothing to roll for a deploy that changes only vars: no new
     * image, no new container version.
     *
     * So it is necessary and not sufficient. Replacing a running instance is
     * the payload's own job, and `deployIdVar` above is what lets it know it
     * has one to do.
     */
    immediateContainerRollout: z.boolean().default(false),
    /**
     * Wrangler named environment (`--env <name>`). When set, deploy targets the
     * matching `env.<name>` block in the package's wrangler.jsonc, so a
     * non-production zbc environment (e.g. `preview`) can ship a DISTINCT worker
     * (own name/domain/bindings) from the same package — without a separate
     * wrangler config. Omit for the top-level (production) worker.
     *
     * The secret push follows only when `workerName` is NOT set: with both,
     * wrangler's secret commands would concatenate the two into a
     * `<workerName>-<wranglerEnv>` script (see step 4 of `apply`), so `--name`
     * is passed alone and the push resolves the TOP-LEVEL wrangler config. An
     * `env.<name>` block that overrides `account_id` is therefore not honoured
     * on the push — put per-environment accounts in the instance's `accountId`.
     */
    wranglerEnv: z.string().optional(),
    /**
     * Override the deployed worker name (`--name <workerName>`). This is what
     * enables per-PR preview workers (e.g. `zbc-landing-pr-42`) from a single
     * wrangler.jsonc: the preview instance sets a PR-scoped name so each PR
     * lands on its own isolated worker + `*.workers.dev` URL. Omit to use the
     * `name` declared in wrangler.jsonc.
     */
    workerName: z.string().optional(),
    /**
     * Hostname patterns this worker answers, e.g. `zbc.zabaca.com/*`, emitted
     * as `--route`. The DNS record for the hostname is NOT created here: it
     * belongs to a `cloudflare-zone` instance, and this instance should import
     * that one so the record exists before the route is claimed.
     *
     * It lives in instance config rather than wrangler.jsonc, and that is the
     * whole point. Preview PRs deploy the SAME wrangler.jsonc under a
     * per-PR `workerName`, so a route declared in the file would be claimed by
     * every preview deploy too — and a Cloudflare route is unique per zone, so
     * the most recently deployed PR would take production's traffic, silently
     * and with no error anywhere. A preview instance omits `routes` and keeps
     * its `*.workers.dev` URL.
     *
     * Deliberately a route, not a wrangler "custom domain": a custom domain
     * has wrangler create its own managed DNS record, which the zone module
     * would then read as undeclared drift, and the two would argue on every
     * apply.
     */
    routes: z.array(z.string()).default([]),
  }),
  outputs: z.object({
    deployUrl: z.string(),
    /**
     * The deployed Worker's script name, parsed from wrangler's "Deployed
     * <name> triggers" confirmation. Lets dependents reference this worker
     * without repeating the name from wrangler.jsonc (e.g. cloudflare-email's
     * catchAll.workerName as `{ from, output: 'workerName' }`).
     */
    workerName: z.string(),
  }),
  async apply(config, ctx) {
    // Deploy credential: an imported instance's output (e.g. cloudflare-token's
    // tokenValue) when `apiToken` is set, else secrets.yaml. Resolved before
    // anything runs so a bad reference fails fast.
    const apiToken = config.apiToken
      ? ctx.output(config.apiToken, 'apiToken')
      : ctx.secret('CLOUDFLARE_API_TOKEN')

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: config.accountId,
    }

    const workdir = path.resolve(ctx.projectRoot, config.workdir)

    // 1. Optional local build (assets). Inherit stdio so build output streams.
    if (config.build) {
      const buildCwd = path.resolve(ctx.projectRoot, config.build.cwd ?? config.workdir)
      console.log(
        `  Building: ${config.build.command} (in ${path.relative(ctx.projectRoot, buildCwd) || '.'})`,
      )
      execSync(config.build.command, { cwd: buildCwd, stdio: 'inherit', env })
    }

    // 2. Resolve every workerVars/workerSecrets entry BEFORE deploy so a bad
    //    reference (unknown import, missing output/secret) fails fast, without
    //    leaving a deployed-but-unconfigured worker. `resolveWorkerValue` is
    //    pure — only the wrangler pushes below have side effects. --var values
    //    additionally ship as part of `wrangler deploy` itself (not a follow-up
    //    call); secrets are pushed after deploy (step 4) since the script must
    //    exist first.
    const resolvedVars = config.workerVars.map((entry) =>
      resolveWorkerValue(entry, ctx, 'workerVars'),
    )
    //    The deploy's own id, resolved here so a deploy with no id fails with
    //    every other unresolvable reference rather than at wrangler. Last,
    //    and skipped when `workerVars` already names it: a `--var` repeated
    //    twice is a value wrangler picks between, and the instance's own entry
    //    is the one that should win.
    if (config.deployIdVar && !resolvedVars.some((v) => v.name === config.deployIdVar)) {
      resolvedVars.push({
        name: config.deployIdVar,
        value: resolveDeployId(ctx.projectRoot, config.deployIdVar),
      })
    }
    const resolvedSecrets = config.workerSecrets.map((entry) =>
      resolveWorkerValue(entry, ctx, 'workerSecrets'),
    )
    const resolvedBindings = [
      ...config.r2Bindings.map((entry) => resolveR2Binding(entry, ctx)),
      ...config.bindings.map((entry) => resolveBinding(entry, ctx)),
    ]

    // 2b. bindings: wrangler has no CLI flag for binding identifiers, so patch
    //     a generated copy of the package's wrangler config and deploy with
    //     --config. Written next to the original so relative paths (main,
    //     assets dir) still resolve; comments don't survive the round-trip,
    //     but the file is throwaway (deleted after deploy).
    let generatedConfig: string | undefined
    if (resolvedBindings.length > 0) {
      const configPath = ['wrangler.jsonc', 'wrangler.json']
        .map((f) => path.join(workdir, f))
        .find((f) => fs.existsSync(f))
      if (!configPath) {
        throw new Error(
          `bindings require a wrangler.jsonc/wrangler.json in ${config.workdir} (wrangler.toml is not supported)`,
        )
      }
      const parsed = JSON.parse(
        stripTrailingCommas(stripJsoncComments(fs.readFileSync(configPath, 'utf8'))),
      ) as Record<string, unknown>
      patchBindings(parsed, resolvedBindings, config.wranglerEnv)
      generatedConfig = path.join(workdir, 'wrangler.zbc-generated.json')
      fs.writeFileSync(generatedConfig, JSON.stringify(parsed, null, 2))
    }

    // 3. Deploy. Creates/updates the Worker script (+ assets, DO, container).
    //    --env selects the named wrangler environment (e.g. preview) so it ships
    //    a distinct worker from the same package; --name overrides the worker
    //    name (per-PR preview workers); both omitted = the package's default.
    const deployArgs = ['deploy']
    if (generatedConfig) deployArgs.push('--config', generatedConfig)
    if (config.wranglerEnv) deployArgs.push('--env', config.wranglerEnv)
    if (config.workerName) deployArgs.push('--name', config.workerName)
    if (config.immediateContainerRollout) deployArgs.push('--containers-rollout', 'immediate')
    for (const route of config.routes) deployArgs.push('--route', route)
    for (const { name, value } of resolvedVars) deployArgs.push('--var', `${name}:${value}`)
    console.log(
      `  Deploying via wrangler (in ${config.workdir})${config.wranglerEnv ? ` [env: ${config.wranglerEnv}]` : ''}${config.workerName ? ` [name: ${config.workerName}]` : ''}${config.immediateContainerRollout ? ' [immediate container rollout]' : ''}${config.routes.length ? ` [routes: ${config.routes.join(', ')}]` : ''}${resolvedVars.length ? ` [vars: ${resolvedVars.map((v) => v.name).join(', ')}]` : ''}${resolvedBindings.length ? ` [bindings: ${resolvedBindings.map((b) => `${b.type}.${b.binding}.${b.field}→${b.value}`).join(', ')}]` : ''}`,
    )
    let out: string
    try {
      out = wrangler(workdir, deployArgs, env)
    } finally {
      if (generatedConfig) fs.rmSync(generatedConfig, { force: true })
    }
    // Success theater guard: wrangler can exit 0 without actually deploying
    // (the --bun incident above). Require the deploy confirmation line — and
    // capture the deployed script name from it for the workerName output.
    const deployedMatch = out.match(/Deployed\s+(\S+)\s+triggers/)
    if (!deployedMatch) {
      throw new Error(
        `wrangler deploy exited 0 but printed no "Deployed ... triggers" confirmation:\n${out}`,
      )
    }
    const workerName = deployedMatch[1]!
    // A routed worker has no workers.dev URL to print: wrangler DISABLES the
    // subdomain when routes are configured and `workers_dev` is not explicitly
    // true, and prints the routes instead. Falling back to the first route
    // keeps `deployUrl` meaning "where this worker answers" rather than going
    // empty the moment an app gets a real hostname.
    const urlMatch = out.match(/https:\/\/[^\s"',]+\.workers\.dev[^\s"',]*/)
    const deployUrl = urlMatch?.[0] ?? routeUrl(config.routes)
    console.log(`  Deployed: ${deployUrl || '(URL not parsed — see wrangler output)'}`)

    // 4. Push Worker secrets (after deploy: the script must exist first).
    //    Already resolved in step 2, so a misconfigured reference never reaches
    //    this point. Value piped via stdin so it never lands in a command
    //    string or the log.
    for (const { name, value } of resolvedSecrets) {
      // --name and --env are mutually exclusive HERE, unlike on deploy: the
      // secret commands resolve their target through wrangler's
      // `getLegacyScriptName`, which CONCATENATES the two —
      //   args.name && args.env ? `${args.name}-${args.env}` : args.name ?? config.name
      // — so passing both pushed every secret to `<workerName>-<wranglerEnv>`,
      // a script no deploy ever created. `secret put` then creates that name as
      // a DRAFT worker and exits 0, which is why it went unnoticed in
      // production twice. `--name` names the script outright, so it wins.
      const secretArgs = ['secret', 'put', name]
      if (config.workerName) secretArgs.push('--name', config.workerName)
      else if (config.wranglerEnv) secretArgs.push('--env', config.wranglerEnv)
      const secretOut = wrangler(workdir, secretArgs, env, value)
      // Same success-theater guard as the deploy above, for the same reason:
      // `secret put` exits 0 whether or not the script it targeted existed —
      // when it did not, wrangler CREATES it as a draft worker and reports
      // success. The exit code therefore says nothing about where the secret
      // landed; wrangler's own two lines do. (The value is never echoed by
      // wrangler, so quoting its output here cannot leak the secret.)
      if (!secretOut.includes(`Uploaded secret ${name}`)) {
        throw new Error(
          `wrangler secret put ${name} exited 0 but printed no "Uploaded secret ${name}" confirmation:\n${secretOut}`,
        )
      }
      // …and when wrangler names the script it wrote to, it must be the one the
      // deploy just confirmed. Two deliberate narrowings, both to fail only on
      // the real thing: checked only when the line is present (a wrangler that
      // stops printing it loses the check rather than failing every apply), and
      // only when `workerName` pins the script outright — without it the name
      // comes from the wrangler config, which is free to decorate it per
      // environment, and this would start reading as a mismatch.
      const targetMatch = config.workerName
        ? secretOut.match(/Creating the secret for the Worker "([^"]+)"/)
        : null
      if (targetMatch && targetMatch[1] !== workerName) {
        throw new Error(
          `wrangler pushed secret ${name} to Worker "${targetMatch[1]}", but the deploy created "${workerName}". The secret is on a different script than the code.`,
        )
      }
      console.log(`  Set Worker secret: ${name}`)
    }

    return { deployUrl, workerName }
  },
  async destroy(config, ctx) {
    // Resolved exactly the way `apply` resolves it. The engine applies the
    // referenced instance on demand when a destroy asks for its output, so the
    // twenty lines that used to live here — a swallowed catch around the
    // reference and a silent fall back to secrets.yaml, because destroy was
    // handed `imports: {}` — say nothing this line does not.
    const apiToken = config.apiToken
      ? ctx.output(config.apiToken, 'apiToken')
      : ctx.secret('CLOUDFLARE_API_TOKEN')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: config.accountId,
    }
    const workdir = path.resolve(ctx.projectRoot, config.workdir)
    // `wrangler delete` removes the Worker (and its DO/container). Non-fatal if
    // already gone. --env / --name target the same worker `apply` deployed
    // (named environment and/or per-PR preview name). Both flags together are
    // safe HERE, unlike on the secret push: `getLegacyScriptName` — the helper
    // that concatenates them — is called only by wrangler's `secret` family
    // (`put`/`delete`/`list`/`bulk` and their `versions secret` twins; verified
    // by reading wrangler 4.129.0's bundle), never by `deploy` or `delete`.
    try {
      const deleteArgs = ['delete', '--force']
      if (config.wranglerEnv) deleteArgs.push('--env', config.wranglerEnv)
      if (config.workerName) deleteArgs.push('--name', config.workerName)
      wrangler(workdir, deleteArgs, env)
      console.log('  Deleted Worker')
    } catch (err) {
      console.log(`  Worker delete skipped: ${(err as Error).message}`)
    }
  },
})
