// api/upload.js
// Node.js ESM en Vercel. Requiere package.json con "type":"module"
import { withClient } from './_db.js';
import { parse as parseCsv } from 'csv-parse/sync';
import formidable from 'formidable';
import fs from 'fs/promises';

export const config = {
  api: { bodyParser: false }, // necesario para formidable
};

// Normaliza nombres de columnas -> snake_case seguro para Postgres
function sanitize(name) {
  return name
    .toString()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Detecta delimitador probable (coma o punto y coma) usando las primeras líneas
function sniffDelimiter(sampleText) {
  const head = sampleText.split(/\r?\n/).slice(0, 5).join('\n');
  const commas = (head.match(/,/g) || []).length;
  const semis  = (head.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

// Convierte "" -> null, deja otros valores intactos
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
    // 1) Parsear multipart con formidable
    const form = formidable({
      multiples: false,
      maxFileSize: 10 * 1024 * 1024, // 10 MB
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

    // 2) Leemos el archivo
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
      cast: (value, context) => {
        // No forzamos numéricos aquí (raw), solo vacíos a null
        return toDb(value);
      },
    });

    if (!rows.length) {
      return res.status(400).json({ ok: false, error: 'CSV vacío' });
    }

    // 4) Conexión y carga a BD
    const inserted = await withClient(async (client) => {
      // Leer columnas reales de la tabla
      const { rows: cols } = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'raw_jira'
        ORDER BY ordinal_position
      `);

      const tableColumns = cols.map(r => r.column_name);
      if (tableColumns.length === 0) {
        throw new Error('La tabla public.raw_jira no existe o no tiene columnas.');
      }

      // Header sanitizado desde el CSV
      const header = Object.keys(rows[0]).map(sanitize);
      // Tomamos el INTERSECT entre columnas del CSV y columnas reales de la tabla
      const insertCols = tableColumns.filter(c => header.includes(c));
      if (insertCols.length === 0) {
        throw new Error('Ninguna columna del CSV coincide con las columnas de public.raw_jira (tras sanitizar nombres).');
      }

      // Mapear valores en el orden de insertCols
      const values = rows.map((row) => {
        const sane = {};
        for (const [k, v] of Object.entries(row)) sane[sanitize(k)] = v;
        return insertCols.map((c) => sane[c] ?? null);
      });

      await client.query('BEGIN');
      try {
        // Borrado total del snapshot anterior
        await client.query('TRUNCATE TABLE public.raw_jira RESTART IDENTITY');

        // Inserción por lotes
        const batchSize = 1000;
        let total = 0;
        for (let i = 0; i < values.length; i += batchSize) {
          const chunk = values.slice(i, i + batchSize);
          const placeholders = chunk
            .map((_, r) => `(${insertCols.map((__, c) => `$${r * insertCols.length + c + 1}`).join(',')})`)
            .join(',');

          const sql = `INSERT INTO public.raw_jira(${insertCols.join(',')}) VALUES ${placeholders}`;
          await client.query(sql, chunk.flat());
          total += chunk.length;
        }

        await client.query('COMMIT');
        return total;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    });

    return res.status(200).json({ ok: true, rows: inserted });
  } catch (err) {
    console.error('UPLOAD_ERROR:', err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
