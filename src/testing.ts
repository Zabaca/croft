// The context a module's `apply` needs when there is no engine around it.
//
// Every module body takes an `ApplyContext`, and until now the only thing that
// could build one was a real `zbc apply`. So module authors did one of two
// things: hand-build a context literal at the top of every test file (and get
// `secret`/`output` subtly wrong, or omit them and pass a bare record), or pull
// pure helpers out of `apply` purely to have something callable — which tests
// the helpers and leaves `apply` itself, where the provider calls and the
// wiring live, unexercised.
//
// This is that context, shipped: the same rules the engine applies, over
// whatever the test stubs, plus a record of what the module asked for.

import { createApplyContext } from './context'
import type { ApplyContext, OutputOptions, OutputRef, SecretOptions } from './types'

export interface TestContextOptions {
  /** `secrets.yaml` for this test. Default: none — every `ctx.secret` throws. */
  secrets?: Record<string, string>
  /** Imported instances' outputs, by instance name. Default: none. */
  imports?: Record<string, unknown>
  /** Default `/zbc-test-project` — a path no test should be writing to. */
  projectRoot?: string
}

export interface TestApplyContext extends ApplyContext {
  /** Secret keys the module asked for, in the order it asked. */
  readonly secretsRead: string[]
  /**
   * Output refs the module resolved, as `<instance>.<output>`, in order —
   * through either `output` or `outputValue`.
   */
  readonly outputsRead: string[]
}

/**
 * An `ApplyContext` over stubbed secrets and imports.
 *
 * The rules are not re-implemented here: `secret` and `output` are the engine's
 * own, so a test sees the same failure a deploy would — a missing secret throws
 * naming the key rather than handing the module `undefined` and failing later
 * at a provider 403 that reads like a permissions problem.
 *
 * ```ts
 * const ctx = createTestContext({
 *   secrets: { CLOUDFLARE_API_TOKEN: 'tok' },
 *   imports: { 'main-db': { databaseUrl: 'libsql://test' } },
 * })
 * const outputs = await myModule.apply({ … }, ctx)
 * expect(ctx.secretsRead).toContain('CLOUDFLARE_API_TOKEN')
 * ```
 */
export function createTestContext(opts: TestContextOptions = {}): TestApplyContext {
  const base = createApplyContext({
    secrets: opts.secrets ?? {},
    imports: opts.imports ?? {},
    projectRoot: opts.projectRoot ?? '/zbc-test-project',
  })

  const secretsRead: string[] = []
  const outputsRead: string[] = []

  return {
    ...base,
    secretsRead,
    outputsRead,
    // Recorded before resolution, not after: a test asserting "this module
    // reads the secret its registry.json declares" has to see the ask even
    // when the ask is what failed.
    secret(key: string, secretOpts?: SecretOptions): string {
      secretsRead.push(key)
      return base.secret(key, secretOpts)
    },
    output(ref: OutputRef, field: string, outputOpts?: OutputOptions): string {
      outputsRead.push(`${ref.from ?? '?'}.${ref.output ?? '?'}`)
      return base.output(ref, field, outputOpts)
    },
    // Both spellings of the same edge land in one list: a test asserting "this
    // module reads its sibling's output" should not have to know which of the
    // two the module happened to call.
    outputValue(ref: OutputRef, field: string): unknown {
      outputsRead.push(`${ref.from ?? '?'}.${ref.output ?? '?'}`)
      return base.outputValue(ref, field)
    },
  }
}
