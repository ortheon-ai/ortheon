import type {
  AgentSpec,
  ApiContract,
  ApiOptions,
  ApiStep,
  ArgSpec,
  BearerValue,
  BrowserOptions,
  BrowserStep,
  ConversationTool,
  DynamicValue,
  EnvValue,
  ExistsCheck,
  ExpectStep,
  Flow,
  FlowConfig,
  FlowItem,
  GateDescriptor,
  GenerateKind,
  GenerateValue,
  MatchSource,
  MatcherName,
  RefValue,
  Resolvable,
  SecretValue,
  Section,
  Spec,
  SpecExpectedOutcome,
  SpecSafety,
  Step,
  StepAction,
  Toolset,
  UseStep,
  WorkflowSpec,
  WorkflowStep,
  WorkflowTrigger,
  WorkflowPlan,
} from './types.js'

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

export function ref(path: string): RefValue {
  return { __type: 'ref', path }
}

export function env(name: string): EnvValue {
  return { __type: 'env', name }
}

export function secret(name: string): SecretValue {
  return { __type: 'secret', name }
}

/** Wraps a token value to produce "Bearer <token>" at resolution time.
 *  Use this for Authorization headers to make the scheme explicit.
 *
 *  @example
 *  headers: { Authorization: bearer(ref('token')) }
 */
export function bearer(token: DynamicValue | string): BearerValue {
  return { __type: 'bearer', value: token }
}

/** Marker for inline API body expectations: asserts the field exists and is non-null.
 *  Use inside api() expect.body blocks instead of the magic string "exists".
 *
 *  @example
 *  expect: { body: { id: existsCheck(), status: 'confirmed' } }
 */
export function existsCheck(): ExistsCheck {
  return { __type: 'exists_check' }
}

/** Generate a fresh value at execution time (not at module load).
 *  Use this in spec data blocks where a unique value is required per run.
 *
 *  Kinds:
 *  - `'uuid'`         — a random UUID (crypto.randomUUID)
 *  - `'timestamp'`    — current epoch milliseconds as a string
 *  - `'unique-email'` — `prefix+<timestamp>@domain` (requires options.prefix and options.domain)
 *
 *  @example
 *  data: { email: generate('unique-email', { prefix: 'test', domain: 'example.com' }) }
 */
export function generate(kind: GenerateKind, options?: Record<string, string>): GenerateValue {
  return { __type: 'generate', kind, ...(options ? { options } : {}) }
}

// ---------------------------------------------------------------------------
// Browser action builder
// ---------------------------------------------------------------------------

export function browser(action: 'goto', options: { url: Resolvable<string>; base?: string }): BrowserStep
export function browser(action: 'click', options: { target: Resolvable<string> }): BrowserStep
export function browser(action: 'type', options: { target: Resolvable<string>; value: Resolvable<string> }): BrowserStep
export function browser(action: 'press', options: { target: Resolvable<string>; key: string }): BrowserStep
export function browser(action: 'select', options: { target: Resolvable<string>; value: Resolvable<string> }): BrowserStep
export function browser(action: 'check', options: { target: Resolvable<string> }): BrowserStep
export function browser(action: 'uncheck', options: { target: Resolvable<string> }): BrowserStep
export function browser(
  action: 'waitFor',
  options:
    | { target: Resolvable<string>; state: 'visible' | 'hidden' | 'attached' | 'detached'; timeout?: number }
    | { url: Resolvable<string>; timeout?: number }
): BrowserStep
export function browser(
  action: 'extract',
  options: { target: Resolvable<string>; save: Record<string, string> }
): BrowserStep
export function browser(action: string, options: Record<string, unknown>): BrowserStep {
  return { __type: 'browser', action, ...options } as BrowserStep
}

// ---------------------------------------------------------------------------
// API step builder
// ---------------------------------------------------------------------------

export function api(target: string, options: ApiOptions = {}): ApiStep {
  return { __type: 'api', target, options }
}

// ---------------------------------------------------------------------------
// Expect step builder
// ---------------------------------------------------------------------------

export function expect(value: DynamicValue, matcher: 'exists' | 'notExists'): ExpectStep
export function expect(value: DynamicValue, matcher: MatcherName, expected: Resolvable<unknown>): ExpectStep
export function expect(
  value: DynamicValue,
  matcher: MatcherName,
  expected?: Resolvable<unknown>
): ExpectStep {
  return { __type: 'expect', value, matcher, expected }
}

// ---------------------------------------------------------------------------
// Flow reuse builder
// ---------------------------------------------------------------------------

export function use(flowName: string, inputs?: Record<string, Resolvable<unknown>>): UseStep {
  return { __type: 'use', flow: flowName, ...(inputs !== undefined ? { inputs } : {}) }
}

// ---------------------------------------------------------------------------
// Structural builders
// ---------------------------------------------------------------------------

export function step(name: string, action: StepAction, options?: { retries?: number; retryIntervalMs?: number }): Step {
  return {
    name,
    action,
    ...(options?.retries !== undefined ? { retries: options.retries } : {}),
    ...(options?.retryIntervalMs !== undefined ? { retryIntervalMs: options.retryIntervalMs } : {}),
  }
}

export function section(name: string, steps: Step[]): Section {
  return { __type: 'section', name, steps }
}

// Flow always has one canonical shape: flow(name, { inputs?, steps })
export function flow(name: string, config: FlowConfig): Flow {
  return { name, ...(config.inputs ? { inputs: config.inputs } : {}), steps: config.steps }
}

// ---------------------------------------------------------------------------
// Spec builder
// ---------------------------------------------------------------------------

export type SpecConfig = {
  baseUrl?: Resolvable<string>
  // Named URL targets keyed by logical name. 'default' is reserved for baseUrl.
  urls?: Record<string, Resolvable<string>>
  apis?: Record<string, ApiContract>
  data?: Record<string, unknown>
  tags?: string[]
  safety?: SpecSafety
  expectedOutcome?: SpecExpectedOutcome
  // library: reusable flows available to use() but NOT directly executed
  library?: Flow[]
  flows: Flow[]
}

export function spec(name: string, config: SpecConfig): Spec {
  return {
    name,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.urls ? { urls: config.urls } : {}),
    ...(config.apis ? { apis: config.apis } : {}),
    ...(config.data ? { data: config.data } : {}),
    ...(config.tags ? { tags: config.tags } : {}),
    ...(config.safety ? { safety: config.safety } : {}),
    ...(config.expectedOutcome ? { expectedOutcome: config.expectedOutcome } : {}),
    ...(config.library ? { library: config.library } : {}),
    flows: config.flows,
  }
}

// ---------------------------------------------------------------------------
// Agent spec builders
// ---------------------------------------------------------------------------

export type ConversationToolConfig = {
  aliases?: string[]
  source?: MatchSource
  args?: ArgSpec
  prompt?: Resolvable<string>
  requires_approval?: boolean
}

export function tool(name: string, config: ConversationToolConfig): ConversationTool {
  return {
    name,
    ...(config.aliases !== undefined ? { aliases: config.aliases } : {}),
    ...(config.source !== undefined ? { source: config.source } : {}),
    ...(config.args !== undefined ? { args: config.args } : {}),
    ...(config.prompt !== undefined ? { prompt: config.prompt } : {}),
    ...(config.requires_approval !== undefined ? { requires_approval: config.requires_approval } : {}),
  }
}

export function toolset(name: string, tools: ConversationTool[]): Toolset {
  return { __type: 'toolset', name, tools }
}

export type AgentConfig = {
  system: Resolvable<string>
  tools: Array<ConversationTool | Toolset>
}

export function agent(name: string, config: AgentConfig): AgentSpec {
  return {
    __type: 'agent',
    name,
    system: config.system,
    tools: config.tools,
  }
}

// ---------------------------------------------------------------------------
// Re-export types for spec file convenience
// ---------------------------------------------------------------------------

export type { AgentSpec, ArgField, ArgSpec, ArgType, BearerValue, ConversationTool, GenerateKind, GenerateValue, Flow, FlowItem, MatchSource, Spec, SpecExpectedOutcome, Step, Section, ApiContract, Toolset } from './types.js'

// ---------------------------------------------------------------------------
// Workflow spec builders
// ---------------------------------------------------------------------------

export type WorkflowStepConfig = {
  approveBefore?: boolean
  approveAfter?: boolean
}

export type WorkflowConfig = {
  trigger: WorkflowTrigger
  steps: WorkflowStep[]
}

export function workflow(name: string, config: WorkflowConfig): WorkflowSpec {
  return {
    __type: 'workflow',
    name,
    trigger: config.trigger,
    steps: config.steps,
  }
}

/** Workflow trigger builders. Pass the result as the `trigger` field in `workflow()`. */
export const trigger = {
  discussion(config: { category: string; command?: string }): WorkflowTrigger {
    return {
      kind: 'discussion',
      category: config.category,
      ...(config.command !== undefined ? { command: config.command } : {}),
    }
  },

  cron(expr: string): WorkflowTrigger {
    return { kind: 'cron', expr }
  },

  manual(): WorkflowTrigger {
    return { kind: 'manual' }
  },

  spawn(config: { maxDepth: number }): WorkflowTrigger {
    return { kind: 'spawn', maxDepth: config.maxDepth }
  },
}

/** Workflow step builders. Pass results as the `steps` array in `workflow()`. */
export const workflowStep = {
  agent(specName: string, config?: WorkflowStepConfig): WorkflowStep {
    return {
      kind: 'agent',
      specName,
      ...(config?.approveBefore !== undefined ? { approveBefore: config.approveBefore } : {}),
      ...(config?.approveAfter !== undefined ? { approveAfter: config.approveAfter } : {}),
    }
  },
}

export type { GateDescriptor, WorkflowSpec, WorkflowStep, WorkflowTrigger, WorkflowPlan } from './types.js'
