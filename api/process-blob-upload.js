import { del } from '@vercel/blob';
import { processJiraCsvSnapshot } from './_jiraCsvSnapshot.js';

export const config = {
  api: { bodyParser: true },
  runtime: 'nodejs',
};

function getBody(req) {
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

function classifyError(err) {
  if (err?.code === 'CSV_PARSE_ERROR') return 'Error parseando CSV';
  if (err?.code === 'MISSING_COLUMNS') return 'Error por columnas faltantes';
  if (err?.code === 'MISSING_TABLE') return 'Error por columnas faltantes';
  if (err?.code === 'DB_INSERT_ERROR') return 'Error insertando en base de datos';
  return 'Error procesando Blob';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let blobUrl;

  try {
    const body = getBody(req);
    blobUrl = body.url;

    if (!blobUrl || typeof blobUrl !== 'string') {
      return res.status(400).json({ ok: false, error: 'Debe enviar JSON con la URL del Blob.' });
    }

    if (!isAllowedBlobUrl(blobUrl)) {
      return res.status(400).json({ ok: false, error: 'La URL no corresponde a Vercel Blob Storage.' });
    }

    const blobRes = await fetch(blobUrl);
    if (!blobRes.ok) {
      return res.status(502).json({
        ok: false,
        error: `Error descargando Blob: HTTP ${blobRes.status}`,
      });
    }

    const contentType = blobRes.headers.get('content-type') || '';
    if (
      contentType
      && !contentType.includes('csv')
      && !contentType.includes('text/plain')
      && !contentType.includes('application/octet-stream')
      && !contentType.includes('application/vnd.ms-excel')
    ) {
      return res.status(400).json({
        ok: false,
        error: `Error procesando Blob: tipo de contenido no permitido (${contentType}).`,
      });
    }

    const text = await blobRes.text();
    const result = await processJiraCsvSnapshot(text);

    const response = {
      ok: true,
      source: 'vercel_blob',
      blobUrl,
      ...result,
    };

    try {
      await del(blobUrl);
      response.blobDeleted = true;
    } catch (cleanupErr) {
      response.blobDeleted = false;
      response.cleanupWarning = cleanupErr?.message || 'No se pudo eliminar el Blob temporal.';
      console.warn('BLOB_CLEANUP_WARNING:', cleanupErr);
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error('PROCESS_BLOB_UPLOAD_ERROR:', err);
    return res.status(500).json({
      ok: false,
      error: `${classifyError(err)}: ${err?.message || String(err)}`,
    });
  }
}
