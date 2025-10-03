# api/upload.py
from flask import Flask, request, jsonify
import os, io, csv, re, time
import psycopg2
from psycopg2.extras import execute_batch, Json

app = Flask(__name__)

# ===== Config/ENV =====
PGHOST     = os.getenv("PGHOST")
PGDATABASE = os.getenv("PGDATABASE")
PGUSER     = os.getenv("PGUSER")
PGPASSWORD = os.getenv("PGPASSWORD")
KEEP_RAW   = os.getenv("KEEP_RAW", "1") == "1"   # guarda fila CSV cruda en JSONB

def get_conn():
    return psycopg2.connect(
        host=PGHOST, dbname=PGDATABASE, user=PGUSER, password=PGPASSWORD, sslmode="require"
    )

# ===== SQL: tabla + vistas =====
DDL_TABLE = """
CREATE TABLE IF NOT EXISTS jira_csv_issues (
  issue_key      TEXT PRIMARY KEY,
  summary        TEXT,
  status         TEXT,
  sprint_planned TEXT,
  sprint_done    TEXT,
  sprint_list    TEXT[],
  sort_num       INTEGER,
  raw            JSONB,
  loaded_at      TIMESTAMPTZ DEFAULT now()
);
"""

DDL_VW_KPI_SPRINT = """
CREATE OR REPLACE VIEW vw_kpi_sprint AS
SELECT
  COALESCE(sprint_planned, 'Sprint 0 - No asignado') AS sprint,
  COALESCE(sort_num, 0) AS sort_num,
  COUNT(*) AS hu_planificadas,
  COUNT(*) FILTER (WHERE sprint_done IS NOT NULL) AS hu_done
FROM jira_csv_issues
GROUP BY 1,2
ORDER BY 2,1;
"""

DDL_VW_ISSUES_FLAT = """
CREATE OR REPLACE VIEW vw_issues_flat AS
SELECT
  issue_key,
  COALESCE(summary, raw->>'Resumen', raw->>'Summary') AS summary,
  COALESCE(status,  raw->>'Estado',  raw->>'Status')  AS status,
  COALESCE(raw->>'Parent summary', raw->>'Principal', raw->>'Epic Link', raw->>'Epic') AS epic,
  COALESCE(raw->>'Assignee', raw->>'Asignado', raw->>'Responsable') AS assignee,
  NULLIF(COALESCE(
    raw->>'Story Points', raw->>'Puntos de historia', raw->>'Puntos de Historia',
    raw->>'customfield_10009', raw->>'customfield_10016'
  ), '')::numeric AS story_points,
  NULLIF(COALESCE(raw->>'Created', raw->>'Creado', raw->>'Fecha de creación'), '')::timestamptz AS created_at,
  NULLIF(COALESCE(raw->>'Updated', raw->>'Actualizado'), '')::timestamptz AS updated_at,
  NULLIF(COALESCE(raw->>'Resolution date', raw->>'Fecha de resolución'), '')::timestamptz AS resolved_at,
  sprint_planned, sprint_done, sprint_list, sort_num, raw
FROM jira_csv_issues;
"""

DDL_VW_VELOCITY_SP = """
CREATE OR REPLACE VIEW vw_velocity_sp AS
SELECT
  sprint_done AS sprint,
  MIN(sort_num) AS sort_num,
  SUM(COALESCE(story_points,0)) AS velocity_sp
FROM vw_issues_flat
WHERE sprint_done IS NOT NULL
GROUP BY sprint_done
ORDER BY sort_num;
"""

DDL_VW_ROLLOVER = """
CREATE OR REPLACE VIEW vw_rollover AS
SELECT
  sprint_done AS sprint_de_cierre,
  MIN(sort_num) AS sort_num,
  COUNT(*) AS hu_rollover
FROM vw_issues_flat
WHERE sprint_done IS NOT NULL
  AND sprint_planned IS NOT NULL
  AND sprint_done <> sprint_planned
GROUP BY sprint_done
ORDER BY sort_num;
"""

DDL_VW_EPIC_COMPLETION = """
CREATE OR REPLACE VIEW vw_epic_completion AS
SELECT
  COALESCE(epic,'Sin épica') AS epic,
  COUNT(*) AS hu_planificadas,
  COUNT(*) FILTER (WHERE sprint_done IS NOT NULL) AS hu_done,
  ROUND(100.0 * COUNT(*) FILTER (WHERE sprint_done IS NOT NULL) / NULLIF(COUNT(*),0), 1) AS pct_done
FROM vw_issues_flat
GROUP BY epic
ORDER BY pct_done DESC, hu_planificadas DESC;
"""

DDL_VW_LEAD_TIME = """
CREATE OR REPLACE VIEW vw_lead_time AS
SELECT
  sprint_done AS sprint,
  MIN(sort_num) AS sort_num,
  ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/86400.0), 2) AS leadtime_days_avg,
  ROUND(percentile_disc(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at))/86400.0), 2) AS leadtime_days_p50
FROM vw_issues_flat
WHERE resolved_at IS NOT NULL
GROUP BY sprint_done
ORDER BY sort_num;
"""

UPSERT_SQL = """
INSERT INTO jira_csv_issues
(issue_key, summary, status, sprint_planned, sprint_done, sprint_list, sort_num, raw)
VALUES (%(issue_key)s, %(summary)s, %(status)s, %(sprint_planned)s, %(sprint_done)s, %(sprint_list)s, %(sort_num)s, %(raw)s)
ON CONFLICT (issue_key) DO UPDATE
SET summary = EXCLUDED.summary,
    status = EXCLUDED.status,
    sprint_planned = EXCLUDED.sprint_planned,
    sprint_done = EXCLUDED.sprint_done,
    sprint_list = EXCLUDED.sprint_list,
    sort_num = EXCLUDED.sort_num,
    raw = EXCLUDED.raw,
    loaded_at = now();
"""

# ===== Helpers de parsing =====
DONE_TOKENS = ["done","finaliz","validado po"]
def is_done(status: str) -> bool:
    s = (status or "").lower()
    return any(t in s for t in DONE_TOKENS)

def extract_sprint_number(name: str) -> int:
    if not name: return 0
    m = re.search(r"(\d+)", name)
    return int(m.group(1)) if m else 0

def unify_sprints(row: dict) -> list:
    sprints = []
    for k,v in row.items():
        if k.lower().startswith("sprint"):
            text = (v or "").strip()
            if not text: continue
            parts = re.split(r"[;,]+", text)
            for p in parts:
                p = p.strip()
                if p and p not in sprints:
                    sprints.append(p)
    return sprints

def planned_done_sprints(sprints: list, status: str):
    if not sprints:
        return None, None, 0
    ordered = sorted(sprints, key=lambda s: extract_sprint_number(s))
    planned = ordered[0]
    sort_num = extract_sprint_number(planned)
    done = ordered[-1] if is_done(status) else None
    return planned, done, sort_num

def sniff_delimiter(content: str) -> str:
    # detección simple ; o , o \t
    if '\t' in content and ',' not in content: return '\t'
    if ';' in content and content.count(';') > content.count(','): return ';'
    return ','

# ===== Handler =====
@app.post("/")
def handle_upload():
    t0 = time.time()
    if not all([PGHOST, PGDATABASE, PGUSER, PGPASSWORD]):
        return jsonify(ok=False, error="Faltan variables de entorno de Neon (PGHOST, PGDATABASE, PGUSER, PGPASSWORD)."), 500

    if 'file' not in request.files:
        return jsonify(ok=False, error="Sube un archivo CSV con el campo 'file'."), 400

    file = request.files['file']
    content = file.read().decode('utf-8', errors='ignore')

    # Parse CSV
    delim = sniff_delimiter(content)
    reader = csv.reader(io.StringIO(content), delimiter=delim)
    try:
        raw_headers = next(reader)
    except StopIteration:
        return jsonify(ok=False, error="CSV vacío."), 400

    # headers únicos
    seen, headers = {}, []
    for h in raw_headers:
        name = (h or "").strip()
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > 1:
            name = f"{name}__{seen[name]}"
        headers.append(name)

    # detectar columnas base
    lower = [h.lower() for h in headers]
    def find_col(cands):
        for c in cands:
            if c.lower() in lower:
                return headers[lower.index(c.lower())]
        return ""

    col_key     = find_col(["key","issue key","clave de incidencia","clave principal","clave","id"])
    col_summary = find_col(["summary","resumen"])
    col_status  = find_col(["status","estado"])
    if not col_key:
        return jsonify(ok=False, error=f"No se detectó la columna de clave (Issue Key). Cabeceras: {headers}"), 400

    rows = []
    for row in reader:
        if len(row) < len(headers):
            row += [""]*(len(headers)-len(row))
        if len(row) > len(headers):
            row = row[:len(headers)]
        d = {headers[i]: row[i] for i in range(len(headers))}
        rows.append(d)

    payloads = []
    for r in rows:
        issue_key = (r.get(col_key) or "").strip()
        if not issue_key:
            continue
        summary = (r.get(col_summary) or "").strip() if col_summary else ""
        status  = (r.get(col_status)  or "").strip() if col_status else ""
        sprints = unify_sprints(r)
        planned, done, sort_num = planned_done_sprints(sprints, status)
        payloads.append({
            "issue_key": issue_key,
            "summary": summary,
            "status": status,
            "sprint_planned": planned,
            "sprint_done": done,
            "sprint_list": sprints if sprints else None,
            "sort_num": sort_num,
            "raw": Json(r) if KEEP_RAW else None
        })

    # Insertar en Neon
    with get_conn() as conn:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(DDL_TABLE)
            # TRUNCATE antes de cargar (para ahorrar espacio)
            cur.execute("TRUNCATE TABLE jira_csv_issues;")
            if payloads:
                execute_batch(cur, UPSERT_SQL, payloads, page_size=1000)
            # Vistas
            cur.execute(DDL_VW_ISSUES_FLAT)
            cur.execute(DDL_VW_KPI_SPRINT)
            cur.execute(DDL_VW_VELOCITY_SP)
            cur.execute(DDL_VW_ROLLOVER)
            cur.execute(DDL_VW_EPIC_COMPLETION)
            cur.execute(DDL_VW_LEAD_TIME)

    elapsed = int((time.time() - t0) * 1000)
    preview = payloads[:3]  # muestra 3 filas de ejemplo
    return jsonify(ok=True, rows=len(payloads), elapsed_ms=elapsed, preview=preview)
