// The readiness wait, against fake probes.
//
// Fixtures rather than a real database, because the case that matters is a
// database that 404s for the first few seconds of its life and there is no way
// to provoke that on demand.

import { expect, test } from 'bun:test'
import { waitUntilReachable } from './index'

const noSleep = async () => {}

test('a probe that succeeds first try does not sleep', async () => {
  let calls = 0
  await waitUntilReachable(
    async () => {
      calls++
    },
    { sleep: noSleep },
  )
  expect(calls).toBe(1)
})

test('a probe that fails then succeeds is waited out', async () => {
  // The real shape: the endpoint 404s a few times, then answers.
  let calls = 0
  await waitUntilReachable(
    async () => {
      if (++calls < 4) throw new Error('SERVER_ERROR: Server returned HTTP status 404')
    },
    { sleep: noSleep },
  )
  expect(calls).toBe(4)
})

test('a probe that never succeeds throws, and says how many tries it got', async () => {
  // Must not hang or pass silently: an unreachable database has to fail the
  // apply, and the attempt count is what tells "raise the budget" apart from
  // "this hostname is wrong".
  let calls = 0
  const err = await waitUntilReachable(
    async () => {
      calls++
      throw new Error('nope')
    },
    { attempts: 3, sleep: noSleep },
  ).catch((e) => e)
  expect(calls).toBe(3)
  expect(err.message).toContain('after 3 attempts')
  expect(err.message).toContain('nope')
})
