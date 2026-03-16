# Writing specs

A practical guide to authoring Ortheon specs. Start here after reading the README.

## The mental model

1. A **spec** describes a behavior.
2. A spec contains **flows** (the executable ones) and optionally **library** flows (reusable, not executed directly).
3. A flow contains **steps** and optional **sections** (cosmetic grouping).
4. Every step is one of: `browser(...)`, `api(...)`, `expect(...)`, or `use(...)`.
5. Steps can **save** outputs.
6. Later steps can **reference** saved outputs with `ref(...)`.

## Contracts first

Before writing steps, declare the APIs your spec will use. This makes the spec self-describing.

```ts
import type { ApiContract } from 'ortheon'

export const paymentsApi: Record<string, ApiContract> = {
  capturePayment: {
    method: 'POST',
    path: '/api/payments/{paymentId}/capture',
    purpose: 'Capture an authorized payment',
    request: {
      params: { paymentId: 'string' },
    },
    response: {
      status: 200,
      // body: { id, status, amount } -- documentary only
    },
  },
}
```

Contracts are:
- **Domain-grouped** -- one file per business domain.
- **Named by business intent** -- `capturePayment`, not `postApiPaymentsV2CaptureHandler`.
- **Stable** -- seldom changed once defined.

Body shapes in contracts are documentation. They are not schema-validated. If path contains `{paymentId}`, the validator will require `params.paymentId` in any step that uses this contract.

## Data catalogs

Prefer static named data over fixture-creation code.

```ts
import { env, secret } from 'ortheon'

export const accounts = {
  testMerchant: {
    id: env('E2E_MERCHANT_ID'),
    apiKey: secret('E2E_MERCHANT_API_KEY'),
  },
}
```

Use `env()` for environment-bound values and `secret()` for sensitive values. Both resolve from `process.env` at runtime. Secret values are automatically redacted as `[REDACTED]` in all failure messages and reporter output -- `env()` values are not redacted.

In a spec, bind data to the `data` field:

```ts
spec('refund flow', {
  data: {
    merchant: accounts.testMerchant,
    product: products.defaultWidget,
  },
  // ...
})
```

Data values are available via `ref('data.merchant.id')` inside steps.

## Writing flows

### Simple flow (no inputs)

```ts
flow('health check', {
  steps: [
    step('ping', api('GET /api/health', { expect: { status: 200 } })),
  ],
})
```

### Flow with declared inputs

```ts
export const addToCartFlow = flow('add to cart', {
  inputs: {
    sku: 'string',
  },
  steps: [
    step('click add', browser('click', { target: `[data-sku="${ref('sku')}"]` })),
    step('wait for cart badge', browser('waitFor', {
      target: '[data-testid=cart-badge]',
      state: 'visible',
    })),
  ],
})
```

Use it from another flow:

```ts
step('add widget to cart', use('add to cart', { sku: ref('data.product.sku') }))
```

Input refs inside the reusable flow are substituted at compile time with the caller's values.

Expanded step names are prefixed with the caller step's name, separated by ` > `. So the steps above expand to `"add widget to cart > click add"` and `"add widget to cart > wait for cart badge"` in the plan. This means the same flow can be invoked twice in one spec without name collisions:

```ts
step('login as buyer', use('login', { email: 'buyer@example.com', ... }))
step('login as admin', use('login', { email: 'admin@example.com', ... }))
// expands to:
// "login as buyer > fill email", "login as buyer > submit"
// "login as admin > fill email", "login as admin > submit"
```

### Sections for long flows

Sections are chapter headings. They group steps for readability in the reporter output. They are not reusable or independently executable.

```ts
flow('full checkout', {
  steps: [
    section('authentication', [
      step('login', use('login', { ... })),
    ]),
    section('cart', [
      step('add item', use('add to cart', { sku: ref('data.product.sku') })),
    ]),
    section('payment', [
      step('submit checkout', api('submitCheckout', { ... })),
    ]),
  ],
})
```

## API steps

### Using a named contract

```ts
step('create order', api('createOrder', {
  headers: { Authorization: bearer(ref('token')) },
  body: { sku: ref('data.product.sku'), quantity: 1 },
  expect: { status: 201 },
  save: { orderId: 'body.id' },
}))
```

### Using inline method + path

```ts
step('list products', api('GET /api/products', {
  expect: { status: 200 },
  save: { products: 'body' },
}))
```

### Save paths

Save paths tell Ortheon where to extract values from the HTTP response:

| Save path | Extracts |
|-----------|----------|
| `"body"` | Entire response body |
| `"body.id"` | Body property `id` |
| `"body.items[0].sku"` | Nested with array index |
| `"status"` | HTTP status code |
| `"headers.x-request-id"` | Response header |

### Inline expectations

The `expect` block on API steps validates the response:

```ts
expect: {
  status: 201,                    // assert exact status code
  body: {
    status: 'confirmed',          // assert body.status equals 'confirmed'
    id: existsCheck(),            // assert body.id is non-null (no value comparison)
  },
}
```

Body field values are checked with `equals`. Use `existsCheck()` (imported from `ortheon`) to check that a field is present and non-null without comparing its value. Do not use the string `"exists"` -- it will be compared with `equals` like any other literal.

## Browser steps

### Navigation

```ts
step('open homepage', browser('goto', { url: '/' }))
```

URLs are relative to `baseUrl` unless they start with `http`.

### Form interaction

```ts
step('fill email', browser('type', { target: '[name=email]', value: ref('data.user.email') }))
step('select country', browser('select', { target: '#country', value: 'US' }))
step('accept terms', browser('check', { target: '#terms' }))
step('submit', browser('click', { target: '[data-testid=submit]' }))
```

### Waiting

```ts
step('wait for spinner to disappear', browser('waitFor', {
  target: '[data-testid=spinner]',
  state: 'hidden',
}))

step('wait for confirmation page', browser('waitFor', {
  url: '/confirmation',
}))
```

Supported states: `visible`, `hidden`, `attached`, `detached`.

### Extracting values from the page

```ts
step('capture order id', browser('extract', {
  target: '[data-testid=order-id]',
  save: {
    displayedOrderId: 'text',
  },
}))

step('capture receipt link', browser('extract', {
  target: 'a[data-testid=receipt]',
  save: {
    receiptUrl: 'attr:href',
  },
}))
```

Extract sources: `"text"` (textContent), `"value"` (input value), `"html"` (innerHTML), `"attr:<name>"` (element attribute).

## Standalone assertions

For assertions that don't belong to a browser or API step:

```ts
step('order status confirmed', expect(ref('order.status'), 'equals', 'confirmed'))
step('name appears in greeting', expect(ref('greeting'), 'contains', ref('data.user.firstName')))
step('order id exists', expect(ref('orderId'), 'exists'))
```

## Retries

One concession to real infrastructure. Add `retries` to any step:

```ts
step('verify async effects', api('verifyEffects', {
  params: { orderId: ref('orderId') },
  expect: { status: 200, body: { processed: true } },
}), { retries: 3 })
```

The step is retried up to N extra times. The default delay is linear backoff: 500ms × attempt number. This is fine for transient error retries.

### Polling

For polling — checking until a condition holds — use `retryIntervalMs` to fix the cadence:

```ts
step('wait for job to finish',
  api('getJob', {
    params: { jobId: ref('jobId') },
    expect: {
      status: 200,
      body: { status: 'done' },   // retries when status is not 'done'
    },
    save: { jobStatus: 'body.status' },
  }),
  { retries: 20, retryIntervalMs: 1000 }
)
```

When `retryIntervalMs` is set, every retry waits exactly that many milliseconds regardless of attempt count. When it is not set, the default linear backoff applies.

Set `retryIntervalMs` explicitly whenever fixed-interval polling is the intent. Leaving it unset on a polling step makes the growing delay semantically misleading — the retry machinery is designed for transient failures, not state polling.

## The `library` field

Flows in `library` are available for `use()` but not executed directly when the spec runs:

```ts
spec('checkout', {
  library: [loginFlow, addToCartFlow],  // available for use()
  flows: [
    flow('main', {                       // executed when spec runs
      steps: [
        step('login', use('login', { ... })),
        step('add item', use('add to cart', { ... })),
        // ...
      ],
    }),
  ],
})
```

## Environment variables

Specs reference environment variables through `env()` and `secret()`:

```ts
baseUrl: env('MY_APP_URL')
```

Set them before running:

```bash
MY_APP_URL=http://localhost:3000 \
E2E_USER_EMAIL=buyer@example.com \
E2E_USER_PASSWORD=password123 \
ortheon run 'specs/**/*.ortheon.ts'
```

Or use a `.env` loader of your choice.

## Naming conventions

Stable names are critical for diffs, debugging, and LLM generation.

| Thing | Convention | Examples |
|-------|-----------|----------|
| API contracts | verbNoun | `createOrder`, `capturePayment` |
| Flows | business-intent | `login`, `submitCheckout`, `refundOrder` |
| Saved values | noun-based, short | `orderId`, `token`, `order` |
| Steps | user/system intent | `create order`, `verify side effects` |
| Sections | domain area | `authentication`, `purchase`, `verification` |

## What not to do

- Don't write arbitrary TypeScript in spec files. Specs should be declarative data.
- Don't build monster flows. Keep flows short and compose them.
- Don't put database queries, log searches, or event bus checks in specs. Expose them as verification APIs.
- Don't add conditionals or loops. If you need different paths, write different specs.
- Don't create fixture-factory functions. Use named data catalogs.
