import { z } from 'zod'
import { exec } from '../host-exec'
import { type IncusTarget, guestRef, incusCommand } from '../incus-core'
import { defineModule } from '../../src/define-module'
import {
  MARKER_DIR,
  markerWrite,
  provisionDigest,
  renderProvisionScript,
  resolveVolatileEnv,
  shouldProvision,
} from '../provision-core'

// Converges the *inside* of an Incus guest: packages plus an idempotent shell
// script. Unlike the cloud-init seed in the vm module, this re-runs on every
// `bun run apply`, so changing the toolchain here updates existing guests in
// place instead of requiring a rebuild.
//
// Work is delivered over `incus exec`, not SSH — it needs no IP, no key
// material and no "wait for sshd" retry loop, and it behaves identically for
// containers and VMs. The guest's SSH keys stay purely for human access. For
// machines we do not host, remote-provision does the same job over SSH; the
// digest and script rendering are shared in provision-core so the two cannot
// drift.
//
// Cheap on no-op applies: the digest of (packages + script + env) is stored
// inside the guest and the whole run is skipped when it matches, the same
// content-diff discipline host-file and systemd-unit use.

// Re-exported for the module's own tests and for callers that already import
// them from here.
export { provisionDigest, renderProvisionScript, resolveVolatileEnv, shouldProvision }

export interface VmOutputs {
  name: string
  sshUser: string
  /**
   * Which daemon holds the guest, from the vm that declared it.
   *
   * Optional, and it has to be: every vm instance in this repo reports none,
   * and the recogniser below must keep recognising them. Absent means the local
   * socket, which is what those guests are.
   */
  target?: IncusTarget
}

/**
 * The one legitimate raw reader of `ctx.imports`.
 *
 * Every other lookup in core names what it wants — `ctx.output({ from, output
 * }, field)` — because the instance file said so. This one has nothing to name:
 * it SEARCHES the imports for outputs shaped like a vm, so that an instance
 * importing exactly one vm need not repeat that vm's name. A ref-based
 * resolver cannot express "whichever one it is", which is why this stays.
 */
export function findVmOutputs(imports: Record<string, unknown>): VmOutputs[] {
  return Object.values(imports).filter((o): o is VmOutputs => {
    if (typeof o !== 'object' || o === null) return false
    const c = o as Record<string, unknown>
    // `target` is deliberately not part of the shape test: it is optional, and
    // requiring it would stop recognising every vm instance declared to date.
    return typeof c.name === 'string' && typeof c.sshUser === 'string'
  })
}

export function resolveInstanceName(
  explicit: string | undefined,
  imports: Record<string, unknown>,
): string {
  if (explicit) return explicit
  const candidates = findVmOutputs(imports)
  if (candidates.length === 0) {
    throw new Error('no vm instance to provision — set config.instance or import a vm instance')
  }
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous vm imports (${candidates.map((c) => c.name).join(', ')}) — set config.instance explicitly`,
    )
  }
  return candidates[0]!.name
}

export const vmProvisionModule = defineModule({
  name: 'vm-provision',
  configSchema: z.object({
    instance: z.string().optional(), // defaults to the single imported vm
    packages: z.array(z.string()).default([]),
    script: z.string().default(''),
    env: z.record(z.string()).default({}),
    envSecrets: z.record(z.string()).default({}), // envVarName -> secrets.yaml key
    volatileEnvFrom: z.record(z.string()).default({}), // envVarName -> "instance.field"
    marker: z.string().default('default'), // lets one guest carry several provision instances
    force: z.boolean().default(false),
  }),
  outputs: z.object({
    instance: z.string(),
    digest: z.string(),
    changed: z.boolean(),
  }),
  apply: async (config, ctx) => {
    const instance = resolveInstanceName(config.instance, ctx.imports)
    const vm = findVmOutputs(ctx.imports).find((v) => v.name === instance)

    // How this guest is reached, stated once per Guest on its vm and read off
    // here the way `sshUser` is a few lines down. There is deliberately no
    // `target` in this module's schema: two declarations of one endpoint could
    // disagree, and the one that disagreed would provision a guest on a machine
    // its vm never touched. `config.instance` with no matching import has
    // nothing to inherit and is therefore local — which is what it has always
    // been, and guessing otherwise would aim it at a machine no declaration
    // names.
    const reach = `${incusCommand(vm?.target)} exec ${guestRef(vm?.target, instance)}`

    const env: Record<string, string> = { ...config.env }
    for (const [key, secretKey] of Object.entries(config.envSecrets)) {
      // Presence is the contract, not non-emptiness — an intentionally blank
      // placeholder lets a script no-op the step it gates until the real value
      // is filled in, at which point the digest changes and it re-provisions.
      env[key] = ctx.secret(secretKey, { allowBlank: true, field: `envSecrets.${key}` })
    }

    const volatileEnv = resolveVolatileEnv(config.volatileEnvFrom, ctx.imports)

    const digest = provisionDigest({ packages: config.packages, script: config.script, env })
    const markerPath = `${MARKER_DIR}/${config.marker}`

    let current: string
    try {
      current = exec(`${reach} -- sh -c 'cat ${markerPath} 2>/dev/null || true'`).trim()
    } catch (e) {
      const err = e as { stderr?: Buffer; message?: string }
      // The daemon's own words when it said any, and the error's message when
      // it did not. A command that failed before it reached a daemon at all —
      // a guest named to an endpoint that is not there — carries no stderr, and
      // an empty reason here would strip the only diagnosis there was. Same
      // call, and the same reason, as `execStatus`'s fallback in host-exec.
      const reason = err.stderr?.toString().trim() || (err.message ?? '')
      throw new Error(`${instance}: cannot exec into guest — is it running? ${reason}`)
    }

    if (!shouldProvision({ current, digest, volatileEnv, force: config.force })) {
      console.log(`  ${instance}: provisioning unchanged (${digest.slice(0, 12)})`)
      return { instance, digest, changed: false }
    }

    const pending = Object.keys(volatileEnv).filter((k) => volatileEnv[k] !== '')
    if (current === digest && pending.length > 0) {
      console.log(`  ${instance}: digest unchanged, re-running for ${pending.join(', ')}`)
    }

    // The script runs as root. PROVISION_USER/_HOME let it drop privileges
    // explicitly (`runuser -u "$PROVISION_USER" -- ...`) for per-user installs.
    const payload =
      renderProvisionScript({
        packages: config.packages,
        script: config.script,
        env: {
          ...env,
          PROVISION_USER: vm?.sshUser ?? 'root',
          PROVISION_HOME: vm?.sshUser ? `/home/${vm.sshUser}` : '/root',
        },
        volatileEnv,
      }) +
      // Only reached if everything above succeeded (set -e), so a failed run
      // leaves the old marker and the next apply retries.
      markerWrite(config.marker, digest)

    console.log(`  ${instance}: provisioning (${digest.slice(0, 12)})`)
    // `stream` because this is the one command here that takes minutes — apt
    // plus a whole toolchain install inside the guest — and an operator
    // watching an apply needs to see it happening rather than a silent gap.
    // The payload goes over stdin so that the secrets it exports never reach a
    // process list; both were `execSync` options before the conversion and
    // neither is a new behaviour.
    exec(`${reach} -- bash -s`, { input: payload, stream: true })

    console.log(`  ${instance}: provisioned`)
    return { instance, digest, changed: true }
  },
})
