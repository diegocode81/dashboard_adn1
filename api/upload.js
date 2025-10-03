// api/upload.js
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // Cargar dependencias dentro del handler (para poder capturar errores)
    let Busboy, Pool, parseSync;
    try {
      Busboy = require('busboy');
    } catch (e) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'Falta dependencia: busboy', detail: String(e) }));
    }
    try {
      ({ Pool } = require('pg'));
    } catch (e) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'Falta dependencia: pg', detail: String(e) }));
    }
    try {
      ({ parse: parseSync } = require('csv-parse/sync'));
    } catch (e) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'Falta dependencia: csv-parse', detail: String(e) }));
    }

    // Solo POST con multipart/form-data
    if (req.method !== 'POST') {
      res.statusCode = 405;
      return res.end(JSON.stringify({ ok: false, error: 'Method not allowed. Usa POST.' }));
    }
    const ct = req.headers['content-type'] || '';
    if (!ct.toLowerCase().includes('multipart/form-data')) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'Content-Type debe ser multipart/form-data' }));
    }

    // Leer archivo CSV vía Busboy
    const csvBuffer = await new Promise((resolve, reject) => {
      let fileFound = false;
      let buf = Buffer.alloc(0);
      const bb = Busboy({ headers: req.headers });

      bb.on('file', (fieldname, file) => {
        if (fieldname === 'file') fileFound = true;
        file.on('data', d => { buf = Buffer.concat([buf, d]); });
        file.on('limit', () => reject(new Error('Archivo demasiado grande')));
      });
      bb.on('error', reject);
      bb.on('finish', () => {
        if (!fileFound) return reject(new Error('No se encontró archivo (campo name="file")'));
        resolve(buf);
      });

      req.pipe(bb);
    });

    // Parsear CSV
    const csvText = csvBuffer.toString('utf8');
    const records = parseSync(csvText, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
    });
    if (!records.length) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'CSV vacío o sin registros.' }));
    }

    // Mapeo de cabeceras (ajusta si cambian en tu CSV)
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
      'Estado': 'estado'
    };
    const INSERT_COLS = Object.values(CSV_TO_COL);
    const pick = (row, name) => {
      const needle = name.trim().toLowerCase();
      for (const k of Object.keys(row)) {
        if (k && k.trim().toLowerCase() === needle) return row[k];
      }
      return null;
    };

    const rows = records.map(r => ([
      pick(r, 'Tipo de Incidencia'),
      pick(r, 'Clave principal'),
      pick(r, 'ID de la incidencia'),
      pick(r, 'Resumen'),
      pick(r, 'Principal'),
      pick(r, 'Clave de incidencia'),
      pick(r, 'Parent summary'),
      pick(r, 'Etiquetas'),
      pick(r, 'Sprint'),
      pick(r, 'Estado'),
    ]));

    // Conexión a Postgres (DATABASE_URL o las PG*)
    const getPgConfig = () => {
      if (process.env.DATABASE_URL) {
        return { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };
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
    };

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

      const CHUNK = 1000;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const params = [];
        const values = chunk.map((r, idx) => {
          params.push(...r);
          const base = idx * INSERT_COLS.length;
          const ph = r.map((_, j) => `$${base + j + 1}`).join(', ');
          return `(${ph})`;
        }).join(', ');
        await client.query(
          `INSERT INTO raw_jira (${INSERT_COLS.join(', ')}) VALUES ${values};`,
          params
        );
        inserted += chunk.length;
      }

      return res.end(JSON.stringify({ ok: true, rows: inserted }));
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err) {
    // Cualquier error no previsto
    console.error('Upload error:', err);
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  }
};
