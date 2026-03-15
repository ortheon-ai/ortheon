# Ortheon

Declarative behavioral specs for real infrastructure. Every step is either a browser interaction or an API call.

## What Ortheon does

Ortheon describes long behavioral flows over real systems using only two executable primitives: `browser(...)` and `api(...)`. Steps save named outputs. Later steps assert on them.

```ts
export default spec("guest order via API", {
  baseUrl: env("APP_BASE_URL"),
  apis: { ...authApi, ...ordersApi },
  data: { product: products.defaultWidget },

  flows: [
    flow("order flow", {
      steps: [
        step(
          "acquire token",
          api("login", {
            body: {
              email: "buyer@example.com",
              password: secret("E2E_USER_PASSWORD"),
            },
            save: { token: "body.token" },
          }),
        ),
        step(
          "create order",
          api("createOrder", {
            headers: { Authorization: bearer(ref("token")) },
            body: { sku: ref("data.product.sku"), quantity: 1 },
            expect: { status: 201, body: { status: "confirmed" } },
            save: { orderId: "body.id" },
          }),
        ),
        step(
          "verify side effects",
          api("verifyOrderEffects", {
            params: { orderId: ref("orderId") },
            expect: {
              status: 200,
              body: { orderExists: true, logRecorded: true },
            },
          }),
        ),
      ],
    }),
  ],
});
```

## Why this shape

LLMs and humans both do best when artifacts have repeated structure, low ambiguity, stable names, explicit dependencies, and a small grammar. Ortheon is designed around that constraint.

- No hidden state. No implicit magic. No arbitrary code.
- Every executable line is a browser action, an API call, or an assertion.
- Every meaningful result is named so later steps can reference it.
- Verification of logs, DB state, event buses, or traces happens through HTTP verification endpoints exposed by the system under test -- not through DSL extensions.

## Installation

```bash
npm install ortheon
npx playwright install chromium
```

Requires Node 20+.

## Quick start

### 1. Define contracts

Contracts declare what APIs exist. Body shapes are documentary -- only param keys and path params are validated.

```ts
// contracts/orders.ts
import type { ApiContract } from "ortheon";

export const ordersApi: Record<string, ApiContract> = {
  createOrder: {
    method: "POST",
    path: "/api/orders",
    purpose: "Create a new order for the authenticated user",
  },
  getOrder: {
    method: "GET",
    path: "/api/orders/{orderId}",
    purpose: "Fetch an order by id",
    request: { params: { orderId: "string" } },
  },
};
```

### 2. Define data catalogs

```ts
// data/users.ts
import { env, secret } from "ortheon";

export const users = {
  standardBuyer: {
    email: env("E2E_USER_EMAIL"),
    password: secret("E2E_USER_PASSWORD"),
    firstName: "Winton",
  },
};
```

### 3. Define reusable flows

Flows declare their inputs explicitly.

```ts
// flows/login.ts
import { flow, step, browser, ref } from "ortheon";

export const loginFlow = flow("login", {
  inputs: {
    email: "string",
    password: "secret",
  },
  steps: [
    step("open login page", browser("goto", { url: "/login" })),
    step(
      "fill email",
      browser("type", { target: "[name=email]", value: ref("email") }),
    ),
    step(
      "fill password",
      browser("type", { target: "[name=password]", value: ref("password") }),
    ),
    step("submit", browser("click", { target: "[data-testid=submit]" })),
    step("wait for redirect", browser("waitFor", { url: "/dashboard" })),
  ],
});
```

### 4. Write a spec

```ts
// specs/checkout.ortheon.ts
import {
  spec,
  flow,
  step,
  api,
  expect,
  use,
  ref,
  env,
  secret,
  bearer,
  section,
} from "ortheon";
import { ordersApi } from "../contracts/orders.js";
import { loginFlow } from "../flows/login.js";
import { users } from "../data/users.js";

export default spec("authenticated checkout", {
  baseUrl: env("APP_BASE_URL"),
  apis: { ...ordersApi },
  data: { user: users.standardBuyer },
  library: [loginFlow],

  flows: [
    flow("checkout", {
      steps: [
        section("authentication", [
          step(
            "get api token",
            api("POST /api/auth/login", {
              body: {
                email: "buyer@example.com",
                password: secret("E2E_USER_PASSWORD"),
              },
              save: { token: "body.token" },
            }),
          ),
          step(
            "browser login",
            use("login", {
              email: ref("data.user.email"),
              password: ref("data.user.password"),
            }),
          ),
        ]),
        section("purchase", [
          step(
            "create order",
            api("createOrder", {
              headers: { Authorization: bearer(ref("token")) },
              body: { sku: "sku_123", quantity: 1 },
              expect: { status: 201 },
              save: { orderId: "body.id", order: "body" },
            }),
          ),
          step(
            "order confirmed",
            expect(ref("order.status"), "equals", "confirmed"),
          ),
        ]),
      ],
    }),
  ],
});
```

### 5. Run it

```bash
APP_BASE_URL=http://localhost:3000 ortheon run 'specs/**/*.ortheon.ts'
```

## CLI

Two commands, `run` and `expand`.

### `ortheon run <glob>`

Run spec files matching a glob pattern.

| Flag                | Description             | Default   |
| ------------------- | ----------------------- | --------- |
| `--base-url <url>`  | Override spec `baseUrl` | --        |
| `--reporter <type>` | `console` or `json`     | `console` |
| `--headed`          | Show the browser window | --        |
| `--timeout <ms>`    | Default step timeout    | `30000`   |
| `--skip-validation` | Skip pre-run validation | --        |

### `ortheon expand <file>`

Print the fully expanded execution plan for a spec. All `use()` calls inlined, all contracts resolved, all sections flattened. Useful for debugging and LLM consumption.

```
SPEC: authenticated checkout
BASE URL: env("APP_BASE_URL")

STEPS (11 total):
    1. [api authentication] acquire api token (flow: checkout)
       action: POST /api/auth/login
       save:   {"token":"body.token"}
    2. [browser authentication] browser login > open login page (flow: login)
       action: browser(goto, "/login")
    3. [browser authentication] browser login > fill email (flow: login)
       action: browser(type, "[data-testid=email]")
   ...
```

## DSL reference

### Primitives

| Function                            | Purpose                          |
| ----------------------------------- | -------------------------------- |
| `spec(name, config)`                | Top-level behavioral spec        |
| `flow(name, { inputs?, steps })`    | Named sequence of steps          |
| `step(name, action, { retries? }?)` | Single executable step           |
| `section(name, steps)`              | Cosmetic grouping (not reusable) |

### Actions

| Function                            | Purpose                                            |
| ----------------------------------- | -------------------------------------------------- |
| `browser(action, options)`          | Browser interaction                                |
| `api(target, options?)`             | HTTP API call (named contract or `"METHOD /path"`) |
| `expect(value, matcher, expected?)` | Standalone assertion                               |
| `use(flowName, inputs?)`            | Inline a reusable flow                             |

### Helpers

| Function        | Purpose                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `ref(path)`     | Reference a saved value (`ref("order.id")`)                                                      |
| `env(name)`     | Read an environment variable                                                                     |
| `secret(name)`  | Read a secret -- redacted as `[REDACTED]` in all failure output                                  |
| `bearer(token)` | Wrap a token to produce `"Bearer <token>"` at runtime. Use for `Authorization` headers.          |
| `existsCheck()` | Marker for inline `expect.body` blocks -- asserts a field is non-null without checking its value |

### Browser actions

| Action    | Options                                              | Playwright equivalent                      |
| --------- | ---------------------------------------------------- | ------------------------------------------ |
| `goto`    | `{ url }`                                            | `page.goto(url)`                           |
| `click`   | `{ target }`                                         | `page.locator(target).click()`             |
| `type`    | `{ target, value }`                                  | `page.locator(target).fill(value)`         |
| `press`   | `{ target, key }`                                    | `page.locator(target).press(key)`          |
| `select`  | `{ target, value }`                                  | `page.locator(target).selectOption(value)` |
| `check`   | `{ target }`                                         | `page.locator(target).check()`             |
| `uncheck` | `{ target }`                                         | `page.locator(target).uncheck()`           |
| `waitFor` | `{ target, state, timeout? }` or `{ url, timeout? }` | `locator.waitFor()` or `page.waitForURL()` |
| `extract` | `{ target, save: { name: source } }`                 | See extract sources below                  |

Extract sources: `"text"`, `"value"`, `"html"`, `"attr:href"`, `"attr:data-*"`, etc.

### Matchers

Five only. No matcher jungle.

| Matcher     | Purpose                                     | Expected required? |
| ----------- | ------------------------------------------- | ------------------ |
| `equals`    | Strict deep equality                        | Yes                |
| `contains`  | Substring, array includes, or object subset | Yes                |
| `matches`   | Regex test                                  | Yes                |
| `exists`    | Not null/undefined                          | No                 |
| `notExists` | Is null/undefined                           | No                 |

### API step options

````ts
api('createOrder', {
  params: { orderId: ref('orderId') },              // path params: /orders/{orderId}
  query: { page: '1' },                             // query string
  headers: { Authorization: bearer(ref('token')) }, // request headers -- use bearer() for tokens
  body: { sku: 'sku_123', quantity: 1 },            // request body (JSON)
  expect: {
    status: 201,                                    // assert status code
    body: {
      status: 'confirmed',                          // assert body.status equals 'confirmed'
      id: existsCheck(),                            // assert body.id is non-null
    },
  },
  save: {
    orderId: 'body.id',                             // save response body field
    order: 'body',                                  // save entire body
  },
})
```

### `ref` path syntax

Dot notation and bracket indexing. Nothing else.

```ts
ref('orderId')              // top-level saved value
ref('order.id')             // nested property
ref('order.items[0].sku')   // array indexing
ref('data.user.email')      // data catalog value
```

No wildcards. No filters. No JSONPath. No recursive descent.

## Spec structure

```ts
spec('name', {
  baseUrl: env('APP_BASE_URL'),               // required
  apis: { ...ordersApi, ...paymentsApi },      // shared contract catalogs
  data: { user: users.standardBuyer },         // data catalog bindings
  tags: ['checkout', 'critical'],              // metadata
  safety: 'non-destructive',                   // metadata
  library: [loginFlow],                        // flows for use() only, not executed directly
  flows: [
    flow('main', {
      inputs: { email: 'string' },             // declared inputs (for reusable flows)
      steps: [
        section('setup', [...]),                // cosmetic grouping
        step('do thing', api(...)),            // executable step
      ],
    }),
  ],
})
```

### `library` vs `flows`

- **`flows`**: executed sequentially when the spec runs.
- **`library`**: available for `use()` references but never executed directly. Put reusable flows here.

## Architecture

```
DSL (authoring) --> Compiler (expansion) --> Runner (execution)
```

- **DSL**: Pure functions that produce typed AST nodes. No side effects.
- **Compiler**: Resolves contracts, expands `use()` calls, flattens sections. Emits a flat `ExecutionPlan`. `baseUrl` stays unresolved -- the runner resolves it at execution time.
- **Validator**: Two passes. Pass 1 (structural) runs on raw AST. Pass 2 (ref resolution) runs on the expanded plan.
- **Runner**: Walks the plan sequentially. Resolves dynamic values, executes actions, processes saves, evaluates assertions. A step failure stops the flow immediately.
- **Reporter**: Console output with section headers, pass/fail icons, and durations. JSON output for CI.

## Failure semantics

A step failure stops the current flow immediately and marks the spec failed.

The `retries` option is the only modifier:

```ts
step('flaky verification', api('verifyEffects', { ... }), { retries: 2 })
```

This retries the entire step up to 2 extra times.

## Auth model

Browser auth and API auth are separate. No hidden state leaks between them.

If a spec needs both browser and API steps, it acquires the API token through a dedicated API step:

```ts
step(
  "get token",
  api("POST /api/auth/login", {
    body: { email: "...", password: secret("PASSWORD") },
    save: { token: "body.token" },
  }),
);

step(
  "create order",
  api("createOrder", {
    headers: { Authorization: bearer(ref("token")) },
    // ...
  }),
);
```

Browser login is for browser-authenticated flows only.

## Verification endpoints

If the system under test has side effects (database writes, event publishing, log recording), it should expose them through HTTP verification endpoints:

```ts
// In the app under test:
// GET /_verify/orders/:id -> { orderExists, logRecorded, eventPublished }

step(
  "verify side effects",
  api("verifyOrderEffects", {
    params: { orderId: ref("orderId") },
    expect: {
      status: 200,
      body: { orderExists: true, logRecorded: true, eventPublished: true },
    },
  }),
);
```

Ortheon does not access databases, log systems, or event buses directly. If behavior matters, expose it through HTTP.

## Scaling doctrine

1. **Specs are thin** -- scenario definitions only.
2. **Contracts are shared** -- define HTTP operations once per domain.
3. **Data is cataloged** -- named data objects, not fixture code.
4. **Flows are small** -- short business-intent flows, composed together.
5. **Expansion is first-class** -- every spec can be rendered fully inlined via `ortheon expand`.
6. **Naming is sacred** -- stable names beat clever abstractions.
7. **Verification stays HTTP** -- probes never leak into the DSL.

## Recommended file structure

```
ortheon/
  contracts/        # API contract catalogs by domain
    orders.ts
    payments.ts
  data/             # Named data catalogs
    users.ts
    products.ts
  flows/            # Reusable flows by domain
    auth/login.ts
    cart/add-item.ts
  specs/            # Scenario specs
    smoke/health.ortheon.ts
    checkout/authenticated-checkout.ortheon.ts
  environments/     # Environment configs (optional)
    staging.ts
```

## Development

```bash
git clone <repo>
cd ortheon
npm install
npx playwright install chromium

npm test                # 104 unit tests (vitest)
npm run examples        # 3 specs against demo app (19 steps)
npm run demo            # start demo server at :3737
npm run typecheck       # typescript --noEmit
```

## License

MIT
````
