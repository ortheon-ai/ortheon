import { describe, it, expect } from 'vitest'
import { runMatcher, matchInlineBody, AssertionError } from '../src/executors/assert.js'

describe('runMatcher', () => {
  describe('equals', () => {
    it('passes for identical strings', () => {
      expect(() => runMatcher('equals', 'hello', 'hello')).not.toThrow()
    })

    it('passes for identical numbers', () => {
      expect(() => runMatcher('equals', 42, 42)).not.toThrow()
    })

    it('passes for deep equal objects', () => {
      expect(() => runMatcher('equals', { a: 1, b: 2 }, { a: 1, b: 2 })).not.toThrow()
    })

    it('passes for deep equal arrays', () => {
      expect(() => runMatcher('equals', [1, 2, 3], [1, 2, 3])).not.toThrow()
    })

    it('fails for different strings', () => {
      expect(() => runMatcher('equals', 'hello', 'world')).toThrow(AssertionError)
    })

    it('fails for objects with different values', () => {
      expect(() => runMatcher('equals', { a: 1 }, { a: 2 })).toThrow(AssertionError)
    })

    it('fails for arrays of different lengths', () => {
      expect(() => runMatcher('equals', [1, 2], [1])).toThrow(AssertionError)
    })
  })

  describe('contains', () => {
    it('passes when string contains substring', () => {
      expect(() => runMatcher('contains', 'hello world', 'world')).not.toThrow()
    })

    it('fails when string does not contain substring', () => {
      expect(() => runMatcher('contains', 'hello world', 'foo')).toThrow(AssertionError)
    })

    it('passes when object contains expected subset', () => {
      expect(() => runMatcher('contains', { a: 1, b: 2, c: 3 }, { a: 1, c: 3 })).not.toThrow()
    })

    it('fails when object is missing expected key', () => {
      expect(() => runMatcher('contains', { a: 1 }, { b: 2 })).toThrow(AssertionError)
    })

    it('passes when array contains the element', () => {
      expect(() => runMatcher('contains', ['a', 'b', 'c'], 'b')).not.toThrow()
    })

    it('fails when array does not contain element', () => {
      expect(() => runMatcher('contains', ['a', 'b'], 'z')).toThrow(AssertionError)
    })

    it('throws for non-string/array/object', () => {
      expect(() => runMatcher('contains', 42, 4)).toThrow(AssertionError)
    })
  })

  describe('matches', () => {
    it('passes when string matches regex pattern string', () => {
      expect(() => runMatcher('matches', 'order-123', '^order-\\d+')).not.toThrow()
    })

    it('passes when string matches RegExp', () => {
      expect(() => runMatcher('matches', 'hello123', /\d+/)).not.toThrow()
    })

    it('fails when string does not match', () => {
      expect(() => runMatcher('matches', 'hello', '^order')).toThrow(AssertionError)
    })

    it('throws for non-string actual', () => {
      expect(() => runMatcher('matches', 42, '\\d+')).toThrow(AssertionError)
    })
  })

  describe('exists', () => {
    it('passes for non-null, non-undefined values', () => {
      expect(() => runMatcher('exists', 'hello', undefined)).not.toThrow()
      expect(() => runMatcher('exists', 0, undefined)).not.toThrow()
      expect(() => runMatcher('exists', false, undefined)).not.toThrow()
      expect(() => runMatcher('exists', {}, undefined)).not.toThrow()
    })

    it('fails for null', () => {
      expect(() => runMatcher('exists', null, undefined)).toThrow(AssertionError)
    })

    it('fails for undefined', () => {
      expect(() => runMatcher('exists', undefined, undefined)).toThrow(AssertionError)
    })
  })

  describe('notExists', () => {
    it('passes for null', () => {
      expect(() => runMatcher('notExists', null, undefined)).not.toThrow()
    })

    it('passes for undefined', () => {
      expect(() => runMatcher('notExists', undefined, undefined)).not.toThrow()
    })

    it('fails for a real value', () => {
      expect(() => runMatcher('notExists', 'hello', undefined)).toThrow(AssertionError)
    })
  })
})

describe('matchInlineBody', () => {
  const body = { id: 'order-1', status: 'confirmed', count: 3 }

  it('passes when all expected fields match', () => {
    expect(() => matchInlineBody(body, { status: 'confirmed' })).not.toThrow()
  })

  it('fails when a field does not match', () => {
    expect(() => matchInlineBody(body, { status: 'pending' })).toThrow()
  })

  it('passes when expected field value is "exists" string', () => {
    expect(() => matchInlineBody(body, { id: 'exists' })).not.toThrow()
  })

  it('fails when "exists" check fails (field missing)', () => {
    expect(() => matchInlineBody(body, { missingField: 'exists' })).toThrow()
  })

  it('handles null body gracefully', () => {
    expect(() => matchInlineBody(null, { id: 'order-1' })).toThrow()
  })
})
