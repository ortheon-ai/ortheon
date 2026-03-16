/**
 * Integration runner: starts the demo server, runs all example specs, then exits.
 */
import { startServer } from '../demo/server.ts'
import { runSpec } from '../src/runner.ts'
import { consoleReport, consoleSummary } from '../src/reporter.ts'
import type { SpecResult } from '../src/types.ts'

const BASE_URL = 'http://localhost:3737'

// Set up environment defaults for demo
process.env['DEMO_BASE_URL'] ??= BASE_URL
process.env['E2E_USER_PASSWORD'] ??= 'password123'
process.env['E2E_USER_EMAIL'] ??= 'buyer@example.com'
process.env['E2E_ADMIN_EMAIL'] ??= 'admin@example.com'
process.env['E2E_ADMIN_PASSWORD'] ??= 'adminpass'

const server = await startServer(3737)

const results: SpecResult[] = []
let anyFailed = false

async function run(name: string, specFile: string) {
  console.log(`\nLoading spec: ${name}`)
  const mod = await import(specFile)
  const s = mod.default
  const result = await runSpec(s, { baseUrl: BASE_URL, skipValidation: false })
  results.push(result)
  consoleReport(result)
  if (result.status === 'fail') anyFailed = true
}

try {
  await run('health smoke test', '../examples/specs/smoke/health.ortheon.ts')
  await run('guest order (API only)', '../examples/specs/checkout/guest-order.ortheon.ts')
  // Authenticated checkout requires browser -- run last
  await run('authenticated checkout', '../examples/specs/checkout/authenticated-checkout.ortheon.ts')
} catch (err) {
  console.error('Unexpected error:', err)
  anyFailed = true
} finally {
  server.close()
}

consoleSummary(results)
process.exit(anyFailed ? 1 : 0)
