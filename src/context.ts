import type { BearerValue, DynamicValue, EnvValue, RefValue, SecretValue } from './types.js'

// ---------------------------------------------------------------------------
// Dot-path resolution utilities
//
// Supported syntax: dot notation + bracket indexing
//   order.id
//   order.items[0].sku
//   verification.events[1].type
//
// No wildcards, no filters, no JSONPath, no recursive descent.
// ---------------------------------------------------------------------------

function parsePath(path: string): Array<string | number> {
  const segments: Array<string | number> = []
  // Split on dots and brackets, e.g. "a.b[0].c" -> ["a", "b", 0, "c"]
  const re = /([^.[]+)|\[(\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(path)) !== null) {
    if (match[1] !== undefined) {
      segments.push(match[1])
    } else if (match[2] !== undefined) {
      segments.push(parseInt(match[2], 10))
    }
  }
  return segments
}

function getPath(obj: unknown, segments: Array<string | number>): unknown {
  let current: unknown = obj
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined
    if (typeof seg === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[seg]
    } else {
      if (typeof current !== 'object') return undefined
      current = (current as Record<string, unknown>)[seg]
    }
  }
  return current
}

function setPath(obj: Record<string, unknown>, segments: Array<string | number>, value: unknown): void {
  if (segments.length === 0) return
  const last = segments[segments.length - 1]
  let current: unknown = obj
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!
    const next = segments[i + 1]
    const nextIsIndex = typeof next === 'number'
    if (typeof seg === 'number') {
      if (!Array.isArray(current)) return
      if ((current as unknown[])[seg] === undefined) {
        (current as unknown[])[seg] = nextIsIndex ? [] : {}
      }
      current = (current as unknown[])[seg]
    } else {
      const rec = current as Record<string, unknown>
      if (rec[seg] === undefined) {
        rec[seg] = nextIsIndex ? [] : {}
      }
      current = rec[seg]
    }
  }
  if (typeof last === 'number') {
    (current as unknown[])[last] = value
  } else {
    (current as Record<string, unknown>)[last!] = value
  }
}

// ---------------------------------------------------------------------------
// RuntimeContext
// ---------------------------------------------------------------------------

export class RuntimeContext {
  private store: Record<string, unknown> = {}
  // Tracks all resolved secret values so they can be redacted from output
  private resolvedSecrets: Set<string> = new Set()

  /** Set a value by dot-path key (top-level or nested). */
  set(path: string, value: unknown): void {
    const segments = parsePath(path)
    if (segments.length === 1) {
      this.store[segments[0] as string] = value
    } else {
      setPath(this.store, segments, value)
    }
  }

  /** Get a value by dot-path. Returns undefined if not found. */
  get(path: string): unknown {
    const segments = parsePath(path)
    return getPath(this.store, segments)
  }

  /** Get a value by dot-path, throw a clear error if missing. */
  require(path: string): unknown {
    const value = this.get(path)
    if (value === undefined) {
      throw new Error(`ref("${path}") is undefined -- no prior step saved this value`)
    }
    return value
  }

  /** Extract a value from an API response body using a save path expression.
   *
   * Save path can be:
   *   "body"         -> the entire response body
   *   "body.id"      -> response body property id
   *   "body.items[0].sku" -> nested
   *   "status"       -> the HTTP status code (as number, from ApiResponse)
   *   "headers.x-request-id" -> a response header
   *
   * Throws for unrecognised path prefixes -- the validator warns at compile time,
   * this throw ensures typos surface immediately at runtime rather than silently
   * propagating undefined into downstream refs.
   */
  extractFromResponse(
    savePath: string,
    response: { status: number; headers: Record<string, string>; body: unknown }
  ): unknown {
    if (savePath === 'body') return response.body
    if (savePath === 'status') return response.status
    if (savePath.startsWith('body.')) {
      const bodyPath = savePath.slice(5)
      return getPath(response.body, parsePath(bodyPath))
    }
    if (savePath.startsWith('headers.')) {
      const headerName = savePath.slice(8)
      return response.headers[headerName]
    }
    throw new Error(
      `Invalid save path "${savePath}". ` +
      'Expected "body", "status", "body.<path>", or "headers.<name>".'
    )
  }

  /** Resolve a DynamicValue to a concrete value. */
  resolve(value: DynamicValue): unknown {
    switch (value.__type) {
      case 'ref':
        return this.resolveRef(value)
      case 'env':
        return this.resolveEnv(value)
      case 'secret':
        return this.resolveSecret(value)
      case 'bearer':
        return this.resolveBearer(value)
    }
  }

  private resolveRef(value: RefValue): unknown {
    return this.require(value.path)
  }

  private resolveEnv(value: EnvValue): string {
    const v = process.env[value.name]
    if (v === undefined) {
      throw new Error(`env("${value.name}") is not set in the environment`)
    }
    return v
  }

  private resolveSecret(value: SecretValue): string {
    const v = process.env[value.name]
    if (v === undefined) {
      throw new Error(`secret("${value.name}") is not set in the environment`)
    }
    this.resolvedSecrets.add(v)
    return v
  }

  /** Replace all known secret values in a string with [REDACTED].
   *  Apply to error messages and any output that may contain resolved secrets.
   */
  redact(text: string): string {
    let result = text
    for (const secret of this.resolvedSecrets) {
      if (secret.length > 0) {
        result = result.split(secret).join('[REDACTED]')
      }
    }
    return result
  }

  private resolveBearer(value: BearerValue): string {
    const inner = typeof value.value === 'string'
      ? value.value
      : String(this.resolve(value.value as DynamicValue))
    return `Bearer ${inner}`
  }

  /** Recursively resolve all DynamicValues within an arbitrary value tree. */
  resolveDeep(value: unknown): unknown {
    if (value === null || value === undefined) return value
    if (this.isDynamic(value)) return this.resolve(value as DynamicValue)
    if (Array.isArray(value)) return value.map(v => this.resolveDeep(v))
    if (typeof value === 'object') {
      const resolved: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        resolved[k] = this.resolveDeep(v)
      }
      return resolved
    }
    return value
  }

  private isDynamic(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      '__type' in value &&
      ['ref', 'env', 'secret', 'bearer'].includes((value as { __type: string }).__type)
    )
  }

  /** Load data object into context under the "data" namespace. */
  loadData(data: Record<string, unknown>): void {
    this.store['data'] = this.resolveDeep(data)
  }

  /** Snapshot the full store (for debugging / expanded plan output). */
  snapshot(): Record<string, unknown> {
    return structuredClone(this.store)
  }
}
