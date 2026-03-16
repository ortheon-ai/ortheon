import { spec, flow, step, expect, ref, env } from '../../../src/dsl.js'

// Intentionally invalid spec: ref('orderId') is used before any step saves it.
// This spec exists as a fixture for the server self-tests -- it is structurally
// valid TypeScript and loads cleanly, but fails pass-2 validation at run time,
// producing a run with status 'error' and a non-empty validation.errors array.

export default spec('invalid: bad refs fixture', {
  baseUrl: env('DEMO_BASE_URL'),
  tags: ['invalid-fixture'],
  expectedOutcome: 'error',
  flows: [
    flow('bad flow', {
      steps: [
        step('assert unsaved ref',
          expect(ref('orderId'), 'equals', 'some-id')
        ),
      ],
    }),
  ],
})
