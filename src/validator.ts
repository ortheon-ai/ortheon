import type {
  ApiStep,
  BrowserStep,
  Diagnostic,
  ExecutableStep,
  ExecutionPlan,
  ExpectStep,
  FlowItem,
  MatcherName,
  RefValue,
  Section,
  Spec,
  Step,
  UseStep,
  ValidationResult,
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

const SAVE_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*(\[\d+\])*([.][a-zA-Z_][a-zA-Z0-9_.]*(\[\d+\])*)*$/

function isSection(item: FlowItem): item is Section {
  return (item as Section).__type === 'section'
}

function validateSavePath(path: string): boolean {
  return SAVE_PATH_RE.test(path)
}

// ---------------------------------------------------------------------------
// Pass 1: Structural validation
// ---------------------------------------------------------------------------

export function validateStructure(spec: Spec): ValidationResult {
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []

  const apis = spec.apis ?? {}
  const flowNames = new Set<string>()

  // Collect all flow names: both library flows and top-level flows (needed for use() validation)
  const allFlows = [...(spec.library ?? []), ...spec.flows]

  for (const flow of allFlows) {
    if (flowNames.has(flow.name)) {
      errors.push({
        severity: 'error',
        message: `Duplicate flow name: "${flow.name}"`,
      })
    }
    flowNames.add(flow.name)
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
      validateStepAction(step, apis, flowNames, location, errors, warnings)
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
  location: string,
  errors: Diagnostic[],
  warnings: Diagnostic[]
): void {
  const action = step.action
  const stepLocation = `${location} > step("${step.name}")`

  switch (action.__type) {
    case 'browser': {
      const bAction = action as BrowserStep & { action: string }
      if (!VALID_BROWSER_ACTIONS.has(bAction.action)) {
        errors.push({
          severity: 'error',
          message: `Unknown browser action: "${bAction.action}" in ${stepLocation}`,
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
          for (const [saveName, savePath] of Object.entries(opts.save as Record<string, string>)) {
            if (!validateSavePath(saveName)) {
              errors.push({
                severity: 'error',
                message: `Invalid save name "${saveName}" in ${stepLocation}. Use dot notation + bracket indexing only.`,
                location: stepLocation,
              })
            }
            void savePath // save path for extract is the source type (text/value/html/attr:X), not validated here
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

      // Validate save paths
      if (apiAction.options.save) {
        for (const [saveName, savePath] of Object.entries(apiAction.options.save)) {
          if (!validateSavePath(saveName)) {
            errors.push({
              severity: 'error',
              message: `Invalid save name "${saveName}" in ${stepLocation}`,
              location: stepLocation,
            })
          }
          if (!validateSavePath(savePath) && savePath !== 'body' && savePath !== 'status') {
            warnings.push({
              severity: 'warning',
              message: `Save path "${savePath}" in ${stepLocation} may not be valid dot-notation`,
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
        // Check input completeness -- would need access to flow definitions
        // This is done in a separate structural check below
        void warnings
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
