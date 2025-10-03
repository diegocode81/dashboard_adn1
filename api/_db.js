// api/_db.js
import { Pool } from 'pg';

// Usa DATABASE_URL o construye desde variables separadas de Neon
const connectionString = process.env.DATABASE_URL
  || `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT ?? 5432}/${process.env.PGDATABASE}?sslmode=require`;

const pool = global.__pgPool ?? new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Neon pooler requiere SSL
});
if (!global.__pgPool) global.__pgPool = pool;

export async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
