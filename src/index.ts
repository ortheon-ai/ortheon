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
  generate,
  // Agent spec builders
  agent,
  tool,
} from './dsl.js'

// Runtime
export { runSpec, runPlan, matchAgent } from './runner.js'
export type { RunOptions, RunPlanOptions } from './runner.js'
export { compile, compileAgent, formatExpandedPlan, formatAgentPlan } from './compiler.js'
export { validate, validateStructure, validateExpandedPlan, validateAgent } from './validator.js'
export { RuntimeContext } from './context.js'

// Reporters
export { consoleReport, jsonReport, consoleSummary } from './reporter.js'

// Types (re-exported for spec file authoring)
export type {
  // Behavioral spec types
  Spec,
  SpecExpectedOutcome,
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
  GenerateKind,
  GenerateValue,
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
  // Agent spec types
  AgentSpec,
  AgentPlan,
  ConversationTool,
  ToolMatch,
  MatchSource,
  RuntimeMessageSource,
  SerializedTool,
  SerializedToolMatch,
  AgentMessage,
  ToolCandidate,
  AgentMatchResult,
} from './types.js'
