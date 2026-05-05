# Agent specs

Agent specs are the second kind of Ortheon spec. Where a behavioral spec describes what must be true about a system (via `browser()` and `api()` steps), an agent spec describes the steps an LLM-driven agent progresses through and the workspace scripts it should be aware of.

---

## Overview

```mermaid
flowchart TD
  GH["GitHub: PR / discussion / comment"] --> ORCH[Orchestrator]
  ORCH -- "parseAgentDispatch(body)" --> ORCH
  ORCH -- "GET /api/suites/:id/execution-plan" --> ORTHEON[Ortheon server]
  ORCH -- "buildAgentPrompt(plan, stepName)" --> ORCH
  ORCH -- "prompt + GITHUB_TOKEN" --> CMD[agent runner]
  CMD -- "Claude output + reply text" --> ORCH
  ORCH -- "post comment: /agent name next-step" --> GH
```

Ortheon's job: author agent specs, compile them to JSON-serializable plans, validate, and serve. The orchestrator owns event watching, history building, and dispatch to the agent runner. The agent runner owns the Claude loop and tool execution (it provides shell access for standard `git`/`gh`/`curl` operations).

---

## Quick example

```ts
import { agent, agentStep, tool } from 'ortheon'

export default agent('deploy-agent', {
  system:
    'You are a deployment bot. You have shell access (git, gh, etc.) ' +
    'so use those for standard developer work. Only call the scripts below for ' +
    'actions not available via the shell.',

  steps: [
    agentStep('plan',
      "Read the PR with `gh pr view` and draft release notes. " +
      "When ready, post '/agent deploy-agent review' to advance."),
    agentStep('review',
      "Post the release notes for review. Ask the user to post " +
      "'/agent deploy-agent ship' once they approve."),
    agentStep('ship',
      'Call trigger-deploy for the production environment. ' +
      'Do not post any /agent line when done; the run is complete.'),
  ],

  tools: [
    tool('trigger-deploy', {
      description: 'Trigger an internal deployment pipeline. Not available via gh/git.',
      path: '/usr/local/bin/trigger-deploy',
      usage: 'trigger-deploy --env <production|staging>',
    }),
  ],
})
```

---

## DSL reference

### `agent(name, config)`

Creates an `AgentSpec`. The name must be kebab-case.

```ts
agent(name: string, config: {
  system: Resolvable<string>
  steps: AgentStep[]      // required, at least one
  tools: Array<ConversationTool | Toolset>
}): AgentSpec
```

### `agentStep(name, prompt)`

Creates an `AgentStep`. The name must be kebab-case and unique within the agent.

```ts
agentStep(name: string, prompt: Resolvable<string>): AgentStep
```

### `tool(name, config)`

Creates a `ConversationTool`. Tools are reserved for scripts/binaries pre-installed in the agent runner's workspace that the agent should be explicitly made aware of. Standard developer tools available via the shell (`git`, `gh`, `curl`, etc.) do not need to be declared here.

```ts
tool(name: string, config: {
  description: Resolvable<string>    // required
  path?: Resolvable<string>          // absolute path inside the workspace
  usage?: Resolvable<string>         // free-form CLI invocation hint
}): ConversationTool
```

`description` is required. `path` must start with `/` if provided as a literal string.

### `toolset(name, tools[])`

Groups tools for sharing across agents. Toolsets are flattened at compile time.

```ts
toolset(name: string, tools: ConversationTool[]): Toolset
```

---

## Compiled `AgentPlan` shape

`compileAgent(spec)` produces:

```ts
type AgentPlan = {
  specName: string
  system: Resolvable<string>      // env()/secret() preserved unresolved
  steps: AgentStep[]
  tools: SerializedTool[]         // workspace-script tool hints
  dispatchReference: string       // auto-generated LLM instructions
}

type SerializedTool = {
  name: string
  description: Resolvable<string>
  path?: Resolvable<string>
  usage?: Resolvable<string>
}
```

Tools are rendered as a markdown "Available scripts" section inside the system prompt by `buildAgentPrompt()`. They are not sent to the Claude API as native tool definitions.

The `dispatchReference` lists the agent name, steps in order, and the `/agent` syntax for keeping or advancing the step. It is included automatically in the output of `buildAgentPrompt()`.

---

## `buildAgentPrompt(plan, stepName)`

Constructs the full system prompt string to send to the agent runner for a given agent run.

```ts
export function buildAgentPrompt(plan: AgentPlan, stepName: string): string
```

Throws if `stepName` is not found among `plan.steps`.

Output format:

```
<system prompt>

Step "<stepName>" (<position> of <total>):
<step prompt>

<dispatchReference rendered for this step>

## Available scripts

These scripts are pre-installed in this workspace. AGENTS.md may describe more —
these are highlighted because the agent spec considers them important for this run.

- trigger-deploy — Trigger an internal deployment pipeline. Not available via gh/git.
  Path:  /usr/local/bin/trigger-deploy
  Usage: trigger-deploy --env <production|staging>
```

The "Available scripts" section is omitted when `plan.tools` is empty.

The dispatch reference section instructs the LLM how to stay on the current step or advance, and warns it not to post any `/agent` line on the final step.

---

## `formatToolsForPrompt(tools)`

Renders a `SerializedTool[]` as the "Available scripts" markdown section. Returns an empty string when the array is empty. Useful when the orchestrator needs to render the tools block independently.

```ts
export function formatToolsForPrompt(tools: SerializedTool[]): string
```

---

## `parseAgentDispatch(text)`

Parses a PR / comment / discussion body for `/agent` dispatch lines.

```ts
export function parseAgentDispatch(text: string): Array<{
  agentName: string
  stepName?: string   // undefined means "start at the first step"
  raw: string
}>
```

Parsing rules:
1. Strip code fences (`` ``` ... ``` ``) and blockquote lines (`> ...`)
2. Match lines with: `^\s*\/agent\s+([a-z0-9][a-z0-9-]*)(?:\s+([a-z0-9][a-z0-9-]*))?\s*$`
3. `stepName` is `undefined` for the bare `/agent <name>` form; the orchestrator treats this as "start at step 1"
4. Results are returned in order of appearance

---

## Step-based dispatch and approval

The step mechanism replaces both explicit workflow gates and separate approval primitives:

- **LLM advances**: the LLM posts `/agent deploy-agent review` in a comment to move to the next step
- **Human approves**: the user posts the same `/agent deploy-agent ship` line to ungate the next step

Both are parsed by the same `parseAgentDispatch()` call in the orchestrator. No special approval primitive is needed.

---

## Validator rules (`validateAgent`)

- `system` must be non-empty (string or dynamic value). `secret()` triggers a warning.
- `steps` must be a non-empty array.
- Each `steps[i].name` must be kebab-case and unique within the agent.
- Each `steps[i].prompt` must be non-empty (or a dynamic value).
- Tool names must be kebab-case and globally unique across all inline tools and toolsets.
- `description` is required and must be non-empty. `secret()` in a description triggers a warning.
- `path` must start with `/` when provided as a literal string.
- `usage` must be non-empty when provided as a literal string.

---

## Server integration

`GET /api/suites/:id/execution-plan` for an agent returns:

```json
{
  "planType": "agent",
  "planVersion": 2,
  "plan": {
    "specName": "deploy-agent",
    "system": "...",
    "steps": [{ "name": "plan", "prompt": "..." }, ...],
    "tools": [
      {
        "name": "trigger-deploy",
        "description": "Trigger an internal deployment pipeline. Not available via gh/git.",
        "path": "/usr/local/bin/trigger-deploy",
        "usage": "trigger-deploy --env <production|staging>"
      }
    ],
    "dispatchReference": "..."
  },
  "validation": { "errors": [], "warnings": [] }
}
```

`GET /api/suites/:id` for an agent returns `stepNames`, `stepCount`, `toolNames`, `toolCount`.

---

## Design notes

**Why dispatch-by-comment instead of workflow gates?**

The previous workflow model required a separate spec type, separate compilation pipeline, explicit `approveBefore`/`approveAfter` fields, and a gate tracking mechanism in the orchestrator. This added complexity without adding expressive power: human approval was always just "a human has to do something before the next step runs."

The dispatch-by-comment model is simpler: the human posts `/agent name step` in a PR comment, and the orchestrator receives it exactly as it would receive an LLM-generated comment. No special cases. The agent spec encodes what the LLM should tell the human to type.

**Why are tools scripts/binaries rather than Anthropic-shaped definitions?**

The agent runner provides shell access. Claude can use `git`, `gh`, `curl`, and any other standard developer tool through that shell. Defining `read-pr` or `merge-pr` as Ortheon tools would duplicate capabilities Claude already has. Tools in Ortheon are reserved for internal APIs, platform-specific integrations, and other scripts that are pre-installed in the workspace but not available as standard shell commands.

Claude does not receive tools as native API tool definitions — they are rendered as markdown in the system prompt ("Available scripts"), which is sufficient for Claude to know to call them via the shell.
