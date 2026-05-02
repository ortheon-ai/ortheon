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
  // Workflow spec builders
  workflow,
  trigger,
  workflowStep,
} from './dsl.js'

// Runtime
export { runSpec, runPlan, runAgentStep } from './runner.js'
export type { RunOptions, RunPlanOptions } from './runner.js'
export { compile, compileAgent, compileWorkflow, formatExpandedPlan, formatAgentPlan, formatAgentSpec, formatCommandReference, formatWorkflowSpec, formatWorkflowPlan } from './compiler.js'
export { validate, validateStructure, validateExpandedPlan, validateAgent, validateToolset, validateWorkflow } from './validator.js'
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
  // Workflow spec types
  WorkflowSpec,
  WorkflowPlan,
  WorkflowTrigger,
  WorkflowStep,
  GateDescriptor,
} from './types.js'
