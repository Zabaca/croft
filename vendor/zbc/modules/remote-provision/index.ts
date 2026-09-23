import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import { defineModule } from '../../src/define-module'
import {
  MARKER_DIR,
  markerWrite,
  provisionDigest,
  renderProvisionScript,
  resolveVolatileEnv,
  shouldProvision,
} from '../provision-core'

// remote-provision — vm-provision's discipline for machines we do not host.
//
// Same digest, same marker file, same stdin delivery; the transport is SSH
// instead of `incus exec`. That swap brings the one problem Incus does not
// have: the target can be unreachable, and unreachable is not the same as
// broken. The vultr exit node is reachable over the tailnet normally and over
// its public IP when the tailnet is precisely what failed — which is the case
// this module is most needed in. So `hosts` is an ordered list, tried in turn,
// and the apply log says which one answered.
//
// Deliberately not here: bootstrapping the machine's existence. This converges
// the inside of a box that already boots and accepts our SSH key. Creating the
// VPS is a separate concern (and a separate credential).

export interface HostChoice {
  host: string
  fallback: boolean
}

export function buildSshArgs(input: {
  host: string
  user: string
  connectTimeout: number
}): string[] {
  return [
    '-o',
    'BatchMode=yes', // fail instead of prompting; nobody is watching an apply
    '-o',
    `ConnectTimeout=${input.connectTimeout}`,
    // StrictHostKeyChecking is left at its default on purpose. An apply that
    // silently accepts a new host key would authenticate whatever answers on
    // that address, which is a worse outcome than a failed apply.
    `${input.user}@${input.host}`,
  ]
}

/**
 * First host that answers wins. `fallback` is true whenever that was not the
 * preferred one, so an apply that quietly stopped using the tailnet says so.
 */
export async function pickHost(
  hosts: string[],
  probe: (host: string) => Promise<boolean>,
): Promise<HostChoice> {
  if (hosts.length === 0) throw new Error('remote-provision: no host configured')
  for (const [i, host] of hosts.entries()) {
    if (await probe(host)) return { host, fallback: i > 0 }
  }
  throw new Error(`remote-provision: no configured host answered (tried ${hosts.join(', ')})`)
}

export const remoteProvisionModule = defineModule({
  name: 'remote-provision',
  configSchema: z.object({
    // Ordered by preference. The first that answers is used.
    hosts: z.array(z.string()).min(1),
    user: z.string().default('root'),
    connectTimeout: z.number().int().positive().default(8),
    packages: z.array(z.string()).default([]),
    script: z.string().default(''),
    env: z.record(z.string()).default({}),
    envSecrets: z.record(z.string()).default({}), // envVarName -> secrets.yaml key
    volatileEnvFrom: z.record(z.string()).default({}), // envVarName -> "instance.field"
    marker: z.string().default('default'),
    force: z.boolean().default(false),
  }),
  outputs: z.object({
    host: z.string(),
    fallback: z.boolean(),
    digest: z.string(),
    changed: z.boolean(),
  }),
  apply: async (config, ctx) => {
    const env: Record<string, string> = { ...config.env }
    for (const [key, secretKey] of Object.entries(config.envSecrets)) {
      env[key] = ctx.secret(secretKey, { allowBlank: true, field: `envSecrets.${key}` })
    }

    const volatileEnv = resolveVolatileEnv(config.volatileEnvFrom, ctx.imports)
    const digest = provisionDigest({ packages: config.packages, script: config.script, env })
    const markerPath = `${MARKER_DIR}/${config.marker}`

    // The marker read doubles as the reachability probe: one round trip
    // answers both "can we get in" and "is there anything to do".
    let marker = ''
    const choice = await pickHost(config.hosts, async (host) => {
      try {
        marker = execFileSync(
          'ssh',
          [
            ...buildSshArgs({ host, user: config.user, connectTimeout: config.connectTimeout }),
            '--',
            `cat ${markerPath} 2>/dev/null || true`,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
          .toString()
          .trim()
        return true
      } catch {
        return false
      }
    })

    if (choice.fallback) {
      console.log(
        `  ${choice.host}: reached via fallback address (preferred ${config.hosts[0]} did not answer)`,
      )
    }

    if (!shouldProvision({ current: marker, digest, volatileEnv, force: config.force })) {
      console.log(`  ${choice.host}: provisioning unchanged (${digest.slice(0, 12)})`)
      return { host: choice.host, fallback: choice.fallback, digest, changed: false }
    }

    const pending = Object.keys(volatileEnv).filter((k) => volatileEnv[k] !== '')
    if (marker === digest && pending.length > 0) {
      console.log(`  ${choice.host}: digest unchanged, re-running for ${pending.join(', ')}`)
    }

    const payload =
      renderProvisionScript({
        packages: config.packages,
        script: config.script,
        env: {
          ...env,
          PROVISION_USER: config.user,
          PROVISION_HOME: config.user === 'root' ? '/root' : `/home/${config.user}`,
        },
        volatileEnv,
      }) + markerWrite(config.marker, digest)

    console.log(`  ${choice.host}: provisioning (${digest.slice(0, 12)})`)
    execFileSync(
      'ssh',
      [
        ...buildSshArgs({
          host: choice.host,
          user: config.user,
          connectTimeout: config.connectTimeout,
        }),
        '--',
        'bash -s',
      ],
      { input: payload, stdio: ['pipe', 'inherit', 'inherit'] },
    )

    console.log(`  ${choice.host}: provisioned`)
    return { host: choice.host, fallback: choice.fallback, digest, changed: true }
  },
})
