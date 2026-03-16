/**
 * Integration runner for the ortheon server self-test suite.
 *
 * Starts:
 *   1. The demo app server (port 3737) -- target for spec runs
 *   2. The ortheon web server (port 4001) -- serving example specs
 *
 * Then runs the server self-test specs (browse-suites, run-suites) against
 * the ortheon server and reports results.
 *
 * ORTHEON_SERVER_URL is set so specs know where to call the server API.
 * DEMO_BASE_URL is set so the health suite can actually run.
 */

import { startServer as startDemoServer } from '../demo/server.ts'
import { discoverSuites, startServer as startOrtheonServer } from '../src/server/app.ts'
import { runSpec } from '../src/runner.ts'
import { consoleReport, consoleSummary } from '../src/reporter.ts'
import type { SpecResult } from '../src/types.ts'

const DEMO_PORT = 3737
const ORTHEON_PORT = 4001
const DEMO_BASE_URL = `http://localhost:${DEMO_PORT}`
const ORTHEON_BASE_URL = `http://localhost:${ORTHEON_PORT}`
const SPEC_GLOB = 'examples/specs/**/*.ortheon.ts'

// Configure environment for all specs.
// DEMO_BASE_URL is the demo app (target for health/order specs).
// ORTHEON_SERVER_URL is the ortheon web server (target for server self-tests).
process.env['DEMO_BASE_URL'] ??= DEMO_BASE_URL
process.env['ORTHEON_SERVER_URL'] ??= ORTHEON_BASE_URL
process.env['E2E_USER_PASSWORD'] ??= 'password123'
process.env['E2E_USER_EMAIL'] ??= 'buyer@example.com'
process.env['E2E_ADMIN_EMAIL'] ??= 'admin@example.com'
process.env['E2E_ADMIN_PASSWORD'] ??= 'adminpass'
console.log('Starting demo server...')
const demoServer = await startDemoServer(DEMO_PORT)

console.log('Discovering and starting ortheon server...')
const suites = await discoverSuites(SPEC_GLOB, process.cwd())
const ortheonServer = await startOrtheonServer(suites, ORTHEON_PORT)

const results: SpecResult[] = []
let anyFailed = false

async function run(name: string, specFile: string) {
  console.log(`\nLoading spec: ${name}`)
  const mod = await import(specFile)
  const s = mod.default
  const result = await runSpec(s, {
    baseUrl: ORTHEON_BASE_URL,
    skipValidation: false,
  })
  results.push(result)
  consoleReport(result)
  if (result.status === 'fail') anyFailed = true
}

try {
  // Browse and expand spec -- API + browser
  await run('browse suites', '../examples/specs/server/browse-suites.ortheon.ts')

  // Run spec -- API + browser
  await run('run suites', '../examples/specs/server/run-suites.ortheon.ts')
} catch (err) {
  console.error('Unexpected error:', err)
  anyFailed = true
} finally {
  demoServer.close()
  ortheonServer.close()
}

consoleSummary(results)
process.exit(anyFailed ? 1 : 0)
