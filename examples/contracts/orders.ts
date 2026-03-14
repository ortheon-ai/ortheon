import type { ApiContract } from '../../src/types.js'

export const ordersApi: Record<string, ApiContract> = {
  createOrder: {
    method: 'POST',
    path: '/api/orders',
    purpose: 'Create a new order for the authenticated user',
    request: {
      headers: { Authorization: 'Bearer <token>' },
      // body: { sku: string, quantity: number } -- documentary
    },
    response: {
      status: 201,
      // body: { id: string, status: "confirmed", sku: string, quantity: number } -- documentary
    },
  },
  getOrder: {
    method: 'GET',
    path: '/api/orders/{orderId}',
    purpose: 'Fetch an order by id for the authenticated user',
    request: {
      params: { orderId: 'string' },
      headers: { Authorization: 'Bearer <token>' },
    },
    response: {
      status: 200,
    },
  },
  verifyOrderEffects: {
    method: 'GET',
    path: '/_verify/orders/{orderId}',
    purpose: 'Verify that persistence and downstream side effects occurred for an order',
    request: {
      params: { orderId: 'string' },
    },
    response: {
      status: 200,
      // body: { orderExists: boolean, logRecorded: boolean, eventPublished: boolean } -- documentary
    },
  },
}

export const healthApi: Record<string, ApiContract> = {
  health: {
    method: 'GET',
    path: '/api/health',
    purpose: 'Check that the service is up and responding',
    response: {
      status: 200,
    },
  },
}

export const productsApi: Record<string, ApiContract> = {
  listProducts: {
    method: 'GET',
    path: '/api/products',
    purpose: 'Return the product catalog',
    response: {
      status: 200,
    },
  },
}
