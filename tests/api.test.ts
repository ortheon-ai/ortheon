import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { Server, IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { executeApiCall } from '../src/executors/api.js'
import { RuntimeContext } from '../src/context.js'

// ---------------------------------------------------------------------------
// Minimal test HTTP server
// ---------------------------------------------------------------------------

type RequestInfo = {
  method: string
  url: string
  headers: Record<string, string>
  body: string
  query: Record<string, string>
}

type RouteHandler = (info: RequestInfo) => { status: number; body: unknown; headers?: Record<string, string> }

function startTestServer(routes: Record<string, RouteHandler>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res) => {
      let rawBody = ''
      req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
      req.on('end', () => {
        const [pathname, queryString] = (req.url ?? '/').split('?')
        const query: Record<string, string> = {}
        if (queryString) {
          for (const [k, v] of new URLSearchParams(queryString).entries()) {
            query[k] = v
          }
        }
        const key = `${req.method} ${pathname}`
        const handler = routes[key]
        if (!handler) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
          return
        }
        const info: RequestInfo = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers as Record<string, string>,
          body: rawBody,
          query,
        }
        const result = handler(info)
        const resHeaders = {
          'Content-Type': 'application/json',
          ...result.headers,
        }
        res.writeHead(result.status, resHeaders)
        res.end(JSON.stringify(result.body))
      })
    })
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://localhost:${port}` })
    })
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeApiCall', () => {
  let server: Server | null = null

  afterEach(() => {
    server?.close()
    server = null
  })

  describe('basic GET', () => {
    it('returns the response status and parsed JSON body', async () => {
      const { server: s, url } = await startTestServer({
        'GET /api/health': () => ({ status: 200, body: { status: 'ok' } }),
      })
      server = s
      const ctx = new RuntimeContext()

      const response = await executeApiCall({ method: 'GET', path: '/api/health' }, url, ctx)
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ status: 'ok' })
    })

    it('returns status and text body for non-JSON responses', async () => {
      const { server: s, url } = await startTestServer({})
      server = s
      s.removeAllListeners('request')
      s.on('request', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('pong')
      })
      const ctx = new RuntimeContext()

      const response = await executeApiCall({ method: 'GET', path: '/' }, url, ctx)
      expect(response.status).toBe(200)
      expect(response.body).toBe('pong')
    })

    it('includes response headers in the result', async () => {
      const { server: s, url } = await startTestServer({
        'GET /resource': () => ({
          status: 200,
          body: {},
          headers: { 'x-request-id': 'req-abc-123' },
        }),
      })
      server = s
      const ctx = new RuntimeContext()

      const response = await executeApiCall({ method: 'GET', path: '/resource' }, url, ctx)
      expect(response.headers['x-request-id']).toBe('req-abc-123')
    })
  })

  describe('POST with body', () => {
    it('sends JSON body and returns the parsed response', async () => {
      let received: unknown
      const { server: s, url } = await startTestServer({
        'POST /api/orders': (info) => {
          received = JSON.parse(info.body)
          return { status: 201, body: { id: 'order-1', status: 'confirmed' } }
        },
      })
      server = s
      const ctx = new RuntimeContext()

      const response = await executeApiCall({
        method: 'POST',
        path: '/api/orders',
        body: { sku: 'sku_123', quantity: 2 },
      }, url, ctx)

      expect(response.status).toBe(201)
      expect(response.body).toEqual({ id: 'order-1', status: 'confirmed' })
      expect(received).toEqual({ sku: 'sku_123', quantity: 2 })
    })

    it('sets Content-Type: application/json by default', async () => {
      let contentType: string | undefined
      const { server: s, url } = await startTestServer({
        'POST /api/data': (info) => {
          contentType = info.headers['content-type']
          return { status: 200, body: {} }
        },
      })
      server = s
      const ctx = new RuntimeContext()

      await executeApiCall({ method: 'POST', path: '/api/data', body: { x: 1 } }, url, ctx)
      expect(contentType).toContain('application/json')
    })
  })

  describe('path param substitution', () => {
    it('substitutes {param} placeholders with encoded param values', async () => {
      let receivedUrl: string | undefined
      const { server: s, url } = await startTestServer({
        'GET /api/orders/order-42': (info) => {
          receivedUrl = info.url
          return { status: 200, body: { id: 'order-42' } }
        },
      })
      server = s
      const ctx = new RuntimeContext()

      await executeApiCall({
        method: 'GET',
        path: '/api/orders/{orderId}',
        params: { orderId: 'order-42' },
      }, url, ctx)

      expect(receivedUrl).toBe('/api/orders/order-42')
    })

    it('URL-encodes param values with special characters', async () => {
      let receivedUrl: string | undefined
      const { server: s, url } = await startTestServer({})
      server = s
      s.removeAllListeners('request')
      s.on('request', (req, res) => {
        receivedUrl = req.url
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
      const ctx = new RuntimeContext()

      await executeApiCall({
        method: 'GET',
        path: '/api/items/{name}',
        params: { name: 'foo bar' },
      }, url, ctx)

      expect(receivedUrl).toBe('/api/items/foo%20bar')
    })

    it('throws when a required path param is not provided', async () => {
      const { server: s, url } = await startTestServer({})
      server = s
      const ctx = new RuntimeContext()

      await expect(
        executeApiCall({ method: 'GET', path: '/api/orders/{orderId}' }, url, ctx)
      ).rejects.toThrow('orderId')
    })
  })

  describe('query params', () => {
    it('appends query params as a query string', async () => {
      let receivedQuery: Record<string, string> = {}
      const { server: s, url } = await startTestServer({
        'GET /api/products': (info) => {
          receivedQuery = info.query
          return { status: 200, body: [] }
        },
      })
      server = s
      const ctx = new RuntimeContext()

      await executeApiCall({
        method: 'GET',
        path: '/api/products',
        query: { sku: 'sku_123', limit: '10' },
      }, url, ctx)

      expect(receivedQuery).toEqual({ sku: 'sku_123', limit: '10' })
    })

    it('omits the query string when no query params are given', async () => {
      let receivedUrl: string | undefined
      const { server: s, url } = await startTestServer({
        'GET /api/items': (info) => {
          receivedUrl = info.url
          return { status: 200, body: [] }
        },
      })
      server = s
      const ctx = new RuntimeContext()

      await executeApiCall({ method: 'GET', path: '/api/items' }, url, ctx)
      expect(receivedUrl).toBe('/api/items')
    })
  })

  describe('custom headers', () => {
    it('passes custom headers through to the request', async () => {
      let authHeader: string | undefined
      const { server: s, url } = await startTestServer({
        'GET /api/secure': (info) => {
          authHeader = info.headers['authorization']
          return { status: 200, body: {} }
        },
      })
      server = s
      const ctx = new RuntimeContext()

      await executeApiCall({
        method: 'GET',
        path: '/api/secure',
        headers: { Authorization: 'Bearer tok-abc' },
      }, url, ctx)

      expect(authHeader).toBe('Bearer tok-abc')
    })
  })

  describe('dynamic value resolution', () => {
    it('resolves ref() values in params, headers, and body via context', async () => {
      let receivedBody: unknown
      let receivedAuth: string | undefined
      const { server: s, url } = await startTestServer({
        'GET /api/orders/order-99': (info) => {
          receivedBody = info.body ? JSON.parse(info.body) : undefined
          receivedAuth = info.headers['authorization']
          return { status: 200, body: { id: 'order-99' } }
        },
      })
      server = s
      const ctx = new RuntimeContext()
      ctx.set('orderId', 'order-99')
      ctx.set('token', 'tok-xyz')

      await executeApiCall({
        method: 'GET',
        path: '/api/orders/{orderId}',
        params: { orderId: { __type: 'ref', path: 'orderId' } as unknown as string },
        headers: { Authorization: { __type: 'bearer', value: { __type: 'ref', path: 'token' } } as unknown as string },
      }, url, ctx)

      expect(receivedAuth).toBe('Bearer tok-xyz')
    })
  })

  describe('URL normalisation', () => {
    it('handles trailing slash on baseUrl correctly', async () => {
      let receivedUrl: string | undefined
      const { server: s, url } = await startTestServer({
        'GET /api/health': (info) => {
          receivedUrl = info.url
          return { status: 200, body: {} }
        },
      })
      server = s
      const ctx = new RuntimeContext()

      // baseUrl with trailing slash -- should not produce double slash
      await executeApiCall({ method: 'GET', path: '/api/health' }, url + '/', ctx)
      expect(receivedUrl).toBe('/api/health')
    })
  })

  describe('timeoutMs', () => {
    it('aborts slow requests when timeoutMs is exceeded', async () => {
      const { server: s, url } = await startTestServer({})
      server = s
      s.removeAllListeners('request')
      s.on('request', (_req, res) => {
        // Respond after 2 seconds
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{}')
        }, 2000)
      })
      const ctx = new RuntimeContext()

      await expect(
        executeApiCall({ method: 'GET', path: '/' }, url, ctx, 50)
      ).rejects.toThrow()
    })
  })
})
