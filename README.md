# Ortheon

Declarative behavioral contracts for real infrastructure.

## What Ortheon _is_

Ortheon is a **constrained behavioral specification system** whose primary artifact is a canonical spec, not arbitrary test code.

- Specs are authored in TypeScript but behave like data: explicit, constrained, and statically understandable
- The DSL is intentionally **non-programmable**
- **Specs are the canonical source of truth**
- Every spec can be **fully expanded into a fully inlined operational representation**
- **Expanded plans are the normalized operational view** used for execution, debugging, and analysis
- The same spec can be used to test real systems, debug failures, compare intended vs actual behavior, and constrain large-scale rewrites, including LLM-driven ones

**Design goal:** a spec should describe _what must be true about the system_, not _how the system is implemented_.

## What Ortheon is not

Ortheon is not:

- a general-purpose test framework
- a programmable test runner
- a DSL for arbitrary setup or fixture logic
- a direct database, log, or event inspection tool
- a replacement for unit, integration, or contract tests

It is a constrained system for expressing and executing **behavioral contracts over real infrastructure**.

## Constraints (non-negotiable)

Ortheon specs are intentionally limited. Ortheon uses a tiny grammar, stable names, and explicit dependencies because those properties make specs easy to validate, execute, diff, and repair — for both humans and LLMs.

- **No arbitrary code** inside specs — no conditionals, loops, or dynamic construction
- **No custom execution primitives** — only `browser(...)`, `api(...)`, and `expect(...)`
- **No hidden state** — all data must be explicitly saved and referenced
- **No direct infrastructure access** — DB/log/event checks must go through HTTP verification endpoints
- **Specs must be statically understandable** — a spec can be fully expanded without executing it

A spec must be statically understandable by inspection. If understanding a spec requires executing arbitrary user code, the spec is invalid by design. When a behavior cannot be expressed within these constraints, the correct fix is usually to expose a better system surface or verification endpoint — not to make specs more programmable.

## Mental model

```
Spec (canonical) --> Compiler (expansion) --> Runner (execution)
```

- **Spec**: the canonical behavioral source of truth — authored by humans or LLMs
- **Expansion**: a fully inlined operational representation — all `use()` calls resolved, all contracts expanded, all sections flattened; this is what the runner executes and what failures are reported against
- **Runner**: walks the expanded plan sequentially against real systems; a step failure stops the flow immediately

Specs and expanded plans are not interchangeable: specs are authored, plans are derived.

## Example

Ortheon describes long behavioral flows over real systems using only two executable primitives: `browser(...)` and `api(...)`. Steps save named outputs. Later steps assert on them.

```ts
export default spec("guest order via API", {
  baseUrl: env("MY_APP_URL"),
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

## LLM usage

Ortheon is designed to be authored and maintained by LLMs.

The DSL works well for models because it has:

- a small, fixed grammar
- repeated structural patterns
- explicit dataflow via `save` / `ref`
- no hidden behavior
- no arbitrary control flow inside specs

Typical loop:

1. LLM generates a spec
2. Validator returns structured errors
3. LLM repairs the spec
4. Spec is executed against real systems
5. Failures are compared against expectations or against the expanded plan

This makes specs suitable as **behavioral contracts** when modifying or rewriting systems.

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
  baseUrl: env("MY_APP_URL"),
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
MY_APP_URL=http://localhost:3000 ortheon run 'specs/**/*.ortheon.ts'
```

## CLI

Four commands: `run`, `list`, `expand`, and `serve`.

### `ortheon run [glob]`

Two modes:

**Local** — run spec files matching a glob pattern:

```bash
ortheon run 'specs/**/*.ortheon.ts'
```

**Remote** — fetch an execution plan from an Ortheon server and run it locally:

```bash
ortheon run --from http://specs.company.com --suite <id>
```

| Flag                | Description                                        | Default   |
| ------------------- | -------------------------------------------------- | --------- |
| `--from <url>`      | Base URL of an Ortheon server to fetch a plan from | --        |
| `--suite <id>`      | Suite ID to fetch (required with `--from`)         | --        |
| `--reporter <type>` | `console` or `json`                                | `console` |
| `--headed`          | Show the browser window                            | --        |
| `--timeout <ms>`    | Default step timeout                               | `30000`   |
| `--skip-validation` | Skip pre-run validation (local mode only)          | --        |

In remote mode, `env()` and `secret()` values in the plan are resolved from your own environment. The server never sees your secrets.

### `ortheon list`

Discover suites available on a remote Ortheon server:

```bash
ortheon list --from http://specs.company.com
```

| Flag           | Description                    | Default    |
| -------------- | ------------------------------ | ---------- |
| `--from <url>` | Base URL of the Ortheon server | (required) |

Prints a table of suite IDs, names, and tags. Use the ID with `ortheon run --from ... --suite <id>`.

### `ortheon expand <file>`

Print the fully expanded execution plan for a spec. All `use()` calls inlined, all contracts resolved, all sections flattened.

This is a **normalized operational view**, not a second language. Specs are the canonical source of truth. The expanded plan is derived from them — use it for debugging, failure analysis, or when you need a fully explicit representation for LLM consumption.

```
SPEC: authenticated checkout
BASE URL: env("MY_APP_URL")

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

### `ortheon serve <glob>`

Start a local web server for browsing and distributing specs as executable plans.

```bash
ortheon serve 'specs/**/*.ortheon.ts' --port 4000
```

| Flag            | Description       | Default |
| --------------- | ----------------- | ------- |
| `--port <port>` | Port to listen on | `4000`  |

`ORTHEON_SERVER_URL` is set automatically to `http://localhost:<port>` so server self-test specs can reach the Ortheon API.

## Web server

`ortheon serve` discovers all matching spec files once at startup and serves a minimal web UI at `http://localhost:4000`. **The server does not execute specs.** Execution is the CLI's responsibility.

### Trust boundary

| Responsibility     | Owner  |
| ------------------ | ------ |
| Spec authorship    | Server |
| Plan compilation   | Server |
| Plan distribution  | Server |
| Execution          | CLI    |
| env vars / secrets | CLI    |

The server never sees the user's environment variables or secrets. The CLI resolves `env()` and `secret()` markers from its own process environment.

### Views

| Path               | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `/`                | Dashboard -- card grid of all discovered suites                     |
| `/suites/:id`      | Suite detail -- metadata, expanded plan, CLI command, plan download |
| `/contracts`       | Contract catalog                                                    |
| `/contracts/:name` | Contract detail                                                     |

### API routes

All under `/api`. Suite IDs are base64url-encoded relative file paths.

| Method | Path                             | Description                                                                                 |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/api/suites`                    | List all suites, sorted by path. Optional `?name=` (substring) and `?tag=` (exact) filters. |
| GET    | `/api/suites/:id`                | Suite metadata (flowNames, stepCount, apiNames)                                             |
| GET    | `/api/suites/:id/plan`           | Browse-oriented expanded plan + validation diagnostics (for web UI)                         |
| GET    | `/api/suites/:id/execution-plan` | Versioned execution plan artifact for CLI consumption                                       |
| GET    | `/api/contracts`                 | All contracts aggregated across suites                                                      |
| GET    | `/api/contracts/:name`           | Full contract detail                                                                        |

`GET /api/suites/:id/execution-plan` returns:

```json
{
  "planVersion": 1,
  "plan": { "specName": "...", "baseUrl": { "__type": "env", "name": "MY_APP_URL" }, "steps": [...], ... },
  "validation": { "errors": [], "warnings": [] },
  "expectedOutcome": "pass",
  "tags": [],
  "safety": null
}
```

`env()` and `secret()` markers in the plan are preserved unresolved — the CLI resolves them locally.

### Running it

```bash
# Terminal 1: start the app under test
MY_APP_URL=http://localhost:3000 \
  ortheon serve 'specs/**/*.ortheon.ts'

# Open http://localhost:4000
# Then run a suite via CLI:
ortheon run --from http://localhost:4000 --suite <id>

# Or discover suites first:
ortheon list --from http://localhost:4000
```

## DSL reference

### Primitives

| Function                                              | Purpose                          |
| ----------------------------------------------------- | -------------------------------- |
| `spec(name, config)`                                  | Top-level behavioral spec        |
| `flow(name, { inputs?, steps })`                      | Named sequence of steps          |
| `step(name, action, { retries?, retryIntervalMs? }?)` | Single executable step           |
| `section(name, steps)`                                | Cosmetic grouping (not reusable) |

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

```ts
api("createOrder", {
  params: { orderId: ref("orderId") }, // path params: /orders/{orderId}
  query: { page: "1" }, // query string
  headers: { Authorization: bearer(ref("token")) }, // request headers -- use bearer() for tokens
  body: { sku: "sku_123", quantity: 1 }, // request body (JSON)
  expect: {
    status: 201, // assert status code
    body: {
      status: "confirmed", // assert body.status equals 'confirmed'
      id: existsCheck(), // assert body.id is non-null
    },
  },
  save: {
    orderId: "body.id", // save response body field
    order: "body", // save entire body
  },
});
```

### `ref` path syntax

Dot notation and bracket indexing. Nothing else.

```ts
ref("orderId"); // top-level saved value
ref("order.id"); // nested property
ref("order.items[0].sku"); // array indexing
ref("data.user.email"); // data catalog value
```

No wildcards. No filters. No JSONPath. No recursive descent.

## Spec structure

```ts
spec('name', {
  baseUrl: env('MY_APP_URL'),                  // required
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
Spec (canonical) --> Compiler (expansion) --> Runner (execution)
```

- **Spec authoring layer**: Pure functions that produce typed AST nodes. No side effects.
- **Compiler**: Resolves contracts, expands `use()` calls, flattens sections. Emits a flat `ExecutionPlan`. `baseUrl` stays unresolved -- the runner resolves it at execution time.
- **Validator**: Two passes. Pass 1 (structural) runs on raw AST. Pass 2 (ref resolution) runs on the expanded plan.
- **Runner**: Walks the plan sequentially. Resolves dynamic values, executes actions, processes saves, evaluates assertions. A step failure stops the flow immediately.
- **Reporter**: Console output with section headers, pass/fail icons, and durations. JSON output for CI.

## Failure semantics

A step failure stops the current flow immediately and marks the spec failed.

`retries` controls how many extra attempts are made:

```ts
step('flaky verification', api('verifyEffects', { ... }), { retries: 2 })
```

This retries the step up to 2 extra times. By default, retries use linear backoff (500ms × attempt number).

For **polling** — repeatedly checking until a condition is met — use `retryIntervalMs` to set a fixed interval instead:

```ts
step(
  "wait for job to complete",
  api("getJob", {
    params: { jobId: ref("jobId") },
    expect: { status: 200, body: { status: "done" } },
  }),
  { retries: 20, retryIntervalMs: 1000 },
);
```

When `retryIntervalMs` is set, every retry waits exactly that many milliseconds regardless of attempt count. Set it explicitly whenever fixed-interval polling is the intent; omitting it leaves the linear-backoff default in place.

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

npm test                    # 191 unit tests (vitest)
npm run examples            # 3 specs against demo app (19 steps)
npm run dev                 # demo server (:3737) + ortheon web server (:4000), ctrl+c kills both
npm run demo                # start demo server at :3737 only
npm run serve               # start ortheon web server against examples/ only
npm run server-tests        # end-to-end self-test of the web server (browse-suites: API + browser)
npm run cli-remote-tests    # end-to-end test of the remote-plan CLI path (list + fetch plan + run)
npm run typecheck           # typescript --noEmit
```

## License

MIT
