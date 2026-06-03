export const config = {
  api: { bodyParser: false },
  runtime: 'nodejs',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  return res.status(410).json({
    ok: false,
    error: 'La carga multipart directa está deshabilitada. Usa el flujo de carga directa a Vercel Blob y procesa la URL con /api/process-blob-upload.',
  });
}
