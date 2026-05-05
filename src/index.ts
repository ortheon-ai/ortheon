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
  agentStep,
  tool,
  toolset,
} from './dsl.js'

// Runtime
export { runSpec, runPlan } from './runner.js'
export type { RunOptions, RunPlanOptions } from './runner.js'
export {
  compile,
  compileAgent,
  flattenTools,
  formatExpandedPlan,
  formatAgentSpec,
  formatDispatchReference,
} from './compiler.js'
export {
  validate,
  validateStructure,
  validateExpandedPlan,
  validateAgent,
  validateToolset,
} from './validator.js'
export { RuntimeContext } from './context.js'

// Agent helpers
export { buildAgentPrompt, parseAgentDispatch } from './agent.js'
export type { AgentDispatch, AgentPromptPayload } from './agent.js'

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
  AgentStep,
  AgentPlan,
  ConversationTool,
  Toolset,
  ArgType,
  ArgField,
  ArgSpec,
  SerializedTool,
} from './types.js'
