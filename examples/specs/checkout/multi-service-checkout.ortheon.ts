import { spec, flow, step, api, expect, ref, env, secret, bearer, section, existsCheck } from '../../../src/dsl.js'
import { authApi } from '../../contracts/auth.js'
import { ordersApi } from '../../contracts/orders.js'
import { paymentsApi } from '../../contracts/payments.js'

// Demonstrates multi-URL support: API steps targeting different service origins.
//
// - DEMO_BASE_URL  → app server (auth, orders)
// - PAYMENTS_URL   → payments microservice (charge, refund)
//
// Run (with both servers available):
//   DEMO_BASE_URL=http://localhost:3737 PAYMENTS_URL=http://localhost:3800 \
//   E2E_USER_PASSWORD=... ortheon run examples/specs/checkout/multi-service-checkout.ortheon.ts

export default spec('multi-service checkout', {
  // Default URL for steps that don't declare a base (auth, orders).
  baseUrl: env('DEMO_BASE_URL'),

  // Named URL for the payments microservice.
  urls: {
    payments: env('PAYMENTS_URL'),
  },

  apis: {
    // Auth + orders run against the default baseUrl (no base declared).
    ...authApi,
    ...ordersApi,
    // Payments contracts declare base: 'payments' and are routed to PAYMENTS_URL.
    ...paymentsApi,
  },

  tags: ['checkout', 'multi-url'],
  safety: 'non-destructive',

  flows: [
    flow('auth and place order', {
      steps: [
        section('authentication', [
          // Hits DEMO_BASE_URL (default)
          step('acquire auth token',
            api('login', {
              body: {
                email: 'buyer@example.com',
                password: secret('E2E_USER_PASSWORD'),
              },
              expect: { status: 200 },
              save: { token: 'body.token' },
            })
          ),
          step('token is present',
            expect(ref('token'), 'exists')
          ),
        ]),

        section('order creation', [
          // Hits DEMO_BASE_URL (default)
          step('create order',
            api('createOrder', {
              headers: { Authorization: bearer(ref('token')) },
              body: { sku: 'sku_123', quantity: 1 },
              expect: { status: 201, body: { id: existsCheck() } },
              save: { orderId: 'body.id' },
            })
          ),
        ]),

        section('payment', [
          // Hits PAYMENTS_URL (from contract's base: 'payments')
          step('charge for order',
            api('chargeCard', {
              headers: { Authorization: bearer(ref('token')) },
              body: { orderId: ref('orderId'), amount: 1999, currency: 'usd' },
              expect: { status: 201, body: { chargeId: existsCheck() } },
              save: { chargeId: 'body.chargeId' },
            })
          ),
          step('charge id is present',
            expect(ref('chargeId'), 'exists')
          ),

          // Hits PAYMENTS_URL -- step-level base overrides contract if needed
          step('fetch charge record',
            api('getCharge', {
              base: 'payments',
              params: { chargeId: ref('chargeId') },
              headers: { Authorization: bearer(ref('token')) },
              expect: { status: 200 },
            })
          ),
        ]),
      ],
    }),
  ],
})
