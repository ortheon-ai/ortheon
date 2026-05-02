import { agent, tool } from '../../../src/dsl.js'

/**
 * Demo agent spec showing requires_approval on a destructive tool.
 *
 * ortheon expand examples/specs/demo/deploy-agent.ortheon.ts
 */
export default agent('deploy-agent', {
  system: 'You are a deployment bot. Prepare release notes, then merge the PR and deploy.',

  tools: [
    tool('read-pr', {
      source: 'llm',
      args: { pr: { type: 'string', required: true } },
      prompt: 'Fetch the PR diff and description.',
    }),
    tool('write-release-notes', {
      source: 'llm',
      args: { content: { type: 'string', required: true } },
    }),
    tool('merge-pr', {
      source: 'llm',
      requires_approval: true,
      args: { pr: { type: 'string', required: true } },
      prompt: 'Merge the pull request after human approval.',
    }),
    tool('trigger-deploy', {
      source: 'llm',
      requires_approval: true,
      args: { env: { type: 'string', required: true } },
      prompt: 'Trigger a deployment to the specified environment after human approval.',
    }),
  ],
})
