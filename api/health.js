// api/health.js
import { Client } from 'pg';

export default async function handler(req, res) {
  try {
    const connStr = process.env.DATABASE_URL;
    if (!connStr) {
      return res.status(500).json({ ok: false, error: 'Missing env DATABASE_URL' });
    }

    // Neon recomienda ssl=require; con pg basta con esto:
    const client = new Client({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
    });

    const t0 = Date.now();
    await client.connect();
    const r = await client.query('select version() as version, now() as now;');
    await client.end();

    return res.status(200).json({
      ok: true,
      db: 'ok',
      elapsed_ms: Date.now() - t0,
      version: r.rows?.[0]?.version,
      now: r.rows?.[0]?.now,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}
