import { handleUpload } from '@vercel/blob/client';

export const config = {
  api: {
    bodyParser: true,
  },
};

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({
      ok: false,
      error: 'Method not allowed',
    });
  }

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return response.status(500).json({
        ok: false,
        step: 'MISSING_BLOB_READ_WRITE_TOKEN',
        error: 'Falta configurar BLOB_READ_WRITE_TOKEN en Vercel Environment Variables',
      });
    }

    const body = request.body;

    const jsonResponse = await handleUpload({
      request,
      body,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname || !pathname.toLowerCase().endsWith('.csv')) {
          throw new Error('Solo se permiten archivos CSV.');
        }

        return {
          allowedContentTypes: [
            'text/csv',
            'application/csv',
            'application/vnd.ms-excel',
            'text/plain',
          ],
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            source: 'jira_csv_direct_upload',
            createdAt: new Date().toISOString(),
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log('BLOB_UPLOAD_COMPLETED', {
          url: blob.url,
          pathname: blob.pathname,
          tokenPayload,
        });
      },
    });

    return response.status(200).json(jsonResponse);
  } catch (error) {
    console.error('BLOB_UPLOAD_ERROR', error);

    return response.status(400).json({
      ok: false,
      step: 'BLOB_UPLOAD_TOKEN_ERROR',
      error: error?.message || 'No se pudo generar el token de subida a Blob.',
      details: error?.stack || null,
    });
  }
}
