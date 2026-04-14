import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const __dir = fileURLToPath(new URL('.', import.meta.url))
const CLI_PATH = resolve(__dir, '..', 'src', 'cli.ts')

// Fixture spec content: plain JS ESM so the CLI does not try to re-exec with tsx.
// Empty flows pass trivially (no steps, no baseUrl required).
function makeSpecFile(name: string, tags: string[]): string {
  return [
    `export default {`,
    `  name: ${JSON.stringify(name)},`,
    tags.length > 0 ? `  tags: ${JSON.stringify(tags)},` : '',
    `  flows: [{ name: 'main', steps: [] }],`,
    `}`,
  ].filter(Boolean).join('\n')
}

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(
    process.execPath,
    // --import tsx makes Node transpile the TypeScript CLI source.
    // __ORTHEON_TSX=1 skips the tsx detection/re-exec block inside cli.ts itself.
    ['--import', 'tsx', CLI_PATH, ...args],
    {
      encoding: 'utf-8',
      env: { ...process.env, __ORTHEON_TSX: '1' },
    },
  )
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ortheon-tag-test-'))

  writeFileSync(join(tmpDir, 'api.js'), makeSpecFile('api spec', ['api']))
  writeFileSync(join(tmpDir, 'storefront.js'), makeSpecFile('storefront spec', ['storefront_v2']))
  writeFileSync(join(tmpDir, 'shared.js'), makeSpecFile('shared spec', ['api', 'storefront_v2']))
  writeFileSync(join(tmpDir, 'untagged.js'), makeSpecFile('untagged spec', []))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ranSpec(stdout: string, name: string): boolean {
  // consoleReport() outputs "PASS  <specName>" or "FAIL  <specName>"
  return stdout.includes(`PASS  ${name}`) || stdout.includes(`FAIL  ${name}`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('--tag filtering', () => {
  it('runs all specs when no --tag flag is given', () => {
    const glob = join(tmpDir, '*.js')
    const { stdout, exitCode } = runCli(['run', glob])

    expect(exitCode).toBe(0)
    expect(ranSpec(stdout, 'api spec')).toBe(true)
    expect(ranSpec(stdout, 'storefront spec')).toBe(true)
    expect(ranSpec(stdout, 'shared spec')).toBe(true)
    expect(ranSpec(stdout, 'untagged spec')).toBe(true)
  })

  it('runs only specs tagged with the given tag', () => {
    const glob = join(tmpDir, '*.js')
    const { stdout, exitCode } = runCli(['run', glob, '--tag', 'api'])

    expect(exitCode).toBe(0)
    expect(ranSpec(stdout, 'api spec')).toBe(true)
    expect(ranSpec(stdout, 'shared spec')).toBe(true)
    expect(ranSpec(stdout, 'storefront spec')).toBe(false)
    expect(ranSpec(stdout, 'untagged spec')).toBe(false)
  })

  it('runs only specs tagged with a different single tag', () => {
    const glob = join(tmpDir, '*.js')
    const { stdout, exitCode } = runCli(['run', glob, '--tag', 'storefront_v2'])

    expect(exitCode).toBe(0)
    expect(ranSpec(stdout, 'storefront spec')).toBe(true)
    expect(ranSpec(stdout, 'shared spec')).toBe(true)
    expect(ranSpec(stdout, 'api spec')).toBe(false)
    expect(ranSpec(stdout, 'untagged spec')).toBe(false)
  })

  it('runs specs matching any of multiple --tag values (union)', () => {
    const glob = join(tmpDir, '*.js')
    const { stdout, exitCode } = runCli(['run', glob, '--tag', 'api', '--tag', 'storefront_v2'])

    expect(exitCode).toBe(0)
    expect(ranSpec(stdout, 'api spec')).toBe(true)
    expect(ranSpec(stdout, 'storefront spec')).toBe(true)
    expect(ranSpec(stdout, 'shared spec')).toBe(true)
    // Untagged spec never runs when any --tag is requested
    expect(ranSpec(stdout, 'untagged spec')).toBe(false)
  })

  it('runs no specs (exit 0) when no spec matches the given tag', () => {
    const glob = join(tmpDir, '*.js')
    const { stdout, exitCode } = runCli(['run', glob, '--tag', 'nonexistent_project'])

    expect(exitCode).toBe(0)
    expect(ranSpec(stdout, 'api spec')).toBe(false)
    expect(ranSpec(stdout, 'storefront spec')).toBe(false)
    expect(ranSpec(stdout, 'shared spec')).toBe(false)
    expect(ranSpec(stdout, 'untagged spec')).toBe(false)
  })

  it('does not run untagged specs when any --tag is specified', () => {
    const glob = join(tmpDir, '*.js')
    // Even a tag that matches some specs should still exclude the untagged spec
    const { stdout } = runCli(['run', glob, '--tag', 'api'])
    expect(ranSpec(stdout, 'untagged spec')).toBe(false)
  })
})
