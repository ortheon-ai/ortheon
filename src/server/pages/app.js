// Ortheon Server SPA
// Vanilla JS, History API routing, three views: dashboard / suite-detail / run-view

// ---------------------------------------------------------------------------
// Router
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
// API helpers
// ---------------------------------------------------------------------------

async function api(path) {
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
// Rendering helpers
// ---------------------------------------------------------------------------

const root = document.getElementById('root')
const breadcrumb = document.getElementById('breadcrumb')

function setRoot(html) { root.innerHTML = html }
function setBreadcrumb(html) { breadcrumb.innerHTML = html }

function statusBadge(status) {
  const labels = { pending: '◌ pending', running: '● running', pass: '✔ pass', fail: '✘ fail', error: '✘ error' }
  return `<span class="status-badge status-${status}" data-testid="run-status" data-status="${status}">${labels[status] ?? status}</span>`
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

// ---------------------------------------------------------------------------
// Dashboard view
// ---------------------------------------------------------------------------

async function renderDashboard() {
  setBreadcrumb('')
  setRoot('<div class="loading-state"><span class="spinner">◌</span> Loading suites&hellip;</div>')

  let data
  try {
    data = await api('/api/suites')
  } catch (err) {
    setRoot(`<div class="error-state">Failed to load suites: ${escapeHtml(err.message)}</div>`)
    return
  }

  const { suites } = data

  if (suites.length === 0) {
    setRoot('<div class="empty-state">No spec files discovered. Check the glob pattern used to start the server.</div>')
    return
  }

  const cards = suites.map(s => {
    const tags = (s.tags || []).map(t => `<span class="badge badge-tag">${escapeHtml(t)}</span>`).join('')
    const errorBadge = s.hasError ? '<span class="badge badge-error">load error</span>' : ''
    const flowBadge = `<span class="badge badge-flow">${s.flowCount} flow${s.flowCount !== 1 ? 's' : ''}</span>`
    return `
      <a class="suite-card" href="/suites/${encodeURIComponent(s.id)}" data-link data-testid="suite-card" data-suite-id="${escapeHtml(s.id)}">
        <div class="suite-card-name">${escapeHtml(s.name)}</div>
        <div class="suite-card-path">${escapeHtml(s.path)}</div>
        <div class="suite-card-meta">${flowBadge}${tags}${errorBadge}</div>
      </a>`
  }).join('\n')

  setRoot(`
    <div>
      <div class="section-header">
        <div>
          <div class="section-title">Spec Suites</div>
          <div class="section-subtitle">${suites.length} suite${suites.length !== 1 ? 's' : ''} discovered</div>
        </div>
      </div>
      <div class="suite-grid" data-testid="suite-list">
        ${cards}
      </div>
    </div>
  `)
}

// ---------------------------------------------------------------------------
// Suite detail view
// ---------------------------------------------------------------------------

async function renderSuiteDetail(id) {
  setBreadcrumb(`<span class="crumb"><a href="/" data-link>Suites</a></span><span class="crumb-sep"> / </span><span class="crumb-current" id="suite-name-crumb">…</span>`)
  setRoot('<div class="loading-state"><span class="spinner">◌</span> Loading suite&hellip;</div>')

  let suite, plan
  try {
    ;[suite, plan] = await Promise.all([
      api(`/api/suites/${encodeURIComponent(id)}`),
      api(`/api/suites/${encodeURIComponent(id)}/plan`),
    ])
  } catch (err) {
    setRoot(`<div class="error-state">${escapeHtml(err.message)}</div>`)
    return
  }

  document.getElementById('suite-name-crumb').textContent = suite.name

  const flowList = suite.flowNames.length
    ? suite.flowNames.map(n => `<li>${escapeHtml(n)}</li>`).join('')
    : '<li class="info-list-empty">none</li>'

  const apiList = suite.apiNames.length
    ? suite.apiNames.map(n => `<li>${escapeHtml(n)}</li>`).join('')
    : '<li class="info-list-empty">none</li>'

  const tagBadges = (suite.tags || []).map(t => `<span class="badge badge-tag">${escapeHtml(t)}</span>`).join('')

  const safetyLabel = suite.safety
    ? `<span class="badge badge-flow">${escapeHtml(suite.safety)}</span>`
    : ''

  const validationHtml = renderValidationBlock(plan.validation)

  const planSteps = (plan.steps || []).map((s, i) => {
    const section = s.section ? `<div class="plan-step-section">${escapeHtml(s.section)}</div>` : ''
    const actionClass = `action-${s.actionType}`
    return `
      <div class="plan-step" data-testid="plan-step">
        <div class="plan-step-num">${i + 1}</div>
        <div class="plan-step-body">
          <div class="plan-step-name">${escapeHtml(s.name)}</div>
          <div class="plan-step-action ${actionClass}">${escapeHtml(s.actionSummary)}</div>
          ${section}
        </div>
      </div>`
  }).join('\n')

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

      ${validationHtml}

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
}

function renderValidationBlock(validation) {
  if (!validation) return ''
  const { errors = [], warnings = [] } = validation

  if (errors.length === 0 && warnings.length === 0) {
    return '<div class="validation-block valid">✔ Validation passed</div>'
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

  const cls = errors.length > 0 ? 'has-errors' : 'has-warnings'
  return `<div class="validation-block ${cls}">${errorItems}${warnItems}</div>`
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

// ---------------------------------------------------------------------------
// Run view
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
    run = await api(`/api/runs/${id}`)
  } catch (err) {
    setRoot(`<div class="error-state">${escapeHtml(err.message)}</div>`)
    return
  }

  renderRun(run)

  if (run.status === 'pending' || run.status === 'running') {
    pollTimer = setInterval(async () => {
      try {
        const updated = await api(`/api/runs/${id}`)
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
  const suiteLink = `<a href="/suites/${encodeURIComponent(run.suiteId)}" data-link>${escapeHtml(run.suiteName)}</a>`

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

  const stepsHtml = (run.flows || []).flatMap(f => f.steps).map(s => {
    const statusIcon = {
      pass:  '<span class="step-icon step-icon-pass">✔</span>',
      fail:  '<span class="step-icon step-icon-fail">✘</span>',
      skip:  '<span class="step-icon step-icon-skip">○</span>',
    }[s.status] || '<span class="step-icon step-icon-pending">◌</span>'

    const section = s.section ? `<div class="run-step-section">${escapeHtml(s.section)}</div>` : ''
    const errHtml = s.error ? `<div class="run-step-error">${escapeHtml(s.error)}</div>` : ''
    const dur = s.durationMs !== null && s.durationMs !== undefined ? durationLabel(s.durationMs) : ''

    return `
      <div class="run-step is-${s.status}" data-testid="step-result" data-status="${escapeHtml(s.status || '')}">
        ${statusIcon}
        <div class="run-step-body">
          <div class="run-step-name">${escapeHtml(s.name)}</div>
          ${section}
          ${errHtml}
        </div>
        <div class="run-step-dur">${escapeHtml(dur)}</div>
      </div>`
  }).join('\n')

  root.innerHTML = `
    <div class="run-view">
      <div class="run-header">
        <div>
          <div class="run-title">Run: ${suiteLink}</div>
          <div class="run-meta">
            ${statusBadge(run.status)}
            <span>${new Date(run.startedAt).toLocaleString()}</span>
          </div>
        </div>
      </div>

      ${progressHtml}
      ${errorHtml}
      ${validationHtml}

      ${stepsHtml
        ? `<div class="run-steps-list">${stepsHtml}</div>`
        : (run.status === 'pending' || run.status === 'running')
          ? '<div class="loading-state"><span class="spinner">◌</span> Waiting for steps&hellip;</div>'
          : ''}
    </div>
  `
}

// ---------------------------------------------------------------------------
// Router entry point
// ---------------------------------------------------------------------------

function render(path) {
  stopPolling()

  const suiteMatch = path.match(/^\/suites\/([^/]+)\/?$/)
  const runMatch   = path.match(/^\/runs\/([^/]+)\/?$/)

  if (suiteMatch) {
    const id = decodeURIComponent(suiteMatch[1])
    renderSuiteDetail(id)
  } else if (runMatch) {
    const id = decodeURIComponent(runMatch[1])
    renderRunView(id)
  } else {
    renderDashboard()
  }
}

// Boot
render(location.pathname)
