/**
 * Integration test for the remote-plan execution path.
 *
 * Proves the full round-trip:
 *   CLI  →  GET /api/suites/:id/execution-plan  →  runPlan()  →  result
 *
 * Starts:
 *   1. The demo app server (port 3737) -- target for spec runs
 *   2. The ortheon web server (port 4002) -- serving example specs
 *
 * Then:
 *   1. Lists suites via GET /api/suites (simulates `ortheon list --from`)
 *   2. Fetches the execution plan for the health suite (simulates `ortheon run --from ... --suite`)
 *   3. Runs the plan via runPlan() with env vars set locally
 *   4. Asserts the result is a pass
 *
 * DEMO_BASE_URL must resolve from the local environment so runPlan() can
 * execute the health spec's steps. The server never sees this value.
 */

import { startServer as startDemoServer } from '../demo/server.ts'
import { discoverSuites, startServer as startOrtheonServer, encodeSuiteId } from '../src/server/app.ts'
import { runPlan } from '../src/runner.ts'
import { consoleReport, consoleSummary } from '../src/reporter.ts'
import type { ExecutionPlan, SpecResult } from '../src/types.ts'

const DEMO_PORT = 3737
const ORTHEON_PORT = 4002
const DEMO_BASE_URL = `http://localhost:${DEMO_PORT}`
const ORTHEON_BASE_URL = `http://localhost:${ORTHEON_PORT}`
const SPEC_GLOB = 'examples/specs/**/*.ortheon.ts'

// The CLI caller sets its own env vars -- the server never sees these.
process.env['DEMO_BASE_URL'] ??= DEMO_BASE_URL

console.log('Starting demo server...')
const demoServer = await startDemoServer(DEMO_PORT)

console.log('Discovering and starting ortheon server...')
const suites = await discoverSuites(SPEC_GLOB, process.cwd())
const ortheonServer = await startOrtheonServer(suites, ORTHEON_PORT)

const results: SpecResult[] = []
let anyFailed = false
let passed = 0
let failed = 0

function ok(msg: string) { console.log(`  ✔ ${msg}`); passed++ }
function fail(msg: string) { console.error(`  ✘ ${msg}`); failed++; anyFailed = true }

try {
  // -------------------------------------------------------------------------
  // Step 1: List suites (simulates `ortheon list --from`)
  // -------------------------------------------------------------------------
  console.log(`\n[1] Listing suites from ${ORTHEON_BASE_URL}`)

  const listRes = await fetch(`${ORTHEON_BASE_URL}/api/suites`)
  if (!listRes.ok) fail(`GET /api/suites returned HTTP ${listRes.status}`)
  else {
    const data = await listRes.json() as { suites: Array<{ id: string; name: string }> }
    ok(`GET /api/suites returned ${data.suites.length} suites`)
    const health = data.suites.find(s => s.name === 'service health check')
    if (!health) fail('health suite not found in suite list')
    else ok(`health suite found: id=${health.id}`)
  }

  // -------------------------------------------------------------------------
  // Step 2: Fetch execution plan for the health suite
  //         (simulates `ortheon run --from ... --suite <id>`)
  // -------------------------------------------------------------------------
  const healthId = encodeSuiteId('examples/specs/smoke/health.ortheon.ts')
  const planUrl = `${ORTHEON_BASE_URL}/api/suites/${healthId}/execution-plan`
  console.log(`\n[2] Fetching execution plan: ${planUrl}`)

  const planRes = await fetch(planUrl)
  if (!planRes.ok) {
    fail(`GET /api/suites/:id/execution-plan returned HTTP ${planRes.status}`)
    throw new Error('Cannot continue without a plan')
  }

  const artifact = await planRes.json() as {
    planVersion: number
    plan: ExecutionPlan
    validation: { errors: string[]; warnings: string[] }
  }

  ok(`plan fetched: planVersion=${artifact.planVersion}`)

  if (artifact.planVersion !== 1) {
    fail(`unexpected planVersion: ${artifact.planVersion}`)
  } else {
    ok('planVersion is 1')
  }

  if (artifact.validation.errors.length > 0) {
    fail(`plan has validation errors: ${artifact.validation.errors.join('; ')}`)
    throw new Error('Plan is invalid; aborting execution')
  } else {
    ok('plan passed server-side validation')
  }

  ok(`plan specName: ${artifact.plan.specName}`)
  ok(`plan steps: ${artifact.plan.steps.length}`)

  // -------------------------------------------------------------------------
  // Step 3: Execute plan locally with user-provided env vars
  //         The server did NOT resolve DEMO_BASE_URL -- the CLI does it here.
  // -------------------------------------------------------------------------
  console.log('\n[3] Running plan via runPlan() (env vars from local process)')

  const result = await runPlan(artifact.plan)
  results.push(result)
  consoleReport(result)

  if (result.status === 'pass') {
    ok(`plan executed successfully: ${result.passedSteps}/${result.totalSteps} steps passed`)
  } else {
    fail(`plan execution failed: ${result.failedSteps}/${result.totalSteps} steps failed`)
    anyFailed = true
  }

} catch (err) {
  console.error('\nUnexpected error:', err)
  anyFailed = true
} finally {
  demoServer.close()
  ortheonServer.close()
}

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log('\n─────────────────────────────────────')
console.log(`CLI remote-plan tests: ${passed} checks passed, ${failed} failed`)
if (results.length > 0) {
  consoleSummary(results)
}
console.log('─────────────────────────────────────')

process.exit(anyFailed ? 1 : 0)
