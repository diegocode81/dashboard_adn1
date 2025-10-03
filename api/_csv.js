import { parse } from 'csv-parse/sync';

// Normaliza cabeceras: "Clave de incidencia" -> "clave_de_incidencia"
export function normalizeKey(k) {
  return String(k)
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '_')
    .replace(/[^\w_]+/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function parseCsvBuffer(buf) {
  const text = buf.toString('utf8');
  const rows = parse(text, { columns: true, skip_empty_lines: true });
  return rows.map(r => {
    const obj = {};
    for (const [k, v] of Object.entries(r)) {
      obj[normalizeKey(k)] = v;
    }
    return obj;
  });
}

export function collectColumns(rows) {
  const set = new Set();
  for (const r of rows) for (const k of Object.keys(r)) set.add(k);
  return [...set];
}
