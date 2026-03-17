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
      // body: { suites: [{ id, name, path, flowCount, tags, hasError, expectedOutcome }] }
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
    purpose: 'Get the browse-oriented expanded plan for a suite, with validation diagnostics and rendered text. For UI display.',
    request: {
      params: { id: 'base64url-encoded relative file path' },
    },
    response: {
      status: 200,
      // body: { specName, baseUrl, steps, flowRanges, validation: { errors, warnings }, renderedPlan }
    },
  },
  getSuiteExecutionPlan: {
    method: 'GET',
    path: '/api/suites/{id}/execution-plan',
    purpose: 'Get the versioned machine-readable execution plan artifact for CLI consumption. env() and secret() markers are unresolved.',
    request: {
      params: { id: 'base64url-encoded relative file path' },
    },
    response: {
      status: 200,
      // body: { planVersion: 1, plan: ExecutionPlan, validation: { errors, warnings }, expectedOutcome, tags, safety }
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
