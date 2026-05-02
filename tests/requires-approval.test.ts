import { describe, it, expect } from 'vitest'
import { agent, tool } from '../src/dsl.js'
import { compileAgent } from '../src/compiler.js'

describe('requires_approval round-trip through compileAgent', () => {
  it('propagates requires_approval: true into SerializedTool', () => {
    const spec = agent('gated-agent', {
      system: 'You are a deployment bot.',
      tools: [
        tool('merge-pr', { requires_approval: true }),
        tool('read-pr', {}),
      ],
    })

    const plan = compileAgent(spec)

    const mergePr = plan.tools.find(t => t.name === 'merge-pr')
    expect(mergePr).toBeDefined()
    expect(mergePr?.requires_approval).toBe(true)
  })

  it('omits requires_approval from SerializedTool when not set', () => {
    const spec = agent('safe-agent', {
      system: 'You are a read-only bot.',
      tools: [
        tool('read-pr', {}),
      ],
    })

    const plan = compileAgent(spec)
    const readPr = plan.tools.find(t => t.name === 'read-pr')
    expect(readPr).toBeDefined()
    expect('requires_approval' in (readPr ?? {})).toBe(false)
  })

  it('omits requires_approval from SerializedTool when explicitly false', () => {
    const spec = agent('explicit-false-agent', {
      system: 'You are a bot.',
      tools: [
        tool('do-thing', { requires_approval: false }),
      ],
    })

    const plan = compileAgent(spec)
    const doThing = plan.tools.find(t => t.name === 'do-thing')
    expect(doThing).toBeDefined()
    expect('requires_approval' in (doThing ?? {})).toBe(false)
  })

  it('is JSON-serializable (survives JSON round-trip)', () => {
    const spec = agent('gated-agent', {
      system: 'You are a deployment bot.',
      tools: [
        tool('deploy', { requires_approval: true, args: { env: { type: 'string', required: true } } }),
      ],
    })

    const plan = compileAgent(spec)
    const roundTripped = JSON.parse(JSON.stringify(plan))
    expect(roundTripped.tools[0].requires_approval).toBe(true)
    expect(roundTripped.tools[0].name).toBe('deploy')
  })

  it('handles mix of approved and non-approved tools', () => {
    const spec = agent('mixed-agent', {
      system: 'You are a mixed bot.',
      tools: [
        tool('safe-read', {}),
        tool('destructive-delete', { requires_approval: true }),
        tool('safe-write', {}),
        tool('dangerous-deploy', { requires_approval: true }),
      ],
    })

    const plan = compileAgent(spec)
    const approvedTools = plan.tools.filter(t => t.requires_approval === true)
    const normalTools = plan.tools.filter(t => !t.requires_approval)

    expect(approvedTools.map(t => t.name)).toEqual(['destructive-delete', 'dangerous-deploy'])
    expect(normalTools.map(t => t.name)).toEqual(['safe-read', 'safe-write'])
  })
})
