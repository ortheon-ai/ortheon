import type { ApiContract } from '../../src/types.js'

// API contracts for the Ortheon web server (ortheon serve).
// All routes are under /api.

export const serverApi: Record<string, ApiContract> = {
  listSuites: {
    method: 'GET',
    path: '/api/suites',
    purpose: 'List all discovered spec suites with summary metadata. Sorted lexically by path.',
    request: {
      query: {
        name: 'optional -- case-insensitive substring match on suite name',
        tag:  'optional -- case-insensitive exact match against suite tags',
      },
    },
    response: {
      status: 200,
      // body: { suites: [{ id, name, path, flowCount, tags, hasError }] }
    },
  },
  getSuite: {
    method: 'GET',
    path: '/api/suites/{id}',
    purpose: 'Get metadata for a specific suite (no AST, no secrets)',
    request: {
      params: { id: 'base64url-encoded relative file path' },
    },
    response: {
      status: 200,
      // body: { id, name, path, flowNames, stepCount, apiNames, tags, safety }
    },
  },
  getSuitePlan: {
    method: 'GET',
    path: '/api/suites/{id}/plan',
    purpose: 'Get the expanded execution plan for a suite, with validation diagnostics',
    request: {
      params: { id: 'base64url-encoded relative file path' },
    },
    response: {
      status: 200,
      // body: { specName, baseUrl, steps, validation: { errors, warnings }, renderedPlan }
    },
  },
  startSuiteRun: {
    method: 'POST',
    path: '/api/suites/{id}/run',
    purpose: 'Start an async run for a suite. Always validates first; refuses invalid suites.',
    request: {
      params: { id: 'base64url-encoded relative file path' },
      // body: { headed?: boolean, baseUrl?: string, timeoutMs?: number } -- all optional
    },
    response: {
      status: 201,
      // body: { runId: string }
    },
  },
  runAll: {
    method: 'POST',
    path: '/api/run-all',
    purpose: 'Start an async run for every discovered suite. Supports excludeTags to skip suites by tag.',
    request: {
      // body: { headed?: boolean, baseUrl?: string, timeoutMs?: number, excludeTags?: string[] } -- all optional
    },
    response: {
      status: 201,
      // body: { runIds: string[] }
    },
  },
  listRuns: {
    method: 'GET',
    path: '/api/runs',
    purpose: 'List all runs with summary status (last 100 retained in memory)',
    response: {
      status: 200,
      // body: { runs: [{ id, suiteId, suiteName, status, startedAt, durationMs }] }
    },
  },
  getRun: {
    method: 'GET',
    path: '/api/runs/{runId}',
    purpose: 'Get full run detail including per-step results, validation diagnostics, and timing',
    request: {
      params: { runId: 'UUID assigned when the run was created' },
    },
    response: {
      status: 200,
      // body: { id, suiteId, suiteName, status, startedAt, finishedAt, durationMs,
      //         error, validation, flows, totalSteps, passedSteps, failedSteps }
    },
  },
  listContracts: {
    method: 'GET',
    path: '/api/contracts',
    purpose: 'List all API contracts aggregated across all loaded suites',
    response: {
      status: 200,
      // body: { contracts: [{ name, method, path, purpose, suiteCount }] }
    },
  },
  getContract: {
    method: 'GET',
    path: '/api/contracts/{name}',
    purpose: 'Get full contract detail including request/response metadata and the suites that use it',
    request: {
      params: { name: 'contract name (key in the apis catalog)' },
    },
    response: {
      status: 200,
      // body: { name, method, path, purpose, request, response, suites: [{ id, name }] }
    },
  },
}
