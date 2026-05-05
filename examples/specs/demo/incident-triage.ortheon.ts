import { agent, agentStep, tool } from '../../../src/dsl.js'

/**
 * Demo agent spec: on-call incident triage triggered by a GitHub discussion.
 *
 * Tools are restricted to internal operations not reachable via the shell.
 * Reading logs, querying status pages, or posting comments use shell access.
 *
 * ortheon expand examples/specs/demo/incident-triage.ortheon.ts
 */
export default agent('incident-triage', {
  system:
    'You are an on-call triage bot. You have shell access (curl, gh, etc.) ' +
    'so use those for standard ops work. Only call the tools below for actions that ' +
    'are not reachable via the shell.',

  steps: [
    agentStep(
      'investigate',
      'Read the incident description and any attached logs. ' +
      'Check the status page and recent deploys with shell access. ' +
      "Post your findings as a comment, then post '/agent incident-triage escalate' " +
      'to escalate or resolve if the issue is already fixed.',
    ),
    agentStep(
      'escalate',
      'Call notify-on-call to page the responsible team and set-feature-flag to disable the ' +
      'affected feature if needed. ' +
      "Ask the responder to post '/agent incident-triage resolve' once the incident is closed.",
    ),
    agentStep(
      'resolve',
      'Call update-incident-status to mark the incident resolved. ' +
      'Do not post any /agent line when done; the run is complete.',
    ),
  ],

  tools: [
    tool('notify-on-call', {
      description:
        'Page the on-call engineer via PagerDuty. Not available via the shell.',
      args: {
        team: { type: 'string', required: true, description: 'Team slug to page (e.g. platform, backend)' },
        message: { type: 'string', required: true, description: 'Short description of the incident' },
      },
    }),
    tool('set-feature-flag', {
      description:
        'Enable or disable a feature flag in LaunchDarkly. Not available via the shell.',
      args: {
        flag: { type: 'string', required: true, description: 'Feature flag key' },
        enabled: { type: 'boolean', required: true, description: 'Whether to enable or disable the flag' },
      },
    }),
    tool('update-incident-status', {
      description:
        'Update the incident record status in the internal incident tracker. Not available via the shell.',
      args: {
        status: { type: 'string', required: true, description: 'New status: investigating | identified | resolved' },
        summary: { type: 'string', description: 'Short resolution summary (required when status is resolved)' },
      },
    }),
  ],
})
