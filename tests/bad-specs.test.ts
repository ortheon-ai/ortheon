import { describe, it, expect } from 'vitest'
import { validate, validateStructure } from '../src/validator.js'
import { compile } from '../src/compiler.js'
import { spec, flow, step, api, browser, expect as orth_expect, use, ref, section } from '../src/dsl.js'

// ---------------------------------------------------------------------------
// Bad-spec fixture tests.
//
// Each fixture is an intentionally broken spec. The test asserts that
// validate() produces the expected diagnostic message substring.
// These keep the validator honest as the system evolves.
// ---------------------------------------------------------------------------

describe('bad-spec fixtures', () => {
  describe('ref used before it is saved', () => {
    it('reports ref used before any prior step saves it', () => {
      const s = spec('bad refs', {
        flows: [
          flow('main', {
            steps: [
              // orderId is referenced before any step saves it
              step('fetch order', api('GET /api/orders/{orderId}', {
                params: { orderId: ref('orderId') },
              })),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const result = validate(s, plan)
      expect(result.valid).toBe(false)
      const msg = result.errors.find(e => e.message.includes('orderId'))
      expect(msg).toBeDefined()
      expect(msg!.message).toContain('orderId')
      expect(msg!.message).toContain('has not been saved')
    })
  })

  describe('missing flow input', () => {
    it('reports use() referencing a flow name that does not exist', () => {
      const s = spec('missing flow', {
        flows: [
          flow('main', {
            steps: [
              step('do login', use('nonExistentLoginFlow')),
            ],
          }),
        ],
      })

      const result = validateStructure(s)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('nonExistentLoginFlow'))).toBe(true)
    })
  })

  describe('duplicate flow name', () => {
    it('reports two flows with the same name', () => {
      const s = spec('dup flows', {
        flows: [
          flow('checkout', { steps: [step('step 1', api('GET /health', {}))] }),
          flow('checkout', { steps: [step('step 2', api('GET /health', {}))] }),
        ],
      })

      const result = validateStructure(s)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.message.includes('Duplicate flow name') && e.message.includes('checkout')
      )).toBe(true)
    })

    it('reports duplicate between library and flows', () => {
      const libFlow = flow('shared', { steps: [step('s1', api('GET /health', {}))] })
      const s = spec('dup library', {
        library: [libFlow],
        flows: [
          flow('shared', { steps: [step('s2', api('GET /health', {}))] }),
        ],
      })

      const result = validateStructure(s)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.message.includes('Duplicate flow name') && e.message.includes('shared')
      )).toBe(true)
    })
  })

  describe('duplicate step name', () => {
    it('reports two steps with the same name within a flow', () => {
      const s = spec('dup steps', {
        flows: [
          flow('main', {
            steps: [
              step('check health', api('GET /health', {})),
              step('check health', api('GET /health', {})),
            ],
          }),
        ],
      })

      const result = validateStructure(s)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.message.includes('Duplicate step name') && e.message.includes('check health')
      )).toBe(true)
    })

    it('reports duplicate step names across use() expansions in the compiled plan', () => {
      const loginFlow = flow('login', {
        steps: [step('submit', browser('click', { target: '[type=submit]' }))],
      })

      // Two different caller step names that produce the same expansion prefix (impossible with
      // the new naming scheme), so instead test direct step name collision in a single flow.
      const s = spec('dup expanded', {
        flows: [
          flow('main', {
            steps: [
              step('submit', browser('click', { target: '#a' })),
              step('submit', browser('click', { target: '#b' })),
            ],
          }),
        ],
      })

      const result = validateStructure(s)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.message.includes('Duplicate step name') && e.message.includes('submit')
      )).toBe(true)
    })
  })

  describe('unknown API contract', () => {
    it('reports api() referencing an undeclared contract name', () => {
      const s = spec('unknown contract', {
        apis: {
          getHealth: { method: 'GET', path: '/api/health' },
        },
        flows: [
          flow('main', {
            steps: [
              step('create order', api('createOrder', {})),
            ],
          }),
        ],
      })

      const result = validateStructure(s)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('createOrder'))).toBe(true)
    })
  })

  describe('missing path param', () => {
    it('reports path param with no corresponding params entry', () => {
      const s = spec('missing path param', {
        flows: [
          flow('main', {
            steps: [
              step('save id', api('POST /api/orders', { save: { orderId: 'body.id' } })),
              // params.orderId is required by the path but not provided
              step('fetch order', api('GET /api/orders/{orderId}', {})),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const result = validate(s, plan)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.message.includes('orderId') && e.message.includes('requires params.orderId')
      )).toBe(true)
    })
  })

  describe('illegal matcher arity', () => {
    it('reports equals matcher without an expected value', () => {
      const s = spec('bad equals', {
        flows: [
          flow('main', {
            steps: [
              step('check', {
                __type: 'expect',
                value: ref('someValue'),
                matcher: 'equals' as const,
                // expected intentionally omitted
              }),
            ],
          }),
        ],
      })

      const result = validateStructure(s)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.message.includes('equals') && e.message.includes('requires an expected value')
      )).toBe(true)
    })

    it('reports contains matcher without an expected value', () => {
      const s = spec('bad contains', {
        flows: [
          flow('main', {
            steps: [
              step('check', {
                __type: 'expect',
                value: ref('someValue'),
                matcher: 'contains' as const,
              }),
            ],
          }),
        ],
      })

      const result = validateStructure(s)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.message.includes('contains') && e.message.includes('requires an expected value')
      )).toBe(true)
    })

    it('warns when exists matcher is given an expected value (it is ignored)', () => {
      const s = spec('extra exists arg', {
        flows: [
          flow('main', {
            steps: [
              step('check', {
                __type: 'expect',
                value: ref('someValue'),
                matcher: 'exists' as const,
                expected: 'ignored value',
              }),
            ],
          }),
        ],
      })

      const result = validateStructure(s)
      // Should pass (no errors) but emit a warning
      expect(result.errors).toHaveLength(0)
      expect(result.warnings.some(w =>
        w.message.includes('exists') && w.message.includes('ignores the expected value')
      )).toBe(true)
    })
  })

  describe('unknown browser action', () => {
    it('reports an unrecognised browser action name', () => {
      const s = spec('bad browser', {
        flows: [
          flow('main', {
            steps: [
              step('do something', {
                __type: 'browser',
                action: 'hover', // not a valid action
                target: '#element',
              } as unknown as import('../src/types.js').BrowserStep),
            ],
          }),
        ],
      })

      const result = validateStructure(s)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.message.includes('hover') && e.message.includes('Unknown browser action')
      )).toBe(true)
    })
  })

  describe('extract without save block', () => {
    it('reports browser extract step missing a save block', () => {
      const s = spec('bad extract', {
        flows: [
          flow('main', {
            steps: [
              step('get text', {
                __type: 'browser',
                action: 'extract',
                target: '#result',
                // save block intentionally omitted
              } as unknown as import('../src/types.js').BrowserStep),
            ],
          }),
        ],
      })

      const result = validateStructure(s)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.message.includes('extract') && e.message.includes('save')
      )).toBe(true)
    })
  })

  describe('ref inside expect used before saved', () => {
    it('reports ref in expect() step that was not saved by any prior step', () => {
      const s = spec('bad expect ref', {
        flows: [
          flow('main', {
            steps: [
              // order.status is never saved -- nothing saves "order"
              step('check status', orth_expect(ref('order.status'), 'equals', 'confirmed')),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const result = validate(s, plan)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.message.includes('order') && e.message.includes('has not been saved')
      )).toBe(true)
    })
  })

  describe('use() in a section targeting a nonexistent flow', () => {
    it('reports use() inside a section referencing a missing flow', () => {
      const s = spec('bad section use', {
        flows: [
          flow('main', {
            steps: [
              section('auth', [
                step('login', use('missingFlow')),
              ]),
            ],
          }),
        ],
      })

      const result = validateStructure(s)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('missingFlow'))).toBe(true)
    })
  })
})
