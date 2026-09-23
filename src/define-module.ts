import type { z } from 'zod'
import { ensureApplyContext } from './context'
import type {
  ActionDeclaration,
  ApplyFn,
  BoundAction,
  DestroyFn,
  InstanceOptions,
  ModuleDefinition,
  ModuleInstance,
  ReadinessDeclaration,
  SecretOutputs,
} from './types'

interface DefineModuleOptions<TConfig extends z.ZodType, TOutputs extends z.ZodType> {
  name: string
  configSchema: TConfig
  outputs: TOutputs
  apply: ApplyFn<z.infer<TConfig>, z.infer<TOutputs>>
  destroy?: DestroyFn<z.infer<TConfig>>
  /** What proves the applied resource is usable — see `ReadinessDeclaration`. */
  ready?: ReadinessDeclaration<z.infer<TConfig>, z.infer<TOutputs>>
  /** Operator-invoked verbs, by name — see `ActionDeclaration`. */
  actions?: Record<string, ActionDeclaration<z.infer<TConfig>>>
  /** Which outputs are credentials, and on what cadence — see `SecretOutputs`. */
  secretOutputs?: SecretOutputs<z.infer<TOutputs>>
}

/**
 * The four modules that declared `ephemeral` in their own config schema before
 * 0.14 — and therefore the only four for which `config: { ephemeral: true }` in
 * a consumer's checked-in instance file ever meant anything.
 *
 * The list is deliberately closed. Every other module's `z.object` STRIPPED an
 * `ephemeral` key, so a stray one — copy-pasted from the old README, which
 * documented the flag as a config field — was silently inert. Honouring it
 * everywhere would give that stray key teeth it never had: `wrangler delete
 * --force` against a live Worker on the next `zbc apply production`, or a hard
 * failure on a module that has no `destroy` at all.
 */
const LEGACY_EPHEMERAL_MODULES = new Set(['turso', 'r2', 'fly', 'cloudflare-token'])

/**
 * The pre-0.14 spelling: `ephemeral` as a field of a module's own config
 * schema. Three of the four modules above acted on it inline, with three
 * different failure policies; the fourth declared it and never read it. The
 * engine owns the rule now, but a consumer's checked-in preview instance files
 * still say `config: { ephemeral: true }` and `zbc update` must not break them —
 * so that spelling keeps working for those four, with a deprecation line
 * printed by `zbc apply`.
 */
export function legacyConfigEphemeral(moduleName: string, config: unknown): boolean {
  return (
    LEGACY_EPHEMERAL_MODULES.has(moduleName) &&
    typeof config === 'object' &&
    config !== null &&
    (config as Record<string, unknown>).ephemeral === true
  )
}

function bindActions<TConfig>(
  actions: Record<string, ActionDeclaration<TConfig>>,
): Record<string, BoundAction<TConfig>> {
  return Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [
      name,
      { ...action, run: (config: TConfig, ctx) => action.run(config, ensureApplyContext(ctx)) },
    ]),
  )
}

export function defineModule<TConfig extends z.ZodType, TOutputs extends z.ZodType>(
  opts: DefineModuleOptions<TConfig, TOutputs>,
): ModuleDefinition<TConfig, TOutputs> {
  const definition: ModuleDefinition<TConfig, TOutputs> = {
    name: opts.name,
    configSchema: opts.configSchema,
    outputsSchema: opts.outputs,
    // The context is normalized HERE rather than in the engine, so a module
    // body may assume `ctx.secret`/`ctx.output` exist whoever called it — the
    // engine, another module's test, a consumer's script. A caller that
    // already holds a full context (the destroy path's on-demand one) is
    // passed through untouched.
    apply: (config, ctx) => opts.apply(config, ensureApplyContext(ctx)),
    destroy: opts.destroy && ((config, ctx) => opts.destroy!(config, ensureApplyContext(ctx))),
    // A probe is a module body like any other: it reaches the provider, and it
    // reads its credential the same way `apply` did. So it gets the same
    // context, normalized in the same place.
    ready: opts.ready && {
      ...opts.ready,
      probe: (outputs, config, ctx) => opts.ready!.probe(outputs, config, ensureApplyContext(ctx)),
    },
    // Same normalization, same reason: an action body is a module body, and
    // it reaches its credential and its imports exactly as `apply` does.
    actions: opts.actions && bindActions(opts.actions),
    // A declaration, not behaviour: the engine reads it, the module body never
    // does. Carried verbatim so `undefined` stays absent rather than becoming a
    // present-but-empty key the engine would have to special-case.
    ...(opts.secretOutputs ? { secretOutputs: opts.secretOutputs } : {}),
    instance(instanceOpts: InstanceOptions<TConfig>): ModuleInstance<TOutputs> {
      return {
        name: instanceOpts.name,
        moduleName: opts.name,
        config: instanceOpts.config,
        imports: instanceOpts.imports ?? [],
        ephemeral: instanceOpts.ephemeral ?? legacyConfigEphemeral(opts.name, instanceOpts.config),
        _outputsSchema: opts.outputs,
        _definition: definition as ModuleDefinition<any, TOutputs>,
      }
    },
  }

  return definition
}
