import { spec, flow, step, api, expect, ref, env, secret, section } from '../../../src/dsl.js'
import { authApi } from '../../contracts/auth.js'
import { ordersApi } from '../../contracts/orders.js'
import { products } from '../../data/products.js'

// API-only order flow.
// Acquires token via API auth, creates an order, fetches it back, verifies side effects.
// No browser steps -- demonstrates pure API specs.
export default spec('guest order via API', {
  baseUrl: env('APP_BASE_URL'),
  apis: {
    ...authApi,
    ...ordersApi,
  },
  data: {
    product: products.defaultWidget,
  },
  tags: ['checkout', 'api-only'],
  safety: 'non-destructive',
  flows: [
    flow('api order flow', {
      steps: [
        section('authentication', [
          step('acquire auth token',
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

        section('order creation', [
          step('create order',
            api('createOrder', {
              headers: {
                Authorization: ref('token'),
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
                orderStatus: 'body.status',
              },
            })
          ),
          step('order status should be confirmed',
            expect(ref('orderStatus'), 'equals', 'confirmed')
          ),
        ]),

        section('verification', [
          step('fetch created order',
            api('getOrder', {
              params: {
                orderId: ref('orderId'),
              },
              headers: {
                Authorization: ref('token'),
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
