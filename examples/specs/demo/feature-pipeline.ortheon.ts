import { workflow, trigger, workflowStep } from '../../../src/dsl.js'

/**
 * Demo workflow: runs a feature pipeline when a release discussion is opened.
 *
 * ortheon expand examples/specs/demo/feature-pipeline.ortheon.ts
 */
export default workflow('feature-pipeline', {
  trigger: trigger.discussion({ category: 'releases', command: '/ship' }),
  steps: [
    workflowStep.agent('plan-agent'),
    workflowStep.agent('review-agent', { approveBefore: true }),
    workflowStep.agent('deploy-agent', { approveBefore: true, approveAfter: true }),
  ],
})
