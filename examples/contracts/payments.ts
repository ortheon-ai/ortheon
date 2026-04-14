import type { ApiContract } from '../../src/types.js'

// Contracts for a hypothetical payments microservice running at a separate origin.
// All contracts declare base: 'payments' so calls are routed to PAYMENTS_URL.

export const paymentsApi: Record<string, ApiContract> = {
  chargeCard: {
    method: 'POST',
    path: '/api/charge',
    base: 'payments',
    purpose: 'Charge a payment card and return a charge ID',
    request: {
      headers: { Authorization: 'Bearer <token>' },
      // body: { orderId: string, amount: number, currency: string } -- documentary
    },
    response: {
      status: 201,
      // body: { chargeId: string, status: 'captured' } -- documentary
    },
  },
  getCharge: {
    method: 'GET',
    path: '/api/charge/{chargeId}',
    base: 'payments',
    purpose: 'Fetch a charge by ID',
    request: {
      params: { chargeId: 'string' },
      headers: { Authorization: 'Bearer <token>' },
    },
    response: {
      status: 200,
      // body: { chargeId: string, status: 'captured' | 'refunded', amount: number } -- documentary
    },
  },
}
