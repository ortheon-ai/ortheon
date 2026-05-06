import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { agent, agentStep, tool, toolset, env, secret } from '../src/dsl.js'
import { compileAgent, formatAgentSpec, formatDispatchReference } from '../src/compiler.js'
import { validateAgent, validateToolset } from '../src/validator.js'
import { buildAgentPrompt, parseAgentDispatch, formatToolsForPrompt } from '../src/agent.js'
import { createApp, type ServerSuite } from '../src/server/app.js'
import type { AgentSpec, AgentPlan } from '../src/types.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const deployAgent: AgentSpec = agent('deploy-agent', {
  system: 'You are a deployment bot.',
  steps: [
    agentStep('plan', 'Draft release notes using `gh pr view`.'),
    agentStep('review', 'Post the notes for review and ask the user to post /agent deploy-agent ship.'),
    agentStep('ship', 'Call trigger-deploy. Do not post any /agent line when done.'),
  ],
  tools: [
    tool('trigger-deploy', {
      description: 'Trigger an internal deployment pipeline. Not available via gh/git.',
      path: '/usr/local/bin/trigger-deploy',
      usage: 'trigger-deploy --env <production|staging>',
    }),
  ],
})

function makeAgentSuite(id: string, s: AgentSpec, overrides?: Partial<ServerSuite>): ServerSuite {
  return {
    id,
    name: s.name,
    path: `/test/${id}.ts`,
    relativePath: `test/${id}.ts`,
    kind: 'agent',
    spec: null,
    agentSpec: s,
    loadError: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// DSL builders
// ---------------------------------------------------------------------------

describe('agent() / agentStep() / tool() DSL', () => {
  it('agent() produces __type: agent', () => {
    expect(deployAgent.__type).toBe('agent')
  })

  it('agent() sets name, system, steps, tools', () => {
    expect(deployAgent.name).toBe('deploy-agent')
    expect(typeof deployAgent.system).toBe('string')
    expect(deployAgent.steps).toHaveLength(3)
    expect(deployAgent.tools).toHaveLength(1)
  })

  it('agentStep() produces correct name and prompt', () => {
    const s = agentStep('my-step', 'Do the thing.')
    expect(s.name).toBe('my-step')
    expect(s.prompt).toBe('Do the thing.')
    expect(s.requiresApproval).toBeUndefined()
  })

  it('agentStep() with requiresApproval: true sets the flag', () => {
    const s = agentStep('plan', 'Draft a plan.', { requiresApproval: true })
    expect(s.requiresApproval).toBe(true)
  })

  it('agentStep() with requiresApproval: false omits the flag', () => {
    const s = agentStep('go', 'Go.', { requiresApproval: false })
    expect('requiresApproval' in s).toBe(false)
  })

  it('tool() preserves name, description, path, usage', () => {
    const t = deployAgent.tools[0]!
    expect(t.name).toBe('trigger-deploy')
    expect(t.description).toContain('deployment pipeline')
    expect(t.path).toBe('/usr/local/bin/trigger-deploy')
    expect(t.usage).toBe('trigger-deploy --env <production|staging>')
  })

  it('tool() without optional fields omits path and usage', () => {
    const t = tool('bare', { description: 'A bare tool.' })
    expect('path' in t).toBe(false)
    expect('usage' in t).toBe(false)
  })

  it('tool() with only path omits usage', () => {
    const t = tool('path-only', { description: 'Has a path.', path: '/usr/local/bin/path-only' })
    expect(t.path).toBe('/usr/local/bin/path-only')
    expect('usage' in t).toBe(false)
  })

  it('agent() accepts env() as system', () => {
    const s = agent('env-agent', { system: env('SYSTEM_PROMPT'), steps: [agentStep('go', 'do it')], tools: [] })
    expect(s.system).toEqual({ __type: 'env', name: 'SYSTEM_PROMPT' })
  })
})

// ---------------------------------------------------------------------------
// compileAgent
// ---------------------------------------------------------------------------

describe('compileAgent()', () => {
  let plan: AgentPlan

  beforeAll(() => {
    plan = compileAgent(deployAgent)
  })

  it('sets specName', () => {
    expect(plan.specName).toBe('deploy-agent')
  })

  it('passes system through unchanged', () => {
    expect(plan.system).toBe('You are a deployment bot.')
  })

  it('copies steps array', () => {
    expect(plan.steps).toHaveLength(3)
    expect(plan.steps[0]!.name).toBe('plan')
    expect(plan.steps[1]!.name).toBe('review')
    expect(plan.steps[2]!.name).toBe('ship')
  })

  it('tool has name, description, path, usage', () => {
    const t = plan.tools[0]!
    expect(t.name).toBe('trigger-deploy')
    expect(t.description).toBe('Trigger an internal deployment pipeline. Not available via gh/git.')
    expect(t.path).toBe('/usr/local/bin/trigger-deploy')
    expect(t.usage).toBe('trigger-deploy --env <production|staging>')
  })

  it('tool without optional fields omits path and usage in plan', () => {
    const s = agent('a', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('ping', { description: 'Ping.' })],
    })
    const p = compileAgent(s)
    expect('path' in p.tools[0]!).toBe(false)
    expect('usage' in p.tools[0]!).toBe(false)
  })

  it('preserves env() markers in system', () => {
    const s = agent('env-agent', { system: env('SYS'), steps: [agentStep('go', 'go')], tools: [] })
    const p = compileAgent(s)
    expect(p.system).toEqual({ __type: 'env', name: 'SYS' })
  })

  it('generates dispatchReference string', () => {
    expect(typeof plan.dispatchReference).toBe('string')
    expect(plan.dispatchReference).toContain('deploy-agent')
    expect(plan.dispatchReference).toContain('plan')
    expect(plan.dispatchReference).toContain('review')
    expect(plan.dispatchReference).toContain('ship')
  })
})

// ---------------------------------------------------------------------------
// compileAgent with toolsets
// ---------------------------------------------------------------------------

describe('compileAgent() with toolsets', () => {
  it('flattens toolset tools into the plan', () => {
    const ts = toolset('ops', [
      tool('notify', { description: 'Notify team.' }),
      tool('flag', { description: 'Toggle flag.' }),
    ])
    const s = agent('bot', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [ts, tool('inline', { description: 'Inline tool.' })],
    })
    const p = compileAgent(s)
    expect(p.tools.map(t => t.name)).toEqual(['notify', 'flag', 'inline'])
  })

  it('each flattened tool preserves description', () => {
    const ts = toolset('ops', [tool('notify', { description: 'Notify team.' })])
    const s = agent('bot', { system: 'hi', steps: [agentStep('go', 'go')], tools: [ts] })
    const p = compileAgent(s)
    expect(p.tools[0]!.description).toBe('Notify team.')
  })
})

// ---------------------------------------------------------------------------
// formatDispatchReference
// ---------------------------------------------------------------------------

describe('formatDispatchReference()', () => {
  it('renders step list', () => {
    const steps = [agentStep('plan', 'p'), agentStep('ship', 's')]
    const ref = formatDispatchReference('my-agent', steps)
    expect(ref).toContain('my-agent')
    expect(ref).toContain('plan')
    expect(ref).toContain('ship')
  })

  it('marks current step', () => {
    const steps = [agentStep('plan', 'p'), agentStep('ship', 's')]
    const ref = formatDispatchReference('my-agent', steps, 'plan')
    expect(ref).toContain('plan')
    expect(ref).toContain('(current)')
  })

  it('shows "advance to next step" for a non-final step', () => {
    const steps = [agentStep('plan', 'p'), agentStep('ship', 's')]
    const ref = formatDispatchReference('my-agent', steps, 'plan')
    expect(ref).toContain('/agent my-agent ship')
  })

  it('shows "do not post" instruction on the final step', () => {
    const steps = [agentStep('plan', 'p'), agentStep('ship', 's')]
    const ref = formatDispatchReference('my-agent', steps, 'ship')
    expect(ref).toContain('final step')
    expect(ref).not.toContain('/agent my-agent plan')
  })

  it('returns empty string for empty steps array', () => {
    expect(formatDispatchReference('my-agent', [])).toBe('')
  })

  it('approval-gated step instructs the agent NOT to self-advance', () => {
    const steps = [
      agentStep('plan', 'p', { requiresApproval: true }),
      agentStep('ship', 's'),
    ]
    const ref = formatDispatchReference('my-agent', steps, 'plan')
    expect(ref).toContain('requires human approval')
    expect(ref).toContain('Do not post a /agent dispatch line yourself')
    expect(ref).not.toContain('To advance to the next step, post:')
    expect(ref).not.toContain('To keep working on the current step, post')
  })

  it('approval-gated step still names the next step in user-facing instructions', () => {
    const steps = [
      agentStep('plan', 'p', { requiresApproval: true }),
      agentStep('ship', 's'),
    ]
    const ref = formatDispatchReference('my-agent', steps, 'plan')
    expect(ref).toContain('/agent my-agent ship')
    expect(ref).toContain('/agent my-agent plan')
  })

  it('approval flag has no effect on a non-active step', () => {
    const steps = [
      agentStep('plan', 'p', { requiresApproval: true }),
      agentStep('ship', 's'),
    ]
    const ref = formatDispatchReference('my-agent', steps, 'ship')
    expect(ref).not.toContain('requires human approval')
    expect(ref).toContain('final step')
  })

  it('approval flag is ignored on the final step (no next step to gate)', () => {
    const steps = [
      agentStep('plan', 'p'),
      agentStep('ship', 's', { requiresApproval: true }),
    ]
    const ref = formatDispatchReference('my-agent', steps, 'ship')
    expect(ref).not.toContain('requires human approval')
    expect(ref).toContain('final step')
  })

  it('non-gated step preserves the existing wording (regression)', () => {
    const steps = [agentStep('plan', 'p'), agentStep('ship', 's')]
    const ref = formatDispatchReference('my-agent', steps, 'plan')
    expect(ref).toContain('To keep working on the current step, post a comment containing exactly:')
    expect(ref).toContain('To advance to the next step, post:')
    expect(ref).not.toContain('requires human approval')
  })
})

// ---------------------------------------------------------------------------
// buildAgentPrompt
// ---------------------------------------------------------------------------

describe('buildAgentPrompt()', () => {
  let plan: AgentPlan

  beforeAll(() => {
    plan = compileAgent(deployAgent)
  })

  it('throws when step name is not found', () => {
    expect(() => buildAgentPrompt(plan, 'nonexistent')).toThrow('no step named "nonexistent"')
  })

  it('returns a string', () => {
    expect(typeof buildAgentPrompt(plan, 'plan')).toBe('string')
  })

  it('includes the system prompt', () => {
    const prompt = buildAgentPrompt(plan, 'plan')
    expect(prompt).toContain('You are a deployment bot.')
  })

  it('includes the step name and position for first step', () => {
    const prompt = buildAgentPrompt(plan, 'plan')
    expect(prompt).toContain('Step "plan" (1 of 3)')
    expect(prompt).toContain('Draft release notes')
  })

  it('includes the step name and position for a middle step', () => {
    const prompt = buildAgentPrompt(plan, 'review')
    expect(prompt).toContain('Step "review" (2 of 3)')
  })

  it('includes the step name and position for the last step', () => {
    const prompt = buildAgentPrompt(plan, 'ship')
    expect(prompt).toContain('Step "ship" (3 of 3)')
  })

  it('includes the dispatch reference in the output', () => {
    const prompt = buildAgentPrompt(plan, 'plan')
    expect(prompt).toContain('deploy-agent')
    expect(prompt).toContain('(current)')
  })

  it('shows the next-step dispatch line for a non-final step', () => {
    const prompt = buildAgentPrompt(plan, 'plan')
    expect(prompt).toContain('/agent deploy-agent review')
  })

  it('shows "do not post" on the final step', () => {
    const prompt = buildAgentPrompt(plan, 'ship')
    expect(prompt).toContain('final step')
  })

  it('includes "Available scripts" section when tools are present', () => {
    const prompt = buildAgentPrompt(plan, 'plan')
    expect(prompt).toContain('Available scripts')
    expect(prompt).toContain('trigger-deploy')
    expect(prompt).toContain('Trigger an internal deployment pipeline')
  })

  it('includes path and usage in Available scripts section', () => {
    const prompt = buildAgentPrompt(plan, 'plan')
    expect(prompt).toContain('/usr/local/bin/trigger-deploy')
    expect(prompt).toContain('trigger-deploy --env <production|staging>')
  })

  it('omits "Available scripts" section when plan has no tools', () => {
    const p = compileAgent(agent('bare', { system: 'hi', steps: [agentStep('go', 'go')], tools: [] }))
    const prompt = buildAgentPrompt(p, 'go')
    expect(prompt).not.toContain('Available scripts')
  })

  it('prompt is consistent across different step names (same tools)', () => {
    const p1 = buildAgentPrompt(plan, 'plan')
    const p2 = buildAgentPrompt(plan, 'ship')
    expect(p1).toContain('trigger-deploy')
    expect(p2).toContain('trigger-deploy')
  })
})

// ---------------------------------------------------------------------------
// formatToolsForPrompt
// ---------------------------------------------------------------------------

describe('formatToolsForPrompt()', () => {
  it('returns empty string for empty tools array', () => {
    expect(formatToolsForPrompt([])).toBe('')
  })

  it('renders tool name and description', () => {
    const tools = [{ name: 'my-tool', description: 'Does something.' }]
    const out = formatToolsForPrompt(tools)
    expect(out).toContain('my-tool')
    expect(out).toContain('Does something.')
  })

  it('renders path when present', () => {
    const tools = [{ name: 'my-tool', description: 'Does something.', path: '/usr/local/bin/my-tool' }]
    const out = formatToolsForPrompt(tools)
    expect(out).toContain('Path:')
    expect(out).toContain('/usr/local/bin/my-tool')
  })

  it('renders usage when present', () => {
    const tools = [{ name: 'my-tool', description: 'Does something.', usage: 'my-tool --flag' }]
    const out = formatToolsForPrompt(tools)
    expect(out).toContain('Usage:')
    expect(out).toContain('my-tool --flag')
  })

  it('omits Path: line when path is absent', () => {
    const tools = [{ name: 'my-tool', description: 'Does something.' }]
    const out = formatToolsForPrompt(tools)
    expect(out).not.toContain('Path:')
  })

  it('includes the "Available scripts" heading', () => {
    const tools = [{ name: 'my-tool', description: 'Does something.' }]
    const out = formatToolsForPrompt(tools)
    expect(out).toContain('## Available scripts')
  })

  it('renders multiple tools', () => {
    const tools = [
      { name: 'tool-a', description: 'Tool A.' },
      { name: 'tool-b', description: 'Tool B.' },
    ]
    const out = formatToolsForPrompt(tools)
    expect(out).toContain('tool-a')
    expect(out).toContain('tool-b')
  })
})

// ---------------------------------------------------------------------------
// parseAgentDispatch
// ---------------------------------------------------------------------------

describe('parseAgentDispatch()', () => {
  it('parses a bare /agent name line', () => {
    const result = parseAgentDispatch('/agent my-agent')
    expect(result).toHaveLength(1)
    expect(result[0]!.agentName).toBe('my-agent')
    expect(result[0]!.stepName).toBeUndefined()
    expect(result[0]!.raw).toBe('/agent my-agent')
  })

  it('parses a /agent name step-name line', () => {
    const result = parseAgentDispatch('/agent deploy-agent plan')
    expect(result).toHaveLength(1)
    expect(result[0]!.agentName).toBe('deploy-agent')
    expect(result[0]!.stepName).toBe('plan')
  })

  it('parses multiple dispatch lines in order', () => {
    const text = [
      '/agent my-agent step-one',
      'Some text',
      '/agent other-agent step-two',
    ].join('\n')
    const result = parseAgentDispatch(text)
    expect(result).toHaveLength(2)
    expect(result[0]!.agentName).toBe('my-agent')
    expect(result[0]!.stepName).toBe('step-one')
    expect(result[1]!.agentName).toBe('other-agent')
    expect(result[1]!.stepName).toBe('step-two')
  })

  it('skips lines inside code fences', () => {
    const text = [
      'Some prose.',
      '```',
      '/agent my-agent plan',
      '```',
      'End of prose.',
    ].join('\n')
    const result = parseAgentDispatch(text)
    expect(result).toHaveLength(0)
  })

  it('skips blockquote lines', () => {
    const text = '> /agent my-agent plan\nnormal'
    const result = parseAgentDispatch(text)
    expect(result).toHaveLength(0)
  })

  it('drops malformed lines (mid-line dispatch)', () => {
    const result = parseAgentDispatch('some text /agent my-agent plan')
    expect(result).toHaveLength(0)
  })

  it('handles leading whitespace before /agent', () => {
    const result = parseAgentDispatch('  /agent my-agent plan')
    expect(result).toHaveLength(1)
    expect(result[0]!.agentName).toBe('my-agent')
  })

  it('returns empty array when no dispatch lines found', () => {
    const result = parseAgentDispatch('just some prose\nno commands here')
    expect(result).toHaveLength(0)
  })

  it('preserves raw text in the result', () => {
    const result = parseAgentDispatch('/agent my-agent review')
    expect(result[0]!.raw).toBe('/agent my-agent review')
  })
})

// ---------------------------------------------------------------------------
// validateAgent
// ---------------------------------------------------------------------------

describe('validateAgent()', () => {
  it('passes a valid agent spec', () => {
    const result = validateAgent(deployAgent)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('errors on empty string system prompt', () => {
    const s = agent('bad', { system: '   ', steps: [agentStep('go', 'go')], tools: [] })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('system prompt'))).toBe(true)
  })

  it('warns on secret() in system prompt', () => {
    const s = agent('secret-agent', { system: secret('SYS'), steps: [agentStep('go', 'go')], tools: [] })
    const result = validateAgent(s)
    expect(result.valid).toBe(true)
    expect(result.warnings.some(w => w.message.includes('leakage risk'))).toBe(true)
  })

  it('errors when steps array is empty', () => {
    const s = agent('no-steps', { system: 'hi', steps: [], tools: [] })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('at least one step'))).toBe(true)
  })

  it('errors on non-kebab-case step name', () => {
    const s = agent('bad', { system: 'hi', steps: [agentStep('BadStep', 'do it')], tools: [] })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('kebab-case'))).toBe(true)
  })

  it('errors on duplicate step names', () => {
    const s = agent('dup', {
      system: 'hi',
      steps: [agentStep('plan', 'plan it'), agentStep('plan', 'plan again')],
      tools: [],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('Duplicate step name'))).toBe(true)
  })

  it('errors on empty step prompt', () => {
    const s = agent('empty-prompt', { system: 'hi', steps: [agentStep('go', '  ')], tools: [] })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('prompt must not be empty'))).toBe(true)
  })

  it('errors on non-kebab-case tool name', () => {
    const s = agent('bad', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('BadName' as string, { description: 'Bad.' })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('kebab-case'))).toBe(true)
  })

  it('errors on duplicate tool names', () => {
    const s = agent('dup', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('same', { description: 'A.' }), tool('same', { description: 'B.' })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('Duplicate tool name'))).toBe(true)
  })

  it('errors on empty tool description', () => {
    const s = agent('bad', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('t', { description: '  ' as string })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('description must not be empty'))).toBe(true)
  })

  it('errors on path not starting with /', () => {
    const s = agent('bad', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('t', { description: 'Tool.', path: 'usr/local/bin/t' })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('absolute path'))).toBe(true)
  })

  it('passes when path starts with /', () => {
    const s = agent('good', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('t', { description: 'Tool.', path: '/usr/local/bin/t' })],
    })
    expect(validateAgent(s).valid).toBe(true)
  })

  it('errors on empty usage string', () => {
    const s = agent('bad', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('t', { description: 'Tool.', usage: '  ' })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('usage must not be empty'))).toBe(true)
  })

  it('warns on secret() in tool description', () => {
    const s = agent('bot', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('leaky', { description: secret('TOOL_DESC') })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(true)
    expect(
      result.warnings.some(
        w => w.message.includes('tool("leaky") description uses secret()') && w.message.includes('leakage risk'),
      ),
    ).toBe(true)
  })

  it('passes when a non-final step uses requiresApproval', () => {
    const s = agent('approve', {
      system: 'hi',
      steps: [
        agentStep('plan', 'plan it', { requiresApproval: true }),
        agentStep('ship', 'ship it'),
      ],
      tools: [],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(true)
    expect(result.warnings.some(w => w.message.includes('requiresApproval'))).toBe(false)
  })

  it('warns when the final step uses requiresApproval (no next step to gate)', () => {
    const s = agent('approve', {
      system: 'hi',
      steps: [
        agentStep('plan', 'plan it'),
        agentStep('ship', 'ship it', { requiresApproval: true }),
      ],
      tools: [],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(true)
    expect(result.warnings.some(w => w.message.includes('requiresApproval'))).toBe(true)
    expect(result.warnings.some(w => w.message.includes('final step'))).toBe(true)
  })

  it('warns on secret() in a tool description nested inside a toolset', () => {
    const ts = toolset('ops', [tool('leaky', { description: secret('TOOL_DESC') })])
    const s = agent('bot', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [ts],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(true)
    expect(
      result.warnings.some(w => w.message.includes('tool("leaky") description uses secret()')),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// validateToolset
// ---------------------------------------------------------------------------

describe('validateToolset()', () => {
  it('passes a valid toolset', () => {
    const ts = toolset('ops', [
      tool('notify', { description: 'Notify.' }),
      tool('flag', { description: 'Flag.' }),
    ])
    expect(validateToolset(ts).valid).toBe(true)
  })

  it('errors on non-kebab-case toolset name', () => {
    const ts = toolset('Bad Name', [])
    expect(validateToolset(ts).valid).toBe(false)
  })

  it('errors on duplicate tool names within a toolset', () => {
    const ts = toolset('dupe', [
      tool('same', { description: 'A.' }),
      tool('same', { description: 'B.' }),
    ])
    expect(validateToolset(ts).valid).toBe(false)
  })

  it('warns on secret() in a tool description', () => {
    const ts = toolset('leaks', [tool('leaky', { description: secret('TOOL_DESC') })])
    const result = validateToolset(ts)
    expect(result.valid).toBe(true)
    expect(
      result.warnings.some(w => w.message.includes('tool("leaky") description uses secret()')),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// formatAgentSpec
// ---------------------------------------------------------------------------

describe('formatAgentSpec()', () => {
  it('includes the agent name', () => {
    const out = formatAgentSpec(deployAgent)
    expect(out).toContain('Agent: deploy-agent')
  })

  it('includes steps with names and prompts', () => {
    const out = formatAgentSpec(deployAgent)
    expect(out).toContain('plan')
    expect(out).toContain('review')
    expect(out).toContain('ship')
  })

  it('includes tool names and descriptions', () => {
    const out = formatAgentSpec(deployAgent)
    expect(out).toContain('trigger-deploy')
    expect(out).toContain('Trigger an internal deployment pipeline')
  })

  it('includes path and usage in tool output', () => {
    const out = formatAgentSpec(deployAgent)
    expect(out).toContain('/usr/local/bin/trigger-deploy')
    expect(out).toContain('trigger-deploy --env <production|staging>')
  })

  it('includes the dispatch reference section', () => {
    const out = formatAgentSpec(deployAgent)
    expect(out).toContain('Dispatch reference')
    expect(out).toContain('deploy-agent')
  })

  it('annotates approval-gated steps with "(requires approval)"', () => {
    const s = agent('gated', {
      system: 'hi',
      steps: [
        agentStep('plan', 'plan it', { requiresApproval: true }),
        agentStep('ship', 'ship it'),
      ],
      tools: [],
    })
    const out = formatAgentSpec(s)
    expect(out).toContain('plan  (requires approval)')
    expect(out).toContain('ship')
    expect(out).not.toContain('ship  (requires approval)')
  })

  it('renders toolset header before grouped tools', () => {
    const ts = toolset('ops', [tool('notify', { description: 'Notify team.' })])
    const s = agent('bot', { system: 'hi', steps: [agentStep('go', 'go')], tools: [ts] })
    const out = formatAgentSpec(s)
    expect(out).toContain('[toolset: ops]')
    expect(out).toContain('notify')
  })
})

// ---------------------------------------------------------------------------
// Server: agent suite routes
// ---------------------------------------------------------------------------

type TestServer = { baseUrl: string; close: () => Promise<void> }

function startTestServer(suites: ServerSuite[]): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const app = createApp(suites)
    const server = createServer(app)
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>(res => server.close(() => res())),
      })
    })
  })
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

describe('server: GET /api/suites with agent suite', () => {
  let srv: TestServer

  beforeAll(async () => {
    srv = await startTestServer([makeAgentSuite('a1', deployAgent)])
  })
  afterAll(() => srv.close())

  it('returns type=agent with stepCount and toolCount', async () => {
    const { status, body } = await get(srv.baseUrl, '/api/suites')
    expect(status).toBe(200)
    const s = (body as { suites: Record<string, unknown>[] }).suites[0]!
    expect(s['type']).toBe('agent')
    expect(s['stepCount']).toBe(3)
    expect(s['toolCount']).toBe(1)
  })
})

describe('server: GET /api/suites/:id for agent suite', () => {
  let srv: TestServer
  const suite = makeAgentSuite('a1', deployAgent)

  beforeAll(async () => { srv = await startTestServer([suite]) })
  afterAll(() => srv.close())

  it('returns agent metadata with stepNames and toolNames', async () => {
    const { status, body } = await get(srv.baseUrl, `/api/suites/${suite.id}`)
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b['type']).toBe('agent')
    expect(b['stepNames']).toEqual(['plan', 'review', 'ship'])
    expect(b['toolNames']).toEqual(['trigger-deploy'])
  })
})

describe('server: GET /api/suites/:id/plan for agent suite', () => {
  let srv: TestServer
  const suite = makeAgentSuite('a1', deployAgent)

  beforeAll(async () => { srv = await startTestServer([suite]) })
  afterAll(() => srv.close())

  it('returns planType=agent with steps and tools', async () => {
    const { status, body } = await get(srv.baseUrl, `/api/suites/${suite.id}/plan`)
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b['planType']).toBe('agent')
    expect(Array.isArray(b['steps'])).toBe(true)
    expect((b['steps'] as unknown[]).length).toBe(3)
    expect(Array.isArray(b['tools'])).toBe(true)
  })

  it('rendered plan contains agent name and step names', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${suite.id}/plan`)
    const rendered = (body as Record<string, unknown>)['renderedPlan'] as string
    expect(rendered).toContain('deploy-agent')
    expect(rendered).toContain('plan')
  })
})

describe('server: GET /api/suites/:id/execution-plan for agent suite', () => {
  let srv: TestServer
  const suite = makeAgentSuite('a1', deployAgent)

  beforeAll(async () => { srv = await startTestServer([suite]) })
  afterAll(() => srv.close())

  it('returns planType=agent and planVersion=2', async () => {
    const { status, body } = await get(srv.baseUrl, `/api/suites/${suite.id}/execution-plan`)
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b['planType']).toBe('agent')
    expect(b['planVersion']).toBe(2)
  })

  it('plan has specName, steps, tools with description/path/usage, and dispatchReference', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${suite.id}/execution-plan`)
    const plan = (body as Record<string, unknown>)['plan'] as Record<string, unknown>
    expect(plan['specName']).toBe('deploy-agent')
    expect(Array.isArray(plan['steps'])).toBe(true)
    expect((plan['steps'] as unknown[]).length).toBe(3)
    const tools = plan['tools'] as Array<Record<string, unknown>>
    expect(tools[0]!['name']).toBe('trigger-deploy')
    expect(typeof tools[0]!['description']).toBe('string')
    expect(tools[0]!['path']).toBe('/usr/local/bin/trigger-deploy')
    expect(tools[0]!['usage']).toBe('trigger-deploy --env <production|staging>')
    expect(tools[0]!['input_schema']).toBeUndefined()
    expect(typeof plan['dispatchReference']).toBe('string')
    expect((plan['dispatchReference'] as string)).toContain('deploy-agent')
  })
})
