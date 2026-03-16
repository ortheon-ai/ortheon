import type {
  ExecutableStep,
  ExecutionPlan,
  ResolvedApiStep,
  Spec,
  SpecResult,
  StepResult,
} from './types.js'
import { RuntimeContext } from './context.js'
import { executeApiCall } from './executors/api.js'
import { executeBrowserStep, launchBrowser, closeBrowser, type BrowserSession } from './executors/browser.js'
import { runMatcher, matchInlineBody } from './executors/assert.js'
import { compile } from './compiler.js'
import { validate } from './validator.js'

// ---------------------------------------------------------------------------
// Runner options
// ---------------------------------------------------------------------------

export type RunOptions = {
  baseUrl?: string
  headed?: boolean
  timeoutMs?: number
  skipValidation?: boolean
}

// ---------------------------------------------------------------------------
// Main entry point: run a spec
// ---------------------------------------------------------------------------

export async function runSpec(spec: Spec, options: RunOptions = {}): Promise<SpecResult> {
  const startTime = Date.now()

  // Compile the spec into an execution plan
  const plan = compile(spec)

  // Optionally validate before running
  if (!options.skipValidation) {
    const result = validate(spec, plan)
    if (!result.valid) {
      const messages = result.errors.map(e => `  - ${e.message}`).join('\n')
      throw new Error(`Spec "${spec.name}" failed validation:\n${messages}`)
    }
  }

  // Determine base URL: CLI override > spec config > env
  const baseUrl = options.baseUrl ?? resolveBaseUrl(plan, spec)

  // Initialize runtime context
  const ctx = new RuntimeContext()
  if (spec.data) {
    ctx.loadData(spec.data)
  }

  // Launch browser session (lazily: only if any step needs it)
  let browserSession: BrowserSession | null = null
  const needsBrowser = plan.steps.some(s => s.action.__type === 'browser')

  if (needsBrowser) {
    browserSession = await launchBrowser({
      ...(options.headed !== undefined ? { headed: options.headed } : {}),
    })
  }

  const stepResults: StepResult[] = []
  let failed = false

  try {
    for (const step of plan.steps) {
      if (failed) {
        stepResults.push({
          name: step.name,
          ...(step.section !== undefined ? { section: step.section } : {}),
          ...(step.flowOrigin !== undefined ? { flowOrigin: step.flowOrigin } : {}),
          status: 'skip',
          durationMs: 0,
        })
        continue
      }

      const result = await runStep(step, ctx, baseUrl, browserSession, options)
      stepResults.push(result)

      if (result.status === 'fail') {
        failed = true
      }
    }
  } finally {
    if (browserSession) {
      await closeBrowser(browserSession)
    }
  }

  // Regroup step results back into authored flows using the plan's flow ranges.
  // Zero-step flows produce an empty FlowResult (passed/failed/skipped all 0).
  const flowResults = plan.flowRanges.map(range => {
    const steps = stepResults.slice(range.startIndex, range.startIndex + range.stepCount)
    return {
      name: range.name,
      steps,
      passed: steps.filter(s => s.status === 'pass').length,
      failed: steps.filter(s => s.status === 'fail').length,
      skipped: steps.filter(s => s.status === 'skip').length,
    }
  })

  const passed = stepResults.filter(s => s.status === 'pass').length
  const failedCount = stepResults.filter(s => s.status === 'fail').length

  return {
    specName: spec.name,
    status: failed ? 'fail' : 'pass',
    flows: flowResults,
    totalSteps: plan.steps.length,
    passedSteps: passed,
    failedSteps: failedCount,
    durationMs: Date.now() - startTime,
  }
}

// ---------------------------------------------------------------------------
// Run a single step with retry logic
// ---------------------------------------------------------------------------

async function runStep(
  step: ExecutableStep,
  ctx: RuntimeContext,
  baseUrl: string,
  browserSession: BrowserSession | null,
  options: RunOptions
): Promise<StepResult> {
  const maxAttempts = (step.retries ?? 0) + 1
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startTime = Date.now()
    try {
      await executeStep(step, ctx, baseUrl, browserSession, options)
      return {
        name: step.name,
        ...(step.section !== undefined ? { section: step.section } : {}),
        ...(step.flowOrigin !== undefined ? { flowOrigin: step.flowOrigin } : {}),
        status: 'pass',
        durationMs: Date.now() - startTime,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxAttempts) {
        // Fixed interval when retryIntervalMs is set (useful for polling).
        // Default is linear backoff (500ms × attempt) for error retries.
        // Callers that want fixed-interval polling should always set retryIntervalMs explicitly.
        await sleep(step.retryIntervalMs ?? (500 * attempt))
      }
    }
  }

  const rawMessage = lastError?.message ?? 'Unknown error'
  const flowContext = step.flowOrigin ? ` (flow: ${step.flowOrigin})` : ''
  const enrichedMessage = `Step "${step.name}"${flowContext} failed: ${rawMessage}`
  const safeMessage = ctx.redact(enrichedMessage)

  return {
    name: step.name,
    ...(step.section !== undefined ? { section: step.section } : {}),
    ...(step.flowOrigin !== undefined ? { flowOrigin: step.flowOrigin } : {}),
    status: 'fail',
    durationMs: 0,
    error: safeMessage,
  }
}

// ---------------------------------------------------------------------------
// Execute a single step (one attempt)
// ---------------------------------------------------------------------------

async function executeStep(
  step: ExecutableStep,
  ctx: RuntimeContext,
  baseUrl: string,
  browserSession: BrowserSession | null,
  options: RunOptions
): Promise<void> {
  const action = step.action

  if (action.__type === 'api') {
    const apiAction = action as ResolvedApiStep
    const response = await executeApiCall(
      {
        method: apiAction.method,
        path: apiAction.path,
        ...(apiAction.options.params !== undefined ? { params: apiAction.options.params as Record<string, string> } : {}),
        ...(apiAction.options.query !== undefined ? { query: apiAction.options.query as Record<string, string> } : {}),
        ...(apiAction.options.headers !== undefined ? { headers: apiAction.options.headers as Record<string, string> } : {}),
        ...(apiAction.options.body !== undefined ? { body: apiAction.options.body } : {}),
      },
      baseUrl,
      ctx,
      options.timeoutMs
    )

    // Process inline expectations
    if (step.inlineExpect) {
      if (step.inlineExpect.status !== undefined) {
        if (response.status !== step.inlineExpect.status) {
          throw new Error(
            `Expected status ${step.inlineExpect.status}, got ${response.status}.\n` +
            `Response body: ${JSON.stringify(response.body, null, 2)}`
          )
        }
      }
      if (step.inlineExpect.body) {
        // Resolve any dynamic values in the expected body
        const resolvedExpectedBody = ctx.resolveDeep(step.inlineExpect.body) as Record<string, unknown>
        matchInlineBody(response.body, resolvedExpectedBody)
      }
    }

    // Process saves
    for (const [saveName, savePath] of Object.entries(step.saves)) {
      const value = ctx.extractFromResponse(savePath, response)
      ctx.set(saveName, value)
    }

    return
  }

  if (action.__type === 'browser') {
    if (!browserSession) {
      throw new Error('Browser step encountered but no browser session is active')
    }
    await executeBrowserStep(action, browserSession, ctx, baseUrl)

    // Browser extract steps save their values inside executeBrowserStep
    // No additional save processing needed here
    return
  }

  if (action.__type === 'expect') {
    for (const expectation of step.expects) {
      // exists/notExists matchers check for value presence or absence, so refs must
      // resolve gracefully (ctx.get, not ctx.require) -- a missing path IS the expected
      // state for notExists and should not throw before the matcher runs.
      const actual = isExistenceMatcher(expectation.matcher)
        ? resolveRefSoft(expectation.value, ctx)
        : ctx.resolveDeep(expectation.value)
      const expected = expectation.expected !== undefined
        ? ctx.resolveDeep(expectation.expected)
        : undefined
      runMatcher(expectation.matcher, actual, expected)
    }
    return
  }

  throw new Error(`Unknown action type: ${(action as { __type: string }).__type}`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBaseUrl(plan: ExecutionPlan, spec: Spec): string {
  const baseUrl = plan.baseUrl

  if (typeof baseUrl === 'string' && baseUrl) return baseUrl

  if (typeof baseUrl === 'object' && baseUrl !== null && '__type' in baseUrl) {
    const dynamic = baseUrl as { __type: string; name?: string }
    if (dynamic.__type === 'env' && dynamic.name) {
      const val = process.env[dynamic.name]
      if (val) return val
    }
  }

  throw new Error(
    `No baseUrl configured for spec "${spec.name}".\n` +
    'Set APP_BASE_URL environment variable or pass --base-url to the CLI.'
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isExistenceMatcher(matcher: string): boolean {
  return matcher === 'exists' || matcher === 'notExists'
}

/** Resolve a value, but for ref() use ctx.get() instead of ctx.require() so that a
 *  missing nested path returns undefined rather than throwing. Used for exists/notExists. */
function resolveRefSoft(value: unknown, ctx: RuntimeContext): unknown {
  if (
    typeof value === 'object' && value !== null &&
    (value as { __type?: string }).__type === 'ref'
  ) {
    return ctx.get((value as { path: string }).path)
  }
  return ctx.resolveDeep(value)
}
