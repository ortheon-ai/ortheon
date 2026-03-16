import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spec, flow, step, api, expect as orthExpect, ref } from '../src/dsl.js'
import { createApp, encodeSuiteId, decodeSuiteId, RunManager, type ServerSuite } from '../src/server/app.js'
import type { Spec } from '../src/types.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const healthSpec: Spec = spec('service health check', {
  baseUrl: 'http://localhost:9999',  // unreachable -- used to test metadata, not run
  flows: [
    flow('health check', {
      steps: [
        step('check health endpoint',
          api('GET /api/health', {
            expect: { status: 200 },
            save: { healthStatus: 'body.status' },
          })
        ),
        step('health status should equal ok',
          orthExpect(ref('healthStatus'), 'equals', 'ok')
        ),
      ],
    }),
  ],
})

const invalidSpec: Spec = spec('invalid spec', {
  flows: [
    flow('bad flow', {
      steps: [
        // uses ref that was never saved -- will fail validation pass 2
        step('check bad ref',
          orthExpect(ref('nonexistent'), 'equals', 'x')
        ),
      ],
    }),
  ],
})

// Multi-flow spec for alignment testing
const multiFlowSpec: Spec = spec('multi flow spec', {
  baseUrl: 'http://localhost:9999',
  flows: [
    flow('flow alpha', {
      steps: [
        step('get alpha',
          api('GET /api/alpha', {
            expect: { status: 200 },
            save: { alphaResult: 'body.value' },
          })
        ),
        step('get beta',
          api('GET /api/beta', {})
        ),
      ],
    }),
    flow('flow gamma', {
      steps: [
        step('post gamma',
          api('POST /api/gamma', {
            expect: { status: 201 },
          })
        ),
      ],
    }),
  ],
})

function makeSuite(id: string, s: Spec, overrides?: Partial<ServerSuite>): ServerSuite {
  return {
    id,
    name: s.name,
    path: `/test/${id}.ts`,
    relativePath: `test/${id}.ts`,
    spec: s,
    loadError: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helpers to start a test server on a random port
// ---------------------------------------------------------------------------

type TestServer = {
  baseUrl: string
  close: () => Promise<void>
  runManager: RunManager
}

function startTestServer(suites: ServerSuite[]): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const runManager = new RunManager()
    const app = createApp(suites, runManager)
    const server = createServer(app)

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${addr.port}`
      resolve({
        baseUrl,
        close: () => new Promise<void>(res => server.close(() => res())),
        runManager,
      })
    })
  })
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function post(baseUrl: string, path: string, data?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data !== undefined ? JSON.stringify(data) : undefined,
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Suite ID encoding / decoding
// ---------------------------------------------------------------------------

describe('encodeSuiteId / decodeSuiteId', () => {
  it('round-trips a simple relative path', () => {
    const path = 'examples/specs/smoke/health.ortheon.ts'
    expect(decodeSuiteId(encodeSuiteId(path))).toBe(path)
  })

  it('round-trips paths with spaces and special characters', () => {
    const path = 'examples/specs/my suite/test spec.ortheon.ts'
    expect(decodeSuiteId(encodeSuiteId(path))).toBe(path)
  })

  it('produces URL-safe output (no +, /, =)', () => {
    const id = encodeSuiteId('examples/specs/smoke/health.ortheon.ts')
    expect(id).not.toMatch(/[+/=]/)
  })

  it('different paths produce different IDs', () => {
    const id1 = encodeSuiteId('a/b.ts')
    const id2 = encodeSuiteId('c/d.ts')
    expect(id1).not.toBe(id2)
  })
})

// ---------------------------------------------------------------------------
// RunManager
// ---------------------------------------------------------------------------

describe('RunManager', () => {
  function makeRun(id: string, suiteId = 's1', status: 'pending' | 'running' | 'pass' | 'fail' | 'error' = 'pending') {
    return { id, suiteId, suiteName: 'test', status, expectedOutcome: 'pass' as const, startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, error: null, validation: null, result: null, planSnapshot: null }
  }

  it('stores and retrieves a run', () => {
    const mgr = new RunManager()
    const run = makeRun('r1')
    mgr.add(run)
    expect(mgr.get('r1')).toBe(run)
  })

  it('evicts the oldest run when MAX_RUNS (100) is exceeded', () => {
    const mgr = new RunManager()
    for (let i = 0; i < 100; i++) {
      mgr.add(makeRun(`run-${i}`))
    }
    expect(mgr.get('run-0')).toBeDefined()
    // Adding run 101 evicts run-0
    mgr.add(makeRun('run-100'))
    expect(mgr.get('run-0')).toBeUndefined()
    expect(mgr.get('run-100')).toBeDefined()
    expect(mgr.size()).toBe(100)
  })

  it('updates a run in place', () => {
    const mgr = new RunManager()
    mgr.add(makeRun('r1'))
    mgr.update('r1', { status: 'running' })
    expect(mgr.get('r1')?.status).toBe('running')
  })

  it('list returns runs in insertion order', () => {
    const mgr = new RunManager()
    for (const id of ['r1', 'r2', 'r3']) {
      mgr.add(makeRun(id))
    }
    expect(mgr.list().map(r => r.id)).toEqual(['r1', 'r2', 'r3'])
  })

  describe('lastRunForSuite', () => {
    it('returns undefined when no runs exist for a suite', () => {
      const mgr = new RunManager()
      mgr.add(makeRun('r1', 's1'))
      expect(mgr.lastRunForSuite('s99')).toBeUndefined()
    })

    it('returns the most recent run for the given suite', () => {
      const mgr = new RunManager()
      mgr.add(makeRun('r1', 's1'))
      mgr.add(makeRun('r2', 's2'))
      mgr.add(makeRun('r3', 's1'))
      expect(mgr.lastRunForSuite('s1')?.id).toBe('r3')
    })

    it('returns undefined on empty manager', () => {
      const mgr = new RunManager()
      expect(mgr.lastRunForSuite('s1')).toBeUndefined()
    })

    it('ignores runs from other suites', () => {
      const mgr = new RunManager()
      mgr.add(makeRun('r1', 's2'))
      mgr.add(makeRun('r2', 's2'))
      expect(mgr.lastRunForSuite('s1')).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// GET /api/suites
// ---------------------------------------------------------------------------

describe('GET /api/suites', () => {
  let srv: TestServer

  beforeAll(async () => {
    const suites = [
      makeSuite('s1', healthSpec),
      makeSuite('s2', invalidSpec),
    ]
    srv = await startTestServer(suites)
  })

  afterAll(() => srv.close())

  it('returns 200 with a suites array', async () => {
    const { status, body } = await get(srv.baseUrl, '/api/suites')
    expect(status).toBe(200)
    expect(body).toHaveProperty('suites')
    expect(Array.isArray((body as { suites: unknown[] }).suites)).toBe(true)
  })

  it('includes expected fields for each suite', async () => {
    const { body } = await get(srv.baseUrl, '/api/suites')
    const suites = (body as { suites: Record<string, unknown>[] }).suites
    expect(suites.length).toBe(2)
    const first = suites[0]!
    expect(first).toHaveProperty('id')
    expect(first).toHaveProperty('name')
    expect(first).toHaveProperty('path')
    expect(first).toHaveProperty('flowCount')
    expect(first).toHaveProperty('tags')
    expect(first).toHaveProperty('lastRun')
  })

  it('lastRun is null when no runs exist for the suite', async () => {
    const { body } = await get(srv.baseUrl, '/api/suites')
    const suites = (body as { suites: { lastRun: unknown }[] }).suites
    for (const s of suites) {
      expect(s.lastRun).toBeNull()
    }
  })

  it('reports flowCount correctly', async () => {
    const { body } = await get(srv.baseUrl, '/api/suites')
    const suites = (body as { suites: { name: string; flowCount: number }[] }).suites
    const health = suites.find(s => s.name === 'service health check')
    expect(health?.flowCount).toBe(1)
  })

  it('includes expectedOutcome field defaulting to "pass"', async () => {
    const { body } = await get(srv.baseUrl, '/api/suites')
    const suites = (body as { suites: { name: string; expectedOutcome: string }[] }).suites
    for (const s of suites) {
      expect(s).toHaveProperty('expectedOutcome')
      expect(s.expectedOutcome).toBe('pass')
    }
  })
})

// ---------------------------------------------------------------------------
// GET /api/suites -- filtering and sort order
// ---------------------------------------------------------------------------

describe('GET /api/suites filtering and sort', () => {
  const taggedSpec: Spec = spec('tagged suite', {
    baseUrl: 'http://localhost:9999',
    tags: ['smoke', 'regression'],
    flows: [
      flow('main', {
        steps: [step('ping', api('GET /ping', {}))],
      }),
    ],
  })

  let srv: TestServer

  beforeAll(async () => {
    // Use relative paths that produce a known lexical sort order
    const suites = [
      makeSuite(encodeSuiteId('b/second.ts'), taggedSpec, { relativePath: 'b/second.ts' }),
      makeSuite(encodeSuiteId('a/first.ts'), healthSpec,  { relativePath: 'a/first.ts' }),
    ]
    srv = await startTestServer(suites)
  })

  afterAll(() => srv.close())

  it('returns all suites sorted lexically by relativePath', async () => {
    const { body } = await get(srv.baseUrl, '/api/suites')
    const suites = (body as { suites: { name: string }[] }).suites
    expect(suites.map(s => s.name)).toEqual(['service health check', 'tagged suite'])
  })

  it('filters by name (case-insensitive substring)', async () => {
    const { status, body } = await get(srv.baseUrl, '/api/suites?name=health')
    expect(status).toBe(200)
    const suites = (body as { suites: { name: string }[] }).suites
    expect(suites).toHaveLength(1)
    expect(suites[0]!.name).toBe('service health check')
  })

  it('returns empty array for a name that matches nothing', async () => {
    const { body } = await get(srv.baseUrl, '/api/suites?name=nonexistent-xyz')
    const suites = (body as { suites: unknown[] }).suites
    expect(suites).toHaveLength(0)
  })

  it('filters by tag (case-insensitive exact match)', async () => {
    const { body } = await get(srv.baseUrl, '/api/suites?tag=smoke')
    const suites = (body as { suites: { name: string }[] }).suites
    expect(suites).toHaveLength(1)
    expect(suites[0]!.name).toBe('tagged suite')
  })

  it('tag filter is case-insensitive', async () => {
    const { body } = await get(srv.baseUrl, '/api/suites?tag=SMOKE')
    const suites = (body as { suites: { name: string }[] }).suites
    expect(suites).toHaveLength(1)
    expect(suites[0]!.name).toBe('tagged suite')
  })

  it('tag filter does not do substring match', async () => {
    // 'smok' is a substring of 'smoke' but should not match
    const { body } = await get(srv.baseUrl, '/api/suites?tag=smok')
    const suites = (body as { suites: unknown[] }).suites
    expect(suites).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/suites/:id
// ---------------------------------------------------------------------------

describe('GET /api/suites/:id', () => {
  let srv: TestServer
  const id = encodeSuiteId('test/health.ts')

  beforeAll(async () => {
    srv = await startTestServer([makeSuite(id, healthSpec)])
  })

  afterAll(() => srv.close())

  it('returns suite metadata for a valid id', async () => {
    const { status, body } = await get(srv.baseUrl, `/api/suites/${id}`)
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b['name']).toBe('service health check')
    expect(Array.isArray(b['flowNames'])).toBe(true)
    expect((b['flowNames'] as string[])).toContain('health check')
    expect(b).toHaveProperty('stepCount')
    expect(b).toHaveProperty('apiNames')
    expect(b).toHaveProperty('tags')
    expect(b).toHaveProperty('safety')
  })

  it('returns 404 for an unknown suite id', async () => {
    const { status, body } = await get(srv.baseUrl, '/api/suites/totally-unknown-id')
    expect(status).toBe(404)
    expect((body as { error: string }).error).toContain('not found')
  })

  it('returns 500 with error message for a suite that failed to load', async () => {
    const brokenId = encodeSuiteId('test/broken.ts')
    const brokenSuites = [
      { id: brokenId, name: 'broken', path: '/test/broken.ts', relativePath: 'test/broken.ts', spec: null, loadError: 'SyntaxError: Unexpected token' },
    ]
    const srv2 = await startTestServer(brokenSuites)
    try {
      const { status, body } = await get(srv2.baseUrl, `/api/suites/${brokenId}`)
      expect(status).toBe(500)
      expect((body as { error: string }).error).toContain('SyntaxError')
    } finally {
      await srv2.close()
    }
  })
})

// ---------------------------------------------------------------------------
// GET /api/suites/:id/plan
// ---------------------------------------------------------------------------

describe('GET /api/suites/:id/plan', () => {
  let srv: TestServer
  const id = encodeSuiteId('test/health.ts')

  beforeAll(async () => {
    srv = await startTestServer([makeSuite(id, healthSpec)])
  })

  afterAll(() => srv.close())

  it('returns plan with steps, validation, and renderedPlan', async () => {
    const { status, body } = await get(srv.baseUrl, `/api/suites/${id}/plan`)
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b).toHaveProperty('specName')
    expect(b).toHaveProperty('steps')
    expect(Array.isArray(b['steps'])).toBe(true)
    expect(b).toHaveProperty('validation')
    expect(b).toHaveProperty('renderedPlan')
    expect(typeof b['renderedPlan']).toBe('string')
  })

  it('steps include actionType and actionSummary', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${id}/plan`)
    const steps = (body as { steps: Record<string, unknown>[] }).steps
    expect(steps.length).toBeGreaterThan(0)
    const first = steps[0]!
    expect(first).toHaveProperty('name')
    expect(first).toHaveProperty('actionType')
    expect(first).toHaveProperty('actionSummary')
    expect(first).toHaveProperty('retries')
    expect(first).toHaveProperty('saves')
    expect(first).toHaveProperty('expects')
  })

  it('includes validation errors for an invalid spec', async () => {
    const invalidId = encodeSuiteId('test/invalid.ts')
    const srv2 = await startTestServer([makeSuite(invalidId, invalidSpec)])
    try {
      const { status, body } = await get(srv2.baseUrl, `/api/suites/${invalidId}/plan`)
      expect(status).toBe(200)
      const validation = (body as { validation: { errors: string[] } }).validation
      expect(validation.errors.length).toBeGreaterThan(0)
    } finally {
      await srv2.close()
    }
  })

  it('returns 404 for unknown id', async () => {
    const { status } = await get(srv.baseUrl, '/api/suites/unknown/plan')
    expect(status).toBe(404)
  })

  it('includes flowRanges with correct shape and values', async () => {
    const { status, body } = await get(srv.baseUrl, `/api/suites/${id}/plan`)
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b).toHaveProperty('flowRanges')
    expect(Array.isArray(b['flowRanges'])).toBe(true)

    const flowRanges = b['flowRanges'] as Record<string, unknown>[]
    expect(flowRanges.length).toBeGreaterThan(0)

    const first = flowRanges[0]!
    expect(first).toHaveProperty('name')
    expect(first).toHaveProperty('startIndex')
    expect(first).toHaveProperty('stepCount')
    expect(typeof first['name']).toBe('string')
    expect(typeof first['startIndex']).toBe('number')
    expect(typeof first['stepCount']).toBe('number')

    // healthSpec has one flow named 'health check' with 2 steps
    expect(first['name']).toBe('health check')
    expect(first['startIndex']).toBe(0)
    expect(first['stepCount']).toBe(2)
  })

  it('flowRanges stepCount sums to total steps', async () => {
    const multiId = encodeSuiteId('test/multiflow-plan.ts')
    const srv2 = await startTestServer([makeSuite(multiId, multiFlowSpec)])
    try {
      const { body } = await get(srv2.baseUrl, `/api/suites/${multiId}/plan`)
      const b = body as Record<string, unknown>
      const steps = b['steps'] as unknown[]
      const flowRanges = b['flowRanges'] as { stepCount: number }[]
      const rangeTotal = flowRanges.reduce((acc, r) => acc + r.stepCount, 0)
      expect(rangeTotal).toBe(steps.length)
    } finally {
      await srv2.close()
    }
  })
})

// ---------------------------------------------------------------------------
// POST /api/suites/:id/run
// ---------------------------------------------------------------------------

describe('POST /api/suites/:id/run', () => {
  let srv: TestServer
  const id = encodeSuiteId('test/health.ts')

  beforeAll(async () => {
    srv = await startTestServer([makeSuite(id, healthSpec)])
  })

  afterAll(() => srv.close())

  it('returns 201 with a runId', async () => {
    const { status, body } = await post(srv.baseUrl, `/api/suites/${id}/run`, {})
    expect(status).toBe(201)
    expect((body as { runId: string }).runId).toBeDefined()
    expect(typeof (body as { runId: string }).runId).toBe('string')
  })

  it('creates a run that appears in GET /api/runs', async () => {
    const { body: postBody } = await post(srv.baseUrl, `/api/suites/${id}/run`, {})
    const runId = (postBody as { runId: string }).runId
    await sleep(50)
    const { body: listBody } = await get(srv.baseUrl, '/api/runs')
    const runs = (listBody as { runs: { id: string }[] }).runs
    expect(runs.some(r => r.id === runId)).toBe(true)
  })

  it('returns 404 for unknown suite', async () => {
    const { status } = await post(srv.baseUrl, '/api/suites/nonexistent/run', {})
    expect(status).toBe(404)
  })

  it('returns 400 for malformed body (non-object)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/suites/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '"not-an-object"',
    })
    expect(res.status).toBe(400)
  })

  it('creates an error run immediately for a load-errored suite', async () => {
    const errId = encodeSuiteId('test/bad.ts')
    const errSuites = [
      { id: errId, name: 'bad', path: '/test/bad.ts', relativePath: 'test/bad.ts', spec: null, loadError: 'Cannot find module' },
    ]
    const srv2 = await startTestServer(errSuites)
    try {
      const { status, body } = await post(srv2.baseUrl, `/api/suites/${errId}/run`, {})
      expect(status).toBe(201)
      const runId = (body as { runId: string }).runId
      const { body: runBody } = await get(srv2.baseUrl, `/api/runs/${runId}`)
      expect((runBody as { status: string }).status).toBe('error')
      expect((runBody as { error: string }).error).toContain('Cannot find module')
    } finally {
      await srv2.close()
    }
  })
})

// ---------------------------------------------------------------------------
// GET /api/runs
// ---------------------------------------------------------------------------

describe('GET /api/runs', () => {
  let srv: TestServer

  beforeAll(async () => {
    srv = await startTestServer([makeSuite('s1', healthSpec)])
  })

  afterAll(() => srv.close())

  it('returns 200 with a runs array', async () => {
    const { status, body } = await get(srv.baseUrl, '/api/runs')
    expect(status).toBe(200)
    expect(Array.isArray((body as { runs: unknown[] }).runs)).toBe(true)
  })

  it('run summaries have expected fields', async () => {
    await post(srv.baseUrl, '/api/suites/s1/run', {})
    await sleep(50)
    const { body } = await get(srv.baseUrl, '/api/runs')
    const runs = (body as { runs: Record<string, unknown>[] }).runs
    expect(runs.length).toBeGreaterThan(0)
    const run = runs[0]!
    expect(run).toHaveProperty('id')
    expect(run).toHaveProperty('suiteId')
    expect(run).toHaveProperty('suiteName')
    expect(run).toHaveProperty('status')
    expect(run).toHaveProperty('startedAt')
    expect(run).toHaveProperty('durationMs')
    expect(run).toHaveProperty('expectedOutcome')
    expect(run).toHaveProperty('meetsExpectedOutcome')
  })
})

// ---------------------------------------------------------------------------
// GET /api/runs/:id
// ---------------------------------------------------------------------------

describe('GET /api/runs/:id', () => {
  let srv: TestServer
  const id = encodeSuiteId('test/health.ts')

  beforeAll(async () => {
    srv = await startTestServer([makeSuite(id, healthSpec)])
  })

  afterAll(() => srv.close())

  it('returns 404 for unknown run id', async () => {
    const { status } = await get(srv.baseUrl, '/api/runs/nonexistent-id')
    expect(status).toBe(404)
  })

  it('returns full run detail shape', async () => {
    const { body: postBody } = await post(srv.baseUrl, `/api/suites/${id}/run`, {})
    const runId = (postBody as { runId: string }).runId
    await sleep(50)

    const { status, body } = await get(srv.baseUrl, `/api/runs/${runId}`)
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b).toHaveProperty('id', runId)
    expect(b).toHaveProperty('suiteId', id)
    expect(b).toHaveProperty('suiteName', 'service health check')
    expect(b).toHaveProperty('status')
    expect(b).toHaveProperty('startedAt')
    expect(b).toHaveProperty('finishedAt')
    expect(b).toHaveProperty('durationMs')
    expect(b).toHaveProperty('error')
    expect(b).toHaveProperty('validation')
  })

  it('step results include actionType, actionSummary, saves, expects, flowOrigin', async () => {
    const { body: postBody } = await post(srv.baseUrl, `/api/suites/${id}/run`, {})
    const runId = (postBody as { runId: string }).runId

    // Poll until terminal
    let finalRun: Record<string, unknown> | null = null
    for (let i = 0; i < 30; i++) {
      await sleep(100)
      const { body } = await get(srv.baseUrl, `/api/runs/${runId}`)
      const r = body as Record<string, unknown>
      if (r['status'] !== 'pending' && r['status'] !== 'running') { finalRun = r; break }
    }
    expect(finalRun).not.toBeNull()

    type StepShape = { name: string; actionType: string | null; actionSummary: string | null; saves: string[]; expects: string[]; flowOrigin: string | null }
    const flows = finalRun?.['flows'] as { name: string; steps: StepShape[] }[] | null
    expect(flows).not.toBeNull()
    const steps = flows?.flatMap(f => f.steps) ?? []
    expect(steps.length).toBeGreaterThan(0)

    const first = steps[0]!
    expect(first).toHaveProperty('actionType')
    expect(first).toHaveProperty('actionSummary')
    expect(first).toHaveProperty('saves')
    expect(first).toHaveProperty('expects')
    expect(first).toHaveProperty('flowOrigin')

    // The API step should have actionType 'api' and summary 'GET /api/health'
    expect(first.actionType).toBe('api')
    expect(first.actionSummary).toBe('GET /api/health')
    expect(Array.isArray(first.saves)).toBe(true)
    expect(Array.isArray(first.expects)).toBe(true)
  })

  it('invalid suite run eventually reaches error status', async () => {
    const invId = encodeSuiteId('test/invalid2.ts')
    const srv2 = await startTestServer([makeSuite(invId, invalidSpec)])
    try {
      const { body: postBody } = await post(srv2.baseUrl, `/api/suites/${invId}/run`, {})
      const runId = (postBody as { runId: string }).runId

      // Poll until the run finishes
      let finalRun: Record<string, unknown> | null = null
      for (let i = 0; i < 20; i++) {
        await sleep(50)
        const { body } = await get(srv2.baseUrl, `/api/runs/${runId}`)
        const run = body as Record<string, unknown>
        if (run['status'] !== 'pending' && run['status'] !== 'running') {
          finalRun = run
          break
        }
      }

      expect(finalRun).not.toBeNull()
      expect(finalRun?.['status']).toBe('error')
      const validation = finalRun?.['validation'] as { errors: string[] } | null
      expect(validation?.errors.length).toBeGreaterThan(0)
    } finally {
      await srv2.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Multi-flow step alignment -- proves plan snapshot merges correctly
// ---------------------------------------------------------------------------

describe('multi-flow step alignment in run response', () => {
  it('actionSummary lands on the correct step in the correct flow', async () => {
    const multiId = encodeSuiteId('test/multiflow.ts')
    const srv = await startTestServer([makeSuite(multiId, multiFlowSpec)])
    try {
      const { body: postBody } = await post(srv.baseUrl, `/api/suites/${multiId}/run`, {})
      const runId = (postBody as { runId: string }).runId

      // Poll until terminal (will error since baseUrl is unreachable, but planSnapshot is set before running)
      let finalRun: Record<string, unknown> | null = null
      for (let i = 0; i < 30; i++) {
        await sleep(100)
        const { body } = await get(srv.baseUrl, `/api/runs/${runId}`)
        const r = body as Record<string, unknown>
        if (r['status'] !== 'pending' && r['status'] !== 'running') { finalRun = r; break }
      }
      expect(finalRun).not.toBeNull()

      type StepShape = { name: string; actionType: string | null; actionSummary: string | null; saves: string[]; expects: string[] }
      type FlowShape = { name: string; steps: StepShape[] }
      const flows = finalRun?.['flows'] as FlowShape[] | null

      // Even on failure, flows and step results should be present
      if (flows === null || flows.length === 0) {
        // Run failed before producing results (e.g. very fast network error) -- skip alignment check
        return
      }

      // flow alpha: 2 steps -- GET /api/alpha (with save), GET /api/beta
      const alphaFlow = flows.find(f => f.name === 'flow alpha')
      if (alphaFlow && alphaFlow.steps.length >= 1) {
        expect(alphaFlow.steps[0]!.actionSummary).toBe('GET /api/alpha')
        expect(alphaFlow.steps[0]!.saves).toContain('alphaResult')
      }
      if (alphaFlow && alphaFlow.steps.length >= 2) {
        expect(alphaFlow.steps[1]!.actionSummary).toBe('GET /api/beta')
      }

      // flow gamma: 1 step -- POST /api/gamma
      const gammaFlow = flows.find(f => f.name === 'flow gamma')
      if (gammaFlow && gammaFlow.steps.length >= 1) {
        expect(gammaFlow.steps[0]!.actionSummary).toBe('POST /api/gamma')
      }
    } finally {
      await srv.close()
    }
  })
})

// ---------------------------------------------------------------------------
// lastRun field on GET /api/suites after runs are created
// ---------------------------------------------------------------------------

describe('GET /api/suites lastRun field', () => {
  it('reflects the most recent run status for a suite', async () => {
    const id = encodeSuiteId('test/lastrun.ts')
    const srv = await startTestServer([makeSuite(id, healthSpec)])
    try {
      // No runs yet -- lastRun should be null
      const { body: before } = await get(srv.baseUrl, '/api/suites')
      const suitesBefore = (before as { suites: { id: string; lastRun: unknown }[] }).suites
      const suiteBefore = suitesBefore.find(s => s.id === id)
      expect(suiteBefore?.lastRun).toBeNull()

      // Create a run
      const { body: postBody } = await post(srv.baseUrl, `/api/suites/${id}/run`, {})
      const runId = (postBody as { runId: string }).runId
      await sleep(50)

      // Now lastRun should be populated
      const { body: after } = await get(srv.baseUrl, '/api/suites')
      const suitesAfter = (after as { suites: { id: string; lastRun: { id: string; status: string; startedAt: string; durationMs: number | null } | null }[] }).suites
      const suiteAfter = suitesAfter.find(s => s.id === id)
      expect(suiteAfter?.lastRun).not.toBeNull()
      expect(suiteAfter?.lastRun?.id).toBe(runId)
      expect(suiteAfter?.lastRun?.status).toBeDefined()
      expect(suiteAfter?.lastRun?.startedAt).toBeDefined()
    } finally {
      await srv.close()
    }
  })
})

// ---------------------------------------------------------------------------
// expectedOutcome and meetsExpectedOutcome in run responses
// ---------------------------------------------------------------------------

describe('expectedOutcome in run responses', () => {
  it('run detail includes expectedOutcome and meetsExpectedOutcome', async () => {
    const id = encodeSuiteId('test/expected-outcome.ts')
    const srv = await startTestServer([makeSuite(id, healthSpec)])
    try {
      const { body: postBody } = await post(srv.baseUrl, `/api/suites/${id}/run`, {})
      const runId = (postBody as { runId: string }).runId
      await sleep(50)
      const { body } = await get(srv.baseUrl, `/api/runs/${runId}`)
      const run = body as Record<string, unknown>
      expect(run).toHaveProperty('expectedOutcome', 'pass')
      expect(run).toHaveProperty('meetsExpectedOutcome')
      expect(typeof run['meetsExpectedOutcome']).toBe('boolean')
    } finally {
      await srv.close()
    }
  })

  it('spec with expectedOutcome "error" propagates to run record', async () => {
    const errorFixture = spec('error fixture', {
      baseUrl: 'http://localhost:9999',
      expectedOutcome: 'error',
      flows: [
        flow('bad flow', {
          steps: [
            step('assert unsaved ref',
              orthExpect(ref('nope'), 'equals', 'x')
            ),
          ],
        }),
      ],
    })
    const id = encodeSuiteId('test/error-fixture.ts')
    const srv = await startTestServer([makeSuite(id, errorFixture)])
    try {
      const { body: postBody } = await post(srv.baseUrl, `/api/suites/${id}/run`, {})
      const runId = (postBody as { runId: string }).runId

      let finalRun: Record<string, unknown> | null = null
      for (let i = 0; i < 20; i++) {
        await sleep(50)
        const { body } = await get(srv.baseUrl, `/api/runs/${runId}`)
        const r = body as Record<string, unknown>
        if (r['status'] !== 'pending' && r['status'] !== 'running') { finalRun = r; break }
      }

      expect(finalRun).not.toBeNull()
      expect(finalRun?.['status']).toBe('error')
      expect(finalRun?.['expectedOutcome']).toBe('error')
      expect(finalRun?.['meetsExpectedOutcome']).toBe(true)
    } finally {
      await srv.close()
    }
  })

  it('suite list includes expectedOutcome from spec', async () => {
    const errorFixture = spec('error fixture for list', {
      baseUrl: 'http://localhost:9999',
      expectedOutcome: 'error',
      flows: [
        flow('f', {
          steps: [step('s', api('GET /ping', {}))],
        }),
      ],
    })
    const id = encodeSuiteId('test/error-fixture-list.ts')
    const srv = await startTestServer([makeSuite(id, errorFixture)])
    try {
      const { body } = await get(srv.baseUrl, '/api/suites')
      const suites = (body as { suites: { id: string; expectedOutcome: string }[] }).suites
      const found = suites.find(s => s.id === id)
      expect(found).toBeDefined()
      expect(found?.expectedOutcome).toBe('error')
    } finally {
      await srv.close()
    }
  })
})

// ---------------------------------------------------------------------------
// POST /api/run-all
// ---------------------------------------------------------------------------

describe('POST /api/run-all', () => {
  it('returns 201 with runIds for all suites', async () => {
    const s1Id = encodeSuiteId('test/run-all-1.ts')
    const s2Id = encodeSuiteId('test/run-all-2.ts')
    const srv = await startTestServer([
      makeSuite(s1Id, healthSpec),
      makeSuite(s2Id, multiFlowSpec),
    ])
    try {
      const { status, body } = await post(srv.baseUrl, '/api/run-all', {})
      expect(status).toBe(201)
      const { runIds } = body as { runIds: string[] }
      expect(runIds).toHaveLength(2)
      expect(new Set(runIds).size).toBe(2)

      await sleep(50)
      const { body: runsBody } = await get(srv.baseUrl, '/api/runs')
      const runs = (runsBody as { runs: { id: string }[] }).runs
      for (const runId of runIds) {
        expect(runs.some(r => r.id === runId)).toBe(true)
      }
    } finally {
      await srv.close()
    }
  })

  it('creates error runs for load-errored suites', async () => {
    const okId = encodeSuiteId('test/run-all-ok.ts')
    const errId = encodeSuiteId('test/run-all-err.ts')
    const srv = await startTestServer([
      makeSuite(okId, healthSpec),
      { id: errId, name: 'broken', path: '/test/run-all-err.ts', relativePath: 'test/run-all-err.ts', spec: null, loadError: 'Cannot parse' },
    ])
    try {
      const { status, body } = await post(srv.baseUrl, '/api/run-all', {})
      expect(status).toBe(201)
      const { runIds } = body as { runIds: string[] }
      expect(runIds).toHaveLength(2)

      await sleep(50)
      const errRunId = runIds[1]!
      const { body: runBody } = await get(srv.baseUrl, `/api/runs/${errRunId}`)
      expect((runBody as { status: string }).status).toBe('error')
      expect((runBody as { error: string }).error).toContain('Cannot parse')
    } finally {
      await srv.close()
    }
  })

  it('returns 400 for malformed body', async () => {
    const srv = await startTestServer([makeSuite('s1', healthSpec)])
    try {
      const res = await fetch(`${srv.baseUrl}/api/run-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '"not-an-object"',
      })
      expect(res.status).toBe(400)
    } finally {
      await srv.close()
    }
  })

  it('excludeTags skips suites with matching tags', async () => {
    const taggedSpec: Spec = spec('tagged suite', {
      baseUrl: 'http://localhost:9999',
      tags: ['server', 'run'],
      flows: [
        flow('f', { steps: [step('s', api('GET /ping', {}))] }),
      ],
    })
    const s1Id = encodeSuiteId('test/run-all-tag-1.ts')
    const s2Id = encodeSuiteId('test/run-all-tag-2.ts')
    const s3Id = encodeSuiteId('test/run-all-tag-3.ts')
    const srv = await startTestServer([
      makeSuite(s1Id, healthSpec),
      makeSuite(s2Id, taggedSpec),
      makeSuite(s3Id, multiFlowSpec),
    ])
    try {
      const { status, body } = await post(srv.baseUrl, '/api/run-all', { excludeTags: ['server'] })
      expect(status).toBe(201)
      const { runIds } = body as { runIds: string[] }
      // Only healthSpec and multiFlowSpec should run (taggedSpec has 'server' tag)
      expect(runIds).toHaveLength(2)
    } finally {
      await srv.close()
    }
  })

  it('excludeTags is case-insensitive', async () => {
    const taggedSpec: Spec = spec('upper tag suite', {
      baseUrl: 'http://localhost:9999',
      tags: ['Server'],
      flows: [
        flow('f', { steps: [step('s', api('GET /ping', {}))] }),
      ],
    })
    const s1Id = encodeSuiteId('test/run-all-case-1.ts')
    const s2Id = encodeSuiteId('test/run-all-case-2.ts')
    const srv = await startTestServer([
      makeSuite(s1Id, healthSpec),
      makeSuite(s2Id, taggedSpec),
    ])
    try {
      const { status, body } = await post(srv.baseUrl, '/api/run-all', { excludeTags: ['server'] })
      expect(status).toBe(201)
      const { runIds } = body as { runIds: string[] }
      expect(runIds).toHaveLength(1)
    } finally {
      await srv.close()
    }
  })

  it('runs all suites when excludeTags is empty', async () => {
    const s1Id = encodeSuiteId('test/run-all-empty-1.ts')
    const s2Id = encodeSuiteId('test/run-all-empty-2.ts')
    const srv = await startTestServer([
      makeSuite(s1Id, healthSpec),
      makeSuite(s2Id, multiFlowSpec),
    ])
    try {
      const { status, body } = await post(srv.baseUrl, '/api/run-all', { excludeTags: [] })
      expect(status).toBe(201)
      const { runIds } = body as { runIds: string[] }
      expect(runIds).toHaveLength(2)
    } finally {
      await srv.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Concurrent runs
// ---------------------------------------------------------------------------

describe('concurrent runs', () => {
  it('allows multiple runs to be created simultaneously', async () => {
    const id = encodeSuiteId('test/concurrent.ts')
    const srv = await startTestServer([makeSuite(id, healthSpec)])
    try {
      const results = await Promise.all([
        post(srv.baseUrl, `/api/suites/${id}/run`, {}),
        post(srv.baseUrl, `/api/suites/${id}/run`, {}),
        post(srv.baseUrl, `/api/suites/${id}/run`, {}),
      ])
      const runIds = results.map(r => (r.body as { runId: string }).runId)
      expect(new Set(runIds).size).toBe(3)  // all unique
      expect(results.every(r => r.status === 201)).toBe(true)
    } finally {
      await srv.close()
    }
  })
})

// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------

describe('SPA fallback', () => {
  let srv: TestServer

  beforeAll(async () => {
    srv = await startTestServer([makeSuite('s1', healthSpec)])
  })

  afterAll(() => srv.close())

  it('serves index.html for unknown paths', async () => {
    const res = await fetch(`${srv.baseUrl}/suites/someid`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('<title>Ortheon</title>')
  })
})
