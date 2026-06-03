// api/upload.js
// Carga CSV de Jira -> TRUNCATE + INSERT en public.raw_jira
// - Inserta SOLO columnas que EXISTEN en la DB (whitelist).
// - Soporta cabeceras duplicadas sin perder valores (p. ej., "Sprint" x N).
// - Duplicados "Sprint": mapea hasta 11 -> sprint, sprint1..sprint10.
// - uploaded_at = NOW() si la columna existe.
// - Lotes dinámicos para no exceder el límite de parámetros en Postgres.

import { withClient } from './_db.js';
import { parse as parseCsv } from 'csv-parse/sync';
import formidable from 'formidable';
import fs from 'fs/promises';

export const config = {
  api: { bodyParser: false, sizeLimit: '25mb' },
  runtime: 'nodejs',
};

// --- Utilidades ---
function sanitize(name) {
  return name
    .toString()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sniffDelimiter(sampleText) {
  const head = sampleText.split(/\r?\n/).slice(0, 5).join('\n');
  const commas = (head.match(/,/g) || []).length;
  const semis  = (head.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

function toDb(v) {
  if (v === '') return null;
  return v;
}

function quoteIdent(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function isCsvFile(file) {
  const name = file?.originalFilename || file?.newFilename || '';
  const type = file?.mimetype || '';
  return /\.csv$/i.test(name)
    || type === 'text/csv'
    || type === 'application/csv'
    || type === 'application/vnd.ms-excel'
    || type === 'text/plain';
}

// Genera claves únicas para cabeceras duplicadas
function makeUniqueHeaders(rawHeaders) {
  const counts = new Map();
  const uniques = [];
  for (const h of rawHeaders) {
    const sane = sanitize(h);
    const seen = counts.get(sane) || 0;
    if (seen === 0) {
      uniques.push({ uniqueKey: sane, base: sane, original: h, occ: 0 });
      counts.set(sane, 1);
    } else {
      const uniqueKey = `${sane}__dup${seen}`; // ej: sprint__dup1
      uniques.push({ uniqueKey, base: sane, original: h, occ: seen });
      counts.set(sane, seen + 1);
    }
  }
  return uniques;
}

// Para 'sprint' mapeamos explícito hasta 11 slots (sprint .. sprint10)
function candidateDbNamesForSprint(occ) {
  const explicit = [
    'sprint',  // occ = 0
    'sprint1', // 1
    'sprint2', // 2
    'sprint3', // 3
    'sprint4', // 4
    'sprint5', // 5
    'sprint6', // 6
    'sprint7', // 7
    'sprint8', // 8
    'sprint9', // 9
    'sprint10' // 10
  ];
  return occ < explicit.length ? [explicit[occ]] : [];
}

// Para otras duplicadas, variaciones comunes
function candidateDbNamesGeneric(base, occ) {
  if (occ === 0) return [base];
  const n = occ; // 1=segunda, 2=tercera...
  return [
    `${base}${n}`,     // base1
    `${base}_${n}`,    // base_1
    `${base}${n+1}`,   // base2 (por si DB es 1-based)
    `${base}_${n+1}`,  // base_2
  ];
}

// Equivalencias CSV(normalizado) -> columna en DB (tolerante a typos/variantes)
const HARDCODED = {
  // Incidencia(s)
  tipo_de_incidencia:  'tipo_de_incidente',
  id_de_la_incidencia: 'id_de_la_inciencia',
  clave_de_incidencia: 'clave_de_incincia',
  issue_key:           'clave_de_incincia',
  key:                 'clave_de_incincia',
  issue_id:            'id_de_la_inciencia',
  id:                  'id_de_la_inciencia',
  tipo_de_incidente:   'tipo_de_incidente',
  issue_type:          'tipo_de_incidente',
  issuetype:           'tipo_de_incidente',

  // Campos comunes Jira ADN PRO
  summary:             'resumen',
  resumen:             'resumen',
  status:              'estado',
  estado:              'estado',
  priority:            'prioridad',
  prioridad:           'prioridad',
  assignee:            'persona_asignada',
  persona_asignada:    'persona_asignada',
  asignado:            'persona_asignada',
  reporter:            'informador',
  informador:          'informador',
  updated:             'actualizada',
  actualizada:         'actualizada',
  team_name:           'team_name',
  campo_personalizado_responsable_qa:       'responsable_qa',
  responsable_qa:                            'responsable_qa',
  campo_personalizado_puntos_de_historia:   'story_points',
  campo_personalizado_story_points:         'story_points',
  campo_personalizado_criticidad:           'criticidad',
  criticidad:                                'criticidad',
  campo_personalizado_fecha_en_pruebas_qa:  'fecha_en_pruebas_qa',
  fecha_en_pruebas_qa:                      'fecha_en_pruebas_qa',
  campo_personalizado_fecha_pase_a_produccion: 'fecha_pase_a_produccion',
  fecha_pase_a_produccion:                     'fecha_pase_a_produccion',
  principal:                                'principal',
  clave_principal:                          'clave_principal',
  parent:                                   'clave_principal',
  parent_key:                               'clave_principal',
  parent_summary:                           'parent_summary',

  // Fechas de CREACIÓN/INICIO -> fecha_creacion
  fecha_de_creacion:   'fecha_creacion',
  creada:              'fecha_creacion',
  fecha_creado:        'fecha_creacion',
  creado:              'fecha_creacion',
  created:             'fecha_creacion',
  created_date:        'fecha_creacion',
  fecha_reporte:       'fecha_creacion',
  fecha_de_reporte:    'fecha_creacion',
  fecha_inicio_real:   'fecha_creacion',
  fecha_de_inicio:     'fecha_creacion',
  start_date:          'fecha_creacion',

  // Fechas de CIERRE/RESOLUCIÓN -> fecha_cierre
  fecha_de_resolucion: 'fecha_cierre',
  resuelta:            'fecha_cierre',
  fecha_resolucion:    'fecha_cierre',
  fecha_cierre_real:   'fecha_cierre',
  resolved:            'fecha_cierre',
  resolution_date:     'fecha_cierre',
  fecha_de_cierre:     'fecha_cierre',
  close_date:          'fecha_cierre',

  // Story points (por si vienen con otro nombre)
  story_points_estimate: 'story_points',
  storypoint:            'story_points'
};

const IMPORTANT_COLUMNS = [
  {
    jiraColumn: 'Clave de incidencia',
    csvCandidates: ['clave_de_incidencia', 'issue_key', 'key'],
    dbCandidates: ['clave_de_incincia', 'clave_de_incidencia', 'issue_key', 'key'],
  },
  {
    jiraColumn: 'ID de la incidencia',
    csvCandidates: ['id_de_la_incidencia', 'issue_id', 'id'],
    dbCandidates: ['id_de_la_inciencia', 'id_de_la_incidencia', 'issue_id'],
  },
  {
    jiraColumn: 'Resumen',
    csvCandidates: ['resumen', 'summary'],
    dbCandidates: ['resumen', 'summary'],
  },
  {
    jiraColumn: 'Tipo de Incidencia',
    csvCandidates: ['tipo_de_incidencia', 'tipo_de_incidente', 'issue_type', 'issuetype'],
    dbCandidates: ['tipo_de_incidente', 'tipo_de_incidencia', 'issue_type', 'issuetype'],
  },
  {
    jiraColumn: 'Estado',
    csvCandidates: ['estado', 'status'],
    dbCandidates: ['estado', 'status'],
  },
  {
    jiraColumn: 'Prioridad',
    csvCandidates: ['prioridad', 'priority'],
    dbCandidates: ['prioridad', 'priority'],
  },
  {
    jiraColumn: 'Persona asignada',
    csvCandidates: ['persona_asignada', 'assignee', 'asignado'],
    dbCandidates: ['persona_asignada', 'assignee', 'asignado'],
  },
  {
    jiraColumn: 'Informador',
    csvCandidates: ['informador', 'reporter'],
    dbCandidates: ['informador', 'reporter'],
  },
  {
    jiraColumn: 'Creada',
    csvCandidates: ['creada', 'fecha_de_creacion', 'created', 'fecha_creacion'],
    dbCandidates: ['fecha_creacion', 'creada', 'created'],
  },
  {
    jiraColumn: 'Actualizada',
    csvCandidates: ['actualizada', 'updated'],
    dbCandidates: ['actualizada', 'updated'],
  },
  {
    jiraColumn: 'Resuelta',
    csvCandidates: ['resuelta', 'fecha_de_resolucion', 'resolved', 'fecha_cierre'],
    dbCandidates: ['fecha_cierre', 'resuelta', 'resolved'],
  },
  {
    jiraColumn: 'Sprint',
    csvCandidates: ['sprint'],
    dbCandidates: ['sprint', 'sprint1', 'sprint2', 'sprint3', 'sprint4', 'sprint5', 'sprint6', 'sprint7', 'sprint8', 'sprint9', 'sprint10'],
  },
  {
    jiraColumn: 'Team Name',
    csvCandidates: ['team_name'],
    dbCandidates: ['team_name'],
  },
  {
    jiraColumn: 'Campo personalizado (Responsable QA)',
    csvCandidates: ['campo_personalizado_responsable_qa', 'responsable_qa'],
    dbCandidates: ['responsable_qa', 'campo_personalizado_responsable_qa'],
  },
  {
    jiraColumn: 'Campo personalizado (Puntos de Historia)',
    csvCandidates: ['campo_personalizado_puntos_de_historia', 'campo_personalizado_story_points', 'story_points'],
    dbCandidates: ['story_points', 'puntos_de_historia', 'campo_personalizado_puntos_de_historia'],
  },
  {
    jiraColumn: 'Campo personalizado (Criticidad)',
    csvCandidates: ['campo_personalizado_criticidad', 'criticidad'],
    dbCandidates: ['criticidad', 'campo_personalizado_criticidad'],
  },
  {
    jiraColumn: 'Campo personalizado (Fecha en Pruebas QA)',
    csvCandidates: ['campo_personalizado_fecha_en_pruebas_qa', 'fecha_en_pruebas_qa'],
    dbCandidates: ['fecha_en_pruebas_qa', 'campo_personalizado_fecha_en_pruebas_qa'],
  },
  {
    jiraColumn: 'Campo personalizado (Fecha pase a producción)',
    csvCandidates: ['campo_personalizado_fecha_pase_a_produccion', 'fecha_pase_a_produccion'],
    dbCandidates: ['fecha_pase_a_produccion', 'campo_personalizado_fecha_pase_a_produccion'],
  },
  {
    jiraColumn: 'Principal',
    csvCandidates: ['principal'],
    dbCandidates: ['principal'],
  },
  {
    jiraColumn: 'Clave principal',
    csvCandidates: ['clave_principal', 'parent', 'parent_key'],
    dbCandidates: ['clave_principal', 'parent', 'parent_key'],
  },
  {
    jiraColumn: 'Parent summary',
    csvCandidates: ['parent_summary'],
    dbCandidates: ['parent_summary'],
  },
];

function duplicatedColumns(uniqueHeaders) {
  const grouped = new Map();
  for (const h of uniqueHeaders) {
    if (!grouped.has(h.base)) grouped.set(h.base, []);
    grouped.get(h.base).push(h);
  }

  return [...grouped.entries()]
    .filter(([, headers]) => headers.length > 1)
    .map(([normalizedName, headers]) => ({
      normalizedName,
      count: headers.length,
      columns: headers.map(h => ({
        original: h.original,
        uniqueKey: h.uniqueKey,
        occurrence: h.occ,
      })),
    }));
}

function missingImportantColumns(uniqueHeaders, tableCols, mapping) {
  const csvBases = new Set(uniqueHeaders.map(h => h.base));
  const mappedTargets = new Set(mapping.map(m => m.targetDbCol));

  return IMPORTANT_COLUMNS
    .filter((important) => {
      const existsInCsv = important.csvCandidates.some(c => csvBases.has(c));
      const existsInDb = important.dbCandidates.some(c => tableCols.has(c));
      const wasMapped = important.dbCandidates.some(c => mappedTargets.has(c));
      return existsInCsv ? !wasMapped : !existsInDb;
    })
    .map((important) => {
      const existsInCsv = important.csvCandidates.some(c => csvBases.has(c));
      return {
        jiraColumn: important.jiraColumn,
        reason: existsInCsv ? 'no-matching-db-column' : 'not-present-in-csv-or-db',
        expectedDbColumns: important.dbCandidates,
      };
    });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // 1) multipart
    const form = formidable({ multiples: false, maxFileSize: 25 * 1024 * 1024, keepExtensions: true });
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
    });
    const fvals = Object.values(files || {});
    if (fvals.length === 0) {
      return res.status(400).json({ ok: false, error: 'Archivo no encontrado (key "file")' });
    }
    const up = Array.isArray(fvals[0]) ? fvals[0][0] : fvals[0];
    if (!isCsvFile(up)) {
      return res.status(400).json({ ok: false, error: 'El archivo debe ser CSV.' });
    }

    // 2) leer archivo
    const buf = await fs.readFile(up.filepath);
    const text = buf.toString('utf8');
    const delimiter = sniffDelimiter(text);

    // 3) cabeceras crudas
    const headerRow = parseCsv(text, {
      delimiter,
      bom: true,
      from_line: 1,
      to_line: 1,
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: false,
    })[0];

    if (!headerRow || !headerRow.length) {
      return res.status(400).json({ ok: false, error: 'No se pudo leer cabeceras del CSV' });
    }

    // 4) claves únicas para parser
    const uniqueHeaders = makeUniqueHeaders(headerRow); // [{uniqueKey, base, original, occ}, ...]
    const columnsForParser = uniqueHeaders.map(x => x.uniqueKey);
    const duplicated = duplicatedColumns(uniqueHeaders);

    // 5) parse filas con las claves únicas
    const rows = parseCsv(text, {
      delimiter,
      bom: true,
      columns: columnsForParser,
      from_line: 2,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
      cast: (value) => toDb(value),
    });
    if (!rows.length) return res.status(400).json({ ok: false, error: 'CSV vacío' });

    // 6) DB: columnas reales (whitelist)
    const result = await withClient(async (client) => {
      const { rows: cols } = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'raw_jira'
      `);
      const tableCols = new Set(cols.map(r => r.column_name));
      if (tableCols.size === 0) throw new Error('La tabla public.raw_jira no existe o no tiene columnas.');

      const hasUploadedAt = tableCols.has('uploaded_at');

      // 7) mapping CSV(uniqueKey)->DB(target)
      const mapping = [];         // [{uniqueKey, original, base, occ, targetDbCol}]
      const usedTargets = new Set();
      const ignored = [];

      for (const h of uniqueHeaders) {
        const { uniqueKey, base, original, occ } = h;
        let target = null;

        const candidates = (base === 'sprint')
          ? candidateDbNamesForSprint(occ)
          : [
              ...(HARDCODED[base] ? [HARDCODED[base]] : []),
              ...candidateDbNamesGeneric(base, occ),
            ];

        for (const c of candidates) {
          if (tableCols.has(c) && !usedTargets.has(c)) {
            target = c;
            break;
          }
        }

        if (target) {
          mapping.push({ uniqueKey, original, base, occ, targetDbCol: target });
          usedTargets.add(target);
        } else {
          ignored.push({ uniqueKey, original, base, occ, reason: 'no-matching-db-column' });
        }
      }

      const insertCols = mapping
        .map(m => m.targetDbCol)
        .filter(c => c !== 'id' && c !== 'uploaded_at');
      const reservedMappings = mapping.filter(m => m.targetDbCol === 'id' || m.targetDbCol === 'uploaded_at');
      for (const m of reservedMappings) {
        ignored.push({
          uniqueKey: m.uniqueKey,
          original: m.original,
          base: m.base,
          occ: m.occ,
          targetDbCol: m.targetDbCol,
          reason: 'reserved-db-column',
        });
      }

      if (!insertCols.length) {
        throw new Error('No hay columnas mapeadas CSV->DB para insertar.');
      }

      const insertMapping = mapping.filter(m => insertCols.includes(m.targetDbCol));
      const mappedByTarget = new Map(insertMapping.map(m => [m.targetDbCol, m]));
      const missingImportant = missingImportantColumns(uniqueHeaders, tableCols, mapping);

      // 8) transformar filas según mapping (orden de insertCols)
      const values = rows.map((row) => {
        const arr = new Array(insertCols.length);
        for (let i = 0; i < insertCols.length; i++) {
          const col = insertCols[i];
          const m = mappedByTarget.get(col);
          if (!m) throw new Error(`Mapping inconsistente para columna ${col}`);
          arr[i] = toDb(row[m.uniqueKey]);
        }
        return arr;
      });

      // 9) TRUNCATE + INSERT por lotes seguros
      await client.query('BEGIN');
      try {
        await client.query('TRUNCATE TABLE public.raw_jira RESTART IDENTITY');

        const effectiveInsertCols = hasUploadedAt ? [...insertCols, 'uploaded_at'] : [...insertCols];
        const baseLen = insertCols.length;
        const extraCols = hasUploadedAt ? 1 : 0;

        // Límite de parámetros de Postgres ~65535. Reservamos margen.
        const PG_MAX_PARAMS = 60000;
        const maxRowsByParams = Math.max(1, Math.floor(PG_MAX_PARAMS / (baseLen + extraCols)));
        // Tope adicional para tamaño de SQL y estabilidad en serverless.
        const batchSize = Math.min(500, maxRowsByParams);

        let total = 0;
        for (let i = 0; i < values.length; i += batchSize) {
          const chunk = values.slice(i, i + batchSize);

          // Placeholders con índices locales al chunk
          const placeholders = [];
          let pIndex = 1;
          for (let r = 0; r < chunk.length; r++) {
            const ids = [];
            for (let c = 0; c < baseLen; c++) {
              ids.push(`$${pIndex++}`);
            }
            const tuple = hasUploadedAt ? `(${ids.join(',')}, NOW())` : `(${ids.join(',')})`;
            placeholders.push(tuple);
          }

          // Empaquetado robusto de parámetros (sin usar Array.flat)
          const expected = chunk.length * baseLen;
          const flatParams = new Array(expected);
          let k = 0;
          for (let r = 0; r < chunk.length; r++) {
            const rowArr = chunk[r];
            for (let c = 0; c < baseLen; c++) {
              flatParams[k++] = rowArr[c];
            }
          }
          if (flatParams.length !== expected) {
            throw new Error(`Param packing mismatch: got ${flatParams.length} vs expected ${expected}`);
          }

          const sql = `INSERT INTO public.raw_jira(${effectiveInsertCols.map(quoteIdent).join(',')}) VALUES ${placeholders.join(',')}`;
          await client.query(sql, flatParams);
          total += chunk.length;
        }

        await client.query('COMMIT');
        const uploadedAt = new Date().toISOString();
        return {
          message: 'CSV cargado correctamente',
          table: 'public.raw_jira',
          mode: 'snapshot_truncate_reload',
          totalRowsReceived: rows.length,
          totalRowsInserted: total,
          totalColumnsReceived: headerRow.length,
          totalColumnsInserted: insertCols.length,
          insertedColumns: insertMapping.map(m => ({
            csvColumn: m.original,
            normalizedCsvColumn: m.base,
            occurrence: m.occ,
            dbColumn: m.targetDbCol,
          })),
          ignoredColumns: ignored,
          duplicatedColumns: duplicated,
          missingImportantColumns: missingImportant,
          uploadedAt,
        };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('UPLOAD_ERROR:', err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
