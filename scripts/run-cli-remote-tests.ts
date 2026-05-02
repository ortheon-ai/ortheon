/**
 * Integration test for the remote-plan execution path.
 *
 * Proves the full round-trip for all example specs:
 *   CLI  →  GET /api/suites/:id/execution-plan  →  runPlan()  →  result
 *
 * Starts:
 *   1. The demo app server (port 3737) -- target for spec runs
 *   2. The ortheon web server (port 4002) -- serving example specs
 *
 * Then for each example spec:
 *   1. Fetches its execution plan from the ortheon server
 *   2. Runs the plan via runPlan() with env vars set locally
 *   3. Reports pass/fail
 *
 * This mirrors what `ortheon run --from <url> --suite <id>` does.
 * DEMO_BASE_URL and auth env vars are set here (as the "CLI user" would),
 * never passed to the server.
 */

import { startServer as startDemoServer } from '../demo/server.ts'
import { discoverSuites, startServer as startOrtheonServer, encodeSuiteId } from '../src/server/app.ts'
import { runPlan } from '../src/runner.ts'
import { consoleReport, consoleSummary } from '../src/reporter.ts'
import type { ExecutionPlan, SpecResult } from '../src/types.ts'

type SuiteListItem = {
  id: string
  name: string
  path: string
  type: string
  [key: string]: unknown
}

const DEMO_PORT = 3737
const ORTHEON_PORT = 4002
const DEMO_BASE_URL = `http://localhost:${DEMO_PORT}`
const ORTHEON_BASE_URL = `http://localhost:${ORTHEON_PORT}`
const SPEC_GLOB = 'examples/specs/**/*.ortheon.ts'

// The CLI caller sets its own env vars — the server never sees these.
process.env['DEMO_BASE_URL'] ??= DEMO_BASE_URL
process.env['E2E_USER_PASSWORD'] ??= 'password123'
process.env['E2E_USER_EMAIL'] ??= 'buyer@example.com'
process.env['E2E_ADMIN_EMAIL'] ??= 'admin@example.com'
process.env['E2E_ADMIN_PASSWORD'] ??= 'adminpass'

console.log('Starting demo server...')
const demoServer = await startDemoServer(DEMO_PORT)

console.log('Discovering and starting ortheon server...')
const suites = await discoverSuites(SPEC_GLOB, process.cwd())
const ortheonServer = await startOrtheonServer(suites, ORTHEON_PORT)

// The same 3 specs that `npm run examples` exercises, identified by their
// relative path (which determines the suite ID the server assigns).
const REMOTE_SPECS: Array<{ label: string; relativePath: string }> = [
  { label: 'health smoke test',       relativePath: 'examples/specs/smoke/health.ortheon.ts' },
  { label: 'guest order (API only)',   relativePath: 'examples/specs/checkout/guest-order.ortheon.ts' },
  { label: 'authenticated checkout',  relativePath: 'examples/specs/checkout/authenticated-checkout.ortheon.ts' },
]

const specResults: SpecResult[] = []
let anyFailed = false

async function fetchAndRunPlan(label: string, relativePath: string): Promise<void> {
  const suiteId = encodeSuiteId(relativePath)
  const planUrl = `${ORTHEON_BASE_URL}/api/suites/${suiteId}/execution-plan`

  console.log(`\nFetching plan: ${label}`)
  console.log(`  ${planUrl}`)

  const planRes = await fetch(planUrl)
  if (!planRes.ok) {
    const err = await planRes.json().catch(() => ({})) as { error?: string }
    throw new Error(`HTTP ${planRes.status}: ${err.error ?? 'unknown error'}`)
  }

  const artifact = await planRes.json() as {
    planVersion: number
    plan: ExecutionPlan
    validation: { errors: string[]; warnings: string[] }
  }

  if (artifact.validation.errors.length > 0) {
    throw new Error(`Plan has validation errors:\n${artifact.validation.errors.map(e => `  - ${e}`).join('\n')}`)
  }

  if (artifact.validation.warnings.length > 0) {
    for (const w of artifact.validation.warnings) {
      console.warn(`  warning: ${w}`)
    }
  }

  const result = await runPlan(artifact.plan)
  specResults.push(result)
  consoleReport(result)
  if (result.status === 'fail') anyFailed = true
}

async function assertWorkflowListing(): Promise<void> {
  console.log('\nChecking workflow listing in /api/suites...')
  const res = await fetch(`${ORTHEON_BASE_URL}/api/suites`)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from /api/suites`)
  }
  const data = await res.json() as { suites: SuiteListItem[] }
  const workflowSuites = data.suites.filter(s => s.type === 'workflow')
  if (workflowSuites.length === 0) {
    throw new Error('No workflow suites found in listing — expected at least one (sample-workflow.ortheon.ts)')
  }
  console.log(`  OK: found ${workflowSuites.length} workflow suite(s)`)
  for (const s of workflowSuites) {
    console.log(`    [workflow] ${s.name}  trigger: ${String(s['triggerKind'])}  steps: ${String(s['stepCount'])}`)
  }
}

try {
  await assertWorkflowListing()

  for (const { label, relativePath } of REMOTE_SPECS) {
    await fetchAndRunPlan(label, relativePath)
  }
} catch (err) {
  console.error('\nUnexpected error:', err)
  anyFailed = true
} finally {
  demoServer.close()
  ortheonServer.close()
}

consoleSummary(specResults)
process.exit(anyFailed ? 1 : 0)
