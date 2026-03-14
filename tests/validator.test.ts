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
      }
      const result = validateExpandedPlan(badPlan)
      expect(result.errors.some(e => e.message.includes('orderId'))).toBe(true)
    })
  })
})
