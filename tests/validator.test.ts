import { describe, it, expect } from 'vitest'
import { validateStructure, validateExpandedPlan } from '../src/validator.js'
import { compile } from '../src/compiler.js'
import { spec, flow, step, api, browser, expect as orth_expect, use, ref, section } from '../src/dsl.js'
import type { ExecutionPlan } from '../src/types.js'

describe('validateStructure (pass 1)', () => {
  describe('name uniqueness', () => {
    it('passes for unique flow names', () => {
      const s = spec('test', {
        flows: [
          flow('flow-a', { steps: [step('step 1', api('GET /health', {}))] }),
          flow('flow-b', { steps: [step('step 1', api('GET /health', {}))] }),
        ],
      })
      const result = validateStructure(s)
      expect(result.errors).toHaveLength(0)
    })

    it('reports duplicate flow names', () => {
      const s = spec('test', {
        flows: [
          flow('checkout', { steps: [step('step 1', api('GET /health', {}))] }),
          flow('checkout', { steps: [step('step 2', api('GET /health', {}))] }),
        ],
      })
      const result = validateStructure(s)
      const dupError = result.errors.find(e => e.message.includes('Duplicate flow name'))
      expect(dupError).toBeDefined()
    })

    it('reports duplicate step names within a flow', () => {
      const s = spec('test', {
        flows: [
          flow('main', {
            steps: [
              step('same name', api('GET /health', {})),
              step('same name', api('GET /health', {})),
            ],
          }),
        ],
      })
      const result = validateStructure(s)
      const dupError = result.errors.find(e => e.message.includes('Duplicate step name'))
      expect(dupError).toBeDefined()
    })
  })

  describe('browser action validation', () => {
    it('passes for valid browser actions', () => {
      const s = spec('test', {
        flows: [
          flow('main', {
            steps: [
              step('goto', browser('goto', { url: '/login' })),
              step('click', browser('click', { target: '[data-testid=submit]' })),
            ],
          }),
        ],
      })
      const result = validateStructure(s)
      expect(result.errors).toHaveLength(0)
    })
  })

  describe('api target validation', () => {
    it('passes for named contracts', () => {
      const s = spec('test', {
        apis: { getHealth: { method: 'GET', path: '/api/health' } },
        flows: [
          flow('main', { steps: [step('check', api('getHealth', {}))] }),
        ],
      })
      expect(validateStructure(s).errors).toHaveLength(0)
    })

    it('passes for "METHOD /path" format', () => {
      const s = spec('test', {
        flows: [
          flow('main', { steps: [step('check', api('GET /api/health', {}))] }),
        ],
      })
      expect(validateStructure(s).errors).toHaveLength(0)
    })

    it('reports unknown named target', () => {
      const s = spec('test', {
        flows: [
          flow('main', { steps: [step('check', api('unknownContract', {}))] }),
        ],
      })
      const result = validateStructure(s)
      expect(result.errors.some(e => e.message.includes('unknownContract'))).toBe(true)
    })
  })

  describe('expect matcher arity', () => {
    it('passes for equals with expected value', () => {
      const s = spec('test', {
        flows: [
          flow('main', { steps: [step('check', orth_expect(ref('val'), 'equals', 'ok'))] }),
        ],
      })
      expect(validateStructure(s).errors).toHaveLength(0)
    })

    it('reports equals without expected value', () => {
      const s = spec('test', {
        flows: [
          flow('main', { steps: [step('check', { __type: 'expect', value: ref('val'), matcher: 'equals' as const })] }),
        ],
      })
      const result = validateStructure(s)
      expect(result.errors.some(e => e.message.includes('requires an expected value'))).toBe(true)
    })

    it('passes for exists without expected value', () => {
      const s = spec('test', {
        flows: [
          flow('main', { steps: [step('check', orth_expect(ref('val'), 'exists'))] }),
        ],
      })
      expect(validateStructure(s).errors).toHaveLength(0)
    })
  })

  describe('use() validation', () => {
    it('passes when use() references an existing flow', () => {
      const s = spec('test', {
        flows: [
          flow('login', { inputs: { email: 'string' }, steps: [step('goto', browser('goto', { url: '/login' }))] }),
          flow('main', { steps: [step('do login', use('login', { email: 'a@b.com' }))] }),
        ],
      })
      expect(validateStructure(s).errors).toHaveLength(0)
    })

    it('reports when use() references a nonexistent flow', () => {
      const s = spec('test', {
        flows: [
          flow('main', { steps: [step('do login', use('nonexistent'))] }),
        ],
      })
      const result = validateStructure(s)
      expect(result.errors.some(e => e.message.includes('nonexistent'))).toBe(true)
    })

    it('reports a missing required input declared by the referenced flow', () => {
      const s = spec('test', {
        flows: [
          flow('login', {
            inputs: { email: 'string', password: 'secret' },
            steps: [step('goto', browser('goto', { url: '/login' }))],
          }),
          flow('main', {
            // password input is missing
            steps: [step('do login', use('login', { email: 'a@b.com' }))],
          }),
        ],
      })
      const result = validateStructure(s)
      expect(result.errors.some(e =>
        e.message.includes('password') && e.message.includes('missing required input')
      )).toBe(true)
    })

    it('warns when use() provides an input not declared by the referenced flow', () => {
      const s = spec('test', {
        flows: [
          flow('login', {
            inputs: { email: 'string' },
            steps: [step('goto', browser('goto', { url: '/login' }))],
          }),
          flow('main', {
            steps: [step('do login', use('login', { email: 'a@b.com', extra: 'surprise' }))],
          }),
        ],
      })
      const result = validateStructure(s)
      expect(result.errors).toHaveLength(0)
      expect(result.warnings.some(w =>
        w.message.includes('extra') && w.message.includes('undeclared input')
      )).toBe(true)
    })

    it('passes when a flow has no declared inputs and use() provides none', () => {
      const s = spec('test', {
        flows: [
          flow('setup', { steps: [step('goto', browser('goto', { url: '/setup' }))] }),
          flow('main', { steps: [step('run setup', use('setup'))] }),
        ],
      })
      expect(validateStructure(s).errors).toHaveLength(0)
    })
  })

  describe('save path validation', () => {
    it('passes for "body", "status", "body.<field>", and "headers.<name>" save paths', () => {
      const s = spec('test', {
        flows: [
          flow('main', {
            steps: [
              step('fetch', api('GET /api/resource', {
                save: {
                  full: 'body',
                  statusCode: 'status',
                  id: 'body.id',
                  requestId: 'headers.x-request-id',
                },
              })),
            ],
          }),
        ],
      })
      const result = validateStructure(s)
      expect(result.warnings.filter(w => w.message.includes('Save path'))).toHaveLength(0)
    })

    it('warns for unrecognised save path expressions', () => {
      const s = spec('test', {
        flows: [
          flow('main', {
            steps: [
              step('fetch', api('GET /api/resource', {
                save: { val: 'something.weird' },
              })),
            ],
          }),
        ],
      })
      const result = validateStructure(s)
      expect(result.warnings.some(w => w.message.includes('something.weird'))).toBe(true)
    })
  })
})

describe('validateExpandedPlan (pass 2)', () => {
  describe('ref resolution', () => {
    it('passes when ref is saved before use', () => {
      const s = spec('test', {
        flows: [
          flow('main', {
            steps: [
              step('create', api('POST /api/orders', { save: { orderId: 'body.id' } })),
              step('fetch', api('GET /api/orders/{orderId}', {
                params: { orderId: ref('orderId') },
              })),
            ],
          }),
        ],
      })
      const plan = compile(s)
      const result = validateExpandedPlan(plan)
      expect(result.errors).toHaveLength(0)
    })

    it('reports when ref is used before save', () => {
      // Manually construct a plan that references a name not yet saved
      const badPlan: ExecutionPlan = {
        specName: 'test',
        baseUrl: 'http://localhost',
        urls: { default: 'http://localhost' },
        apis: {},
        data: {},
        steps: [
          {
            name: 'use before save',
            action: {
              __type: 'api',
              method: 'GET',
              path: '/api/orders/{orderId}',
              options: { params: { orderId: { __type: 'ref', path: 'orderId' } as unknown as string } },
            },
            retries: 0,
            saves: {},
            expects: [],
          },
        ],
        flowRanges: [],
      }
      const result = validateExpandedPlan(badPlan)
      expect(result.errors.some(e => e.message.includes('orderId'))).toBe(true)
    })
  })

  describe('path param completeness', () => {
    it('reports when path param has no matching params entry', () => {
      const badPlan: ExecutionPlan = {
        specName: 'test',
        baseUrl: 'http://localhost',
        urls: { default: 'http://localhost' },
        apis: {},
        data: {},
        steps: [
          {
            name: 'fetch order',
            action: {
              __type: 'api',
              method: 'GET',
              path: '/api/orders/{orderId}',
              options: {}, // no params.orderId
            },
            retries: 0,
            saves: {},
            expects: [],
          },
        ],
        flowRanges: [],
      }
      const result = validateExpandedPlan(badPlan)
      expect(result.errors.some(e => e.message.includes('orderId'))).toBe(true)
    })
  })
})

describe('named URLs (multi-URL validation)', () => {
  describe('validateStructure', () => {
    it('passes when api step base matches a declared url key', () => {
      const s = spec('test', {
        baseUrl: 'http://app.example.com',
        urls: { payments: 'http://payments.example.com' },
        apis: { charge: { method: 'POST', path: '/api/charge' } },
        flows: [
          flow('main', { steps: [step('charge', api('charge', { base: 'payments' }))] }),
        ],
      })
      expect(validateStructure(s).errors).toHaveLength(0)
    })

    it('reports error when api step base is not in urls map', () => {
      const s = spec('test', {
        baseUrl: 'http://app.example.com',
        apis: { charge: { method: 'POST', path: '/api/charge' } },
        flows: [
          flow('main', { steps: [step('charge', api('charge', { base: 'payments' }))] }),
        ],
      })
      const result = validateStructure(s)
      expect(result.errors.some(e => e.message.includes('"payments"'))).toBe(true)
    })

    it('reports error when contract base is not in urls map', () => {
      const s = spec('test', {
        baseUrl: 'http://app.example.com',
        apis: { charge: { method: 'POST', path: '/api/charge', base: 'payments' } },
        flows: [
          flow('main', { steps: [step('charge', api('charge', {}))] }),
        ],
      })
      const result = validateStructure(s)
      expect(result.errors.some(e => e.message.includes('"payments"') && e.message.includes('Contract'))).toBe(true)
    })

    it('passes for browser goto with valid base', () => {
      const s = spec('test', {
        baseUrl: 'http://app.example.com',
        urls: { admin: 'http://admin.example.com' },
        flows: [
          flow('main', { steps: [step('open admin', browser('goto', { url: '/dashboard', base: 'admin' }))] }),
        ],
      })
      expect(validateStructure(s).errors).toHaveLength(0)
    })

    it('reports error when browser goto base is not in urls map', () => {
      const s = spec('test', {
        baseUrl: 'http://app.example.com',
        flows: [
          flow('main', { steps: [step('open admin', browser('goto', { url: '/dashboard', base: 'admin' }))] }),
        ],
      })
      const result = validateStructure(s)
      expect(result.errors.some(e => e.message.includes('"admin"'))).toBe(true)
    })

    it('accepts "default" as a valid base without explicit urls declaration', () => {
      const s = spec('test', {
        baseUrl: 'http://app.example.com',
        apis: { health: { method: 'GET', path: '/api/health' } },
        flows: [
          flow('main', { steps: [step('check', api('health', { base: 'default' }))] }),
        ],
      })
      expect(validateStructure(s).errors).toHaveLength(0)
    })
  })
})
