const els = {
  updatedAt: document.getElementById('updatedAt'),
  refreshBtn: document.getElementById('refreshBtn'),
  stateMessage: document.getElementById('stateMessage'),
  warningsPanel: document.getElementById('warningsPanel'),
  warningsList: document.getElementById('warningsList'),
  totalIssues: document.getElementById('totalIssues'),
  totalBugs: document.getElementById('totalBugs'),
  openBugs: document.getElementById('openBugs'),
  closedBugs: document.getElementById('closedBugs'),
  closureRate: document.getElementById('closureRate'),
  avgResolutionDays: document.getElementById('avgResolutionDays'),
  openBugAgingAvgDays: document.getElementById('openBugAgingAvgDays'),
  byStatusBody: document.getElementById('byStatusBody'),
  byPriorityBody: document.getElementById('byPriorityBody'),
  byIssueTypeBody: document.getElementById('byIssueTypeBody'),
};

const formatter = new Intl.NumberFormat('es-EC');
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
  const number = Number(value) || 0;
  return `${formatter.format(number)} días`;
}

function formatDate(value) {
  if (!value) return 'Sin datos';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin datos';
  return dateFormatter.format(date);
}

function renderWarnings(warnings = []) {
  els.warningsList.innerHTML = '';

  if (!warnings.length) {
    els.warningsPanel.classList.add('hidden');
    return;
  }

  for (const warning of warnings) {
    const li = document.createElement('li');
    li.textContent = warning;
    els.warningsList.appendChild(li);
  }

  els.warningsPanel.classList.remove('hidden');
}

function renderTable(tbody, rows, labelKey) {
  tbody.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2;
    td.textContent = 'Sin datos';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const tr = document.createElement('tr');
    const label = document.createElement('td');
    const count = document.createElement('td');

    label.textContent = row[labelKey] || 'Sin dato';
    count.textContent = formatNumber(row.count);

    tr.append(label, count);
    tbody.appendChild(tr);
  }
}

function renderTotals(totals) {
  els.totalIssues.textContent = formatNumber(totals.totalIssues);
  els.totalBugs.textContent = formatNumber(totals.totalBugs);
  els.openBugs.textContent = formatNumber(totals.openBugs);
  els.closedBugs.textContent = formatNumber(totals.closedBugs);
  els.closureRate.textContent = `${formatNumber(totals.closureRate)}%`;
  els.avgResolutionDays.textContent = formatDays(totals.avgResolutionDays);
  els.openBugAgingAvgDays.textContent = formatDays(totals.openBugAgingAvgDays);
}

function renderDashboard(data) {
  const totals = data.totals || {};

  els.updatedAt.textContent = formatDate(data.updatedAt);
  renderTotals({
    totalIssues: totals.totalIssues,
    totalBugs: totals.totalBugs,
    openBugs: totals.openBugs,
    closedBugs: totals.closedBugs,
    closureRate: totals.closureRate,
    avgResolutionDays: totals.avgResolutionDays,
    openBugAgingAvgDays: totals.openBugAgingAvgDays,
  });

  renderTable(els.byStatusBody, data.byStatus || [], 'status');
  renderTable(els.byPriorityBody, data.byPriority || [], 'priority');
  renderTable(els.byIssueTypeBody, data.byIssueType || [], 'issueType');
  renderWarnings(data.warnings || []);

  if (!totals.totalIssues) {
    setState('No existen datos cargados todavía. Sube un CSV de Jira desde la pantalla principal para alimentar el dashboard.', '');
    return;
  }

  hideState();
}

async function loadDashboard() {
  els.refreshBtn.disabled = true;
  setState('Cargando dashboard QA...');

  try {
    const res = await fetch('/api/qa-dashboard');
    const text = await res.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Respuesta no es JSON: ${text.slice(0, 200)}`);
    }

    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'No se pudo cargar el dashboard QA.');
    }

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

// ─── Seguimiento de Deltas por Equipo ────────────────────────────────────────

let allDeltas = [];
let allTeams  = [];

const deltasEls = {
  filterTeam:          document.getElementById('filterTeam'),
  filterEpic:          document.getElementById('filterEpic'),
  deltasBody:          document.getElementById('deltasBody'),
  deltasStateMessage:  document.getElementById('deltasStateMessage'),
  deltasWarningsPanel: document.getElementById('deltasWarningsPanel'),
  deltasWarningsList:  document.getElementById('deltasWarningsList'),
};

// Escapa caracteres HTML para prevenir XSS al insertar texto en el DOM.
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function progressClass(percent) {
  if (percent >= 80) return 'progress-high';
  if (percent >= 50) return 'progress-medium';
  return 'progress-low';
}

function renderDeltasWarnings(warnings) {
  deltasEls.deltasWarningsList.innerHTML = '';
  if (!warnings.length) {
    deltasEls.deltasWarningsPanel.classList.add('hidden');
    return;
  }
  for (const w of warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    deltasEls.deltasWarningsList.appendChild(li);
  }
  deltasEls.deltasWarningsPanel.classList.remove('hidden');
}

function buildChildTable(childCards) {
  const wrap = document.createElement('div');
  wrap.className = 'child-table-wrap';

  if (!childCards || !childCards.length) {
    wrap.textContent = 'Esta épica no tiene cards directas asociadas.';
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'child-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Key</th>
        <th>Resumen</th>
        <th>Tipo</th>
        <th>Estado</th>
        <th>Responsable</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');
  for (const card of childCards) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${escapeHtml(card.key)}</code></td>
      <td>${escapeHtml(card.summary)}</td>
      <td>${escapeHtml(card.type)}</td>
      <td>${escapeHtml(card.status)}</td>
      <td>${escapeHtml(card.assignee || 'Sin asignar')}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderDeltasTable(deltas) {
  const tbody = deltasEls.deltasBody;
  tbody.innerHTML = '';

  if (!deltas.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.textContent = 'No se encontraron Deltas/Épicas para los filtros seleccionados.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const delta of deltas) {
    const pct    = delta.progressPercent;
    const pClass = progressClass(pct);

    // ── Fila principal ──
    const tr = document.createElement('tr');
    tr.className = 'delta-row';

    // Celda equipo
    const tdTeam = document.createElement('td');
    tdTeam.textContent = delta.team;

    // Celda épica con botón expand
    const tdEpic = document.createElement('td');
    tdEpic.className = 'epic-cell-td';
    tdEpic.innerHTML = `
      <div class="epic-cell">
        <button class="expand-btn" aria-expanded="false" aria-label="Ver detalle">&#9654;</button>
        <span class="epic-key">${escapeHtml(delta.epicKey)}</span>
        <span class="epic-summary">${escapeHtml(delta.epicSummary)}</span>
      </div>`;

    // Helper para celdas numéricas
    const tdNum = (val) => {
      const t = document.createElement('td');
      t.className = 'num';
      t.textContent = val;
      return t;
    };

    // Celda barra de progreso
    const tdProgress = document.createElement('td');
    tdProgress.className = 'progress-cell';
    tdProgress.innerHTML = `
      <div class="progress-bar-wrap">
        <div class="progress-bar ${pClass}" style="width:${Math.min(100, pct)}%"></div>
      </div>
      <span class="progress-label">${pct}%</span>`;

    tr.append(
      tdTeam,
      tdEpic,
      tdNum(delta.totalCards),
      tdNum(delta.completedCards),
      tdNum(delta.inProgressCards),
      tdNum(delta.pendingCards),
      tdNum(delta.blockedCards),
      tdProgress
    );
    tbody.appendChild(tr);

    // ── Fila de detalle (oculta por defecto) ──
    const detailTr = document.createElement('tr');
    detailTr.className = 'delta-detail-row hidden';

    const detailTd = document.createElement('td');
    detailTd.colSpan = 8;
    detailTd.className = 'detail-cell';
    detailTd.appendChild(buildChildTable(delta.childCards));
    detailTr.appendChild(detailTd);
    tbody.appendChild(detailTr);

    // Toggle expand/collapse
    const expandBtn = tdEpic.querySelector('.expand-btn');
    expandBtn.addEventListener('click', () => {
      const expanded = expandBtn.getAttribute('aria-expanded') === 'true';
      expandBtn.setAttribute('aria-expanded', String(!expanded));
      expandBtn.textContent = expanded ? '\u25B6' : '\u25BC';
      detailTr.classList.toggle('hidden', expanded);
    });
  }
}

function populateEpicFilter(deltas) {
  const currentVal = deltasEls.filterEpic.value;
  deltasEls.filterEpic.innerHTML = '<option value="">Todas</option>';
  for (const delta of deltas) {
    const opt = document.createElement('option');
    opt.value = delta.epicKey;
    opt.textContent = `${delta.epicKey} — ${delta.epicSummary}`;
    deltasEls.filterEpic.appendChild(opt);
  }
  // Restaurar selección si sigue siendo válida
  const stillValid = [...deltasEls.filterEpic.options].some((o) => o.value === currentVal);
  if (stillValid) deltasEls.filterEpic.value = currentVal;
}

function populateTeamFilter(teams) {
  deltasEls.filterTeam.innerHTML = '<option value="">Todos</option>';
  for (const team of teams) {
    const opt = document.createElement('option');
    opt.value = team;
    opt.textContent = team;
    deltasEls.filterTeam.appendChild(opt);
  }
}

function filterAndRenderDeltas() {
  const teamFilter = deltasEls.filterTeam.value;
  const epicFilter = deltasEls.filterEpic.value;

  let filtered = allDeltas;
  if (teamFilter) filtered = filtered.filter((d) => d.team === teamFilter);
  if (epicFilter) filtered = filtered.filter((d) => d.epicKey === epicFilter);

  renderDeltasTable(filtered);
}

async function loadDeltas() {
  deltasEls.deltasStateMessage.textContent = 'Cargando análisis de Deltas...';
  deltasEls.deltasStateMessage.className = 'state-message';

  try {
    const res  = await fetch('/api/qa-deltas');
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Respuesta no es JSON: ${text.slice(0, 200)}`);
    }

    if (!data.ok) {
      deltasEls.deltasStateMessage.textContent =
        data.error || 'No se pudo calcular el análisis de Deltas.';
      deltasEls.deltasStateMessage.className = 'state-message error';
      renderDeltasWarnings([]);
      return;
    }

    allDeltas = data.deltas || [];
    allTeams  = data.teams  || [];

    populateTeamFilter(allTeams);
    populateEpicFilter(allDeltas);
    filterAndRenderDeltas();
    renderDeltasWarnings(data.warnings || []);

    deltasEls.deltasStateMessage.className = 'state-message hidden';
  } catch (err) {
    deltasEls.deltasStateMessage.textContent = `Error al cargar Deltas: ${err.message || String(err)}`;
    deltasEls.deltasStateMessage.className = 'state-message error';
  }
}

// Listeners de filtros
deltasEls.filterTeam.addEventListener('change', () => {
  const teamFilter = deltasEls.filterTeam.value;
  const scopedDeltas = teamFilter
    ? allDeltas.filter((d) => d.team === teamFilter)
    : allDeltas;
  populateEpicFilter(scopedDeltas);
  filterAndRenderDeltas();
});

deltasEls.filterEpic.addEventListener('change', filterAndRenderDeltas);

// Cargar Deltas al iniciar la página
loadDeltas();
