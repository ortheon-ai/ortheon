import { env, secret } from '../../src/dsl.js'

export const users = {
  standardBuyer: {
    email: env('E2E_USER_EMAIL'),
    password: secret('E2E_USER_PASSWORD'),
    firstName: 'Winton',
  },
  adminUser: {
    email: env('E2E_ADMIN_EMAIL'),
    password: secret('E2E_ADMIN_PASSWORD'),
  },
}
