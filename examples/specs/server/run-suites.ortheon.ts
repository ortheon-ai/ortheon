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

const HEALTH_SUITE_ID = 'ZXhhbXBsZXMvc3BlY3Mvc21va2UvaGVhbHRoLm9ydGhlb24udHM'

export default spec('ortheon server: run suites', {
  baseUrl: env('ORTHEON_SERVER_URL'),
  apis: { ...serverApi },
  tags: ['server', 'run'],
  safety: 'non-destructive',
  flows: [
    flow('api: start and monitor a run', {
      steps: [
        section('start run', [
          step('start run for health suite',
            api('startSuiteRun', {
              params: { id: HEALTH_SUITE_ID },
              body: {},
              expect: {
                status: 201,
                body: { runId: existsCheck() },
              },
              save: { runId: 'body.runId' },
            })
          ),
          step('runId is a non-empty string',
            expect(ref('runId'), 'exists')
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
          // Retry up to 15 times (each retry delays 500ms * attempt).
          // The health spec should complete within a few seconds.
          // If body.status is 'running' or 'pending', the inline expect
          // body check fails, causing the step to retry.
          step('wait for run to pass',
            api('getRun', {
              params: { runId: ref('runId') },
              expect: {
                status: 200,
                body: { status: 'pass' },
              },
              save: {
                runStatus: 'body.status',
                runPassedSteps: 'body.passedSteps',
              },
            }),
            { retries: 15 }
          ),
          step('run status is pass',
            expect(ref('runStatus'), 'equals', 'pass')
          ),
          step('run has passed steps',
            expect(ref('runPassedSteps'), 'exists')
          ),
        ]),
      ],
    }),

    flow('browser: run via web UI', {
      steps: [
        section('navigate to suite detail', [
          step('navigate to health suite detail',
            browser('goto', { url: `/suites/${HEALTH_SUITE_ID}` })
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
