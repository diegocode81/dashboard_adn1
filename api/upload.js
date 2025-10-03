// api/upload.js
// Serverless Function (Node.js) para subir CSV y cargarlo a Postgres (Neon)
const { Pool } = require("pg");
const Busboy = require("busboy");
const { parse } = require("csv-parse/sync");

const TABLE = process.env.TABLE_NAME || "jira_raw";
const DATABASE_URL = process.env.DATABASE_URL;

function sqlId(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

module.exports = async (req, res) => {
  const started = Date.now();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  if (!DATABASE_URL) {
    return res.status(500).json({ ok: false, error: "Missing env DATABASE_URL" });
  }

  try {
    // Leer multipart/form-data con Busboy
    const busboy = Busboy({ headers: req.headers });
    let fileBuffer = Buffer.alloc(0);
    let fileFound = false;

    await new Promise((resolve, reject) => {
      busboy.on("file", (name, file) => {
        fileFound = true;
        file.on("data", (d) => (fileBuffer = Buffer.concat([fileBuffer, d])));
        file.on("error", reject);
        file.on("end", () => {});
      });
      busboy.on("error", reject);
      busboy.on("finish", resolve);
      req.pipe(busboy);
    });

    if (!fileFound) {
      return res.status(400).json({ ok: false, error: "No file received" });
    }

    const csvText = fileBuffer.toString("utf8");

    // Parse CSV
    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
    });

    if (!records.length) {
      return res.status(400).json({ ok: false, error: "CSV sin filas" });
    }

    const headers = Object.keys(records[0]);
    const colsSql = headers.map((h) => `"${sqlId(h)}"`);

    const pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`TRUNCATE TABLE ${TABLE}`);

      // Inserción por lotes
      const BATCH = 500;
      for (let i = 0; i < records.length; i += BATCH) {
        const slice = records.slice(i, i + BATCH);
        const values = [];
        const rowsSql = [];

        slice.forEach((row) => {
          const placeholders = headers.map((_, j) => `$${values.length + j + 1}`);
          rowsSql.push(`(${placeholders.join(",")})`);
          for (const h of headers) {
            const v = row[h];
            values.push(v === "" ? null : v);
          }
        });

        const sql = `INSERT INTO ${TABLE} (${colsSql.join(",")}) VALUES ${rowsSql.join(",")}`;
        await client.query(sql, values);
      }

      await client.query("COMMIT");
      client.release();

      const elapsed = Date.now() - started;
      return res.json({ ok: true, table: TABLE, inserted: records.length, elapsed_ms: elapsed });
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      client.release();
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
