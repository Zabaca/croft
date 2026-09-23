import { z } from 'zod'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { type ExecResult, exec, execStatus } from '../host-exec'
import { type IncusTarget, guestRef, incusCommand, incusTargetSchema } from '../incus-core'
import { defineModule } from '../../src/define-module'

// Creates an Incus guest — a system container (cheap, shared kernel) or a full
// KVM virtual machine (`type: 'virtual-machine'`) — and seeds it with
// cloud-init so it comes up reachable over SSH.
//
// This module owns only what is *irreducibly one-shot*: the guest itself and
// the cloud-init user-data that plants the login user and its authorized_keys.
// cloud-init runs exactly once, on first boot, so anything placed in it is
// frozen at creation time. Everything that should re-converge on later applies
// — toolchains, dotfiles, the full key set — belongs in a vm-provision
// instance importing this one.
//
// Shells out through `host-exec` rather than `execSync`, so a test can stand in
// front of the daemon and run this module's real `apply`. Before
// that, nothing in the suite invoked the half of this module that creates
// anything, and it could not: there is one incus daemon on this box, so a test
// of the real thing would leave guests behind.
//
// Which daemon, and whether that invocation carries `sudo`, is decided by the
// declaration's `target` and rendered by `incus-core` — see the note above
// `daemonFor`. With no target it is `sudo incus`, matching the systemd-unit
// module's convention on this host (passwordless sudo is set up deliberately),
// and that is every declaration in this repo.
//
// `incus init` pulls an image and writes a progress bar to stderr, which is
// captured and therefore counts against the buffer, so every call here is given
// far more than Node's 1 MB default. `stdio[0]` was `'pipe'` with nothing ever
// fed to it, which `host-exec` measured to be equivalent to its `'ignore'`; no
// call site here has ever passed an input, so the parameter is gone rather than
// carried over unused.
const INCUS_MAX_BUFFER = 64 * 1024 * 1024

// ── Which daemon, and how a guest is named to it ────────────────────────────
//
// A declaration may name a `target`, and absent means the local socket — so
// every declaration in this repo keeps the command line it had.
//
// **How a guest is addressed is `incus-core`'s answer, not this module's**, and
// that is the one thing here that must not be written twice. `incus-core`'s own
// header predicted this change and said so: the `sudo` prefix "is a decision
// about how this repo reaches the daemon, not a coincidence of two modules
// needing the same wrapper". `incusCommand` and `guestRef` are that decision,
// and `incus-core`'s `incus()` renders through the same `incusCommand()`, so
// the substrate modules and the guest modules cannot disagree about what local
// means.
//
// **What is not shared is the runner, and the reason is not laziness.**
// `incus-core`'s `incus()` puts a 60s cap on every call because the three
// modules using it read and write daemon config, where a wedged daemon should
// fail an apply rather than hang it. Guest creation is the opposite: `incus
// init` pulls an image, which routinely takes longer than that and writes a
// progress bar to stderr that counts against the buffer — hence no timeout by
// default here and 64 MB rather than Node's 1 MB. `vm-provision` needs a third
// set again (a payload on stdin, streamed to the console, minutes long). One
// runner serving all three would have to be told which of the three it was on
// every call, which is the same knowledge spread further, not collected.
interface Daemon {
  /** Run an incus subcommand; `args` is everything after `incus`. Throws on a non-zero exit. */
  run: (args: string, timeout?: number) => string
  /** The same, where a non-zero exit is an answer rather than a failure — see `host-exec`. */
  runStatus: (args: string, timeout?: number) => ExecResult
  /** How a guest is named here: bare locally, `remote:name` on a remote. */
  ref: (name: string) => string
  /** The positional scope `incus list` takes, empty locally. */
  scope: string
  /**
   * Every guest this daemon holds, in **every** incus project.
   *
   * A second read rather than a widening of the first, because incus refuses to
   * answer both questions at once: `--project zabaca list --all-projects` exits
   * non-zero with `Can't specify --project with --all-projects` (measured on
   * this daemon, incus 6.0.0, 2026-08-18). So this one is rendered from a
   * target with the project stripped, and `incus-core` still decides the `sudo`
   * — a projectless *local* invocation is still root, and a remote one is still
   * not.
   */
  acrossProjects: () => IncusInstance[]
}

// The invocation is applied here rather than at each call site, so a call site
// cannot render a command aimed at the wrong daemon. `ref` is the half that
// still has to be spelled out per guest, and it has to be: an unqualified name
// means the default remote, so a forgotten `ref` is a well-formed command that
// acts locally and reports success.
const daemonFor = (target?: IncusTarget): Daemon => {
  const invocation = incusCommand(target)
  // The same endpoint asked without a project. `remote` is kept because it
  // decides *which machine*; `project` is dropped because incus refuses it
  // beside `--all-projects`. Built by handing `incusCommand` a narrower target
  // rather than by composing the string here, so the `sudo` decision stays in
  // the one place `incus-core` exists to keep it.
  const across = incusCommand(target?.remote === undefined ? undefined : { remote: target.remote })
  const scope = guestRef(target, '')
  return {
    run: (args, timeout) => exec(`${invocation} ${args}`, { timeout, maxBuffer: INCUS_MAX_BUFFER }),
    runStatus: (args, timeout) =>
      execStatus(`${invocation} ${args}`, { timeout, maxBuffer: INCUS_MAX_BUFFER }),
    ref: (name) => guestRef(target, name),
    scope,
    acrossProjects: () =>
      JSON.parse(
        exec([across, 'list', scope, '--all-projects --format json'].filter(Boolean).join(' '), {
          maxBuffer: INCUS_MAX_BUFFER,
        }),
      ) as IncusInstance[],
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

// Incus config keys that only take effect at creation. Re-setting them on a
// live guest is a no-op inside it, so they must never be diffed as drift.
const CREATE_ONLY_PREFIX = 'cloud-init.'

export function renderCloudInit(opts: {
  sshUser: string
  authorizedKeys: string[]
  extraUserData?: string
}): string {
  if (opts.authorizedKeys.length === 0) {
    throw new Error('authorizedKeys is empty — the guest would come up with no way in')
  }

  const base: Record<string, unknown> = {
    users: [
      {
        name: opts.sshUser,
        shell: '/bin/bash',
        sudo: 'ALL=(ALL) NOPASSWD:ALL',
        groups: ['sudo'],
        ssh_authorized_keys: [...opts.authorizedKeys],
      },
    ],
    package_update: true,
    packages: ['openssh-server', 'ca-certificates', 'curl'],
    // Deliberately NOT `ssh_pwauth: false`. That handler rewrites
    // /etc/ssh/sshd_config during the config stage, before `packages:` has
    // installed openssh-server, leaving a 26-byte file holding only
    // `PasswordAuthentication no`. Everything else then falls back to
    // OpenSSH's compiled-in defaults — including `UsePAM no`, under which sshd
    // rejects any account whose shadow field is `!`, which is precisely what
    // cloud-init's password locking sets. Net effect: a guest with correct
    // keys that still answers "Permission denied (publickey)".
    write_files: [
      {
        path: '/etc/ssh/sshd_config.d/60-zbc.conf',
        permissions: '0644',
        content: [
          'PasswordAuthentication no',
          'KbdInteractiveAuthentication no',
          'PubkeyAuthentication yes',
          'UsePAM yes',
          '',
        ].join('\n'),
      },
    ],
    // The drop-in is only read if the packaged sshd_config still has its
    // Include line, so make that true rather than assume it.
    runcmd: [
      [
        'sh',
        '-c',
        'grep -q "^Include /etc/ssh/sshd_config.d/" /etc/ssh/sshd_config || sed -i "1i Include /etc/ssh/sshd_config.d/*.conf" /etc/ssh/sshd_config',
      ],
      ['systemctl', 'restart', 'ssh'],
    ],
  }

  const extra = opts.extraUserData
    ? ((Bun.YAML.parse(opts.extraUserData) ?? {}) as Record<string, unknown>)
    : {}

  const merged = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    const existing = merged[key]
    // Concatenate list-valued keys (packages, runcmd, write_files) so callers
    // add to the baseline; anything else is a deliberate override.
    merged[key] = Array.isArray(existing) && Array.isArray(value) ? [...existing, ...value] : value
  }

  // Block style (the indent arg) rather than the default flow style: the seed
  // is what you read in the guest when a boot goes wrong, and it has to stay
  // legible there.
  return `#cloud-config\n${Bun.YAML.stringify(merged, null, 2)}`
}

export function planConfigChanges(
  existing: Record<string, string>,
  desired: Record<string, string>,
): Record<string, string> {
  const changes: Record<string, string> = {}
  for (const [key, value] of Object.entries(desired)) {
    if (key.startsWith(CREATE_ONLY_PREFIX)) continue
    if (existing[key] !== value) changes[key] = value
  }
  return changes
}

// Handles both a single-key .pub and a multi-key authorized_keys file, so a
// guest can be handed the exact key set that already reaches this host.
export function parseKeyFile(contents: string): string[] {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

// POSIX single-quote escaping: close, escape, reopen.
const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

// One `--config`/`config set` argument, quoted as a whole so values with
// spaces (raw.apparmor rules) survive the shell.
export function renderConfigPair(key: string, value: string): string {
  return sq(`${key}=${value}`)
}

export function buildDesiredConfig(config: {
  cpu?: number
  memory?: string
  incusConfig: Record<string, string>
}): Record<string, string> {
  const desired: Record<string, string> = { ...config.incusConfig }
  if (config.cpu !== undefined) desired['limits.cpu'] = String(config.cpu)
  if (config.memory !== undefined) desired['limits.memory'] = config.memory
  return desired
}

// `incus init` flags, in the order incus documents them: what kind of guest,
// which pool its root lands on, then the config keys. `-s` is create-only —
// it writes an *instance-local* root device, which is both why a copy of this
// guest inherits the pool and why changing it later means delete-and-recreate.
export function buildInitFlags(opts: {
  type: string
  storagePool?: string
  desired: Record<string, string>
}): string {
  return [
    opts.type === 'virtual-machine' ? '--vm' : '',
    opts.storagePool === undefined ? '' : `-s ${opts.storagePool}`,
    ...Object.entries(opts.desired).map(([k, v]) => `--config ${renderConfigPair(k, v)}`),
  ]
    .filter(Boolean)
    .join(' ')
}

// Applying a root-disk quota takes a different verb depending on where the root
// device came from. `override` exists to pull a *profile-inherited* device down
// onto the instance and errors with "The device already exists" if there is
// already an instance-local one — which `-s <pool>` creates at init time.
export function renderRootSizeArgs(opts: {
  name: string
  disk: string
  storagePool?: string
  target?: IncusTarget
}): string {
  const verb = opts.storagePool === undefined ? 'override' : 'set'
  return `config device ${verb} ${guestRef(opts.target, opts.name)} root size=${opts.disk}`
}

export function renderDeviceArgs(name: string, spec: Record<string, string>): string {
  const { type, ...rest } = spec
  if (!type) throw new Error(`device "${name}" is missing a type`)
  const props = Object.entries(rest).map(([k, v]) => `${k}=${v}`)
  return [name, type, ...props].join(' ')
}

export function planDeviceAdds(
  existing: Record<string, Record<string, string>>,
  desired: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const adds: Record<string, Record<string, string>> = {}
  for (const [name, spec] of Object.entries(desired)) {
    if (!existing[name]) adds[name] = spec
  }
  return adds
}

export function pickIpv4(instance: unknown): string | null {
  const network = (instance as { state?: { network?: Record<string, unknown> } } | null)?.state
    ?.network
  if (!network || typeof network !== 'object') return null

  for (const [iface, data] of Object.entries(network)) {
    if (iface === 'lo') continue
    const addresses = (data as { addresses?: unknown }).addresses
    if (!Array.isArray(addresses)) continue
    for (const addr of addresses) {
      const a = addr as { family?: string; address?: string; scope?: string }
      if (a.family === 'inet' && a.scope === 'global' && typeof a.address === 'string') {
        return a.address
      }
    }
  }
  return null
}

interface IncusInstance {
  name: string
  /** The incus project holding it. Present on every row of an `--all-projects` list. */
  project?: string
  status?: string
  config?: Record<string, string>
  devices?: Record<string, Record<string, string>>
  state?: unknown
}

// `incus list <remote>:` scopes the listing to an endpoint; the scope is empty
// locally, and dropped rather than emitted so the local command is unchanged.
// Names come back bare either way — a remote reports `dev-ws`, not
// `build-host:dev-ws` — which is why the match below is still on config.name.
function inspect(daemon: Daemon, name: string): IncusInstance | null {
  const { code, out } = daemon.runStatus(
    ['list', daemon.scope, '--format json'].filter(Boolean).join(' '),
  )
  if (code !== 0) throw new Error(`incus list failed: ${out}`)
  const all = JSON.parse(out) as IncusInstance[]
  return all.find((i) => i.name === name) ?? null
}

// ── The move this module cannot make ───────────────────────────────────────
//
// `target` routes where a command is *sent*; it never migrates anything. So a
// declaration whose project stops matching the machine is not a slow drift, it
// is an immediate trap: `inspect` is scoped by the target, a guest sitting in
// another incus project is invisible to it, `existing` comes back null, and the
// apply takes the create branch and builds a **second, empty guest of the same
// name** beside the running one. `incus init` succeeds, the apply reports
// created, and nothing in the diff or the output says which of the two the
// service is now talking to.
//
// This happened for real on 2026-08-18: `dev-ws` was moved into `zabaca`
// by hand and its declaration still said nothing, so for a few hours any
// whole-environment apply would have done exactly that to a production surface.
//
// The module refuses instead. It does not perform the move — that needs the
// guest stopped, which is downtime on somebody's service in a window this
// process did not choose, and it is planned as a human act with the
// commands written down. What it can do is make the trap loud at the one moment
// it would otherwise be silent, which costs one extra `incus list` on the
// create path and nothing at all on the converge path.
//
// **Visibility is what makes it possible**:
// an incus project is a namespace on one daemon, so a listing across projects
// still sees every guest whatever holds it. A restricted certificate sees only
// the projects it is scoped to, so over such an endpoint this guard narrows to
// what that identity can see rather than failing — untested, because no
// restricted remote is enrolled on this box yet.

/**
 * The incus project holding a guest of this name, when it is not the one just
 * searched — or null when no such guest exists anywhere on the daemon.
 *
 * Called **only** after a scoped `inspect` came back empty, which is what makes
 * the answer meaningful without this function knowing what "my project" is: the
 * scoped list would have returned the guest if it were here, so any row bearing
 * the name is by construction somewhere else. Resolving the current project
 * instead would mean deciding what an absent `project` means on a remote whose
 * own config names one, and getting that wrong is a false positive on a correct
 * declaration.
 *
 * A matching row with no project is a failed read rather than a miss. The check
 * is on the matching row alone and not on every row, because a name that does
 * not match cannot produce a finding either way — and a guard that failed every
 * create over an unrelated guest's shape is one somebody switches off.
 */
export function findGuestInAnotherProject(
  rows: { name: string; project?: string }[],
  name: string,
): string | null {
  for (const row of rows) {
    if (row.name !== name) continue
    if (typeof row.project !== 'string' || row.project.trim() === '')
      throw new Error(
        `incus list --all-projects reported a guest called ${name} with no project — ` +
          'the JSON shape has moved, and reading that as "no clash" is how this guard goes quiet',
      )
    return row.project
  }
  return null
}

/**
 * What to tell somebody whose declaration and whose daemon disagree.
 *
 * Both ways out, because either can be the right one: usually the guest is the
 * fact and the file is what is stale, but a guest put somewhere by hand is the
 * other case and this module cannot tell them apart. The move commands are
 * emitted only when the declaration names a project — with none, the
 * destination is "whatever this endpoint defaults to", and spelling a
 * `--target-project` for that would be inventing a command rather than quoting
 * one.
 */
export function renderCrossProjectRefusal(opts: {
  name: string
  found: string
  declared?: string
  verb: 'create' | 'delete'
}): string {
  const { name, found, declared, verb } = opts
  const here = declared === undefined ? "this endpoint's default project" : `\`${declared}\``
  const consequence =
    verb === 'create'
      ? `Creating it here would build a second, empty ${name} beside that one, and \`incus init\` would report success.`
      : `Nothing was deleted: a delete here would miss it, and reporting success would say ${name} is gone when it is running.`
  return [
    `${name}: this declaration converges ${here}, and the daemon holds a guest called ${name} in \`${found}\`.`,
    consequence,
    'A cross-project move needs the guest stopped, so it costs downtime on whatever it serves, and this module does not make one. Either:',
    `  • point the declaration at the guest:  target: { project: '${found}' }`,
    ...(declared === undefined
      ? []
      : [
          '  • or move the guest, by hand, in a window you chose:',
          `      incus stop ${name} --project ${found}`,
          `      incus move ${name} ${name} --project ${found} --target-project ${declared}`,
          `      incus start ${name} --project ${declared}`,
        ]),
  ].join('\n')
}

async function waitForIpv4(
  daemon: Daemon,
  name: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ip = pickIpv4(inspect(daemon, name))
    if (ip) return ip
    await sleep(1000)
  }
  return null
}

// Blocks until the guest can actually run commands and cloud-init has settled.
// For VMs `incus exec` only works once incus-agent is up inside, so this polls
// rather than reading once — and it is the barrier that makes it safe for a
// vm-provision instance to start apt work without racing cloud-init's own.
async function waitForReady(daemon: Daemon, name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (daemon.runStatus(`exec ${daemon.ref(name)} -- true`).code === 0) break
    await sleep(2000)
  }
  if (daemon.runStatus(`exec ${daemon.ref(name)} -- true`).code !== 0) {
    throw new Error(`${name}: guest never became executable within ${timeoutMs}ms`)
  }

  // `--wait` blocks with no timeout of its own, so bound it by whatever is
  // left of readyTimeoutMs — otherwise a cloud-init that never settles hangs
  // the whole apply indefinitely.
  const remaining = Math.max(deadline - Date.now(), 10_000)
  const { code, out } = daemon.runStatus(
    `exec ${daemon.ref(name)} -- cloud-init status --wait`,
    remaining,
  )
  // 0 = done, 2 = done with recoverable warnings. Anything else means the seed
  // failed, which usually means no SSH access — surface it rather than let a
  // provision step fail later with a confusing error.
  if (code !== 0 && code !== 2) {
    throw new Error(`${name}: cloud-init did not complete cleanly (exit ${code})\n${out}`)
  }
}

export const vmModule = defineModule({
  name: 'vm',
  configSchema: z
    .object({
      name: z.string(), // incus instance name, e.g. "agent-vm"
      image: z.string().default('images:ubuntu/noble/cloud'), // /cloud variants ship cloud-init
      type: z.enum(['container', 'virtual-machine']).default('container'),
      cpu: z.number().int().min(1).optional(),
      memory: z.string().optional(), // e.g. "8GiB"
      disk: z.string().optional(), // needs a quota-capable pool (btrfs/zfs/lvm), not dir
      // Storage pool for the root disk. Create-only: it becomes an
      // instance-local root device, so `incus copy` of this guest lands in the
      // same pool, and changing it on a live guest needs a delete-and-recreate.
      storagePool: z.string().optional(),
      // Which incus daemon this guest lives on, and in which incus project.
      // **Absent means the local socket**, which is what every declaration in
      // this repo says and what the module keeps saying for
      // agent-vm, ci-runner and agent-base. A guest owned by another repo names
      // one, and the commands become `incus --project zabaca … build-host:<name>`
      // with `sudo` substituted away rather than added to.
      target: incusTargetSchema.optional(),
      // No default: this names a real user created on every guest this module
      // provisions, so it belongs to the consumer, not to whoever wrote the
      // module. A missing value fails at parse time rather than silently
      // creating someone else's username on the operator's infrastructure.
      sshUser: z.string().min(1),
      authorizedKeys: z.array(z.string()).default([]),
      authorizedKeyFiles: z.array(z.string()).default([]), // e.g. "~/.ssh/id_ed25519.pub"
      userData: z.string().optional(), // extra cloud-config, merged over the baseline
      // deviceName -> {type, ...props}. A container needs
      // `{ tun: { type: 'unix-char', path: '/dev/net/tun' } }` to run tailscale;
      // VMs have their own kernel and don't.
      devices: z.record(z.record(z.string())).default({}),
      // Arbitrary incus config keys, e.g. `security.nesting: 'true'` so a
      // container can run docker. The dedicated cpu/memory fields win over
      // duplicate limits.* keys here. Changing security.* on a live container
      // needs an `incus restart` to fully take effect.
      incusConfig: z.record(z.string()).default({}),
      readyTimeoutMs: z.number().int().default(300_000),
    })
    .refine((c) => c.authorizedKeys.length > 0 || c.authorizedKeyFiles.length > 0, {
      message: 'at least one of authorizedKeys or authorizedKeyFiles is required',
    }),
  outputs: z.object({
    name: z.string(),
    type: z.string(),
    sshUser: z.string(),
    // Stated once per Guest. A vm-provision instance importing this one reads
    // the target off here rather than re-declaring it, exactly as it already
    // reads sshUser — two declarations of the same endpoint could disagree, and
    // the one that disagreed would provision a guest on the wrong machine.
    target: incusTargetSchema.optional(),
    ipv4: z.string().nullable(),
    created: z.boolean(),
    changed: z.boolean(),
  }),
  apply: async (config) => {
    const daemon = daemonFor(config.target)

    /**
     * The cloud-init seed, built only when it is about to be used.
     *
     * `authorizedKeyFiles` names files on the machine running the apply, and
     * the seed is a create-time input: cloud-init runs once, on first boot, and
     * nothing on the converge path reads it. Building it eagerly made every
     * converge of an existing guest depend on that machine's `~/.ssh`, which is
     * invisible while one machine converges and breaks the moment the repo that
     * owns a guest applies from somewhere else.
     *
     * Found by applying an unchanged declaration from a second machine: the
     * guest had been RUNNING for days and the apply died with
     * `ENOENT: ~/.ssh/authorized_keys`, on a file whose contents would have gone
     * nowhere even if it had existed. A missing file on the CREATE path is still
     * a broken declaration and still throws — that is the only path where a key
     * reaches the guest at all.
     */
    const seed = (): string =>
      renderCloudInit({
        sshUser: config.sshUser,
        authorizedKeys: [
          ...new Set(
            [
              ...config.authorizedKeys,
              ...config.authorizedKeyFiles.flatMap((f) =>
                parseKeyFile(fs.readFileSync(expandHome(f), 'utf8')),
              ),
            ].filter((k) => k.length > 0),
          ),
        ],
        extraUserData: config.userData,
      })

    const desired = buildDesiredConfig(config)

    const existing = inspect(daemon, config.name)
    let created = false
    let changed = false

    if (!existing) {
      // Before creating anything: the guest may already exist in another incus
      // project on this same daemon, where the scoped read above could not see
      // it. See the note above `findGuestInAnotherProject` — this is the one
      // moment the trap is silent.
      const elsewhere = findGuestInAnotherProject(daemon.acrossProjects(), config.name)
      if (elsewhere !== null)
        throw new Error(
          renderCrossProjectRefusal({
            name: config.name,
            found: elsewhere,
            declared: config.target?.project,
            verb: 'create',
          }),
        )

      const flags = buildInitFlags({
        type: config.type,
        ...(config.storagePool === undefined ? {} : { storagePool: config.storagePool }),
        desired,
      })
      daemon.run(`init ${config.image} ${daemon.ref(config.name)} ${flags}`)

      // user-data is multi-KB YAML — hand it over through a temp file and
      // quoted command substitution rather than escaping it into argv.
      // The substitution is performed by the shell running `incus`, which is
      // this machine whether or not the guest is remote — so the file is local
      // and the YAML travels as an argument. Nothing has to reach the far side.
      //
      // `<key>=<value>`, which is the only form `incus config set --help` puts
      // under `Usage:`. The `<key> <value>` this used to render is the one the
      // same help calls "backward compatibility", and that is the category
      // upstream removes — on the local socket a removal would be three years
      // of history breaking at once, but `target` carries this call to daemons
      // this repo neither installs nor pins, where it would land as a runtime
      // failure on the one path with nothing behind it. Measured against incus
      // 6.0.0 rather than assumed: the seed's `sudo: ALL=(ALL) NOPASSWD:ALL`
      // means the value has an `=` of its own, and incus splits on the first
      // one only, so nothing about the seed's content changes.
      //
      // Not `renderConfigPair`, which single-quotes the whole pair: that is
      // right for every other value here and would stop this one substituting.
      const tmp = path.join(os.tmpdir(), `zbc-cloud-init-${config.name}.yaml`)
      fs.writeFileSync(tmp, seed(), { mode: 0o600 })
      try {
        daemon.run(`config set ${daemon.ref(config.name)} cloud-init.user-data="$(cat ${tmp})"`)
      } finally {
        fs.unlinkSync(tmp)
      }

      if (config.disk) {
        daemon.run(
          renderRootSizeArgs({
            name: config.name,
            disk: config.disk,
            ...(config.storagePool === undefined ? {} : { storagePool: config.storagePool }),
            ...(config.target === undefined ? {} : { target: config.target }),
          }),
        )
      }
      for (const [dev, spec] of Object.entries(config.devices)) {
        daemon.run(`config device add ${daemon.ref(config.name)} ${renderDeviceArgs(dev, spec)}`)
      }
      daemon.run(`start ${daemon.ref(config.name)}`)
      created = true
      changed = true
      console.log(`  ${config.name} created (${config.type}) from ${config.image}`)
    } else {
      const pending = planConfigChanges(existing.config ?? {}, desired)
      const entries = Object.entries(pending)
      if (entries.length > 0) {
        daemon.run(
          `config set ${daemon.ref(config.name)} ${entries.map(([k, v]) => renderConfigPair(k, v)).join(' ')}`,
        )
        changed = true
        console.log(
          `  ${config.name} limits updated: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`,
        )
        if (config.type === 'virtual-machine') {
          console.log(
            `  note: VM limit changes need \`incus restart ${config.name}\` to take effect`,
          )
        }
      }
      for (const [dev, spec] of Object.entries(
        planDeviceAdds(existing.devices ?? {}, config.devices),
      )) {
        daemon.run(`config device add ${daemon.ref(config.name)} ${renderDeviceArgs(dev, spec)}`)
        changed = true
        console.log(`  ${config.name} device added: ${dev}`)
      }
      if (existing.status !== 'Running') {
        daemon.run(`start ${daemon.ref(config.name)}`)
        changed = true
      }
    }

    await waitForReady(daemon, config.name, config.readyTimeoutMs)
    const ipv4 = await waitForIpv4(daemon, config.name, 60_000)

    console.log(
      `  ${config.name} ready — ${config.sshUser}@${ipv4 ?? '(no ipv4 yet)'} ${changed ? '' : '(unchanged)'}`,
    )
    return {
      name: config.name,
      type: config.type,
      sshUser: config.sshUser,
      ...(config.target === undefined ? {} : { target: config.target }),
      ipv4,
      created,
      changed,
    }
  },
  destroy: async (config) => {
    const daemon = daemonFor(config.target)
    const existing = inspect(daemon, config.name)
    if (!existing) {
      // The same trap in the direction that reports success rather than damage,
      // which is why it is not left as the obviously-harmless case: a destroy
      // that cannot see the guest returns quietly, and the operator reads that
      // as deleted while the guest is still running in the other project.
      const elsewhere = findGuestInAnotherProject(daemon.acrossProjects(), config.name)
      if (elsewhere !== null)
        throw new Error(
          renderCrossProjectRefusal({
            name: config.name,
            found: elsewhere,
            declared: config.target?.project,
            verb: 'delete',
          }),
        )
      return
    }
    daemon.run(`delete --force ${daemon.ref(config.name)}`)
    console.log(`  ${config.name} deleted`)
  },
})
