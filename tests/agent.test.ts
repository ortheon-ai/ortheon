import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { agent, agentStep, tool, toolset, env, secret } from '../src/dsl.js'
import { compileAgent, formatAgentSpec, formatDispatchReference } from '../src/compiler.js'
import { validateAgent, validateToolset } from '../src/validator.js'
import { buildAgentPrompt, parseAgentDispatch } from '../src/agent.js'
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
      args: { env: { type: 'string', required: true, description: 'Target environment' } },
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
  })

  it('tool() preserves name, description, args', () => {
    const t = deployAgent.tools[0]!
    expect(t.name).toBe('trigger-deploy')
    expect((t as { description?: string }).description).toContain('deployment pipeline')
    expect((t as { args?: unknown }).args).toBeDefined()
  })

  it('tool() without description or args omits those keys', () => {
    const t = tool('bare', {})
    expect('description' in t).toBe(false)
    expect('args' in t).toBe(false)
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

  it('converts tool args to Anthropic input_schema', () => {
    const t = plan.tools[0]!
    expect(t.name).toBe('trigger-deploy')
    expect(t.input_schema.type).toBe('object')
    expect(t.input_schema.properties['env']).toEqual({ type: 'string', description: 'Target environment' })
    expect(t.input_schema.required).toContain('env')
  })

  it('tool with no args produces empty input_schema', () => {
    const s = agent('a', { system: 'hi', steps: [agentStep('go', 'go')], tools: [tool('ping', {})] })
    const p = compileAgent(s)
    expect(p.tools[0]!.input_schema).toEqual({ type: 'object', properties: {}, required: [] })
  })

  it('non-required args are not in input_schema.required', () => {
    const s = agent('a', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('cmd', { args: { opt: { type: 'string' }, req: { type: 'string', required: true } } })],
    })
    const p = compileAgent(s)
    expect(p.tools[0]!.input_schema.required).toEqual(['req'])
    expect(Object.keys(p.tools[0]!.input_schema.properties)).toContain('opt')
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
      tools: [ts, tool('inline', {})],
    })
    const p = compileAgent(s)
    expect(p.tools.map(t => t.name)).toEqual(['notify', 'flag', 'inline'])
  })

  it('each flattened tool has input_schema', () => {
    const ts = toolset('ops', [tool('notify', {})])
    const s = agent('bot', { system: 'hi', steps: [agentStep('go', 'go')], tools: [ts] })
    const p = compileAgent(s)
    expect(p.tools[0]!.input_schema).toBeDefined()
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

  it('includes the system prompt', () => {
    const out = buildAgentPrompt(plan, 'plan')
    expect(out).toContain('You are a deployment bot.')
  })

  it('includes the step name and position for first step', () => {
    const out = buildAgentPrompt(plan, 'plan')
    expect(out).toContain('Step "plan" (1 of 3)')
    expect(out).toContain('Draft release notes')
  })

  it('includes the step name and position for a middle step', () => {
    const out = buildAgentPrompt(plan, 'review')
    expect(out).toContain('Step "review" (2 of 3)')
  })

  it('includes the step name and position for the last step', () => {
    const out = buildAgentPrompt(plan, 'ship')
    expect(out).toContain('Step "ship" (3 of 3)')
  })

  it('includes the dispatch reference in the output', () => {
    const out = buildAgentPrompt(plan, 'plan')
    expect(out).toContain('deploy-agent')
    expect(out).toContain('(current)')
  })

  it('shows the next-step dispatch line for a non-final step', () => {
    const out = buildAgentPrompt(plan, 'plan')
    expect(out).toContain('/agent deploy-agent review')
  })

  it('shows "do not post" on the final step', () => {
    const out = buildAgentPrompt(plan, 'ship')
    expect(out).toContain('final step')
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
      tools: [tool('BadName' as string, {})],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('kebab-case'))).toBe(true)
  })

  it('errors on duplicate tool names', () => {
    const s = agent('dup', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('same', {}), tool('same', {})],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('Duplicate tool name'))).toBe(true)
  })

  it('errors on invalid arg type', () => {
    const s = agent('bad', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('t', { args: { count: { type: 'array' as 'string' } } })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('invalid type'))).toBe(true)
  })

  it('errors on non-kebab-case arg name', () => {
    const s = agent('bad', {
      system: 'hi',
      steps: [agentStep('go', 'go')],
      tools: [tool('t', { args: { myField: { type: 'string' } } })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('kebab-case'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// validateToolset
// ---------------------------------------------------------------------------

describe('validateToolset()', () => {
  it('passes a valid toolset', () => {
    const ts = toolset('ops', [tool('notify', {}), tool('flag', {})])
    expect(validateToolset(ts).valid).toBe(true)
  })

  it('errors on non-kebab-case toolset name', () => {
    const ts = toolset('Bad Name', [])
    expect(validateToolset(ts).valid).toBe(false)
  })

  it('errors on duplicate tool names within a toolset', () => {
    const ts = toolset('dupe', [tool('same', {}), tool('same', {})])
    expect(validateToolset(ts).valid).toBe(false)
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

  it('includes tool names', () => {
    const out = formatAgentSpec(deployAgent)
    expect(out).toContain('trigger-deploy')
  })

  it('includes the dispatch reference section', () => {
    const out = formatAgentSpec(deployAgent)
    expect(out).toContain('Dispatch reference')
    expect(out).toContain('deploy-agent')
  })

  it('renders toolset header before grouped tools', () => {
    const ts = toolset('ops', [tool('notify', {})])
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

  it('plan has specName, steps, tools with input_schema, and dispatchReference', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${suite.id}/execution-plan`)
    const plan = (body as Record<string, unknown>)['plan'] as Record<string, unknown>
    expect(plan['specName']).toBe('deploy-agent')
    expect(Array.isArray(plan['steps'])).toBe(true)
    expect((plan['steps'] as unknown[]).length).toBe(3)
    const tools = plan['tools'] as Array<Record<string, unknown>>
    expect(tools[0]!['name']).toBe('trigger-deploy')
    expect(tools[0]!['input_schema']).toBeDefined()
    expect(typeof plan['dispatchReference']).toBe('string')
    expect((plan['dispatchReference'] as string)).toContain('deploy-agent')
  })

  it('input_schema has correct structure', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${suite.id}/execution-plan`)
    const plan = (body as Record<string, unknown>)['plan'] as Record<string, unknown>
    const tools = plan['tools'] as Array<Record<string, unknown>>
    const schema = tools[0]!['input_schema'] as Record<string, unknown>
    expect(schema['type']).toBe('object')
    expect(schema['properties']).toBeDefined()
    expect(Array.isArray(schema['required'])).toBe(true)
    expect((schema['required'] as string[])).toContain('env')
  })
})
