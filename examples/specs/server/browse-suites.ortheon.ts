import { spec, flow, step, api, expect, browser, ref, env, existsCheck, section } from '../../../src/dsl.js'
import { serverApi } from '../../contracts/server.js'

// Self-test spec: verifies the ortheon server's browse/expand API and web UI.
//
// Assumes the server was started with:
//   ortheon serve examples/specs/**/*.ortheon.ts
//
// ORTHEON_SERVER_URL must be set (e.g. http://localhost:4000).
// The health suite is used as the known reference suite.
// All assertions are behavioral -- not incidental inventory counts.

const KNOWN_SUITE_NAME = 'service health check'
const KNOWN_STEP_SUBSTRING = 'GET /api/health'

export default spec('ortheon server: browse and expand', {
  baseUrl: env('ORTHEON_SERVER_URL'),
  apis: { ...serverApi },
  tags: ['server', 'browse'],
  safety: 'non-destructive',
  flows: [
    flow('api: list and inspect suites', {
      steps: [
        section('suite list', [
          step('list suites',
            api('listSuites', {
              expect: {
                status: 200,
                body: { suites: existsCheck() },
              },
              save: {
                firstSuiteId: 'body.suites[0].id',
                firstSuiteName: 'body.suites[0].name',
              },
            })
          ),
          step('suite list is non-empty',
            expect(ref('firstSuiteId'), 'exists')
          ),
        ]),

        section('suite detail', [
          step('get first suite detail',
            api('getSuite', {
              params: { id: ref('firstSuiteId') },
              expect: {
                status: 200,
                body: {
                  id: existsCheck(),
                  name: existsCheck(),
                  flowNames: existsCheck(),
                  stepCount: existsCheck(),
                  apiNames: existsCheck(),
                },
              },
              save: {
                suiteDetailName: 'body.name',
                suiteFlowNames: 'body.flowNames',
              },
            })
          ),
          step('suite detail name matches list name',
            expect(ref('suiteDetailName'), 'equals', ref('firstSuiteName'))
          ),
        ]),

        section('expanded plan', [
          step('get expanded plan for first suite',
            api('getSuitePlan', {
              params: { id: ref('firstSuiteId') },
              expect: {
                status: 200,
                body: {
                  specName: existsCheck(),
                  steps: existsCheck(),
                  validation: existsCheck(),
                  renderedPlan: existsCheck(),
                },
              },
              save: {
                firstPlanStepName: 'body.steps[0].name',
                renderedPlan: 'body.renderedPlan',
              },
            })
          ),
          step('plan has at least one step',
            expect(ref('firstPlanStepName'), 'exists')
          ),
          step('rendered plan is a non-empty string',
            expect(ref('renderedPlan'), 'exists')
          ),
        ]),

        section('known suite assertions', [
          // These steps require the known health suite to be in the server's suite list.
          // They use the health spec's known ID (base64url of its relative path).
          step('get health suite detail',
            api('getSuite', {
              params: { id: 'ZXhhbXBsZXMvc3BlY3Mvc21va2UvaGVhbHRoLm9ydGhlb24udHM' },
              expect: { status: 200 },
              save: {
                healthSuiteName: 'body.name',
              },
            })
          ),
          step('health suite name is correct',
            expect(ref('healthSuiteName'), 'equals', KNOWN_SUITE_NAME)
          ),
          step('get health suite expanded plan',
            api('getSuitePlan', {
              params: { id: 'ZXhhbXBsZXMvc3BlY3Mvc21va2UvaGVhbHRoLm9ydGhlb24udHM' },
              expect: { status: 200 },
              save: {
                healthRenderedPlan: 'body.renderedPlan',
              },
            })
          ),
          step('health plan contains known step action',
            expect(ref('healthRenderedPlan'), 'contains', KNOWN_STEP_SUBSTRING)
          ),
        ]),
      ],
    }),

    flow('browser: dashboard and suite detail', {
      steps: [
        section('dashboard', [
          step('navigate to dashboard',
            browser('goto', { url: '/' })
          ),
          step('wait for suite list to appear',
            browser('waitFor', { target: '[data-testid="suite-list"]', state: 'visible' })
          ),
          step('extract first suite id from dashboard',
            browser('extract', {
              target: '[data-testid="suite-card"]:first-child',
              save: { firstCardSuiteId: 'attr:data-suite-id' },
            })
          ),
          step('first card suite id is non-empty',
            expect(ref('firstCardSuiteId'), 'exists')
          ),
        ]),

        section('suite detail navigation', [
          step('click first suite card',
            browser('click', { target: '[data-testid="suite-card"]:first-child' })
          ),
          step('wait for suite detail to appear',
            browser('waitFor', { target: '[data-testid="suite-detail"]', state: 'visible' })
          ),
          step('wait for plan steps to appear',
            browser('waitFor', { target: '[data-testid="plan-steps"]', state: 'visible' })
          ),
          step('run button is visible',
            browser('waitFor', { target: '[data-testid="run-button"]', state: 'visible' })
          ),
        ]),
      ],
    }),
  ],
})
