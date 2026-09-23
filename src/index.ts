export { defineModule } from './define-module'
export { defineConfig } from './config'
export {
  createApplyContext,
  ensureApplyContext,
  resolveOutput,
  resolveOutputValue,
  resolveSecret,
} from './context'
export { createTestContext } from './testing'
export type { TestApplyContext, TestContextOptions } from './testing'
export type {
  ModuleDefinition,
  ModuleInstance,
  ApplyContext,
  ApplyContextInput,
  OutputRef,
  OutputOptions,
  SecretOptions,
  InstanceOptions,
  ReadyFn,
  ReadinessDeclaration,
  ActionFn,
  ActionDeclaration,
  BoundAction,
} from './types'
