/**
 * Integration runner for the ortheon server self-test suite.
 *
 * Starts:
 *   1. The ortheon web server (port 4001) -- serving example specs
 *
 * Then runs the browse-suites self-test spec (API + browser) against the
 * ortheon server and reports results.
 *
 * ORTHEON_SERVER_URL is set so the spec knows where to call the server API.
 */

import { discoverSuites, startServer as startOrtheonServer } from '../src/server/app.ts'
import { runSpec } from '../src/runner.ts'
import { consoleReport, consoleSummary } from '../src/reporter.ts'
import type { SpecResult } from '../src/types.ts'

const ORTHEON_PORT = 4001
const ORTHEON_BASE_URL = `http://localhost:${ORTHEON_PORT}`
const SPEC_GLOB = 'examples/specs/**/*.ortheon.ts'

// ORTHEON_SERVER_URL is needed by browse-suites to call the server API.
process.env['ORTHEON_SERVER_URL'] ??= ORTHEON_BASE_URL

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
} catch (err) {
  console.error('Unexpected error:', err)
  anyFailed = true
} finally {
  ortheonServer.close()
}

consoleSummary(results)
process.exit(anyFailed ? 1 : 0)
