import { describe, it, expect } from 'vitest'
import { compile, formatExpandedPlan } from '../../src/compiler.js'
import { spec, flow, step, api, browser, use, ref, section } from '../../src/dsl.js'

// ---------------------------------------------------------------------------
// Golden tests for expanded plan output.
//
// These snapshot the formatted text of compiled plans to prove that
// use() expansion, section flattening, contract resolution, and input
// substitution all produce the correct fully-inlined, inspectable plan.
// ---------------------------------------------------------------------------

describe('expanded plan golden tests', () => {
  describe('contract resolution', () => {
    it('resolves named API contracts to method + path', () => {
      const s = spec('order api', {
        baseUrl: 'http://localhost:3737',
        apis: {
          createOrder: { method: 'POST', path: '/api/orders' },
          getOrder:    { method: 'GET',  path: '/api/orders/{orderId}' },
        },
        flows: [
          flow('place and fetch', {
            steps: [
              step('create order', api('createOrder', { save: { orderId: 'body.id' } })),
              step('fetch order',  api('getOrder',    { params: { orderId: ref('orderId') } })),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const output = formatExpandedPlan(plan)

      expect(output).toMatchInlineSnapshot(`
        "SPEC: order api
        BASE URL: http://localhost:3737

        STEPS (2 total):
            1. create order (flow: place and fetch)
               action: POST /api/orders
               save:   {"orderId":"body.id"}
            2. fetch order (flow: place and fetch)
               action: GET /api/orders/{orderId}"
      `)
    })

    it('accepts inline METHOD /path format without contracts', () => {
      const s = spec('inline api', {
        flows: [
          flow('main', {
            steps: [
              step('health check', api('GET /api/health', { expect: { status: 200 } })),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const output = formatExpandedPlan(plan)

      expect(output).toMatchInlineSnapshot(`
        "SPEC: inline api

        STEPS (1 total):
            1. health check (flow: main)
               action: GET /api/health
               expect: {"status":200}"
      `)
    })
  })

  describe('section flattening', () => {
    it('flattens sections into steps retaining section labels', () => {
      const s = spec('sectioned spec', {
        flows: [
          flow('checkout', {
            steps: [
              section('setup', [
                step('open page', browser('goto', { url: '/checkout' })),
              ]),
              section('purchase', [
                step('submit order', api('POST /api/orders', {})),
                step('check status', api('GET /api/orders/1', { expect: { status: 200 } })),
              ]),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const output = formatExpandedPlan(plan)

      expect(output).toMatchInlineSnapshot(`
        "SPEC: sectioned spec

        STEPS (3 total):
            1. [setup] open page (flow: checkout)
               action: browser(goto, "/checkout")
            2. [purchase] submit order (flow: checkout)
               action: POST /api/orders
            3. [purchase] check status (flow: checkout)
               action: GET /api/orders/1
               expect: {"status":200}"
      `)
    })
  })

  describe('use() expansion', () => {
    it('inlines a library flow with caller-prefixed step names', () => {
      const loginFlow = flow('login', {
        inputs: { email: 'string', password: 'secret' },
        steps: [
          step('open login page', browser('goto', { url: '/login' })),
          step('fill email',      browser('type', { target: '[name=email]', value: ref('email') })),
          step('submit',          browser('click', { target: '[type=submit]' })),
        ],
      })

      const s = spec('use expansion', {
        library: [loginFlow],
        flows: [
          flow('main', {
            steps: [
              step('log in as buyer', use('login', { email: 'buyer@example.com', password: 'pass' })),
              step('create order',    api('POST /api/orders', {})),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const output = formatExpandedPlan(plan)

      expect(output).toMatchInlineSnapshot(`
        "SPEC: use expansion

        STEPS (4 total):
            1. log in as buyer > open login page (flow: login)
               action: browser(goto, "/login")
            2. log in as buyer > fill email (flow: login)
               action: browser(type, "[name=email]")
            3. log in as buyer > submit (flow: login)
               action: browser(click, "[type=submit]")
            4. create order (flow: main)
               action: POST /api/orders"
      `)
    })

    it('produces distinct step names for double use() of same flow', () => {
      const loginFlow = flow('login', {
        inputs: { email: 'string', password: 'secret' },
        steps: [
          step('fill email', browser('type', { target: '[name=email]', value: ref('email') })),
          step('submit',     browser('click', { target: '[type=submit]' })),
        ],
      })

      const s = spec('double use', {
        library: [loginFlow],
        flows: [
          flow('multi-user', {
            steps: [
              step('login as buyer', use('login', { email: 'buyer@example.com', password: 'pass1' })),
              step('login as admin', use('login', { email: 'admin@example.com', password: 'pass2' })),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const output = formatExpandedPlan(plan)

      expect(output).toMatchInlineSnapshot(`
        "SPEC: double use

        STEPS (4 total):
            1. login as buyer > fill email (flow: login)
               action: browser(type, "[name=email]")
            2. login as buyer > submit (flow: login)
               action: browser(click, "[type=submit]")
            3. login as admin > fill email (flow: login)
               action: browser(type, "[name=email]")
            4. login as admin > submit (flow: login)
               action: browser(click, "[type=submit]")"
      `)
    })
  })

  describe('input substitution', () => {
    it('substitutes ref() inputs at compile time in expanded steps', () => {
      const submitFlow = flow('submit-form', {
        inputs: { formUrl: 'string', buttonLabel: 'string' },
        steps: [
          step('go to form', browser('goto', { url: ref('formUrl') })),
          step('click button', browser('click', { target: ref('buttonLabel') })),
        ],
      })

      const s = spec('input substitution', {
        library: [submitFlow],
        flows: [
          flow('main', {
            steps: [
              step('submit checkout', use('submit-form', {
                formUrl: '/checkout',
                buttonLabel: '[data-testid=checkout-btn]',
              })),
            ],
          }),
        ],
      })

      const plan = compile(s)

      // The expanded steps should have literal values substituted -- not ref() markers
      const gotoStep = plan.steps.find(s => s.name === 'submit checkout > go to form')
      const clickStep = plan.steps.find(s => s.name === 'submit checkout > click button')

      expect(gotoStep).toBeDefined()
      expect(clickStep).toBeDefined()

      // Verify literals are substituted (not ref wrappers)
      const gotoAction = gotoStep!.action as { url: unknown }
      expect(gotoAction.url).toBe('/checkout')

      const clickAction = clickStep!.action as { target: unknown }
      expect(clickAction.target).toBe('[data-testid=checkout-btn]')
    })

    it('preserves outer ref() bindings unchanged when not matching input names', () => {
      const loginFlow = flow('login', {
        inputs: { email: 'string' },
        steps: [
          step('fill email', browser('type', { target: '[name=email]', value: ref('email') })),
        ],
      })

      const s = spec('ref preservation', {
        data: { user: { email: 'test@example.com' } },
        library: [loginFlow],
        flows: [
          flow('main', {
            steps: [
              step('do login', use('login', { email: ref('data.user.email') })),
            ],
          }),
        ],
      })

      const plan = compile(s)
      // The email input is bound to ref('data.user.email'), so the expanded step
      // should have ref('data.user.email') substituted in place of ref('email')
      const fillStep = plan.steps.find(s => s.name === 'do login > fill email')
      expect(fillStep).toBeDefined()
      const action = fillStep!.action as { value: unknown }
      expect(action.value).toEqual({ __type: 'ref', path: 'data.user.email' })
    })
  })

  describe('multi-URL base annotation', () => {
    it('shows [base: <name>] on API and browser goto steps that target a named URL', () => {
      const s = spec('multi-url spec', {
        baseUrl: 'http://app.local',
        urls: { payments: 'http://pay.local', admin: 'http://admin.local' },
        apis: {
          login:      { method: 'POST', path: '/api/auth/login' },
          chargeCard: { method: 'POST', path: '/api/charge', base: 'payments' },
        },
        flows: [
          flow('checkout', {
            steps: [
              step('login',        api('login', {})),
              step('charge',       api('chargeCard', {})),
              step('open app',     browser('goto', { url: '/' })),
              step('open admin',   browser('goto', { url: '/dashboard', base: 'admin' })),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const output = formatExpandedPlan(plan)

      expect(output).toMatchInlineSnapshot(`
        "SPEC: multi-url spec
        BASE URL: http://app.local
        URL [payments]: http://pay.local
        URL [admin]: http://admin.local

        STEPS (4 total):
            1. login (flow: checkout)
               action: POST /api/auth/login
            2. charge (flow: checkout)
               action: POST /api/charge [base: payments]
            3. open app (flow: checkout)
               action: browser(goto, "/")
            4. open admin (flow: checkout)
               action: browser(goto, "/dashboard") [base: admin]"
      `)
    })
  })

  describe('save and retry metadata', () => {
    it('preserves save paths and retry counts in expanded plan', () => {
      const s = spec('metadata spec', {
        flows: [
          flow('main', {
            steps: [
              step('create', api('POST /api/orders', {
                save: { orderId: 'body.id', orderStatus: 'body.status' },
              }), { retries: 2 }),
            ],
          }),
        ],
      })

      const plan = compile(s)
      const output = formatExpandedPlan(plan)

      expect(output).toMatchInlineSnapshot(`
        "SPEC: metadata spec

        STEPS (1 total):
            1. create (flow: main)
               action: POST /api/orders
               save:   {"orderId":"body.id","orderStatus":"body.status"}
               retries: 2"
      `)
    })
  })
})
