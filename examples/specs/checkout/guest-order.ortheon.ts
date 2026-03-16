import { spec, flow, step, api, expect, ref, env, secret, bearer, section, existsCheck } from '../../../src/dsl.js'
import { authApi } from '../../contracts/auth.js'
import { ordersApi, productsApi } from '../../contracts/orders.js'
import { products } from '../../data/products.js'

// API-only order flow.
// Acquires token via API auth, creates an order, fetches it back, verifies side effects.
// No browser steps -- demonstrates pure API specs.
export default spec('guest order via API', {
  baseUrl: env('APP_BASE_URL'),
  apis: {
    ...authApi,
    ...ordersApi,
    ...productsApi,
  },
  data: {
    product: products.defaultWidget,
  },
  tags: ['checkout', 'api-only'],
  safety: 'non-destructive',
  flows: [
    flow('api order flow', {
      steps: [
        section('product catalog', [
          // Demonstrates: query params -- server filters the catalog by SKU
          step('list products filtered by sku',
            api('listProducts', {
              query: {
                sku: ref('data.product.sku'),
              },
              expect: {
                status: 200,
              },
              save: {
                catalogResults: 'body',
              },
            })
          ),
          // Demonstrates: exists matcher -- confirms results were returned
          step('filtered catalog should return results',
            expect(ref('catalogResults'), 'exists')
          ),
        ]),

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
                Authorization: bearer(ref('token')),
              },
              body: {
                sku: ref('data.product.sku'),
                quantity: 1,
              },
              expect: {
                status: 201,
                body: {
                  id: existsCheck(),
                  status: 'confirmed',
                },
              },
              save: {
                orderId: 'body.id',
                orderStatus: 'body.status',
              },
            })
          ),
          // Demonstrates: matches matcher -- orderId is a UUID
          step('order id should be a UUID',
            expect(ref('orderId'), 'matches', '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
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
          // Demonstrates: contains matcher (object subset) -- checks a subset of the fetched order
          step('fetched order should contain confirmed status',
            expect(ref('fetchedOrder'), 'contains', { status: 'confirmed' })
          ),
          // Demonstrates: notExists matcher -- order body has no "cancelReason" field
          step('confirmed order should have no cancel reason',
            expect(ref('fetchedOrder.cancelReason'), 'notExists')
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
