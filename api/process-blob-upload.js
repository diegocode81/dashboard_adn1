import { processJiraCsvSnapshot } from './_jiraCsvSnapshot.js';

export const config = {
  api: { bodyParser: true },
  runtime: 'nodejs',
};

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return req.body || {};
}

function isAllowedBlobUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && (
        parsed.hostname.endsWith('.blob.vercel-storage.com')
        || parsed.hostname.endsWith('.public.blob.vercel-storage.com')
      );
  } catch {
    return false;
  }
}

function errorMessage(err) {
  if (err?.code === 'CSV_PARSE_ERROR') return `Error parseando CSV: ${err.message}`;
  if (err?.code === 'MISSING_COLUMNS' || err?.code === 'MISSING_TABLE') {
    return `Error por columnas faltantes: ${err.message}`;
  }
  if (err?.code === 'DB_INSERT_ERROR') return `Error insertando en base de datos: ${err.message}`;
  return err?.message || String(err);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { url } = parseBody(req);

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ ok: false, error: 'Debe enviar JSON con el campo url.' });
    }

    if (!isAllowedBlobUrl(url)) {
      return res.status(400).json({ ok: false, error: 'La URL no corresponde a Vercel Blob Storage.' });
    }

    const blobRes = await fetch(url);
    if (!blobRes.ok) {
      return res.status(502).json({
        ok: false,
        error: `Error descargando CSV desde Blob: HTTP ${blobRes.status}`,
      });
    }

    const text = await blobRes.text();
    const result = await processJiraCsvSnapshot(text);

    return res.status(200).json({
      ok: true,
      ...result,
      message: 'CSV cargado correctamente desde Blob',
      mode: 'blob_direct_upload_snapshot',
      blobUrl: url,
    });
  } catch (err) {
    console.error('PROCESS_BLOB_UPLOAD_ERROR:', err);
    return res.status(500).json({
      ok: false,
      error: errorMessage(err),
    });
  }
}
