import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { runSpec, runPlan } from '../src/runner.js'
import { compile } from '../src/compiler.js'
import { spec, flow, step, api, browser, expect as orth_expect, ref, env } from '../src/dsl.js'
import type { ExecutionPlan } from '../src/types.js'

// ---------------------------------------------------------------------------
// Minimal test HTTP server
// ---------------------------------------------------------------------------

type RouteTable = Record<string, { status: number; body: unknown; delay?: number }>

function startTestServer(routes: RouteTable): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const key = `${req.method} ${req.url?.split('?')[0]}`
      const route = routes[key]
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      const respond = () => {
        res.writeHead(route.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(route.body))
      }
      if (route.delay) {
        setTimeout(respond, route.delay)
      } else {
        respond()
      }
    })
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://localhost:${port}` })
    })
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSpec', () => {
  let server: Server | null = null

  afterEach(() => {
    server?.close()
    server = null
  })

  describe('pass / fail outcomes', () => {
    it('returns pass for a spec where all steps succeed', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/health': { status: 200, body: { status: 'ok' } },
      })
      server = s

      const theSpec = spec('health', {
        flows: [
          flow('main', {
            steps: [
              step('check health', api('GET /api/health', { expect: { status: 200 } })),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('pass')
      expect(result.passedSteps).toBe(1)
      expect(result.failedSteps).toBe(0)
      // Flow results preserve authored flow names
      expect(result.flows).toHaveLength(1)
      expect(result.flows[0]!.name).toBe('main')
    })

    it('returns fail when a step receives an unexpected status', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/items': { status: 500, body: { error: 'internal' } },
      })
      server = s

      const theSpec = spec('bad-status', {
        flows: [
          flow('main', {
            steps: [
              step('list items', api('GET /api/items', { expect: { status: 200 } })),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('fail')
      expect(result.failedSteps).toBe(1)
      expect(result.flows[0]!.steps[0]!.error).toBeDefined()
    })

    it('returns fail when an inline body assertion fails', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/health': { status: 200, body: { status: 'degraded' } },
      })
      server = s

      const theSpec = spec('body-fail', {
        flows: [
          flow('main', {
            steps: [
              step('check health', api('GET /api/health', {
                expect: { status: 200, body: { status: 'ok' } },
              })),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('fail')
    })

    it('returns fail when an expect() assertion fails', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/status': { status: 200, body: { state: 'inactive' } },
      })
      server = s

      const theSpec = spec('expect-fail', {
        flows: [
          flow('main', {
            steps: [
              step('fetch status', api('GET /api/status', { save: { state: 'body.state' } })),
              step('assert active', orth_expect(ref('state'), 'equals', 'active')),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('fail')
      const assertStep = result.flows[0]!.steps.find(s => s.name === 'assert active')
      expect(assertStep?.status).toBe('fail')
    })
  })

  describe('step skip-after-failure', () => {
    it('skips all steps after the first failure', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/a': { status: 200, body: {} },
        'GET /api/b': { status: 500, body: {} },  // fails
        'GET /api/c': { status: 200, body: {} },
      })
      server = s

      const theSpec = spec('skip-test', {
        flows: [
          flow('main', {
            steps: [
              step('step a', api('GET /api/a', { expect: { status: 200 } })),
              step('step b', api('GET /api/b', { expect: { status: 200 } })),
              step('step c', api('GET /api/c', { expect: { status: 200 } })),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('fail')
      const steps = result.flows[0]!.steps
      expect(steps[0]!.status).toBe('pass')
      expect(steps[1]!.status).toBe('fail')
      expect(steps[2]!.status).toBe('skip')
    })
  })

  describe('retry logic', () => {
    it('retries a failing step and passes on a later attempt', async () => {
      // Track call count server-side
      let callCount = 0
      const { server: s, url } = await startTestServer({})
      server = s

      // Override the handler with one that counts calls
      s.removeAllListeners('request')
      s.on('request', (req, res) => {
        if (req.url === '/api/flaky') {
          callCount++
          const status = callCount < 3 ? 503 : 200
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: callCount >= 3 }))
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      const theSpec = spec('retry-test', {
        flows: [
          flow('main', {
            steps: [
              step('flaky call', api('GET /api/flaky', { expect: { status: 200 } }), { retries: 3 }),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('pass')
      expect(callCount).toBe(3)
    })

    it('retries with fixed interval when retryIntervalMs is set', async () => {
      let callCount = 0
      const callTimestamps: number[] = []
      const { server: s, url } = await startTestServer({})
      server = s

      s.removeAllListeners('request')
      s.on('request', (req, res) => {
        if (req.url === '/api/flaky') {
          callCount++
          callTimestamps.push(Date.now())
          const status = callCount < 3 ? 503 : 200
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: callCount >= 3 }))
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      const theSpec = spec('retry-interval-test', {
        flows: [
          flow('main', {
            steps: [
              step('flaky call', api('GET /api/flaky', { expect: { status: 200 } }), { retries: 3, retryIntervalMs: 100 }),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('pass')
      expect(callCount).toBe(3)
      // Verify intervals are approximately fixed (not linearly growing)
      // Interval 1: between call 1 and 2; interval 2: between call 2 and 3
      const interval1 = callTimestamps[1]! - callTimestamps[0]!
      const interval2 = callTimestamps[2]! - callTimestamps[1]!
      // Both intervals should be ~100ms (allow generous tolerance for CI)
      expect(interval1).toBeGreaterThanOrEqual(50)
      expect(interval1).toBeLessThan(400)
      expect(interval2).toBeGreaterThanOrEqual(50)
      expect(interval2).toBeLessThan(400)
      // Fixed interval: second interval should not be dramatically larger than first
      // (with linear backoff it would be ~double)
      expect(interval2).toBeLessThan(interval1 * 3)
    })

    it('fails after exhausting all retries', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/always-fail': { status: 503, body: { error: 'unavailable' } },
      })
      server = s

      const theSpec = spec('retry-exhausted', {
        flows: [
          flow('main', {
            steps: [
              step('always fails', api('GET /api/always-fail', { expect: { status: 200 } }), { retries: 2 }),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('fail')
      expect(result.failedSteps).toBe(1)
    })
  })

  describe('baseUrl resolution', () => {
    it('uses baseUrl from options when provided', async () => {
      const { server: s, url } = await startTestServer({
        'GET /ping': { status: 200, body: { pong: true } },
      })
      server = s

      const theSpec = spec('url-from-options', {
        flows: [
          flow('main', {
            steps: [step('ping', api('GET /ping', { expect: { status: 200 } }))],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('pass')
    })

    it('resolves baseUrl from env() when no option is provided', async () => {
      const { server: s, url } = await startTestServer({
        'GET /ping': { status: 200, body: {} },
      })
      server = s

      process.env['TEST_BASE_URL'] = url
      try {
        const theSpec = spec('url-from-env', {
          baseUrl: env('TEST_BASE_URL'),
          flows: [
            flow('main', {
              steps: [step('ping', api('GET /ping', { expect: { status: 200 } }))],
            }),
          ],
        })

        const result = await runSpec(theSpec)
        expect(result.status).toBe('pass')
      } finally {
        delete process.env['TEST_BASE_URL']
      }
    })

    it('throws when baseUrl is not configured', async () => {
      const theSpec = spec('no-url', {
        flows: [
          flow('main', {
            steps: [step('ping', api('GET /ping', {}))],
          }),
        ],
      })

      await expect(runSpec(theSpec)).rejects.toThrow('No baseUrl')
    })

    it('throws "No baseUrl configured" for a browser goto step with no baseUrl', async () => {
      // A spec with no baseUrl but a browser goto step using the default base should
      // throw the clear "No baseUrl configured" error early, not a confusing Playwright error.
      const theSpec = spec('no-url-browser', {
        flows: [
          flow('main', {
            steps: [step('open page', browser('goto', { url: '/home' }))],
          }),
        ],
      })

      await expect(runSpec(theSpec)).rejects.toThrow('No baseUrl')
    })

    it('does NOT throw "No baseUrl configured" for browser goto when a named base is used', async () => {
      // A spec with no baseUrl but a goto that targets a named base is valid at plan level;
      // assertDefaultUrlIfNeeded should not fire. Any failure is at execution time (e.g.
      // "no browser session"), not the early "No baseUrl configured" message.
      const theSpec = spec('no-default-url', {
        urls: { admin: 'http://admin.example.com' },
        flows: [
          flow('main', {
            steps: [step('open admin', browser('goto', { url: '/dashboard', base: 'admin' }))],
          }),
        ],
      })

      let caughtMessage: string | undefined
      try {
        await runSpec(theSpec)
      } catch (e) {
        caughtMessage = (e as Error).message
      }
      // Either no throw, or a different error (e.g. "no browser session") -- never the early baseUrl check.
      if (caughtMessage !== undefined) {
        expect(caughtMessage).not.toMatch('No baseUrl configured')
      }
    })

    it('throws when a named URL env var is set to an empty string', async () => {
      process.env['EMPTY_PAYMENTS_URL'] = ''
      try {
        const theSpec = spec('empty-named-url', {
          baseUrl: 'http://app.example.com',
          urls: { payments: env('EMPTY_PAYMENTS_URL') },
          apis: {
            charge: { method: 'POST', path: '/api/charge', base: 'payments' },
          },
          flows: [
            flow('main', {
              steps: [step('charge', api('charge', { expect: { status: 201 } }))],
            }),
          ],
        })

        await expect(runSpec(theSpec)).rejects.toThrow(/EMPTY_PAYMENTS_URL.*is set but empty/s)
      } finally {
        delete process.env['EMPTY_PAYMENTS_URL']
      }
    })

    it('throws a descriptive error when browser goto references an unknown base', async () => {
      // A misspelled or missing base on a goto step must throw immediately with a clear
      // error rather than silently falling back to the default URL.
      // Use skipValidation so the structural validator doesn't catch it first -- this
      // simulates the runPlan() path which always skips validation.
      const theSpec = spec('unknown-base-goto', {
        baseUrl: 'http://app.example.com',
        urls: { admin: 'http://admin.example.com' },
        flows: [
          flow('main', {
            steps: [step('open typo', browser('goto', { url: '/dashboard', base: 'admn' as string }))],
          }),
        ],
      })

      await expect(runSpec(theSpec, { skipValidation: true })).rejects.toThrow(/references base "admn" which is not defined/)
    })
  })

  describe('validation', () => {
    it('throws for an invalid spec before running any steps', async () => {
      const theSpec = spec('invalid', {
        flows: [
          flow('main', {
            steps: [
              // ref('missing') was never saved
              step('check', orth_expect(ref('missing'), 'equals', 'value')),
            ],
          }),
        ],
      })

      await expect(runSpec(theSpec, { baseUrl: 'http://localhost' })).rejects.toThrow('validation')
    })

    it('skips validation when skipValidation: true', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/ok': { status: 200, body: { val: 'hello' } },
      })
      server = s

      const theSpec = spec('skip-validate', {
        flows: [
          flow('main', {
            steps: [
              step('fetch', api('GET /api/ok', { save: { val: 'body.val' } })),
              // This ref would fail validation -- but we skip it
              step('check', orth_expect(ref('val'), 'equals', 'hello')),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url, skipValidation: true })
      expect(result.status).toBe('pass')
    })
  })

  describe('ref save and use', () => {
    it('saves and threads a value through multiple steps via ref()', async () => {
      const { server: s, url } = await startTestServer({
        'POST /api/items': { status: 201, body: { id: 'item-99', name: 'Widget' } },
        'GET /api/items/item-99': { status: 200, body: { id: 'item-99', status: 'active' } },
      })
      // Override to use path segments for the dynamic route
      s.removeAllListeners('request')
      s.on('request', (req, res) => {
        if (req.method === 'POST' && req.url === '/api/items') {
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: 'item-99', name: 'Widget' }))
        } else if (req.method === 'GET' && req.url === '/api/items/item-99') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: 'item-99', status: 'active' }))
        } else {
          res.writeHead(404)
          res.end()
        }
      })
      server = s

      const theSpec = spec('ref-threading', {
        flows: [
          flow('main', {
            steps: [
              step('create item', api('POST /api/items', {
                expect: { status: 201 },
                save: { itemId: 'body.id' },
              })),
              step('fetch item', api('GET /api/items/{itemId}', {
                params: { itemId: ref('itemId') },
                expect: { status: 200 },
                save: { itemStatus: 'body.status' },
              })),
              step('assert active', orth_expect(ref('itemStatus'), 'equals', 'active')),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('pass')
      expect(result.passedSteps).toBe(3)
    })
  })

  describe('flow grouping in results', () => {
    it('groups step results into per-flow FlowResult entries', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/a': { status: 200, body: {} },
        'GET /api/b': { status: 200, body: {} },
      })
      server = s

      const theSpec = spec('multi-flow-spec', {
        flows: [
          flow('flow-one', {
            steps: [step('step a', api('GET /api/a', { expect: { status: 200 } }))],
          }),
          flow('flow-two', {
            steps: [step('step b', api('GET /api/b', { expect: { status: 200 } }))],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('pass')
      expect(result.flows).toHaveLength(2)
      expect(result.flows[0]!.name).toBe('flow-one')
      expect(result.flows[0]!.steps).toHaveLength(1)
      expect(result.flows[0]!.steps[0]!.name).toBe('step a')
      expect(result.flows[1]!.name).toBe('flow-two')
      expect(result.flows[1]!.steps).toHaveLength(1)
      expect(result.flows[1]!.steps[0]!.name).toBe('step b')
    })

    it('produces an empty FlowResult for zero-step flows', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/a': { status: 200, body: {} },
      })
      server = s

      const theSpec = spec('zero-step-spec', {
        flows: [
          flow('empty-flow', { steps: [] }),
          flow('real-flow', {
            steps: [step('step a', api('GET /api/a', { expect: { status: 200 } }))],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url, skipValidation: true })
      expect(result.flows).toHaveLength(2)
      expect(result.flows[0]!.name).toBe('empty-flow')
      expect(result.flows[0]!.steps).toHaveLength(0)
      expect(result.flows[1]!.name).toBe('real-flow')
    })
  })

  describe('exists / notExists with missing nested paths', () => {
    it('notExists passes when a saved object lacks the specified field', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/item': { status: 200, body: { id: 'item-1', status: 'active' } },
      })
      server = s

      const theSpec = spec('notexists-test', {
        flows: [
          flow('main', {
            steps: [
              step('fetch item', api('GET /api/item', { save: { item: 'body' } })),
              // item.cancelReason doesn't exist in the response object
              step('no cancel reason', orth_expect(ref('item.cancelReason'), 'notExists')),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('pass')
    })

    it('exists fails when a saved object lacks the specified field', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/item': { status: 200, body: { id: 'item-1' } },
      })
      server = s

      const theSpec = spec('exists-fail-test', {
        flows: [
          flow('main', {
            steps: [
              step('fetch item', api('GET /api/item', { save: { item: 'body' } })),
              step('price must exist', orth_expect(ref('item.price'), 'exists')),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url })
      expect(result.status).toBe('fail')
    })
  })

  describe('timeoutMs', () => {
    it('aborts a slow API call when timeoutMs is exceeded', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/slow': { status: 200, body: {}, delay: 2000 },
      })
      server = s

      const theSpec = spec('timeout-test', {
        flows: [
          flow('main', {
            steps: [
              step('slow call', api('GET /api/slow', { expect: { status: 200 } })),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec, { baseUrl: url, timeoutMs: 100 })
      expect(result.status).toBe('fail')
      const stepResult = result.flows[0]!.steps[0]!
      expect(stepResult.status).toBe('fail')
      expect(stepResult.error).toMatch(/abort|timeout|network/i)
    })
  })
})

// ---------------------------------------------------------------------------
// runPlan -- executes a pre-compiled ExecutionPlan
// ---------------------------------------------------------------------------

describe('runPlan', () => {
  let server: Server | null = null

  afterEach(() => {
    server?.close()
    server = null
  })

  it('executes a pre-compiled plan and returns pass', async () => {
    const { server: s, url } = await startTestServer({
      'GET /api/health': { status: 200, body: { status: 'ok' } },
    })
    server = s

    const theSpec = spec('health-plan', {
      baseUrl: url,
      flows: [
        flow('main', {
          steps: [step('check health', api('GET /api/health', { expect: { status: 200 } }))],
        }),
      ],
    })

    const plan = compile(theSpec)
    const result = await runPlan(plan)

    expect(result.status).toBe('pass')
    expect(result.specName).toBe('health-plan')
    expect(result.passedSteps).toBe(1)
    expect(result.flows).toHaveLength(1)
    expect(result.flows[0]!.name).toBe('main')
  })

  it('returns fail when a step fails', async () => {
    const { server: s, url } = await startTestServer({
      'GET /api/health': { status: 500, body: {} },
    })
    server = s

    const theSpec = spec('fail-plan', {
      baseUrl: url,
      flows: [
        flow('main', {
          steps: [step('check', api('GET /api/health', { expect: { status: 200 } }))],
        }),
      ],
    })

    const result = await runPlan(compile(theSpec))
    expect(result.status).toBe('fail')
    expect(result.failedSteps).toBe(1)
  })

  it('resolves baseUrl from env() marker in the plan', async () => {
    const { server: s, url } = await startTestServer({
      'GET /ping': { status: 200, body: {} },
    })
    server = s

    process.env['PLAN_TEST_URL'] = url
    try {
      const theSpec = spec('env-url-plan', {
        baseUrl: env('PLAN_TEST_URL'),
        flows: [
          flow('main', {
            steps: [step('ping', api('GET /ping', { expect: { status: 200 } }))],
          }),
        ],
      })

      const result = await runPlan(compile(theSpec))
      expect(result.status).toBe('pass')
    } finally {
      delete process.env['PLAN_TEST_URL']
    }
  })

  it('throws with a clear message when env() base URL is not set', async () => {
    delete process.env['MISSING_ENV_VAR']

    const theSpec = spec('missing-env-plan', {
      baseUrl: env('MISSING_ENV_VAR'),
      flows: [
        flow('main', {
          steps: [step('ping', api('GET /ping', {}))],
        }),
      ],
    })

    await expect(runPlan(compile(theSpec))).rejects.toThrow('MISSING_ENV_VAR')
  })

  it('saves and threads values across steps', async () => {
    const { server: s, url } = await startTestServer({
      'GET /api/data': { status: 200, body: { value: 'hello' } },
    })
    server = s

    const theSpec = spec('ref-plan', {
      baseUrl: url,
      flows: [
        flow('main', {
          steps: [
            step('fetch', api('GET /api/data', { save: { val: 'body.value' } })),
            step('assert', orth_expect(ref('val'), 'equals', 'hello')),
          ],
        }),
      ],
    })

    const result = await runPlan(compile(theSpec))
    expect(result.status).toBe('pass')
    expect(result.passedSteps).toBe(2)
  })

  it('accepts a plan with inline data catalog', async () => {
    const { server: s, url } = await startTestServer({
      'GET /api/echo': { status: 200, body: {} },
    })
    server = s

    const theSpec = spec('data-plan', {
      baseUrl: url,
      data: { item: { sku: 'sku-001' } },
      flows: [
        flow('main', {
          steps: [step('fetch', api('GET /api/echo', { expect: { status: 200 } }))],
        }),
      ],
    })

    const plan = compile(theSpec)
    const result = await runPlan(plan)
    expect(result.status).toBe('pass')
  })

  it('routes steps to named URLs from the urls map', async () => {
    // Two separate servers simulating 'app' and 'payments' services
    const { server: appServer, url: appUrl } = await startTestServer({
      'GET /api/health': { status: 200, body: { ok: true } },
    })
    const { server: paymentsServer, url: paymentsUrl } = await startTestServer({
      'POST /api/charge': { status: 201, body: { charged: true } },
    })
    server = appServer
    const servers = [appServer, paymentsServer]

    try {
      const theSpec = spec('multi-url', {
        baseUrl: appUrl,
        urls: { payments: paymentsUrl },
        apis: {
          health: { method: 'GET', path: '/api/health' },
          charge: { method: 'POST', path: '/api/charge', base: 'payments' },
        },
        flows: [
          flow('main', {
            steps: [
              step('health check', api('health', { expect: { status: 200 } })),
              step('charge', api('charge', { expect: { status: 201 } })),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec)
      expect(result.status).toBe('pass')
      expect(result.passedSteps).toBe(2)
    } finally {
      servers.forEach(s => s.close())
      server = null
    }
  })

  it('allows step-level base to override contract-level base at runtime', async () => {
    const { server: s1, url: url1 } = await startTestServer({
      'POST /api/charge': { status: 201, body: { charged: true } },
    })
    const { server: s2, url: url2 } = await startTestServer({
      'POST /api/charge': { status: 200, body: { charged: true } },
    })
    server = s1
    const servers = [s1, s2]

    try {
      const theSpec = spec('override-base', {
        baseUrl: 'http://unused.example.com',
        urls: { a: url1, b: url2 },
        apis: {
          charge: { method: 'POST', path: '/api/charge', base: 'a' },
        },
        flows: [
          flow('main', {
            steps: [
              // Override contract base 'a' with 'b' at call site
              step('charge via b', api('charge', { base: 'b', expect: { status: 200 } })),
            ],
          }),
        ],
      })

      const result = await runSpec(theSpec)
      expect(result.status).toBe('pass')
    } finally {
      servers.forEach(s => s.close())
      server = null
    }
  })

  it('accepts a plain ExecutionPlan object without going through compile()', async () => {
    const { server: s, url } = await startTestServer({
      'GET /api/raw': { status: 200, body: { ok: true } },
    })
    server = s

    // Simulate a plan fetched from a remote server as raw JSON
    const rawPlan: ExecutionPlan = {
      specName: 'raw-plan',
      baseUrl: url,
      urls: { default: url },
      apis: {},
      data: {},
      steps: [
        {
          name: 'check raw',
          action: { __type: 'api', method: 'GET', path: '/api/raw', options: { expect: { status: 200 } } },
          retries: 0,
          saves: {},
          expects: [],
          inlineExpect: { status: 200 },
        },
      ],
      flowRanges: [{ name: 'main', startIndex: 0, stepCount: 1 }],
    }

    const result = await runPlan(rawPlan)
    expect(result.status).toBe('pass')
    expect(result.specName).toBe('raw-plan')
  })
})
