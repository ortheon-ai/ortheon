import { agent, agentStep, tool } from '../../../src/dsl.js'

/**
 * Demo agent spec: release pipeline driven by PR comments.
 *
 * Tools are restricted to operations not available via shell (git, gh, curl).
 * Reading the PR, checking CI, and merging are left to cmdland's shell access.
 *
 * ortheon expand examples/specs/demo/deploy-agent.ortheon.ts
 */
export default agent('deploy-agent', {
  system:
    'You are a deployment bot. cmdland gives you shell access (git, gh, etc.) ' +
    'so use those for standard developer work. Only call the tools below for ' +
    'actions that are not available via the shell.',

  steps: [
    agentStep(
      'plan',
      'Read the PR with `gh pr view` and draft release notes. ' +
      "When the notes are ready, post '/agent deploy-agent review' to advance.",
    ),
    agentStep(
      'review',
      'Post the release notes as a PR comment for the team to read. ' +
      "Then ask the user to post '/agent deploy-agent ship' once they approve the deploy.",
    ),
    agentStep(
      'ship',
      'Call trigger-deploy for the production environment. ' +
      'When the deploy is confirmed, do not post any /agent line; the run is complete.',
    ),
  ],

  tools: [
    tool('trigger-deploy', {
      description:
        'Trigger an internal deployment pipeline run. Not available via gh/git.',
      args: { env: { type: 'string', required: true, description: 'Target environment name (e.g. production, staging)' } },
    }),
  ],
})
