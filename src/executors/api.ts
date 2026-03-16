import type { ApiResponse } from '../types.js'
import type { RuntimeContext } from '../context.js'

// ---------------------------------------------------------------------------
// API executor -- Node 20+ native fetch
// ---------------------------------------------------------------------------

export type ResolvedApiCall = {
  method: string
  path: string            // may contain {paramName} placeholders
  params?: Record<string, string>
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: unknown
}

function substitutePath(path: string, params: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key]
    if (value === undefined) {
      throw new Error(`Path param "{${key}}" not provided in params`)
    }
    return encodeURIComponent(value)
  })
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  // Ensure no double slashes between baseUrl and path
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const p = path.startsWith('/') ? path : `/${path}`
  const url = `${base}${p}`
  if (!query || Object.keys(query).length === 0) return url
  const qs = new URLSearchParams(query).toString()
  return `${url}?${qs}`
}

export async function executeApiCall(
  call: ResolvedApiCall,
  baseUrl: string,
  context: RuntimeContext,
  timeoutMs?: number
): Promise<ApiResponse> {
  // Resolve dynamic values in params, query, headers, body
  const resolvedParams = call.params
    ? Object.fromEntries(
        Object.entries(call.params).map(([k, v]) => [k, String(context.resolveDeep(v))])
      )
    : {}

  const resolvedQuery = call.query
    ? Object.fromEntries(
        Object.entries(call.query).map(([k, v]) => [k, String(context.resolveDeep(v))])
      )
    : undefined

  const resolvedHeaders: Record<string, string> = {}
  if (call.headers) {
    for (const [k, v] of Object.entries(call.headers)) {
      resolvedHeaders[k] = String(context.resolveDeep(v))
    }
  }

  const resolvedBody = call.body !== undefined ? context.resolveDeep(call.body) : undefined

  const resolvedPath = substitutePath(call.path, resolvedParams)
  const url = buildUrl(baseUrl, resolvedPath, resolvedQuery)

  const fetchOptions: RequestInit = {
    method: call.method.toUpperCase(),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...resolvedHeaders,
    },
    ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  }

  if (resolvedBody !== undefined) {
    fetchOptions.body = JSON.stringify(resolvedBody)
  }

  const response = await fetch(url, fetchOptions)

  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })

  let body: unknown
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    body = await response.json()
  } else {
    body = await response.text()
  }

  return { status: response.status, headers: responseHeaders, body }
}
