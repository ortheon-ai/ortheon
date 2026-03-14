import { describe, it, expect } from 'vitest'
import { compile, formatExpandedPlan } from '../src/compiler.js'
import { spec, flow, step, api, browser, expect as orth_expect, use, ref, section } from '../src/dsl.js'

describe('compile', () => {
  describe('contract resolution', () => {
    it('resolves a named API contract to method + path', () => {
      const s = spec('test', {
        apis: {
          getHealth: { method: 'GET', path: '/api/health' },
        },
        flows: [
          flow('main', {
            steps: [
              step('check health', api('getHealth', { expect: { status: 200 } })),
            ],
          }),
        ],
      })

      const plan = compile(s)
      expect(plan.steps).toHaveLength(1)
      const action = plan.steps[0]!.action
      expect(action.__type).toBe('api')
      if (action.__type === 'api') {
        expect(action.method).toBe('GET')
        expect(action.path).toBe('/api/health')
      }
    })

    it('accepts inline "METHOD /path" format without contracts', () => {
      const s = spec('test', {
        flows: [
          flow('main', {
            steps: [
              step('list products', api('GET /api/products', {})),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const action = plan.steps[0]!.action
      expect(action.__type).toBe('api')
      if (action.__type === 'api') {
        expect(action.method).toBe('GET')
        expect(action.path).toBe('/api/products')
      }
    })

    it('throws for unknown contract name', () => {
      const s = spec('test', {
        flows: [
          flow('main', {
            steps: [
              step('do thing', api('nonExistentContract', {})),
            ],
          }),
        ],
      })
      expect(() => compile(s)).toThrow('nonExistentContract')
    })
  })

  describe('use() expansion', () => {
    it('inlines a referenced flow\'s steps with caller-prefixed names', () => {
      const authFlow = flow('login', {
        inputs: { email: 'string', password: 'secret' },
        steps: [
          step('goto login', browser('goto', { url: '/login' })),
          step('fill email', browser('type', { target: '[name=email]', value: ref('email') })),
        ],
      })

      const s = spec('test', {
        flows: [
          authFlow,
          flow('checkout', {
            steps: [
              step('do login', use('login', { email: 'buyer@example.com', password: 'pass' })),
              step('create order', api('POST /api/orders', {})),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const stepNames = plan.steps.map(s => s.name)
      // Expanded steps are prefixed with caller step name
      expect(stepNames).toContain('do login > goto login')
      expect(stepNames).toContain('do login > fill email')
      expect(stepNames).toContain('create order')
    })

    it('produces distinct step names when the same flow is used twice', () => {
      const loginFlow = flow('login', {
        inputs: { email: 'string', password: 'secret' },
        steps: [
          step('fill email', browser('type', { target: '[name=email]', value: ref('email') })),
          step('submit', browser('click', { target: '[type=submit]' })),
        ],
      })

      const s = spec('test', {
        library: [loginFlow],
        flows: [
          flow('multi-user-flow', {
            steps: [
              step('login as buyer', use('login', { email: 'buyer@example.com', password: 'pass1' })),
              step('login as admin', use('login', { email: 'admin@example.com', password: 'pass2' })),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const stepNames = plan.steps.map(s => s.name)
      expect(stepNames).toContain('login as buyer > fill email')
      expect(stepNames).toContain('login as buyer > submit')
      expect(stepNames).toContain('login as admin > fill email')
      expect(stepNames).toContain('login as admin > submit')
      // All four names must be distinct
      expect(new Set(stepNames).size).toBe(stepNames.length)
    })

    it('carries flowOrigin metadata on expanded steps', () => {
      const loginFlow = flow('login', {
        steps: [step('goto login', browser('goto', { url: '/login' }))],
      })
      const s = spec('test', {
        library: [loginFlow],
        flows: [
          flow('main', {
            steps: [step('do login', use('login'))],
          }),
        ],
      })
      const plan = compile(s)
      const expanded = plan.steps.find(s => s.name === 'do login > goto login')
      expect(expanded).toBeDefined()
      expect(expanded?.flowOrigin).toBe('login')
    })

    it('throws when use() references a nonexistent flow', () => {
      const s = spec('test', {
        flows: [
          flow('main', {
            steps: [
              step('run missing', use('nonExistentFlow')),
            ],
          }),
        ],
      })
      expect(() => compile(s)).toThrow('nonExistentFlow')
    })
  })

  describe('section flattening', () => {
    it('flattens sections into steps with section metadata', () => {
      const s = spec('test', {
        flows: [
          flow('main', {
            steps: [
              section('auth', [
                step('goto login', browser('goto', { url: '/login' })),
              ]),
              section('purchase', [
                step('create order', api('POST /api/orders', {})),
              ]),
            ],
          }),
        ],
      })

      const plan = compile(s)
      expect(plan.steps).toHaveLength(2)
      expect(plan.steps[0]!.section).toBe('auth')
      expect(plan.steps[1]!.section).toBe('purchase')
      expect(plan.steps[0]!.name).toBe('goto login')
      expect(plan.steps[1]!.name).toBe('create order')
    })
  })

  describe('save resolution', () => {
    it('populates saves from api step options', () => {
      const s = spec('test', {
        flows: [
          flow('main', {
            steps: [
              step('create order', api('POST /api/orders', {
                save: { orderId: 'body.id', order: 'body' },
              })),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const step0 = plan.steps[0]!
      expect(step0.saves).toEqual({ orderId: 'body.id', order: 'body' })
    })
  })

  describe('expect steps', () => {
    it('populates expects for expect() steps', () => {
      const s = spec('test', {
        flows: [
          flow('main', {
            steps: [
              step('status check', orth_expect(ref('order.status'), 'equals', 'confirmed')),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const step0 = plan.steps[0]!
      expect(step0.expects).toHaveLength(1)
      expect(step0.expects[0]!.matcher).toBe('equals')
      expect(step0.expects[0]!.expected).toBe('confirmed')
    })
  })
})

describe('formatExpandedPlan', () => {
  it('produces readable text output', () => {
    const s = spec('health check', {
      apis: { health: { method: 'GET', path: '/api/health' } },
      flows: [
        flow('main', {
          steps: [
            step('check health', api('health', { expect: { status: 200 }, save: { status: 'body.status' } })),
          ],
        }),
      ],
    })

    const plan = compile(s)
    const output = formatExpandedPlan(plan)
    expect(output).toContain('SPEC: health check')
    expect(output).toContain('check health')
    expect(output).toContain('GET /api/health')
  })
})
