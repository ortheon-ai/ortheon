// Ortheon Server SPA
// Vanilla JS, History API routing, five views: dashboard / runs / suite-detail / run-view / contract-detail
//
// Sections:
//  1. Router
//  2. API helpers
//  3. State helpers
//  4. Render primitives
//  5. Grouping utilities
//  6. Dashboard – Suites view
//  7. Dashboard – Runs list view
//  8. Dashboard – Contracts list view
//  9. Suite detail view
// 10. Contract detail view
// 11. Run view

// ---------------------------------------------------------------------------
// 1. Router
// ---------------------------------------------------------------------------

function navigate(path, push = true) {
  if (push && location.pathname !== path) history.pushState(null, '', path)
  render(path)
}

window.addEventListener('popstate', () => render(location.pathname))

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-link]')
  if (!link) return
  e.preventDefault()
  navigate(link.getAttribute('href') || '/')
})

// ---------------------------------------------------------------------------
// 2. API helpers
// ---------------------------------------------------------------------------

async function apiFetch(path) {
  const res = await fetch(path)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json()
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// 3. State helpers
// ---------------------------------------------------------------------------

// Per-run collapsed flow state: Map<runId, Set<flowName>>
const collapsedFlowsState = new Map()

function getCollapsedFlows(runId) {
  if (!collapsedFlowsState.has(runId)) collapsedFlowsState.set(runId, new Set())
  return collapsedFlowsState.get(runId)
}

function toggleFlowCollapse(runId, flowName) {
  const set = getCollapsedFlows(runId)
  if (set.has(flowName)) set.delete(flowName)
  else set.add(flowName)
}

function isFlowCollapsed(runId, flowName) {
  return getCollapsedFlows(runId).has(flowName)
}

// Per-run expanded step state: Map<runId, Set<stepKey>>
const expandedStepsState = new Map()

function getExpandedSteps(runId) {
  if (!expandedStepsState.has(runId)) expandedStepsState.set(runId, new Set())
  return expandedStepsState.get(runId)
}

function toggleStepExpand(runId, stepKey) {
  const set = getExpandedSteps(runId)
  if (set.has(stepKey)) set.delete(stepKey)
  else set.add(stepKey)
}

function isStepExpanded(runId, stepKey) {
  return getExpandedSteps(runId).has(stepKey)
}

// Compute smart collapse defaults for a completed run
function applySmartCollapseDefaults(run) {
  if (run.status === 'pending' || run.status === 'running') return

  const collapsed = getCollapsedFlows(run.id)
  if (collapsed.size > 0) return // user has already interacted, respect their state

  const flows = run.flows ?? []
  const anyFailed = flows.some(f => f.failed > 0)

  if (anyFailed) {
    // Collapse fully-passing flows, expand failed ones
    for (const f of flows) {
      if (f.failed === 0) collapsed.add(f.name)
    }
  } else {
    // All passed: collapse all but the first
    for (let i = 1; i < flows.length; i++) {
      collapsed.add(flows[i].name)
    }
  }
}

// Auto-expand failed steps for a run
function applyAutoExpandFailures(run) {
  const expanded = getExpandedSteps(run.id)
  if (expanded.size > 0) return // already initialized

  const flows = run.flows ?? []
  let idx = 0
  for (const f of flows) {
    for (const s of f.steps) {
      if (s.status === 'fail') expanded.add(`${run.id}:${idx}`)
      idx++
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Render primitives
// ---------------------------------------------------------------------------

const root = document.getElementById('root')
const breadcrumb = document.getElementById('breadcrumb')

function setRoot(html) { root.innerHTML = html }
function setBreadcrumb(html) { breadcrumb.innerHTML = html }

function statusBadge(status) {
  const labels = { pending: '◌ pending', running: '● running', pass: '✔ pass', fail: '✘ fail', error: '✘ error' }
  return `<span class="status-badge status-${status}" data-testid="run-status" data-status="${status}">${labels[status] ?? status}</span>`
}

// Returns a badge that visually reflects whether the run met its expected outcome.
// meetsExpected is null while the run is still in progress (pending/running).
function outcomeBadge(status, meetsExpected, expectedOutcome) {
  if (meetsExpected === null || meetsExpected === undefined) {
    return statusBadge(status)
  }
  if (meetsExpected) {
    if (expectedOutcome === 'pass') {
      return statusBadge(status)
    }
    return `<span class="status-badge status-pass" data-testid="run-status" data-status="${escapeHtml(status)}">✔ ${escapeHtml(status)} · expected</span>`
  }
  if (expectedOutcome !== 'pass') {
    return `<span class="status-badge status-fail" data-testid="run-status" data-status="${escapeHtml(status)}">✘ ${escapeHtml(status)} · unexpected</span>`
  }
  return statusBadge(status)
}

function durationLabel(ms) {
  if (ms === null || ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function timeAgo(iso) {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay === 1) return 'yesterday'
  return `${diffDay}d ago`
}

function methodBadge(method) {
  return `<span class="method-badge method-${method.toLowerCase()}">${escapeHtml(method)}</span>`
}

function renderTabBar(activeTab) {
  return `
    <div class="tab-bar">
      <a class="tab${activeTab === 'suites' ? ' active' : ''}" href="/" data-link data-testid="suites-tab">Suites</a>
      <a class="tab${activeTab === 'runs' ? ' active' : ''}" href="/runs" data-link data-testid="runs-tab">Runs</a>
      <a class="tab${activeTab === 'contracts' ? ' active' : ''}" href="/contracts" data-link data-testid="contracts-tab">Contracts</a>
    </div>`
}

// Render a JSON-like value as readable HTML
function renderJsonValue(val, depth = 0) {
  if (val === null) return '<span class="json-null">null</span>'
  if (typeof val === 'boolean') return `<span class="json-bool">${val}</span>`
  if (typeof val === 'number') return `<span class="json-num">${val}</span>`
  if (typeof val === 'string') return `<span class="json-str">${escapeHtml(JSON.stringify(val))}</span>`
  if (Array.isArray(val)) {
    if (val.length === 0) return '<span class="json-punct">[]</span>'
    if (depth >= 2) return `<span class="json-punct">[…]</span>`
    const items = val.map(v => `<div class="json-arr-item">${renderJsonValue(v, depth + 1)}</div>`).join('')
    return `<div class="json-arr">${items}</div>`
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val)
    if (entries.length === 0) return '<span class="json-punct">{}</span>'
    if (depth >= 2) return `<span class="json-punct">{…}</span>`
    const rows = entries.map(([k, v]) =>
      `<tr><td class="kv-key">${escapeHtml(k)}</td><td class="kv-val">${renderJsonValue(v, depth + 1)}</td></tr>`
    ).join('')
    return `<table class="kv-table">${rows}</table>`
  }
  return escapeHtml(String(val))
}

// ---------------------------------------------------------------------------
// 5. Grouping utilities
// ---------------------------------------------------------------------------

// Group consecutive steps by section, preserving order.
// Returns: [{section: string|null, steps: [step, ...]}]
function groupStepsBySection(steps) {
  const groups = []
  for (const step of steps) {
    const section = step.section ?? null
    const last = groups[groups.length - 1]
    if (last && last.section === section) {
      last.steps.push(step)
    } else {
      groups.push({ section, steps: [step] })
    }
  }
  return groups
}

// ---------------------------------------------------------------------------
// 6. Dashboard – Suites view
// ---------------------------------------------------------------------------

// Cache full suite list for tag chip collection (not re-derived from filtered results)
let _allSuites = null
let _activeTag = null
let _searchDebounceTimer = null

async function renderDashboard() {
  setBreadcrumb('')
  setRoot('<div class="loading-state"><span class="spinner">◌</span> Loading suites&hellip;</div>')

  let data
  try {
    data = await apiFetch('/api/suites')
  } catch (err) {
    setRoot(`<div class="error-state">Failed to load suites: ${escapeHtml(err.message)}</div>`)
    return
  }

  _allSuites = data.suites
  _activeTag = null
  renderSuiteGrid(_allSuites, '')
}

function renderSuiteGrid(suites, searchVal) {
  const allTags = [...new Set((_allSuites ?? []).flatMap(s => s.tags || []))].sort()

  const tagChips = allTags.length > 0
    ? `<div class="tag-chips">
        ${allTags.map(t => `<button class="tag-chip${_activeTag === t ? ' active' : ''}" data-tag="${escapeHtml(t)}" data-testid="tag-chip">${escapeHtml(t)}</button>`).join('')}
       </div>`
    : ''

  const cards = suites.length === 0
    ? '<div class="empty-state">No spec files match your filter. Try a different search.</div>'
    : suites.map(s => {
        const tags = (s.tags || []).map(t => `<span class="badge badge-tag">${escapeHtml(t)}</span>`).join('')
        const errorBadge = s.hasError ? '<span class="badge badge-error">load error</span>' : ''
        const flowBadge = `<span class="badge badge-flow">${s.flowCount} flow${s.flowCount !== 1 ? 's' : ''}</span>`

        let lastRunHtml = ''
        if (s.lastRun) {
          const ago = timeAgo(s.lastRun.startedAt)
          const exact = new Date(s.lastRun.startedAt).toLocaleString()
          const dur = s.lastRun.durationMs !== null ? ` · ${durationLabel(s.lastRun.durationMs)}` : ''
          const expectedOutcome = s.lastRun.expectedOutcome ?? s.expectedOutcome ?? 'pass'
          const meetsExpected = s.lastRun.meetsExpectedOutcome
          lastRunHtml = `
            <div class="suite-card-last-run" data-testid="suite-last-run">
              ${outcomeBadge(s.lastRun.status, meetsExpected, expectedOutcome)}
              <span class="last-run-time" title="${escapeHtml(exact)}">${escapeHtml(ago)}${escapeHtml(dur)}</span>
            </div>`
        }

        return `
          <a class="suite-card" href="/suites/${encodeURIComponent(s.id)}" data-link data-testid="suite-card" data-suite-id="${escapeHtml(s.id)}">
            <div class="suite-card-name">${escapeHtml(s.name)}</div>
            <div class="suite-card-path">${escapeHtml(s.path)}</div>
            <div class="suite-card-meta">${flowBadge}${tags}${errorBadge}</div>
            ${lastRunHtml}
          </a>`
      }).join('\n')

  setRoot(`
    <div>
      ${renderTabBar('suites')}
      <div class="tab-content-header">
        <div class="filter-bar">
          <div class="filter-bar-row">
            <input
              class="search-input"
              type="search"
              placeholder="Search suites…"
              value="${escapeHtml(searchVal)}"
              data-testid="search-input"
              autocomplete="off"
            />
            <button class="btn btn-primary" id="run-all-btn" data-testid="run-all-button">▶ Run All</button>
          </div>
          ${tagChips}
        </div>
        <div class="section-subtitle">${suites.length} suite${suites.length !== 1 ? 's' : ''} discovered</div>
      </div>
      <div class="suite-grid" data-testid="suite-list">
        ${cards}
      </div>
    </div>
  `)

  // Wire up search
  const input = root.querySelector('.search-input')
  if (input) {
    input.addEventListener('input', (e) => {
      clearTimeout(_searchDebounceTimer)
      const val = e.target.value
      _searchDebounceTimer = setTimeout(() => fetchFilteredSuites(val, _activeTag), 200)
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.target.value = ''; fetchFilteredSuites('', _activeTag) }
    })
  }

  // Wire up tag chips
  root.querySelectorAll('[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.getAttribute('data-tag')
      _activeTag = _activeTag === tag ? null : tag
      const searchVal2 = root.querySelector('.search-input')?.value ?? ''
      fetchFilteredSuites(searchVal2, _activeTag)
    })
  })

  // Wire up Run All
  const runAllBtn = root.querySelector('#run-all-btn')
  if (runAllBtn) {
    runAllBtn.addEventListener('click', () => startRunAll())
  }
}

async function fetchFilteredSuites(name, tag) {
  const params = new URLSearchParams()
  if (name) params.set('name', name)
  if (tag) params.set('tag', tag)
  const qs = params.toString()

  try {
    const data = await apiFetch(`/api/suites${qs ? '?' + qs : ''}`)
    renderSuiteGrid(data.suites, name)
  } catch (err) {
    // silently keep old grid on transient error
  }
}

// ---------------------------------------------------------------------------
// 7. Dashboard – Runs list view
// ---------------------------------------------------------------------------

async function renderRunsList() {
  setBreadcrumb('')
  setRoot('<div class="loading-state"><span class="spinner">◌</span> Loading runs&hellip;</div>')

  let data
  try {
    data = await apiFetch('/api/runs')
  } catch (err) {
    setRoot(`<div class="error-state">Failed to load runs: ${escapeHtml(err.message)}</div>`)
    return
  }

  const runs = [...data.runs].reverse()

  const rows = runs.length === 0
    ? '<div class="empty-state">No runs yet. Open a suite and click Run.</div>'
    : runs.map(r => {
        const ago = timeAgo(r.startedAt)
        const exact = new Date(r.startedAt).toLocaleString()
        const dur = r.durationMs !== null ? durationLabel(r.durationMs) : ''
        const expectedOutcome = r.expectedOutcome ?? 'pass'
        return `
          <a class="run-row" href="/runs/${encodeURIComponent(r.id)}" data-link>
            <div class="run-row-suite">${escapeHtml(r.suiteName)}</div>
            <div class="run-row-meta">
              ${outcomeBadge(r.status, r.meetsExpectedOutcome, expectedOutcome)}
              <span class="run-row-time" title="${escapeHtml(exact)}">${escapeHtml(ago)}</span>
              ${dur ? `<span class="run-row-dur">${escapeHtml(dur)}</span>` : ''}
            </div>
          </a>`
      }).join('\n')

  setRoot(`
    <div>
      ${renderTabBar('runs')}
      <div class="tab-content-header">
        <div class="section-subtitle">${runs.length} run${runs.length !== 1 ? 's' : ''} (most recent first)</div>
      </div>
      <div class="runs-list" data-testid="runs-list">
        ${rows}
      </div>
    </div>
  `)
}

// ---------------------------------------------------------------------------
// 8. Dashboard – Contracts list view
// ---------------------------------------------------------------------------

async function renderContractsList() {
  setBreadcrumb('')
  setRoot('<div class="loading-state"><span class="spinner">◌</span> Loading contracts&hellip;</div>')

  let data
  try {
    data = await apiFetch('/api/contracts')
  } catch (err) {
    setRoot(`<div class="error-state">Failed to load contracts: ${escapeHtml(err.message)}</div>`)
    return
  }

  const { contracts } = data

  const cards = contracts.length === 0
    ? '<div class="empty-state">No contracts declared across loaded suites.</div>'
    : contracts.map(c => {
        const suiteBadge = `<span class="badge badge-flow">${c.suiteCount} suite${c.suiteCount !== 1 ? 's' : ''}</span>`
        const purpose = c.purpose ? `<div class="contract-card-purpose">${escapeHtml(c.purpose)}</div>` : ''
        return `
          <a class="contract-card" href="/contracts/${encodeURIComponent(c.name)}" data-link data-testid="contract-card">
            <div class="contract-card-top">
              ${methodBadge(c.method)}
              <span class="contract-card-name">${escapeHtml(c.name)}</span>
            </div>
            <div class="contract-card-path">${escapeHtml(c.path)}</div>
            ${purpose}
            <div class="contract-card-meta">${suiteBadge}</div>
          </a>`
      }).join('\n')

  setRoot(`
    <div>
      ${renderTabBar('contracts')}
      <div class="tab-content-header">
        <div class="section-subtitle">${contracts.length} contract${contracts.length !== 1 ? 's' : ''} declared</div>
      </div>
      <div class="suite-grid" data-testid="contract-list">
        ${cards}
      </div>
    </div>
  `)
}

// ---------------------------------------------------------------------------
// 9. Suite detail view
// ---------------------------------------------------------------------------

async function renderSuiteDetail(id) {
  setBreadcrumb(`<span class="crumb"><a href="/" data-link>Suites</a></span><span class="crumb-sep"> / </span><span class="crumb-current" id="suite-name-crumb">…</span>`)
  setRoot('<div class="loading-state"><span class="spinner">◌</span> Loading suite&hellip;</div>')

  let suite, plan
  try {
    ;[suite, plan] = await Promise.all([
      apiFetch(`/api/suites/${encodeURIComponent(id)}`),
      apiFetch(`/api/suites/${encodeURIComponent(id)}/plan`),
    ])
  } catch (err) {
    setRoot(`<div class="error-state">${escapeHtml(err.message)}</div>`)
    return
  }

  document.getElementById('suite-name-crumb').textContent = suite.name

  function flowAnchorId(name) {
    return 'flow-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  }

  const flowList = suite.flowNames.length
    ? suite.flowNames.map(n => `<li><button class="flow-jump-link" data-scroll-to="${flowAnchorId(n)}">${escapeHtml(n)}</button></li>`).join('')
    : '<li class="info-list-empty">none</li>'

  const apiList = suite.apiNames.length
    ? suite.apiNames.map(n => `<li><a href="/contracts/${encodeURIComponent(n)}" data-link>${escapeHtml(n)}</a></li>`).join('')
    : '<li class="info-list-empty">none</li>'

  const tagBadges = (suite.tags || []).map(t => `<span class="badge badge-tag">${escapeHtml(t)}</span>`).join('')

  const safetyLabel = suite.safety
    ? `<span class="badge badge-flow">${escapeHtml(suite.safety)}</span>`
    : ''

  const validationHtml = renderValidationBlock(plan.validation)

  const steps = plan.steps || []
  const flowRanges = plan.flowRanges || []

  function renderPlanStep(s, globalIdx, flowName) {
    const actionClass = `action-${s.actionType}`
    const sectionHtml = s.section ? `<div class="plan-step-section">${escapeHtml(s.section)}</div>` : ''

    const flowOriginHtml = s.flowOrigin && s.flowOrigin !== flowName
      ? `<span class="plan-step-flow-origin">via ${escapeHtml(s.flowOrigin)}</span>`
      : ''

    const savePills = (s.saves || []).map(k =>
      `<span class="plan-step-pill plan-step-pill-save">save: ${escapeHtml(k)}</span>`
    ).join('')

    const expectPills = (s.expects || []).map(e =>
      `<span class="plan-step-pill plan-step-pill-expect">${escapeHtml(e)}</span>`
    ).join('')

    const retryPill = s.retries > 0
      ? `<span class="plan-step-pill plan-step-pill-retry">retry ×${s.retries}${s.retryIntervalMs ? ` @ ${s.retryIntervalMs}ms` : ''}</span>`
      : ''

    const detailPills = savePills + expectPills + retryPill
    const detailHtml = detailPills
      ? `<div class="plan-step-details">${detailPills}</div>`
      : ''

    return `
      <div class="plan-step" data-testid="plan-step">
        <div class="plan-step-num">${globalIdx + 1}</div>
        <div class="plan-step-body">
          <div class="plan-step-name">${escapeHtml(s.name)}${flowOriginHtml}</div>
          <div class="plan-step-action ${actionClass}">${escapeHtml(s.actionSummary)}</div>
          ${sectionHtml}
          ${detailHtml}
        </div>
      </div>`
  }

  let planSteps
  if (flowRanges.length > 0) {
    planSteps = flowRanges.map(range => {
      const flowSteps = steps.slice(range.startIndex, range.startIndex + range.stepCount)
      const stepsHtml = flowSteps.map((s, i) => renderPlanStep(s, range.startIndex + i, range.name)).join('\n')
      return `
        <div class="plan-flow-group" id="${flowAnchorId(range.name)}">
          <div class="plan-flow-header">
            <span class="plan-flow-name">${escapeHtml(range.name)}</span>
            <span class="plan-flow-count">${range.stepCount} step${range.stepCount !== 1 ? 's' : ''}</span>
          </div>
          <div class="plan-flow-steps">
            ${stepsHtml || '<div class="empty-state" style="min-height:40px;font-size:12px;">no steps</div>'}
          </div>
        </div>`
    }).join('\n')
  } else {
    planSteps = steps.map((s, i) => renderPlanStep(s, i, null)).join('\n')
  }

  setRoot(`
    <div class="suite-detail" data-testid="suite-detail">
      <div class="detail-header">
        <div>
          <div class="detail-title">${escapeHtml(suite.name)}</div>
          <div class="detail-meta">
            <span class="detail-path">${escapeHtml(suite.path)}</span>
            ${tagBadges}
            ${safetyLabel}
          </div>
        </div>
        <button class="btn btn-primary" id="run-btn" data-testid="run-button" data-suite-id="${escapeHtml(id)}">
          ▶ Run
        </button>
      </div>

      ${validationHtml}

      <div class="info-grid">
        <div class="info-card">
          <div class="info-card-label">Flows</div>
          <ul class="info-list">${flowList}</ul>
        </div>
        <div class="info-card">
          <div class="info-card-label">API Contracts</div>
          <ul class="info-list">${apiList}</ul>
        </div>
        <div class="info-card">
          <div class="info-card-label">Steps</div>
          <div style="font-size: 28px; font-weight: 700; color: var(--text); font-family: var(--mono);">${plan.steps.length}</div>
        </div>
      </div>

      <div class="plan-section">
        <div class="plan-header">
          <span>Expanded Plan</span>
          <span>${plan.steps.length} steps</span>
        </div>
        <div class="plan-steps-list" data-testid="plan-steps">
          ${planSteps || '<div class="empty-state">No steps</div>'}
        </div>
      </div>
    </div>
  `)

  document.getElementById('run-btn')?.addEventListener('click', () => startRun(id))

  root.querySelectorAll('[data-scroll-to]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-scroll-to')
      const target = document.getElementById(targetId)
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  })
}

function renderValidationBlock(validation) {
  if (!validation) return ''
  const { errors = [], warnings = [] } = validation

  if (errors.length === 0 && warnings.length === 0) {
    return '<div class="validation-block valid" data-testid="validation-summary">✔ Validation passed</div>'
  }

  const errorItems = errors.map(e => `
    <div class="validation-item v-error">
      <span class="validation-icon">✘</span>
      <span>${escapeHtml(e)}</span>
    </div>`).join('')

  const warnItems = warnings.map(w => `
    <div class="validation-item v-warning">
      <span class="validation-icon">⚠</span>
      <span>${escapeHtml(w)}</span>
    </div>`).join('')

  const summary = []
  if (errors.length > 0) summary.push(`${errors.length} error${errors.length !== 1 ? 's' : ''}`)
  if (warnings.length > 0) summary.push(`${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`)

  const cls = errors.length > 0 ? 'has-errors' : 'has-warnings'
  return `
    <div class="validation-block ${cls}" data-testid="validation-summary">
      <div class="validation-summary-line">
        ${errors.length > 0 ? '✘' : '⚠'} ${escapeHtml(summary.join(', '))}
      </div>
      <div class="validation-items">
        ${errorItems}${warnItems}
      </div>
    </div>`
}

async function startRun(suiteId) {
  const btn = document.getElementById('run-btn')
  if (btn) btn.disabled = true

  try {
    const { runId } = await apiPost(`/api/suites/${encodeURIComponent(suiteId)}/run`, {})
    navigate(`/runs/${runId}`)
  } catch (err) {
    if (btn) {
      btn.disabled = false
      btn.textContent = `Error: ${err.message}`
    }
  }
}

async function startRunAll() {
  const btn = document.getElementById('run-all-btn')
  if (btn) {
    btn.disabled = true
    btn.textContent = '▶ Starting…'
  }

  try {
    await apiPost('/api/run-all', {})
    navigate('/runs')
  } catch (err) {
    if (btn) {
      btn.disabled = false
      btn.textContent = `Error: ${err.message}`
      setTimeout(() => { btn.textContent = '▶ Run All' }, 3000)
    }
  }
}

// ---------------------------------------------------------------------------
// 10. Contract detail view
// ---------------------------------------------------------------------------

async function renderContractDetail(name) {
  setBreadcrumb(`<span class="crumb"><a href="/contracts" data-link>Contracts</a></span><span class="crumb-sep"> / </span><span class="crumb-current" id="contract-name-crumb">…</span>`)
  setRoot('<div class="loading-state"><span class="spinner">◌</span> Loading contract&hellip;</div>')

  let contract
  try {
    contract = await apiFetch(`/api/contracts/${encodeURIComponent(name)}`)
  } catch (err) {
    setRoot(`<div class="error-state">${escapeHtml(err.message)}</div>`)
    return
  }

  document.getElementById('contract-name-crumb').textContent = contract.name

  const purposeHtml = contract.purpose
    ? `<div class="contract-detail-purpose">${escapeHtml(contract.purpose)}</div>`
    : ''

  function renderKvTable(obj) {
    if (!obj || typeof obj !== 'object') return ''
    const rows = Object.entries(obj)
    if (rows.length === 0) return ''
    return `<table class="kv-table">${rows.map(([k, v]) =>
      `<tr><td class="kv-key">${escapeHtml(k)}</td><td class="kv-val">${escapeHtml(String(v))}</td></tr>`
    ).join('')}</table>`
  }

  const req = contract.request
  const reqSections = []
  if (req) {
    if (req.params && Object.keys(req.params).length > 0) {
      reqSections.push(`<div class="contract-section-label">Path params</div>${renderKvTable(req.params)}`)
    }
    if (req.query && Object.keys(req.query).length > 0) {
      reqSections.push(`<div class="contract-section-label">Query params</div>${renderKvTable(req.query)}`)
    }
    if (req.headers && Object.keys(req.headers).length > 0) {
      reqSections.push(`<div class="contract-section-label">Headers</div>${renderKvTable(req.headers)}`)
    }
    if (req.body !== undefined && req.body !== null) {
      const bodyHtml = typeof req.body === 'object' && !Array.isArray(req.body)
        ? renderJsonValue(req.body)
        : `<pre class="contract-body-pre">${escapeHtml(JSON.stringify(req.body, null, 2))}</pre>`
      reqSections.push(`<div class="contract-section-label">Body</div><div class="contract-body-block">${bodyHtml}</div>`)
    }
  }

  const requestCard = reqSections.length > 0
    ? `<div class="info-card"><div class="info-card-label">Request</div>${reqSections.join('')}</div>`
    : ''

  const resp = contract.response
  const respSections = []
  if (resp) {
    if (resp.status !== undefined && resp.status !== null) {
      respSections.push(`<div class="contract-section-label">Status</div><span class="contract-status-code">${escapeHtml(String(resp.status))}</span>`)
    }
    if (resp.body !== undefined && resp.body !== null) {
      const bodyHtml = typeof resp.body === 'object' && !Array.isArray(resp.body)
        ? renderJsonValue(resp.body)
        : `<pre class="contract-body-pre">${escapeHtml(JSON.stringify(resp.body, null, 2))}</pre>`
      respSections.push(`<div class="contract-section-label">Body</div><div class="contract-body-block">${bodyHtml}</div>`)
    }
  }

  const responseCard = respSections.length > 0
    ? `<div class="info-card"><div class="info-card-label">Response</div>${respSections.join('')}</div>`
    : resp
      ? `<div class="info-card"><div class="info-card-label">Response</div><span class="info-list-empty">No response metadata declared</span></div>`
      : ''

  const suiteItems = (contract.suites || []).map(s =>
    `<li><a href="/suites/${encodeURIComponent(s.id)}" data-link>${escapeHtml(s.name)}</a></li>`
  ).join('')

  const suitesCard = `
    <div class="info-card">
      <div class="info-card-label">Used in suites</div>
      ${suiteItems
        ? `<ul class="info-list">${suiteItems}</ul>`
        : '<span class="info-list-empty">none</span>'}
    </div>`

  setRoot(`
    <div class="suite-detail" data-testid="contract-detail">
      <div class="detail-header">
        <div>
          <div class="detail-title contract-detail-title">
            ${methodBadge(contract.method)}
            <span>${escapeHtml(contract.name)}</span>
          </div>
          <div class="detail-meta">
            <span class="detail-path">${escapeHtml(contract.path)}</span>
          </div>
        </div>
      </div>
      ${purposeHtml}
      <div class="info-grid">
        ${requestCard}
        ${responseCard}
        ${suitesCard}
      </div>
    </div>
  `)
}

// ---------------------------------------------------------------------------
// 11. Run view
// ---------------------------------------------------------------------------

let pollTimer = null

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function renderRunView(id) {
  stopPolling()
  setBreadcrumb(`<span class="crumb"><a href="/" data-link>Suites</a></span><span class="crumb-sep"> / </span><span class="crumb-current">Run</span>`)
  setRoot('<div class="loading-state"><span class="spinner">◌</span> Loading run&hellip;</div>')

  let run
  try {
    run = await apiFetch(`/api/runs/${id}`)
  } catch (err) {
    setRoot(`<div class="error-state">${escapeHtml(err.message)}</div>`)
    return
  }

  applySmartCollapseDefaults(run)
  applyAutoExpandFailures(run)
  renderRun(run)

  if (run.status === 'pending' || run.status === 'running') {
    pollTimer = setInterval(async () => {
      try {
        const updated = await apiFetch(`/api/runs/${id}`)
        applySmartCollapseDefaults(updated)
        applyAutoExpandFailures(updated)
        renderRun(updated)
        if (updated.status !== 'pending' && updated.status !== 'running') {
          stopPolling()
        }
      } catch {
        stopPolling()
      }
    }, 2000)
  }
}

function renderRun(run) {
  // Update breadcrumb with suite link once we have the data
  const shortId = run.id.slice(0, 8)
  setBreadcrumb(`
    <span class="crumb"><a href="/" data-link>Suites</a></span>
    <span class="crumb-sep"> / </span>
    <span class="crumb"><a href="/suites/${encodeURIComponent(run.suiteId)}" data-link>${escapeHtml(run.suiteName)}</a></span>
    <span class="crumb-sep"> / </span>
    <span class="crumb-current">Run ${escapeHtml(shortId)}</span>
  `)

  const isTerminal = run.status !== 'pending' && run.status !== 'running'
  const startExact = new Date(run.startedAt).toLocaleString()
  const expectedOutcome = run.expectedOutcome ?? 'pass'
  const meetsExpected = run.meetsExpectedOutcome

  const progressHtml = run.totalSteps !== null ? `
    <div class="run-progress">
      <span class="prog-pass">✔ ${run.passedSteps}</span>
      <span class="prog-fail">✘ ${run.failedSteps}</span>
      <span>/ ${run.totalSteps} steps</span>
      ${run.durationMs !== null ? `<span>${durationLabel(run.durationMs)}</span>` : ''}
    </div>` : ''

  const errorHtml = run.error
    ? `<div class="run-error-block">Error: ${escapeHtml(run.error)}</div>`
    : ''

  const validationHtml = run.validation && (run.validation.errors.length > 0)
    ? `<div class="run-validation-block">
        <div class="run-validation-title">Validation errors</div>
        ${run.validation.errors.map(e => `<div class="run-validation-item">✘ ${escapeHtml(e)}</div>`).join('')}
      </div>`
    : ''

  const rerunBtn = isTerminal
    ? `<button class="btn btn-secondary" id="rerun-btn" data-testid="rerun-button" data-suite-id="${escapeHtml(run.suiteId)}">↺ Re-run</button>`
    : ''

  // Build flows HTML
  let flowsHtml = ''
  if (run.flows && run.flows.length > 0) {
    let globalStepIdx = 0
    flowsHtml = run.flows.map(f => {
      const collapsed = isFlowCollapsed(run.id, f.name)
      const flowDurMs = f.steps.reduce((acc, s) => acc + (s.durationMs ?? 0), 0)
      const flowDur = flowDurMs > 0 ? durationLabel(flowDurMs) : ''
      const flowStatus = f.failed > 0 ? 'fail' : (f.skipped === f.steps.length ? 'skip' : 'pass')

      const countBadges = `
        <span class="flow-count flow-count-pass">✔ ${f.passed}</span>
        <span class="flow-count flow-count-fail">✘ ${f.failed}</span>
        ${f.skipped > 0 ? `<span class="flow-count flow-count-skip">○ ${f.skipped}</span>` : ''}
      `

      const sectionGroups = groupStepsBySection(f.steps)

      const stepsHtml = sectionGroups.map(group => {
        const sectionHeader = group.section
          ? `<div class="run-section-header" data-testid="section-header">${escapeHtml(group.section)}</div>`
          : ''

        const stepRows = group.steps.map(s => {
          const stepKey = `${run.id}:${globalStepIdx}`
          globalStepIdx++
          return renderStepRow(run.id, stepKey, s)
        }).join('\n')

        return sectionHeader + stepRows
      }).join('\n')

      return `
        <div class="flow-block" data-flow="${escapeHtml(f.name)}">
          <div class="flow-header flow-header-${flowStatus}" data-testid="flow-header" data-flow="${escapeHtml(f.name)}" data-run="${escapeHtml(run.id)}">
            <span class="flow-toggle">${collapsed ? '▶' : '▼'}</span>
            <span class="flow-name">${escapeHtml(f.name)}</span>
            <span class="flow-counts">${countBadges}</span>
            ${flowDur ? `<span class="flow-dur">${escapeHtml(flowDur)}</span>` : ''}
          </div>
          <div class="flow-steps${collapsed ? ' is-collapsed' : ''}">
            ${stepsHtml}
          </div>
        </div>`
    }).join('\n')
  } else if (run.status === 'pending' || run.status === 'running') {
    flowsHtml = '<div class="loading-state"><span class="spinner">◌</span> Waiting for steps&hellip;</div>'
  }

  root.innerHTML = `
    <div class="run-view">
      <div class="run-header">
        <div>
          <div class="run-title">Run: <a href="/suites/${encodeURIComponent(run.suiteId)}" data-link>${escapeHtml(run.suiteName)}</a></div>
          <div class="run-meta">
            ${outcomeBadge(run.status, meetsExpected, expectedOutcome)}
            <span title="${escapeHtml(startExact)}">${escapeHtml(timeAgo(run.startedAt))}</span>
          </div>
        </div>
        ${rerunBtn}
      </div>

      ${progressHtml}
      ${errorHtml}
      ${validationHtml}

      <div class="flows-list">
        ${flowsHtml}
      </div>
    </div>
  `

  // Wire up flow collapse toggles
  root.querySelectorAll('[data-testid="flow-header"]').forEach(header => {
    header.addEventListener('click', () => {
      const flowName = header.getAttribute('data-flow')
      const runId = header.getAttribute('data-run')
      toggleFlowCollapse(runId, flowName)
      const block = header.closest('.flow-block')
      const stepsEl = block?.querySelector('.flow-steps')
      const toggle = header.querySelector('.flow-toggle')
      if (stepsEl) stepsEl.classList.toggle('is-collapsed')
      if (toggle) toggle.textContent = stepsEl?.classList.contains('is-collapsed') ? '▶' : '▼'
    })
  })

  // Wire up step detail toggles
  root.querySelectorAll('[data-testid="step-detail-toggle"]').forEach(toggle => {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation()
      const stepKey = toggle.getAttribute('data-step-key')
      const runId = toggle.getAttribute('data-run')
      toggleStepExpand(runId, stepKey)
      const stepEl = toggle.closest('.run-step')
      const panel = stepEl?.querySelector('[data-testid="step-detail-panel"]')
      if (panel) panel.classList.toggle('is-hidden')
      toggle.textContent = panel?.classList.contains('is-hidden') ? '…' : '×'
    })
  })

  // Wire up re-run button
  const rerunBtnActual = document.getElementById('rerun-btn')
  if (rerunBtnActual) {
    rerunBtnActual.addEventListener('click', async () => {
      rerunBtnActual.disabled = true
      rerunBtnActual.textContent = '↺ Starting…'
      try {
        const suiteId = rerunBtnActual.getAttribute('data-suite-id')
        const { runId } = await apiPost(`/api/suites/${encodeURIComponent(suiteId)}/run`, {})
        navigate(`/runs/${runId}`)
      } catch (err) {
        rerunBtnActual.disabled = false
        rerunBtnActual.textContent = `↺ Re-run`
      }
    })
  }
}

function renderStepRow(runId, stepKey, s) {
  const statusIcon = {
    pass:  '<span class="step-icon step-icon-pass">✔</span>',
    fail:  '<span class="step-icon step-icon-fail">✘</span>',
    skip:  '<span class="step-icon step-icon-skip">○</span>',
  }[s.status] || '<span class="step-icon step-icon-pending">◌</span>'

  const dur = s.durationMs !== null && s.durationMs !== undefined ? durationLabel(s.durationMs) : ''
  const expanded = isStepExpanded(runId, stepKey)

  // Build detail panel content
  const hasDetail = s.actionSummary || (s.saves && s.saves.length > 0) || (s.expects && s.expects.length > 0) || s.error
  let detailHtml = ''
  if (hasDetail) {
    const actionLine = s.actionSummary
      ? `<div class="step-detail-row"><span class="step-detail-label">${escapeHtml(s.actionType ?? 'action')}</span><span class="step-detail-val mono">${escapeHtml(s.actionSummary)}</span></div>`
      : ''
    const savesLine = s.saves && s.saves.length > 0
      ? `<div class="step-detail-row"><span class="step-detail-label">saves</span><span class="step-detail-val mono">${s.saves.map(v => escapeHtml(v)).join(', ')}</span></div>`
      : ''
    const expectsLine = s.expects && s.expects.length > 0
      ? `<div class="step-detail-row"><span class="step-detail-label">expects</span><span class="step-detail-val">${s.expects.map(v => `<span class="mono">${escapeHtml(v)}</span>`).join('<br>')}</span></div>`
      : ''
    const errorLine = s.error
      ? `<div class="run-step-error">${escapeHtml(s.error)}</div>`
      : ''

    detailHtml = `
      <div class="step-detail-panel${expanded ? '' : ' is-hidden'}" data-testid="step-detail-panel">
        ${actionLine}${savesLine}${expectsLine}${errorLine}
      </div>`
  }

  const toggleBtn = hasDetail
    ? `<button class="step-detail-toggle" data-testid="step-detail-toggle" data-step-key="${escapeHtml(stepKey)}" data-run="${escapeHtml(runId)}" title="Toggle detail">${expanded ? '×' : '…'}</button>`
    : ''

  return `
    <div class="run-step is-${s.status}" data-testid="step-result" data-status="${escapeHtml(s.status || '')}">
      <div class="run-step-main">
        ${statusIcon}
        <div class="run-step-body">
          <div class="run-step-name">${escapeHtml(s.name)}</div>
        </div>
        <div class="run-step-right">
          <div class="run-step-dur">${escapeHtml(dur)}</div>
          ${toggleBtn}
        </div>
      </div>
      ${detailHtml}
    </div>`
}

// ---------------------------------------------------------------------------
// Router entry point
// ---------------------------------------------------------------------------

function render(path) {
  stopPolling()
  if (_searchDebounceTimer !== null) {
    clearTimeout(_searchDebounceTimer)
    _searchDebounceTimer = null
  }
  _allSuites = null
  _activeTag = null

  const suiteMatch    = path.match(/^\/suites\/([^/]+)\/?$/)
  const runMatch      = path.match(/^\/runs\/([^/]+)\/?$/)
  const contractMatch = path.match(/^\/contracts\/([^/]+)\/?$/)

  if (suiteMatch) {
    const id = decodeURIComponent(suiteMatch[1])
    renderSuiteDetail(id)
  } else if (runMatch) {
    const id = decodeURIComponent(runMatch[1])
    renderRunView(id)
  } else if (contractMatch) {
    const name = decodeURIComponent(contractMatch[1])
    renderContractDetail(name)
  } else if (path === '/contracts') {
    renderContractsList()
  } else if (path === '/runs') {
    renderRunsList()
  } else {
    renderDashboard()
  }
}

// Boot
render(location.pathname)
