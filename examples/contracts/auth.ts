import type { ApiContract } from '../../src/types.js'

export const authApi: Record<string, ApiContract> = {
  login: {
    method: 'POST',
    path: '/api/auth/login',
    purpose: 'Authenticate with email and password, receive a bearer token',
    request: {
      // body: { email: string, password: string } -- documentary
    },
    response: {
      status: 200,
      // body: { token: string, userId: string, firstName: string } -- documentary
    },
  },
}
