-- /sql/kpis/01_plan_vs_done.sql
CREATE SCHEMA IF NOT EXISTS kpi;

CREATE MATERIALIZED VIEW IF NOT EXISTS kpi.mv_plan_vs_done AS
SELECT
  COALESCE(NULLIF(TRIM(sprint), ''), 'Sin sprint') AS sprint,
  COUNT(*) FILTER (WHERE estado IS NOT NULL)                           AS hu_planificadas,
  COUNT(*) FILTER (WHERE LOWER(estado) IN ('done','hecho','cerrado')) AS hu_done,
  CASE
    WHEN COUNT(*) FILTER (WHERE estado IS NOT NULL) = 0 THEN 0
    ELSE ROUND(
      100.0 * COUNT(*) FILTER (WHERE LOWER(estado) IN ('done','hecho','cerrado'))
      / (COUNT(*) FILTER (WHERE estado IS NOT NULL))
    , 2)
  END AS pct_cumplimiento
FROM public.raw_jira
GROUP BY 1;

-- (re)calcular con la nueva carga
REFRESH MATERIALIZED VIEW kpi.mv_plan_vs_done;
