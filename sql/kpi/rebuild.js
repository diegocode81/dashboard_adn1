// Ejecuta TODOS los archivos *.sql en /sql/kpis en orden alfanumérico.
// Opcional: exige un token (ADMIN_TOKEN) para seguridad.
import fs from 'fs/promises';
import path from 'path';
import { getPool } from '../_db.js';

const ROOT = process.cwd();
const KPIS_DIR = path.join(ROOT, 'sql', 'kpis');

export default async function handler(req, res) {
  try {
    // auth simple (opcional)
    const token = process.env.ADMIN_TOKEN;
    if (token) {
      const auth = req.headers.authorization || '';
      const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (provided !== token) return res.status(401).json({ ok:false, error:'Unauthorized' });
    }

    const pool = getPool();
    const files = (await fs.readdir(KPIS_DIR))
      .filter(f => f.endsWith('.sql'))
      .sort();

    if (!files.length) {
      return res.status(200).json({ ok:true, executed: [], note:'No hay archivos SQL en /sql/kpis' });
    }

    const executed = [];
    for (const f of files) {
      const sql = await fs.readFile(path.join(KPIS_DIR, f), 'utf8');
      await pool.query(sql);
      executed.push(f);
    }

    return res.status(200).json({ ok:true, executed });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
}
