import type {
  AgentSpec,
  ApiStep,
  ArgType,
  BrowserStep,
  ConversationTool,
  Diagnostic,
  ExecutableStep,
  ExecutionPlan,
  ExpectStep,
  Flow,
  FlowItem,
  MatchSource,
  MatcherName,
  RefValue,
  ResolvedApiStep,
  Section,
  Spec,
  Step,
  Toolset,
  UseStep,
  ValidationResult,
  WorkflowSpec,
} from './types.js'

// ---------------------------------------------------------------------------
// Validator -- two-pass validation
//
// Pass 1: Structural validation on raw Spec AST (before compilation)
//   - name uniqueness
//   - action shape correctness
//   - matcher arity
//   - named API targets exist
//   - use() targets exist and receive all declared inputs
//   - save path syntax validity
//
// Pass 2: Expanded-plan validation (after compilation)
//   - ref resolution (every ref traces to a prior save, data, or flow input)
//   - save ordering (ref does not precede the step that saves it)
//   - path param completeness ({orderId} requires params.orderId)
// ---------------------------------------------------------------------------

const VALID_BROWSER_ACTIONS = new Set([
  'goto', 'click', 'type', 'press', 'select', 'check', 'uncheck', 'waitFor', 'extract',
])

const MATCHERS_REQUIRING_EXPECTED = new Set<MatcherName>([
  'equals', 'contains', 'matches',
])

const MATCHERS_NO_EXPECTED = new Set<MatcherName>([
  'exists', 'notExists',
])

// Valid save NAME: the context store key (dot-notation + bracket indexing only, no dashes).
const SAVE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*(\[\d+\])*([.][a-zA-Z_][a-zA-Z0-9_.]*(\[\d+\])*)*$/

// Valid save PATH: the runtime source expression.
// Accepted: "body", "status", "body.<dot-path>", "headers.<header-name>"
// Header names are case-insensitive and may contain letters, digits, and hyphens.
function isValidSavePath(path: string): boolean {
  if (path === 'body' || path === 'status') return true
  if (path.startsWith('body.')) return SAVE_NAME_RE.test(path.slice(5))
  if (path.startsWith('headers.')) return /^headers\.[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(path)
  return false
}

function isSection(item: FlowItem): item is Section {
  return (item as Section).__type === 'section'
}

function validateSaveName(name: string): boolean {
  return SAVE_NAME_RE.test(name)
}

// ---------------------------------------------------------------------------
// Pass 1: Structural validation
// ---------------------------------------------------------------------------

export function validateStructure(spec: Spec): ValidationResult {
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []

  const apis = spec.apis ?? {}
  const flowNames = new Set<string>()

  // Build the set of valid base names: 'default' is always valid (maps to baseUrl).
  const validBases = new Set<string>(['default'])
  for (const key of Object.keys(spec.urls ?? {})) {
    validBases.add(key)
  }

  // Validate contract-level base declarations.
  for (const [contractName, contract] of Object.entries(apis)) {
    if (contract.base !== undefined && !validBases.has(contract.base)) {
      errors.push({
        severity: 'error',
        message: `Contract "${contractName}" declares base "${contract.base}" which is not defined in the spec's urls map. ` +
          `Available bases: ${[...validBases].join(', ')}`,
      })
    }
  }

  // Collect all flow names: both library flows and top-level flows (needed for use() validation)
  const allFlows = [...(spec.library ?? []), ...spec.flows]

  const flowMap = new Map<string, Flow>()

  for (const flow of allFlows) {
    if (flowNames.has(flow.name)) {
      errors.push({
        severity: 'error',
        message: `Duplicate flow name: "${flow.name}"`,
      })
    }
    flowNames.add(flow.name)
    flowMap.set(flow.name, flow)
  }

  for (const flow of allFlows) {
    const location = `flow("${flow.name}")`
    const stepNames = new Set<string>()

    const allSteps = flattenToSteps(flow.steps)

    for (const step of allSteps) {
      // Step name uniqueness within flow
      if (stepNames.has(step.name)) {
        errors.push({
          severity: 'error',
          message: `Duplicate step name: "${step.name}" in ${location}`,
          location,
        })
      }
      stepNames.add(step.name)

      // Validate the step action
      validateStepAction(step, apis, flowNames, flowMap, location, errors, warnings, validBases)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

function flattenToSteps(items: FlowItem[]): Step[] {
  const steps: Step[] = []
  for (const item of items) {
    if (isSection(item)) {
      steps.push(...item.steps)
    } else {
      steps.push(item)
    }
  }
  return steps
}

function validateStepAction(
  step: Step,
  apis: Record<string, import('./types.js').ApiContract>,
  flowNames: Set<string>,
  flowMap: Map<string, Flow>,
  location: string,
  errors: Diagnostic[],
  warnings: Diagnostic[],
  validBases: Set<string>
): void {
  const action = step.action
  const stepLocation = `${location} > step("${step.name}")`

  // Validate retries: must be a non-negative integer when present
  if (step.retries !== undefined) {
    if (!Number.isFinite(step.retries) || step.retries < 0 || !Number.isInteger(step.retries)) {
      errors.push({
        severity: 'error',
        message: `retries must be a non-negative integer in ${stepLocation}`,
        location: stepLocation,
      })
    }
  }

  // Validate retryIntervalMs: must be a non-negative finite number when present
  if (step.retryIntervalMs !== undefined) {
    if (!Number.isFinite(step.retryIntervalMs) || step.retryIntervalMs < 0) {
      errors.push({
        severity: 'error',
        message: `retryIntervalMs must be a non-negative finite number in ${stepLocation}`,
        location: stepLocation,
      })
    }
  }

  switch (action.__type) {
    case 'browser': {
      const bAction = action as BrowserStep & { action: string; base?: string }
      if (!VALID_BROWSER_ACTIONS.has(bAction.action)) {
        errors.push({
          severity: 'error',
          message: `Unknown browser action: "${bAction.action}" in ${stepLocation}`,
          location: stepLocation,
        })
      }
      // Validate base on goto steps.
      if (bAction.action === 'goto' && bAction.base !== undefined && !validBases.has(bAction.base)) {
        errors.push({
          severity: 'error',
          message: `browser("goto") declares base "${bAction.base}" which is not defined in the spec's urls map in ${stepLocation}. ` +
            `Available bases: ${[...validBases].join(', ')}`,
          location: stepLocation,
        })
      }
      // extract must have save block
      if (bAction.action === 'extract') {
        const opts = action as BrowserStep & { save?: unknown }
        if (!opts.save || typeof opts.save !== 'object') {
          errors.push({
            severity: 'error',
            message: `browser("extract") must have a "save" block in ${stepLocation}`,
            location: stepLocation,
          })
        } else {
          for (const [saveName] of Object.entries(opts.save as Record<string, string>)) {
            if (!validateSaveName(saveName)) {
              errors.push({
                severity: 'error',
                message: `Invalid save name "${saveName}" in ${stepLocation}. Use dot notation + bracket indexing only.`,
                location: stepLocation,
              })
            }
          }
        }
      }
      break
    }
    case 'api': {
      const apiAction = action as ApiStep
      const target = apiAction.target

      // If not "METHOD /path", must be a declared contract
      const methodPathRe = /^(GET|POST|PUT|PATCH|DELETE)\s+/i
      if (!methodPathRe.test(target) && !(target in apis)) {
        errors.push({
          severity: 'error',
          message: `api("${target}") is not a declared contract name and does not match "METHOD /path" format in ${stepLocation}`,
          location: stepLocation,
        })
      }

      // Validate step-level base override.
      if (apiAction.options.base !== undefined && !validBases.has(apiAction.options.base)) {
        errors.push({
          severity: 'error',
          message: `api("${target}") declares base "${apiAction.options.base}" which is not defined in the spec's urls map in ${stepLocation}. ` +
            `Available bases: ${[...validBases].join(', ')}`,
          location: stepLocation,
        })
      }

      // Validate save names and paths
      if (apiAction.options.save) {
        for (const [saveName, savePath] of Object.entries(apiAction.options.save)) {
          if (!validateSaveName(saveName)) {
            errors.push({
              severity: 'error',
              message: `Invalid save name "${saveName}" in ${stepLocation}. Use dot notation + bracket indexing only.`,
              location: stepLocation,
            })
          }
          if (!isValidSavePath(savePath)) {
            warnings.push({
              severity: 'warning',
              message: `Save path "${savePath}" in ${stepLocation} is not a recognised source expression. Use "body", "status", "body.<path>", or "headers.<name>".`,
              location: stepLocation,
            })
          }
        }
      }
      break
    }
    case 'expect': {
      const expectAction = action as ExpectStep
      const matcher = expectAction.matcher

      if (MATCHERS_REQUIRING_EXPECTED.has(matcher) && expectAction.expected === undefined) {
        errors.push({
          severity: 'error',
          message: `expect() with matcher "${matcher}" requires an expected value in ${stepLocation}`,
          location: stepLocation,
        })
      }
      if (MATCHERS_NO_EXPECTED.has(matcher) && expectAction.expected !== undefined) {
        warnings.push({
          severity: 'warning',
          message: `expect() with matcher "${matcher}" ignores the expected value in ${stepLocation}`,
          location: stepLocation,
        })
      }
      break
    }
    case 'use': {
      const useAction = action as UseStep
      if (!flowNames.has(useAction.flow)) {
        errors.push({
          severity: 'error',
          message: `use("${useAction.flow}") references a flow that is not declared in this spec in ${stepLocation}`,
          location: stepLocation,
        })
      } else {
        // Check that all declared inputs are provided and no undeclared inputs are passed
        const referencedFlow = flowMap.get(useAction.flow)
        const declaredInputs = Object.keys(referencedFlow?.inputs ?? {})
        const providedInputs = Object.keys(useAction.inputs ?? {})
        for (const required of declaredInputs) {
          if (!providedInputs.includes(required)) {
            errors.push({
              severity: 'error',
              message: `use("${useAction.flow}") is missing required input "${required}" in ${stepLocation}`,
              location: stepLocation,
            })
          }
        }
        for (const extra of providedInputs) {
          if (!declaredInputs.includes(extra)) {
            warnings.push({
              severity: 'warning',
              message: `use("${useAction.flow}") provides undeclared input "${extra}" in ${stepLocation}`,
              location: stepLocation,
            })
          }
        }
      }
      break
    }
    default: {
      errors.push({
        severity: 'error',
        message: `Unknown step action type: "${(action as { __type: string }).__type}" in ${stepLocation}`,
        location: stepLocation,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 2: Expanded-plan validation
// ---------------------------------------------------------------------------

export function validateExpandedPlan(plan: ExecutionPlan): ValidationResult {
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []

  // Build valid base set from the plan's urls map (may be absent on legacy plans).
  const validPlanBases = new Set<string>(Object.keys(plan.urls ?? {}))

  // Check for duplicate step names across the entire expanded plan (catches double use() expansion)
  const allStepNames = new Set<string>()
  for (const step of plan.steps) {
    if (allStepNames.has(step.name)) {
      errors.push({
        severity: 'error',
        message: `Duplicate step name in expanded plan: "${step.name}". If this step comes from a reused flow, the use() caller step name is used as a prefix -- ensure each use() step has a unique name.`,
      })
    }
    allStepNames.add(step.name)
  }

  // Track what names have been saved so far (as we walk forward)
  const savedNames = new Set<string>()

  // Pre-populate from spec data keys (data.user, data.product, etc.)
  // At runtime these are available as "data.xxx"
  savedNames.add('data')

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!
    const location = `step[${i}]("${step.name}")`

    // Check all refs used in this step reference previously saved values
    checkRefsInStep(step, savedNames, location, errors)

    // Check base references in expanded API steps.
    if (step.action.__type === 'api') {
      const apiAction = step.action as ResolvedApiStep
      if (apiAction.base !== undefined && !validPlanBases.has(apiAction.base)) {
        errors.push({
          severity: 'error',
          message: `Step "${step.name}" references base "${apiAction.base}" which is not in the plan's urls map. ` +
            `Available bases: ${[...validPlanBases].join(', ')}`,
          location,
        })
      }
    }

    // Check path params
    if (step.action.__type === 'api') {
      const apiAction = step.action
      const pathParams = extractPathParams(apiAction.path)
      if (pathParams.length > 0) {
        const stepParams = (apiAction.options?.params ?? {}) as Record<string, unknown>
        for (const param of pathParams) {
          if (!(param in stepParams)) {
            errors.push({
              severity: 'error',
              message: `Path param "{${param}}" in "${apiAction.path}" requires params.${param} in ${location}`,
              location,
            })
          }
        }
      }
    }

    // Register what this step saves
    for (const saveName of Object.keys(step.saves)) {
      savedNames.add(saveName)
      // Also register nested save paths as available prefixes
      const topKey = saveName.split('.')[0]
      if (topKey) savedNames.add(topKey)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

function extractPathParams(path: string): string[] {
  const params: string[] = []
  const re = /\{(\w+)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(path)) !== null) {
    if (match[1]) params.push(match[1])
  }
  return params
}

function collectRefs(value: unknown): RefValue[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'object' && '__type' in value) {
    if ((value as { __type: string }).__type === 'ref') {
      return [value as RefValue]
    }
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectRefs)
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(collectRefs)
  }
  return []
}

function checkRefsInStep(
  step: ExecutableStep,
  savedNames: Set<string>,
  location: string,
  errors: Diagnostic[]
): void {
  const refs = collectRefs(step.action)

  for (const ref of refs) {
    const topKey = ref.path.split('.')[0] ?? ref.path
    if (!savedNames.has(topKey) && !savedNames.has(ref.path)) {
      errors.push({
        severity: 'error',
        message: `ref("${ref.path}") used in ${location} but "${topKey}" has not been saved by any prior step`,
        location,
      })
    }
  }

  // Also check expects
  for (const expectation of step.expects) {
    const refs2 = collectRefs(expectation.value)
    for (const ref of refs2) {
      const topKey = ref.path.split('.')[0] ?? ref.path
      if (!savedNames.has(topKey) && !savedNames.has(ref.path)) {
        errors.push({
          severity: 'error',
          message: `ref("${ref.path}") in expect() of ${location} has not been saved by any prior step`,
          location,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Agent validator
// ---------------------------------------------------------------------------

const KEBAB_RE = /^[a-z0-9][a-z0-9-]*$/
const VALID_SOURCES = new Set<MatchSource>(['user', 'llm', 'tool', 'any'])
const VALID_ARG_TYPES = new Set<ArgType>(['string', 'number', 'boolean'])

// ---------------------------------------------------------------------------
// Per-tool validation (shared by validateAgent and validateToolset)
// ---------------------------------------------------------------------------

function validateTool(
  t: ConversationTool,
  allIdentifiers: Set<string>,
  errors: Diagnostic[],
  warnings: Diagnostic[],
): void {
  if (!KEBAB_RE.test(t.name)) {
    errors.push({
      severity: 'error',
      message: `tool name "${t.name}" must be kebab-case (lowercase letters, digits, hyphens; must start with a letter or digit)`,
    })
  }

  if (allIdentifiers.has(t.name)) {
    errors.push({
      severity: 'error',
      message: `Duplicate command identifier: "${t.name}" (conflicts with another tool name or alias)`,
    })
  } else {
    allIdentifiers.add(t.name)
  }

  for (const alias of t.aliases ?? []) {
    if (!KEBAB_RE.test(alias)) {
      errors.push({
        severity: 'error',
        message: `tool("${t.name}") alias "${alias}" must be kebab-case`,
      })
    }
    if (allIdentifiers.has(alias)) {
      errors.push({
        severity: 'error',
        message: `Duplicate command identifier: "${alias}" (alias of tool "${t.name}" conflicts with another tool name or alias)`,
      })
    } else {
      allIdentifiers.add(alias)
    }
  }

  if (t.source !== undefined && !VALID_SOURCES.has(t.source)) {
    errors.push({
      severity: 'error',
      message: `tool("${t.name}") has invalid source "${t.source}". Valid values: user, llm, tool, any`,
    })
  }

  if (
    t.prompt !== undefined &&
    typeof t.prompt === 'object' &&
    t.prompt !== null &&
    '__type' in (t.prompt as object) &&
    (t.prompt as { __type: string }).__type === 'secret'
  ) {
    warnings.push({
      severity: 'warning',
      message: `tool("${t.name}") prompt uses secret() -- this value will be sent to an LLM, creating a leakage risk. Use env() instead.`,
    })
  }

  if (t.args) {
    for (const [fieldName, field] of Object.entries(t.args)) {
      if (!KEBAB_RE.test(fieldName)) {
        errors.push({
          severity: 'error',
          message: `tool("${t.name}") arg "${fieldName}" must be kebab-case`,
        })
      }
      if (!VALID_ARG_TYPES.has(field.type as ArgType)) {
        errors.push({
          severity: 'error',
          message: `tool("${t.name}") arg "${fieldName}" has invalid type "${field.type}". Valid types: string, number, boolean`,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// validateToolset: standalone validation for a named tool group
// ---------------------------------------------------------------------------

export function validateToolset(ts: Toolset): ValidationResult {
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []

  if (!KEBAB_RE.test(ts.name)) {
    errors.push({
      severity: 'error',
      message: `toolset name "${ts.name}" must be kebab-case`,
    })
  }

  const allIdentifiers = new Set<string>()
  for (const t of ts.tools) {
    validateTool(t, allIdentifiers, errors, warnings)
  }

  return { valid: errors.length === 0, errors, warnings }
}

export function validateAgent(spec: AgentSpec): ValidationResult {
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []

  // system must be present and non-empty (or a dynamic value)
  if (typeof spec.system === 'string') {
    if (!spec.system.trim()) {
      errors.push({
        severity: 'error',
        message: 'agent system prompt must not be empty',
      })
    }
  } else if (typeof spec.system === 'object' && spec.system !== null && '__type' in spec.system) {
    const dyn = spec.system as { __type: string }
    if (dyn.__type === 'secret') {
      warnings.push({
        severity: 'warning',
        message: 'agent system prompt uses secret() -- this value will be sent to an LLM, creating a leakage risk. Use env() instead.',
      })
    }
  } else {
    errors.push({
      severity: 'error',
      message: 'agent system prompt must be a string or a dynamic value (env(), secret())',
    })
  }

  // Build a global identifier registry across all tools and toolsets
  const allIdentifiers = new Set<string>()

  for (const entry of spec.tools) {
    if ('__type' in entry && entry.__type === 'toolset') {
      // Validate toolset name
      if (!KEBAB_RE.test(entry.name)) {
        errors.push({
          severity: 'error',
          message: `toolset name "${entry.name}" must be kebab-case`,
        })
      }
      // Validate each tool in the toolset (using the shared identifier registry
      // so cross-toolset duplicates are caught)
      for (const t of entry.tools) {
        validateTool(t, allIdentifiers, errors, warnings)
      }
    } else {
      validateTool(entry as ConversationTool, allIdentifiers, errors, warnings)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Combined validate function
// ---------------------------------------------------------------------------

export function validate(spec: Spec, plan?: ExecutionPlan): ValidationResult {
  const pass1 = validateStructure(spec)

  if (!pass1.valid || !plan) {
    return pass1
  }

  const pass2 = validateExpandedPlan(plan)

  return {
    valid: pass2.valid,
    errors: [...pass1.errors, ...pass2.errors],
    warnings: [...pass1.warnings, ...pass2.warnings],
  }
}

// ---------------------------------------------------------------------------
// Workflow validator
// ---------------------------------------------------------------------------

// Five-field standard cron expression: min hour dom month dow
// Each field may be a number, *, or simple range/step (good enough for validation;
// the orchestrator performs the authoritative parse via croniter).
const CRON_FIELD_RE = /^(\*|(\d+(-\d+)?(\/\d+)?|\*\/\d+)(,(\d+(-\d+)?(\/\d+)?|\*\/\d+))*)$/

function isValidCronExpr(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every(f => CRON_FIELD_RE.test(f))
}

const KEBAB_SPEC_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

export function validateWorkflow(spec: WorkflowSpec): ValidationResult {
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []

  if (spec.steps.length === 0) {
    errors.push({ severity: 'error', message: 'workflow must have at least one step' })
  }

  const { trigger } = spec
  const validTriggerKinds = new Set(['discussion', 'cron', 'manual', 'spawn'])

  if (!validTriggerKinds.has(trigger.kind)) {
    errors.push({
      severity: 'error',
      message: `unknown trigger kind: "${(trigger as { kind: string }).kind}". Valid kinds: ${[...validTriggerKinds].join(', ')}`,
    })
  } else {
    switch (trigger.kind) {
      case 'discussion':
        if (!trigger.category || typeof trigger.category !== 'string' || !trigger.category.trim()) {
          errors.push({ severity: 'error', message: 'trigger.discussion requires a non-empty category' })
        }
        break
      case 'cron':
        if (!isValidCronExpr(trigger.expr)) {
          errors.push({
            severity: 'error',
            message: `trigger.cron expr "${trigger.expr}" is not a valid 5-field cron expression (min hour dom month dow)`,
          })
        }
        break
      case 'spawn':
        if (typeof trigger.maxDepth !== 'number' || !Number.isInteger(trigger.maxDepth) || trigger.maxDepth < 1) {
          errors.push({ severity: 'error', message: 'trigger.spawn requires maxDepth >= 1' })
        }
        break
      case 'manual':
        break
    }
  }

  for (let i = 0; i < spec.steps.length; i++) {
    const s = spec.steps[i]!
    const loc = `step[${i}]`

    if (s.kind !== 'agent') {
      errors.push({
        severity: 'error',
        message: `${loc}: unknown step kind "${(s as { kind: string }).kind}". Currently only "agent" steps are supported`,
      })
      continue
    }

    if (!KEBAB_SPEC_NAME_RE.test(s.specName)) {
      errors.push({
        severity: 'error',
        message: `${loc}: specName "${s.specName}" must be kebab-case (lowercase letters, digits, hyphens; must start with a letter or digit)`,
      })
    }

    if (i === 0 && s.approveBefore) {
      errors.push({
        severity: 'error',
        message: `${loc}: approveBefore on the first step is not allowed — there is no upstream agent to gate on`,
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
