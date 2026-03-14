import type {
  ApiContract,
  ApiStep,
  BrowserStep,
  ExecutableStep,
  ExecutionPlan,
  ExpectStep,
  Flow,
  FlowItem,
  InlineExpect,
  Resolvable,
  Section,
  Spec,
  Step,
  UseStep,
} from './types.js'

// ---------------------------------------------------------------------------
// Compiler
//
// Transforms a Spec AST into a flat ExecutionPlan:
//   1. Resolve named API contracts -> concrete method + path
//   2. Expand use() calls -> inline the referenced flow's steps (with input bindings)
//   3. Flatten sections -> step list with section metadata
//   4. Emit ExecutionPlan (baseUrl stays as Resolvable -- resolved at runtime)
// ---------------------------------------------------------------------------

function isSection(item: FlowItem): item is Section {
  return (item as Section).__type === 'section'
}

function isUseStep(step: Step): step is Step & { action: UseStep } {
  return (step.action as UseStep).__type === 'use'
}

function parseMethodPath(target: string): { method: string; path: string } | null {
  // Matches "POST /api/orders", "GET /api/health", etc.
  const match = /^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i.exec(target)
  if (!match) return null
  return { method: match[1]!.toUpperCase(), path: match[2]! }
}

function resolveApiTarget(
  target: string,
  apis: Record<string, ApiContract>
): { method: string; path: string } {
  // Try direct "METHOD /path" format first
  const parsed = parseMethodPath(target)
  if (parsed) return parsed

  // Try named contract
  const contract = apis[target]
  if (contract) {
    return { method: contract.method, path: contract.path }
  }

  throw new Error(
    `api("${target}") does not match a "METHOD /path" pattern and is not a declared contract name.\n` +
    `Declared contracts: ${Object.keys(apis).join(', ') || '(none)'}`
  )
}

// Build a flow lookup map from all flows in the spec (including the spec's own flows)
function buildFlowMap(flows: Flow[]): Map<string, Flow> {
  const map = new Map<string, Flow>()
  for (const f of flows) {
    map.set(f.name, f)
  }
  return map
}

// Substitute ref(inputName) values in a step's options with the caller-provided bindings.
// This is compile-time substitution: ref("email") -> ref("data.user.email") (or a literal).
const DYNAMIC_TYPES = new Set(['ref', 'env', 'secret', 'bearer'])

function substituteRefs(value: unknown, bindings: Record<string, Resolvable<unknown>>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(v => substituteRefs(v, bindings))

  const obj = value as Record<string, unknown>
  const type = obj['__type'] as string | undefined

  // It's a DynamicValue (ref/env/secret) -- handle substitution
  if (type !== undefined && DYNAMIC_TYPES.has(type)) {
    if (type === 'ref') {
      const path = obj['path'] as string | undefined
      if (path && path in bindings) {
        return bindings[path]
      }
    }
    // env() and secret() pass through unchanged
    return value
  }

  // Any other object (BrowserStep, ApiStep, plain object) -- recurse into all properties
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    result[k] = substituteRefs(v, bindings)
  }
  return result
}

function substituteStepRefs(step: Step, bindings: Record<string, Resolvable<unknown>>): Step {
  if (Object.keys(bindings).length === 0) return step
  return {
    ...step,
    action: substituteRefs(step.action, bindings) as Step['action'],
  }
}

function expandStep(
  step: Step,
  flowMap: Map<string, Flow>,
  apis: Record<string, ApiContract>,
  sectionName: string | undefined,
  flowOrigin: string | undefined,
  inputBindings: Record<string, Resolvable<unknown>>,
  callerPrefix: string | undefined
): ExecutableStep[] {
  // Apply any inherited input substitutions to this step's action
  const substitutedStep = substituteStepRefs(step, inputBindings)
  const action = substitutedStep.action

  // The effective step name includes any caller prefix from a use() site
  const effectiveName = callerPrefix
    ? `${callerPrefix} > ${substitutedStep.name}`
    : substitutedStep.name

  if (action.__type === 'use') {
    const useAction = action as UseStep
    const referencedFlow = flowMap.get(useAction.flow)
    if (!referencedFlow) {
      throw new Error(
        `use("${useAction.flow}") references a flow that is not declared in this spec.\n` +
        `Available flows: ${[...flowMap.keys()].join(', ')}`
      )
    }

    // The caller-provided inputs become the bindings for the referenced flow's internal refs
    const callerInputs = useAction.inputs ?? {}

    // Expand the referenced flow's steps inline, substituting its internal input refs.
    // Use the caller step's effective name as the prefix for expanded step names so that
    // two invocations of the same flow produce distinct step names in the plan.
    return expandFlowItems(
      referencedFlow.steps,
      flowMap,
      apis,
      sectionName,
      useAction.flow,
      callerInputs as Record<string, Resolvable<unknown>>,
      effectiveName
    )
  }

  if (action.__type === 'api') {
    const apiAction = action as ApiStep
    const { method, path } = resolveApiTarget(apiAction.target, apis)

    const executableStep: ExecutableStep = {
      name: effectiveName,
      ...(sectionName ? { section: sectionName } : {}),
      ...(flowOrigin ? { flowOrigin } : {}),
      action: {
        __type: 'api',
        method,
        path,
        options: apiAction.options,
      },
      retries: substitutedStep.retries ?? 0,
      saves: apiAction.options.save ?? {},
      ...(apiAction.options.expect !== undefined ? { inlineExpect: apiAction.options.expect } : {}),
      expects: [],
    }

    return [executableStep]
  }

  if (action.__type === 'browser') {
    const executableStep: ExecutableStep = {
      name: effectiveName,
      ...(sectionName ? { section: sectionName } : {}),
      ...(flowOrigin ? { flowOrigin } : {}),
      action: action as BrowserStep,
      retries: substitutedStep.retries ?? 0,
      saves: {},
      expects: [],
    }

    // Browser extract steps carry their saves inline in the action options
    if ((action as BrowserStep).action === 'extract') {
      const extractOpts = action as BrowserStep & { save: Record<string, string> }
      executableStep.saves = extractOpts.save ?? {}
    }

    return [executableStep]
  }

  if (action.__type === 'expect') {
    const expectAction = action as ExpectStep
    const executableStep: ExecutableStep = {
      name: effectiveName,
      ...(sectionName ? { section: sectionName } : {}),
      ...(flowOrigin ? { flowOrigin } : {}),
      action: expectAction,
      retries: substitutedStep.retries ?? 0,
      saves: {},
      expects: [
        {
          matcher: expectAction.matcher,
          value: expectAction.value,
          expected: expectAction.expected,
        },
      ],
    }
    return [executableStep]
  }

  throw new Error(`Unknown step action type: ${(action as { __type: string }).__type}`)
}

function expandFlowItems(
  items: FlowItem[],
  flowMap: Map<string, Flow>,
  apis: Record<string, ApiContract>,
  parentSection: string | undefined,
  flowOrigin: string | undefined,
  inputBindings: Record<string, Resolvable<unknown>>,
  callerPrefix: string | undefined = undefined
): ExecutableStep[] {
  const result: ExecutableStep[] = []

  for (const item of items) {
    if (isSection(item)) {
      // Apply input substitutions to section steps as well
      const substitutedSteps = item.steps.map(s => substituteStepRefs(s, inputBindings))
      for (const s of substitutedSteps) {
        result.push(
          ...expandStep(s, flowMap, apis, item.name, flowOrigin, {}, callerPrefix)
        )
      }
    } else {
      result.push(
        ...expandStep(item, flowMap, apis, parentSection, flowOrigin, inputBindings, callerPrefix)
      )
    }
  }

  return result
}

export function compile(spec: Spec): ExecutionPlan {
  const apis = spec.apis ?? {}
  const data = spec.data ?? {}
  const flows = spec.flows

  // Build flow map from both top-level flows AND library flows.
  // Library flows are available for use() resolution but not directly executed.
  const allFlows = [...(spec.library ?? []), ...flows]
  const flowMap = buildFlowMap(allFlows)

  const allSteps: ExecutableStep[] = []

  // Only execute top-level flows (spec.flows), not library flows.
  for (const flow of flows) {
    const flowSteps = expandFlowItems(flow.steps, flowMap, apis, undefined, flow.name, {}, undefined)
    allSteps.push(...flowSteps)
  }

  return {
    specName: spec.name,
    baseUrl: spec.baseUrl ?? '',
    apis,
    data,
    steps: allSteps,
  }
}

// ---------------------------------------------------------------------------
// Expanded plan formatter (for "ortheon expand" command)
// ---------------------------------------------------------------------------

export function formatExpandedPlan(plan: ExecutionPlan): string {
  const lines: string[] = []
  lines.push(`SPEC: ${plan.specName}`)
  if (plan.baseUrl) {
    const baseUrlStr = typeof plan.baseUrl === 'string'
      ? plan.baseUrl
      : `${(plan.baseUrl as { __type: string; name?: string }).__type}("${(plan.baseUrl as { name?: string }).name ?? ''}")`
    lines.push(`BASE URL: ${baseUrlStr}`)
  }
  lines.push('')
  lines.push(`STEPS (${plan.steps.length} total):`)

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!
    const prefix = `  ${String(i + 1).padStart(3, ' ')}.`
    const section = step.section ? `[${step.section}] ` : ''
    const flowOrigin = step.flowOrigin ? ` (flow: ${step.flowOrigin})` : ''
    const actionStr = formatAction(step.action)

    lines.push(`${prefix} ${section}${step.name}${flowOrigin}`)
    lines.push(`       action: ${actionStr}`)

    if (Object.keys(step.saves).length > 0) {
      lines.push(`       save:   ${JSON.stringify(step.saves)}`)
    }
    if (step.inlineExpect) {
      lines.push(`       expect: ${JSON.stringify(step.inlineExpect)}`)
    }
    if (step.expects.length > 0) {
      for (const e of step.expects) {
        const val = typeof e.value === 'object' && e.value !== null && '__type' in e.value
          ? `ref("${(e.value as { path?: string }).path ?? ''}")`
          : JSON.stringify(e.value)
        const exp = e.expected !== undefined ? ` ${JSON.stringify(e.expected)}` : ''
        lines.push(`       assert: ${val} ${e.matcher}${exp}`)
      }
    }
    if (step.retries > 0) {
      lines.push(`       retries: ${step.retries}`)
    }
  }

  return lines.join('\n')
}

function formatAction(action: ExecutableStep['action']): string {
  if (action.__type === 'api') {
    return `${action.method} ${action.path}`
  }
  if (action.__type === 'browser') {
    const bAction = action as BrowserStep & { action: string; target?: unknown; url?: unknown }
    const target = bAction.target ?? bAction.url ?? ''
    return `browser(${bAction.action}, ${JSON.stringify(target)})`
  }
  if (action.__type === 'expect') {
    return `expect(...)`
  }
  return 'unknown'
}
