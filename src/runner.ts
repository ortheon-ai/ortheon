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
    browserSession = await launchBrowser({ headed: options.headed })
  }

  const stepResults: StepResult[] = []
  let failed = false

  try {
    for (const step of plan.steps) {
      if (failed) {
        stepResults.push({
          name: step.name,
          section: step.section,
          flowOrigin: step.flowOrigin,
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

  const passed = stepResults.filter(s => s.status === 'pass').length
  const failedCount = stepResults.filter(s => s.status === 'fail').length
  const skipped = stepResults.filter(s => s.status === 'skip').length

  return {
    specName: spec.name,
    status: failed ? 'fail' : 'pass',
    flows: [
      {
        name: spec.name,
        steps: stepResults,
        passed,
        failed: failedCount,
        skipped,
      },
    ],
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
        section: step.section,
        flowOrigin: step.flowOrigin,
        status: 'pass',
        durationMs: Date.now() - startTime,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxAttempts) {
        // Small delay between retries
        await sleep(500 * attempt)
      }
    }
  }

  return {
    name: step.name,
    section: step.section,
    flowOrigin: step.flowOrigin,
    status: 'fail',
    durationMs: 0,
    error: lastError?.message ?? 'Unknown error',
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
  _options: RunOptions
): Promise<void> {
  const action = step.action

  if (action.__type === 'api') {
    const apiAction = action as ResolvedApiStep
    const response = await executeApiCall(
      {
        method: apiAction.method,
        path: apiAction.path,
        params: apiAction.options.params as Record<string, string> | undefined,
        query: apiAction.options.query as Record<string, string> | undefined,
        headers: apiAction.options.headers as Record<string, string> | undefined,
        body: apiAction.options.body,
      },
      baseUrl,
      ctx
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
      const actual = ctx.resolveDeep(expectation.value)
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
