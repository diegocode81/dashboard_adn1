import { handleUpload } from '@vercel/blob/client';

export const config = {
  api: { bodyParser: true },
  runtime: 'nodejs',
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const rawBody = await readRawBody(req);
  return rawBody ? JSON.parse(rawBody) : undefined;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: 'BLOB_READ_WRITE_TOKEN no está configurado.',
      });
    }

    const jsonResponse = await handleUpload({
      token: process.env.BLOB_READ_WRITE_TOKEN,
      request: req,
      body: await parseBody(req),
      onBeforeGenerateToken: async (pathname) => {
        if (!/\.csv$/i.test(pathname)) {
          throw new Error('Solo se permiten archivos CSV.');
        }

        return {
          allowedContentTypes: [
            'text/csv',
            'application/csv',
            'application/vnd.ms-excel',
            'text/plain',
            'application/octet-stream',
          ],
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            source: 'jira_csv_direct_upload',
            createdAt: new Date().toISOString(),
          }),
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.log('BLOB_UPLOAD_COMPLETED:', blob.url);
      },
    });

    return res.status(200).json(jsonResponse);
  } catch (err) {
    console.error('BLOB_UPLOAD_ERROR:', err);
    return res.status(400).json({
      ok: false,
      error: err?.message || 'No se pudo obtener el token de subida a Blob.',
    });
  }
}
