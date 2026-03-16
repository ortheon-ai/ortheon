import { spec, flow, step, api, expect, browser, ref, env, existsCheck, section } from '../../../src/dsl.js'
import { serverApi } from '../../contracts/server.js'

// Self-test spec: verifies the ortheon server's run execution API and web UI.
//
// Assumes the server was started with:
//   ortheon serve examples/specs/**/*.ortheon.ts
//
// ORTHEON_SERVER_URL must be set (e.g. http://localhost:4000).
// APP_BASE_URL must also be set so the health spec has a baseUrl to run against.
//
// The health suite is used as the known target suite because it is fast,
// API-only, and has a predictable pass outcome.
//
// The invalid fixture suite (examples/specs/invalid/bad-refs.ortheon.ts) is used
// to exercise the validate-before-run lifecycle and the error run detail shape.
//
// NOTE: API flows use ?name= filtering to discover suite IDs dynamically.
// The browser flow uses a hardcoded path for navigation because the DSL has no
// string-interpolation primitive -- this is the only remaining hardcoded ID.

const HEALTH_SUITE_NAME  = 'service health check'
const HEALTH_FLOW_NAME   = 'health check'
const INVALID_SUITE_NAME = 'invalid: bad refs fixture'

// Used only for browser navigation (SPA route construction requires a literal path).
const HEALTH_SUITE_PATH = '/suites/ZXhhbXBsZXMvc3BlY3Mvc21va2UvaGVhbHRoLm9ydGhlb24udHM'

export default spec('ortheon server: run suites', {
  baseUrl: env('ORTHEON_SERVER_URL'),
  apis: { ...serverApi },
  tags: ['server', 'run'],
  safety: 'non-destructive',
  flows: [
    flow('api: start and monitor a run', {
      steps: [
        section('discover health suite', [
          // Use the ?name= filter so we do not depend on hardcoded base64url IDs.
          step('find health suite by name',
            api('listSuites', {
              query: { name: HEALTH_SUITE_NAME },
              expect: {
                status: 200,
                body: { suites: existsCheck() },
              },
              save: {
                healthSuiteId: 'body.suites[0].id',
                healthSuiteName: 'body.suites[0].name',
              },
            })
          ),
          step('health suite id is non-empty',
            expect(ref('healthSuiteId'), 'exists')
          ),
        ]),

        section('start run', [
          step('start run for health suite',
            api('startSuiteRun', {
              params: { id: ref('healthSuiteId') },
              body: {},
              expect: {
                status: 201,
                body: { runId: existsCheck() },
              },
              save: { runId: 'body.runId' },
            })
          ),
          step('runId matches UUID format',
            expect(ref('runId'), 'matches', '^[0-9a-f]{8}-')
          ),
        ]),

        section('run appears in run list', [
          step('list runs',
            api('listRuns', {
              expect: {
                status: 200,
                body: { runs: existsCheck() },
              },
              save: { runListCount: 'body.runs.length' },
            })
          ),
          step('run list is non-empty',
            expect(ref('runListCount'), 'exists')
          ),
        ]),

        section('poll run to completion', [
          // Poll until the run reaches 'pass'. retryIntervalMs sets a fixed 1s cadence
          // rather than the default linear backoff -- the right choice for polling.
          // If body.status is 'running' or 'pending', the inline body match fails,
          // which triggers a retry.
          step('wait for run to pass',
            api('getRun', {
              params: { runId: ref('runId') },
              expect: {
                status: 200,
                body: { status: 'pass' },
              },
              save: {
                runStatus:      'body.status',
                runPassedSteps: 'body.passedSteps',
                runSuiteName:   'body.suiteName',
                runFinishedAt:  'body.finishedAt',
                runDurationMs:  'body.durationMs',
                runTotalSteps:  'body.totalSteps',
                runError:       'body.error',
                runFlowName:    'body.flows[0].name',
              },
            }),
            { retries: 15, retryIntervalMs: 1000 }
          ),
          step('run status is pass',
            expect(ref('runStatus'), 'equals', 'pass')
          ),
          step('run has passed steps',
            expect(ref('runPassedSteps'), 'exists')
          ),
          step('run suite name is correct',
            expect(ref('runSuiteName'), 'equals', HEALTH_SUITE_NAME)
          ),
          step('run has finished timestamp',
            expect(ref('runFinishedAt'), 'exists')
          ),
          step('run has duration',
            expect(ref('runDurationMs'), 'exists')
          ),
          step('run has total steps count',
            expect(ref('runTotalSteps'), 'exists')
          ),
          step('passing run has no error',
            expect(ref('runError'), 'notExists')
          ),
          // Proves that flow grouping is preserved in run results:
          // the first flow in the result must carry the authored flow name.
          step('run result preserves authored flow name',
            expect(ref('runFlowName'), 'equals', HEALTH_FLOW_NAME)
          ),
        ]),
      ],
    }),

    flow('api: invalid suite run lifecycle', {
      steps: [
        section('discover invalid fixture', [
          step('find invalid suite by name',
            api('listSuites', {
              query: { name: INVALID_SUITE_NAME },
              expect: {
                status: 200,
                body: { suites: existsCheck() },
              },
              save: {
                invalidSuiteId: 'body.suites[0].id',
              },
            })
          ),
          step('invalid suite id is non-empty',
            expect(ref('invalidSuiteId'), 'exists')
          ),
        ]),

        section('start run for invalid suite', [
          step('start invalid run',
            api('startSuiteRun', {
              params: { id: ref('invalidSuiteId') },
              body: {},
              expect: {
                status: 201,
                body: { runId: existsCheck() },
              },
              save: { invalidRunId: 'body.runId' },
            })
          ),
        ]),

        section('poll invalid run to error', [
          step('wait for invalid run to error',
            api('getRun', {
              params: { runId: ref('invalidRunId') },
              expect: {
                status: 200,
                body: { status: 'error' },
              },
              save: {
                invalidRunStatus:     'body.status',
                invalidRunError:      'body.error',
                invalidValidationErr: 'body.validation.errors[0]',
              },
            }),
            { retries: 10, retryIntervalMs: 500 }
          ),
          step('invalid run status is error',
            expect(ref('invalidRunStatus'), 'equals', 'error')
          ),
          step('invalid run has a validation error',
            expect(ref('invalidValidationErr'), 'exists')
          ),
          step('invalid run error message references validation',
            expect(ref('invalidRunError'), 'contains', 'Validation')
          ),
        ]),
      ],
    }),

    flow('browser: run via web UI', {
      steps: [
        section('navigate to suite detail', [
          step('navigate to health suite detail',
            browser('goto', { url: HEALTH_SUITE_PATH })
          ),
          step('wait for suite detail to load',
            browser('waitFor', { target: '[data-testid="suite-detail"]', state: 'visible' })
          ),
          step('wait for run button',
            browser('waitFor', { target: '[data-testid="run-button"]', state: 'visible' })
          ),
        ]),

        section('trigger and monitor run', [
          step('click run button',
            browser('click', { target: '[data-testid="run-button"]' })
          ),
          step('wait for run view to appear',
            browser('waitFor', { target: '[data-testid="run-status"]', state: 'visible' })
          ),
          step('wait for run to reach a terminal status',
            browser('waitFor', {
              target: '[data-testid="run-status"][data-status="pass"], [data-testid="run-status"][data-status="fail"], [data-testid="run-status"][data-status="error"]',
              state: 'visible',
              timeout: 30000,
            })
          ),
          step('extract run status from UI',
            browser('extract', {
              target: '[data-testid="run-status"]',
              save: { uiRunStatus: 'attr:data-status' },
            })
          ),
          step('UI run status is pass',
            expect(ref('uiRunStatus'), 'equals', 'pass')
          ),
        ]),
      ],
    }),
  ],
})
