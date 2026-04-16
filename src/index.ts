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
  toolset,
} from './dsl.js'

// Runtime
export { runSpec, runPlan, runAgentStep } from './runner.js'
export type { RunOptions, RunPlanOptions } from './runner.js'
export { compile, compileAgent, formatExpandedPlan, formatAgentPlan, formatAgentSpec, formatCommandReference } from './compiler.js'
export { validate, validateStructure, validateExpandedPlan, validateAgent, validateToolset } from './validator.js'
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
  Toolset,
  MatchSource,
  RuntimeMessageSource,
  ArgType,
  ArgField,
  ArgSpec,
  SerializedTool,
  AgentMessage,
  ToolCallResult,
  AgentStepResult,
} from './types.js'
