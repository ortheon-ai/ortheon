import { describe, it, expect } from 'vitest'
import { workflow, trigger, workflowStep } from '../src/dsl.js'
import { validateWorkflow } from '../src/validator.js'

describe('validateWorkflow', () => {
  it('passes a valid discussion-trigger workflow', () => {
    const spec = workflow('feature-pipeline', {
      trigger: trigger.discussion({ category: 'releases' }),
      steps: [
        workflowStep.agent('plan-agent'),
        workflowStep.agent('review-agent'),
      ],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('errors on empty steps array', () => {
    const spec = workflow('empty', {
      trigger: trigger.manual(),
      steps: [],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('at least one step'))).toBe(true)
  })

  it('errors on invalid cron expression', () => {
    const spec = workflow('cron-bad', {
      trigger: trigger.cron('not-a-cron'),
      steps: [workflowStep.agent('worker')],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('cron'))).toBe(true)
  })

  it('accepts a valid 5-field cron expression', () => {
    const spec = workflow('cron-good', {
      trigger: trigger.cron('0 9 * * 1'),
      steps: [workflowStep.agent('worker')],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(true)
  })

  it('accepts wildcard-step cron expressions', () => {
    const spec = workflow('cron-wildcard', {
      trigger: trigger.cron('*/15 * * * *'),
      steps: [workflowStep.agent('worker')],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(true)
  })

  it('errors when discussion trigger has empty category', () => {
    const spec = workflow('disc-no-cat', {
      trigger: { kind: 'discussion', category: '' },
      steps: [workflowStep.agent('worker')],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('category'))).toBe(true)
  })

  it('errors when spawn trigger has maxDepth < 1', () => {
    const spec = workflow('spawn-bad', {
      trigger: { kind: 'spawn', maxDepth: 0 },
      steps: [workflowStep.agent('worker')],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('maxDepth'))).toBe(true)
  })

  it('accepts spawn trigger with maxDepth >= 1', () => {
    const spec = workflow('spawn-ok', {
      trigger: trigger.spawn({ maxDepth: 2 }),
      steps: [workflowStep.agent('worker')],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(true)
  })

  it('errors on non-kebab-case specName', () => {
    const spec = workflow('bad-names', {
      trigger: trigger.manual(),
      steps: [
        workflowStep.agent('PlanAgent'),
      ],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('kebab-case'))).toBe(true)
  })

  it('errors when first step has approveBefore', () => {
    const spec = workflow('first-gate', {
      trigger: trigger.manual(),
      steps: [
        workflowStep.agent('agent-a', { approveBefore: true }),
        workflowStep.agent('agent-b'),
      ],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('first step'))).toBe(true)
  })

  it('allows approveBefore on steps other than the first', () => {
    const spec = workflow('gate-ok', {
      trigger: trigger.manual(),
      steps: [
        workflowStep.agent('agent-a'),
        workflowStep.agent('agent-b', { approveBefore: true }),
      ],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(true)
  })

  it('reports multiple errors in one pass', () => {
    const spec = workflow('multi-errors', {
      trigger: trigger.cron('bad-cron'),
      steps: [
        workflowStep.agent('BadName', { approveBefore: true }),
      ],
    })
    const result = validateWorkflow(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })
})
