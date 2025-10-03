// api/health.js
import { Client } from 'pg';

export default async function handler(req, res) {
  try {
    // Armamos la conexión desde variables de entorno típicas de Postgres
    const con = {
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : false,
    };

    const client = new Client(con);
    const start = Date.now();
    await client.connect();
    const dbInfo = await client.query('select version()');
    await client.end();

    res.status(200).json({
      ok: true,
      db: 'ok',
      elapsed_ms: Date.now() - start,
      version: dbInfo.rows[0].version,
      now: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
