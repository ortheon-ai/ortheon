import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { agent, tool, env, secret } from '../src/dsl.js'
import { compileAgent, formatAgentPlan } from '../src/compiler.js'
import { validateAgent } from '../src/validator.js'
import { matchAgent } from '../src/runner.js'
import { createApp, type ServerSuite } from '../src/server/app.js'
import type { AgentSpec, AgentPlan } from '../src/types.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const minimalAgentSpec: AgentSpec = agent('triage', {
  system: 'You are a helpful triage bot.',
  tools: [
    tool('create-issue', {
      match: [
        { source: 'user', pattern: /please create an issue/i },
        { source: 'llm', pattern: /I'll create an issue for you/i },
      ],
      description: 'Creates a GitHub issue',
      prompt: 'When confirmed, call this tool.',
    }),
    tool('lookup-docs', {
      match: [{ source: 'any', pattern: /how do I (.+)\?/i }],
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
    expect(minimalAgentSpec.system).toBe('You are a helpful triage bot.')
  })

  it('tool() preserves name, match, description, prompt', () => {
    const t = minimalAgentSpec.tools[0]!
    expect(t.name).toBe('create-issue')
    expect(t.match).toHaveLength(2)
    expect(t.description).toBe('Creates a GitHub issue')
    expect(t.prompt).toBe('When confirmed, call this tool.')
  })

  it('tool() without description or prompt omits those keys', () => {
    const t = minimalAgentSpec.tools[1]!
    expect('description' in t).toBe(false)
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
    expect(plan.system).toBe('You are a helpful triage bot.')
  })

  it('serializes RegExp.source and RegExp.flags', () => {
    const rule = plan.tools[0]!.match[0]!
    expect(rule.pattern).toBe('please create an issue')
    expect(rule.flags).toBe('i')
  })

  it('preserves source on each match rule', () => {
    expect(plan.tools[0]!.match[0]!.source).toBe('user')
    expect(plan.tools[0]!.match[1]!.source).toBe('llm')
    expect(plan.tools[1]!.match[0]!.source).toBe('any')
  })

  it('passes description and prompt through', () => {
    const t = plan.tools[0]!
    expect(t.description).toBe('Creates a GitHub issue')
    expect(t.prompt).toBe('When confirmed, call this tool.')
  })

  it('omits description/prompt when not set', () => {
    const t = plan.tools[1]!
    expect('description' in t).toBe(false)
    expect('prompt' in t).toBe(false)
  })

  it('preserves env() markers unresolved in system', () => {
    const s = agent('env-agent', { system: env('SYSTEM_PROMPT'), tools: [] })
    const p = compileAgent(s)
    expect(p.system).toEqual({ __type: 'env', name: 'SYSTEM_PROMPT' })
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
    expect(out).toContain('You are a helpful triage bot.')
  })

  it('includes tool names and match rules', () => {
    const plan = compileAgent(minimalAgentSpec)
    const out = formatAgentPlan(plan)
    expect(out).toContain('tool: create-issue')
    expect(out).toContain('tool: lookup-docs')
    expect(out).toContain('source=user')
    expect(out).toContain('source=any')
  })

  it('renders env() system as a label', () => {
    const s = agent('env-agent', { system: env('SYSTEM_PROMPT'), tools: [] })
    const out = formatAgentPlan(compileAgent(s))
    expect(out).toContain('env("SYSTEM_PROMPT")')
  })

  it('shows (no tools defined) when tools list is empty', () => {
    const s = agent('empty', { system: 'hi', tools: [] })
    const out = formatAgentPlan(compileAgent(s))
    expect(out).toContain('(no tools defined)')
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

  it('errors on duplicate tool names', () => {
    const s = agent('dup', {
      system: 'hi',
      tools: [
        tool('same', { match: [{ source: 'user', pattern: /x/ }] }),
        tool('same', { match: [{ source: 'user', pattern: /y/ }] }),
      ],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('Duplicate tool name'))).toBe(true)
  })

  it('errors when a tool has no match rules', () => {
    const s = agent('bad', {
      system: 'hi',
      tools: [tool('empty-tool', { match: [] })],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('at least one match rule'))).toBe(true)
  })

  it('errors on an invalid match source', () => {
    const s = agent('bad', {
      system: 'hi',
      tools: [
        // cast to bypass TS so we can test the runtime validator
        tool('t', { match: [{ source: 'robot' as 'user', pattern: /x/ }] }),
      ],
    })
    const result = validateAgent(s)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('invalid source'))).toBe(true)
  })

  it('accepts valid match sources: user, llm, tool, any', () => {
    const s = agent('all-sources', {
      system: 'hi',
      tools: [
        tool('multi', {
          match: [
            { source: 'user', pattern: /a/ },
            { source: 'llm', pattern: /b/ },
            { source: 'tool', pattern: /c/ },
            { source: 'any', pattern: /d/ },
          ],
        }),
      ],
    })
    expect(validateAgent(s).valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// matchAgent
// ---------------------------------------------------------------------------

describe('matchAgent()', () => {
  const plan = compileAgent(minimalAgentSpec)

  it('returns empty candidates when no rules match', () => {
    const result = matchAgent(plan, { text: 'just a regular message', source: 'user' })
    expect(result.candidates).toHaveLength(0)
  })

  it('matches a user-source rule against a user message', () => {
    const result = matchAgent(plan, { text: 'please create an issue', source: 'user' })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.name).toBe('create-issue')
    expect(result.candidates[0]!.matchIndex).toBe(0)
  })

  it('does NOT match a user-source rule against an llm message', () => {
    const result = matchAgent(plan, { text: 'please create an issue', source: 'llm' })
    // Only the llm-source rule for create-issue could match, but its pattern is different
    // So we expect no match for this text from llm source
    expect(result.candidates.every(c => c.name !== 'create-issue' || c.matchIndex !== 0)).toBe(true)
  })

  it('matches an llm-source rule against an llm message', () => {
    const result = matchAgent(plan, { text: "I'll create an issue for you", source: 'llm' })
    const match = result.candidates.find(c => c.name === 'create-issue' && c.matchIndex === 1)
    expect(match).toBeDefined()
  })

  it('matches source=any against any source', () => {
    const docQuery = 'how do I reset my password?'
    for (const source of ['user', 'llm', 'tool'] as const) {
      const result = matchAgent(plan, { text: docQuery, source })
      const match = result.candidates.find(c => c.name === 'lookup-docs')
      expect(match).toBeDefined()
    }
  })

  it('captures regex groups', () => {
    const result = matchAgent(plan, { text: 'how do I reset my password?', source: 'user' })
    const match = result.candidates.find(c => c.name === 'lookup-docs')
    expect(match?.captures[0]).toBe('reset my password')
  })

  it('returns matchIndex identifying which rule fired', () => {
    const result = matchAgent(plan, { text: "I'll create an issue for you", source: 'llm' })
    const match = result.candidates.find(c => c.name === 'create-issue')
    expect(match?.matchIndex).toBe(1)
  })

  it('produces multiple candidates when multiple rules match', () => {
    // A message that matches both user-source rules of create-issue and any-source of lookup-docs
    const multiPlan = compileAgent(agent('multi', {
      system: 'hi',
      tools: [
        tool('both', {
          match: [
            { source: 'user', pattern: /foo/ },
            { source: 'any', pattern: /foo/ },
          ],
        }),
      ],
    }))
    const result = matchAgent(multiPlan, { text: 'foo', source: 'user' })
    // Both rules match, so 2 candidates for the same tool
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[0]!.matchIndex).toBe(0)
    expect(result.candidates[1]!.matchIndex).toBe(1)
  })

  it('is case-insensitive when the regex has the i flag', () => {
    const result = matchAgent(plan, { text: 'PLEASE CREATE AN ISSUE', source: 'user' })
    expect(result.candidates.some(c => c.name === 'create-issue')).toBe(true)
  })

  it('strips g flag -- does not reuse lastIndex state', () => {
    const gFlagPlan = compileAgent(agent('g-flag', {
      system: 'hi',
      tools: [
        tool('t', {
          match: [{ source: 'any', pattern: /foo/g }],
        }),
      ],
    }))
    // Call twice: if lastIndex leaked, the second call would fail
    const r1 = matchAgent(gFlagPlan, { text: 'foo', source: 'user' })
    const r2 = matchAgent(gFlagPlan, { text: 'foo', source: 'user' })
    expect(r1.candidates).toHaveLength(1)
    expect(r2.candidates).toHaveLength(1)
  })

  it('strips y (sticky) flag -- prevents sticky matching confusion', () => {
    const yFlagPlan = compileAgent(agent('y-flag', {
      system: 'hi',
      tools: [
        tool('t', {
          match: [{ source: 'any', pattern: /foo/y }],
        }),
      ],
    }))
    const result = matchAgent(yFlagPlan, { text: 'bar foo', source: 'user' })
    // Sticky would require match at index 0; without sticky it should match mid-string
    expect(result.candidates).toHaveLength(1)
  })

  it('uses first match only -- captures from first occurrence', () => {
    const plan2 = compileAgent(agent('first-match', {
      system: 'hi',
      tools: [
        tool('t', {
          match: [{ source: 'any', pattern: /word: (\w+)/ }],
        }),
      ],
    }))
    const result = matchAgent(plan2, { text: 'word: alpha, word: beta', source: 'user' })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.captures[0]).toBe('alpha')
  })

  it('returns empty captures array when regex has no groups', () => {
    const plan2 = compileAgent(agent('no-groups', {
      system: 'hi',
      tools: [
        tool('t', {
          match: [{ source: 'any', pattern: /hello/ }],
        }),
      ],
    }))
    const result = matchAgent(plan2, { text: 'say hello', source: 'user' })
    expect(result.candidates[0]!.captures).toEqual([])
  })

  it('respects tool declaration order', () => {
    const result = matchAgent(plan, { text: 'please create an issue how do I do something?', source: 'user' })
    // create-issue appears before lookup-docs in the spec
    const names = result.candidates.map(c => c.name)
    const createIdx = names.indexOf('create-issue')
    const lookupIdx = names.indexOf('lookup-docs')
    expect(createIdx).toBeLessThan(lookupIdx)
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
  })

  it('serialized patterns are strings not RegExp objects', async () => {
    const { body } = await get(srv.baseUrl, `/api/suites/${suite.id}/execution-plan`)
    const plan = (body as Record<string, unknown>)['plan'] as Record<string, unknown>
    const tools = plan['tools'] as Array<{ match: Array<{ pattern: unknown }> }>
    expect(typeof tools[0]!.match[0]!.pattern).toBe('string')
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
