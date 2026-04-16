import type {
  AgentPlan,
  AgentSpec,
  ApiContract,
  ApiStep,
  BrowserStep,
  ConversationTool,
  ExecutableStep,
  ExecutionPlan,
  ExpectStep,
  Flow,
  FlowItem,
  FlowRange,
  InlineExpect,
  Resolvable,
  Section,
  SerializedTool,
  Spec,
  Step,
  Toolset,
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
const DYNAMIC_TYPES = new Set(['ref', 'env', 'secret', 'bearer', 'generate'])

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
    const contract = apis[apiAction.target]
    const { method, path } = resolveApiTarget(apiAction.target, apis)
    // Step-level base wins over contract-level base.
    const base = apiAction.options.base ?? contract?.base

    const executableStep: ExecutableStep = {
      name: effectiveName,
      ...(sectionName ? { section: sectionName } : {}),
      ...(flowOrigin ? { flowOrigin } : {}),
      action: {
        __type: 'api',
        method,
        path,
        ...(base !== undefined ? { base } : {}),
        options: apiAction.options,
      },
      retries: substitutedStep.retries ?? 0,
      ...(substitutedStep.retryIntervalMs !== undefined ? { retryIntervalMs: substitutedStep.retryIntervalMs } : {}),
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
      ...(substitutedStep.retryIntervalMs !== undefined ? { retryIntervalMs: substitutedStep.retryIntervalMs } : {}),
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
      ...(substitutedStep.retryIntervalMs !== undefined ? { retryIntervalMs: substitutedStep.retryIntervalMs } : {}),
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
  const flowRanges: FlowRange[] = []

  // Only execute top-level flows (spec.flows), not library flows.
  for (const flow of flows) {
    const startIndex = allSteps.length
    const flowSteps = expandFlowItems(flow.steps, flowMap, apis, undefined, flow.name, {}, undefined)
    allSteps.push(...flowSteps)
    flowRanges.push({ name: flow.name, startIndex, stepCount: flowSteps.length })
  }

  // Build the unified urls map. baseUrl is the 'default' entry; spec.urls adds named entries.
  // Explicit urls['default'] (if provided) overrides the baseUrl-derived default.
  const urls: Record<string, Resolvable<string>> = {
    default: spec.baseUrl ?? '',
    ...(spec.urls ?? {}),
  }

  return {
    specName: spec.name,
    // Mirror urls['default'] so that an explicit urls['default'] override is reflected here too.
    // Non-null assertion: 'default' is always set in the literal above the spread.
    baseUrl: urls['default']!,
    urls,
    apis,
    data,
    steps: allSteps,
    flowRanges,
  }
}

// ---------------------------------------------------------------------------
// Expanded plan formatter (for "ortheon expand" command)
// ---------------------------------------------------------------------------

export function formatExpandedPlan(plan: ExecutionPlan): string {
  const lines: string[] = []
  lines.push(`SPEC: ${plan.specName}`)
  for (const [key, val] of Object.entries(plan.urls)) {
    // Skip empty-string placeholders (spec with no baseUrl / unconfigured entry)
    if (typeof val === 'string' && !val) continue
    const valStr = typeof val === 'string'
      ? val
      : `${(val as { __type: string; name?: string }).__type}("${(val as { name?: string }).name ?? ''}")`
    if (key === 'default') {
      lines.push(`BASE URL: ${valStr}`)
    } else {
      lines.push(`URL [${key}]: ${valStr}`)
    }
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
    if (step.retryIntervalMs !== undefined) {
      lines.push(`       retryIntervalMs: ${step.retryIntervalMs}`)
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Agent compiler
//
// Transforms an AgentSpec into an AgentPlan:
//   - Defaults source to 'llm' when not specified
//   - Passes aliases, args, prompt, and system through unchanged
// ---------------------------------------------------------------------------

export function flattenTools(entries: AgentSpec['tools']): ConversationTool[] {
  const result: ConversationTool[] = []
  for (const entry of entries) {
    if ('__type' in entry && entry.__type === 'toolset') {
      result.push(...entry.tools)
    } else {
      result.push(entry as ConversationTool)
    }
  }
  return result
}

export function compileAgent(spec: AgentSpec): AgentPlan {
  const tools: SerializedTool[] = flattenTools(spec.tools).map(t => ({
    name: t.name,
    ...(t.aliases !== undefined ? { aliases: t.aliases } : {}),
    source: t.source ?? 'llm',
    ...(t.args !== undefined ? { args: t.args } : {}),
    ...(t.prompt !== undefined ? { prompt: t.prompt } : {}),
  }))

  return {
    specName: spec.name,
    system: spec.system,
    tools,
    commandReference: formatCommandReference(tools),
  }
}

// ---------------------------------------------------------------------------
// Command reference formatter
//
// Generates an LLM-ready block describing available commands. Intended to be
// appended to the system prompt so the LLM does not need to duplicate the
// command table in the spec's `system` field.
// ---------------------------------------------------------------------------

export function formatCommandReference(tools: SerializedTool[]): string {
  if (tools.length === 0) return ''

  const lines: string[] = [
    'Commands are available by writing /command key="value" on its own line.',
    '',
    'Available commands:',
  ]

  for (const t of tools) {
    let cmdLine = `  /${t.name}`
    if (t.args && Object.keys(t.args).length > 0) {
      const argParts = Object.entries(t.args).map(([k, f]) => {
        const req = f.required ? ', required' : ''
        return `${k}="<${f.type}${req}>"`
      })
      cmdLine += ' ' + argParts.join(' ')
    }
    if (t.aliases && t.aliases.length > 0) {
      cmdLine += `  (aliases: ${t.aliases.join(', ')})`
    }
    lines.push(cmdLine)
  }

  lines.push('')
  lines.push('Rules:')
  lines.push('- One command per line, at the start of the line')
  lines.push('- Always quote argument values: key="value"')
  lines.push('- Do not place commands inside code blocks or block quotes')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Agent plan formatter
// ---------------------------------------------------------------------------

function formatResolvable(value: Resolvable<string>): string {
  if (typeof value === 'string') return value
  const v = value as { __type: string; path?: string; name?: string; kind?: string; value?: unknown }
  switch (v.__type) {
    case 'ref':      return `ref("${v.path ?? ''}")`
    case 'env':      return `env("${v.name ?? ''}")`
    case 'secret':   return `secret("${v.name ?? ''}")`
    case 'generate': return `generate("${v.kind ?? ''}")`
    case 'bearer':   return `bearer(...)`
    default:         return `${v.__type}(...)`
  }
}

export function formatAgentPlan(plan: AgentPlan): string {
  const lines: string[] = []

  lines.push(`Agent: ${plan.specName}`)
  lines.push(`System prompt: ${formatResolvable(plan.system)}`)
  lines.push('')

  if (plan.tools.length === 0) {
    lines.push('  (no commands defined)')
    return lines.join('\n')
  }

  lines.push('  Arg syntax: /command key="value" ...')
  lines.push('')

  for (const t of plan.tools) {
    const aliasesSuffix = t.aliases && t.aliases.length > 0 ? `   aliases: ${t.aliases.join(', ')}` : ''
    lines.push(`  command: ${t.name}   source: ${t.source}${aliasesSuffix}`)

    if (t.args && Object.keys(t.args).length > 0) {
      const argParts = Object.entries(t.args).map(([k, f]) => {
        const req = f.required ? ', required' : ''
        return `${k} (${f.type}${req})`
      })
      lines.push(`    args: ${argParts.join(', ')}`)
    }

    if (t.prompt !== undefined) {
      const promptStr = typeof t.prompt === 'string'
        ? t.prompt.trim()
        : formatResolvable(t.prompt)
      lines.push(`    prompt: ${promptStr}`)
    }

    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

function formatToolEntry(t: ConversationTool, lines: string[]): void {
  const source = t.source ?? 'llm'
  const aliasesSuffix = t.aliases && t.aliases.length > 0 ? `   aliases: ${t.aliases.join(', ')}` : ''
  lines.push(`  command: ${t.name}   source: ${source}${aliasesSuffix}`)

  if (t.args && Object.keys(t.args).length > 0) {
    const argParts = Object.entries(t.args).map(([k, f]) => {
      const req = f.required ? ', required' : ''
      return `${k} (${f.type}${req})`
    })
    lines.push(`    args: ${argParts.join(', ')}`)
  }

  if (t.prompt !== undefined) {
    const promptStr = typeof t.prompt === 'string'
      ? t.prompt.trim()
      : formatResolvable(t.prompt)
    lines.push(`    prompt: ${promptStr}`)
  }

  lines.push('')
}

// Renders an AgentSpec with toolset groupings visible. Used by ortheon expand
// so provenance is shown even though the compiled AgentPlan is flat.
export function formatAgentSpec(spec: AgentSpec): string {
  const lines: string[] = []

  lines.push(`Agent: ${spec.name}`)
  lines.push(`System prompt: ${formatResolvable(spec.system)}`)
  lines.push('')

  const allEntries = spec.tools
  if (allEntries.length === 0) {
    lines.push('  (no commands defined)')
    return lines.join('\n')
  }

  lines.push('  Arg syntax: /command key="value" ...')
  lines.push('')

  for (const entry of allEntries) {
    if ('__type' in entry && (entry as Toolset).__type === 'toolset') {
      const ts = entry as Toolset
      lines.push(`  [toolset: ${ts.name}]`)
      for (const t of ts.tools) {
        formatToolEntry(t, lines)
      }
    } else {
      formatToolEntry(entry as ConversationTool, lines)
    }
  }

  return lines.join('\n').trimEnd()
}

function formatAction(action: ExecutableStep['action']): string {
  if (action.__type === 'api') {
    const baseSuffix = action.base ? ` [base: ${action.base}]` : ''
    return `${action.method} ${action.path}${baseSuffix}`
  }
  if (action.__type === 'browser') {
    const bAction = action as BrowserStep & { action: string; target?: unknown; url?: unknown; base?: string }
    const target = bAction.target ?? bAction.url ?? ''
    const baseSuffix = bAction.action === 'goto' && bAction.base ? ` [base: ${bAction.base}]` : ''
    return `browser(${bAction.action}, ${JSON.stringify(target)})${baseSuffix}`
  }
  if (action.__type === 'expect') {
    return `expect(...)`
  }
  return 'unknown'
}
