import type { AgentPlan, SerializedTool } from './types.js'
import { formatDispatchReference } from './compiler.js'

// ---------------------------------------------------------------------------
// buildAgentPrompt
//
// Constructs the system prompt and tool list to pass to the agent runner for
// a given step. stepName must match an AgentStep.name on the plan; throws if
// not found.
//
// env() and secret() markers in system and step prompt are passed through
// unresolved. The orchestrator is expected to resolve them from the runtime
// environment before calling this function, or to substitute resolved strings
// directly.
// ---------------------------------------------------------------------------

export type AgentPromptPayload = {
  prompt: string
  tools: SerializedTool[]
}

export function buildAgentPrompt(plan: AgentPlan, stepName: string): AgentPromptPayload {
  const idx = plan.steps.findIndex(s => s.name === stepName)
  if (idx === -1) {
    throw new Error(
      `Agent "${plan.specName}" has no step named "${stepName}". ` +
      `Available steps: ${plan.steps.map(s => s.name).join(', ')}`
    )
  }

  const step = plan.steps[idx]!
  const total = plan.steps.length
  const position = idx + 1

  const systemStr = typeof plan.system === 'string'
    ? plan.system
    : JSON.stringify(plan.system)

  const promptStr = typeof step.prompt === 'string'
    ? step.prompt
    : JSON.stringify(step.prompt)

  const dispatchRef = formatDispatchReference(plan.specName, plan.steps, stepName)

  const prompt = [
    systemStr,
    '',
    `Step "${stepName}" (${position} of ${total}):`,
    promptStr,
    '',
    dispatchRef,
  ].join('\n')

  return { prompt, tools: plan.tools }
}

// ---------------------------------------------------------------------------
// parseAgentDispatch
//
// Parses a PR / comment / discussion body for /agent [agent-name] [step-name?]
// dispatch lines.
//
// Parsing rules:
//   1. Strip code fences (``` ... ```) and blockquote lines (> ...)
//   2. Scan lines with: ^\s*\/agent\s+([a-z0-9][a-z0-9-]*)(?:\s+([a-z0-9][a-z0-9-]*))?\s*$
//   3. Returns one entry per matched line, in order
//   4. stepName is undefined when the bare form (/agent <name>) is used;
//      the orchestrator treats undefined as "start at the first step"
// ---------------------------------------------------------------------------

const DISPATCH_LINE_RE = /^\s*\/agent\s+([a-z0-9][a-z0-9-]*)(?:\s+([a-z0-9][a-z0-9-]*))?\s*$/

export type AgentDispatch = {
  agentName: string
  stepName?: string
  raw: string
}

function stripIgnoredRegions(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inFence = false

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^\s*>/.test(line)) continue
    result.push(line)
  }

  return result.join('\n')
}

export function parseAgentDispatch(text: string): AgentDispatch[] {
  const stripped = stripIgnoredRegions(text)
  const dispatches: AgentDispatch[] = []

  for (const line of stripped.split('\n')) {
    const m = DISPATCH_LINE_RE.exec(line)
    if (m === null) continue

    dispatches.push({
      agentName: m[1]!,
      ...(m[2] !== undefined ? { stepName: m[2] } : {}),
      raw: line.trim(),
    })
  }

  return dispatches
}
