// api/upload.js
const { Pool } = require('pg');
const Busboy = require('busboy');
const { parse } = require('csv-parse/sync');

function getPgConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    };
  }
  const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE } = process.env;
  return {
    host: PGHOST,
    port: PGPORT ? Number(PGPORT) : 5432,
    user: PGUSER,
    password: PGPASSWORD,
    database: PGDATABASE,
    ssl: PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
  };
}

const CSV_TO_COL = {
  'Tipo de Incidencia': 'tipo_de_incidente',
  'Clave principal': 'clave_principal',
  'ID de la incidencia': 'id_de_la_inciencia',
  'Resumen': 'resumen',
  'Principal': 'principal',
  'Clave de incidencia': 'clave_de_inciencia',
  'Parent summary': 'parent_summary',
  'Etiquetas': 'etiquetas',
  'Sprint': 'sprint',
  'Estado': 'estado',
};
const INSERT_COLS = Object.values(CSV_TO_COL);

function pick(row, headerName) {
  const target = headerName.trim().toLowerCase();
  for (const k of Object.keys(row)) {
    if (k && k.trim().toLowerCase() === target) return row[k];
  }
  return null;
}

module.exports = async (req, res) => {
  // Fuerza JSON en TODAS las respuestas
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Solo POST
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: 'Method not allowed. Use POST.' }));
  }

  // Debe ser multipart/form-data
  const ct = req.headers['content-type'] || '';
  if (!ct.toLowerCase().includes('multipart/form-data')) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'Content-Type debe ser multipart/form-data' }));
  }

  try {
    // 1) Leer el archivo CSV por streaming
    const csvBuffer = await new Promise((resolve, reject) => {
      let fileFound = false;
      let fileBuffer = Buffer.alloc(0);

      const bb = Busboy({ headers: req.headers });

      bb.on('file', (fieldname, file) => {
        // Asegúrate de que el input en el HTML tenga name="file"
        if (fieldname === 'file') fileFound = true;
        file.on('data', (d) => { fileBuffer = Buffer.concat([fileBuffer, d]); });
        file.on('limit', () => reject(new Error('Archivo demasiado grande')));
      });

      bb.on('error', reject);
      bb.on('finish', () => {
        if (!fileFound) return reject(new Error('No se encontró archivo (campo name="file")'));
        resolve(fileBuffer);
      });

      req.pipe(bb);
    });

    // 2) Parsear CSV
    const text = csvBuffer.toString('utf8');
    const records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
    });

    if (!records.length) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'CSV vacío o sin registros.' }));
    }

    const rows = records.map((row) => ([
      pick(row, 'Tipo de Incidencia'),
      pick(row, 'Clave principal'),
      pick(row, 'ID de la incidencia'),
      pick(row, 'Resumen'),
      pick(row, 'Principal'),
      pick(row, 'Clave de incidencia'),
      pick(row, 'Parent summary'),
      pick(row, 'Etiquetas'),
      pick(row, 'Sprint'),
      pick(row, 'Estado'),
    ]));

    // 3) Conectar Postgres
    const pool = new Pool(getPgConfig());
    const client = await pool.connect();

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS raw_jira (
          id bigserial PRIMARY KEY,
          tipo_de_incidente   text,
          clave_principal     text,
          id_de_la_inciencia  text,
          resumen             text,
          principal           text,
          clave_de_inciencia  text,
          parent_summary      text,
          etiquetas           text,
          sprint              text,
          estado              text,
          uploaded_at         timestamptz DEFAULT now()
        );
      `);

      await client.query('TRUNCATE TABLE raw_jira;');

      const chunkSize = 1000;
      let inserted = 0;

      for (let i = 0; i < rows.length; i += chunkSize) {
        const slice = rows.slice(i, i + chunkSize);
        const params = [];
        const valuesClause = slice.map((r, idx) => {
          const base = idx * INSERT_COLS.length;
          params.push(...r);
          const placeholders = r.map((_, j) => `$${base + j + 1}`).join(', ');
          return `(${placeholders})`;
        }).join(', ');

        const sql = `
          INSERT INTO raw_jira (${INSERT_COLS.join(', ')})
          VALUES ${valuesClause};
        `;
        await client.query(sql, params);
        inserted += slice.length;
      }

      return res.end(JSON.stringify({ ok: true, rows: inserted }));
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err) {
    console.error('Upload error:', err);
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
  }
};
