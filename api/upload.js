// api/upload.js
// Carga CSV de Jira -> TRUNCATE + INSERT en public.raw_jira
// - Inserta SOLO columnas que EXISTEN en la DB (whitelist).
// - Soporta cabeceras duplicadas sin perder valores (p. ej., "Sprint" x N).
// - Duplicados "Sprint": mapea hasta 7 -> sprint, sprint1..sprint6.
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

// Para 'sprint' mapeamos explícito hasta 7 slots
function candidateDbNamesForSprint(occ) {
  const explicit = ['sprint','sprint1','sprint2','sprint3','sprint4','sprint5','sprint6'];
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
  clave_de_incidencia: 'clave_de_inciencia',
};

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

    // 5) parse filas con las claves únicas
    const rows = parseCsv(text, {
      delimiter,
      bom: true,
      columns: columnsForParser,
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

      if (!insertCols.length) {
        throw new Error('No hay columnas mapeadas CSV->DB para insertar.');
      }

      // 8) transformar filas según mapping (orden de insertCols)
      const values = rows.map((row) => {
        const arr = new Array(insertCols.length);
        for (let i = 0; i < insertCols.length; i++) {
          const col = insertCols[i];
          const m = mapping.find(x => x.targetDbCol === col);
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

          const sql = `INSERT INTO public.raw_jira(${effectiveInsertCols.join(',')}) VALUES ${placeholders.join(',')}`;
          await client.query(sql, flatParams);
          total += chunk.length;
        }

        await client.query('COMMIT');
        return {
          inserted: total,
          usedDbColumns: insertCols,
          ignoredCsvColumns: ignored,
          headerMapping: mapping,
          uploadedAt: hasUploadedAt ? 'NOW()' : null,
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
