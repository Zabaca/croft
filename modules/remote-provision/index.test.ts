import { describe, expect, test } from 'bun:test'
import { buildSshArgs, pickHost } from './index'

describe('buildSshArgs', () => {
  test('never prompts — an apply has no one to answer a passphrase or a host-key question', () => {
    const args = buildSshArgs({ host: 'vultr', user: 'root', connectTimeout: 8 })
    expect(args).toContain('BatchMode=yes')
    expect(args.join(' ')).toContain('ConnectTimeout=8')
    expect(args).toContain('root@vultr')
  })

  test('leaves host-key checking at its default — accepting blindly would defeat it', () => {
    expect(
      buildSshArgs({ host: 'vultr', user: 'root', connectTimeout: 8 }).join(' '),
    ).not.toContain('StrictHostKeyChecking=no')
  })
})

describe('pickHost', () => {
  // The vultr node is reachable two ways and they fail independently: the
  // tailnet name is the normal route, the public IP is what is left when the
  // tailnet is exactly what broke — which is the state this module exists to
  // repair.
  test('uses the first host that answers', async () => {
    const tried: string[] = []
    const picked = await pickHost(['vultr', '66.135.3.195'], async (h) => {
      tried.push(h)
      return true
    })
    expect(picked.host).toBe('vultr')
    expect(tried).toEqual(['vultr'])
  })

  test('falls through to the next when the preferred host is unreachable', async () => {
    const picked = await pickHost(['vultr', '66.135.3.195'], async (h) => h !== 'vultr')
    expect(picked.host).toBe('66.135.3.195')
    expect(picked.fallback).toBe(true)
  })

  test('reports which host it settled on, so a silent fallback is not silent', async () => {
    expect((await pickHost(['vultr'], async () => true)).fallback).toBe(false)
  })

  test('names every host it tried when none answer', async () => {
    await expect(pickHost(['vultr', '66.135.3.195'], async () => false)).rejects.toThrow(
      /vultr.*66\.135\.3\.195/s,
    )
  })

  test('refuses an empty host list rather than reporting a confusing failure', async () => {
    await expect(pickHost([], async () => true)).rejects.toThrow(/no host/i)
  })
})
