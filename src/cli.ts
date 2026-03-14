#!/usr/bin/env node
import { program } from 'commander'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile, formatExpandedPlan } from './compiler.js'
import { validate } from './validator.js'
import { runSpec } from './runner.js'
import { consoleReport, jsonReport, consoleSummary } from './reporter.js'
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
      const spec = await loadSpec(file)
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
    const spec = await loadSpec(file)
    if (!spec) process.exit(1)

    const plan = compile(spec)

    // Run pass 1 validation and report issues
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
// Helpers
// ---------------------------------------------------------------------------

async function loadSpec(file: string): Promise<Spec | null> {
  const absPath = resolve(file)
  const fileUrl = pathToFileURL(absPath).href
  try {
    const mod = await import(fileUrl) as { default?: Spec } | Spec
    const spec = (mod as { default?: Spec }).default ?? (mod as Spec)
    if (!spec || typeof spec !== 'object' || !('flows' in spec)) {
      console.error(`File "${file}" does not export a valid Ortheon spec (expected a default export from spec(...))`)
      return null
    }
    return spec
  } catch (err) {
    console.error(`Failed to load spec file "${file}":`)
    console.error(err instanceof Error ? err.message : String(err))
    return null
  }
}

async function resolveGlob(pattern: string): Promise<string[]> {
  // Use Node 22+ glob, or fall back to manual resolution
  // For Node 20 compatibility, we do simple directory + extension matching
  const fsPromises = await import('node:fs/promises').catch(() => null)
  const glob = fsPromises !== null ? (fsPromises as unknown as { glob?: unknown }).glob ?? null : null

  // Try native glob (Node 22+)
  if (glob && typeof (glob as unknown) === 'function') {
    try {
      const files: string[] = []
      for await (const f of (glob as (p: string) => AsyncIterable<string>)(pattern)) {
        files.push(f)
      }
      return files
    } catch {
      // fall through to manual
    }
  }

  // Manual glob for Node 20: expand simple patterns
  return manualGlob(pattern)
}

async function manualGlob(pattern: string): Promise<string[]> {
  const { readdirSync, statSync } = await import('node:fs')
  const path = await import('node:path')

  // If it's a direct file path
  try {
    const stat = statSync(pattern)
    if (stat.isFile()) return [pattern]
  } catch { /* not a direct file */ }

  // Simple recursive directory + suffix matching
  const suffix = pattern.includes('*') ? pattern.split('*').pop() ?? '' : ''
  const baseDir = pattern.includes('/')
    ? pattern.split('*')[0]?.replace(/\/$/, '') ?? '.'
    : '.'

  const files: string[] = []
  function walk(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.isFile() && (suffix ? full.endsWith(suffix) : true)) {
          files.push(full)
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  walk(baseDir)
  return files
}

program.parse()
