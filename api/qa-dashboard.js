import { withClient } from './_db.js';

const EMPTY_TOTALS = {
  totalIssues: 0,
  totalBugs: 0,
  openBugs: 0,
  closedBugs: 0,
  closureRate: 0,
  avgResolutionDays: 0,
  openBugAgingAvgDays: 0,
};

const COLUMN_CANDIDATES = {
  issueType: [
    'tipo_de_incidente',
    'tipo_de_incidencia',
    'issue_type',
    'issuetype',
    'tipo',
    'type',
  ],
  status: ['estado', 'status'],
  priority: ['prioridad', 'priority'],
  createdAt: [
    'fecha_creacion',
    'fecha_de_creacion',
    'created',
    'created_date',
    'fecha_creado',
    'fecha_reporte',
    'fecha_de_reporte',
    'fecha_inicio_real',
    'fecha_de_inicio',
    'start_date',
  ],
  closedAt: [
    'fecha_cierre',
    'fecha_de_cierre',
    'fecha_resolucion',
    'fecha_de_resolucion',
    'resolved',
    'resolution_date',
    'fecha_cierre_real',
    'close_date',
  ],
  uploadedAt: ['uploaded_at'],
};

function quoteIdent(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function pickColumn(tableColumns, candidates) {
  return candidates.find((candidate) => tableColumns.has(candidate)) || null;
}

function columnExpr(column) {
  return column ? `NULLIF(TRIM(${quoteIdent(column)}::text), '')` : 'NULL';
}

function bugCondition(issueTypeColumn) {
  if (!issueTypeColumn) return 'FALSE';
  const expr = `COALESCE(${quoteIdent(issueTypeColumn)}::text, '')`;
  return `(
    ${expr} ILIKE '%bug%'
    OR ${expr} ILIKE '%defecto%'
    OR ${expr} ILIKE '%error%'
    OR ${expr} ILIKE '%incidente%'
  )`;
}

function closedCondition(statusColumn) {
  if (!statusColumn) return 'FALSE';
  const expr = `COALESCE(${quoteIdent(statusColumn)}::text, '')`;
  return `(
    ${expr} ILIKE '%cerrado%'
    OR ${expr} ILIKE '%cerrada%'
    OR ${expr} ILIKE '%closed%'
    OR ${expr} ILIKE '%done%'
    OR ${expr} ILIKE '%resuelto%'
    OR ${expr} ILIKE '%resolved%'
    OR ${expr} ILIKE '%finalizado%'
    OR ${expr} ILIKE '%finalizada%'
  )`;
}

function dateExpr(column) {
  if (!column) return 'NULL::timestamp';
  const value = `NULLIF(${quoteIdent(column)}::text, '')`;
  return `CASE
    WHEN ${value} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN ${value}::timestamp
    WHEN ${value} ~ '^\\d{1,2}/\\d{1,2}/\\d{4}' THEN to_timestamp(${value}, 'DD/MM/YYYY HH24:MI:SS')::timestamp
    ELSE NULL::timestamp
  END`;
}

function roundNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function toCountRows(rows, labelKey) {
  return rows.map((row) => ({
    [labelKey]: row[labelKey] || 'Sin dato',
    count: Number(row.count) || 0,
  }));
}

async function groupedCount(client, column, labelKey) {
  if (!column) return [];

  const { rows } = await client.query(`
    SELECT COALESCE(${columnExpr(column)}, 'Sin dato') AS ${quoteIdent(labelKey)}, COUNT(*)::int AS count
    FROM public.raw_jira
    GROUP BY 1
    ORDER BY count DESC, ${quoteIdent(labelKey)} ASC
  `);

  return toCountRows(rows, labelKey);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const result = await withClient(async (client) => {
      const { rows: columnRows } = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'raw_jira'
      `);

      const tableColumns = new Set(columnRows.map((row) => row.column_name));
      const warnings = [];

      if (tableColumns.size === 0) {
        return {
          ok: true,
          updatedAt: new Date().toISOString(),
          totals: EMPTY_TOTALS,
          byStatus: [],
          byPriority: [],
          byIssueType: [],
          warnings: ['No se encontró la tabla public.raw_jira o no tiene columnas disponibles.'],
        };
      }

      const columns = {
        issueType: pickColumn(tableColumns, COLUMN_CANDIDATES.issueType),
        status: pickColumn(tableColumns, COLUMN_CANDIDATES.status),
        priority: pickColumn(tableColumns, COLUMN_CANDIDATES.priority),
        createdAt: pickColumn(tableColumns, COLUMN_CANDIDATES.createdAt),
        closedAt: pickColumn(tableColumns, COLUMN_CANDIDATES.closedAt),
        uploadedAt: pickColumn(tableColumns, COLUMN_CANDIDATES.uploadedAt),
      };

      for (const [key, column] of Object.entries(columns)) {
        if (!column && key !== 'uploadedAt') {
          warnings.push(`No se encontró columna para ${key}.`);
        }
      }

      const bugSql = bugCondition(columns.issueType);
      const closedSql = closedCondition(columns.status);
      const createdSql = dateExpr(columns.createdAt);
      const closedAtSql = dateExpr(columns.closedAt);

      const { rows: totalRows } = await client.query(`
        WITH normalized AS (
          SELECT
            ${bugSql} AS is_bug,
            ${closedSql} AS is_closed,
            ${createdSql} AS created_at,
            ${closedAtSql} AS closed_at
          FROM public.raw_jira
        )
        SELECT
          COUNT(*)::int AS total_issues,
          COUNT(*) FILTER (WHERE is_bug)::int AS total_bugs,
          COUNT(*) FILTER (WHERE is_bug AND is_closed)::int AS closed_bugs,
          COUNT(*) FILTER (WHERE is_bug AND NOT is_closed)::int AS open_bugs,
          AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 86400)
            FILTER (WHERE is_bug AND is_closed AND created_at IS NOT NULL AND closed_at IS NOT NULL AND closed_at >= created_at)
            AS avg_resolution_days,
          AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400)
            FILTER (WHERE is_bug AND NOT is_closed AND created_at IS NOT NULL)
            AS open_bug_aging_avg_days
        FROM normalized
      `);

      const totalsRow = totalRows[0] || {};
      const totalBugs = Number(totalsRow.total_bugs) || 0;
      const closedBugs = Number(totalsRow.closed_bugs) || 0;

      const totals = {
        totalIssues: Number(totalsRow.total_issues) || 0,
        totalBugs,
        openBugs: columns.status ? Number(totalsRow.open_bugs) || 0 : 0,
        closedBugs: columns.status ? closedBugs : 0,
        closureRate: totalBugs && columns.status ? roundNumber((closedBugs / totalBugs) * 100) : 0,
        avgResolutionDays: columns.createdAt && columns.closedAt
          ? roundNumber(totalsRow.avg_resolution_days)
          : 0,
        openBugAgingAvgDays: columns.createdAt && columns.status
          ? roundNumber(totalsRow.open_bug_aging_avg_days)
          : 0,
      };

      const byStatus = await groupedCount(client, columns.status, 'status');
      const byPriority = await groupedCount(client, columns.priority, 'priority');
      const byIssueType = await groupedCount(client, columns.issueType, 'issueType');

      const updatedAt = columns.uploadedAt
        ? (await client.query(`SELECT MAX(${quoteIdent(columns.uploadedAt)}) AS updated_at FROM public.raw_jira`)).rows[0]?.updated_at
        : null;

      return {
        ok: true,
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : new Date().toISOString(),
        totals,
        byStatus,
        byPriority,
        byIssueType,
        detectedColumns: columns,
        ...(warnings.length ? { warnings } : {}),
      };
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('QA_DASHBOARD_ERROR:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'No se pudo calcular el dashboard QA.',
    });
  }
}
