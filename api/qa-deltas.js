import { withClient } from './_db.js';

function quoteIdent(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function pickColumn(tableColumns, candidates) {
  return candidates.find((c) => tableColumns.has(c)) || null;
}

const COLUMN_CANDIDATES = {
  key:       ['clave_de_incincia', 'clave_de_incidencia', 'issue_key', 'key'],
  summary:   ['resumen', 'summary'],
  issueType: ['tipo_de_incidente', 'tipo_de_incidencia', 'issue_type', 'issuetype'],
  status:    ['estado', 'status'],
  team:      ['team_name'],
  assignee:  ['persona_asignada', 'assignee'],
  parent:    ['clave_principal', 'parent', 'parent_key', 'principal'],
};

/**
 * Clasifica el estado de una card en una de 4 categorías.
 * Normaliza la cadena eliminando acentos para comparaciones robustas.
 */
function classifyStatus(status) {
  if (!status) return 'pending';
  const s = status
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  // Bloqueado — mayor prioridad
  if (s.includes('bloqueado') || s.includes('blocked') || s.includes('impedimento')) {
    return 'blocked';
  }

  // Completado
  if (
    s.includes('finaliz') ||
    s.includes('cerrad') ||
    s === 'done' || s.includes('done') ||
    s === 'resolved' || s.includes('resolv') ||
    s === 'closed' || s.includes('closed')
  ) {
    return 'completed';
  }

  // En progreso
  if (
    s.includes('desarrollo') ||
    s.includes('in progress') ||
    s.includes('progress') ||
    s.includes('verificac') ||
    s.includes('listo para') ||
    s.includes('en curso')
  ) {
    return 'inprogress';
  }

  // Pendiente (default)
  return 'pending';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const result = await withClient(async (client) => {
      // 1. Detectar columnas disponibles en public.raw_jira
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
          error: 'No se pudo identificar la columna que relaciona cards con épicas',
          availableColumns: [],
        };
      }

      // 2. Resolver candidatos a columnas
      const cols = {};
      for (const [field, candidates] of Object.entries(COLUMN_CANDIDATES)) {
        cols[field] = pickColumn(tableColumns, candidates);
      }

      // 3. Warnings por columnas faltantes
      if (!cols.team) {
        warnings.push('No se encontró columna de equipo (team_name). Las épicas aparecerán sin equipo.');
      }
      if (!cols.assignee) {
        warnings.push('No se encontró columna de responsable (persona_asignada / assignee).');
      }

      // 4. Columnas críticas — sin ellas no se puede calcular relación
      if (!cols.parent) {
        return {
          ok: false,
          step: 'EPIC_RELATION_NOT_FOUND',
          error: 'No se pudo identificar la columna que relaciona cards con épicas (clave_principal / parent)',
          availableColumns: [...tableColumns],
        };
      }
      if (!cols.issueType) {
        return {
          ok: false,
          step: 'EPIC_RELATION_NOT_FOUND',
          error: 'No se pudo identificar la columna de tipo de incidencia',
          availableColumns: [...tableColumns],
        };
      }

      // 5. Fetch todas las rows relevantes en una sola query
      const sel = (col, alias) =>
        col
          ? `COALESCE(NULLIF(TRIM(${quoteIdent(col)}::text), ''), '') AS ${alias}`
          : `'' AS ${alias}`;

      const { rows: allRows } = await client.query(`
        SELECT
          ${sel(cols.key,       'k')},
          ${sel(cols.summary,   's')},
          ${sel(cols.issueType, 'it')},
          ${sel(cols.status,    'st')},
          ${sel(cols.team,      'tm')},
          ${cols.assignee
            ? `NULLIF(TRIM(${quoteIdent(cols.assignee)}::text), '') AS asgn`
            : 'NULL::text AS asgn'},
          ${sel(cols.parent,    'par')}
        FROM public.raw_jira
      `);

      // 6. Separar épicas de cards
      const epics = allRows.filter((r) => {
        const t = r.it.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return t.includes('epic') || t.includes('epica');
      });

      if (!epics.length) {
        warnings.push(
          'No se encontraron épicas en la tabla. ' +
          'Asegúrate de que tipo_de_incidente contenga valores como "Épica" o "Epic".'
        );
      }

      const epicKeys = new Set(epics.map((e) => e.k).filter(Boolean));

      // Cards directas de épicas (no son épicas y su padre es una épica)
      const cards = allRows.filter(
        (r) => r.it && !epicKeys.has(r.k) && r.par && epicKeys.has(r.par)
      );

      // Cards con padre que no es ninguna épica conocida
      const orphanCount = allRows.filter(
        (r) => !epicKeys.has(r.k) && r.par && !epicKeys.has(r.par) && r.par !== ''
      ).length;
      if (orphanCount > 0) {
        warnings.push(`${orphanCount} cards tienen referencia a una épica que no existe en el dataset actual.`);
      }

      // 7. Construir mapa de deltas
      const deltaMap = new Map();
      for (const epic of epics) {
        if (!epic.k) continue;
        deltaMap.set(epic.k, {
          team:              epic.tm || 'Sin equipo',
          epicKey:           epic.k,
          epicSummary:       epic.s || epic.k,
          totalCards:        0,
          completedCards:    0,
          inProgressCards:   0,
          pendingCards:      0,
          blockedCards:      0,
          progressPercent:   0,
          statusBreakdown:   {},
          issueTypeBreakdown:{},
          childCards:        [],
        });
      }

      // 8. Asociar cards hijas a sus deltas
      for (const card of cards) {
        const delta = deltaMap.get(card.par);
        if (!delta) continue;

        delta.totalCards++;
        const cat = classifyStatus(card.st);
        if      (cat === 'completed')  delta.completedCards++;
        else if (cat === 'inprogress') delta.inProgressCards++;
        else if (cat === 'blocked')    delta.blockedCards++;
        else                           delta.pendingCards++;

        const stLabel = card.st || 'Sin estado';
        delta.statusBreakdown[stLabel] = (delta.statusBreakdown[stLabel] || 0) + 1;

        const itLabel = card.it || 'Sin tipo';
        delta.issueTypeBreakdown[itLabel] = (delta.issueTypeBreakdown[itLabel] || 0) + 1;

        delta.childCards.push({
          key:      card.k,
          summary:  card.s,
          type:     card.it,
          status:   card.st,
          assignee: card.asgn,
        });
      }

      // 9. Finalizar cada delta
      let epicsWithoutCards = 0;
      for (const delta of deltaMap.values()) {
        if (delta.totalCards === 0) epicsWithoutCards++;

        delta.progressPercent = delta.totalCards > 0
          ? Math.round((delta.completedCards / delta.totalCards) * 10000) / 100
          : 0;

        delta.statusBreakdown = Object.entries(delta.statusBreakdown)
          .map(([status, count]) => ({ status, count }))
          .sort((a, b) => b.count - a.count);

        delta.issueTypeBreakdown = Object.entries(delta.issueTypeBreakdown)
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count);
      }

      if (epicsWithoutCards > 0) {
        warnings.push(
          `${epicsWithoutCards} épica(s) no tienen cards directas asociadas en el dataset actual.`
        );
      }

      const deltas = [...deltaMap.values()].sort(
        (a, b) => a.team.localeCompare(b.team) || a.epicKey.localeCompare(b.epicKey)
      );
      const teams = [...new Set(deltas.map((d) => d.team))].sort();

      // 10. Fecha de última carga
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
        detectedColumns: cols,
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
