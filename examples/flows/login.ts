import { flow, step, browser, ref } from '../../src/dsl.js'

// Reusable browser login flow.
// Declared inputs: email (string), password (secret).
// After this flow completes, the user is on /products.
export const loginFlow = flow('login', {
  inputs: {
    email: 'string',
    password: 'secret',
  },
  steps: [
    step('open login page',
      browser('goto', { url: '/login' })
    ),
    step('fill email',
      browser('type', {
        target: '[data-testid=email]',
        value: ref('email'),
      })
    ),
    step('fill password',
      browser('type', {
        target: '[data-testid=password]',
        value: ref('password'),
      })
    ),
    step('submit login',
      browser('click', {
        target: '[data-testid=submit-login]',
      })
    ),
    step('wait for redirect to products',
      browser('waitFor', {
        url: '/products',
      })
    ),
  ],
})
