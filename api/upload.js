import formidable from 'formidable';
import fs from 'fs/promises';
import { put } from '@vercel/blob';
import { processJiraCsvSnapshot } from './_jiraCsvSnapshot.js';

export const config = {
  api: { bodyParser: false, sizeLimit: '25mb' },
  runtime: 'nodejs',
};

function isCsvFile(file) {
  const name = file?.originalFilename || file?.newFilename || '';
  const type = file?.mimetype || '';
  return /\.csv$/i.test(name)
    || type === 'text/csv'
    || type === 'application/csv'
    || type === 'application/vnd.ms-excel'
    || type === 'text/plain';
}

function safeBlobPath(fileName) {
  const cleanName = (fileName || 'jira.csv')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'jira.csv';
  return `jira-imports/${Date.now()}-${cleanName}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const form = formidable({ multiples: false, maxFileSize: 25 * 1024 * 1024, keepExtensions: true });
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, parsedFiles) => (err ? reject(err) : resolve({ fields, files: parsedFiles })));
    });

    const fvals = Object.values(files || {});
    if (fvals.length === 0) {
      return res.status(400).json({ ok: false, error: 'Archivo no encontrado (key "file")' });
    }

    const up = Array.isArray(fvals[0]) ? fvals[0][0] : fvals[0];
    if (!isCsvFile(up)) {
      return res.status(400).json({ ok: false, error: 'El archivo debe ser CSV.' });
    }

    const fileBuffer = await fs.readFile(up.filepath);
    const blob = await put(safeBlobPath(up.originalFilename || up.newFilename), fileBuffer, {
      access: 'public',
      contentType: up.mimetype || 'text/csv',
    });

    const blobRes = await fetch(blob.url);
    if (!blobRes.ok) {
      return res.status(502).json({
        ok: false,
        error: `Blob creado, pero no se pudo leer el archivo: HTTP ${blobRes.status}`,
        blobUrl: blob.url,
      });
    }

    const text = await blobRes.text();
    const result = await processJiraCsvSnapshot(text);

    return res.status(200).json({
      ok: true,
      source: 'server_upload_blob',
      blobUrl: blob.url,
      ...result,
    });
  } catch (err) {
    console.error('UPLOAD_ERROR:', err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
