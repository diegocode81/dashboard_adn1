import { withClient } from './_db.js';

function quoteIdent(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function pickColumn(tableColumns, candidates) {
  return candidates.find((c) => tableColumns.has(c)) || null;
}

// ─── Columnas candidatas ───────────────────────────────────────────────────
const KEY_COLS       = ['clave_de_incincia', 'clave_de_incidencia', 'issue_key', 'key'];
const SUMMARY_COLS   = ['resumen', 'summary'];
const TYPE_COLS      = ['tipo_de_incidente', 'tipo_de_incidencia', 'issue_type', 'issuetype'];
const STATUS_COLS    = ['estado', 'status'];
const ASSIGNEE_COLS  = ['persona_asignada', 'assignee'];
// Usamos SÓLO clave_principal para relación padre-hijo (no "principal" que puede ser ID numérico)
const PARENT_COLS    = ['clave_principal', 'parent', 'parent_key'];
const PARENT_SUM_COLS = ['parent_summary'];

// Candidatos de equipo en orden de prioridad
const TEAM_COL_CANDIDATES = [
  'campo_personalizado_equipo',
  'campo_personalizado_nombre_de_equipo_ti_gdd',
  'campo_personalizado_nombre_de_equipo_ti__gdd_',
  'team_name',
  'componentes',
  'components',
  'etiquetas',
  'labels',
];

// ─── Inferencia de equipo desde texto ──────────────────────────────────────
// Patrones de más específico a menos específico
const TEAM_PATTERNS = [
  { re: /Soporte\s+URPIPRO/i,               name: () => 'Soporte URPIPRO' },
  { re: /Relaci[oó]n\s+con\s+el\s+cliente/i, name: () => 'Relación con el cliente' },
  { re: /Aplicaciones\s+Externas/i,          name: () => 'Aplicaciones Externas' },
  { re: /Dise[ñn]o\s+UX/i,                  name: () => 'Diseño UX' },
  { re: /Originaci[oó]n/i,                   name: () => 'Originación' },
  { re: /\bEQD\b/i,                          name: () => 'EQD' },
  { re: /\b(EQ[0-9]+)\b/i,                  name: (m) => m[1].toUpperCase() },
  { re: /\bUX\b/i,                           name: () => 'UX' },
  { re: /Soporte/i,                          name: () => 'Soporte' },
];

function inferTeamFromText(text) {
  if (!text) return null;
  for (const { re, name } of TEAM_PATTERNS) {
    const m = text.match(re);
    if (m) return name(m);
  }
  return null;
}

/**
 * Detecta el equipo de una issue row.
 * 1. Valor explícito en _team (ya resuelto con COALESCE en SQL).
 * 2. Inferencia desde _summary.
 * 3. Inferencia desde _parent_summary.
 */
function detectTeamFromIssue(row) {
  if (row._team) return row._team;
  return (
    inferTeamFromText(row._summary) ||
    inferTeamFromText(row._parent_summary) ||
    null
  );
}

// ─── Clasificación de estado ───────────────────────────────────────────────
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

// ─── Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const result = await withClient(async (client) => {
      // 1. Detectar columnas disponibles
      const { rows: columnRows } = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'raw_jira'
        ORDER BY ordinal_position
      `);
      const tableColumns = new Set(columnRows.map((r) => r.column_name));
      const warnings = [];

      if (tableColumns.size === 0) {
        return {
          ok: false,
          step: 'EPIC_RELATION_NOT_FOUND',
          error: 'Tabla public.raw_jira no encontrada o sin columnas.',
          availableColumns: [],
        };
      }

      // 2. Resolver columnas
      const keyCol         = pickColumn(tableColumns, KEY_COLS);
      const summaryCol     = pickColumn(tableColumns, SUMMARY_COLS);
      const typeCol        = pickColumn(tableColumns, TYPE_COLS);
      const statusCol      = pickColumn(tableColumns, STATUS_COLS);
      const assigneeCol    = pickColumn(tableColumns, ASSIGNEE_COLS);
      const parentCol      = pickColumn(tableColumns, PARENT_COLS);
      const parentSumCol   = pickColumn(tableColumns, PARENT_SUM_COLS);

      // Todas las columnas de equipo que existen en la tabla (en orden de prioridad)
      const existingTeamCols = TEAM_COL_CANDIDATES.filter((c) => tableColumns.has(c));
      const hasExplicitTeamCol = existingTeamCols.length > 0;

      if (!typeCol) {
        return {
          ok: false,
          step: 'EPIC_RELATION_NOT_FOUND',
          error: 'No se pudo identificar la columna de tipo de incidencia.',
          availableColumns: [...tableColumns],
        };
      }
      if (!parentCol) {
        return {
          ok: false,
          step: 'EPIC_RELATION_NOT_FOUND',
          error: 'No se pudo identificar la columna de relación padre/hijo (clave_principal / parent).',
          availableColumns: [...tableColumns],
        };
      }

      // 3. Construir expresión SQL para equipo (COALESCE sobre todas las columnas encontradas)
      const sel = (col, alias) =>
        col
          ? `COALESCE(NULLIF(TRIM(${quoteIdent(col)}::text), ''), '') AS ${alias}`
          : `'' AS ${alias}`;

      const teamExpr = hasExplicitTeamCol
        ? `COALESCE(${existingTeamCols
            .map((c) => `NULLIF(TRIM(${quoteIdent(c)}::text), '')`)
            .join(', ')}, '') AS _team`
        : `'' AS _team`;

      // 4. Fetch todas las rows
      const { rows: allRows } = await client.query(`
        SELECT
          ${sel(keyCol,       '_key')},
          ${sel(summaryCol,   '_summary')},
          ${sel(typeCol,      '_issue_type')},
          ${sel(statusCol,    '_status')},
          ${assigneeCol
            ? `NULLIF(TRIM(${quoteIdent(assigneeCol)}::text), '') AS _assignee`
            : 'NULL::text AS _assignee'},
          ${sel(parentCol,    '_parent')},
          ${sel(parentSumCol, '_parent_summary')},
          ${teamExpr}
        FROM public.raw_jira
      `);

      // 5. Construir índice por clave
      const issuesByKey = new Map();
      for (const row of allRows) {
        if (row._key) issuesByKey.set(row._key, row);
      }

      // 6. Identificar épicas
      const isEpicType = (typeStr) => {
        const t = typeStr.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return t.includes('epic') || t.includes('epica');
      };

      const epics = allRows.filter((r) => isEpicType(r._issue_type));

      if (!epics.length) {
        warnings.push(
          'No se encontraron épicas. Verifica que tipo_de_incidente contenga "Épica" o "Epic".'
        );
      }

      const epicKeys = new Set(epics.map((e) => e._key).filter(Boolean));

      // 7. resolveEpicKey: sube por la cadena de padres hasta encontrar una épica (máx 5 niveles)
      function resolveEpicKey(startIssue) {
        if (!startIssue) return null;
        const visited = new Set();
        let current = startIssue;

        for (let depth = 0; depth <= 5; depth++) {
          if (!current) return null;
          if (visited.has(current._key)) return null; // ciclo detectado
          visited.add(current._key);

          if (isEpicType(current._issue_type)) return current._key;

          const parentKey = current._parent;
          if (!parentKey) return null;
          current = issuesByKey.get(parentKey) || null;
        }
        return null;
      }

      // 8. Construir mapa de deltas a partir de épicas
      const deltaMap = new Map();
      for (const epic of epics) {
        if (!epic._key) continue;
        const explicitTeam = detectTeamFromIssue(epic);
        deltaMap.set(epic._key, {
          team:              explicitTeam || null,  // se resolverá en paso 10
          epicKey:           epic._key,
          epicSummary:       epic._summary || epic._key,
          totalCards:        0,
          completedCards:    0,
          inProgressCards:   0,
          pendingCards:      0,
          blockedCards:      0,
          progressPercent:   0,
          statusBreakdown:   {},
          issueTypeBreakdown:{},
          childCards:        [],
          _teamVotes:        {},  // votos de equipo desde cards hijas
        });
      }

      // 9. Asociar TODAS las issues no-épicas a su épica (directa o indirectamente)
      let unassociated = 0;
      for (const row of allRows) {
        if (epicKeys.has(row._key)) continue; // saltar las propias épicas

        const epicKey = resolveEpicKey(row);
        if (!epicKey) {
          unassociated++;
          continue;
        }

        const delta = deltaMap.get(epicKey);
        if (!delta) {
          unassociated++;
          continue;
        }

        delta.totalCards++;

        const cat = classifyStatus(row._status);
        if      (cat === 'completed')  delta.completedCards++;
        else if (cat === 'inprogress') delta.inProgressCards++;
        else if (cat === 'blocked')    delta.blockedCards++;
        else                           delta.pendingCards++;

        // Breakdowns
        const stLabel = row._status || 'Sin estado';
        delta.statusBreakdown[stLabel] = (delta.statusBreakdown[stLabel] || 0) + 1;

        const itLabel = row._issue_type || 'Sin tipo';
        delta.issueTypeBreakdown[itLabel] = (delta.issueTypeBreakdown[itLabel] || 0) + 1;

        // Voto de equipo desde la card hija
        const cardTeam = detectTeamFromIssue(row);
        if (cardTeam) {
          delta._teamVotes[cardTeam] = (delta._teamVotes[cardTeam] || 0) + 1;
        }

        delta.childCards.push({
          key:      row._key,
          summary:  row._summary,
          type:     row._issue_type,
          status:   row._status,
          assignee: row._assignee,
        });
      }

      if (unassociated > 0) {
        warnings.push(
          `${unassociated} cards no pudieron asociarse a una épica después de resolver jerarquía padre/hijo.`
        );
      }

      // 10. Finalizar cada delta: equipo, progreso, breakdowns
      let epicsWithoutTeam  = 0;
      let epicsWithoutCards = 0;

      for (const delta of deltaMap.values()) {
        if (delta.totalCards === 0) epicsWithoutCards++;

        // Resolver equipo: explícito > voto mayoritario de hijos > inferencia > fallback
        if (!delta.team) {
          const votes   = delta._teamVotes;
          const topVote = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
          if (topVote) {
            delta.team = topVote[0];
          } else {
            delta.team = inferTeamFromText(delta.epicSummary) || 'Sin equipo identificado';
            if (delta.team === 'Sin equipo identificado') epicsWithoutTeam++;
          }
        }
        delete delta._teamVotes;

        // Porcentaje de avance
        delta.progressPercent = delta.totalCards > 0
          ? Math.round((delta.completedCards / delta.totalCards) * 10000) / 100
          : 0;

        // Convertir breakdowns a arrays ordenados
        delta.statusBreakdown = Object.entries(delta.statusBreakdown)
          .map(([status, count]) => ({ status, count }))
          .sort((a, b) => b.count - a.count);

        delta.issueTypeBreakdown = Object.entries(delta.issueTypeBreakdown)
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count);
      }

      // 11. Construir warnings finales
      if (!hasExplicitTeamCol) {
        warnings.push(
          'No se encontró columna de equipo explícita. El equipo fue inferido desde texto cuando fue posible.'
        );
      }
      if (!assigneeCol) {
        warnings.push('No se encontró columna de responsable (persona_asignada / assignee).');
      }
      if (epicsWithoutTeam > 0) {
        warnings.push(`No se pudo identificar equipo para ${epicsWithoutTeam} épica(s).`);
      }
      if (epicsWithoutCards > 0) {
        warnings.push(`${epicsWithoutCards} épica(s) no tienen cards asociadas en el dataset actual.`);
      }

      // 12. Construir respuesta final
      const deltas = [...deltaMap.values()].sort(
        (a, b) => a.team.localeCompare(b.team) || a.epicKey.localeCompare(b.epicKey)
      );
      const teams = [...new Set(deltas.map((d) => d.team))].sort();

      let updatedAt = new Date().toISOString();
      if (tableColumns.has('uploaded_at')) {
        const { rows: upRows } = await client.query(
          'SELECT MAX(uploaded_at) AS ua FROM public.raw_jira'
        );
        if (upRows[0]?.ua) updatedAt = new Date(upRows[0].ua).toISOString();
      }

      return {
        ok: true,
        updatedAt,
        teams,
        deltas,
        detectedColumns: {
          key:        keyCol,
          summary:    summaryCol,
          issueType:  typeCol,
          status:     statusCol,
          assignee:   assigneeCol,
          parent:     parentCol,
          parentSum:  parentSumCol,
          teamCols:   existingTeamCols,
        },
        warnings,
      };
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('QA_DELTAS_ERROR:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'No se pudo calcular el análisis de Deltas.',
    });
  }
}
