# Agent specs

Agent specs are the second kind of Ortheon spec. Where a behavioral spec describes what must be true about a system (via `browser()` and `api()` steps), an agent spec describes what commands an LLM-driven agent is allowed to emit and how those commands are parsed and dispatched.

The two kinds of spec are distinct. They live in separate files and are loaded, compiled, and validated by separate pipelines that share the same infrastructure (loader, server, CLI).

---

## The command dispatch model

An agent spec defines a **command table**. At runtime, the LLM is expected to emit `/command key="value"` lines in its messages. `runAgentStep()` parses those lines deterministically and returns ordered candidates.

```
user message
     │
     ▼
runAgentStep(plan, { text, source })
     │
     ├── strip code fences + blockquotes
     ├── scan lines for /command ...
     ├── parse key="value" args
     ├── resolve alias → canonical name
     ├── filter by source
     ├── validate args against schema
     │
     ▼
AgentStepResult { candidates: ToolCallResult[] }
     │
     ▼
caller: execute, feed back, or forward to LLM
```

No fuzzy text matching. No regex over prose. A `/command` line either matches a declared tool by exact name (or alias) or it is ignored.

---

## Quick example

```ts
import { agent, tool, env } from "ortheon";

export default agent("bug-reports", {
  system: "You are a bug triage bot. Analyze incoming reports and take action.",

  tools: [
    tool("create-issue", {
      source: "llm",
      args: {
        title: { type: "string", required: true },
        priority: { type: "string" },
      },
      prompt: "Create a GitHub issue with the title and priority provided.",
    }),
    tool("ask-for-repro", {
      source: "llm",
      prompt: `Ask the user for:
- steps to reproduce
- expected vs actual behavior
- environment details`,
    }),
    tool("lookup-docs", {
      aliases: ["docs"],
      source: "any",
      args: { query: { type: "string", required: true } },
    }),
  ],
});
```

The system prompt describes the agent's role. It does **not** list the available commands — that is generated automatically as `plan.commandReference` during compilation. The caller appends it to the system prompt when constructing the LLM call.

After compilation, `plan.commandReference` contains:

```
Commands are available by writing /command key="value" on its own line.

Available commands:
  /create-issue title="<string, required>" priority="<string>"
  /ask-for-repro
  /lookup-docs query="<string, required>"  (aliases: docs)

Rules:
- One command per line, at the start of the line
- Always quote argument values: key="value"
- Do not place commands inside code blocks or block quotes
```

The caller constructs the system prompt by appending the command reference:

```ts
const systemPrompt = plan.system + "\n\n" + plan.commandReference;
```

When the LLM responds with:

```
I'll create the issue for you.

/create-issue title="Order API returns 500 on empty cart" priority="high"
```

`runAgentStep()` produces:

```ts
{
  candidates: [
    {
      name: "create-issue",
      args: { title: "Order API returns 500 on empty cart", priority: "high" },
      raw: '/create-issue title="Order API returns 500 on empty cart" priority="high"',
      prompt: "Create a GitHub issue with the title and priority provided.",
      validation: { valid: true },
    },
  ],
}
```

---

## DSL reference

### `agent(name, config)`

Creates an agent spec. The default export from an `.ortheon.ts` file should be the result of `agent()`.

```ts
export default agent("bug-reports", {
  system: "...",
  tools: [...],
});
```

| Field | Type | Description |
|---|---|---|
| `system` | `string \| EnvValue` | System prompt for the LLM. Use `env()`. See [System prompt guidelines](#system-prompt-guidelines). |
| `tools` | `Array<ConversationTool \| Toolset>` | Declared commands. Toolsets are flattened to a flat command table at compile time. |

### `tool(name, config)`

Declares a command the agent is allowed to emit.

```ts
tool("create-issue", {
  source: "llm",
  aliases: ["issue"],
  args: {
    title: { type: "string", required: true },
    priority: { type: "string" },
  },
  prompt: "Create a GitHub issue.",
})
```

| Field | Type | Default | Description |
|---|---|---|---|
| `source` | `'llm' \| 'user' \| 'tool' \| 'any'` | `'llm'` | Which message source may trigger this command. |
| `aliases` | `string[]` | — | Alternate command names. All identifiers must be unique across all tools and aliases. |
| `args` | `ArgSpec` | — | Argument schema for validation and coercion. |
| `prompt` | `Resolvable<string>` | — | Content returned to the caller in `ToolCallResult.prompt` when this command is dispatched. |
| `requires_approval` | `boolean` | `false` | If `true`, the agent runtime must pause and wait for an external approval before executing this tool. |

**Source values:**

| Value | Meaning |
|---|---|
| `'llm'` | Command is triggered by LLM output (default — prevents user `/command` abuse) |
| `'user'` | Command is triggered by user messages only |
| `'tool'` | Command is triggered by tool result messages only |
| `'any'` | Command is triggered by any source |

### `toolset(name, tools)`

Creates a named, shareable group of tools. Toolsets are the primary mechanism for sharing tools across multiple agent specs.

```ts
// tools/support.ts
export const supportTools = toolset("support", [
  tool("lookup-docs", {
    source: "any",
    args: { query: { type: "string", required: true } },
  }),
  tool("escalate", {
    source: "llm",
    prompt: "Transfer the conversation to a human agent.",
  }),
])
```

Import and include it in an agent's `tools` array:

```ts
// agents/triage.ts
import { supportTools } from "../tools/support.js"

export default agent("triage", {
  system: "You are a triage bot.",
  tools: [supportTools, tool("create-issue", { ... })],
})
```

The compiler flattens toolsets into the flat `SerializedTool[]` in the compiled `AgentPlan`. The toolset name does not appear in the plan or in `commandReference` — it is authoring-time metadata only, visible in `ortheon expand` output.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | kebab-case identifier for the group. Appears in `ortheon expand` output. |
| `tools` | `ConversationTool[]` | The tools in this group. |

**Multiple toolsets** can be mixed with inline tools in any order:

```ts
tools: [ts1, tool("inline-a", { ... }), ts2, tool("inline-b", { ... })]
```

The flattened order in the plan follows the declaration order.

**Cross-toolset name conflicts** are caught by `validateAgent()` — the uniqueness check spans all toolsets and inline tools in a single pass.

---

### Tool sharing patterns

There are three ways to share tool definitions across agent specs:

**1. Named toolset (primary)**

```ts
export const supportTools = toolset("support", [
  tool("lookup-docs", { ... }),
  tool("escalate", { ... }),
])
```

Use when tools logically belong together and you want to see their group in `ortheon expand` output.

**2. Individual tool exports**

```ts
export const lookupDocsTool = tool("lookup-docs", { ... })
export const escalateTool = tool("escalate", { ... })

// In agent:
tools: [lookupDocsTool, escalateTool, tool("create-issue", { ... })]
```

Use when you want to pick individual tools from a larger library.

**3. Factory functions for parameterized variants**

```ts
export const makeSearchTool = (domain: string) =>
  tool(`search-${domain}`, {
    args: { query: { type: "string", required: true } },
    prompt: `Search the ${domain} knowledge base.`,
  })

// In agent:
tools: [makeSearchTool("docs"), makeSearchTool("api")]
```

Use when the same tool shape is needed with different names or prompts per agent. This is plain TypeScript — no new DSL is required.

---

### `ArgSpec`

A record of field names to `ArgField` definitions:

```ts
args: {
  title:       { type: "string",  required: true },
  description: { type: "string" },
  count:       { type: "number" },
  active:      { type: "boolean" },
}
```

| `ArgField` property | Type | Description |
|---|---|---|
| `type` | `'string' \| 'number' \| 'boolean'` | Expected type after coercion |
| `required` | `boolean` | If true, a missing arg produces `validation.valid = false` |

Arg field names must be kebab-case. `number` args are coerced from `"123"` to `123`. `boolean` args accept only `"true"` or `"false"`. Any other value produces a validation error.

Unknown args (not in the schema) pass through as raw strings.

### `prompt` as output payload

`tool.prompt` is not advisory guidance to the LLM. It is a value returned to the **caller** when the command is dispatched. The caller decides what to do with it — append it to the conversation, send it to the LLM as a follow-up, or ignore it.

Typical use: inject a structured instruction back into the conversation immediately after the command fires.

```ts
tool("ask-for-repro", {
  prompt: `Ask the user for:
- steps to reproduce
- expected vs actual behavior
- environment details`,
})
```

`prompt` is `Resolvable<string>`, so `env()` works for externalized prompts. `secret()` is structurally valid but triggers a validator warning (same as for `system`).

---

## `runAgentStep()` API

```ts
import { runAgentStep } from "ortheon";

const result = runAgentStep(plan, { text: message.text, source: "llm" });
```

**Signature:**

```ts
function runAgentStep(plan: AgentPlan, message: AgentMessage): AgentStepResult
```

`AgentPlan` is the output of `compileAgent()`. In remote mode, fetch it from `GET /api/suites/:id/execution-plan`.

### Parsing rules

1. **Strip ignored regions**: content inside code fences (` ``` `) and blockquote lines (`> ...`) is removed before scanning.

2. **Scan lines** with: `^\s*\/([a-z0-9][a-z0-9-]*)(?:\s+(.*?))?\s*$`
   - Must be at the start of a line (leading whitespace is allowed)
   - A command embedded mid-sentence is not matched

3. **Parse args** with: `([a-z0-9][a-z0-9-]*)="([^"]*)"`
   - All pairs are extracted and removed from the line
   - If any non-whitespace remains after extraction, the line is **dropped as malformed**
   - Arg names must be kebab-case

4. **Resolve alias**: if the name matches an alias, it is replaced with the canonical tool name.

5. **Skip unknown names**: if no tool (or alias) matches, the line is ignored.

6. **Filter by source**: if `tool.source` is not `'any'` and does not match `message.source`, the line is ignored.

7. **Validate args**: each arg is checked against the tool's `ArgSpec` (if defined). Required fields, type coercion, and error reporting happen here.

8. **Order**: candidates are returned in the order they appear in the message.

### `AgentMessage`

```ts
type AgentMessage = {
  text: string;
  source: "user" | "llm" | "tool";
}
```

### `ToolCallResult`

```ts
type ToolCallResult = {
  name: string;                    // canonical tool name
  args: Record<string, unknown>;   // coerced arg values
  raw: string;                     // original command line (trimmed)
  prompt?: Resolvable<string>;     // from tool definition, if set
  validation?: {
    valid: boolean;
    errors?: string[];             // e.g. ['missing required arg "title"']
  };
}
```

### `AgentStepResult`

```ts
type AgentStepResult = {
  candidates: ToolCallResult[];
}
```

### Two-level validation

| Level | Behavior |
|---|---|
| Malformed syntax (unquoted value, mid-line command) | Line is silently dropped |
| Schema violation (missing required arg, wrong type) | Candidate is included with `validation.valid = false` |

This keeps the interface observable: the caller always sees what was parseable and can send correction prompts for schema violations.

---

## Caller loop

`runAgentStep()` handles one message at a time. The caller owns the full conversation loop:

```
0. Build system prompt: plan.system + "\n\n" + plan.commandReference
1. Receive user message
2. runAgentStep(plan, { text, source: 'user' })
3. If candidates:
     execute tool calls per caller policy
     feed tool outputs back as { source: 'tool' } messages
     go to step 2
4. If no candidates:
     call LLM with system prompt + context
     runAgentStep(plan, { text: llmReply, source: 'llm' })
     if candidates → step 3
     else post LLM reply to conversation
```

Ortheon provides the dispatch machinery. It does not provide:
- LLM client
- conversation history
- tool execution
- chain depth limits
- error correction prompts

These remain the caller's responsibility by design.

---

## Compile and inspect

### `compileAgent(spec)`

Transforms an `AgentSpec` into a JSON-serializable `AgentPlan`:
- Defaults `source` to `'llm'` for any tool that omits it
- Passes `aliases`, `args`, `prompt`, and `system` through unchanged
- Generates `commandReference` — an LLM-ready string describing the available commands

```ts
import { compileAgent } from "ortheon";

const plan = compileAgent(spec);
// plan.commandReference → "Commands are available by writing /command ..."
```

`AgentPlan` is the value distributed by the server's execution-plan endpoint and consumed by `runAgentStep()`.

### `plan.commandReference`

A pre-formatted string generated from the `tools` array during compilation. Contains the command table (names, arg placeholders, aliases) and formatting rules the LLM needs to emit well-formed commands.

Append it to the system prompt when constructing LLM calls:

```ts
const systemPrompt = plan.system + "\n\n" + plan.commandReference;
```

This keeps the spec's `system` field focused on the agent's role and behavior, while the command syntax is always derived from the tool declarations — no manual duplication, no drift.

When the tool list is empty, `commandReference` is an empty string.

### `ortheon expand <file>`

Prints the command table for an agent spec file. When the spec uses toolsets, they are shown as named groups:

```
Agent: triage
System prompt: You are a triage bot...

  Arg syntax: /command key="value" ...

  [toolset: support]
  command: lookup-docs    source: any
    args: query (string, required)
  command: escalate       source: llm
    prompt: Transfer the conversation to a human agent.

  command: create-issue   source: llm
    args: title (string, required), priority (string)
    prompt: Create a GitHub issue with the title and priority provided.
```

When no toolsets are used:

```
Agent: bug-reports
System prompt: You are a bug triage bot...

  Arg syntax: /command key="value" ...

  command: create-issue   source: llm
    args: title (string, required), priority (string)
    prompt: Create a GitHub issue with the title and priority provided.

  command: ask-for-repro  source: llm
    prompt: Ask the user for:
    - steps to reproduce
    ...

  command: lookup-docs    source: any   aliases: docs
    args: query (string, required)
```

Validation errors and warnings print above the table.

---

## Validation

`validateAgent(spec)` runs structural checks and returns a `ValidationResult`.

**Errors:**

| Rule | Message |
|---|---|
| `system` is an empty string | `agent system prompt must not be empty` |
| Tool name is not kebab-case | `tool name "..." must be kebab-case` |
| Duplicate tool name or alias across all tools (including cross-toolset) | `Duplicate command identifier: "..."` |
| Alias is not kebab-case | `tool("...") alias "..." must be kebab-case` |
| `source` is not a valid value | `tool("...") has invalid source "..."` |
| Arg field name is not kebab-case | `tool("...") arg "..." must be kebab-case` |
| Arg field type is not `string`, `number`, or `boolean` | `tool("...") arg "..." has invalid type "..."` |
| Toolset name is not kebab-case | `toolset name "..." must be kebab-case` |

**Warnings:**

| Rule | Message |
|---|---|
| `system` uses `secret()` | `agent system prompt uses secret() -- ...leakage risk...` |

The validator catches name/alias conflicts globally across all tools and toolsets in a single pass. A tool name cannot be the same as another tool's name or any tool's alias, regardless of which toolset it belongs to.

### `validateToolset(toolset)`

Validates a toolset standalone, before it is composed into an agent. Useful for library authors shipping shared tool groups.

```ts
import { validateToolset } from "ortheon"

const result = validateToolset(supportTools)
if (!result.valid) {
  console.error(result.errors)
}
```

Runs the same per-tool checks as `validateAgent()`, plus the toolset name must be kebab-case. The uniqueness check is scoped to the toolset in isolation — cross-toolset conflicts are caught by `validateAgent()` when the toolset is composed.

---

## Server integration

Agent specs discovered by `ortheon serve` appear alongside behavioral specs in the same suite list. The server compiles and serves agent plans through the same API routes.

**`GET /api/suites`** response for an agent suite:

```json
{
  "id": "...",
  "name": "bug-reports",
  "path": "agents/bug-reports.ortheon.ts",
  "type": "agent",
  "toolCount": 3,
  "hasError": false
}
```

**`GET /api/suites/:id`** response:

```json
{
  "id": "...",
  "name": "bug-reports",
  "type": "agent",
  "toolNames": ["create-issue", "ask-for-repro", "lookup-docs"],
  "toolCount": 3
}
```

**`GET /api/suites/:id/execution-plan`** response:

```json
{
  "planType": "agent",
  "planVersion": 1,
  "plan": {
    "specName": "bug-reports",
    "system": "You are a bug triage bot...",
    "tools": [
      {
        "name": "create-issue",
        "source": "llm",
        "args": {
          "title": { "type": "string", "required": true },
          "priority": { "type": "string" }
        },
        "prompt": "Create a GitHub issue..."
      },
      ...
    ]
  },
  "validation": { "errors": [], "warnings": [] }
}
```

`env()` markers in `system` and `prompt` are preserved unresolved in the plan. The agent runtime resolves them from its own environment.

**`ortheon list`** output:

```
Suites at http://specs.company.com:

ID          NAME          TYPE      INFO
----------  ------------  ------    ----
abc123      bug-reports   [agent]   3 tool(s)
def456      checkout      [spec]    smoke, critical
```

Agent suites cannot be executed with `ortheon run` — they have no steps. They are consumed by an agent runtime that fetches the plan and calls `runAgentStep()`.

---

## System prompt guidelines

The `system` field describes the agent's role and behavioral context. It should **not** list available commands — that information is auto-generated as `plan.commandReference` during compilation.

A good system prompt:

```
You are a bug triage bot. Analyze incoming reports, ask for reproduction steps when needed, and create issues for confirmed bugs.
```

A bad system prompt (duplicates the tool declarations):

```
You are a bug triage bot. Available commands:
/create-issue title="..." priority="high|medium|low"
/ask-for-repro
/lookup-docs query="..."
```

The caller appends `plan.commandReference` to `plan.system` when building the LLM system prompt. This ensures the command table always matches the tool declarations.

```ts
const plan = compileAgent(spec);
const systemPrompt = plan.system + "\n\n" + plan.commandReference;
// pass systemPrompt to your LLM client
```

**Use `env()` for the system prompt** when it is long, environment-specific, or managed outside the codebase:

```ts
agent("bug-reports", {
  system: env("TRIAGE_SYSTEM_PROMPT"),
  tools: [...],
})
```

**Do not use `secret()` for the system prompt.** System prompts are sent to the LLM and appear in logs. The validator warns when `secret()` is used for `system`.

---

## Design notes

### Why deterministic command parsing instead of regex over prose

Regex matching on natural language is fragile. A small phrasing change can silently skip a tool call. Debugging failures requires knowing why a pattern didn't match, which is harder than knowing why a command line wasn't found.

The `/command` model is easier to reason about:
- A command either appears or it does not
- Malformed lines are dropped, not misinterpreted
- Arg validation produces observable errors, not silent misroutes
- The system prompt is the single place to tune LLM behavior
- The command table is inspectable and diffable (`ortheon expand`)

The tradeoff: the LLM must reliably emit well-formed `/command key="value"` lines. Most capable models do this consistently when given clear instructions. When they don't, the caller can detect the failure (empty candidates) and send a correction prompt.

### Why `source` defaults to `'llm'`

Users can type `/command` in a chat interface. Defaulting to `'llm'` prevents user messages from accidentally triggering tool dispatch. Set `source: 'user'` or `source: 'any'` explicitly when user-initiated commands are intentional.

### Why unknown args pass through

Strict mode (rejecting unknown args) is a useful constraint but not always appropriate. An LLM might include an extra arg for context that the caller wants to inspect. Strict mode is left as a future extension rather than baked in as the only behavior.
