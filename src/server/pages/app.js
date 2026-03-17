// Ortheon Server SPA
// Vanilla JS, History API routing, four views: dashboard / suite-detail / contract-detail / contract-list
//
// Sections:
//  1. Router
//  2. API helpers
//  3. Render primitives
//  4. Grouping utilities
//  5. Dashboard – Suites view
//  6. Dashboard – Contracts list view
//  7. Suite detail view
//  8. Contract detail view

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

// ---------------------------------------------------------------------------
// 3. Render primitives
// ---------------------------------------------------------------------------

const root = document.getElementById('root')
const breadcrumb = document.getElementById('breadcrumb')

function setRoot(html) { root.innerHTML = html }
function setBreadcrumb(html) { breadcrumb.innerHTML = html }

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function methodBadge(method) {
  return `<span class="method-badge method-${method.toLowerCase()}">${escapeHtml(method)}</span>`
}

function renderTabBar(activeTab) {
  return `
    <div class="tab-bar">
      <a class="tab${activeTab === 'suites' ? ' active' : ''}" href="/" data-link data-testid="suites-tab">Suites</a>
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
// 4. Grouping utilities
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
// 5. Dashboard – Suites view
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

        return `
          <a class="suite-card" href="/suites/${encodeURIComponent(s.id)}" data-link data-testid="suite-card" data-suite-id="${escapeHtml(s.id)}">
            <div class="suite-card-name">${escapeHtml(s.name)}</div>
            <div class="suite-card-path">${escapeHtml(s.path)}</div>
            <div class="suite-card-meta">${flowBadge}${tags}${errorBadge}</div>
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
// 6. Dashboard – Contracts list view
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
// 7. Suite detail view
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

  // CLI command and plan artifact info
  const serverOrigin = window.location.origin
  const executionPlanUrl = `${serverOrigin}/api/suites/${encodeURIComponent(id)}/execution-plan`
  const cliCommand = `ortheon run --from ${serverOrigin} --suite ${id}`

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

      <div class="info-card" style="margin-bottom: 24px;" data-testid="cli-launcher">
        <div class="info-card-label">Run via CLI</div>
        <div class="cli-command-block" data-testid="cli-command">
          <code>${escapeHtml(cliCommand)}</code>
          <button class="btn btn-secondary btn-sm copy-btn" data-copy="${escapeHtml(cliCommand)}" title="Copy to clipboard">Copy</button>
        </div>
        <div class="cli-links" style="margin-top: 8px; display: flex; gap: 12px; align-items: center;">
          <span style="font-size: 12px; color: var(--muted);">Suite ID: <code style="font-family: var(--mono)">${escapeHtml(id)}</code></span>
          <a href="${escapeHtml(executionPlanUrl)}" target="_blank" class="btn btn-secondary btn-sm" data-testid="download-plan-link">Download plan JSON</a>
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

  // Wire up copy buttons
  root.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.getAttribute('data-copy')
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent
        btn.textContent = 'Copied!'
        setTimeout(() => { btn.textContent = orig }, 1500)
      }).catch(() => {})
    })
  })

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

// ---------------------------------------------------------------------------
// 8. Contract detail view
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
// Router entry point
// ---------------------------------------------------------------------------

function render(path) {
  if (_searchDebounceTimer !== null) {
    clearTimeout(_searchDebounceTimer)
    _searchDebounceTimer = null
  }
  _allSuites = null
  _activeTag = null

  const suiteMatch    = path.match(/^\/suites\/([^/]+)\/?$/)
  const contractMatch = path.match(/^\/contracts\/([^/]+)\/?$/)

  if (suiteMatch) {
    const id = decodeURIComponent(suiteMatch[1])
    renderSuiteDetail(id)
  } else if (contractMatch) {
    const name = decodeURIComponent(contractMatch[1])
    renderContractDetail(name)
  } else if (path === '/contracts') {
    renderContractsList()
  } else {
    renderDashboard()
  }
}

render(location.pathname)
