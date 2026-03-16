import type {
  ApiContract,
  ApiOptions,
  ApiStep,
  BearerValue,
  BrowserOptions,
  BrowserStep,
  DynamicValue,
  EnvValue,
  ExistsCheck,
  ExpectStep,
  Flow,
  FlowConfig,
  FlowItem,
  MatcherName,
  RefValue,
  Resolvable,
  SecretValue,
  Section,
  Spec,
  SpecSafety,
  Step,
  StepAction,
  UseStep,
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

// ---------------------------------------------------------------------------
// Browser action builder
// ---------------------------------------------------------------------------

export function browser(action: 'goto', options: { url: Resolvable<string> }): BrowserStep
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
  apis?: Record<string, ApiContract>
  data?: Record<string, unknown>
  tags?: string[]
  safety?: SpecSafety
  // library: reusable flows available to use() but NOT directly executed
  library?: Flow[]
  flows: Flow[]
}

export function spec(name: string, config: SpecConfig): Spec {
  return {
    name,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.apis ? { apis: config.apis } : {}),
    ...(config.data ? { data: config.data } : {}),
    ...(config.tags ? { tags: config.tags } : {}),
    ...(config.safety ? { safety: config.safety } : {}),
    ...(config.library ? { library: config.library } : {}),
    flows: config.flows,
  }
}

// ---------------------------------------------------------------------------
// Re-export types for spec file convenience
// ---------------------------------------------------------------------------

export type { BearerValue, Flow, FlowItem, Spec, Step, Section, ApiContract } from './types.js'
