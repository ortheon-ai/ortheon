import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { agent, tool, env, secret, ref } from '../src/dsl.js'
import { compileAgent, formatAgentPlan, formatCommandReference } from '../src/compiler.js'
import { validateAgent } from '../src/validator.js'
import { runAgentStep } from '../src/runner.js'
import { createApp, type ServerSuite } from '../src/server/app.js'
import type { AgentSpec, AgentPlan } from '../src/types.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const minimalAgentSpec: AgentSpec = agent('triage', {
  system: 'You are a helpful triage bot. Emit commands using /name key="value".',
  tools: [
    tool('create-issue', {
      source: 'llm',
      args: {
        title: { type: 'string', required: true },
        priority: { type: 'string' },
      },
      prompt: 'Create a GitHub issue using the provided title and details.',
    }),
    tool('lookup-docs', {
      aliases: ['docs'],
      source: 'any',
      args: { query: { type: 'string', required: true } },
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

describe('agent() / tool() DSL', () => {
  it('agent() produces __type: agent', () => {
    expect(minimalAgentSpec.__type).toBe('agent')
  })

  it('agent() sets name and system', () => {
    expect(minimalAgentSpec.name).toBe('triage')
    expect(minimalAgentSpec.system).toContain('triage bot')
  })

  it('tool() preserves name, source, args, prompt', () => {
    const t = minimalAgentSpec.tools[0]!
    expect(t.name).toBe('create-issue')
    expect(t.source).toBe('llm')
    expect(t.args).toBeDefined()
    expect(t.prompt).toBe('Create a GitHub issue using the provided title and details.')
  })

  it('tool() preserves aliases', () => {
    const t = minimalAgentSpec.tools[1]!
    expect(t.aliases).toEqual(['docs'])
  })

  it('tool() without source, aliases, args, prompt omits those keys', () => {
    const t = tool('bare', {})
    expect('source' in t).toBe(false)
    expect('aliases' in t).toBe(false)
    expect('args' in t).toBe(false)
    expect('prompt' in t).toBe(false)
  })

  it('agent() accepts env() as system', () => {
    const s = agent('env-agent', { system: env('SYSTEM_PROMPT'), tools: [] })
    expect(s.system).toEqual({ __type: 'env', name: 'SYSTEM_PROMPT' })
  })
})

// ---------------------------------------------------------------------------
// compileAgent
// ---------------------------------------------------------------------------

describe('compileAgent()', () => {
  let plan: AgentPlan

  beforeAll(() => {
    plan = compileAgent(minimalAgentSpec)
  })

  it('sets specName from the spec name', () => {
    expect(plan.specName).toBe('triage')
  })

  it('passes system through unchanged', () => {
    expect(plan.system).toContain('triage bot')
  })

  it('defaults source to llm when not specified', () => {
    const s = agent('a', { system: 'hi', tools: [tool('cmd', {})] })
    const p = compileAgent(s)
    expect(p.tools[0]!.source).toBe('llm')
  })

  it('preserves explicit source', () => {
    expect(plan.tools[0]!.source).toBe('llm')
    expect(plan.tools[1]!.source).toBe('any')
  })

  it('passes aliases through', () => {
    expect(plan.tools[1]!.aliases).toEqual(['docs'])
  })

  it('passes args through', () => {
    const args = plan.tools[0]!.args!
    expect(args['title']).toEqual({ type: 'string', required: true })
    expect(args['priority']).toEqual({ type: 'string' })
  })

  it('passes prompt through', () => {
    expect(plan.tools[0]!.prompt).toBe('Create a GitHub issue using the provided title and details.')
  })

  it('omits aliases when not set (create-issue has no aliases)', () => {
    expect('aliases' in plan.tools[0]!).toBe(false)
  })

  it('preserves env() markers unresolved in system', () => {
    const s = agent('env-agent', { system: env('SYSTEM_PROMPT'), tools: [] })
    const p = compileAgent(s)
    expect(p.system).toEqual({ __type: 'env', name: 'SYSTEM_PROMPT' })
  })

  it('populates commandReference on the plan', () => {
    expect(typeof plan.commandReference).toBe('string')
    expect(plan.commandReference).toContain('/create-issue')
    expect(plan.commandReference).toContain('/lookup-docs')
  })

  it('commandReference is empty string when no tools', () => {
    const s = agent('empty', { system: 'hi', tools: [] })
    const p = compileAgent(s)
    expect(p.commandReference).toBe('')
  })
})

// ---------------------------------------------------------------------------
// formatCommandReference
// ---------------------------------------------------------------------------

describe('formatCommandReference()', () => {
  const plan = compileAgent(minimalAgentSpec)

  it('includes command names with slash prefix', () => {
    expect(plan.commandReference).toContain('/create-issue')
    expect(plan.commandReference).toContain('/lookup-docs')
  })

  it('includes arg placeholders with types', () => {
    expect(plan.commandReference).toContain('title="<string, required>"')
    expect(plan.commandReference).toContain('priority="<string>"')
  })

  it('includes aliases', () => {
    expect(plan.commandReference).toContain('aliases: docs')
  })

  it('includes formatting rules', () => {
    expect(plan.commandReference).toContain('One command per line')
    expect(plan.commandReference).toContain('Always quote argument values')
  })

  it('returns empty string for empty tool list', () => {
    expect(formatCommandReference([])).toBe('')
  })

  it('includes commands with no args (no arg placeholders on the command line)', () => {
    const tools = compileAgent(agent('a', {
      system: 'hi',
      tools: [tool('ping', { source: 'llm' })],
    })).tools
    const ref = formatCommandReference(tools)
    expect(ref).toContain('/ping')
    const pingLine = ref.split('\n').find(l => l.includes('/ping'))!
    expect(pingLine).not.toContain('="<')
  })
})

// ---------------------------------------------------------------------------
// formatAgentPlan
// ---------------------------------------------------------------------------

describe('formatAgentPlan()', () => {
  it('includes the agent name', () => {
    const plan = compileAgent(minimalAgentSpec)
    const out = formatAgentPlan(plan)
    expect(out).toContain('Agent: triage')
  })

  it('includes the system prompt', () => {
    const plan = compileAgent(minimalAgentSpec)
    const out = formatAgentPlan(plan)
    expect(out).toContain('triage bot')
  })

  it('includes command names and sources', () => {
    const plan = compileAgent(minimalAgentSpec)
    const out = formatAgentPlan(plan)
    expect(out).toContain('command: create-issue')
    expect(out).toContain('command: lookup-docs')
    expect(out).toContain('source: llm')
    expect(out).toContain('source: any')
  })

  it('shows aliases', () => {
    const plan = compileAgent(minimalAgentSpec)
    const out = formatAgentPlan(plan)
    expect(out).toContain('aliases: docs')
  })

  it('shows arg grammar line', () => {
    const plan = compileAgent(minimalAgentSpec)
    const out = formatAgentPlan(plan)
    expect(out).toContain('Arg syntax: /command key="value"')
  })

  it('shows args with types and required marker', () => {
    const plan = compileAgent(minimalAgentSpec)
    const out = formatAgentPlan(plan)
    expect(out).toContain('title (string, required)')
    expect(out).toContain('priority (string)')
  })

  it('renders env() system as a label', () => {
    const s = agent('env-agent', { system: env('SYSTEM_PROMPT'), tools: [] })
    const out = formatAgentPlan(compileAgent(s))
    expect(out).toContain('env("SYSTEM_PROMPT")')
  })

  it('renders secret() system with its name', () => {
    const s = agent('secret-sys', { system: secret('SYS_SECRET'), tools: [] })
    const out = formatAgentPlan(compileAgent(s))
    expect(out).toContain('secret("SYS_SECRET")')
  })

  it('renders ref() system with its path', () => {
    const s = agent('ref-sys', { system: ref('config.systemPrompt'), tools: [] })
    const out = formatAgentPlan(compileAgent(s))
    expect(out).toContain('ref("config.systemPrompt")')
  })

  it('renders env() prompt with its name', () => {
    const s = agent('env-prompt', {
      system: 'hi',
      tools: [tool('do-thing', { prompt: env('TOOL_PROMPT') })],
    })
    const out = formatAgentPlan(compileAgent(s))
    expect(out).toContain('env("TOOL_PROMPT")')
  })

  it('renders ref() prompt with its path', () => {
    const s = agent('ref-prompt', {
      system: 'hi',
      tools: [tool('do-thing', { prompt: ref('prompts.doThing') })],
    })
    const out = formatAgentPlan(compileAgent(s))
    expect(out).toContain('ref("prompts.doThing")')
  })

  it('shows (no commands defined) when tools list is empty', () => {
    const s = agent('empty', { system: 'hi', tools: [] })
    const out = formatAgentPlan(compileAgent(s))
    expect(out).toContain('(no commands defined)')
  })
})

// ---------------------------------------------------------------------------
// validateAgent
// ---------------------------------------------------------------------------

describe('validateAgent()', () => {
  it('passes a valid agent spec', () => {
    const result = validateAgent(minimalAgentSpec)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('errors on empty string system prompt', () => {
    const s = agent('bad', { system: '   ', tools: [] })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('system prompt'))).toBe(true)
  })

  it('warns on secret() in system prompt', () => {
    const s = agent('secret-agent', { system: secret('SYSTEM'), tools: [] })
    const result = validateAgent(s)
    expect(result.valid).toBe(true)
    expect(result.warnings.some(w => w.message.includes('leakage risk'))).toBe(true)
  })

  it('does not warn on env() in system prompt', () => {
    const s = agent('env-agent', { system: env('SYSTEM'), tools: [] })
    const result = validateAgent(s)
    expect(result.warnings).toHaveLength(0)
  })

  it('warns on secret() in tool prompt', () => {
    const s = agent('secret-prompt', {
      system: 'hi',
      tools: [tool('cmd', { prompt: secret('TOOL_PROMPT') })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(true)
    expect(result.warnings.some(w => w.message.includes('leakage risk') && w.message.includes('cmd'))).toBe(true)
  })

  it('does not warn on env() in tool prompt', () => {
    const s = agent('env-prompt', {
      system: 'hi',
      tools: [tool('cmd', { prompt: env('TOOL_PROMPT') })],
    })
    const result = validateAgent(s)
    expect(result.warnings).toHaveLength(0)
  })

  it('does not warn on string tool prompt', () => {
    const s = agent('str-prompt', {
      system: 'hi',
      tools: [tool('cmd', { prompt: 'Do something.' })],
    })
    const result = validateAgent(s)
    expect(result.warnings).toHaveLength(0)
  })

  it('errors on duplicate tool names', () => {
    const s = agent('dup', {
      system: 'hi',
      tools: [
        tool('same', {}),
        tool('same', {}),
      ],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('Duplicate command identifier'))).toBe(true)
  })

  it('errors when alias clashes with another tool name', () => {
    const s = agent('clash', {
      system: 'hi',
      tools: [
        tool('create-issue', {}),
        tool('other', { aliases: ['create-issue'] }),
      ],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('Duplicate command identifier'))).toBe(true)
  })

  it('errors when alias clashes with another alias', () => {
    const s = agent('clash', {
      system: 'hi',
      tools: [
        tool('a', { aliases: ['shared'] }),
        tool('b', { aliases: ['shared'] }),
      ],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('Duplicate command identifier'))).toBe(true)
  })

  it('errors on non-kebab-case tool name', () => {
    const s = agent('bad', {
      system: 'hi',
      tools: [tool('CreateIssue' as string, {})],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('kebab-case'))).toBe(true)
  })

  it('errors on non-kebab-case alias', () => {
    const s = agent('bad', {
      system: 'hi',
      tools: [tool('good', { aliases: ['BadAlias'] })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('kebab-case'))).toBe(true)
  })

  it('errors on invalid source', () => {
    const s = agent('bad', {
      system: 'hi',
      tools: [tool('t', { source: 'robot' as 'user' })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('invalid source'))).toBe(true)
  })

  it('accepts valid sources: user, llm, tool, any', () => {
    for (const src of ['user', 'llm', 'tool', 'any'] as const) {
      const s = agent('a', { system: 'hi', tools: [tool('cmd', { source: src })] })
      expect(validateAgent(s).valid).toBe(true)
    }
  })

  it('errors on invalid arg type', () => {
    const s = agent('bad', {
      system: 'hi',
      tools: [tool('t', { args: { count: { type: 'array' as 'string' } } })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('invalid type'))).toBe(true)
  })

  it('errors on non-kebab-case arg name', () => {
    const s = agent('bad', {
      system: 'hi',
      tools: [tool('t', { args: { myField: { type: 'string' } } })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('kebab-case'))).toBe(true)
  })

  it('accepts valid arg definitions', () => {
    const s = agent('ok', {
      system: 'hi',
      tools: [
        tool('cmd', {
          args: {
            title: { type: 'string', required: true },
            count: { type: 'number' },
            active: { type: 'boolean' },
          },
        }),
      ],
    })
    expect(validateAgent(s).valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// runAgentStep
// ---------------------------------------------------------------------------

describe('runAgentStep()', () => {
  const plan = compileAgent(minimalAgentSpec)

  it('returns empty candidates when no commands present', () => {
    const result = runAgentStep(plan, { text: 'just some prose with no commands', source: 'llm' })
    expect(result.candidates).toHaveLength(0)
  })

  it('parses a simple command with no args', () => {
    const p = compileAgent(agent('a', {
      system: 'hi',
      tools: [tool('ping', { source: 'llm' })],
    }))
    const result = runAgentStep(p, { text: '/ping', source: 'llm' })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.name).toBe('ping')
    expect(result.candidates[0]!.args).toEqual({})
  })

  it('parses key="value" args', () => {
    const result = runAgentStep(plan, {
      text: '/create-issue title="Order API returns 500" priority="high"',
      source: 'llm',
    })
    expect(result.candidates).toHaveLength(1)
    const c = result.candidates[0]!
    expect(c.name).toBe('create-issue')
    expect(c.args['title']).toBe('Order API returns 500')
    expect(c.args['priority']).toBe('high')
  })

  it('preserves the raw line', () => {
    const line = '/create-issue title="Test"'
    const result = runAgentStep(plan, { text: line, source: 'llm' })
    expect(result.candidates[0]!.raw).toBe(line)
  })

  it('resolves aliases to canonical tool name', () => {
    const result = runAgentStep(plan, {
      text: '/docs query="how to reset"',
      source: 'user',
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.name).toBe('lookup-docs')
  })

  it('ignores unknown command names', () => {
    const result = runAgentStep(plan, { text: '/no-such-command', source: 'llm' })
    expect(result.candidates).toHaveLength(0)
  })

  it('filters by source: llm-only tool not triggered by user message', () => {
    const result = runAgentStep(plan, {
      text: '/create-issue title="Test"',
      source: 'user',
    })
    expect(result.candidates).toHaveLength(0)
  })

  it('source=any matches user, llm, and tool messages', () => {
    for (const source of ['user', 'llm', 'tool'] as const) {
      const result = runAgentStep(plan, {
        text: '/lookup-docs query="test"',
        source,
      })
      expect(result.candidates).toHaveLength(1)
    }
  })

  it('includes prompt from tool definition', () => {
    const result = runAgentStep(plan, {
      text: '/create-issue title="Test"',
      source: 'llm',
    })
    expect(result.candidates[0]!.prompt).toBe('Create a GitHub issue using the provided title and details.')
  })

  it('tool without prompt omits the prompt field', () => {
    const result = runAgentStep(plan, {
      text: '/lookup-docs query="test"',
      source: 'llm',
    })
    expect('prompt' in result.candidates[0]!).toBe(false)
  })

  it('produces validation.valid=true when all required args present', () => {
    const result = runAgentStep(plan, {
      text: '/create-issue title="Bug"',
      source: 'llm',
    })
    expect(result.candidates[0]!.validation?.valid).toBe(true)
  })

  it('produces validation.valid=false when required arg missing', () => {
    const result = runAgentStep(plan, {
      text: '/create-issue priority="high"',
      source: 'llm',
    })
    const c = result.candidates[0]!
    expect(c.validation?.valid).toBe(false)
    expect(c.validation?.errors?.some(e => e.includes('title'))).toBe(true)
  })

  it('coerces number args', () => {
    const p = compileAgent(agent('a', {
      system: 'hi',
      tools: [tool('set', { source: 'llm', args: { count: { type: 'number' } } })],
    }))
    const result = runAgentStep(p, { text: '/set count="42"', source: 'llm' })
    expect(result.candidates[0]!.args['count']).toBe(42)
  })

  it('errors on non-numeric number arg', () => {
    const p = compileAgent(agent('a', {
      system: 'hi',
      tools: [tool('set', { source: 'llm', args: { count: { type: 'number' } } })],
    }))
    const result = runAgentStep(p, { text: '/set count="abc"', source: 'llm' })
    expect(result.candidates[0]!.validation?.valid).toBe(false)
  })

  it('errors on empty-string number arg (not coerced to 0)', () => {
    const p = compileAgent(agent('a', {
      system: 'hi',
      tools: [tool('set', { source: 'llm', args: { count: { type: 'number' } } })],
    }))
    const result = runAgentStep(p, { text: '/set count=""', source: 'llm' })
    expect(result.candidates[0]!.validation?.valid).toBe(false)
    expect(result.candidates[0]!.args['count']).not.toBe(0)
  })

  it('errors on whitespace-only number arg (not coerced to 0)', () => {
    const p = compileAgent(agent('a', {
      system: 'hi',
      tools: [tool('set', { source: 'llm', args: { count: { type: 'number' } } })],
    }))
    const result = runAgentStep(p, { text: '/set count="   "', source: 'llm' })
    expect(result.candidates[0]!.validation?.valid).toBe(false)
    expect(result.candidates[0]!.args['count']).not.toBe(0)
  })

  it('coerces boolean args (true/false)', () => {
    const p = compileAgent(agent('a', {
      system: 'hi',
      tools: [tool('toggle', { source: 'llm', args: { active: { type: 'boolean' } } })],
    }))
    const r1 = runAgentStep(p, { text: '/toggle active="true"', source: 'llm' })
    const r2 = runAgentStep(p, { text: '/toggle active="false"', source: 'llm' })
    expect(r1.candidates[0]!.args['active']).toBe(true)
    expect(r2.candidates[0]!.args['active']).toBe(false)
  })

  it('errors on invalid boolean arg value', () => {
    const p = compileAgent(agent('a', {
      system: 'hi',
      tools: [tool('toggle', { source: 'llm', args: { active: { type: 'boolean' } } })],
    }))
    const result = runAgentStep(p, { text: '/toggle active="yes"', source: 'llm' })
    expect(result.candidates[0]!.validation?.valid).toBe(false)
  })

  it('passes unknown args through as strings (no strict mode)', () => {
    const result = runAgentStep(plan, {
      text: '/create-issue title="Bug" extra-info="ok"',
      source: 'llm',
    })
    expect(result.candidates[0]!.args['extra-info']).toBe('ok')
  })

  it('extracts multiple commands from one message in order', () => {
    const text = [
      'Sure, here is what I will do:',
      '/lookup-docs query="how to create issues"',
      'And then:',
      '/create-issue title="Repro bug"',
    ].join('\n')
    const result = runAgentStep(plan, { text, source: 'llm' })
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[0]!.name).toBe('lookup-docs')
    expect(result.candidates[1]!.name).toBe('create-issue')
  })

  it('ignores commands inside code fences', () => {
    const text = [
      'Example:',
      '```',
      '/create-issue title="Inside fence"',
      '```',
      'That was just an example.',
    ].join('\n')
    const result = runAgentStep(plan, { text, source: 'llm' })
    expect(result.candidates).toHaveLength(0)
  })

  it('ignores commands on blockquote lines', () => {
    const text = '> /create-issue title="Quoted"\nactual prose'
    const result = runAgentStep(plan, { text, source: 'llm' })
    expect(result.candidates).toHaveLength(0)
  })

  it('drops lines with malformed args (unquoted values)', () => {
    const result = runAgentStep(plan, {
      text: '/create-issue title=unquoted',
      source: 'llm',
    })
    expect(result.candidates).toHaveLength(0)
  })

  it('drops lines with malformed args (missing closing quote would be unparseable -- key with no value)', () => {
    // key= with no value and no closing quote leaves non-whitespace residue
    const result = runAgentStep(plan, {
      text: '/create-issue title=',
      source: 'llm',
    })
    expect(result.candidates).toHaveLength(0)
  })

  it('handles leading whitespace before command', () => {
    const result = runAgentStep(plan, {
      text: '  /create-issue title="Test"',
      source: 'llm',
    })
    expect(result.candidates).toHaveLength(1)
  })

  it('does not match mid-line commands (not line-anchored)', () => {
    const result = runAgentStep(plan, {
      text: 'call /create-issue title="Test" now',
      source: 'llm',
    })
    expect(result.candidates).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Server: agent spec routes
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
    srv = await startTestServer([makeAgentSuite('a1', minimalAgentSpec)])
  })
  afterAll(() => srv.close())

  it('lists the agent suite with type=agent', async () => {
    const { status, body } = await get(srv.baseUrl, '/api/suites')
    expect(status).toBe(200)
    const suites = (body as { suites: unknown[] }).suites
    expect(suites).toHaveLength(1)
    const s = suites[0] as Record<string, unknown>
    expect(s['type']).toBe('agent')
    expect(s['name']).toBe('triage')
    expect(typeof s['toolCount']).toBe('number')
  })
})

describe('server: GET /api/suites/:id for agent suite', () => {
  let srv: TestServer
  const suite = makeAgentSuite('a1', minimalAgentSpec)

  beforeAll(async () => {
    srv = await startTestServer([suite])
  })
  afterAll(() => srv.close())

  it('returns agent metadata with type=agent', async () => {
    const { status, body } = await get(srv.baseUrl, `/api/suites/${suite.id}`)
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b['type']).toBe('agent')
    expect(b['toolNames']).toEqual(['create-issue', 'lookup-docs'])
  })
})

describe('server: GET /api/suites/:id/plan for agent suite', () => {
  let srv: TestServer
  const suite = makeAgentSuite('a1', minimalAgentSpec)

  beforeAll(async () => {
    srv = await startTestServer([suite])
  })
  afterAll(() => srv.close())

  it('returns planType=agent and tools list', async () => {
    const { status, body } = await get(srv.baseUrl, `/api/suites/${suite.id}/plan`)
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b['planType']).toBe('agent')
    expect(Array.isArray(b['tools'])).toBe(true)
    expect(b['renderedPlan']).toContain('triage')
  })

  it('rendered plan contains command table', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${suite.id}/plan`)
    const rendered = (body as Record<string, unknown>)['renderedPlan'] as string
    expect(rendered).toContain('command: create-issue')
    expect(rendered).toContain('Arg syntax')
  })
})

describe('server: GET /api/suites/:id/execution-plan for agent suite', () => {
  let srv: TestServer
  const suite = makeAgentSuite('a1', minimalAgentSpec)

  beforeAll(async () => {
    srv = await startTestServer([suite])
  })
  afterAll(() => srv.close())

  it('returns planType=agent and planVersion=1', async () => {
    const { status, body } = await get(srv.baseUrl, `/api/suites/${suite.id}/execution-plan`)
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b['planType']).toBe('agent')
    expect(b['planVersion']).toBe(1)
    const plan = b['plan'] as Record<string, unknown>
    expect(plan['specName']).toBe('triage')
    expect(Array.isArray(plan['tools'])).toBe(true)
    expect(typeof plan['commandReference']).toBe('string')
    expect((plan['commandReference'] as string)).toContain('/create-issue')
  })

  it('serialized tools have source and name (no match array)', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${suite.id}/execution-plan`)
    const plan = (body as Record<string, unknown>)['plan'] as Record<string, unknown>
    const tools = plan['tools'] as Array<Record<string, unknown>>
    expect(tools[0]!['name']).toBe('create-issue')
    expect(tools[0]!['source']).toBe('llm')
    expect('match' in tools[0]!).toBe(false)
  })
})

describe('server: behavioral plan endpoint still has planType=behavioral', () => {
  it('returns planType=behavioral for a spec suite', async () => {
    const { spec: specModule } = await import('../src/dsl.js')
    const { flow: flowFn, step: stepFn, api: apiFn } = await import('../src/dsl.js')
    const s = specModule('health', {
      baseUrl: 'http://localhost:9999',
      flows: [flowFn('main', { steps: [stepFn('check', apiFn('GET /health', {}))] })],
    })
    const suiteFn: ServerSuite = {
      id: 'spec1',
      name: s.name,
      path: '/test/spec1.ts',
      relativePath: 'test/spec1.ts',
      kind: 'spec',
      spec: s,
      agentSpec: null,
      loadError: null,
    }
    const srv = await startTestServer([suiteFn])
    try {
      const { body } = await get(srv.baseUrl, '/api/suites/spec1/execution-plan')
      expect((body as Record<string, unknown>)['planType']).toBe('behavioral')
    } finally {
      await srv.close()
    }
  })
})
