#!/usr/bin/env node

// ---------------------------------------------------------------------------
// Auto-detect TypeScript specs and re-exec with tsx if needed.
// tsx cannot be registered at runtime (it requires --import at startup),
// so we detect .ts usage early and spawn a child process with --import tsx.
// ---------------------------------------------------------------------------

// Only inspect positional arguments for .ts/.tsx extensions.
// Flag values (e.g. URLs passed to --from) must be skipped — a URL like
// https://specs.example.ts ends in ".ts" but is not a TypeScript file.
const needsTsx = (() => {
  if (process.env['__ORTHEON_TSX']) return false
  const flagsWithValues = new Set(['--from', '--suite', '--reporter', '--timeout', '--port', '--retries'])
  const variadicFlags = new Set(['--tag'])
  const args = process.argv.slice(2)
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('-')) {
      if (variadicFlags.has(a)) {
        while (i + 1 < args.length && !args[i + 1]!.startsWith('-')) i++
      } else if (flagsWithValues.has(a)) {
        i++
      }
    } else {
      positional.push(a)
    }
  }
  return positional.some(a => a.endsWith('.ts') || a.endsWith('.tsx'))
})()

if (needsTsx) {
  const { execFileSync } = await import('node:child_process')
  try {
    await import('tsx' as string)
  } catch {
    console.error('TypeScript spec files require tsx. Install it: npm install -D tsx')
    process.exit(1)
  }
  try {
    // Preserve existing Node.js flags (--inspect, --max-old-space-size, etc.).
    // Strip any pre-existing --import tsx / --import=tsx so tsx is not registered twice.
    const execArgv = process.execArgv.filter((a, i, arr) => {
      if (a === '--import=tsx') return false
      if (a === '--import' && arr[i + 1] === 'tsx') return false
      if (a === 'tsx' && arr[i - 1] === '--import') return false
      return true
    })
    execFileSync(
      process.execPath,
      ['--import', 'tsx', ...execArgv, ...process.argv.slice(1)],
      { stdio: 'inherit', env: { ...process.env, '__ORTHEON_TSX': '1' } },
    )
    process.exit(0)
  } catch (err) {
    process.exit((err as { status?: number }).status ?? 1)
  }
}

import { program } from 'commander'
import { readFileSync } from 'node:fs'
import { compile, compileAgent, formatExpandedPlan, formatAgentPlan } from './compiler.js'
import { validate, validateAgent } from './validator.js'
import { runSpec, runPlan } from './runner.js'
import { consoleReport, jsonReport, consoleSummary } from './reporter.js'
import { resolveGlob, loadSpecFile } from './loader.js'
import type { AgentSpec, ExecutionPlan, Spec, SpecResult } from './types.js'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
) as { version: string }

program
  .name('ortheon')
  .description('Declarative behavioral spec runner')
  .version(packageJson.version)

// ---------------------------------------------------------------------------
// ortheon run [glob]
//
// Two modes:
//   Local:  ortheon run 'specs/**/*.ortheon.ts'
//   Remote: ortheon run --from <url> --suite <id>
// ---------------------------------------------------------------------------

program
  .command('run [glob]')
  .description('Run specs from local files or fetch and run a plan from a remote server')
  .option('--from <url>', 'Base URL of an Ortheon server to fetch the plan from')
  .option('--suite <id>', 'Suite ID to fetch from the remote server (required with --from)')
  .option('--reporter <type>', 'Output format: console | json (default: console)', 'console')
  .option('--headed', 'Run browser in headed mode (show the browser window)')
  .option('--timeout <ms>', 'Default step timeout in milliseconds', '30000')
  .option('--skip-validation', 'Skip pre-run validation (local mode only)')
  .option('--tag <tag...>', 'Only run specs whose tags include at least one of these values (local mode only)')
  .option('--retries <n>', 'Number of times to retry a failed spec before marking it as failed (default: 0)', '0')
  .action(async (glob: string | undefined, options: {
    from?: string
    suite?: string
    reporter: string
    headed?: boolean
    timeout: string
    skipValidation?: boolean
    tag?: string[]
    retries: string
  }) => {
    if (options.from !== undefined) {
      await runRemote(options.from, options.suite, options)
    } else {
      if (!glob) {
        console.error('Error: a glob pattern is required when --from is not specified')
        console.error('  Usage: ortheon run <glob>')
        console.error('         ortheon run --from <url> --suite <id>')
        process.exit(1)
      }
      await runLocal(glob, options)
    }
  })

// ---------------------------------------------------------------------------
// ortheon list --from <url>
//
// Discover suites on a remote Ortheon server.
// ---------------------------------------------------------------------------

program
  .command('list')
  .description('List suites available on a remote Ortheon server')
  .requiredOption('--from <url>', 'Base URL of the Ortheon server')
  .action(async (options: { from: string }) => {
    const baseUrl = options.from.replace(/\/$/, '')
    let data: {
      suites: Array<
        | { id: string; name: string; path: string; type: 'spec'; tags: string[]; expectedOutcome: string }
        | { id: string; name: string; path: string; type: 'agent'; toolCount: number }
        | { id: string; name: string; path: string; type: 'unknown'; hasError: true }
      >
    }

    try {
      const res = await fetch(`${baseUrl}/api/suites`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        console.error(`Error fetching suites: ${body.error ?? `HTTP ${res.status}`}`)
        process.exit(1)
      }
      data = await res.json() as typeof data
    } catch (err) {
      console.error(`Failed to connect to ${baseUrl}:`)
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    const suites = data.suites
    if (suites.length === 0) {
      console.log('No suites found on the remote server.')
      process.exit(0)
    }

    const maxIdLen = Math.max(8, ...suites.map(s => s.id.length))
    const maxNameLen = Math.max(4, ...suites.map(s => s.name.length))

    console.log(`Suites at ${baseUrl}:\n`)
    console.log(`${'ID'.padEnd(maxIdLen)}  ${'NAME'.padEnd(maxNameLen)}  TYPE    INFO`)
    console.log(`${'-'.repeat(maxIdLen)}  ${'-'.repeat(maxNameLen)}  ------  ----`)

    for (const s of suites) {
      if (s.type === 'agent') {
        console.log(`${s.id.padEnd(maxIdLen)}  ${s.name.padEnd(maxNameLen)}  [agent]  ${s.toolCount} tool(s)`)
      } else if (s.type === 'unknown') {
        console.log(`${s.id.padEnd(maxIdLen)}  ${s.name.padEnd(maxNameLen)}  [error]  (failed to load)`)
      } else {
        const tags = s.tags.length > 0 ? s.tags.join(', ') : ''
        console.log(`${s.id.padEnd(maxIdLen)}  ${s.name.padEnd(maxNameLen)}  [spec]   ${tags}`)
      }
    }

    console.log(`\n${suites.length} suite(s). Run with: ortheon run --from ${baseUrl} --suite <id>`)
  })

// ---------------------------------------------------------------------------
// ortheon expand <file>
// ---------------------------------------------------------------------------

program
  .command('expand <file>')
  .description('Print the fully expanded execution plan for a spec or agent file')
  .action(async (file: string) => {
    const loaded = await loadSpecFile(file)

    if (loaded.kind === null) {
      console.error(`Failed to load spec file "${file}":`)
      console.error(loaded.error)
      process.exit(1)
    }

    if (loaded.kind === 'agent') {
      const agentPlan = compileAgent(loaded.spec)
      const validation = validateAgent(loaded.spec)
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
      console.log(formatAgentPlan(agentPlan))
      process.exit(validation.valid ? 0 : 1)
    }

    const plan = compile(loaded.spec)

    const validation = validate(loaded.spec, plan)
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
  .description('Start the Ortheon web server for browsing and distributing specs')
  .option('--port <port>', 'Port to listen on', '4000')
  .action(async (glob: string, options: {
    port: string
  }) => {
    const port = parseInt(options.port, 10)
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${options.port}`)
      process.exit(1)
    }

    const cwd = process.cwd()
    const serverUrl = `http://localhost:${port}`

    // ORTHEON_SERVER_URL is set so specs that call the server API know its address.
    process.env['ORTHEON_SERVER_URL'] ??= serverUrl

    const { discoverSuites, startServer } = await import('./server/app.js')

    console.log(`Discovering specs matching: ${glob}`)
    const suites = await discoverSuites(glob, cwd)

    if (suites.length === 0) {
      console.error(`No spec files found matching: ${glob}`)
      process.exit(1)
    }

    await startServer(suites, port)
  })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runLocal(
  glob: string,
  options: { reporter: string; headed?: boolean; timeout: string; skipValidation?: boolean; tag?: string[]; retries: string },
): Promise<void> {
  const files = await resolveGlob(glob)

  if (files.length === 0) {
    console.error(`No spec files found matching: ${glob}`)
    process.exit(1)
  }

  const retriesParsed = parseInt(options.retries, 10)
  if (isNaN(retriesParsed) || retriesParsed < 0) {
    console.error(`Invalid --retries value: "${options.retries}". Must be a non-negative integer.`)
    process.exit(1)
  }
  const maxAttempts = retriesParsed + 1
  const results: SpecResult[] = []
  let anyFailed = false

  for (const file of files) {
    const spec = await loadSpecForCli(file)
    if (!spec) continue

    if (options.tag && options.tag.length > 0) {
      const specTags = spec.tags ?? []
      const hasMatch = options.tag.some(t => specTags.includes(t))
      if (!hasMatch) continue
    }

    let lastResult: SpecResult | null = null
    let specFailed = false

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        console.error(`\nRetrying "${spec.name}" (attempt ${attempt}/${maxAttempts})...`)
      }

      try {
        const result = await runSpec(spec, {
          ...(options.headed !== undefined ? { headed: options.headed } : {}),
          ...(options.skipValidation !== undefined ? { skipValidation: options.skipValidation } : {}),
          timeoutMs: parseInt(options.timeout, 10),
        })

        lastResult = result
        specFailed = result.status === 'fail'

        if (!specFailed) break
      } catch (err) {
        console.error(`\nError running spec "${file}":`)
        console.error(err instanceof Error ? err.message : String(err))
        specFailed = true
      }
    }

    if (lastResult) {
      if (options.reporter === 'json') {
        jsonReport(lastResult)
      } else {
        consoleReport(lastResult)
      }
      results.push(lastResult)
    }
    if (specFailed) anyFailed = true
  }

  if (options.reporter !== 'json' && results.length > 1) {
    consoleSummary(results)
  }

  process.exit(anyFailed ? 1 : 0)
}

async function runRemote(
  fromUrl: string,
  suiteId: string | undefined,
  options: { reporter: string; headed?: boolean; timeout: string },
): Promise<void> {
  if (!suiteId) {
    console.error('Error: --suite <id> is required when using --from')
    console.error(`  Tip: run "ortheon list --from ${fromUrl}" to see available suites`)
    process.exit(1)
  }

  const baseUrl = fromUrl.replace(/\/$/, '')
  const artifactUrl = `${baseUrl}/api/suites/${encodeURIComponent(suiteId)}/execution-plan`

  console.log(`Fetching plan from: ${artifactUrl}`)

  let artifact: {
    planVersion: number
    plan: ExecutionPlan
    validation: { errors: string[]; warnings: string[] }
    expectedOutcome: string
    tags: string[]
    safety: string | null
  }

  try {
    const res = await fetch(artifactUrl)
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      console.error(`Error fetching plan: ${body.error ?? `HTTP ${res.status}`}`)
      process.exit(1)
    }
    artifact = await res.json() as typeof artifact
  } catch (err) {
    console.error(`Failed to connect to ${baseUrl}:`)
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  // Warn about unknown plan versions
  if (artifact.planVersion !== 1) {
    console.warn(`Warning: plan version ${artifact.planVersion} is newer than this CLI supports (v1). Some features may not work correctly.`)
  }

  // Abort on validation errors from the server
  if (artifact.validation.errors.length > 0) {
    console.error(`Plan has validation errors:`)
    for (const err of artifact.validation.errors) {
      console.error(`  error: ${err}`)
    }
    process.exit(1)
  }

  if (artifact.validation.warnings.length > 0) {
    for (const warn of artifact.validation.warnings) {
      console.warn(`  warning: ${warn}`)
    }
  }

  let result: SpecResult
  try {
    result = await runPlan(artifact.plan, {
      ...(options.headed !== undefined ? { headed: options.headed } : {}),
      timeoutMs: parseInt(options.timeout, 10),
    })
  } catch (err) {
    console.error(`\nError running plan:`)
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  if (options.reporter === 'json') {
    jsonReport(result)
  } else {
    consoleReport(result)
  }

  process.exit(result.status === 'fail' ? 1 : 0)
}

async function loadSpecForCli(file: string): Promise<Spec | null> {
  const result = await loadSpecFile(file)
  if (result.kind === null) {
    console.error(`Failed to load spec file "${file}":`)
    console.error(result.error)
    return null
  }
  if (result.kind === 'agent') {
    console.error(`"${file}" is an agent spec. Agent specs cannot be run directly -- use an agent runtime to consume this spec.`)
    return null
  }
  return result.spec
}

program.parse()
