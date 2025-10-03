// api/upload.js
const { Pool } = require('pg');
const Busboy = require('busboy');
const { parse } = require('csv-parse/sync');

/**
 * Construye la configuración de conexión a Postgres.
 * Usa DATABASE_URL si existe; si no, usa las variables sueltas (PGHOST, etc.)
 */
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

/**
 * Mapeo de cabeceras del CSV (Jira) a columnas en la tabla raw_jira
 * Si tu CSV tiene otros encabezados, ajústalos aquí.
 */
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

// columnas en el INSERT (en este orden)
const INSERT_COLS = Object.values(CSV_TO_COL);

// helper para buscar un valor en la fila por nombre de cabecera, ignorando mayúsculas/espacios
function pick(row, headerName) {
  const target = headerName.trim().toLowerCase();
  for (const k of Object.keys(row)) {
    if (k && k.trim().toLowerCase() === target) return row[k];
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ ok: false, error: 'Method not allowed. Use POST.' });
  }

  try {
    // 1) Parsear multipart/form-data y obtener el CSV como Buffer
    const csvBuffer = await new Promise((resolve, reject) => {
      const bb = Busboy({ headers: req.headers });
      let fileBuffer = Buffer.alloc(0);
      let fileFound = false;

      bb.on('file', (_name, file /* Readable */, _info) => {
        fileFound = true;
        file.on('data', (data) => {
          fileBuffer = Buffer.concat([fileBuffer, data]);
        });
      });

      bb.on('error', reject);

      bb.on('finish', () => {
        if (!fileFound) {
          return reject(new Error('No se encontró archivo en el formulario (campo file).'));
        }
        resolve(fileBuffer);
      });

      req.pipe(bb);
    });

    // 2) Parsear CSV
    const text = csvBuffer.toString('utf8');
    const records = parse(text, {
      columns: true,            // devuelve objetos con las cabeceras como claves
      skip_empty_lines: true,
      bom: true,                // por si viene con BOM
      trim: true,
    });

    if (!records.length) {
      return res.status(400).json({ ok: false, error: 'CSV vacío o sin registros.' });
    }

    // 3) Preparar datos a insertar (en el orden de INSERT_COLS)
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

    // 4) Conexión a Postgres
    const pool = new Pool(getPgConfig());
    const client = await pool.connect();

    try {
      // 4.1) Crear tabla si no existe (para evitar el error de "relation does not exist")
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

      // 4.2) Limpiar snapshot anterior
      await client.query('TRUNCATE TABLE raw_jira;');

      // 4.3) Insert masivo en bloques
      const chunkSize = 1000; // ajusta si el CSV es muy grande
      let inserted = 0;

      for (let i = 0; i < rows.length; i += chunkSize) {
        const slice = rows.slice(i, i + chunkSize);

        const params = [];
        const valuesClause = slice
          .map((r, idx) => {
            const base = idx * INSERT_COLS.length;
            params.push(...r);
            const placeholders = r.map((_, j) => `$${base + j + 1}`).join(', ');
            return `(${placeholders})`;
          })
          .join(',\n');

        const sql = `
          INSERT INTO raw_jira (${INSERT_COLS.join(', ')})
          VALUES ${valuesClause};
        `;

        await client.query(sql, params);
        inserted += slice.length;
      }

      return res.json({ ok: true, rows: inserted });
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err) {
    console.error('Upload error:', err);
    res.statusCode = 500;
    return res.json({ ok: false, error: err.message || String(err) });
  }
};
