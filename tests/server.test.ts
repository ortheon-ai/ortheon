import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { RequestHandler } from 'express'
import { spec, flow, step, api, expect as orthExpect, ref } from '../src/dsl.js'
import { createApp, encodeSuiteId, decodeSuiteId, type ServerSuite } from '../src/server/app.js'
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
    kind: 'spec',
    spec: s,
    agentSpec: null,
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
}

function startTestServer(
  suites: ServerSuite[],
  middleware?: RequestHandler[],
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const app = createApp(suites, { middleware })
    const server = createServer(app)

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${addr.port}`
      resolve({
        baseUrl,
        close: () => new Promise<void>(res => server.close(() => res())),
      })
    })
  })
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
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
    expect(first).toHaveProperty('expectedOutcome')
    expect(first).not.toHaveProperty('lastRun')
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

describe('GET /api/suites with a failed-to-load suite', () => {
  let srv: TestServer
  let brokenId: string

  beforeAll(async () => {
    brokenId = encodeSuiteId('test/broken.ts')
    const suites: ServerSuite[] = [
      makeSuite('s1', healthSpec),
      {
        id: brokenId,
        name: 'broken',
        path: '/test/broken.ts',
        relativePath: 'test/broken.ts',
        kind: null,
        spec: null,
        agentSpec: null,
        loadError: 'SyntaxError: Unexpected token',
      },
    ]
    srv = await startTestServer(suites)
  })

  afterAll(() => srv.close())

  it('returns type="unknown" and hasError=true for a suite that failed to load', async () => {
    const { body } = await get(srv.baseUrl, '/api/suites')
    const suites = (body as { suites: Record<string, unknown>[] }).suites
    const broken = suites.find(s => s['name'] === 'broken')
    expect(broken).toBeDefined()
    expect(broken!['type']).toBe('unknown')
    expect(broken!['hasError']).toBe(true)
  })

  it('does not return type="spec" or type="agent" for a suite that failed to load', async () => {
    const { body } = await get(srv.baseUrl, '/api/suites')
    const suites = (body as { suites: Record<string, unknown>[] }).suites
    const broken = suites.find(s => s['name'] === 'broken')
    expect(broken!['type']).not.toBe('spec')
    expect(broken!['type']).not.toBe('agent')
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
      { id: brokenId, name: 'broken', path: '/test/broken.ts', relativePath: 'test/broken.ts', kind: null, spec: null, agentSpec: null, loadError: 'SyntaxError: Unexpected token' },
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
// GET /api/suites/:id/execution-plan
// ---------------------------------------------------------------------------

describe('GET /api/suites/:id/execution-plan', () => {
  let srv: TestServer
  const id = encodeSuiteId('test/exec-plan.ts')

  beforeAll(async () => {
    srv = await startTestServer([makeSuite(id, healthSpec)])
  })

  afterAll(() => srv.close())

  it('returns 200 with planVersion, plan, and validation', async () => {
    const { status, body } = await get(srv.baseUrl, `/api/suites/${id}/execution-plan`)
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b).toHaveProperty('planVersion', 1)
    expect(b).toHaveProperty('plan')
    expect(b).toHaveProperty('validation')
  })

  it('plan field contains specName, baseUrl, steps, flowRanges, data, apis', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${id}/execution-plan`)
    const plan = (body as { plan: Record<string, unknown> }).plan
    expect(plan).toHaveProperty('specName', 'service health check')
    expect(plan).toHaveProperty('baseUrl')
    expect(plan).toHaveProperty('steps')
    expect(plan).toHaveProperty('flowRanges')
    expect(plan).toHaveProperty('data')
    expect(plan).toHaveProperty('apis')
    expect(Array.isArray(plan['steps'])).toBe(true)
    expect(Array.isArray(plan['flowRanges'])).toBe(true)
  })

  it('steps contain raw executable action objects, not display summaries', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${id}/execution-plan`)
    const plan = (body as { plan: { steps: Record<string, unknown>[] } }).plan
    const step = plan.steps[0]!
    // Each step has a full action object, not a string summary
    expect(step).toHaveProperty('action')
    const action = step['action'] as Record<string, unknown>
    expect(action).toHaveProperty('__type')
    expect(step).toHaveProperty('name')
    expect(step).toHaveProperty('saves')
    expect(step).toHaveProperty('expects')
    expect(step).toHaveProperty('retries')
  })

  it('validation field has errors and warnings arrays', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${id}/execution-plan`)
    const validation = (body as { validation: Record<string, unknown> }).validation
    expect(Array.isArray(validation['errors'])).toBe(true)
    expect(Array.isArray(validation['warnings'])).toBe(true)
  })

  it('validation errors are populated for an invalid spec', async () => {
    const badId = encodeSuiteId('test/exec-plan-bad.ts')
    const srv2 = await startTestServer([makeSuite(badId, invalidSpec)])
    try {
      const { status, body } = await get(srv2.baseUrl, `/api/suites/${badId}/execution-plan`)
      expect(status).toBe(200)
      const validation = (body as { validation: { errors: string[] } }).validation
      expect(validation.errors.length).toBeGreaterThan(0)
    } finally {
      await srv2.close()
    }
  })

  it('includes expectedOutcome, tags, and safety from the spec', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${id}/execution-plan`)
    const b = body as Record<string, unknown>
    expect(b).toHaveProperty('expectedOutcome', 'pass')
    expect(Array.isArray(b['tags'])).toBe(true)
  })

  it('returns 404 for unknown suite id', async () => {
    const { status } = await get(srv.baseUrl, '/api/suites/nonexistent-id/execution-plan')
    expect(status).toBe(404)
  })

  it('plan is directly usable by runPlan() without modification', async () => {
    // This is the key end-to-end assertion: the returned plan shape is accepted by runPlan
    const { body } = await get(srv.baseUrl, `/api/suites/${id}/execution-plan`)
    const b = body as { plan: Record<string, unknown> }
    // We just verify the shape rather than actually executing (no live server for healthSpec)
    // runPlan() accepts an ExecutionPlan -- checking that all required fields are present
    expect(b.plan).toHaveProperty('specName')
    expect(b.plan).toHaveProperty('baseUrl')
    expect(b.plan).toHaveProperty('steps')
    expect(b.plan).toHaveProperty('flowRanges')
    expect(b.plan).toHaveProperty('data')
    expect(b.plan).toHaveProperty('apis')
    // planVersion is in the envelope, not the plan itself
    expect(body).toHaveProperty('planVersion', 1)
  })
})

// ---------------------------------------------------------------------------
// SPA fallback (run tests removed; server no longer executes specs)
// ---------------------------------------------------------------------------

// The following tests have been removed as the server no longer has run endpoints:
// - POST /api/suites/:id/run
// - POST /api/run-all
// - GET /api/runs
// - GET /api/runs/:id
// - RunManager unit tests
//
// Execution now happens via the CLI using plans fetched from GET /api/suites/:id/execution-plan.

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

// ---------------------------------------------------------------------------
// Middleware hook
// ---------------------------------------------------------------------------

describe('middleware hook', () => {
  it('supplied middleware runs before route handlers and can reject requests', async () => {
    const rejectAll: RequestHandler = (_req, res, _next) => {
      res.status(401).json({ error: 'unauthorized' })
    }
    const srv = await startTestServer([makeSuite('s1', healthSpec)], [rejectAll])

    try {
      // Any API route should be blocked by the middleware.
      const res = await fetch(`${srv.baseUrl}/api/suites`)
      expect(res.status).toBe(401)
      const body = await res.json() as Record<string, unknown>
      expect(body['error']).toBe('unauthorized')

      // A second route to confirm middleware applies broadly.
      const res2 = await fetch(`${srv.baseUrl}/api/contracts`)
      expect(res2.status).toBe(401)
    } finally {
      await srv.close()
    }
  })

  it('middleware that calls next() allows requests through', async () => {
    let sawRequest = false
    const passThrough: RequestHandler = (_req, _res, next) => {
      sawRequest = true
      next()
    }
    const srv = await startTestServer([makeSuite('s1', healthSpec)], [passThrough])

    try {
      const res = await fetch(`${srv.baseUrl}/api/suites`)
      expect(res.status).toBe(200)
      expect(sawRequest).toBe(true)
    } finally {
      await srv.close()
    }
  })
})
