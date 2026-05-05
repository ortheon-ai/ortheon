import type { AgentPlan, SerializedTool } from './types.js'
import { formatDispatchReference } from './compiler.js'

// ---------------------------------------------------------------------------
// formatToolsForPrompt
//
// Renders a SerializedTool[] as a markdown "Available scripts" section.
// Returns an empty string when the array is empty (section is omitted).
// ---------------------------------------------------------------------------

export function formatToolsForPrompt(tools: SerializedTool[]): string {
  if (tools.length === 0) return ''

  const lines: string[] = [
    '## Available scripts',
    '',
    'These scripts are pre-installed in this workspace. AGENTS.md may describe more — ' +
    'these are highlighted because the agent spec considers them important for this run.',
    '',
  ]

  for (const t of tools) {
    const descStr = typeof t.description === 'string' ? t.description : JSON.stringify(t.description)
    lines.push(`- ${t.name} — ${descStr}`)
    if (t.path !== undefined) {
      const pathStr = typeof t.path === 'string' ? t.path : JSON.stringify(t.path)
      lines.push(`  Path:  ${pathStr}`)
    }
    if (t.usage !== undefined) {
      const usageStr = typeof t.usage === 'string' ? t.usage : JSON.stringify(t.usage)
      lines.push(`  Usage: ${usageStr}`)
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

// ---------------------------------------------------------------------------
// buildAgentPrompt
//
// Constructs the full system prompt string to pass to the agent runner for a
// given step. stepName must match an AgentStep.name on the plan; throws if
// not found.
//
// Output sections (separated by blank lines):
//   1. System prompt
//   2. Step "<name>" (<i> of <n>): <step prompt>
//   3. dispatchReference (step progression instructions)
//   4. Available scripts (if plan.tools is non-empty)
//
// env() and secret() markers in system and step prompt are passed through
// unresolved. The orchestrator is expected to resolve them from the runtime
// environment, or substitute resolved strings directly.
// ---------------------------------------------------------------------------

export function buildAgentPrompt(plan: AgentPlan, stepName: string): string {
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

  const parts = [
    systemStr,
    '',
    `Step "${stepName}" (${position} of ${total}):`,
    promptStr,
    '',
    dispatchRef,
  ]

  const toolsSection = formatToolsForPrompt(plan.tools)
  if (toolsSection) {
    parts.push('', toolsSection)
  }

  return parts.join('\n')
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
