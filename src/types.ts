// ---------------------------------------------------------------------------
// Dynamic value types -- the only way to reference runtime/environment state
// ---------------------------------------------------------------------------

export type RefValue = { __type: 'ref'; path: string }
export type EnvValue = { __type: 'env'; name: string }
export type SecretValue = { __type: 'secret'; name: string }
// Wraps a token value and resolves to "Bearer <value>" at runtime.
// Use this for Authorization headers instead of manual string construction.
export type BearerValue = { __type: 'bearer'; value: DynamicValue | string }
export type DynamicValue = RefValue | EnvValue | SecretValue | BearerValue
export type Resolvable<T> = T | DynamicValue

// ---------------------------------------------------------------------------
// Matchers -- five only, no more in v1
// ---------------------------------------------------------------------------

export type MatcherName = 'equals' | 'contains' | 'matches' | 'exists' | 'notExists'

// ---------------------------------------------------------------------------
// Browser action types
// ---------------------------------------------------------------------------

export type BrowserAction =
  | 'goto'
  | 'click'
  | 'type'
  | 'press'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'waitFor'
  | 'extract'

// attr: prefix enables attribute extraction (attr:href, attr:data-order-id, etc.)
export type ExtractSource = 'text' | 'value' | 'html' | string // `attr:${string}` subset

export type WaitForOptions =
  | { target: Resolvable<string>; state: 'visible' | 'hidden' | 'attached' | 'detached'; timeout?: number }
  | { url: Resolvable<string>; timeout?: number }

export type BrowserOptions =
  | { action: 'goto'; url: Resolvable<string> }
  | { action: 'click'; target: Resolvable<string> }
  | { action: 'type'; target: Resolvable<string>; value: Resolvable<string> }
  | { action: 'press'; target: Resolvable<string>; key: string }
  | { action: 'select'; target: Resolvable<string>; value: Resolvable<string> }
  | { action: 'check'; target: Resolvable<string> }
  | { action: 'uncheck'; target: Resolvable<string> }
  | { action: 'waitFor' } & WaitForOptions
  | { action: 'extract'; target: Resolvable<string>; save: Record<string, ExtractSource> }

export type BrowserStep = { __type: 'browser' } & BrowserOptions

// ---------------------------------------------------------------------------
// API step types
// ---------------------------------------------------------------------------

// Sentinel marker for inline body expect blocks: { field: existsCheck() }
// Checks that the field is present and non-null without comparing its value.
export type ExistsCheck = { __type: 'exists_check' }

export type InlineExpect = {
  status?: number
  body?: Record<string, Resolvable<unknown> | ExistsCheck>
}

export type ApiOptions = {
  params?: Record<string, Resolvable<string>>
  query?: Record<string, Resolvable<string>>
  headers?: Record<string, Resolvable<string>>
  body?: Record<string, Resolvable<unknown>> | Resolvable<unknown>
  expect?: InlineExpect
  save?: Record<string, string>
}

export type ApiStep = {
  __type: 'api'
  target: string  // "POST /api/orders" or named contract key
  options: ApiOptions
}

// ---------------------------------------------------------------------------
// Expect step types
// ---------------------------------------------------------------------------

export type ExpectStep = {
  __type: 'expect'
  value: DynamicValue
  matcher: MatcherName
  expected?: Resolvable<unknown>
}

// ---------------------------------------------------------------------------
// Use step types (flow reuse)
// ---------------------------------------------------------------------------

export type UseStep = {
  __type: 'use'
  flow: string
  inputs?: Record<string, Resolvable<unknown>>
}

// ---------------------------------------------------------------------------
// Step and Section types
// ---------------------------------------------------------------------------

export type StepAction = BrowserStep | ApiStep | ExpectStep | UseStep

export type Step = {
  name: string
  action: StepAction
  retries?: number
  retryIntervalMs?: number
}

export type Section = {
  __type: 'section'
  name: string
  steps: Step[]
}

export type FlowItem = Step | Section

// ---------------------------------------------------------------------------
// Flow types
// ---------------------------------------------------------------------------

export type InputType = 'string' | 'secret' | 'number' | 'boolean'

export type FlowConfig = {
  inputs?: Record<string, InputType>
  steps: FlowItem[]
}

export type Flow = {
  name: string
  inputs?: Record<string, InputType>
  steps: FlowItem[]
}

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type ApiContract = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  purpose?: string
  request?: {
    params?: Record<string, string>
    query?: Record<string, string>
    headers?: Record<string, string>
    // body is documentary only -- not schema-validated
  }
  response?: {
    status?: number
    // body is documentary only
  }
}

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

export type SpecSafety = 'destructive' | 'non-destructive'

// Declares what a successful run of this spec looks like.
// Defaults to 'pass' (all steps pass). Set to 'error' for fixture specs that are
// intentionally invalid -- the UI will render an error outcome as correct (green)
// and an unexpected pass outcome as alarming (red).
export type SpecExpectedOutcome = 'pass' | 'error'

export type Spec = {
  name: string
  baseUrl?: Resolvable<string>
  apis?: Record<string, ApiContract>
  data?: Record<string, unknown>
  tags?: string[]
  safety?: SpecSafety
  expectedOutcome?: SpecExpectedOutcome
  // library: reusable flows available to use() but NOT directly executed at top level
  library?: Flow[]
  flows: Flow[]
}

// ---------------------------------------------------------------------------
// Compiled execution plan types
// ---------------------------------------------------------------------------

export type ResolvedApiStep = {
  __type: 'api'
  method: string
  path: string
  options: ApiOptions
}

export type ResolvedBrowserStep = BrowserStep

export type ResolvedExpectStep = ExpectStep

export type ResolvedExpectation = {
  matcher: MatcherName
  value: DynamicValue | unknown
  expected?: Resolvable<unknown>
}

export type ExecutableStep = {
  name: string
  section?: string
  flowOrigin?: string
  action: ResolvedApiStep | ResolvedBrowserStep | ResolvedExpectStep
  retries: number
  retryIntervalMs?: number
  saves: Record<string, string>
  inlineExpect?: InlineExpect
  expects: ResolvedExpectation[]
}

// A FlowRange records how steps in the flat plan map back to authored flows.
// startIndex + stepCount allow slicing plan.steps into per-flow groups.
// Flows that expand to zero steps still appear here (stepCount: 0).
export type FlowRange = {
  name: string
  startIndex: number
  stepCount: number
}

export type ExecutionPlan = {
  specName: string
  baseUrl: Resolvable<string>
  apis: Record<string, ApiContract>
  data: Record<string, unknown>
  steps: ExecutableStep[]
  flowRanges: FlowRange[]
}

// ---------------------------------------------------------------------------
// Validation types
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'error' | 'warning'

export type Diagnostic = {
  severity: DiagnosticSeverity
  message: string
  location?: string
}

export type ValidationResult = {
  valid: boolean
  errors: Diagnostic[]
  warnings: Diagnostic[]
}

// ---------------------------------------------------------------------------
// Runtime result types
// ---------------------------------------------------------------------------

export type StepStatus = 'pass' | 'fail' | 'skip'

export type StepResult = {
  name: string
  section?: string
  flowOrigin?: string
  status: StepStatus
  durationMs: number
  error?: string
}

export type FlowResult = {
  name: string
  steps: StepResult[]
  passed: number
  failed: number
  skipped: number
}

export type SpecResult = {
  specName: string
  status: 'pass' | 'fail'
  flows: FlowResult[]
  totalSteps: number
  passedSteps: number
  failedSteps: number
  durationMs: number
}

export type ApiResponse = {
  status: number
  headers: Record<string, string>
  body: unknown
}
