import { workflow, trigger, workflowStep } from '../../../src/dsl.js'

/**
 * Sample workflow: runs a release pipeline when a release discussion is opened.
 *
 * ortheon expand examples/specs/workflows/sample-workflow.ortheon.ts
 */
export default workflow('sample-release-pipeline', {
  trigger: trigger.discussion({ category: 'releases', command: '/ship' }),
  steps: [
    workflowStep.agent('plan-agent'),
    workflowStep.agent('review-agent', { approveBefore: true }),
    workflowStep.agent('deploy-agent', { approveBefore: true, approveAfter: true }),
  ],
})
