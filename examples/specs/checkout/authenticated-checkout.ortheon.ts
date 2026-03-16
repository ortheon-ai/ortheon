import { spec, flow, step, api, expect, use, ref, env, secret, bearer, section } from '../../../src/dsl.js'
import { authApi } from '../../contracts/auth.js'
import { ordersApi } from '../../contracts/orders.js'
import { loginFlow } from '../../flows/login.js'
import { users } from '../../data/users.js'
import { products } from '../../data/products.js'

// Full canonical spec:
// - API token acquisition (explicit)
// - Browser login (via reusable flow)
// - API order creation with explicit auth header
// - Order verification
// - Side-effect verification
//
// Auth is explicit: browser login is browser-only.
// API calls use a token acquired through a separate login API step.
export default spec('authenticated checkout creates persistent order', {
  baseUrl: env('DEMO_BASE_URL'),
  apis: {
    ...authApi,
    ...ordersApi,
  },
  data: {
    user: users.standardBuyer,
    product: products.defaultWidget,
  },
  tags: ['checkout', 'critical', 'regression'],
  safety: 'non-destructive',
  // library: flows available for use() but not directly executed
  library: [loginFlow],
  flows: [
    flow('checkout', {
      steps: [
        section('api authentication', [
          step('acquire api token',
            api('login', {
              body: {
                email: 'buyer@example.com',
                password: secret('E2E_USER_PASSWORD'),
              },
              expect: {
                status: 200,
              },
              save: {
                token: 'body.token',
              },
            })
          ),
        ]),

        section('browser authentication', [
          step('browser login',
            use('login', {
              email: ref('data.user.email'),
              password: ref('data.user.password'),
            })
          ),
        ]),

        section('purchase', [
          step('create order',
            api('createOrder', {
              headers: {
                Authorization: bearer(ref('token')),
              },
              body: {
                sku: ref('data.product.sku'),
                quantity: 1,
              },
              expect: {
                status: 201,
                body: {
                  status: 'confirmed',
                },
              },
              save: {
                orderId: 'body.id',
                order: 'body',
              },
            })
          ),
          step('order status should be confirmed',
            expect(ref('order.status'), 'equals', 'confirmed')
          ),
        ]),

        section('verification', [
          step('fetch created order',
            api('getOrder', {
              params: {
                orderId: ref('orderId'),
              },
              headers: {
                Authorization: bearer(ref('token')),
              },
              expect: {
                status: 200,
              },
              save: {
                fetchedOrder: 'body',
              },
            })
          ),
          step('fetched order status should be confirmed',
            expect(ref('fetchedOrder.status'), 'equals', 'confirmed')
          ),
          step('verify persistence and side effects',
            api('verifyOrderEffects', {
              params: {
                orderId: ref('orderId'),
              },
              expect: {
                status: 200,
                body: {
                  orderExists: true,
                  logRecorded: true,
                  eventPublished: true,
                },
              },
            })
          ),
        ]),
      ],
    }),
  ],
})
