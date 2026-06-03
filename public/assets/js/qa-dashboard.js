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
