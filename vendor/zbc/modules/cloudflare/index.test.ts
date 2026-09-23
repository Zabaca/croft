import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { cloudflareModule, routeUrl } from './index'

/**
 * End-to-end resolver tests for the cloudflare module.
 *
 * These exercise the REAL `apply`, not `resolveWorkerValue` in isolation: a stub
 * `wrangler` binary is dropped at `<workdir>/node_modules/.bin/wrangler` (which
 * `resolveWrangler` prefers over `bunx`), so every wrangler invocation — the
 * `deploy` and each `secret put` — is recorded to a log file. The tests assert
 * on what actually reached wrangler: `--var` flags on the deploy call, secret
 * values piped via stdin, and — for the fail-fast contract — that a bad
 * reference throws WITHOUT wrangler ever being run (no half-applied worker).
 */

/**
 * POSIX-sh stub. Records each call (argv + stdin) to $STUB_LOG, and prints what
 * wrangler 4.129.0 prints — including, crucially, WHICH SCRIPT each subcommand
 * resolved from the flags it was handed, since that is the thing under test:
 *
 *   - `deploy` → `Deployed <script> triggers` + a `<script>.workers.dev` URL,
 *     where `<script>` is `--name` when given, else `<config name>-<--env>`,
 *     else the config name (`my-worker`). `deploy` honours `--name` on its own.
 *   - `secret put` → `Creating the secret for the Worker "<script>"` and
 *     `Success! Uploaded secret <KEY>`, where `<script>` comes from wrangler's
 *     `getLegacyScriptName`: `name && env ? name-env : name ?? config.name`.
 *     That last rule is the bug being tested — a stub that ignored it would let
 *     a module passing BOTH flags look correct.
 *
 * `$STUB_SECRET_SILENT` makes `secret put` print nothing (exit 0 anyway, as
 * wrangler does when it silently creates a draft worker) and
 * `$STUB_SECRET_WORKER` forces the script in the `Creating …` line, so the
 * mismatch guard can be exercised against a module that is already correct.
 */
const STUB_WRANGLER = `#!/bin/sh
input="$(cat)"
{
  printf '<<<CALL\\n'
  printf 'argv=%s\\n' "$*"
  printf 'token=%s\\n' "$CLOUDFLARE_API_TOKEN"
  printf 'stdin=%s\\n' "$input"
  printf 'CALL>>>\\n'
} >> "$STUB_LOG"

# Recover the --name / --env this call was handed.
flag_name=""
flag_env=""
flag_config=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --name) flag_name="$arg" ;;
    --env) flag_env="$arg" ;;
    --config) flag_config="$arg" ;;
  esac
  prev="$arg"
done

# Record the config file wrangler was actually handed, contents and all: the
# generated copy is deleted the moment deploy returns, so this log is the only
# place the patched bindings can be observed from outside the module.
if [ -n "$flag_config" ]; then
  {
    printf '<<<CFG\n'
    cat "$flag_config"
    printf '\nCFG>>>\n'
  } >> "$STUB_LOG"
fi

if [ "$1" = "deploy" ]; then
  # deploy: --name wins outright; otherwise the legacy <config name>-<env>.
  if [ -n "$flag_name" ]; then script="$flag_name"
  elif [ -n "$flag_env" ]; then script="my-worker-$flag_env"
  else script=my-worker
  fi
  printf 'Total Upload: 1 KiB / gzip: 1 KiB\\n'
  printf 'Deployed %s triggers (1.23 sec)\\n' "$script"
  printf 'https://%s.workers.dev\\n' "$script"
fi

if [ "$1" = "secret" ] && [ "$2" = "put" ] && [ -z "$STUB_SECRET_SILENT" ]; then
  # secret put: wrangler's getLegacyScriptName CONCATENATES name and env.
  if [ -n "$flag_name" ] && [ -n "$flag_env" ]; then script="$flag_name-$flag_env"
  elif [ -n "$flag_name" ]; then script="$flag_name"
  elif [ -n "$flag_env" ]; then script="my-worker-$flag_env"
  else script=my-worker
  fi
  [ -z "$STUB_SECRET_WORKER" ] || script="$STUB_SECRET_WORKER"
  printf 'Creating the secret for the Worker "%s"\\n' "$script"
  printf 'Success! Uploaded secret %s\\n' "$3"
fi
exit 0
`

interface WranglerCall {
  argv: string[]
  token: string
  stdin: string
}

/** Parse the stub's log into an ordered list of `{ argv, token, stdin }` calls. */
function parseCalls(log: string): WranglerCall[] {
  const calls: WranglerCall[] = []
  const re = /<<<CALL\nargv=(.*)\ntoken=(.*)\nstdin=([\s\S]*?)\nCALL>>>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(log)) !== null) {
    calls.push({ argv: m[1].length ? m[1].split(' ') : [], token: m[2], stdin: m[3] })
  }
  return calls
}

/**
 * The `--config` files the stub was handed, parsed, in call order. Plain JSON:
 * the module writes the generated copy with `JSON.stringify`, so comments and
 * trailing commas are already gone by the time wrangler sees it.
 */
function parseConfigs(log: string): Array<Record<string, unknown>> {
  const configs: Array<Record<string, unknown>> = []
  const re = /<<<CFG\n([\s\S]*?)\nCFG>>>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(log)) !== null) {
    configs.push(JSON.parse(m[1]) as Record<string, unknown>)
  }
  return configs
}

const createdRoots: string[] = []
const stubEnvKeys = new Set<string>()

afterEach(() => {
  delete process.env.STUB_LOG
  for (const key of stubEnvKeys) delete process.env[key]
  stubEnvKeys.clear()
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** Run `apply` against a fresh stubbed workdir; capture calls even on throw. */
async function runApply(opts: {
  config?: Record<string, unknown>
  secrets?: Record<string, string>
  /** Replace the secrets map entirely (no default CLOUDFLARE_API_TOKEN). */
  bareSecrets?: Record<string, string>
  imports?: Record<string, unknown>
  /** Extra env for the stub (STUB_SECRET_SILENT / STUB_SECRET_WORKER). */
  stubEnv?: Record<string, string>
  /** Written to `<workdir>/wrangler.jsonc` — the package's own wrangler config. */
  wranglerConfig?: string
  /** Run against the freshly-created project root before `apply` (e.g. `git init`). */
  prepare?: (root: string) => void
}): Promise<{
  result?: { deployUrl: string }
  error?: Error
  calls: WranglerCall[]
  configs: Array<Record<string, unknown>>
  root: string
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-stub-'))
  createdRoots.push(root)
  const binDir = path.join(root, 'node_modules', '.bin')
  fs.mkdirSync(binDir, { recursive: true })
  const stubPath = path.join(binDir, 'wrangler')
  fs.writeFileSync(stubPath, STUB_WRANGLER, { mode: 0o755 })
  fs.chmodSync(stubPath, 0o755)

  if (opts.wranglerConfig !== undefined) {
    fs.writeFileSync(path.join(root, 'wrangler.jsonc'), opts.wranglerConfig)
  }

  const logPath = path.join(root, 'calls.log')
  process.env.STUB_LOG = logPath
  for (const [k, v] of Object.entries(opts.stubEnv ?? {})) {
    process.env[k] = v
    stubEnvKeys.add(k)
  }

  // Parse through the schema so defaults (workerSecrets/workerVars → []) and the
  // union validation apply exactly as the engine would.
  const config = cloudflareModule.configSchema.parse({
    workdir: '.',
    accountId: 'acct-1',
    ...opts.config,
  })
  const ctx = {
    secrets: opts.bareSecrets ?? { CLOUDFLARE_API_TOKEN: 'cf-token', ...opts.secrets },
    imports: opts.imports ?? {},
    projectRoot: root,
  }
  opts.prepare?.(root)

  let result: { deployUrl: string } | undefined
  let error: Error | undefined
  try {
    result = (await cloudflareModule.apply(config, ctx)) as { deployUrl: string }
  } catch (e) {
    error = e as Error
  }
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  return { result, error, calls: parseCalls(log), configs: parseConfigs(log), root }
}

/** Run `destroy` against the same stubbed workdir; capture calls even on throw. */
async function runDestroy(opts: {
  config?: Record<string, unknown>
  secrets?: Record<string, string>
  bareSecrets?: Record<string, string>
  imports?: Record<string, unknown>
}): Promise<{ error?: Error; calls: WranglerCall[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-stub-'))
  createdRoots.push(root)
  const binDir = path.join(root, 'node_modules', '.bin')
  fs.mkdirSync(binDir, { recursive: true })
  const stubPath = path.join(binDir, 'wrangler')
  fs.writeFileSync(stubPath, STUB_WRANGLER, { mode: 0o755 })
  fs.chmodSync(stubPath, 0o755)

  const logPath = path.join(root, 'calls.log')
  process.env.STUB_LOG = logPath

  const config = cloudflareModule.configSchema.parse({
    workdir: '.',
    accountId: 'acct-1',
    ...opts.config,
  })
  const ctx = {
    secrets: opts.bareSecrets ?? { CLOUDFLARE_API_TOKEN: 'cf-token', ...opts.secrets },
    imports: opts.imports ?? {},
    projectRoot: root,
  }

  let error: Error | undefined
  try {
    await cloudflareModule.destroy!(config, ctx)
  } catch (e) {
    error = e as Error
  }
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  return { error, calls: parseCalls(log) }
}

const deployCall = (calls: WranglerCall[]) => calls.find((c) => c.argv[0] === 'deploy')
const secretCalls = (calls: WranglerCall[]) =>
  calls.filter((c) => c.argv[0] === 'secret' && c.argv[1] === 'put')

describe('cloudflare apply — sanity', () => {
  test('the stub binary is actually invoked (deploy + URL parsed)', async () => {
    const { result, error, calls } = await runApply({})
    expect(error).toBeUndefined()
    expect(result?.deployUrl).toBe('https://my-worker.workers.dev')
    expect(deployCall(calls)).toBeDefined()
    expect(secretCalls(calls)).toHaveLength(0)
  })
})

describe('cloudflare apply — plain-name resolution (secrets.yaml)', () => {
  test('workerSecrets plain name → secret put with value piped via stdin', async () => {
    const { error, calls } = await runApply({
      config: { workerSecrets: ['MY_SECRET'] },
      secrets: { MY_SECRET: 's3cr3t' },
    })
    expect(error).toBeUndefined()
    const secrets = secretCalls(calls)
    expect(secrets).toHaveLength(1)
    expect(secrets[0].argv).toEqual(['secret', 'put', 'MY_SECRET'])
    expect(secrets[0].stdin).toBe('s3cr3t')
    // Secret value never rides on the deploy command line.
    expect(deployCall(calls)?.argv.join(' ')).not.toContain('s3cr3t')
  })

  test('workerVars plain name → --var NAME:VALUE on the deploy call', async () => {
    const { error, calls } = await runApply({
      config: { workerVars: ['PUBLIC_CFG'] },
      secrets: { PUBLIC_CFG: 'hello' },
    })
    expect(error).toBeUndefined()
    const deploy = deployCall(calls)
    const i = deploy!.argv.indexOf('--var')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(deploy!.argv[i + 1]).toBe('PUBLIC_CFG:hello')
    expect(secretCalls(calls)).toHaveLength(0)
  })
})

describe('cloudflare apply — import-reference resolution (ctx.imports)', () => {
  test('workerVars { name, from, output } → resolved value as --var under NAME', async () => {
    const { error, calls } = await runApply({
      config: { workerVars: [{ name: 'DB_URL', from: 'main-db', output: 'databaseUrl' }] },
      imports: { 'main-db': { databaseUrl: 'libsql://x.turso.io', authToken: 'tok' } },
    })
    expect(error).toBeUndefined()
    const deploy = deployCall(calls)
    const i = deploy!.argv.indexOf('--var')
    // A colon-bearing value (libsql:// URL) must survive intact after NAME:.
    expect(deploy!.argv[i + 1]).toBe('DB_URL:libsql://x.turso.io')
  })

  test('workerSecrets { name, from, output } → secret put NAME with value via stdin', async () => {
    const { error, calls } = await runApply({
      config: { workerSecrets: [{ name: 'DB_TOKEN', from: 'main-db', output: 'authToken' }] },
      imports: { 'main-db': { databaseUrl: 'libsql://x.turso.io', authToken: 'tok-123' } },
    })
    expect(error).toBeUndefined()
    const secrets = secretCalls(calls)
    expect(secrets).toHaveLength(1)
    expect(secrets[0].argv).toEqual(['secret', 'put', 'DB_TOKEN'])
    expect(secrets[0].stdin).toBe('tok-123')
    // An imported auth token must not leak onto the deploy command line.
    expect(deployCall(calls)?.argv.join(' ')).not.toContain('tok-123')
  })
})

describe('cloudflare apply — apiToken from an imported instance', () => {
  test('apiToken { from, output } → wrangler runs with the imported value, not secrets.yaml', async () => {
    const { error, calls } = await runApply({
      config: { apiToken: { from: 'deploy-token', output: 'tokenValue' } },
      imports: { 'deploy-token': { tokenValue: 'minted-tok', tokenId: 'tok-1' } },
    })
    expect(error).toBeUndefined()
    const deploy = deployCall(calls)
    expect(deploy?.token).toBe('minted-tok')
  })

  test('omitted apiToken keeps the secrets.yaml fallback', async () => {
    const { error, calls } = await runApply({})
    expect(error).toBeUndefined()
    expect(deployCall(calls)?.token).toBe('cf-token')
  })

  test('apiToken referencing an instance not in imports → fail-fast, no wrangler', async () => {
    const { error, calls } = await runApply({
      config: { apiToken: { from: 'ghost', output: 'tokenValue' } },
      imports: {},
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('ghost')
    expect(error!.message).toContain('apiToken')
    expect(calls).toHaveLength(0)
  })

  test('apiToken referencing an output the instance does not emit → fail-fast', async () => {
    const { error, calls } = await runApply({
      config: { apiToken: { from: 'deploy-token', output: 'missing' } },
      imports: { 'deploy-token': { tokenValue: 'minted-tok' } },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('missing')
    expect(error!.message).toContain('deploy-token')
    expect(calls).toHaveLength(0)
  })

  test('no apiToken config and no CLOUDFLARE_API_TOKEN secret → clear error, no wrangler', async () => {
    const { error, calls } = await runApply({ bareSecrets: {} })
    expect(error).toBeDefined()
    expect(error!.message).toContain('CLOUDFLARE_API_TOKEN')
    expect(calls).toHaveLength(0)
  })
})

describe('cloudflare apply — hard errors are fail-fast (no wrangler runs)', () => {
  test('reference to an instance not in imports throws, naming both', async () => {
    const { error, calls } = await runApply({
      config: { workerVars: [{ name: 'X', from: 'ghost', output: 'y' }] },
      imports: {},
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('ghost')
    expect(error!.message).toContain('X')
    expect(error!.message).toContain('imports')
    expect(calls).toHaveLength(0) // fail-fast: wrangler never ran
  })

  test('reference to an output the instance does not emit throws, naming both', async () => {
    const { error, calls } = await runApply({
      config: { workerSecrets: [{ name: 'X', from: 'main-db', output: 'missing' }] },
      imports: { 'main-db': { databaseUrl: 'libsql://x.turso.io' } },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('missing')
    expect(error!.message).toContain('main-db')
    // Regression guard: a bad workerSecrets ref must NOT deploy first.
    expect(calls).toHaveLength(0)
  })

  test('plain name missing from secrets.yaml throws before deploy', async () => {
    const { error, calls } = await runApply({
      config: { workerSecrets: ['NOPE'] },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('NOPE')
    expect(error!.message).toContain('secrets.yaml')
    expect(calls).toHaveLength(0)
  })
})

// Guard: the stub must be a POSIX-sh script so spawnSync can exec it directly.
test('stub wrangler is executable on this platform', () => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-probe-'))
  try {
    const p = path.join(probe, 'wrangler')
    fs.writeFileSync(p, STUB_WRANGLER, { mode: 0o755 })
    fs.chmodSync(p, 0o755)
    const out = execSync(`STUB_LOG=/dev/null ${p} deploy`, { encoding: 'utf8' })
    expect(out).toMatch(/Deployed\s+\S+\s+triggers/)
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
})

describe('routeUrl', () => {
  test('names the origin a concrete route answers on', () => {
    expect(routeUrl(['zbc.zabaca.com/*'])).toBe('https://zbc.zabaca.com')
    expect(routeUrl(['zbc.zabaca.com/api/*'])).toBe('https://zbc.zabaca.com')
  })

  test('a wildcard host is a set, not an address', () => {
    // `https://*.example.com` looks like a URL and resolves to nothing, so a
    // dependent reading deployUrl would get a string it cannot fetch.
    expect(routeUrl(['*.example.com/*'])).toBe('')
    expect(routeUrl(['*.example.com/*', 'real.example.com/*'])).toBe('https://real.example.com')
  })

  test('no routes means no url, not a fabricated one', () => {
    expect(routeUrl([])).toBe('')
  })
})

/**
 * Teardown resolves its credential the same way `apply` does.
 *
 * It used to be twenty lines that could not: the engine handed `destroy` an
 * empty `imports`, so the `apiToken` reference was wrapped in a swallowed catch
 * and fell back to a `CLOUDFLARE_API_TOKEN` in secrets.yaml — a second copy at
 * rest of a credential `cloudflare-token` mints fresh and never persists. The
 * engine now applies the referenced instance on demand, so the reference is the
 * answer and the fallback is gone.
 */
describe('cloudflare destroy — the same credential rule as apply', () => {
  test('an apiToken reference is used, not secrets.yaml', async () => {
    const { error, calls } = await runDestroy({
      config: { apiToken: { from: 'deploy-token', output: 'tokenValue' } },
      imports: { 'deploy-token': { tokenValue: 'minted-tok' } },
      secrets: { CLOUDFLARE_API_TOKEN: 'stale-from-secrets' },
    })
    expect(error).toBeUndefined()
    expect(calls[0]?.argv[0]).toBe('delete')
    expect(calls[0]?.token).toBe('minted-tok')
  })

  test('an unresolvable apiToken reference fails by name — it no longer falls back', async () => {
    const { error, calls } = await runDestroy({
      config: { apiToken: { from: 'deploy-token', output: 'tokenValue' } },
      imports: {},
      secrets: { CLOUDFLARE_API_TOKEN: 'stale-from-secrets' },
    })
    expect(error?.message).toContain('deploy-token')
    expect(error?.message).toContain('apiToken')
    expect(calls).toHaveLength(0)
  })

  test('no apiToken config still reads secrets.yaml', async () => {
    const { error, calls } = await runDestroy({})
    expect(error).toBeUndefined()
    expect(calls[0]?.token).toBe('cf-token')
  })

  test('no apiToken config and no secret names the secret, and deletes nothing', async () => {
    const { error, calls } = await runDestroy({ bareSecrets: {} })
    expect(error?.message).toContain('CLOUDFLARE_API_TOKEN')
    expect(calls).toHaveLength(0)
  })
})

/**
 * Which script a secret lands on.
 *
 * wrangler's secret commands resolve their target through `getLegacyScriptName`
 * — `args.name && args.env ? `${args.name}-${args.env}` : args.name ?? config.name`
 * — so passing BOTH flags targets `<workerName>-<wranglerEnv>`, a script no
 * deploy ever created. `deploy` and `delete` do not go through that function and
 * honour `--name` on its own, which is why only the secret push was wrong.
 */
describe('cloudflare apply — a secret lands on the script that was deployed', () => {
  test('workerName + wranglerEnv → secret put targets --name alone', async () => {
    const { error, calls } = await runApply({
      config: {
        workerName: 'foothill-metabolic',
        wranglerEnv: 'production',
        workerSecrets: ['GCAL_TOKEN'],
      },
      secrets: { GCAL_TOKEN: 'g-tok' },
    })
    expect(error).toBeUndefined()
    const secret = secretCalls(calls)[0]
    // Both flags together would target `foothill-metabolic-production`.
    expect(secret.argv).toEqual(['secret', 'put', 'GCAL_TOKEN', '--name', 'foothill-metabolic'])
    // The deploy call is unchanged: `deploy` honours --name alongside --env.
    expect(deployCall(calls)!.argv).toContain('--env')
    expect(deployCall(calls)!.argv).toContain('--name')
  })

  // Regression guard rather than fix coverage: with no workerName the argv is
  // what it always was. It is here because the fix reorders the two branches,
  // and this is the branch that must keep working.
  test('wranglerEnv alone still selects the named environment', async () => {
    const { error, calls } = await runApply({
      config: { wranglerEnv: 'preview', workerSecrets: ['MY_SECRET'] },
      secrets: { MY_SECRET: 's3cr3t' },
    })
    expect(error).toBeUndefined()
    expect(secretCalls(calls)[0].argv).toEqual(['secret', 'put', 'MY_SECRET', '--env', 'preview'])
  })
})

/**
 * The success-theater guard the deploy path already had, on the secret push.
 *
 * `wrangler secret put` exits 0 even when the script it targeted does not
 * exist — it creates a draft worker and reports success — so the exit code
 * alone says nothing about where the secret landed.
 */
describe('cloudflare apply — a silent secret push is a failed apply', () => {
  test('secret put exits 0 with no confirmation → apply throws, naming the secret', async () => {
    const { error } = await runApply({
      config: { workerSecrets: ['MY_SECRET'] },
      secrets: { MY_SECRET: 's3cr3t' },
      stubEnv: { STUB_SECRET_SILENT: '1' },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('MY_SECRET')
  })

  test('secret put reporting a different worker than the deploy → apply throws, naming both', async () => {
    const { error } = await runApply({
      config: { workerName: 'foothill-metabolic', workerSecrets: ['GCAL_TOKEN'] },
      secrets: { GCAL_TOKEN: 'g-tok' },
      // The deploy created `foothill-metabolic`; wrangler reports it wrote the
      // secret to the name the OLD both-flags call would have produced. The
      // module cannot generate this any more, so the stub forces it — the guard
      // is what stands between a future regression and another silent apply.
      stubEnv: { STUB_SECRET_WORKER: 'foothill-metabolic-production' },
    })
    expect(error).toBeDefined()
    // Names the script it wrote to, the script the deploy created, and the key.
    expect(error!.message).toContain('"foothill-metabolic-production"')
    expect(error!.message).toContain('"foothill-metabolic"')
    expect(error!.message).toContain('GCAL_TOKEN')
  })
})

/**
 * Bindings: an imported instance's output reaching the file wrangler reads.
 *
 * `workerSecrets`/`workerVars` carry an output into the worker's ENV; neither
 * can reach a BINDING, because a binding is a field in the wrangler config and
 * wrangler has no CLI flag for it. Four consumers wrote a `d1` module and every
 * one still hardcoded `database_id` in `wrangler.jsonc` for exactly that reason.
 *
 * These assert on the config file the stub was actually handed — the generated
 * copy is deleted the moment deploy returns, so the log is the only outside
 * view of it.
 */
describe('cloudflare apply — bindings resolve into the wrangler config', () => {
  const D1_CONFIG = `{
  // A package's own wrangler config declares the binding; the id is not its business.
  "name": "my-worker",
  "d1_databases": [{ "binding": "DB", "database_name": "app", "database_id": "PLACEHOLDER" }],
}`

  test('{ type, binding, field, from, output } sets the field from the import', async () => {
    const { error, calls, configs } = await runApply({
      wranglerConfig: D1_CONFIG,
      config: {
        bindings: [
          {
            type: 'd1_databases',
            binding: 'DB',
            field: 'database_id',
            from: 'app-db',
            output: 'databaseId',
          },
        ],
      },
      imports: { 'app-db': { databaseId: 'ffb0c2f6-1e2a-4c1e-9a4a-6f0a2c8d1111' } },
    })
    expect(error).toBeUndefined()
    expect(configs).toHaveLength(1)
    const d1 = configs[0].d1_databases as Array<Record<string, string>>
    expect(d1[0].database_id).toBe('ffb0c2f6-1e2a-4c1e-9a4a-6f0a2c8d1111')
    // Everything else about the package's config survives the round-trip.
    expect(d1[0].database_name).toBe('app')
    expect(configs[0].name).toBe('my-worker')
    // The deploy read the generated copy, and it is gone afterwards.
    const deploy = deployCall(calls)!
    const cfgPath = deploy.argv[deploy.argv.indexOf('--config') + 1]
    expect(cfgPath).toBeDefined()
    expect(fs.existsSync(cfgPath)).toBe(false)
  })

  test('a literal value needs no import, and a dotted type reaches a nested array', async () => {
    const { error, configs } = await runApply({
      wranglerConfig: `{
  "name": "my-worker",
  "queues": { "producers": [{ "binding": "JOBS", "queue": "PLACEHOLDER" }] },
}`,
      config: {
        bindings: [
          {
            type: 'queues.producers',
            binding: 'JOBS',
            field: 'queue',
            value: 'zbc-jobs-preview-pr-42',
          },
        ],
      },
    })
    expect(error).toBeUndefined()
    const producers = (configs[0].queues as { producers: Array<Record<string, string>> }).producers
    expect(producers[0].queue).toBe('zbc-jobs-preview-pr-42')
  })

  test('a binding the package does not declare fails before wrangler runs', async () => {
    const { error, calls } = await runApply({
      wranglerConfig: `{ "name": "my-worker", "d1_databases": [{ "binding": "DB" }] }`,
      config: {
        bindings: [{ type: 'd1_databases', binding: 'TYPO', field: 'database_id', value: 'db-1' }],
      },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('TYPO')
    expect(error!.message).toContain('d1_databases')
    expect(calls).toHaveLength(0)
  })

  test('an unresolvable reference fails before wrangler runs, naming the instance', async () => {
    const { error, calls } = await runApply({
      wranglerConfig: `{ "name": "my-worker", "d1_databases": [{ "binding": "DB" }] }`,
      config: {
        bindings: [
          {
            type: 'd1_databases',
            binding: 'DB',
            field: 'database_id',
            from: 'ghost',
            output: 'databaseId',
          },
        ],
      },
      imports: {},
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('ghost')
    expect(error!.message).toContain('d1_databases')
    expect(calls).toHaveLength(0)
  })

  test('r2Bindings still patches r2_buckets[].bucket_name — same code path', async () => {
    const { error, configs } = await runApply({
      wranglerConfig: `{
  // comments and trailing commas survive being read, not being written
  "name": "my-worker",
  "r2_buckets": [{ "binding": "RAW", "bucket_name": "PLACEHOLDER" },],
}`,
      config: { r2Bindings: [{ binding: 'RAW', from: 'inbox-raw', output: 'bucketName' }] },
      imports: { 'inbox-raw': { bucketName: 'zbc-inbox-raw' } },
    })
    expect(error).toBeUndefined()
    const buckets = configs[0].r2_buckets as Array<Record<string, string>>
    expect(buckets[0].bucket_name).toBe('zbc-inbox-raw')
  })

  test('an array that keys on `name` (durable_objects) is matched by name', async () => {
    const { error, configs } = await runApply({
      wranglerConfig: `{
  "name": "my-worker",
  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "Room" }] },
}`,
      config: {
        bindings: [
          {
            type: 'durable_objects.bindings',
            binding: 'ROOM',
            field: 'script_name',
            value: 'zbc-rooms',
          },
        ],
      },
    })
    expect(error).toBeUndefined()
    const dos = (configs[0].durable_objects as { bindings: Array<Record<string, string>> }).bindings
    expect(dos[0].script_name).toBe('zbc-rooms')
    expect(dos[0].class_name).toBe('Room')
  })

  /**
   * Wrangler's binding keys are NOT inheritable: `d1_databases`, `r2_buckets`,
   * `kv_namespaces`, `queues` and friends declared at the top level are not
   * merged into `env.<name>`. Patching the top-level entry and deploying with
   * `--env` would therefore ship a worker with no such binding at all —
   * wrangler only warns — while this module printed the binding as wired.
   */
  test('with wranglerEnv, a binding declared only at the top level is an error', async () => {
    const { error, calls } = await runApply({
      wranglerConfig: `{
  "name": "my-worker",
  "d1_databases": [{ "binding": "DB", "database_id": "PLACEHOLDER" }],
  "env": { "preview": {} },
}`,
      config: {
        wranglerEnv: 'preview',
        bindings: [
          { type: 'd1_databases', binding: 'DB', field: 'database_id', value: 'preview-db-id' },
        ],
      },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('DB')
    expect(error!.message).toContain('d1_databases')
    expect(error!.message).toContain('preview')
    expect(calls).toHaveLength(0)
  })

  test('an unmatched r2Bindings entry names r2Bindings, not the key it came from', async () => {
    const { error, calls } = await runApply({
      wranglerConfig: `{ "name": "my-worker", "r2_buckets": [{ "binding": "RAW_BUCKET" }] }`,
      config: { r2Bindings: [{ binding: 'RAW', bucketName: 'zbc-inbox-raw' }] },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('r2Bindings')
    expect(error!.message).toContain('RAW')
    expect(calls).toHaveLength(0)
  })

  test('with wranglerEnv, a binding declared only in that env block is patched', async () => {
    const { error, configs } = await runApply({
      wranglerConfig: `{
  "name": "my-worker",
  "env": { "preview": { "d1_databases": [{ "binding": "DB", "database_id": "PLACEHOLDER" }] } },
}`,
      config: {
        wranglerEnv: 'preview',
        bindings: [
          { type: 'd1_databases', binding: 'DB', field: 'database_id', value: 'preview-db-id' },
        ],
      },
    })
    expect(error).toBeUndefined()
    const env = configs[0].env as { preview: { d1_databases: Array<Record<string, string>> } }
    expect(env.preview.d1_databases[0].database_id).toBe('preview-db-id')
  })
})

/**
 * `deployIdVar` — the var that makes an image-only deploy visible.
 *
 * GITHUB_SHA is cleared for the whole block and restored afterwards: this suite
 * runs in GitHub Actions too, where it is set, and two of these tests are about
 * what happens when it is NOT.
 */
describe('cloudflare apply — deployIdVar names the deploy', () => {
  const realSha = process.env.GITHUB_SHA
  beforeEach(() => {
    delete process.env.GITHUB_SHA
  })
  afterEach(() => {
    if (realSha === undefined) delete process.env.GITHUB_SHA
    else process.env.GITHUB_SHA = realSha
  })

  test('GITHUB_SHA reaches the deploy as --var under the configured name', async () => {
    const { error, calls } = await runApply({
      config: { deployIdVar: 'WALGIT_BUILD_ID' },
      stubEnv: { GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567' },
    })

    expect(error).toBeUndefined()
    expect(deployCall(calls)?.argv).toContain(
      'WALGIT_BUILD_ID:0123456789abcdef0123456789abcdef01234567',
    )
  })

  test('unset, nothing is injected — an existing instance deploys exactly as before', async () => {
    const { error, calls } = await runApply({
      config: { workerVars: [{ name: 'WALGIT_PUBLIC', value: '1' }] },
      stubEnv: { GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567' },
    })

    expect(error).toBeUndefined()
    expect(deployCall(calls)?.argv.filter((a) => a === '--var')).toHaveLength(1)
    expect(deployCall(calls)?.argv).toContain('WALGIT_PUBLIC:1')
  })

  test('it rides alongside the declared vars rather than replacing them', async () => {
    const { error, calls } = await runApply({
      config: {
        deployIdVar: 'WALGIT_BUILD_ID',
        workerVars: [{ name: 'WALGIT_PUBLIC', value: '1' }],
      },
      stubEnv: { GITHUB_SHA: 'abc123' },
    })

    expect(error).toBeUndefined()
    expect(deployCall(calls)?.argv).toContain('WALGIT_PUBLIC:1')
    expect(deployCall(calls)?.argv).toContain('WALGIT_BUILD_ID:abc123')
  })

  test('a declared var of the same name wins, and is not deployed twice', async () => {
    // Two `--var` flags with one name is a value the deploy picks between, so
    // the instance's own entry is the one that ships.
    const { error, calls } = await runApply({
      config: {
        deployIdVar: 'WALGIT_BUILD_ID',
        workerVars: [{ name: 'WALGIT_BUILD_ID', value: 'pinned-by-the-instance' }],
      },
      stubEnv: { GITHUB_SHA: 'abc123' },
    })

    expect(error).toBeUndefined()
    expect(deployCall(calls)?.argv).toContain('WALGIT_BUILD_ID:pinned-by-the-instance')
    expect(deployCall(calls)?.argv).not.toContain('WALGIT_BUILD_ID:abc123')
  })

  /**
   * A one-commit repository whose only tracked file is a `.gitignore` ignoring
   * everything else — so the stub binary and the call log the harness drops in
   * beside it do not read as a dirty tree.
   */
  const gitInit = (repo: string) => {
    fs.writeFileSync(path.join(repo, '.gitignore'), '*\n')
    execSync('git init -q && git add -f .gitignore && git commit -q -m first', {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
      shell: '/bin/sh',
    })
  }

  test('outside CI the deployed commit comes from git', async () => {
    // The local path: no GITHUB_SHA, and `git rev-parse HEAD` in the project
    // root answers. The expected value comes from git itself rather than being
    // recomputed the way the module computes it.
    const { error, calls, root } = await runApply({
      config: { deployIdVar: 'WALGIT_BUILD_ID' },
      prepare: gitInit,
    })
    const head = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim()

    expect(error).toBeUndefined()
    expect(deployCall(calls)?.argv).toContain(`WALGIT_BUILD_ID:${head}`)
  })

  test('a working tree with changes deploys a distinct id, not the bare commit', async () => {
    // A local apply builds the image from the WORKING TREE, so a dirty tree is
    // a different image under the same commit. Reusing the bare sha there would
    // be the exact bug this key exists to close.
    const { error, calls, root } = await runApply({
      config: { deployIdVar: 'WALGIT_BUILD_ID' },
      prepare: (repo) => {
        gitInit(repo)
        // A modification to the one TRACKED file, so the tree is dirty by
        // git's own account and not merely cluttered.
        fs.appendFileSync(path.join(repo, '.gitignore'), '# edited\n')
      },
    })
    const head = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim()

    expect(error).toBeUndefined()
    const injected = deployCall(calls)?.argv.find((a) => a.startsWith('WALGIT_BUILD_ID:'))
    expect(injected).toStartWith(`WALGIT_BUILD_ID:${head}-dirty-`)
  })

  test('no CI sha and no git repository fails before wrangler runs', async () => {
    // Fail fast, like every other unresolvable reference here: a deploy that
    // silently omitted the var would leave the old container serving, which is
    // the failure nobody notices.
    const { error, calls } = await runApply({ config: { deployIdVar: 'WALGIT_BUILD_ID' } })

    expect(error?.message).toContain('deployIdVar')
    expect(error?.message).toContain('WALGIT_BUILD_ID')
    expect(error?.message).toContain('GITHUB_SHA')
    expect(calls).toHaveLength(0)
  })
})
