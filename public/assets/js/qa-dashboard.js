// ═══════════════════════════════════════════════════════
//  DASHBOARD GENERAL (KPIs + Resúmenes)
// ═══════════════════════════════════════════════════════

const els = {
  updatedAt:           document.getElementById('updatedAt'),
  refreshBtn:          document.getElementById('refreshBtn'),
  stateMessage:        document.getElementById('stateMessage'),
  warningsPanel:       document.getElementById('warningsPanel'),
  warningsList:        document.getElementById('warningsList'),
  totalIssues:         document.getElementById('totalIssues'),
  totalBugs:           document.getElementById('totalBugs'),
  openBugs:            document.getElementById('openBugs'),
  closedBugs:          document.getElementById('closedBugs'),
  closureRate:         document.getElementById('closureRate'),
  avgResolutionDays:   document.getElementById('avgResolutionDays'),
  openBugAgingAvgDays: document.getElementById('openBugAgingAvgDays'),
  byStatusBody:        document.getElementById('byStatusBody'),
  byPriorityBody:      document.getElementById('byPriorityBody'),
  byIssueTypeBody:     document.getElementById('byIssueTypeBody'),
};

const formatter    = new Intl.NumberFormat('es-EC');
const dateFormatter = new Intl.DateTimeFormat('es-EC', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function setState(message, type = '') {
  els.stateMessage.textContent = message;
  els.stateMessage.className = `state-message ${type}`.trim();
}
function hideState() {
  els.stateMessage.className = 'state-message hidden';
}
function formatNumber(value) {
  return formatter.format(Number(value) || 0);
}
function formatDays(value) {
  return `${formatter.format(Number(value) || 0)} días`;
}
function formatDate(value) {
  if (!value) return 'Sin datos';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Sin datos' : dateFormatter.format(d);
}

function renderWarnings(warnings = []) {
  els.warningsList.innerHTML = '';
  if (!warnings.length) { els.warningsPanel.classList.add('hidden'); return; }
  for (const w of warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    els.warningsList.appendChild(li);
  }
  els.warningsPanel.classList.remove('hidden');
}

function renderTable(tbody, rows, labelKey) {
  tbody.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2; td.textContent = 'Sin datos';
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  for (const row of rows) {
    const tr    = document.createElement('tr');
    const label = document.createElement('td');
    const count = document.createElement('td');
    label.textContent = row[labelKey] || 'Sin dato';
    count.textContent = formatNumber(row.count);
    tr.append(label, count);
    tbody.appendChild(tr);
  }
}

function renderTotals(t) {
  els.totalIssues.textContent         = formatNumber(t.totalIssues);
  els.totalBugs.textContent           = formatNumber(t.totalBugs);
  els.openBugs.textContent            = formatNumber(t.openBugs);
  els.closedBugs.textContent          = formatNumber(t.closedBugs);
  els.closureRate.textContent         = `${formatNumber(t.closureRate)}%`;
  els.avgResolutionDays.textContent   = formatDays(t.avgResolutionDays);
  els.openBugAgingAvgDays.textContent = formatDays(t.openBugAgingAvgDays);
}

function renderDashboard(data) {
  const totals = data.totals || {};
  els.updatedAt.textContent = formatDate(data.updatedAt);
  renderTotals(totals);
  renderTable(els.byStatusBody,    data.byStatus    || [], 'status');
  renderTable(els.byPriorityBody,  data.byPriority  || [], 'priority');
  renderTable(els.byIssueTypeBody, data.byIssueType || [], 'issueType');
  renderWarnings(data.warnings || []);
  if (!totals.totalIssues) {
    setState('No existen datos cargados todavía. Sube un CSV de Jira desde la pantalla principal.', '');
    return;
  }
  hideState();
}

async function loadDashboard() {
  els.refreshBtn.disabled = true;
  setState('Cargando dashboard QA...');
  try {
    const res  = await fetch('/api/qa-dashboard');
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`Respuesta no es JSON: ${text.slice(0, 200)}`); }
    if (!res.ok || !data.ok) throw new Error(data.error || 'No se pudo cargar el dashboard QA.');
    renderDashboard(data);
  } catch (err) {
    setState(`Error backend: ${err.message || String(err)}`, 'error');
    renderWarnings([]);
  } finally {
    els.refreshBtn.disabled = false;
  }
}

els.refreshBtn.addEventListener('click', loadDashboard);
loadDashboard();

// ═══════════════════════════════════════════════════════
//  DASHBOARD DE DELTAS
// ═══════════════════════════════════════════════════════

let allDeltas = [];

const dEl = {
  filterDomain:        document.getElementById('dFilterDomain'),
  filterDelta:         document.getElementById('dFilterDelta'),
  filterStatus:        document.getElementById('dFilterStatus'),
  deltasBody:          document.getElementById('deltasBody'),
  stateMsg:            document.getElementById('deltasStateMsg'),
  warningsPanel:       document.getElementById('deltasWarningsPanel'),
  warningsList:        document.getElementById('deltasWarningsList'),
  kpiTotalDeltas:      document.getElementById('dKpiTotalDeltas'),
  kpiTotalCards:       document.getElementById('dKpiTotalCards'),
  kpiCompleted:        document.getElementById('dKpiCompleted'),
  kpiInProgress:       document.getElementById('dKpiInProgress'),
  kpiAvgProgress:      document.getElementById('dKpiAvgProgress'),
  snapshotDate:        document.getElementById('deltasSnapshotDate'),
};

// ── Utilities ──────────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function progressClass(pct) {
  if (pct >= 80) return 'progress-high';
  if (pct >= 50) return 'progress-medium';
  return 'progress-low';
}

// ── Warnings ───────────────────────────────────────────

function renderDeltasWarnings(warnings) {
  dEl.warningsList.innerHTML = '';
  if (!warnings || !warnings.length) {
    dEl.warningsPanel.classList.add('hidden');
    return;
  }
  for (const w of warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    dEl.warningsList.appendChild(li);
  }
  dEl.warningsPanel.classList.remove('hidden');
}

// ── KPIs ───────────────────────────────────────────────

function renderDeltasKpis(deltas) {
  const totalCards  = deltas.reduce((s, d) => s + d.totalCards,     0);
  const completed   = deltas.reduce((s, d) => s + d.completedCards, 0);
  const inProgress  = deltas.reduce((s, d) => s + d.inProgressCards,0);
  const avgProgress = deltas.length
    ? Math.round(deltas.reduce((s, d) => s + d.progressPercent, 0) / deltas.length * 100) / 100
    : 0;

  dEl.kpiTotalDeltas.textContent = deltas.length;
  dEl.kpiTotalCards.textContent  = formatNumber(totalCards);
  dEl.kpiCompleted.textContent   = formatNumber(completed);
  dEl.kpiInProgress.textContent  = formatNumber(inProgress);
  dEl.kpiAvgProgress.textContent = `${avgProgress}%`;
}

// ── Filters ────────────────────────────────────────────

function populateDomainFilter(deltas) {
  const current = dEl.filterDomain.value;

  // Collect unique domains; sort alphabetically, "Sin clasificar" always last
  const allDomains = [...new Set(deltas.map((d) => d.domain))];
  const domains = allDomains
    .filter((d) => d !== 'Sin clasificar')
    .sort((a, b) => a.localeCompare(b, 'es'));
  if (allDomains.includes('Sin clasificar')) domains.push('Sin clasificar');

  dEl.filterDomain.innerHTML = '<option value="">Todos</option>';
  for (const dom of domains) {
    const opt = document.createElement('option');
    opt.value = dom; opt.textContent = dom;
    dEl.filterDomain.appendChild(opt);
  }
  if ([...dEl.filterDomain.options].some((o) => o.value === current)) {
    dEl.filterDomain.value = current;
  }
}

function populateDeltaFilter(deltas) {
  const current = dEl.filterDelta.value;
  dEl.filterDelta.innerHTML = '<option value="">Todas</option>';
  for (const d of deltas) {
    const opt = document.createElement('option');
    opt.value = d.epicKey;
    opt.textContent = `${d.epicKey} — ${d.epicSummary}`;
    dEl.filterDelta.appendChild(opt);
  }
  if ([...dEl.filterDelta.options].some((o) => o.value === current)) {
    dEl.filterDelta.value = current;
  }
}

// ── Child detail table ─────────────────────────────────

function buildChildDetail(childIssues) {
  const wrap = document.createElement('div');
  wrap.className = 'child-table-wrap';
  if (!childIssues || !childIssues.length) {
    wrap.textContent = 'Esta épica no tiene issues asociadas.';
    return wrap;
  }
  const table = document.createElement('table');
  table.className = 'child-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Key</th><th>Tipo</th><th>Resumen</th><th>Estado</th><th>Responsable</th>
      </tr>
    </thead>`;
  const tbody = document.createElement('tbody');
  for (const issue of childIssues) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${escapeHtml(issue.key)}</code></td>
      <td>${escapeHtml(issue.type)}</td>
      <td>${escapeHtml(issue.summary)}</td>
      <td>${escapeHtml(issue.status)}</td>
      <td>${escapeHtml(issue.assignee || '—')}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ── Table render ───────────────────────────────────────

function renderDeltasTable(deltas) {
  const tbody = dEl.deltasBody;
  tbody.innerHTML = '';

  renderDeltasKpis(deltas);

  if (!deltas.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.textContent = 'No se encontraron Deltas para los filtros seleccionados.';
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }

  for (const delta of deltas) {
    const pct    = delta.progressPercent;
    const pClass = progressClass(pct);

    // Main row
    const tr = document.createElement('tr');
    tr.className = 'delta-row';

    const tdDomain = document.createElement('td');
    tdDomain.innerHTML = `<span class="domain-badge">${escapeHtml(delta.domain)}</span>`;

    const tdDelta = document.createElement('td');
    tdDelta.className = 'epic-cell-td';
    tdDelta.innerHTML = `
      <div class="epic-cell">
        <button class="expand-btn" aria-expanded="false" aria-label="Expandir detalle">&#9654;</button>
        <div class="epic-text">
          <span class="epic-key">${escapeHtml(delta.epicKey)}</span>
          <span class="epic-summary" title="${escapeHtml(delta.epicSummary)}">${escapeHtml(delta.epicSummary)}</span>
        </div>
      </div>`;

    const tdNum = (val) => {
      const t = document.createElement('td');
      t.className = 'num'; t.textContent = val; return t;
    };

    const tdProgress = document.createElement('td');
    tdProgress.className = 'progress-cell';
    tdProgress.innerHTML = `
      <div class="progress-bar-wrap">
        <div class="progress-bar ${pClass}" style="width:${Math.min(100, pct)}%"></div>
      </div>
      <span class="progress-label">${pct}%</span>`;

    tr.append(
      tdDomain, tdDelta,
      tdNum(delta.totalCards), tdNum(delta.completedCards),
      tdNum(delta.inProgressCards), tdNum(delta.pendingCards),
      tdNum(delta.blockedCards), tdProgress
    );
    tbody.appendChild(tr);

    // Detail row (hidden by default)
    const detailTr = document.createElement('tr');
    detailTr.className = 'delta-detail-row hidden';
    const detailTd = document.createElement('td');
    detailTd.colSpan = 8;
    detailTd.className = 'detail-cell';
    detailTd.appendChild(buildChildDetail(delta.childIssues));
    detailTr.appendChild(detailTd);
    tbody.appendChild(detailTr);

    // Toggle expand/collapse
    tdDelta.querySelector('.expand-btn').addEventListener('click', () => {
      const btn      = tdDelta.querySelector('.expand-btn');
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!expanded));
      btn.textContent = expanded ? '\u25B6' : '\u25BC';
      detailTr.classList.toggle('hidden', expanded);
    });
  }
}

// ── Status filter — uses computed counters, NOT a textual status field ─────

function matchesDeltaStatusFilter(delta, selectedStatus) {
  if (!selectedStatus || selectedStatus === 'Todos') return true;

  const totalCards      = Number(delta.totalCards      || 0);
  const completedCards  = Number(delta.completedCards  || 0);
  const inProgressCards = Number(delta.inProgressCards || 0);
  const pendingCards    = Number(delta.pendingCards    || 0);
  const blockedCards    = Number(delta.blockedCards    || 0);
  const progressPercent = Number(delta.progressPercent || 0);

  let result;
  if (selectedStatus === 'Finalizados')      result = completedCards > 0;
  else if (selectedStatus === 'En progreso') result = inProgressCards > 0;
  else if (selectedStatus === 'Pendientes')  result = pendingCards > 0;
  else if (selectedStatus === 'Bloqueados')  result = blockedCards > 0;
  else if (selectedStatus === 'Completados 100%') result = totalCards > 0 && progressPercent === 100;
  else if (selectedStatus === 'Sin avance')  result = totalCards > 0 && completedCards === 0 && inProgressCards === 0;
  else if (selectedStatus === 'Avance parcial') result = progressPercent > 0 && progressPercent < 100;
  else result = true;

  // Debug log — remove after validation
  console.log('DELTA_STATUS_FILTER_DEBUG', {
    selectedStatus,
    epicKey: delta.epicKey,
    completedCards,
    inProgressCards,
    pendingCards,
    blockedCards,
    progressPercent,
    result,
  });

  return result;
}

// ── Filter + render ────────────────────────────────────

function filterAndRenderDeltas() {
  const domain = dEl.filterDomain.value;
  const key    = dEl.filterDelta.value;
  const status = dEl.filterStatus.value;

  let filtered = allDeltas;
  if (domain) filtered = filtered.filter((d) => d.domain === domain);
  if (key)    filtered = filtered.filter((d) => d.epicKey === key);
  filtered = filtered.filter((d) => matchesDeltaStatusFilter(d, status));

  renderDeltasTable(filtered);
}

// ── Load from API ──────────────────────────────────────

async function loadDeltas() {
  dEl.stateMsg.textContent = 'Cargando análisis de Deltas...';
  dEl.stateMsg.className   = 'state-message';

  try {
    const res  = await fetch('/api/qa-deltas');
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`Respuesta no es JSON: ${text.slice(0, 200)}`); }

    if (!data.ok) {
      dEl.stateMsg.textContent = data.error || 'Error al cargar Deltas.';
      dEl.stateMsg.className   = 'state-message error';
      renderDeltasWarnings([]);
      return;
    }

    allDeltas = data.deltas || [];

    if (dEl.snapshotDate) dEl.snapshotDate.textContent = formatDate(data.snapshotDate);

    populateDomainFilter(allDeltas);
    populateDeltaFilter(allDeltas);
    filterAndRenderDeltas();
    renderDeltasWarnings(data.warnings || []);

    dEl.stateMsg.className = 'state-message hidden';
  } catch (err) {
    dEl.stateMsg.textContent = `Error al cargar Deltas: ${err.message || String(err)}`;
    dEl.stateMsg.className   = 'state-message error';
  }
}

// ── Event listeners ────────────────────────────────────

dEl.filterDomain.addEventListener('change', () => {
  const dom          = dEl.filterDomain.value;
  const scopedDeltas = dom ? allDeltas.filter((d) => d.domain === dom) : allDeltas;
  populateDeltaFilter(scopedDeltas);
  filterAndRenderDeltas();
});
dEl.filterDelta.addEventListener('change', filterAndRenderDeltas);
dEl.filterStatus.addEventListener('change', filterAndRenderDeltas);

loadDeltas();
