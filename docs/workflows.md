# Workflow specs

Workflow specs are the third kind of Ortheon spec. Where a behavioral spec describes what must be true about a system and an agent spec describes what commands an LLM-driven agent is allowed to emit, a **workflow spec** declares a trigger and an ordered sequence of agent specs to invoke, with optional per-step approval gates.

Workflow specs are **declarative metadata only**. Ortheon compiles and serves them but never executes them. Execution is the responsibility of:
- The **orchestrator service** (schedules runs in response to triggers)
- **cmdland** (drives the agent conversation loop and parks on approval gates)

This design preserves Ortheon's trust boundary: the library only defines structure, not side effects.

---

## Concept

A workflow has two parts:

1. **Trigger** — when the workflow runs (on a GitHub Discussion, a cron schedule, a manual dispatch, or a spawn from another agent)
2. **Steps** — an ordered list of agent specs to invoke, each optionally gated before or after execution

When a gate is declared, the executor (cmdland/orchestrator) pauses the workflow at that point and waits for an external approval to be recorded before proceeding.

---

## Quick example

### Discussion-triggered pipeline

```ts
import { workflow, trigger, workflowStep } from "ortheon";

export default workflow("feature-pipeline", {
  trigger: trigger.discussion({ category: "releases", command: "/ship" }),
  steps: [
    workflowStep.agent("plan-agent"),
    workflowStep.agent("review-agent",  { approveBefore: true }),
    workflowStep.agent("deploy-agent",  { approveBefore: true, approveAfter: true }),
  ],
});
```

### Cron-scheduled pipeline

```ts
import { workflow, trigger, workflowStep } from "ortheon";

export default workflow("nightly-report", {
  trigger: trigger.cron("0 2 * * *"),
  steps: [
    workflowStep.agent("data-collector"),
    workflowStep.agent("report-writer"),
    workflowStep.agent("report-sender"),
  ],
});
```

---

## DSL reference

### `workflow(name, config)`

Creates a workflow spec. The default export from an `.ortheon.ts` file should be the result of `workflow()`.

```ts
export default workflow("feature-pipeline", {
  trigger: trigger.discussion({ category: "releases" }),
  steps: [...],
});
```

| Field | Type | Description |
|---|---|---|
| `trigger` | `WorkflowTrigger` | When the workflow is activated. Use a `trigger.*` builder. |
| `steps` | `WorkflowStep[]` | Ordered agent steps to invoke. Use `workflowStep.agent()` builders. |

---

### `trigger.*`

A namespace of trigger builders. Pass the result as `workflow.trigger`.

#### `trigger.discussion({ category, command? })`

Fires when a GitHub Discussion is opened (or labeled) in the specified category.

```ts
trigger.discussion({ category: "releases" })
trigger.discussion({ category: "bugs", command: "/triage" })
```

| Field | Type | Description |
|---|---|---|
| `category` | `string` | Discussion category name (required, non-empty). |
| `command` | `string` | Optional command prefix that must appear in the discussion body. |

#### `trigger.cron(expr)`

Fires on a cron schedule. The expression must be a standard 5-field cron string (`min hour dom month dow`).

```ts
trigger.cron("0 9 * * 1")       // 9 AM every Monday
trigger.cron("*/15 * * * *")    // every 15 minutes
```

#### `trigger.manual()`

Fires only when explicitly dispatched by the orchestrator (no automatic schedule).

```ts
trigger.manual()
```

#### `trigger.spawn({ maxDepth })`

Fires when another agent explicitly spawns this workflow. `maxDepth` limits recursive spawning.

```ts
trigger.spawn({ maxDepth: 2 })
```

| Field | Type | Description |
|---|---|---|
| `maxDepth` | `number` | Maximum spawn depth (integer >= 1). |

---

### `workflowStep.agent(specName, config?)`

Declares a step that runs the named agent spec.

```ts
workflowStep.agent("plan-agent")
workflowStep.agent("review-agent", { approveBefore: true })
workflowStep.agent("deploy-agent", { approveBefore: true, approveAfter: true })
```

| Field | Type | Default | Description |
|---|---|---|---|
| `specName` | `string` | — | kebab-case name of the agent spec to invoke. The orchestrator resolves this to the compiled `AgentPlan`. |
| `approveBefore` | `boolean` | `false` | If `true`, the executor parks the workflow before running this step until an approval is recorded. Not allowed on the first step. |
| `approveAfter` | `boolean` | `false` | If `true`, the executor parks the workflow after running this step until an approval is recorded. |

---

## Compile and inspect

### `compileWorkflow(spec)`

Transforms a `WorkflowSpec` into a `WorkflowPlan`:
- Passes `trigger` and `steps` through unchanged
- Derives the flat `gates` array from `approveBefore` / `approveAfter` declarations on each step

```ts
import { compileWorkflow } from "ortheon";

const plan = compileWorkflow(spec);
// plan.gates → [{ stepIndex: 1, position: 'before' }, ...]
```

`WorkflowPlan` is the value distributed by the server's execution-plan endpoint (plan 02) and consumed by the orchestrator and cmdland.

### `ortheon expand <file>`

Prints the workflow plan for a workflow spec file:

```
Workflow: feature-pipeline
Trigger:  discussion(category: "releases", command: "/ship")

Steps (3):
    1. agent: plan-agent
    2. agent: review-agent   [approveBefore]
    3. agent: deploy-agent   [approveBefore, approveAfter]
```

When validation fails, errors print above the plan.

---

## Validator rules

`validateWorkflow(spec)` returns a `ValidationResult`.

**Errors:**

| Rule | Message |
|---|---|
| `steps` array is empty | `workflow must have at least one step` |
| Trigger `kind` is not one of `discussion`, `cron`, `manual`, `spawn` | `unknown trigger kind: "..."` |
| `trigger.discussion` has empty `category` | `trigger.discussion requires a non-empty category` |
| `trigger.cron` expr is not a valid 5-field cron string | `trigger.cron expr "..." is not a valid 5-field cron expression` |
| `trigger.spawn` has `maxDepth` < 1 | `trigger.spawn requires maxDepth >= 1` |
| A step `specName` is not kebab-case | `step[N]: specName "..." must be kebab-case` |
| First step has `approveBefore: true` | `step[0]: approveBefore on the first step is not allowed` |

The orchestrator performs the authoritative cron parse via croniter when it syncs workflows from Ortheon's `respond` endpoint. The validator here uses a lightweight regex to catch obvious mistakes early.

---

## Server integration

`ortheon serve` exposes workflow plans through the same API endpoint pattern as agent and behavioral plans.

**`GET /api/suites`** — includes workflow suites with `type: "workflow"`, `stepCount`, and `triggerKind`.

**`GET /api/suites/:id`** — returns workflow metadata: `trigger`, `stepNames`, `stepCount`, `gateCount`.

**`GET /api/suites/:id/plan`** — returns `planType: "workflow"` with the compiled `WorkflowPlan`, validation diagnostics, and a `renderedPlan` string for display.

**`GET /api/suites/:id/execution-plan`** — returns `planType: "workflow"`, `planVersion: 1`, and the compiled `WorkflowPlan`. The orchestrator service fetches these plans on startup (or on schedule) to register triggers and build the run queue.

Workflow specs cannot be run with `ortheon run` — they are consumed exclusively by the orchestrator and cmdland.
