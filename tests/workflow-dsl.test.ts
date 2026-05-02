import { describe, it, expect } from 'vitest'
import { workflow, trigger, workflowStep } from '../src/dsl.js'
import { compileWorkflow, formatWorkflowSpec, formatWorkflowPlan } from '../src/compiler.js'

describe('workflow DSL + compileWorkflow', () => {
  it('round-trips a discussion-trigger workflow through compileWorkflow', () => {
    const spec = workflow('feature-pipeline', {
      trigger: trigger.discussion({ category: 'releases' }),
      steps: [
        workflowStep.agent('plan-agent'),
        workflowStep.agent('review-agent', { approveBefore: true }),
        workflowStep.agent('deploy-agent', { approveBefore: true }),
      ],
    })

    expect(spec.__type).toBe('workflow')
    expect(spec.name).toBe('feature-pipeline')
    expect(spec.trigger).toEqual({ kind: 'discussion', category: 'releases' })
    expect(spec.steps).toHaveLength(3)

    const plan = compileWorkflow(spec)
    expect(plan.specName).toBe('feature-pipeline')
    expect(plan.trigger).toEqual({ kind: 'discussion', category: 'releases' })
    expect(plan.steps).toHaveLength(3)
    expect(plan.steps[0]).toEqual({ kind: 'agent', specName: 'plan-agent' })
    expect(plan.steps[1]).toEqual({ kind: 'agent', specName: 'review-agent', approveBefore: true })
    expect(plan.steps[2]).toEqual({ kind: 'agent', specName: 'deploy-agent', approveBefore: true })
  })

  it('derives gates from approveBefore and approveAfter', () => {
    const spec = workflow('gated-pipeline', {
      trigger: trigger.manual(),
      steps: [
        workflowStep.agent('agent-a'),
        workflowStep.agent('agent-b', { approveAfter: true }),
        workflowStep.agent('agent-c', { approveBefore: true, approveAfter: true }),
      ],
    })

    const plan = compileWorkflow(spec)
    expect(plan.gates).toEqual([
      { stepIndex: 1, position: 'after' },
      { stepIndex: 2, position: 'before' },
      { stepIndex: 2, position: 'after' },
    ])
  })

  it('produces an empty gates array when no gates are declared', () => {
    const spec = workflow('ungated', {
      trigger: trigger.cron('0 9 * * 1'),
      steps: [workflowStep.agent('worker')],
    })
    const plan = compileWorkflow(spec)
    expect(plan.gates).toEqual([])
  })

  it('trigger.cron preserves the expression', () => {
    const t = trigger.cron('*/15 * * * *')
    expect(t).toEqual({ kind: 'cron', expr: '*/15 * * * *' })
  })

  it('trigger.manual produces the correct shape', () => {
    expect(trigger.manual()).toEqual({ kind: 'manual' })
  })

  it('trigger.spawn carries maxDepth', () => {
    expect(trigger.spawn({ maxDepth: 3 })).toEqual({ kind: 'spawn', maxDepth: 3 })
  })

  it('trigger.discussion with optional command', () => {
    const t = trigger.discussion({ category: 'bugs', command: '/triage' })
    expect(t).toEqual({ kind: 'discussion', category: 'bugs', command: '/triage' })
  })

  it('workflowStep.agent omits optional fields when not set', () => {
    const s = workflowStep.agent('my-agent')
    expect(s).toEqual({ kind: 'agent', specName: 'my-agent' })
    expect('approveBefore' in s).toBe(false)
    expect('approveAfter' in s).toBe(false)
  })

  it('formatWorkflowSpec renders trigger and steps', () => {
    const spec = workflow('my-pipeline', {
      trigger: trigger.discussion({ category: 'releases' }),
      steps: [
        workflowStep.agent('plan-agent'),
        workflowStep.agent('review-agent', { approveBefore: true }),
      ],
    })
    const output = formatWorkflowSpec(spec)
    expect(output).toContain('Workflow: my-pipeline')
    expect(output).toContain('discussion(category: "releases")')
    expect(output).toContain('plan-agent')
    expect(output).toContain('review-agent')
    expect(output).toContain('[approveBefore]')
  })

  it('formatWorkflowPlan renders gates section', () => {
    const spec = workflow('gated', {
      trigger: trigger.manual(),
      steps: [
        workflowStep.agent('agent-a'),
        workflowStep.agent('agent-b', { approveAfter: true }),
      ],
    })
    const plan = compileWorkflow(spec)
    const output = formatWorkflowPlan(plan)
    expect(output).toContain('Gates (1)')
    expect(output).toContain('step 2 after')
  })
})
