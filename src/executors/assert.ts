import type { MatcherName } from '../types.js'

// ---------------------------------------------------------------------------
// Assertion engine -- five matchers only
// ---------------------------------------------------------------------------

export class AssertionError extends Error {
  constructor(
    public readonly matcher: MatcherName,
    public readonly actual: unknown,
    public readonly expected: unknown,
    message: string
  ) {
    super(message)
    this.name = 'AssertionError'
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as object)
    const keysB = Object.keys(b as object)
    if (keysA.length !== keysB.length) return false
    return keysA.every(k => deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k]
    ))
  }
  return false
}

// Subset match: all keys in expected are present in actual with equal values.
// Used for object subset matching in `contains`.
function isSubset(actual: unknown, expected: unknown): boolean {
  if (actual === null || typeof actual !== 'object') return false
  if (expected === null || typeof expected !== 'object') return false
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    if (!deepEqual((actual as Record<string, unknown>)[k], v)) return false
  }
  return true
}

export function runMatcher(
  matcher: MatcherName,
  actual: unknown,
  expected: unknown
): void {
  switch (matcher) {
    case 'equals': {
      if (!deepEqual(actual, expected)) {
        throw new AssertionError(
          matcher,
          actual,
          expected,
          `Expected ${stringify(actual)} to equal ${stringify(expected)}`
        )
      }
      break
    }
    case 'contains': {
      if (typeof actual === 'string' && typeof expected === 'string') {
        if (!actual.includes(expected)) {
          throw new AssertionError(
            matcher,
            actual,
            expected,
            `Expected string "${actual}" to contain "${expected}"`
          )
        }
      } else if (Array.isArray(actual)) {
        const found = actual.some(item => deepEqual(item, expected))
        if (!found) {
          throw new AssertionError(
            matcher,
            actual,
            expected,
            `Expected array to include ${stringify(expected)}`
          )
        }
      } else if (typeof actual === 'object' && actual !== null) {
        if (!isSubset(actual, expected)) {
          throw new AssertionError(
            matcher,
            actual,
            expected,
            `Expected object to contain subset ${stringify(expected)}`
          )
        }
      } else {
        throw new AssertionError(
          matcher,
          actual,
          expected,
          `Cannot use "contains" on ${typeof actual} value`
        )
      }
      break
    }
    case 'matches': {
      if (typeof actual !== 'string') {
        throw new AssertionError(
          matcher,
          actual,
          expected,
          `"matches" requires a string value, got ${typeof actual}`
        )
      }
      const pattern = expected instanceof RegExp ? expected : new RegExp(String(expected))
      if (!pattern.test(actual)) {
        throw new AssertionError(
          matcher,
          actual,
          expected,
          `Expected "${actual}" to match ${pattern}`
        )
      }
      break
    }
    case 'exists': {
      if (actual === null || actual === undefined) {
        throw new AssertionError(
          matcher,
          actual,
          undefined,
          `Expected value to exist but got ${stringify(actual)}`
        )
      }
      break
    }
    case 'notExists': {
      if (actual !== null && actual !== undefined) {
        throw new AssertionError(
          matcher,
          actual,
          undefined,
          `Expected value to not exist but got ${stringify(actual)}`
        )
      }
      break
    }
    default: {
      const _exhaustive: never = matcher
      throw new Error(`Unknown matcher: ${_exhaustive}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Inline body expectation matching
// Used to validate the `expect.body` block on API steps.
//
// Each field in the body expect block is checked with equals.
// If the value is an ExistsCheck marker ({ __type: 'exists_check' }), existence
// is checked instead of equality. Use existsCheck() from dsl.ts -- never the
// raw string "exists", which would be treated as a literal equality check.
// ---------------------------------------------------------------------------

function isExistsCheck(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __type?: string }).__type === 'exists_check'
  )
}

export function matchInlineBody(
  actual: unknown,
  expected: Record<string, unknown>
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = typeof actual === 'object' && actual !== null
      ? (actual as Record<string, unknown>)[key]
      : undefined

    if (isExistsCheck(expectedValue)) {
      runMatcher('exists', actualValue, undefined)
    } else {
      runMatcher('equals', actualValue, expectedValue)
    }
  }
}
