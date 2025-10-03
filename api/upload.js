// api/upload.js
// Carga CSV de Jira -> TRUNCATE + INSERT en public.raw_jira
// Novedad: mapea cabeceras duplicadas a columnas numeradas existentes en DB (p.ej., sprint -> sprint, sprint1, sprint2)
// y sigue ignorando cualquier columna del CSV que NO exista en la DB.

import { withClient } from './_db.js';
import { parse as parseCsv } from 'csv-parse/sync';
import formidable from 'formidable';
import fs from 'fs/promises';

export const config = { api: { bodyParser: false } };

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

// Dado un baseName (p.ej. 'sprint') y un occurrenceIndex (0 = primera, 1 = segunda, ...),
// propone nombres candidatos en DB: sprint, sprint1, sprint_1, sprint2, sprint_2, ...
function candidateDbNames(baseName, occurrenceIndex) {
  if (occurrenceIndex === 0) return [baseName];
  const n = occurrenceIndex; // 1 -> segunda, 2 -> tercera...
  // orden de prueba (flexible a distintos estilos usados en la tabla):
  return [
    `${baseName}${n}`,     // sprint1
    `${baseName}_${n}`,    // sprint_1
    `${baseName}${n+1}`,   // sprint2 (fallback si la tabla usa 1-based pero nos llega 0-based)
    `${baseName}_${n+1}`,  // sprint_2
  ];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // 1) Parse multipart
    const form = formidable({ multiples: false, maxFileSize: 25 * 1024 * 1024, keepExtensions: true });
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
    });
    const fvals = Object.values(files || {});
    if (fvals.length === 0) {
      return res.status(400).json({ ok: false, error: 'Archivo no encontrado en el form-data (key "file")' });
    }
    const up = Array.isArray(fvals[0]) ? fvals[0][0] : fvals[0];

    // 2) Leer archivo
    const buf = await fs.readFile(up.filepath);
    const text = buf.toString('utf8');

    // 3) Parse CSV robusto
    const delimiter = sniffDelimiter(text);
    const rows = parseCsv(text, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      delimiter,
      cast: (value) => toDb(value),
    });
    if (!rows.length) return res.status(400).json({ ok: false, error: 'CSV vacío' });

    // 4) Conexión a BD y lectura de columnas reales
    const result = await withClient(async (client) => {
      const { rows: cols } = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'raw_jira'
      `);
      const tableColumnsSet = new Set(cols.map(r => r.column_name));
      if (tableColumnsSet.size === 0) throw new Error('La tabla public.raw_jira no existe o no tiene columnas.');

      const hasUploadedAt = tableColumnsSet.has('uploaded_at');

      // 5) Construir el MAPE0 de columnas CSV -> columnas DB, manejando DUPLICADOS
      // Recorremos las columnas del CSV en orden, llevando un contador por base sane.
      const csvHeader = Object.keys(rows[0]);
      const seenCountByBase = new Map();
      const mapping = []; // [{ source: <originalHeader>, sourceSaneBase, targetDbCol }]
      const ignored = []; // columnas que no se pueden mapear a DB
      const duplicatesHandled = []; // duplicados mapeados a sprint1/sprint2/...

      for (const original of csvHeader) {
        const base = sanitize(original);
        if (!base) { ignored.push({ original, reason: 'sanitized-empty' }); continue; }

        const occ = seenCountByBase.get(base) || 0;
        const candidates = candidateDbNames(base, occ);
        let chosen = null;
        for (const c of candidates) {
          if (tableColumnsSet.has(c) && !mapping.some(m => m.targetDbCol === c)) {
            chosen = c;
            break;
          }
        }

        if (chosen) {
          mapping.push({ source: original, sourceSaneBase: base, occurrence: occ, targetDbCol: chosen });
          if (occ > 0) duplicatesHandled.push({ original, base, occurrence: occ, mapped_to: chosen });
          seenCountByBase.set(base, occ + 1);
        } else {
          // No hay columna en DB compatible para esta ocurrencia concreta -> se ignora
          ignored.push({ original, base, occurrence: occ, reason: 'no-matching-db-column' });
          seenCountByBase.set(base, occ + 1);
        }
      }

      // Construimos la lista final de columnas destino (ordenadas según mapping)
      const insertCols = mapping
        .map(m => m.targetDbCol)
        .filter((v, i, arr) => arr.indexOf(v) === i) // únicas
        .filter(c => c !== 'id' && c !== 'uploaded_at'); // jamás insertamos id, uploaded_at lo seteamos manualmente

      if (!insertCols.length) {
        throw new Error('No hay columnas mapeadas CSV->DB para insertar.');
      }

      // 6) Transformar filas en parámetros en el MISMO orden de insertCols
      const values = rows.map((row) => {
        const out = [];
        for (const col of insertCols) {
          // Encuentra en el mapping qué header original cae en esta columna DB
          const m = mapping.find(x => x.targetDbCol === col);
          const val = row[m.source]; // usamos el header ORIGINAL exacto para extraer el valor correcto
          out.push(toDb(val));
        }
        return out;
      });

      // 7) TRUNCATE + INSERT (lotes)
      await client.query('BEGIN');
      try {
        await client.query('TRUNCATE TABLE public.raw_jira RESTART IDENTITY');

        const effectiveInsertCols = hasUploadedAt ? [...insertCols, 'uploaded_at'] : [...insertCols];
        const baseLen = insertCols.length;

        const batchSize = 1000;
        let total = 0;
        for (let i = 0; i < values.length; i += batchSize) {
          const chunk = values.slice(i, i + batchSize);
          const placeholders = chunk
            .map((_, r) => {
              const idxs = Array.from({ length: baseLen }, (_, c) => `$${r * baseLen + c + 1}`).join(',');
              return hasUploadedAt ? `(${idxs}, NOW())` : `(${idxs})`;
            })
            .join(',');
          const flatParams = chunk.flat();
          const sql = `INSERT INTO public.raw_jira(${effectiveInsertCols.join(',')}) VALUES ${placeholders}`;
          await client.query(sql, flatParams);
          total += chunk.length;
        }

        await client.query('COMMIT');
        return {
          inserted: total,
          mappedColumns: mapping,
          usedDbColumns: insertCols,
          duplicatesHandled,
          ignoredCsvColumns: ignored,
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
