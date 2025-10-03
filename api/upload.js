// api/upload.js
import { withClient } from './_db.js';
import { parse as parseCsv } from 'csv-parse/sync';
import formidable from 'formidable';
import fs from 'fs/promises';

export const config = {
  api: {
    bodyParser: false, // imprescindible para formidable
  },
};

// Sanitiza nombres de columnas como hicimos antes
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

async function runKpiSql(client) {
  // Aquí puedes ejecutar tus SQLs de KPIs (vistas/materializaciones) si lo deseas.
  // Ejemplo:
  // await client.query(`CREATE OR REPLACE VIEW vw_kpi_x AS ...;`);
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
      maxFileSize: 10 * 1024 * 1024, // 10MB
      keepExtensions: true,
    });

    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err);
        resolve({ fields, files });
      });
    });

    // Tomamos el primer archivo que llegue
    let up;
    const fvals = Object.values(files || {});
    if (fvals.length === 0) {
      return res.status(400).json({ ok: false, error: 'Archivo no encontrado en el form-data' });
    }
    up = Array.isArray(fvals[0]) ? fvals[0][0] : fvals[0];

    // 2) Leemos el archivo a Buffer
    const buf = await fs.readFile(up.filepath);

    // 3) Parseo CSV
    const csv = parseCsv(buf, { columns: true, skip_empty_lines: true });
    if (!csv.length) {
      return res.status(400).json({ ok: false, error: 'CSV vacío' });
    }

    // 4) Carga en BD: truncar e insertar
    const inserted = await withClient(async (client) => {
      // columnas reales de la tabla
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

      const header = Object.keys(csv[0]).map(sanitize);
      const insertCols = tableColumns.filter((c) => header.includes(c));
      if (insertCols.length === 0) {
        throw new Error('Ninguna columna del CSV coincide con columnas de raw_jira.');
      }

      const values = csv.map((row) => {
        const sane = {};
        for (const [k, v] of Object.entries(row)) sane[sanitize(k)] = v;
        return insertCols.map((c) => sane[c] ?? null);
      });

      await client.query('BEGIN');
      await client.query('TRUNCATE TABLE raw_jira');

      // Inserción por lotes
      const batchSize = 1000;
      let total = 0;
      for (let i = 0; i < values.length; i += batchSize) {
        const chunk = values.slice(i, i + batchSize);
        const placeholders = chunk
          .map((_, r) => `(${insertCols.map((__, c) => `$${r * insertCols.length + c + 1}`).join(',')})`)
          .join(',');

        const sql = `INSERT INTO raw_jira(${insertCols.join(',')}) VALUES ${placeholders}`;
        await client.query(sql, chunk.flat());
        total += chunk.length;
      }

      // Ejecutar SQLs de KPIs si aplica
      await runKpiSql(client);

      await client.query('COMMIT');
      return total;
    });

    return res.status(200).json({ ok: true, rows: inserted });
  } catch (err) {
    console.error('UPLOAD_ERROR:', err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
