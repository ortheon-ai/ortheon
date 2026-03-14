import { describe, it, expect, beforeEach } from 'vitest'
import { RuntimeContext } from '../src/context.js'

describe('RuntimeContext', () => {
  let ctx: RuntimeContext

  beforeEach(() => {
    ctx = new RuntimeContext()
  })

  describe('set and get', () => {
    it('stores and retrieves a top-level value', () => {
      ctx.set('orderId', 'abc-123')
      expect(ctx.get('orderId')).toBe('abc-123')
    })

    it('stores and retrieves a nested object', () => {
      ctx.set('order', { id: 'abc', status: 'confirmed' })
      expect(ctx.get('order.id')).toBe('abc')
      expect(ctx.get('order.status')).toBe('confirmed')
    })

    it('resolves bracket indexing for arrays', () => {
      ctx.set('items', [{ sku: 'sku_1' }, { sku: 'sku_2' }])
      expect(ctx.get('items[0].sku')).toBe('sku_1')
      expect(ctx.get('items[1].sku')).toBe('sku_2')
    })

    it('returns undefined for missing paths', () => {
      expect(ctx.get('nonexistent')).toBeUndefined()
      expect(ctx.get('order.id')).toBeUndefined()
    })

    it('returns undefined for out-of-bounds array access', () => {
      ctx.set('items', [{ sku: 'sku_1' }])
      expect(ctx.get('items[5].sku')).toBeUndefined()
    })
  })

  describe('require', () => {
    it('returns value when it exists', () => {
      ctx.set('token', 'tok_abc')
      expect(ctx.require('token')).toBe('tok_abc')
    })

    it('throws a clear error when value is missing', () => {
      expect(() => ctx.require('missing')).toThrow('ref("missing") is undefined')
    })
  })

  describe('resolve', () => {
    it('resolves RefValue from context', () => {
      ctx.set('orderId', 'order-42')
      const resolved = ctx.resolve({ __type: 'ref', path: 'orderId' })
      expect(resolved).toBe('order-42')
    })

    it('resolves EnvValue from process.env', () => {
      process.env['TEST_VAR'] = 'hello'
      const resolved = ctx.resolve({ __type: 'env', name: 'TEST_VAR' })
      expect(resolved).toBe('hello')
      delete process.env['TEST_VAR']
    })

    it('throws for missing env var', () => {
      delete process.env['MISSING_ENV']
      expect(() => ctx.resolve({ __type: 'env', name: 'MISSING_ENV' })).toThrow('env("MISSING_ENV") is not set')
    })

    it('resolves SecretValue from process.env', () => {
      process.env['MY_SECRET'] = 'supersecret'
      const resolved = ctx.resolve({ __type: 'secret', name: 'MY_SECRET' })
      expect(resolved).toBe('supersecret')
      delete process.env['MY_SECRET']
    })
  })

  describe('resolveDeep', () => {
    it('resolves refs nested inside objects', () => {
      ctx.set('userId', 'u-1')
      const result = ctx.resolveDeep({
        id: { __type: 'ref', path: 'userId' },
        name: 'Alice',
      })
      expect(result).toEqual({ id: 'u-1', name: 'Alice' })
    })

    it('passes through plain values unchanged', () => {
      expect(ctx.resolveDeep('hello')).toBe('hello')
      expect(ctx.resolveDeep(42)).toBe(42)
      expect(ctx.resolveDeep(null)).toBe(null)
    })

    it('resolves refs inside arrays', () => {
      ctx.set('x', 99)
      const result = ctx.resolveDeep([{ __type: 'ref', path: 'x' }, 'literal'])
      expect(result).toEqual([99, 'literal'])
    })
  })

  describe('extractFromResponse', () => {
    const response = {
      status: 201,
      headers: { 'x-request-id': 'req-abc' },
      body: { id: 'order-1', status: 'confirmed', items: [{ sku: 'sku_1' }] },
    }

    it('extracts the full body', () => {
      expect(ctx.extractFromResponse('body', response)).toEqual(response.body)
    })

    it('extracts a body field', () => {
      expect(ctx.extractFromResponse('body.id', response)).toBe('order-1')
    })

    it('extracts a nested body field', () => {
      expect(ctx.extractFromResponse('body.items[0].sku', response)).toBe('sku_1')
    })

    it('extracts status', () => {
      expect(ctx.extractFromResponse('status', response)).toBe(201)
    })

    it('extracts a header', () => {
      expect(ctx.extractFromResponse('headers.x-request-id', response)).toBe('req-abc')
    })
  })

  describe('loadData', () => {
    it('loads data under the "data" namespace', () => {
      ctx.loadData({ product: { sku: 'sku_123', name: 'Widget' } })
      expect(ctx.get('data.product.sku')).toBe('sku_123')
    })

    it('resolves env refs inside data at load time', () => {
      process.env['E2E_USER'] = 'buyer@example.com'
      ctx.loadData({ user: { email: { __type: 'env', name: 'E2E_USER' } } })
      expect(ctx.get('data.user.email')).toBe('buyer@example.com')
      delete process.env['E2E_USER']
    })
  })

  describe('redact', () => {
    it('replaces a resolved secret value with [REDACTED]', () => {
      process.env['MY_SECRET'] = 'supersecret123'
      ctx.resolve({ __type: 'secret', name: 'MY_SECRET' })
      const redacted = ctx.redact('error: Authorization header value supersecret123 was rejected')
      expect(redacted).toBe('error: Authorization header value [REDACTED] was rejected')
      delete process.env['MY_SECRET']
    })

    it('replaces all occurrences of a secret value', () => {
      process.env['MY_SECRET'] = 'tok123'
      ctx.resolve({ __type: 'secret', name: 'MY_SECRET' })
      const redacted = ctx.redact('tok123 and tok123 again')
      expect(redacted).toBe('[REDACTED] and [REDACTED] again')
      delete process.env['MY_SECRET']
    })

    it('leaves strings unchanged when no secrets have been resolved', () => {
      const result = ctx.redact('no secrets here')
      expect(result).toBe('no secrets here')
    })

    it('does not redact env() values -- only secret() values', () => {
      process.env['MY_ENV_VAR'] = 'envvalue'
      ctx.resolve({ __type: 'env', name: 'MY_ENV_VAR' })
      const result = ctx.redact('message with envvalue')
      expect(result).toBe('message with envvalue')
      delete process.env['MY_ENV_VAR']
    })
  })
})
