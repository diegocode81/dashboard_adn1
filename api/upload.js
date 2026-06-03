// Endpoint legacy de carga multipart.
// Se mantiene por compatibilidad, pero la pantalla principal usa Vercel Blob
// para evitar FUNCTION_PAYLOAD_TOO_LARGE en Vercel Free.

import formidable from 'formidable';
import fs from 'fs/promises';
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

    const buf = await fs.readFile(up.filepath);
    const result = await processJiraCsvSnapshot(buf.toString('utf8'));

    return res.status(200).json({ ok: true, source: 'multipart_legacy', ...result });
  } catch (err) {
    console.error('UPLOAD_ERROR:', err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
