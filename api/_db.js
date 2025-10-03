// api/_db.js
import { Pool } from 'pg';

function ensureEnv(...keys) {
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
  }
}

// Requerimos las PG* que ya configuraste en Vercel
ensureEnv('PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD');

// ssl: true para Neon (o usa { rejectUnauthorized:false } si lo prefieres)
const useSSL = (process.env.PGSSLMODE || 'require').toLowerCase() !== 'disable';
const ssl = useSSL ? { rejectUnauthorized: false } : undefined;

export const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

// Utilidad para ejecutar con client dedicado
export async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
