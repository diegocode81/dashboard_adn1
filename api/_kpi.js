// /api/_kpi.js
import fs from 'fs/promises';
import path from 'path';
import { getPool } from './_db.js';

const KPIS_DIR = path.join(process.cwd(), 'sql', 'kpis');

export async function rebuildAllKpis() {
  const pool = getPool();

  // Si no existe la carpeta, no falla:
  const files = await fs.readdir(KPIS_DIR).catch(() => []);
  const executed = [];

  // Ejecuta *.sql en orden alfanumérico
  for (const f of files.sort()) {
    if (!f.endsWith('.sql')) continue;
    const sql = await fs.readFile(path.join(KPIS_DIR, f), 'utf8');
    await pool.query(sql);
    executed.push(f);
  }

  return executed;
}
