import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Spec } from './types.js'

// ---------------------------------------------------------------------------
// Spec loader -- resolves, imports, and validates a spec file
// ---------------------------------------------------------------------------

export async function loadSpecFile(
  file: string
): Promise<{ spec: Spec; error: null } | { spec: null; error: string }> {
  const absPath = resolve(file)
  const fileUrl = pathToFileURL(absPath).href
  try {
    const mod = await import(fileUrl) as { default?: Spec } | Spec
    const s = (mod as { default?: Spec }).default ?? (mod as Spec)
    if (!s || typeof s !== 'object' || !('flows' in s)) {
      return {
        spec: null,
        error: `File does not export a valid Ortheon spec (expected a default export from spec(...))`,
      }
    }
    return { spec: s, error: null }
  } catch (err) {
    return { spec: null, error: err instanceof Error ? err.message : String(err) }
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
