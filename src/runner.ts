import type {
  AgentMessage,
  AgentPlan,
  AgentStepResult,
  ExecutableStep,
  ExecutionPlan,
  ResolvedApiStep,
  SerializedTool,
  Spec,
  SpecResult,
  StepResult,
  ToolCallResult,
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

// Options for runPlan() -- no baseUrl (resolved from plan's env() marker) or skipValidation.
export type RunPlanOptions = {
  headed?: boolean
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

export async function runSpec(spec: Spec, options: RunOptions = {}): Promise<SpecResult> {
  const plan = compile(spec)

  if (!options.skipValidation) {
    const result = validate(spec, plan)
    if (!result.valid) {
      const messages = result.errors.map(e => `  - ${e.message}`).join('\n')
      throw new Error(`Spec "${spec.name}" failed validation:\n${messages}`)
    }
  }

  // CLI override > spec config > env. The override applies to the 'default' URL only.
  const resolvedUrls = resolveUrls(plan)
  if (options.baseUrl) {
    resolvedUrls['default'] = options.baseUrl
  }

  // Fail fast if the default URL is still empty and any step will need it.
  assertDefaultUrlIfNeeded(plan, resolvedUrls)

  return executeCompiledPlan(plan, resolvedUrls, options)
}

// Run a pre-compiled ExecutionPlan fetched from a server or produced externally.
// Skips compilation and validation — the server is assumed to have done both.
// env() and secret() markers in the plan are resolved from the caller's process.env.
export async function runPlan(plan: ExecutionPlan, options: RunPlanOptions = {}): Promise<SpecResult> {
  const resolvedUrls = resolveUrls(plan)
  assertDefaultUrlIfNeeded(plan, resolvedUrls)
  return executeCompiledPlan(plan, resolvedUrls, options)
}

// ---------------------------------------------------------------------------
// Shared execution core
// ---------------------------------------------------------------------------

async function executeCompiledPlan(
  plan: ExecutionPlan,
  resolvedUrls: Record<string, string>,
  options: { headed?: boolean; timeoutMs?: number },
): Promise<SpecResult> {
  const startTime = Date.now()

  const ctx = new RuntimeContext()
  if (plan.data && Object.keys(plan.data).length > 0) {
    ctx.loadData(plan.data)
  }

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

      const result = await runStep(step, ctx, resolvedUrls, browserSession, options)
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
    specName: plan.specName,
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
  resolvedUrls: Record<string, string>,
  browserSession: BrowserSession | null,
  options: RunOptions
): Promise<StepResult> {
  const maxAttempts = (step.retries ?? 0) + 1
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startTime = Date.now()
    try {
      await executeStep(step, ctx, resolvedUrls, browserSession, options)
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
  resolvedUrls: Record<string, string>,
  browserSession: BrowserSession | null,
  options: RunOptions
): Promise<void> {
  const action = step.action

  if (action.__type === 'api') {
    const apiAction = action as ResolvedApiStep
    const targetBase = apiAction.base ?? 'default'
    const stepBaseUrl = resolvedUrls[targetBase]
    if (stepBaseUrl === undefined) {
      throw new Error(
        `Step "${step.name}" references base "${targetBase}" which is not defined in the spec's urls map.\n` +
        `Available bases: ${Object.keys(resolvedUrls).join(', ')}`
      )
    }
    if (!stepBaseUrl) {
      if (targetBase === 'default') {
        throw new Error(
          'No baseUrl configured for this spec.\n' +
          'Set the appropriate environment variable for the env() key declared in the spec.'
        )
      }
      throw new Error(
        `Step "${step.name}" targets base "${targetBase}" but the URL is empty.\n` +
        'Set the appropriate environment variable for the env() key declared in the spec.'
      )
    }
    const response = await executeApiCall(
      {
        method: apiAction.method,
        path: apiAction.path,
        ...(apiAction.options.params !== undefined ? { params: apiAction.options.params as Record<string, string> } : {}),
        ...(apiAction.options.query !== undefined ? { query: apiAction.options.query as Record<string, string> } : {}),
        ...(apiAction.options.headers !== undefined ? { headers: apiAction.options.headers as Record<string, string> } : {}),
        ...(apiAction.options.body !== undefined ? { body: apiAction.options.body } : {}),
      },
      stepBaseUrl,
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
    // Only goto uses a base URL; all other browser actions operate on the already-loaded page.
    let browserBaseUrl = ''
    if (action.action === 'goto') {
      const browserBase = (action as { base?: string }).base ?? 'default'
      if (!(browserBase in resolvedUrls)) {
        throw new Error(
          `Step "${step.name}" references base "${browserBase}" which is not defined in the spec's urls map.\n` +
          `Available bases: ${Object.keys(resolvedUrls).join(', ')}`
        )
      }
      browserBaseUrl = resolvedUrls[browserBase]!
      if (!browserBaseUrl) {
        if (browserBase === 'default') {
          throw new Error(
            'No baseUrl configured for this spec.\n' +
            'Set the appropriate environment variable for the env() key declared in the spec.'
          )
        }
        throw new Error(
          `Step "${step.name}" targets base "${browserBase}" but the URL is empty.\n` +
          'Set the appropriate environment variable for the env() key declared in the spec.'
        )
      }
    }
    await executeBrowserStep(action, browserSession, ctx, browserBaseUrl)

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

function resolveUrlEntry(key: string, value: import('./types.js').Resolvable<string>, specName: string): string {
  if (typeof value === 'string' && value) return value

  if (typeof value === 'object' && value !== null && '__type' in value) {
    const dynamic = value as { __type: string; name?: string }
    if (dynamic.__type === 'env' && dynamic.name) {
      const val = process.env[dynamic.name]
      if (val !== undefined && val !== '') return val
      const label = key === 'default' ? 'baseUrl' : `urls["${key}"]`
      const reason = val === '' ? 'is set but empty' : 'is not set'
      throw new Error(
        `No URL configured for "${specName}" (${label}): ` +
        `env variable "${dynamic.name}" ${reason}.\n` +
        `Set ${dynamic.name} in your environment and try again.`
      )
    }
  }

  const label = key === 'default' ? 'baseUrl' : `urls["${key}"]`
  throw new Error(
    `No URL configured for "${specName}" (${label}).\n` +
    'Set the appropriate environment variable for the env() key declared in the spec.'
  )
}

function resolveUrls(plan: ExecutionPlan): Record<string, string> {
  const result: Record<string, string> = {}
  // plan.urls may be absent on plans constructed before this feature was added.
  const urlMap = plan.urls ?? { default: plan.baseUrl }
  for (const [key, value] of Object.entries(urlMap)) {
    // For a literal empty string (spec declared no baseUrl), defer the error to
    // step execution -- specs that exclusively use named bases are still valid.
    if (typeof value === 'string' && !value) {
      result[key] = ''
      continue
    }
    result[key] = resolveUrlEntry(key, value, plan.specName)
  }
  if (!('default' in result)) {
    result['default'] = ''
  }
  return result
}

/** Throw eagerly for URL problems that would otherwise surface mid-execution:
 *  1. The default URL is empty and at least one step needs it.
 *  2. A step references a named base that does not exist in the resolved map.
 *  Both are checked before the browser is launched so CI (no Playwright) fails cleanly.
 *  Steps that never use a URL (expect steps, non-goto browser actions) are skipped. */
function assertDefaultUrlIfNeeded(plan: ExecutionPlan, resolvedUrls: Record<string, string>): void {
  for (const s of plan.steps) {
    // Determine the base only for steps that actually make a network/navigation call.
    // expect steps and non-goto browser actions (click, type, …) don't use a URL at all.
    let targetBase: string | undefined

    if (s.action.__type === 'api') {
      targetBase = (s.action as ResolvedApiStep).base ?? 'default'
    } else if (s.action.__type === 'browser') {
      const bAction = s.action as { action: string; base?: string }
      if (bAction.action === 'goto') targetBase = bAction.base ?? 'default'
    }

    if (targetBase === undefined) continue

    if (!(targetBase in resolvedUrls)) {
      throw new Error(
        `Step "${s.name}" references base "${targetBase}" which is not defined in the spec's urls map.\n` +
        `Available bases: ${Object.keys(resolvedUrls).join(', ')}`
      )
    }

    if (!resolvedUrls[targetBase]) {
      if (targetBase === 'default') {
        throw new Error(
          `No baseUrl configured for "${plan.specName}".\n` +
          'Set the appropriate environment variable for the env() key declared in the spec.'
        )
      }
      throw new Error(
        `Step "${s.name}" targets base "${targetBase}" but the URL is empty.\n` +
        'Set the appropriate environment variable for the env() key declared in the spec.'
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Agent step runner
//
// Deterministic /command dispatch. Parses command lines from the message text,
// resolves aliases, filters by source, validates args, and returns ordered
// candidates. The caller owns the execution loop, LLM calls, and history.
//
// Parsing rules:
//   1. Strip ignored regions: code fences (```...```) and blockquote lines (> ...)
//   2. Scan lines with: ^\s*\/([a-z0-9][a-z0-9-]*)(?:\s+(.*))?\s*$
//   3. Parse args with: ([a-z0-9][a-z0-9-]*)="([^"]*)"
//   4. Reject lines with non-whitespace remaining after removing all arg pairs
//   5. Resolve alias -> canonical tool name; skip unknown names
//   6. Filter by source; skip if tool.source !== message.source and !== 'any'
//   7. Validate args against schema; produce validation result in candidate
//   8. Order candidates by appearance in the message
// ---------------------------------------------------------------------------

const COMMAND_LINE_RE = /^\s*\/([a-z0-9][a-z0-9-]*)(?:\s+(.*?))?\s*$/
const ARG_PAIR_RE = /([a-z0-9][a-z0-9-]*)="([^"]*)"/g

function stripIgnoredRegions(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inFence = false

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^\s*>/.test(line)) continue
    result.push(line)
  }

  return result.join('\n')
}

function parseArgs(argsStr: string): { args: Record<string, string>; malformed: boolean } {
  const args: Record<string, string> = {}
  let remaining = argsStr

  // Extract all key="value" pairs
  const re = new RegExp(ARG_PAIR_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(argsStr)) !== null) {
    args[m[1]!] = m[2]!
    remaining = remaining.replace(m[0], '')
  }

  // If anything non-whitespace remains, the line is malformed
  const malformed = /\S/.test(remaining)
  return { args, malformed }
}

function validateArgs(
  tool: SerializedTool,
  rawArgs: Record<string, string>
): { coerced: Record<string, unknown>; errors: string[] } {
  const coerced: Record<string, unknown> = {}
  const errors: string[] = []

  if (!tool.args) {
    // No schema -- pass raw string values through as-is
    for (const [k, v] of Object.entries(rawArgs)) {
      coerced[k] = v
    }
    return { coerced, errors }
  }

  // Coerce known fields and check required
  for (const [fieldName, field] of Object.entries(tool.args)) {
    const raw = rawArgs[fieldName]
    if (raw === undefined) {
      if (field.required) {
        errors.push(`missing required arg "${fieldName}"`)
      }
      continue
    }
    if (field.type === 'number') {
      const trimmed = raw.trim()
      const n = trimmed === '' ? NaN : Number(trimmed)
      if (isNaN(n)) {
        errors.push(`arg "${fieldName}" expected number, got "${raw}"`)
        coerced[fieldName] = raw
      } else {
        coerced[fieldName] = n
      }
    } else if (field.type === 'boolean') {
      if (raw === 'true') {
        coerced[fieldName] = true
      } else if (raw === 'false') {
        coerced[fieldName] = false
      } else {
        errors.push(`arg "${fieldName}" expected boolean (true/false), got "${raw}"`)
        coerced[fieldName] = raw
      }
    } else {
      coerced[fieldName] = raw
    }
  }

  // Pass unknown args through as raw strings (no strict mode in v1)
  for (const [k, v] of Object.entries(rawArgs)) {
    if (!Object.hasOwn(coerced, k)) {
      coerced[k] = v
    }
  }

  return { coerced, errors }
}

export function runAgentStep(plan: AgentPlan, message: AgentMessage): AgentStepResult {
  // Build lookup maps
  const nameToTool = new Map<string, SerializedTool>()
  const aliasToName = new Map<string, string>()
  for (const t of plan.tools) {
    nameToTool.set(t.name, t)
    for (const alias of t.aliases ?? []) {
      aliasToName.set(alias, t.name)
    }
  }

  const candidates: ToolCallResult[] = []
  const stripped = stripIgnoredRegions(message.text)

  for (const line of stripped.split('\n')) {
    const lineMatch = COMMAND_LINE_RE.exec(line)
    if (lineMatch === null) continue

    const rawName = lineMatch[1]!
    const argsStr = lineMatch[2] ?? ''

    // Parse args; drop malformed lines
    const { args: rawArgs, malformed } = parseArgs(argsStr)
    if (malformed) continue

    // Resolve alias -> canonical name
    const canonicalName = aliasToName.has(rawName) ? aliasToName.get(rawName)! : rawName
    const tool = nameToTool.get(canonicalName)
    if (tool === undefined) continue

    // Source filter
    if (tool.source !== 'any' && tool.source !== message.source) continue

    // Validate and coerce args
    const { coerced, errors } = validateArgs(tool, rawArgs)
    const validation: ToolCallResult['validation'] = errors.length > 0
      ? { valid: false, errors }
      : { valid: true }

    const candidate: ToolCallResult = {
      name: canonicalName,
      args: coerced,
      raw: line.trim(),
      ...(tool.prompt !== undefined ? { prompt: tool.prompt } : {}),
      validation,
    }

    candidates.push(candidate)
  }

  return { candidates }
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
