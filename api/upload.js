// api/upload.js
import { Client } from 'pg';
import { parse } from 'csv-parse/sync';

export const config = {
  api: {
    bodyParser: false, // para leer el archivo tal cual (multipart)
  },
};

function readMultipart(req) {
  // Vercel/Node sin librerías: aceptamos CSV crudo (text/csv).
  // Si subes con <input type=file>, usa fetch con enctype "text/csv".
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Only POST is allowed' });
      return;
    }

    const csvText = await readMultipart(req);

    if (!csvText || !csvText.trim()) {
      res.status(400).json({ ok: false, error: 'CSV vacío o no recibido' });
      return;
    }

    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
    });

    // Conexión a Neon / Postgres desde env vars
    const con = {
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : false,
    };

    const client = new Client(con);
    await client.connect();

    // TRUNCATE + INSERT masivo
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE raw_jira');

    // Ajusta estos nombres de columnas a tu tabla raw_jira
    const cols = [
      'tipo_de_incidente', 'clave_principal', 'id_de_la_inciencia', 'resumen',
      'principal', 'clave_de_inciencia', 'parent_summary', 'etiquetas',
      'sprint', 'estado'
    ];

    const insertText = `
      INSERT INTO raw_jira (${cols.join(', ')})
      VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
    `;

    for (const r of records) {
      const values = [
        r['Tipo de Incidenc'],           // renómbralos según los headers del CSV
        r['Clave principal'],
        r['ID de la incidenci'],
        r['Resumen'],
        r['Principal'],
        r['Clave de incidenci'],
        r['Parent summary'],
        r['Etiquetas'],
        r['Sprint'],
        r['Estado'],
      ];
      await client.query(insertText, values);
    }

    await client.query('COMMIT');
    await client.end();

    res.status(200).json({ ok: true, rows: records.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
