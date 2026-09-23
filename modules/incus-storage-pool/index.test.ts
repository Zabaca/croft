import { describe, expect, test } from 'bun:test'
import {
  incusStoragePoolModule,
  packageForDriver,
  parseDrivers,
  poolExists,
  renderCreateCommand,
} from './index'

// `incus info` prints YAML and has no --format flag, so the driver probe reads
// the shape verbatim from the daemon.
const INFO_DIR_ONLY = `config: {}
api_status: stable
environment:
  storage: dir
  storage_version: "1"
  storage_supported_drivers:
  - name: dir
    version: "1"
    remote: false
`

const INFO_WITH_BTRFS = `config: {}
environment:
  storage_supported_drivers:
  - name: btrfs
    version: "6.6.3"
    remote: false
  - name: dir
    version: "1"
    remote: false
`

const STORAGE_LIST = JSON.stringify([
  { name: 'default', driver: 'dir', config: { source: '/var/lib/incus/storage-pools/default' } },
  { name: 'sessions', driver: 'btrfs', config: { size: '200GiB' } },
])

describe('parseDrivers', () => {
  test('reads the driver names the daemon advertises', () => {
    expect(parseDrivers(INFO_WITH_BTRFS)).toEqual(['btrfs', 'dir'])
  })

  test('a box with no btrfs tooling advertises only dir', () => {
    expect(parseDrivers(INFO_DIR_ONLY)).toEqual(['dir'])
  })

  test('is empty rather than throwing when the key is absent', () => {
    expect(parseDrivers('environment: {}\n')).toEqual([])
  })
})

describe('packageForDriver', () => {
  test('maps each quota-capable driver to the apt package that enables it', () => {
    expect(packageForDriver('btrfs')).toBe('btrfs-progs')
    expect(packageForDriver('zfs')).toBe('zfsutils-linux')
    expect(packageForDriver('lvm')).toBe('lvm2')
  })

  test('dir needs no package — it is always available', () => {
    expect(packageForDriver('dir')).toBeNull()
  })
})

describe('poolExists', () => {
  test('finds a pool by exact name', () => {
    expect(poolExists(STORAGE_LIST, 'sessions')).toBe(true)
  })

  test('does not match on a prefix', () => {
    expect(poolExists(STORAGE_LIST, 'session')).toBe(false)
  })

  test('handles an empty list', () => {
    expect(poolExists('[]', 'sessions')).toBe(false)
  })
})

describe('renderCreateCommand', () => {
  test('a sized pool is loop-backed — the size is a cap, not an allocation', () => {
    expect(renderCreateCommand({ name: 'sessions', driver: 'btrfs', size: '200GiB' })).toBe(
      'sudo incus storage create sessions btrfs size=200GiB',
    )
  })

  test('a sourced pool takes the raw device instead', () => {
    expect(renderCreateCommand({ name: 'sessions', driver: 'btrfs', source: '/dev/nvme1n1' })).toBe(
      'sudo incus storage create sessions btrfs source=/dev/nvme1n1',
    )
  })
})

describe('config schema', () => {
  test('defaults to btrfs — in-tree, no DKMS, quota-capable', () => {
    expect(
      incusStoragePoolModule.configSchema.parse({ name: 'sessions', size: '200GiB' }).driver,
    ).toBe('btrfs')
  })

  test('rejects a pool that is neither sized nor sourced — incus would silently pick a default', () => {
    expect(() => incusStoragePoolModule.configSchema.parse({ name: 'sessions' })).toThrow()
  })

  test('rejects size and source together — they are different backing stories', () => {
    expect(() =>
      incusStoragePoolModule.configSchema.parse({
        name: 'sessions',
        size: '200GiB',
        source: '/dev/nvme1n1',
      }),
    ).toThrow()
  })

  test('pins the converge identity', () => {
    expect(incusStoragePoolModule.name).toBe('incus-storage-pool')
  })
})
