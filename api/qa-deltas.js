import { withClient } from './_db.js';

function quoteIdent(id) {
  return `"${id.replace(/"/g, '""')}"`;
}

function pick(cols, candidates) {
  return candidates.find((c) => cols.has(c)) || null;
}

// ─── Column candidates ────────────────────────────────────────────────────
const KEY_COLS      = ['clave_de_incincia', 'clave_de_incidencia', 'issue_key'];
const SUMMARY_COLS  = ['resumen', 'summary'];
const TYPE_COLS     = ['tipo_de_incidente', 'tipo_de_incidencia', 'issue_type', 'issuetype'];
const STATUS_COLS   = ['estado', 'status'];
const ASSIGNEE_COLS = ['persona_asignada', 'assignee'];
// Only clave_principal — not "principal" (may contain numeric IDs)
const PARENT_COLS   = ['clave_principal', 'parent', 'parent_key'];
const PSUM_COLS     = ['parent_summary'];

// ─── Domain detection (text inference only) ───────────────────────────────
// Bracket codes take priority; then plain-text patterns as fallback.
// Most specific patterns listed first to avoid partial collisions.
const DOMAIN_PATTERNS = [
  // ── Bracket codes (Jira epic naming convention) ──────────────────────────
  { re: /\[APP\s*EXT\]/i,       domain: () => 'Aplicaciones Externas' },
  { re: /\[DP-EQ1\]/i,          domain: () => 'EQ1 - Originación de Crédito' },
  { re: /\[EQ1\]/i,             domain: () => 'EQ1 - Originación de Crédito' },
  { re: /\[EQ2\]/i,             domain: () => 'EQ2 - Relación con el Cliente' },
  { re: /\[EQ3\]/i,             domain: () => 'EQ3 - Aplicaciones Externas' },
  { re: /\[EQ6\]/i,             domain: () => 'EQ6 - Soporte URPIPRO' },
  { re: /\[EQD\]/i,             domain: () => 'Diseño UX' },
  { re: /\[UX\]/i,              domain: () => 'Diseño UX' },
  { re: /\[CR\]/i,              domain: () => 'Relación con el Cliente' },
  { re: /\[LO\]/i,              domain: () => 'Originación / Línea Operativa' },
  { re: /\[QE\]/i,              domain: () => 'QA / Calidad' },
  { re: /\[QA\]/i,              domain: () => 'QA / Calidad' },
  { re: /\[BE\]/i,              domain: () => 'Backend' },
  { re: /\[FE\]/i,              domain: () => 'Frontend' },
  // ── Bare codes (no brackets) ─────────────────────────────────────────────
  { re: /\bEQD\b/i,             domain: () => 'Diseño UX' },
  { re: /\bDP-EQ1\b/i,         domain: () => 'EQ1 - Originación de Crédito' },
  { re: /\bEQ1\b/i,            domain: () => 'EQ1 - Originación de Crédito' },
  { re: /\bEQ2\b/i,            domain: () => 'EQ2 - Relación con el Cliente' },
  { re: /\bEQ3\b/i,            domain: () => 'EQ3 - Aplicaciones Externas' },
  { re: /\bEQ6\b/i,            domain: () => 'EQ6 - Soporte URPIPRO' },
  // ── Natural language ─────────────────────────────────────────────────────
  { re: /Relaci[oó]n\s+con\s+el\s+cliente/i, domain: () => 'Relación con el Cliente' },
  { re: /Aplicaciones\s+Externas/i,           domain: () => 'Aplicaciones Externas' },
  { re: /Dise[ñn]o\s+UX/i,                   domain: () => 'Diseño UX' },
  { re: /Originaci[oó]n/i,                    domain: () => 'Originación / Línea Operativa' },
  { re: /URPIPRO/i,                           domain: () => 'EQ6 - Soporte URPIPRO' },
  { re: /Soporte/i,                           domain: () => 'Soporte' },
];

function detectDomain(...texts) {
  for (const text of texts) {
    if (!text) continue;
    for (const { re, domain } of DOMAIN_PATTERNS) {
      const m = text.match(re);
      if (m) return domain(m);
    }
  }
  return 'Sin clasificar';
}

// ─── Status classification ────────────────────────────────────────────────
function classifyStatus(status) {
  if (!status) return 'pending';
  const s = status.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  if (s.includes('bloqueado') || s.includes('blocked') || s.includes('impedimento')) {
    return 'blocked';
  }
  if (
    s.includes('finaliz') || s.includes('cerrad') ||
    s === 'done' || s.includes('done') ||
    s === 'resolved' || s.includes('resolv') ||
    s === 'closed' || s.includes('closed')
  ) {
    return 'completed';
  }
  if (
    s.includes('desarrollo') || s.includes('in progress') || s.includes('progress') ||
    s.includes('verificac') || s.includes('listo para') || s.includes('en curso')
  ) {
    return 'inprogress';
  }
  return 'pending';
}

// ─── Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const result = await withClient(async (client) => {
      // 1. Detect available columns
      const { rows: colRows } = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'raw_jira'
        ORDER BY ordinal_position
      `);
      const tableColumns = new Set(colRows.map((r) => r.column_name));

      if (tableColumns.size === 0) {
        return {
          ok: false,
          error: 'Tabla public.raw_jira no encontrada o sin columnas.',
          snapshotDate: new Date().toISOString(),
          totalDeltas: 0,
          deltas: [],
          warnings: [],
        };
      }

      // 2. Resolve column names
      const keyCol      = pick(tableColumns, KEY_COLS);
      const summaryCol  = pick(tableColumns, SUMMARY_COLS);
      const typeCol     = pick(tableColumns, TYPE_COLS);
      const statusCol   = pick(tableColumns, STATUS_COLS);
      const assigneeCol = pick(tableColumns, ASSIGNEE_COLS);
      const parentCol   = pick(tableColumns, PARENT_COLS);
      const pSumCol     = pick(tableColumns, PSUM_COLS);

      if (!typeCol) {
        return {
          ok: false,
          error: 'No se encontró columna de tipo de incidencia.',
          snapshotDate: new Date().toISOString(),
          totalDeltas: 0,
          deltas: [],
          warnings: [],
          availableColumns: [...tableColumns],
        };
      }
      if (!parentCol) {
        return {
          ok: false,
          error: 'No se encontró columna de relación padre/hijo (clave_principal).',
          snapshotDate: new Date().toISOString(),
          totalDeltas: 0,
          deltas: [],
          warnings: [],
          availableColumns: [...tableColumns],
        };
      }

      // 3. Fetch all rows with normalized aliases
      const sel = (col, alias) =>
        col
          ? `COALESCE(NULLIF(TRIM(${quoteIdent(col)}::text), ''), '') AS "${alias}"`
          : `'' AS "${alias}"`;

      const { rows: allRows } = await client.query(`
        SELECT
          ${sel(keyCol,      'k')},
          ${sel(summaryCol,  's')},
          ${sel(typeCol,     'it')},
          ${sel(statusCol,   'st')},
          ${assigneeCol
            ? `NULLIF(TRIM(${quoteIdent(assigneeCol)}::text), '') AS "asgn"`
            : 'NULL::text AS "asgn"'},
          ${sel(parentCol,   'par')},
          ${sel(pSumCol,     'psum')}
        FROM public.raw_jira
      `);

      // 4. Build index by key  (O(1) lookups for hierarchy resolution)
      const issuesByKey = new Map();
      for (const row of allRows) {
        if (row.k) issuesByKey.set(row.k, row);
      }

      // 5. Identify epics
      const isEpicType = (typeStr) => {
        if (!typeStr) return false;
        const t = typeStr.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return t.includes('epic') || t.includes('epica');
      };

      const epics = allRows.filter((r) => isEpicType(r.it));
      const epicKeys = new Set(epics.map((e) => e.k).filter(Boolean));

      // 6. resolveEpic: walk up parent chain (max 5 levels, cycle-safe)
      function resolveEpic(startIssue) {
        if (!startIssue) return null;
        const visited = new Set();
        let cur = startIssue;

        for (let depth = 0; depth <= 5; depth++) {
          if (!cur) return null;
          if (visited.has(cur.k)) return null; // cycle guard
          visited.add(cur.k);

          if (isEpicType(cur.it)) return cur.k;

          const parentKey = cur.par;
          if (!parentKey) return null;
          cur = issuesByKey.get(parentKey) || null;
        }
        return null;
      }

      // 7. Build delta map from epics
      const deltaMap = new Map();
      for (const epic of epics) {
        if (!epic.k) continue;
        deltaMap.set(epic.k, {
          epicKey:          epic.k,
          epicSummary:      epic.s || epic.k,
          domain:           detectDomain(epic.s, epic.psum),
          totalCards:       0,
          completedCards:   0,
          inProgressCards:  0,
          pendingCards:     0,
          blockedCards:     0,
          progressPercent:  0,
          childIssues:      [],
        });
      }

      // 8. Associate ALL non-epic issues to their epic (direct or indirect)
      let unassociated = 0;
      for (const row of allRows) {
        if (epicKeys.has(row.k)) continue; // skip epics themselves

        const epicKey = resolveEpic(row);
        if (!epicKey) { unassociated++; continue; }

        const delta = deltaMap.get(epicKey);
        if (!delta) { unassociated++; continue; }

        delta.totalCards++;

        const cat = classifyStatus(row.st);
        if      (cat === 'completed')  delta.completedCards++;
        else if (cat === 'inprogress') delta.inProgressCards++;
        else if (cat === 'blocked')    delta.blockedCards++;
        else                           delta.pendingCards++;

        delta.childIssues.push({
          key:      row.k,
          type:     row.it,
          summary:  row.s,
          status:   row.st,
          assignee: row.asgn,
        });
      }

      // 9. Finalize deltas (progress %)
      for (const delta of deltaMap.values()) {
        delta.progressPercent = delta.totalCards > 0
          ? Math.round((delta.completedCards / delta.totalCards) * 10000) / 100
          : 0;
      }

      // 10. Sort: lowest progress first, then most pending
      const deltas = [...deltaMap.values()].sort(
        (a, b) => a.progressPercent - b.progressPercent || b.pendingCards - a.pendingCards
      );

      // 11. Warnings
      const warnings = [];
      if (!epics.length) {
        warnings.push('No se encontraron Épicas. Verifica que tipo_de_incidente contenga "Épica" o "Epic".');
      }
      if (unassociated > 0) {
        warnings.push(`${unassociated} incidencias no pudieron asociarse a ninguna Épica.`);
      }

      // 12. Snapshot date
      let snapshotDate = new Date().toISOString();
      if (tableColumns.has('uploaded_at')) {
        const { rows: upRows } = await client.query(
          'SELECT MAX(uploaded_at) AS ua FROM public.raw_jira'
        );
        if (upRows[0]?.ua) snapshotDate = new Date(upRows[0].ua).toISOString();
      }

      return {
        ok: true,
        snapshotDate,
        totalDeltas: deltas.length,
        deltas,
        warnings,
        _meta: {
          detectedColumns: { keyCol, summaryCol, typeCol, statusCol, assigneeCol, parentCol, pSumCol },
          totalEpics: epics.length,
          totalIssues: allRows.length,
          unassociated,
        },
      };
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('QA_DELTAS_ERROR:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Error al calcular el análisis de Deltas.',
      snapshotDate: new Date().toISOString(),
      totalDeltas: 0,
      deltas: [],
      warnings: [],
    });
  }
}
