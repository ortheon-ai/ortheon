// ---------------------------------------------------------------------------
// Ortheon public API
// ---------------------------------------------------------------------------

// DSL builder functions
export {
  spec,
  flow,
  step,
  section,
  browser,
  api,
  expect,
  use,
  ref,
  env,
  secret,
  bearer,
  existsCheck,
} from './dsl.js'

// Runtime
export { runSpec } from './runner.js'
export { compile, formatExpandedPlan } from './compiler.js'
export { validate, validateStructure, validateExpandedPlan } from './validator.js'
export { RuntimeContext } from './context.js'

// Reporters
export { consoleReport, jsonReport, consoleSummary } from './reporter.js'

// Types (re-exported for spec file authoring)
export type {
  Spec,
  Flow,
  FlowConfig,
  Step,
  Section,
  ApiContract,
  ApiOptions,
  BrowserStep,
  ApiStep,
  ExpectStep,
  UseStep,
  BearerValue,
  ExistsCheck,
  DynamicValue,
  RefValue,
  EnvValue,
  SecretValue,
  Resolvable,
  MatcherName,
  ExtractSource,
  InputType,
  ExecutionPlan,
  ExecutableStep,
  SpecResult,
  StepResult,
  FlowResult,
  ValidationResult,
  Diagnostic,
} from './types.js'
