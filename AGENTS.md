# Ortheon

Declarative behavioral spec framework. Two executable primitives: `browser(...)` and `api(...)`. Everything else is structure, data, or assertions.

## Project layout

```
src/
  types.ts           Type system (all types in one file)
  dsl.ts             Builder functions: spec, flow, step, browser, api, expect, use, ref, env, secret, bearer, existsCheck
  compiler.ts        Expand use(), resolve contracts, flatten sections → ExecutionPlan
  validator.ts       Two-pass validation (structural on AST, ref resolution on expanded plan)
  runner.ts          Sequential step execution with retry, save, assert
  context.ts         Runtime save/ref store with dot-path resolution
  reporter.ts        Console + JSON output
  loader.ts          Shared glob resolution and spec file loading (used by CLI and server)
  cli.ts             CLI: ortheon run <glob>, ortheon expand <file>, ortheon serve <glob> [--port] [--base-url]
  index.ts           Public API re-exports
  executors/
    browser.ts       Playwright wrapper (9 actions)
    api.ts           Native fetch wrapper
    assert.ts        5-matcher assertion engine
  server/
    app.ts           Express app: suite discovery, RunManager, 6 API routes, SPA serving
    pages/
      index.html     SPA shell
      styles.css     Dark dev-tool aesthetic
      app.js         Client-side routing, fetch, DOM rendering (dashboard/detail/run views)
demo/                Express app for runnable examples
examples/
  contracts/         API contract catalogs (auth, orders, payments, server)
  data/              Named data catalogs
  flows/             Reusable flows
  specs/             Canonical specs including server self-tests (browse-suites, run-suites)
scripts/             Automation scripts (run-examples, run-server-tests)
tests/               Vitest unit tests (context, assert, compiler, validator, golden, bad-specs, server)
```

## Documentation

- **[README.md](README.md)** -- Installation, quick start, full DSL reference, CLI reference, auth model, scaling doctrine, recommended file structure.
- **[docs/architecture.md](docs/architecture.md)** -- Four-layer architecture (authoring, compilation, execution, server), compiler internals (contract resolution, use() expansion, compile-time ref substitution), validator passes, runtime context mechanics, executor details, server layer (suite discovery, RunManager, SPA), key design decisions.
- **[docs/writing-specs.md](docs/writing-specs.md)** -- Practical authoring guide: contracts, data catalogs, flows, API steps, browser steps, assertions, retries, naming conventions, what not to do.

## Core rules

- Only two executable things: `browser(...)` and `api(...)`. Assertions via `expect(...)`. Reuse via `use(...)`.
- No hidden state. Browser auth and API auth are separate. Tokens must be acquired and passed explicitly via `bearer(ref('token'))`.
- `secret()` values are redacted as `[REDACTED]` in all failure output. `env()` values are not redacted.
- Sequential execution only. A step failure stops the flow.
- Five matchers: `equals`, `contains`, `matches`, `exists`, `notExists`.
- Nine browser actions: `goto`, `click`, `type`, `press`, `select`, `check`, `uncheck`, `waitFor`, `extract`.
- `ref()` paths use dot notation + bracket indexing only. No wildcards, no JSONPath.
- `use()` expanded steps are named `"<caller step> > <inner step>"`. Double-use of the same flow always produces distinct step names.
- Inline `expect.body` existence checks use `existsCheck()`, not the string `"exists"`.
- `save` is uniform: same `{ name: "path" }` shape in both browser and API steps.
- Reusable flows declare their inputs. `flow(name, { inputs, steps })` -- one shape, no overloads.
- `section` is cosmetic grouping only -- not reusable, not independently executable.
- Contract body shapes are documentation only -- not schema-validated.
- Verification of DB state, logs, events, etc. happens through HTTP verification endpoints, not DSL extensions.

## Commands

```bash
npm test              # 134 unit tests
npm run examples      # 3 specs against demo app (19 steps)
npm run demo          # Start demo server at :3737
npm run serve         # Start ortheon web server against examples/
npm run server-tests  # End-to-end self-test of the web server
npm run typecheck     # TypeScript --noEmit
npm run build         # Compile to dist/
```
