#!/usr/bin/env node
import { program } from 'commander'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile, formatExpandedPlan } from './compiler.js'
import { validate } from './validator.js'
import { runSpec } from './runner.js'
import { consoleReport, jsonReport, consoleSummary } from './reporter.js'
import { resolveGlob } from './loader.js'
import { discoverSuites, startServer } from './server/app.js'
import type { Spec, SpecResult } from './types.js'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
) as { version: string }

program
  .name('ortheon')
  .description('Declarative behavioral spec runner')
  .version(packageJson.version)

// ---------------------------------------------------------------------------
// ortheon run <glob>
// ---------------------------------------------------------------------------

program
  .command('run <glob>')
  .description('Run spec files matching the given glob pattern')
  .option('--base-url <url>', 'Override the spec baseUrl (also reads APP_BASE_URL env var)')
  .option('--reporter <type>', 'Output format: console | json (default: console)', 'console')
  .option('--headed', 'Run browser in headed mode (show the browser window)')
  .option('--timeout <ms>', 'Default step timeout in milliseconds', '30000')
  .option('--skip-validation', 'Skip pre-run validation')
  .action(async (glob: string, options: {
    baseUrl?: string
    reporter: string
    headed?: boolean
    timeout: string
    skipValidation?: boolean
  }) => {
    const files = await resolveGlob(glob)

    if (files.length === 0) {
      console.error(`No spec files found matching: ${glob}`)
      process.exit(1)
    }

    const results: SpecResult[] = []
    let anyFailed = false

    for (const file of files) {
      const spec = await loadSpecForCli(file)
      if (!spec) continue

      try {
        const result = await runSpec(spec, {
          ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
          ...(options.headed !== undefined ? { headed: options.headed } : {}),
          ...(options.skipValidation !== undefined ? { skipValidation: options.skipValidation } : {}),
        })

        results.push(result)

        if (options.reporter === 'json') {
          jsonReport(result)
        } else {
          consoleReport(result)
        }

        if (result.status === 'fail') anyFailed = true
      } catch (err) {
        console.error(`\nError running spec "${file}":`)
        console.error(err instanceof Error ? err.message : String(err))
        anyFailed = true
      }
    }

    if (options.reporter !== 'json' && results.length > 1) {
      consoleSummary(results)
    }

    process.exit(anyFailed ? 1 : 0)
  })

// ---------------------------------------------------------------------------
// ortheon expand <file>
// ---------------------------------------------------------------------------

program
  .command('expand <file>')
  .description('Print the fully expanded execution plan for a spec file')
  .action(async (file: string) => {
    const spec = await loadSpecForCli(file)
    if (!spec) process.exit(1)

    const plan = compile(spec)

    const validation = validate(spec, plan)
    if (!validation.valid) {
      console.error('Validation errors:')
      for (const err of validation.errors) {
        console.error(`  error: ${err.message}`)
      }
      console.error('')
    }
    if (validation.warnings.length > 0) {
      for (const warn of validation.warnings) {
        console.warn(`  warning: ${warn.message}`)
      }
      console.warn('')
    }

    console.log(formatExpandedPlan(plan))
    process.exit(validation.valid ? 0 : 1)
  })

// ---------------------------------------------------------------------------
// ortheon serve <glob>
// ---------------------------------------------------------------------------

program
  .command('serve <glob>')
  .description('Start the Ortheon web server for browsing and running specs')
  .option('--port <port>', 'Port to listen on', '4000')
  .option('--base-url <url>', 'Default base URL for running specs (also reads APP_BASE_URL env var)')
  .action(async (glob: string, options: {
    port: string
    baseUrl?: string
  }) => {
    const port = parseInt(options.port, 10)
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${options.port}`)
      process.exit(1)
    }

    const cwd = process.cwd()
    const serverUrl = `http://localhost:${port}`

    // Set environment variables so specs can resolve their own base URLs.
    // --base-url sets APP_BASE_URL (the target app under test).
    // ORTHEON_SERVER_URL is always set to this server's own address so
    // specs like run-suites.ortheon.ts can call the ortheon API directly.
    if (options.baseUrl !== undefined) {
      process.env['APP_BASE_URL'] ??= options.baseUrl
    }
    process.env['ORTHEON_SERVER_URL'] ??= serverUrl

    console.log(`Discovering specs matching: ${glob}`)
    const suites = await discoverSuites(glob, cwd)

    if (suites.length === 0) {
      console.error(`No spec files found matching: ${glob}`)
      process.exit(1)
    }

    // Do not pass baseUrlOverride -- each spec resolves its own base URL
    // from its env() references (APP_BASE_URL, ORTHEON_SERVER_URL, etc.).
    // POST /api/suites/:id/run body.baseUrl can still override per-run.
    await startServer(suites, port)
  })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadSpecForCli(file: string): Promise<Spec | null> {
  const absPath = resolve(file)
  const fileUrl = pathToFileURL(absPath).href
  try {
    const mod = await import(fileUrl) as { default?: Spec } | Spec
    const s = (mod as { default?: Spec }).default ?? (mod as Spec)
    if (!s || typeof s !== 'object' || !('flows' in s)) {
      console.error(`File "${file}" does not export a valid Ortheon spec (expected a default export from spec(...))`)
      return null
    }
    return s
  } catch (err) {
    console.error(`Failed to load spec file "${file}":`)
    console.error(err instanceof Error ? err.message : String(err))
    return null
  }
}

program.parse()
