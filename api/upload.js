// api/upload.js
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

// Genera nombres únicos para cabeceras duplicadas sin perder ninguna
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
      const uniqueKey = `${sane}__dup${seen}`; // ej: sprint__dup1, sprint__dup2
      uniques.push({ uniqueKey, base: sane, original: h, occ: seen });
      counts.set(sane, seen + 1);
    }
  }
  return uniques;
}

// Candidatos de nombre existentes en BD para una ocurrencia (>0)
function candidateDbNames(base, occ) {
  if (occ === 0) return [base];
  // probamos varios estilos por si la tabla usa "1-based" o "_1" o ambos
  return [
    `${base}${occ}`,       // sprint1 (occ=1)
    `${base}_${occ}`,      // sprint_1
    `${base}${occ + 1}`,   // sprint2 (fallback)
    `${base}_${occ + 1}`,  // sprint_2
  ];
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
    if (fvals.length === 0) return res.status(400).json({ ok: false, error: 'Archivo no encontrado (key "file")' });
    const up = Array.isArray(fvals[0]) ? fvals[0][0] : fvals[0];

    // 2) leer archivo
    const buf = await fs.readFile(up.filepath);
    const text = buf.toString('utf8');
    const delimiter = sniffDelimiter(text);

    // 3) obtener cabeceras crudas SIN columns:true para no perder duplicados
    const headerRow = parseCsv(text, {
      delimiter,
      bom: true,
      from_line: 1,
      to_line: 1,
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: false,
    })[0]; // array con las cabeceras tal cual

    if (!headerRow || !headerRow.length) {
      return res.status(400).json({ ok: false, error: 'No se pudo leer cabeceras del CSV' });
    }

    // 4) generar claves únicas para duplicados
    const uniqueHeaders = makeUniqueHeaders(headerRow); // [{uniqueKey, base, original, occ}, ...]
    const columnsForParser = uniqueHeaders.map(x => x.uniqueKey);

    // 5) parsear el CSV ahora sí con columns = uniqueKeys
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

      // 7) construir mapping CSV(uniqueKey)->DB(target), manejando duplicados (occ)
      const mapping = [];         // [{uniqueKey, original, base, occ, targetDbCol}]
      const usedTargets = new Set();
      const ignored = [];

      for (const h of uniqueHeaders) {
        const { uniqueKey, base, original, occ } = h;
        let target = null;

        const candidates = candidateDbNames(base, occ);
        for (const c of candidates) {
          if (tableCols.has(c) && !usedTargets.has(c)) {
            target = c;
            break;
          }
        }
        // si no encontró candidato y es la ocurrencia 0, probamos el base tal cual (ya lo probamos arriba)
        // si no hay target, se ignora
        if (target) {
          mapping.push({ uniqueKey, original, base, occ, targetDbCol: target });
          usedTargets.add(target);
        } else {
          // también ignoramos columnas que no existen en DB
          ignored.push({ uniqueKey, original, base, occ, reason: 'no-matching-db-column' });
        }
      }

      const insertCols = mapping.map(m => m.targetDbCol).filter(c => c !== 'id' && c !== 'uploaded_at');
      if (!insertCols.length) throw new Error('No hay columnas mapeadas CSV->DB para insertar.');

      // 8) transformar filas según mapping (en orden de insertCols)
      const values = rows.map((row) => {
        const arr = [];
        for (const col of insertCols) {
          const m = mapping.find(x => x.targetDbCol === col);
          arr.push(toDb(row[m.uniqueKey]));
        }
        return arr;
      });

      // 9) TRUNCATE + INSERT
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
          usedDbColumns: insertCols,
          ignoredCsvColumns: ignored,
          headerMapping: mapping, // útil para debug (ver cómo se asignaron duplicados)
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
