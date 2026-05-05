# Ortheon

Declarative behavioral spec framework. Two executable primitives: `browser(...)` and `api(...)`. Everything else is structure, data, or assertions.

## Project layout

```
src/
  types.ts           Type system (all types in one file)
  types.ts           Type system (all types in one file)
  dsl.ts             Builder functions: spec, flow, step, browser, api, expect, use, ref, env, secret, bearer, existsCheck, agent, agentStep, tool, toolset
  compiler.ts        Expand use(), resolve contracts, flatten sections → ExecutionPlan; compileAgent() → AgentPlan with Anthropic-shaped tools + dispatchReference
  validator.ts       Two-pass validation (structural on AST, ref resolution on expanded plan); validateAgent()
  agent.ts           Agent helpers: buildAgentPrompt(), parseAgentDispatch()
  runner.ts          Sequential step execution with retry, save, assert; runSpec() + runPlan()
  context.ts         Runtime save/ref store with dot-path resolution
  reporter.ts        Console + JSON output
  loader.ts          Shared glob resolution and spec file loading (used by CLI and server)
  cli.ts             CLI: ortheon run [glob|--from+--suite], ortheon list --from, ortheon expand <file>, ortheon serve <glob> [--port]
  index.ts           Public API re-exports
  executors/
    browser.ts       Playwright wrapper (9 actions)
    api.ts           Native fetch wrapper
    assert.ts        5-matcher assertion engine
  server/
    app.ts           Express app: suite discovery, 6 API routes, SPA serving (no execution, no run tracking)
    pages/
      index.html     SPA shell
      styles.css     Dark dev-tool aesthetic
      app.js         Client-side routing, fetch, DOM rendering (dashboard/suite-detail/contracts)
demo/                Express app for runnable examples
examples/
  contracts/         API contract catalogs (auth, orders, payments, server)
  data/              Named data catalogs
  flows/             Reusable flows
  specs/             Canonical specs including server self-test (browse-suites)
scripts/             Automation scripts (run-examples, run-server-tests)
tests/               Vitest unit tests (context, assert, compiler, validator, golden, bad-specs, server, runner)
```

## Documentation

- **[README.md](README.md)** -- Installation, quick start, full DSL reference, CLI reference, auth model, scaling doctrine, recommended file structure.
- **[docs/architecture.md](docs/architecture.md)** -- Four-layer architecture (authoring, compilation, execution, server), compiler internals (contract resolution, use() expansion, compile-time ref substitution), validator passes, runtime context mechanics, executor details, server layer (trust boundary, plan distribution, execution-plan artifact), key design decisions.
- **[docs/writing-specs.md](docs/writing-specs.md)** -- Practical authoring guide: contracts, data catalogs, flows, API steps, browser steps, assertions, retries, naming conventions, what not to do.
- **[docs/agents.md](docs/agents.md)** -- Agent spec full reference: step-based dispatch model, tool config, toolset composition, buildAgentPrompt(), parseAgentDispatch(), validation, server integration.

## Architecture: server vs CLI

The server is a **spec registry and plan distributor**, not an executor:
- Server owns: spec files, compilation, validation, plan distribution
- CLI owns: execution, env vars, secrets, reporting

Two CLI execution modes:
```bash
ortheon run 'specs/**/*.ortheon.ts'              # local mode: compile + run from files
ortheon run --from http://server --suite <id>    # remote mode: fetch plan, run locally
```

`runPlan(plan, options)` is the entry point for remote-mode execution. `runSpec(spec, options)` is for local mode. Both share the same internal execution engine.

## Workflow

When it makes sense, follow a red/green testing loop using the example specs in `examples/specs/`:

1. **Red** -- Run `npm run examples` (or the relevant subset) and confirm the test(s) that cover your change are failing or not yet present. If a spec doesn't exist for the behavior you're adding or fixing, write one first in `examples/specs/` and verify it fails.
2. **Implement** -- Make the minimal code change.
3. **Green** -- Run `npm run examples` again and confirm the new/changed spec passes. Also run `npm test` to ensure no unit-test regressions.

Do this on every change, no matter how small. Never skip to implementation without first establishing a failing spec.

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
- Reusable tool groups use `toolset(name, tools[])`. Toolsets are flattened to a flat Anthropic-shaped tool array at compile time.
- Agent tools are reserved for actions that cannot be performed through cmdland's shell access. Standard `git`/`gh`/`curl` operations are not modeled as tools.
- `section` is cosmetic grouping only -- not reusable, not independently executable.
- Contract body shapes are documentation only -- not schema-validated.
- Verification of DB state, logs, events, etc. happens through HTTP verification endpoints, not DSL extensions.
- The server never executes specs. Execution happens in the CLI only.

## Commands

```bash
npm test                  # unit tests
npm run examples          # 3 specs against demo app (19 steps)
npm run demo              # Start demo server at :3737
npm run serve             # Start ortheon web server against examples/
npm run server-tests      # End-to-end self-test of the web server (browse-suites only, API + browser)
npm run cli-remote-tests  # End-to-end test of the remote-plan CLI path (list + fetch + runPlan)
npm run typecheck         # TypeScript --noEmit
npm run build             # Compile to dist/
```
