CREATE SCHEMA IF NOT EXISTS kpi;

CREATE MATERIALIZED VIEW IF NOT EXISTS kpi.mv_carryover AS
SELECT
  COALESCE(NULLIF(TRIM(sprint), ''), 'Sin sprint') AS sprint,
  COUNT(*) FILTER (WHERE LOWER(estado) NOT IN ('done','hecho','cerrado')) AS hu_pendientes
FROM public.raw_jira
GROUP BY 1;

REFRESH MATERIALIZED VIEW CONCURRENTLY kpi.mv_carryover;
