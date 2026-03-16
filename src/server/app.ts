import express from 'express'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { compile, formatExpandedPlan } from '../compiler.js'
import { validate } from '../validator.js'
import { runSpec } from '../runner.js'
import { loadSpecFile } from '../loader.js'
import type { Spec, SpecResult, ExecutableStep, BrowserStep } from '../types.js'

const __serverDir = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Suite ID encoding (base64url of relative file path)
// ---------------------------------------------------------------------------

export function encodeSuiteId(relativePath: string): string {
  return Buffer.from(relativePath).toString('base64url')
}

export function decodeSuiteId(id: string): string {
  return Buffer.from(id, 'base64url').toString('utf-8')
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerSuite = {
  id: string
  name: string
  path: string
  relativePath: string
  spec: Spec | null
  loadError: string | null
}

type RunStatus = 'pending' | 'running' | 'pass' | 'fail' | 'error'

type RunRecord = {
  id: string
  suiteId: string
  suiteName: string
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  error: string | null
  validation: { errors: string[]; warnings: string[] } | null
  result: SpecResult | null
}

// ---------------------------------------------------------------------------
// Run manager (max 100 runs, FIFO eviction on overflow)
// ---------------------------------------------------------------------------

const MAX_RUNS = 100

export class RunManager {
  private runs: Map<string, RunRecord> = new Map()
  private order: string[] = []

  add(run: RunRecord): void {
    if (this.runs.size >= MAX_RUNS) {
      const oldest = this.order.shift()
      if (oldest !== undefined) this.runs.delete(oldest)
    }
    this.runs.set(run.id, run)
    this.order.push(run.id)
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id)
  }

  list(): RunRecord[] {
    const out: RunRecord[] = []
    for (const id of this.order) {
      const r = this.runs.get(id)
      if (r !== undefined) out.push(r)
    }
    return out
  }

  update(id: string, updates: Partial<RunRecord>): void {
    const run = this.runs.get(id)
    if (run !== undefined) Object.assign(run, updates)
  }

  size(): number {
    return this.runs.size
  }
}

// ---------------------------------------------------------------------------
// Action summary formatters (for the plan endpoint)
// ---------------------------------------------------------------------------

function formatActionSummary(step: ExecutableStep): string {
  const action = step.action
  if (action.__type === 'api') {
    return `${action.method} ${action.path}`
  }
  if (action.__type === 'browser') {
    const b = action as BrowserStep & { action: string; target?: unknown; url?: unknown }
    const target = b.target ?? b.url ?? ''
    return `browser.${b.action}(${JSON.stringify(target)})`
  }
  if (action.__type === 'expect') {
    return `expect ${action.matcher}`
  }
  return 'unknown'
}

function formatExpectSummaries(step: ExecutableStep): string[] {
  const parts: string[] = []
  if (step.inlineExpect?.status !== undefined) {
    parts.push(`status: ${step.inlineExpect.status}`)
  }
  if (step.inlineExpect?.body !== undefined) {
    parts.push(`body: ${JSON.stringify(step.inlineExpect.body)}`)
  }
  for (const e of step.expects) {
    const exp = e.expected !== undefined ? ` ${JSON.stringify(e.expected)}` : ''
    parts.push(`${e.matcher}${exp}`)
  }
  return parts
}

// ---------------------------------------------------------------------------
// Run response mapper
// ---------------------------------------------------------------------------

function mapRunToResponse(run: RunRecord): object {
  const flows = run.result !== null
    ? run.result.flows.map(f => ({
        name: f.name,
        steps: f.steps.map(s => ({
          name: s.name,
          section: s.section ?? null,
          status: s.status as 'pass' | 'fail' | 'skip',
          durationMs: s.durationMs,
          error: s.error ?? null,
        })),
        passed: f.passed,
        failed: f.failed,
        skipped: f.skipped,
      }))
    : null

  return {
    id: run.id,
    suiteId: run.suiteId,
    suiteName: run.suiteName,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    error: run.error,
    validation: run.validation,
    flows,
    totalSteps: run.result !== null ? run.result.totalSteps : null,
    passedSteps: run.result !== null ? run.result.passedSteps : null,
    failedSteps: run.result !== null ? run.result.failedSteps : null,
  }
}

// ---------------------------------------------------------------------------
// Suite step count (flattening sections)
// ---------------------------------------------------------------------------

function countSteps(spec: Spec): number {
  let count = 0
  for (const f of spec.flows) {
    for (const item of f.steps) {
      if ('__type' in item && (item as { __type: string }).__type === 'section') {
        count += (item as { steps: unknown[] }).steps.length
      } else {
        count++
      }
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Express app factory
// ---------------------------------------------------------------------------

export function createApp(
  suites: ServerSuite[],
  runManager: RunManager,
): express.Application {
  const app = express()
  app.use(express.json())

  const suiteMap = new Map<string, ServerSuite>()
  for (const s of suites) suiteMap.set(s.id, s)

  const pagesDir = join(__serverDir, 'pages')
  app.use(express.static(pagesDir))

  // -------------------------------------------------------------------------
  // GET /api/suites -- list all discovered suites
  // -------------------------------------------------------------------------

  app.get('/api/suites', (_req, res) => {
    const result = suites.map(s => ({
      id: s.id,
      name: s.name,
      path: s.relativePath,
      flowCount: s.spec !== null ? s.spec.flows.length : 0,
      tags: s.spec !== null ? (s.spec.tags ?? []) : [],
      hasError: s.loadError !== null,
    }))
    res.json({ suites: result })
  })

  // -------------------------------------------------------------------------
  // GET /api/suites/:id -- metadata for one suite
  // -------------------------------------------------------------------------

  app.get('/api/suites/:id', (req, res) => {
    const suite = suiteMap.get(req.params['id'] ?? '')
    if (suite === undefined) {
      res.status(404).json({ error: 'Suite not found' })
      return
    }
    if (suite.loadError !== null || suite.spec === null) {
      res.status(500).json({ error: suite.loadError ?? 'Failed to load spec' })
      return
    }
    const { spec } = suite
    res.json({
      id: suite.id,
      name: spec.name,
      path: suite.relativePath,
      flowNames: spec.flows.map(f => f.name),
      stepCount: countSteps(spec),
      apiNames: Object.keys(spec.apis ?? {}),
      tags: spec.tags ?? [],
      safety: spec.safety ?? null,
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/suites/:id/plan -- expanded execution plan + validation
  // -------------------------------------------------------------------------

  app.get('/api/suites/:id/plan', (req, res) => {
    const suite = suiteMap.get(req.params['id'] ?? '')
    if (suite === undefined) {
      res.status(404).json({ error: 'Suite not found' })
      return
    }
    if (suite.loadError !== null || suite.spec === null) {
      res.status(500).json({ error: suite.loadError ?? 'Failed to load spec' })
      return
    }

    let plan: ReturnType<typeof compile>
    try {
      plan = compile(suite.spec)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
      return
    }

    const validation = validate(suite.spec, plan)

    const rawBaseUrl = plan.baseUrl
    const baseUrlStr = typeof rawBaseUrl === 'string'
      ? (rawBaseUrl || null)
      : `${(rawBaseUrl as { __type: string; name?: string }).__type}("${(rawBaseUrl as { name?: string }).name ?? ''}")`

    const steps = plan.steps.map(s => ({
      name: s.name,
      section: s.section ?? null,
      flowOrigin: s.flowOrigin ?? null,
      actionType: s.action.__type as 'api' | 'browser' | 'expect',
      actionSummary: formatActionSummary(s),
      retries: s.retries,
      saves: Object.keys(s.saves),
      expects: formatExpectSummaries(s),
    }))

    res.json({
      specName: plan.specName,
      baseUrl: baseUrlStr,
      steps,
      validation: {
        errors: validation.errors.map(e => e.message),
        warnings: validation.warnings.map(w => w.message),
      },
      renderedPlan: formatExpandedPlan(plan),
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/suites/:id/run -- start an async run
  // -------------------------------------------------------------------------

  app.post('/api/suites/:id/run', (req, res) => {
    const suite = suiteMap.get(req.params['id'] ?? '')
    if (suite === undefined) {
      res.status(404).json({ error: 'Suite not found' })
      return
    }

    // Validate body shape
    const body = req.body as Record<string, unknown> | undefined | null
    if (body !== undefined && body !== null && typeof body !== 'object') {
      res.status(400).json({ error: 'Request body must be a JSON object' })
      return
    }

    const headed = typeof body?.['headed'] === 'boolean' ? body['headed'] : undefined
    const reqBaseUrl = typeof body?.['baseUrl'] === 'string' ? body['baseUrl'] : undefined
    const timeoutMs = typeof body?.['timeoutMs'] === 'number' ? body['timeoutMs'] : undefined

    // If the suite failed to load, create an immediate error run
    if (suite.loadError !== null || suite.spec === null) {
      const run: RunRecord = {
        id: randomUUID(),
        suiteId: suite.id,
        suiteName: suite.name,
        status: 'error',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        error: suite.loadError ?? 'Failed to load spec',
        validation: null,
        result: null,
      }
      runManager.add(run)
      res.status(201).json({ runId: run.id })
      return
    }

    const run: RunRecord = {
      id: randomUUID(),
      suiteId: suite.id,
      suiteName: suite.spec.name,
      status: 'pending',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      error: null,
      validation: null,
      result: null,
    }
    runManager.add(run)

    // Only override baseUrl when explicitly requested in the POST body.
    // Specs resolve their own base URLs from env() at runtime.
    const runOptions: { headed?: boolean; baseUrl?: string; timeoutMs?: number } = {}
    if (headed !== undefined) runOptions.headed = headed
    if (reqBaseUrl !== undefined) runOptions.baseUrl = reqBaseUrl
    if (timeoutMs !== undefined) runOptions.timeoutMs = timeoutMs
    void executeRun(run, suite.spec, runManager, runOptions)

    res.status(201).json({ runId: run.id })
  })

  // -------------------------------------------------------------------------
  // GET /api/runs -- list all runs (summaries)
  // -------------------------------------------------------------------------

  app.get('/api/runs', (_req, res) => {
    const runs = runManager.list().map(r => ({
      id: r.id,
      suiteId: r.suiteId,
      suiteName: r.suiteName,
      status: r.status,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
    }))
    res.json({ runs })
  })

  // -------------------------------------------------------------------------
  // GET /api/runs/:id -- full run detail
  // -------------------------------------------------------------------------

  app.get('/api/runs/:id', (req, res) => {
    const run = runManager.get(req.params['id'] ?? '')
    if (run === undefined) {
      res.status(404).json({ error: 'Run not found' })
      return
    }
    res.json(mapRunToResponse(run))
  })

  // SPA fallback -- must be declared last
  app.get('*', (_req, res) => {
    res.sendFile(join(pagesDir, 'index.html'))
  })

  return app
}

// ---------------------------------------------------------------------------
// Background run execution (validate first, then run)
// ---------------------------------------------------------------------------

async function executeRun(
  run: RunRecord,
  spec: Spec,
  manager: RunManager,
  options: { headed?: boolean; baseUrl?: string; timeoutMs?: number },
): Promise<void> {
  const startTime = Date.now()
  manager.update(run.id, { status: 'running' })

  // Always validate before running
  let compiledOk = false
  try {
    const plan = compile(spec)
    const validation = validate(spec, plan)

    manager.update(run.id, {
      validation: {
        errors: validation.errors.map(e => e.message),
        warnings: validation.warnings.map(w => w.message),
      },
    })

    if (!validation.valid) {
      manager.update(run.id, {
        status: 'error',
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        error: `Validation failed: ${validation.errors.map(e => e.message).join('; ')}`,
      })
      return
    }

    compiledOk = true
  } catch (err) {
    manager.update(run.id, {
      status: 'error',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (!compiledOk) return

  // Execute the spec
  try {
    const runOpts: Parameters<typeof runSpec>[1] = { skipValidation: true }
    if (options.headed !== undefined) runOpts.headed = options.headed
    if (options.baseUrl !== undefined) runOpts.baseUrl = options.baseUrl
    if (options.timeoutMs !== undefined) runOpts.timeoutMs = options.timeoutMs

    const result = await runSpec(spec, runOpts)
    manager.update(run.id, {
      status: result.status === 'pass' ? 'pass' : 'fail',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      result,
    })
  } catch (err) {
    manager.update(run.id, {
      status: 'error',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Suite discovery -- load all specs matching a glob at startup
// ---------------------------------------------------------------------------

export async function discoverSuites(
  globPattern: string,
  cwd: string,
): Promise<ServerSuite[]> {
  const { resolveGlob } = await import('../loader.js')
  const { relative, resolve } = await import('node:path')

  const files = await resolveGlob(globPattern)
  const suites: ServerSuite[] = []

  for (const file of files) {
    const absPath = resolve(file)
    const rel = relative(cwd, absPath)
    const id = encodeSuiteId(rel)

    const loaded = await loadSpecFile(absPath)
    suites.push({
      id,
      name: loaded.spec !== null ? loaded.spec.name : rel,
      path: absPath,
      relativePath: rel,
      spec: loaded.spec,
      loadError: loaded.error,
    })
  }

  return suites
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

export async function startServer(
  suites: ServerSuite[],
  port = 4000,
): Promise<ReturnType<typeof createServer>> {
  const runManager = new RunManager()
  const app = createApp(suites, runManager)

  return new Promise((resolve) => {
    const server = createServer(app)
    server.listen(port, () => {
      console.log(`Ortheon server running at http://localhost:${port}`)
      console.log(`Serving ${suites.length} spec(s)`)
      suites
        .filter(s => s.loadError !== null)
        .forEach(s => console.warn(`  warning: failed to load "${s.relativePath}": ${s.loadError ?? ''}`))
      resolve(server)
    })
  })
}

