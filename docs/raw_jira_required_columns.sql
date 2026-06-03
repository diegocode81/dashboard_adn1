-- Columnas sugeridas para public.raw_jira orientadas a analisis QA de Jira ADN PRO.
-- Este archivo es documental: no se ejecuta automaticamente.
-- No elimina columnas, no elimina tablas y no ejecuta TRUNCATE.

-- Clave de incidencia Jira, por ejemplo ADNPRO-123.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS clave_de_incincia text;

-- ID interno de incidencia Jira.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS id_de_la_inciencia text;

-- Resumen/titulo de la incidencia Jira.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS resumen text;

-- Tipo de incidencia: Bug, Historia, Tarea, Incidente u otro.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS tipo_de_incidente text;

-- Estado actual dentro del workflow Jira.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS estado text;

-- Prioridad definida en Jira.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS prioridad text;

-- Persona asignada en Jira.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS persona_asignada text;

-- Usuario informador/reportador en Jira.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS informador text;

-- Fecha de creacion de la incidencia.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS fecha_creacion text;

-- Fecha de ultima actualizacion de la incidencia.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS actualizada text;

-- Fecha de resolucion/cierre de la incidencia.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS fecha_cierre text;

-- Sprint principal. Jira puede exportar varias columnas Sprint.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS sprint text;
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS sprint1 text;
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS sprint2 text;
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS sprint3 text;
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS sprint4 text;
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS sprint5 text;
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS sprint6 text;
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS sprint7 text;
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS sprint8 text;
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS sprint9 text;
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS sprint10 text;

-- Team Name exportado desde Jira.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS team_name text;

-- Campo personalizado Jira: Responsable QA.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS responsable_qa text;

-- Campo personalizado Jira: Puntos de Historia.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS story_points text;

-- Campo personalizado Jira: Criticidad.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS criticidad text;

-- Campo personalizado Jira: Fecha en Pruebas QA.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS fecha_en_pruebas_qa text;

-- Campo personalizado Jira: Fecha pase a produccion.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS fecha_pase_a_produccion text;

-- Campo Jira: Principal.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS principal text;

-- Campo Jira: Clave principal / parent key.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS clave_principal text;

-- Campo Jira: Parent summary.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS parent_summary text;

-- Timestamp tecnico de carga del snapshot.
ALTER TABLE public.raw_jira ADD COLUMN IF NOT EXISTS uploaded_at timestamptz;
