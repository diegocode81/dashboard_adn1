// api/upload.js
const Busboy = require('busboy');
const { parse } = require('csv-parse/sync');
const { Client } = require('pg');

function parseCsv(buffer) {
  const text = buffer.toString('utf8');
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true
  });
  return { headers: Object.keys(records[0] || {}), rows: records };
}

function mapColumns(cols) {
  // Normaliza nombres: snake_case y mínimas transformaciones
  return cols.map(c =>
    c
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
  );
}

function guessTypes(rows, headers) {
  // Heurística simple: si todas las filas son números -> numeric
  const types = {};
  headers.forEach((h) => {
    let allNumeric = true;
    for (const r of rows) {
      const v = (r[h] ?? '').toString().trim();
      if (v === '' || v.toLowerCase() === 'null') continue;
      if (isNaN(Number(v))) { allNumeric = false; break; }
    }
    types[h] = allNumeric ? 'numeric' : 'text';
  });
  return types;
}

async function upsertTable(client, table, headers, rows) {
  // Normaliza columnas
  const norm = mapColumns(headers);
  const types = guessTypes(rows, headers);

  // Crea tabla si no existe
  const colsDDL = norm.map((n, i) => `"${n}" ${types[headers[i]]}`).join(', ');
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${table}" (
      id bigserial PRIMARY KEY,
      ${colsDDL}
    )
  `);

  // Trunca
  await client.query(`TRUNCATE TABLE "${table}"`);

  // Inserta por lotes
  const batchSize = 1000;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const values = [];
    const placeholders = [];

    slice.forEach((r, idx) => {
      const rowValues = norm.map((n, j) => r[headers[j]] ?? null);
      values.push(...rowValues);
      const base = idx * norm.length;
      const ph = norm.map((_, k) => `$${base + k + 1}`);
      placeholders.push(`(${ph.join(',')})`);
    });

    const sql = `
      INSERT INTO "${table}" (${norm.map(n => `"${n}"`).join(', ')})
      VALUES ${placeholders.join(', ')}
    `;
    await client.query(sql, values);
    inserted += slice.length;
  }

  return inserted;
}

module.exports = async (req, res) => {
  const start = Date.now();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const DATABASE_URL = process.env.DATABASE_URL;
    const TABLE_NAME = process.env.TABLE_NAME || 'jira_raw';

    if (!DATABASE_URL) {
      return res.status(500).json({ ok: false, error: 'Missing env DATABASE_URL' });
    }

    // ---- parse multipart con Busboy ----
    const buf = await new Promise((resolve, reject) => {
      const bb = Busboy({ headers: req.headers });
      let chunks = [];
      let fileFound = false;

      bb.on('file', (_name, file) => {
        fileFound = true;
        file.on('data', (d) => chunks.push(d));
        file.on('end', () => {});
      });

      bb.on('error', reject);
      bb.on('finish', () => {
        if (!fileFound) return reject(new Error('No file field found'));
        resolve(Buffer.concat(chunks));
      });

      req.pipe(bb);
    });

    const { headers, rows } = parseCsv(buf);
    if (!rows.length) {
      return res.status(400).json({ ok: false, error: 'CSV without rows' });
    }

    const client = new Client({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    await client.connect();

    let inserted = 0;
    try {
      inserted = await upsertTable(client, TABLE_NAME, headers, rows);
    } finally {
      await client.end();
    }

    return res.status(200).json({
      ok: true,
      table: TABLE_NAME,
      inserted,
      elapsed_ms: Date.now() - start
    });

  } catch (err) {
    // Log y respuesta JSON (evitamos HTML)
    console.error('[upload] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message,
      stack: err.stack
    });
  }
};
