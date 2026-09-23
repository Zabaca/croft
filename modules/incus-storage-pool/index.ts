import { z } from 'zod'
import { execSync } from 'node:child_process'
import { defineModule } from '../../src/define-module'

// Creates an Incus storage pool. Exists so the `dir` default — which has no
// reflinks, so every `incus copy` rewrites the whole rootfs, and no quotas, so
// a runaway guest eats the host's disk — is a choice rather than an accident.
//
// The subtlety this module owns: incus only advertises a storage driver whose
// *userland tools* it can find, and it probes for them once, at daemon start.
// A fresh box therefore reports `dir` as the only supported driver even though
// the btrfs kernel module is right there. Installing the package is half the
// fix; restarting the daemon so it re-probes is the other half, and skipping it
// leaves `incus storage create` failing with a driver-not-supported error that
// says nothing about the real cause.
//
// Shells out with sudo, matching the vm and systemd-unit modules' convention on
// this host (passwordless sudo is set up deliberately).

const run = (cmd: string, timeout?: number) =>
  execSync(cmd, {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  }).toString()

function runStatus(cmd: string, timeout?: number): { code: number; out: string } {
  try {
    return { code: 0, out: run(cmd, timeout) }
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer }
    return {
      code: err.status ?? 1,
      out: `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`,
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Drivers the daemon says it can use. `incus info` is YAML — it has no --format flag. */
export function parseDrivers(infoYaml: string): string[] {
  const parsed = (Bun.YAML.parse(infoYaml) ?? {}) as {
    environment?: { storage_supported_drivers?: Array<{ name?: string }> }
  }
  return (parsed.environment?.storage_supported_drivers ?? [])
    .map((d) => d.name)
    .filter((n): n is string => typeof n === 'string')
}

/** The apt package whose presence makes incus advertise a driver. */
export function packageForDriver(driver: string): string | null {
  switch (driver) {
    case 'btrfs':
      return 'btrfs-progs'
    case 'zfs':
      return 'zfsutils-linux'
    case 'lvm':
      return 'lvm2'
    default:
      return null
  }
}

export function poolExists(storageListJson: string, name: string): boolean {
  const pools = JSON.parse(storageListJson) as Array<{ name?: string }>
  return pools.some((p) => p.name === name)
}

export function renderCreateCommand(config: {
  name: string
  driver: string
  size?: string
  source?: string
}): string {
  // A sized pool is loop-backed: incus writes a sparse image under
  // /var/lib/incus/disks, so the size is a ceiling and not an allocation.
  const backing = config.source === undefined ? `size=${config.size}` : `source=${config.source}`
  return `sudo incus storage create ${config.name} ${config.driver} ${backing}`
}

export const incusStoragePoolModule = defineModule({
  name: 'incus-storage-pool',
  configSchema: z
    .object({
      name: z.string(), // pool name, e.g. "sessions"
      driver: z.enum(['btrfs', 'zfs', 'lvm', 'dir']).default('btrfs'),
      size: z.string().optional(), // loop-image ceiling, e.g. "200GiB"
      source: z.string().optional(), // raw block device, e.g. "/dev/nvme1n1"
      readyTimeoutMs: z.number().int().default(60_000),
    })
    .refine((c) => (c.size === undefined) !== (c.source === undefined), {
      message: 'exactly one of size (loop-backed) or source (raw device) is required',
    }),
  outputs: z.object({
    name: z.string(),
    driver: z.string(),
    created: z.boolean(),
    changed: z.boolean(),
  }),
  apply: async (config) => {
    let changed = false

    const drivers = () => {
      const { code, out } = runStatus('sudo incus info')
      if (code !== 0) throw new Error(`incus info failed: ${out}`)
      return parseDrivers(out)
    }

    if (!drivers().includes(config.driver)) {
      const pkg = packageForDriver(config.driver)
      if (pkg === null)
        throw new Error(`incus does not support driver ${config.driver} and no package provides it`)

      run(`sudo apt-get install -y ${pkg}`, 10 * 60_000)
      console.log(`  ${pkg} installed`)

      // The probe is start-time only, so the daemon has to come back before it
      // will admit the driver exists.
      run('sudo systemctl restart incus')
      const deadline = Date.now() + config.readyTimeoutMs
      while (Date.now() < deadline && runStatus('sudo incus info').code !== 0) {
        await sleep(1000)
      }
      changed = true

      if (!drivers().includes(config.driver)) {
        throw new Error(`incus still does not support ${config.driver} after installing ${pkg}`)
      }
      console.log(`  incus restarted — ${config.driver} driver available`)
    }

    const { code, out } = runStatus('sudo incus storage list --format json')
    if (code !== 0) throw new Error(`incus storage list failed: ${out}`)

    let created = false
    if (!poolExists(out, config.name)) {
      run(renderCreateCommand(config), 10 * 60_000)
      created = true
      changed = true
      console.log(
        `  pool ${config.name} created (${config.driver}, ${config.source ?? config.size})`,
      )
    } else {
      console.log(`  pool ${config.name} present (unchanged)`)
    }

    return { name: config.name, driver: config.driver, created, changed }
  },
  destroy: async (config) => {
    const { code, out } = runStatus('sudo incus storage list --format json')
    if (code !== 0 || !poolExists(out, config.name)) return
    run(`sudo incus storage delete ${config.name}`)
    console.log(`  pool ${config.name} deleted`)
  },
})
