// api/upload.js
// Carga CSV de Jira -> TRUNCATE + INSERT en public.raw_jira
// Reglas:
// - Solo inserta columnas que EXISTEN ya en la DB (whitelist).
// - Si el CSV trae cabeceras duplicadas (tras sanitizar), conserva la PRIMERA y descarta las demás.
// - uploaded_at se llena con NOW() si existe la columna en la tabla.

import { withClient } from './_db.js';
import { parse as parseCsv } from 'csv-parse/sync';
import formidable from 'formidable';
import fs from 'fs/promises';

export const config = {
  api: { bodyParser: false }, // necesario para formidable
};

// Sanitiza nombres igual que usamos para crear la tabla (snake_case ASCII)
function sanitize(name) {
  return name
    .toString()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')     // no alfanum -> _
    .replace(/^_+|_+$/g, '');        // sin _ al borde
}

// Detecta delimitador probable (coma o punto y coma)
function sniffDelimiter(sampleText) {
  const head = sampleText.split(/\r?\n/).slice(0, 5).join('\n');
  const commas = (head.match(/,/g) || []).length;
  const semis  = (head.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

// "" -> null
function toDb(v) {
  if (v === '') return null;
  return v;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // 1) Parsear multipart
    const form = formidable({
      multiples: false,
      maxFileSize: 25 * 1024 * 1024, // 25MB por si tu CSV crece
      keepExtensions: true,
    });
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err);
        resolve({ fields, files });
      });
    });
    const fvals = Object.values(files || {});
    if (fvals.length === 0) {
      return res.status(400).json({ ok: false, error: 'Archivo no encontrado en el form-data (key "file")' });
    }
    const up = Array.isArray(fvals[0]) ? fvals[0][0] : fvals[0];

    // 2) Leer archivo
    const buf = await fs.readFile(up.filepath);
    const text = buf.toString('utf8');

    // 3) Parseo CSV robusto
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
    if (!rows.length) {
      return res.status(400).json({ ok: false, error: 'CSV vacío' });
    }

    // 4) Preparar header del CSV con control de duplicados
    const originalHeader = Object.keys(rows[0]);
    const seen = new Set();
    const headerKept = [];          // nombres sanitizados que conservamos
    const headerKeptOriginals = []; // nombres originales correspondientes
    const dupesDiscarded = [];      // lista de duplicados descartados (original -> sane)

    for (const h of originalHeader) {
      const sane = sanitize(h);
      if (!sane) continue; // ignora vacíos tras sanitizar
      if (seen.has(sane)) {
        dupesDiscarded.push({ original: h, sane });
        continue; // descarta duplicados, conservamos la primera aparición
      }
      seen.add(sane);
      headerKept.push(sane);
      headerKeptOriginals.push(h);
    }

    // 5) Conexión y carga a BD
    const result = await withClient(async (client) => {
      // Columnas existentes en la tabla (whitelist)
      const { rows: cols } = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'raw_jira'
      `);

      const tableColumnsSet = new Set(cols.map(r => r.column_name));
      if (tableColumnsSet.size === 0) throw new Error('La tabla public.raw_jira no existe o no tiene columnas.');

      // Columnas que SÍ vamos a insertar: intersección (excluye id; uploaded_at lo añadimos nosotros)
      const allowedInsertCols = headerKept.filter(c => tableColumnsSet.has(c) && c !== 'id' && c !== 'uploaded_at');

      // Si no hay intersección, error explícito
      if (!allowedInsertCols.length) {
        throw new Error('Ninguna columna del CSV coincide con columnas de public.raw_jira.');
      }

      // ¿Tenemos uploaded_at en la tabla?
      const hasUploadedAt = tableColumnsSet.has('uploaded_at');

      // Mapear filas → valores en orden de allowedInsertCols
      const values = rows.map((row) => {
        const saneRow = {};
        for (const [k, v] of Object.entries(row)) saneRow[sanitize(k)] = v;
        const arr = allowedInsertCols.map((c) => (c in saneRow ? toDb(saneRow[c]) : null));
        return arr;
      });

      // Configurar SQL de inserción
      // Si existe uploaded_at, lo seteamos a NOW() para todas las filas
      const insertCols = hasUploadedAt ? [...allowedInsertCols, 'uploaded_at'] : [...allowedInsertCols];

      await client.query('BEGIN');
      try {
        await client.query('TRUNCATE TABLE public.raw_jira RESTART IDENTITY');

        const batchSize = 1000;
        let total = 0;
        for (let i = 0; i < values.length; i += batchSize) {
          const chunk = values.slice(i, i + batchSize);

          // Parametrización
          const placeholders = chunk
            .map((_, r) => {
              const base = insertCols.length - (hasUploadedAt ? 1 : 0);
              const idxs = [];
              for (let c = 0; c < base; c++) {
                idxs.push(`$${r * base + c + 1}`);
              }
              // uploaded_at = NOW() (no es parámetro)
              return hasUploadedAt ? `(${idxs.join(',')}, NOW())` : `(${idxs.join(',')})`;
            })
            .join(',');

          const flatParams = chunk.flat(); // solo params de las columnas permitidas (sin uploaded_at)
          const sql = `INSERT INTO public.raw_jira(${insertCols.join(',')}) VALUES ${placeholders}`;
          await client.query(sql, flatParams);
          total += chunk.length;
        }

        await client.query('COMMIT');
        return {
          inserted: total,
          allowedInsertCols,
          ignoredNewCsvCols: headerKept.filter(c => !tableColumnsSet.has(c)), // columnas que venían en CSV pero NO están en DB (se ignoran)
          dupesDiscarded,
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
