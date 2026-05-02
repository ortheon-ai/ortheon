import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentSpec, Spec, WorkflowSpec } from './types.js'

// ---------------------------------------------------------------------------
// Spec loader -- resolves, imports, and validates a spec file.
//
// Returns a discriminated union:
//   { kind: 'spec', spec, error: null }
//   { kind: 'agent', spec, error: null }
//   { kind: 'workflow', spec, error: null }
//   { kind: null, spec: null, error: string }
// ---------------------------------------------------------------------------

export type LoadedSpec =
  | { kind: 'spec'; spec: Spec; error: null }
  | { kind: 'agent'; spec: AgentSpec; error: null }
  | { kind: 'workflow'; spec: WorkflowSpec; error: null }
  | { kind: null; spec: null; error: string }

export async function loadSpecFile(file: string): Promise<LoadedSpec> {
  const absPath = resolve(file)
  const fileUrl = pathToFileURL(absPath).href
  try {
    const mod = await import(fileUrl) as { default?: unknown } | unknown
    const s = (mod as { default?: unknown }).default ?? mod

    if (!s || typeof s !== 'object') {
      return {
        kind: null,
        spec: null,
        error: `File does not export a valid Ortheon spec or agent spec (expected a default export from spec(...) or agent(...))`,
      }
    }

    // WorkflowSpec is identified by __type: 'workflow' (check before agent)
    if ('__type' in (s as object) && (s as { __type: string }).__type === 'workflow') {
      return { kind: 'workflow', spec: s as WorkflowSpec, error: null }
    }

    // AgentSpec is identified by __type: 'agent'
    if ('__type' in (s as object) && (s as { __type: string }).__type === 'agent') {
      return { kind: 'agent', spec: s as AgentSpec, error: null }
    }

    // Behavioral spec is identified by the presence of 'flows'
    if ('flows' in (s as object)) {
      return { kind: 'spec', spec: s as Spec, error: null }
    }

    return {
      kind: null,
      spec: null,
      error: `File does not export a valid Ortheon spec or agent spec (expected a default export from spec(...) or agent(...))`,
    }
  } catch (err) {
    return { kind: null, spec: null, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Glob resolver -- Node 22+ native glob with manual fallback for Node 20
// ---------------------------------------------------------------------------

export async function resolveGlob(pattern: string): Promise<string[]> {
  const fsPromises = await import('node:fs/promises').catch(() => null)
  const glob = fsPromises !== null
    ? (fsPromises as unknown as { glob?: unknown }).glob ?? null
    : null

  if (glob && typeof (glob as unknown) === 'function') {
    try {
      const files: string[] = []
      for await (const f of (glob as (p: string) => AsyncIterable<string>)(pattern)) {
        files.push(f)
      }
      return files
    } catch {
      // fall through to manual glob
    }
  }

  return manualGlob(pattern)
}

async function manualGlob(pattern: string): Promise<string[]> {
  const { readdirSync, statSync } = await import('node:fs')
  const path = await import('node:path')

  try {
    const stat = statSync(pattern)
    if (stat.isFile()) return [pattern]
  } catch { /* not a direct file */ }

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
