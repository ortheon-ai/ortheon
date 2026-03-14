import type { SpecResult, StepResult } from './types.js'

// ---------------------------------------------------------------------------
// Console reporter
// ---------------------------------------------------------------------------

const PASS = '\u2714' // ✔
const FAIL = '\u2718' // ✘
const SKIP = '\u25CB' // ○

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + '.'.repeat(len - str.length)
}

function statusIcon(status: StepResult['status']): string {
  switch (status) {
    case 'pass': return PASS
    case 'fail': return FAIL
    case 'skip': return SKIP
  }
}

function statusLabel(status: StepResult['status']): string {
  switch (status) {
    case 'pass': return 'PASS'
    case 'fail': return 'FAIL'
    case 'skip': return 'SKIP'
  }
}

export function consoleReport(result: SpecResult): void {
  const specHeader = result.status === 'pass'
    ? `PASS  ${result.specName}`
    : `FAIL  ${result.specName}`

  console.log('')
  console.log(specHeader)

  const colWidth = 58

  let currentSection: string | undefined

  for (const flow of result.flows) {
    for (const step of flow.steps) {
      // Print section header when section changes
      if (step.section !== currentSection) {
        currentSection = step.section
        if (currentSection) {
          console.log(`\n  [${currentSection}]`)
        }
      }

      const icon = statusIcon(step.status)
      const label = statusLabel(step.status)
      const durationStr = step.status !== 'skip' ? ` (${step.durationMs}ms)` : ''
      const name = step.section ? `    ${step.name}` : `  ${step.name}`
      const paddedName = padRight(name + ' ', colWidth)
      console.log(`${paddedName} ${icon} ${label}${durationStr}`)

      if (step.error) {
        const lines = step.error.split('\n')
        for (const line of lines) {
          console.log(`         ${line}`)
        }
      }
    }
  }

  console.log('')
  const summary = `  ${result.passedSteps} passed`
    + (result.failedSteps > 0 ? `, ${result.failedSteps} failed` : '')
    + `, ${result.totalSteps} total`
    + ` — ${result.durationMs}ms`
  console.log(summary)
  console.log('')
}

// ---------------------------------------------------------------------------
// JSON reporter
// ---------------------------------------------------------------------------

export function jsonReport(result: SpecResult): void {
  console.log(JSON.stringify(result, null, 2))
}

// ---------------------------------------------------------------------------
// Multi-spec summary
// ---------------------------------------------------------------------------

export function consoleSummary(results: SpecResult[]): void {
  const totalSpecs = results.length
  const passedSpecs = results.filter(r => r.status === 'pass').length
  const failedSpecs = results.filter(r => r.status === 'fail').length
  const totalSteps = results.reduce((n, r) => n + r.totalSteps, 0)
  const passedSteps = results.reduce((n, r) => n + r.passedSteps, 0)
  const failedSteps = results.reduce((n, r) => n + r.failedSteps, 0)
  const totalMs = results.reduce((n, r) => n + r.durationMs, 0)

  console.log('─'.repeat(64))
  if (failedSpecs > 0) {
    console.log(`FAILED  ${failedSpecs}/${totalSpecs} specs  |  ${failedSteps}/${totalSteps} steps failed  |  ${totalMs}ms`)
  } else {
    console.log(`PASSED  ${totalSpecs}/${totalSpecs} specs  |  ${passedSteps}/${totalSteps} steps  |  ${totalMs}ms`)
  }
  console.log('')
}
