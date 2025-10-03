// /api/upload.js
import Busboy from 'busboy';
import { getPool } from './_db.js';
import { parseCsvBuffer, collectColumns } from './_csv.js';
import { rebuildAllKpis } from './_kpi.js';

export const config = { api: { bodyParser: false } };

function readFileFromRequest(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    let fileBuffer = Buffer.alloc(0);

    bb.on('file', (_name, file) => {
      file.on('data', (d) => (fileBuffer = Buffer.concat([fileBuffer, d])));
    });
    bb.on('error', reject);
    bb.on('finish', () => resolve(fileBuffer));

    req.pipe(bb);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const buf = await readFileFromRequest(req);
    if (!buf?.length) return res.status(400).json({ ok: false, error: 'Archivo vacío' });

    const rows = parseCsvBuffer(buf);
    if (!rows.length) return res.status(400).json({ ok: false, error: 'CSV sin filas' });

    const cols = collectColumns(rows);
    const pool = getPool();
    const client = await pool.connect();

    let inserted = 0;

    try {
      await client.query('BEGIN');

      // Crea tabla RAW si no existe
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.raw_jira (
          _loaded_at TIMESTAMPTZ DEFAULT now()
        )
      `);

      // Asegura columnas del CSV como TEXT
      for (const c of cols) {
        await client.query(`ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS "${c}" TEXT`);
      }

      // Snapshot: truncar antes de insertar
      await client.query(`TRUNCATE public.raw_jira`);

      // Inserción por lotes
      const batchSize = 500;
      for (let i = 0; i < rows.length; i += batchSize) {
        const slice = rows.slice(i, i + batchSize);
        const values = [];
        const params = [];
        let p = 1;

        for (const r of slice) {
          const rowVals = cols.map(c => r[c] ?? null);
          params.push(...rowVals);
          values.push(`(${cols.map(() => `$${p++}`).join(',')})`);
        }

        const sql = `
          INSERT INTO public.raw_jira (${cols.map(c => `"${c}"`).join(',')})
          VALUES ${values.join(',')}
        `;
        await client.query(sql, params);
        inserted += slice.length;
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // ✅ Una vez confirmada la carga RAW, reconstruimos KPIs
    const executed = await rebuildAllKpis();

    return res.status(200).json({
      ok: true,
      rows: inserted,
      columns: cols.length,
      kpis_executed: executed
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
