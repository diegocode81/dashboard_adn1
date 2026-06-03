import { handleUpload } from '@vercel/blob/client';

export const config = {
  api: { bodyParser: true },
  runtime: 'nodejs',
};

function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return req.body;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const jsonResponse = await handleUpload({
      body,
      request: req,
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
          ],
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            source: 'jira_csv_snapshot',
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
      error: err?.message || 'Error subiendo archivo a Blob.',
    });
  }
}
