# Architecture

Ortheon has three layers: authoring, compilation, and execution. Each has a single job and a defined boundary.

```
┌─────────────────────────┐
│    Authoring Layer      │
│  spec, flow, step, ...  │  Pure functions → typed AST
│  types.ts, dsl.ts       │
└────────────┬────────────┘
             │  Spec (AST)
┌────────────▼────────────┐
│   Compilation Layer     │
│  compiler.ts            │  Contract resolution, use() expansion,
│  validator.ts           │  section flattening, two-pass validation
└────────────┬────────────┘
             │  ExecutionPlan (flat, inspectable)
┌────────────▼────────────┐
│    Execution Layer      │
│  runner.ts              │  Sequential step execution
│  context.ts             │  Runtime save/ref store
│  executors/browser.ts   │  Playwright wrapper
│  executors/api.ts       │  Native fetch wrapper
│  executors/assert.ts    │  5-matcher assertion engine
│  reporter.ts            │  Console + JSON output
└─────────────────────────┘
```

## Authoring layer

### Types (`src/types.ts`)

All type definitions live in one file. Key concepts:

**Dynamic values** are the only way to reference runtime state:

```ts
RefValue    = { __type: 'ref', path: string }      // saved value reference
EnvValue    = { __type: 'env', name: string }      // environment variable
SecretValue = { __type: 'secret', name: string }   // secret -- redacted in failure output
BearerValue = { __type: 'bearer', value: DynamicValue | string } // resolves to "Bearer <value>"
ExistsCheck = { __type: 'exists_check' }           // existence marker for inline body expects
```

`Resolvable<T>` wraps any value that might be a dynamic value at authoring time but becomes a concrete value at runtime.

**Step actions** are a discriminated union on `__type`:

- `BrowserStep` -- browser interaction
- `ApiStep` -- HTTP API call
- `ExpectStep` -- standalone assertion
- `UseStep` -- flow reuse (expanded at compile time)

**Structural types** hold everything together:

- `Step` -- name + action + optional retries
- `Section` -- cosmetic grouping (chapter heading, not executable unit)
- `Flow` -- named sequence with optional declared inputs
- `Spec` -- top-level document with apis, data, library, and flows

### DSL (`src/dsl.ts`)

Pure builder functions that return typed AST nodes. No side effects, no registration, no global state. Each function is trivial -- it constructs and returns an object literal. The power is in the types, not the functions.

The `browser()` function uses overloads to provide per-action type safety (the `goto` overload requires `url`, the `type` overload requires `target` and `value`, etc.) while the runtime implementation is a single catch-all.

`flow()` has one canonical shape: `flow(name, { inputs?, steps })`. No overloads. Regularity helps LLMs more than ergonomic cleverness.

## Compilation layer

### Compiler (`src/compiler.ts`)

Transforms a `Spec` AST into an `ExecutionPlan` -- a flat, ordered list of executable steps.

**Steps:**

1. **Build flow map** -- collects all flows (both `spec.library` and `spec.flows`) into a lookup map. Library flows are available for `use()` resolution but are not directly executed.

2. **Resolve contracts** -- for each `api("contractName", ...)`, looks up the contract in `spec.apis` and merges its `method` and `path`. Also accepts `"METHOD /path"` format directly.

3. **Expand `use()` calls** -- inlines the referenced flow's steps. Input bindings are applied via compile-time ref substitution: if the login flow uses `ref("email")` internally and the caller provides `{ email: ref("data.user.email") }`, every `ref("email")` in the inlined steps is replaced with `ref("data.user.email")`. Expanded step names are prefixed with the caller step's name to guarantee uniqueness and traceability: `step('browser login', use('login', ...))` produces steps named `"browser login > open login page"`, `"browser login > fill email"`, etc. This means two invocations of the same flow in one spec always produce distinct, debuggable step names.

4. **Flatten sections** -- collapses sections into the parent step list, preserving the section name as metadata on each step.

5. **Emit `ExecutionPlan`** -- the `baseUrl` stays as `Resolvable<string>` (may be an unresolved `env()` value). The runner resolves it at execution time.

The `formatExpandedPlan()` function produces the human-readable expanded output used by `ortheon expand`.

### Validator (`src/validator.ts`)

Two-pass validation, split to avoid the "two almost-compilers" problem.

**Pass 1: Structural (on raw AST, before compilation)**

- Flow names unique within spec (across both `library` and `flows`)
- Step names unique within flow
- Browser action names are valid
- Matcher arity: `exists`/`notExists` take no expected value; `equals`/`contains`/`matches` require one
- Named API targets exist in `spec.apis`
- `use()` targets exist in the flow map
- Save path syntax validity

**Pass 2: Expanded-plan (on compiled `ExecutionPlan`)**

- Every `ref()` traces to a prior `save`, a `data` binding, or a flow input
- Save ordering: a ref does not precede the step that saves it
- Path params in contract paths (`{orderId}`) have corresponding `params` entries
- Step names are unique across the entire expanded plan (catches ambiguous double-use of the same flow)

Contract body shapes are **documentary only** -- not validated. This avoids accidentally building "OpenAPI but smaller and sadder."

## Execution layer

### Runner (`src/runner.ts`)

The main `runSpec()` function:

1. Compiles the spec into an `ExecutionPlan`
2. Validates (both passes)
3. Resolves `baseUrl` (CLI override > spec config > env var)
4. Loads `spec.data` into context
5. Launches browser (lazily, only if any step needs it)
6. Walks steps sequentially:
   - Resolves dynamic values in step options
   - Executes the action
   - Processes saves
   - Evaluates assertions
   - On failure: retries up to `step.retries` times
   - On final failure: stops the flow, skips remaining steps
7. Closes browser
8. Returns `SpecResult`

### Context (`src/context.ts`)

Runtime key-value store with dot-path resolution.

```ts
ctx.set('order', { id: 'abc', items: [{ sku: 'sku_1' }] })
ctx.get('order.id')           // 'abc'
ctx.get('order.items[0].sku') // 'sku_1'
```

`resolve()` dispatches on `__type`:
- `ref` -> look up in store (throws if missing with a clear path message)
- `env` -> `process.env[name]` (throws if missing)
- `secret` -> `process.env[name]`, and records the resolved value in a private `resolvedSecrets` set
- `bearer` -> resolves inner value then returns `"Bearer <value>"`

`resolveDeep()` recursively resolves all dynamic values in an arbitrary object tree. This is how step options get their concrete values at runtime.

`redact(text)` replaces every value that was ever returned by `resolveSecret()` with `[REDACTED]`. Applied to all step failure messages before they are stored in `StepResult.error`. This means secrets never appear in console output, JSON reports, or error strings regardless of where in the request they were used.

`extractFromResponse()` evaluates save paths against an API response:
- `"body"` -> entire response body
- `"body.id"` -> nested property
- `"status"` -> HTTP status code
- `"headers.x-request-id"` -> response header

`loadData()` resolves the spec's `data` block (which may contain `env()` and `secret()` values) and places it under the `"data"` namespace.

### Browser executor (`src/executors/browser.ts`)

Thin Playwright wrapper. Each `BrowserAction` maps to exactly one Playwright call. No abstraction beyond the mapping.

The `extract` action supports four source types:
- `"text"` -> `locator.textContent()`
- `"value"` -> `locator.inputValue()`
- `"html"` -> `locator.innerHTML()`
- `"attr:<name>"` -> `locator.getAttribute(name)`

One `Browser` + `Page` per spec run. Headless by default.

### API executor (`src/executors/api.ts`)

Uses Node 20+ native `fetch`. Path param substitution (`{orderId}` -> concrete value), query string building, JSON body serialization. Header values pass through unchanged -- use `bearer(ref('token'))` in the DSL to produce `"Bearer <token>"` explicitly.

### Assertion engine (`src/executors/assert.ts`)

Five matchers. `deepEqual` for structural comparison. `isSubset` for object `contains`. `matchInlineBody` for the inline `expect.body` blocks on API steps -- each field is checked with `equals`, except values that are an `ExistsCheck` marker (`{ __type: 'exists_check' }`), which check existence instead. Use `existsCheck()` from the DSL to produce this marker.

### Reporter (`src/reporter.ts`)

Console reporter prints section-grouped output with pass/fail icons and durations. JSON reporter emits the full `SpecResult` structure. `consoleSummary` prints a multi-spec summary line.

## Key design decisions

### `existsCheck()` for inline body expectations

Inline `expect.body` blocks use an `ExistsCheck` marker object (`{ __type: 'exists_check' }`) to signal an existence assertion rather than equality. The DSL function is `existsCheck()`. This replaces the earlier approach of using the magic string `"exists"` as a sentinel, which was a collision risk if an API legitimately returned that string as a value. The `exists` and `notExists` matchers remain as named strings in standalone `expect()` steps only.

### `library` vs `flows`

Flows in `spec.flows` are executed directly. Flows in `spec.library` are only available for `use()` resolution. This distinction replaces the more complex "detect which flows are only referenced" heuristic that would have required half the compiler inside the heuristic.

### Compile-time input substitution

When `use("login", { email: ref("data.user.email") })` expands the login flow, the compiler replaces every `ref("email")` inside the inlined steps with `ref("data.user.email")`. This is a compile-time transformation, not a runtime scope mechanism. It means the expanded plan has no unbound flow-input refs and the validator's pass 2 can check ref availability without understanding flow scoping.

### Sequential execution only

Ortheon v1 executes flows sequentially. Parallel steps are intentionally out of scope. This keeps execution semantics, shared state, timing, and debugging simple.

### Auth separation

Browser auth (cookies/session) and API auth (bearer tokens) are separate. The canonical pattern is: acquire the API token through a dedicated `POST /api/auth/login` API step, then pass it explicitly via `headers: { Authorization: bearer(ref('token')) }`. Browser login is for browser-only flows.
