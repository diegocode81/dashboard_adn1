# Análisis técnico - QA Jira KPI Dashboard

## 1. Resumen ejecutivo

El repositorio actual implementa una aplicación web mínima para cargar un CSV exportado desde Jira, procesarlo en una función serverless y reemplazar el contenido de una tabla PostgreSQL llamada `public.raw_jira`. La interfaz se encuentra en `public/index.html`, el backend está en la carpeta `api/` y la persistencia usa PostgreSQL/Neon mediante la dependencia `pg`.

El sistema ya contiene una base técnica relacionada con Jira, carga de archivos, normalización de columnas y almacenamiento de datos crudos. No se encontró un dashboard interno, motor de KPIs, autenticación, roles, permisos, pruebas automatizadas, modelos formales ni integración con Jira API. El dashboard actualmente se consume mediante un enlace externo a Grafana desde el HTML público.

Inferencia técnica: el nuevo módulo provisional "QA Jira KPI Dashboard" debería evolucionar desde la capacidad existente de ingesta CSV/Jira, pero conviene separarlo conceptualmente en tres capas: ingesta/validación de archivo, normalización/análisis de tarjetas Jira y visualización de KPIs. En el estado actual, la primera etapa más segura es un MVP documental y funcionalmente acotado basado en carga manual de Excel/CSV, cálculo de KPIs básicos y una visualización simple, sin asumir integración directa con Jira API.

## 2. Arquitectura actual del sistema

### Framework utilizado

No encontrado como framework explícito en el repositorio. No existe configuración de Next.js, Vite, React, Express, NestJS ni otro framework de aplicación.

Inferencia técnica: por la estructura `api/*.js`, las exportaciones `default async function handler(req, res)` y el README que indica despliegue en Vercel, el proyecto parece estar diseñado para Vercel Serverless Functions con archivos estáticos servidos desde `public/`.

### Lenguaje principal

JavaScript con módulos ES (`"type": "module"` en `package.json`).

### Estructura de carpetas

- `api/`: endpoints backend serverless.
- `public/`: frontend estático.
- `docs/`: carpeta documental creada para este análisis.
- `.git/`: control de versiones.

Archivos versionados relevantes:

- `api/upload.js`
- `api/_db.js`
- `api/health.js`
- `public/index.html`
- `package.json`
- `README`

No encontrado:

- `src/`
- `components/`
- `services/`
- `lib/`
- `models/`
- `tests/`
- migraciones de base de datos
- configuración de CI/CD
- configuración explícita de Vercel
- lockfile de dependencias

### Arquitectura frontend/backend

Frontend:

- Implementado como HTML, CSS y JavaScript vanilla en `public/index.html`.
- Contiene un formulario de carga de archivo CSV.
- Usa `fetch('/api/upload', { method: 'POST', body: fd })` para enviar el archivo.
- Muestra la respuesta JSON en pantalla.
- Incluye un enlace externo a Grafana para visualizar un dashboard.

Backend:

- Implementado como funciones serverless en `api/`.
- `api/upload.js`: recibe un archivo multipart, parsea CSV, mapea columnas y carga datos en PostgreSQL.
- `api/_db.js`: administra un pool compartido de PostgreSQL.
- `api/health.js`: valida conectividad a PostgreSQL y devuelve versión, latencia y timestamp.

### Sistema de rutas

Rutas encontradas:

- `/`: servido por `public/index.html`.
- `/api/upload`: endpoint `POST` para carga de CSV.
- `/api/health`: endpoint para health check de base de datos.

No encontrado:

- routing frontend con React Router, Next.js App Router, Pages Router u otro mecanismo.
- rutas internas para dashboards, reportes, QA o administración.

### Componentes principales

No encontrado un sistema de componentes formal.

Elementos principales actuales:

- Interfaz de carga en `public/index.html`.
- Handler de carga en `api/upload.js`.
- Helper de base de datos en `api/_db.js`.
- Health check en `api/health.js`.

### Servicios existentes

Servicios internos encontrados:

- `withClient(fn)` en `api/_db.js`: helper para adquirir y liberar clientes PostgreSQL desde un pool global.
- Handler de carga CSV en `api/upload.js`.
- Handler de health check en `api/health.js`.

Servicios externos mencionados:

- Neon para base de datos, indicado en `README`.
- GitHub para versionamiento, indicado en `README`.
- Vercel para despliegue, indicado en `README`.
- Grafana para dashboard externo, indicado en `README` y enlazado desde `public/index.html`.

### Manejo actual de archivos, formularios o cargas

Encontrado en `public/index.html` y `api/upload.js`.

Frontend:

- Input de archivo con `accept=".csv,text/csv"`.
- Construcción de `FormData`.
- Envío bajo la key `file`.
- Estado visual de carga con spinner.
- Renderizado de respuesta JSON o error.

Backend:

- `formidable` parsea multipart con `multiples: false`, `maxFileSize: 25 * 1024 * 1024` y `keepExtensions: true`.
- El endpoint declara `bodyParser: false`, `sizeLimit: '25mb'` y `runtime: 'nodejs'`.
- Lee el archivo temporal con `fs.readFile(up.filepath)`.
- Convierte el buffer a UTF-8.
- Detecta delimitador `,` o `;`.
- Procesa CSV con `csv-parse/sync`.

Observación: el HTML muestra "Acepta archivos hasta ~10MB", pero el backend configura `25mb`. Existe una inconsistencia de comunicación de límite.

### Manejo actual de dashboards, gráficos o reportes

Dashboard interno: No encontrado.

Gráficos internos: No encontrado.

Reportes internos: No encontrado.

Se encontró un enlace externo a Grafana en `public/index.html`:

- `https://diegocode81.grafana.net/public-dashboards/b7913af3102248a48f901f8b37d637ea`

Inferencia técnica: actualmente el repositorio se encarga principalmente de ingestar datos hacia PostgreSQL y delega la visualización avanzada a Grafana.

### Manejo actual de autenticación, roles o permisos

No encontrado.

No existen guards, sesiones, JWT, OAuth, middleware de autorización, roles, permisos ni restricciones visibles en frontend/backend.

Riesgo: cualquier usuario con acceso a la URL podría intentar ejecutar `/api/upload` y reemplazar la tabla `public.raw_jira`, salvo que existan controles externos no presentes en el repositorio.

### Manejo actual de persistencia de datos

Persistencia encontrada:

- PostgreSQL mediante `pg`.
- Conexión a través de `DATABASE_URL` o variables `PGUSER`, `PGPASSWORD`, `PGHOST`, `PGPORT`, `PGDATABASE`.
- SSL configurado con `rejectUnauthorized: false`.
- Tabla esperada: `public.raw_jira`.

Comportamiento de carga:

- Consulta `information_schema.columns` para obtener columnas reales de `public.raw_jira`.
- Usa whitelist de columnas existentes en base.
- Ejecuta `TRUNCATE TABLE public.raw_jira RESTART IDENTITY`.
- Inserta por lotes de hasta 500 filas, respetando un límite aproximado de 60.000 parámetros PostgreSQL.
- Usa transacción `BEGIN`, `COMMIT` y `ROLLBACK`.
- Agrega `uploaded_at = NOW()` si la columna existe.

No encontrado:

- esquema SQL de `public.raw_jira`.
- migraciones.
- histórico de cargas.
- versionamiento de snapshots.
- modelo relacional documentado.

## 3. Módulos existentes relacionados

### QA

No encontrado como módulo explícito.

Inferencia técnica: los datos Jira podrían contener issues de QA, bugs o incidencias, pero el repositorio no implementa lógica específica de QA.

### Métricas

No encontrado como módulo interno.

Inferencia técnica: el dashboard externo de Grafana puede contener métricas, pero el repositorio no incluye consultas, paneles, definiciones de KPIs ni lógica de cálculo.

### Dashboards

Encontrado solo como enlace externo a Grafana en `public/index.html` y mención en `README`.

No encontrado dashboard interno.

### Reportes

No encontrado.

### Importación de archivos

Encontrado.

El sistema importa CSV exportado desde Jira mediante `public/index.html` y `/api/upload`.

### Procesamiento de Excel, CSV o JSON

CSV:

- Encontrado mediante `csv-parse/sync`.
- Hay normalización de cabeceras, detección de delimitador y soporte para cabeceras duplicadas.

Excel:

- No encontrado.
- No existe dependencia como `xlsx`, `exceljs` u otra librería de lectura XLS/XLSX.

JSON:

- Se usa JSON como formato de respuesta HTTP.
- No encontrado procesamiento de archivos JSON de entrada.

### Gestión de proyectos

No encontrado como módulo.

Se encontró una referencia funcional en el HTML: CSV exportado desde Jira con filtro `project = ADN1`.

### Jira o issues

Encontrado.

Evidencias:

- `api/upload.js` indica carga "CSV de Jira".
- `public/index.html` titula "Subir CSV de Jira".
- La tabla destino es `public.raw_jira`.
- Existen equivalencias de cabeceras Jira hacia columnas de base de datos.
- Se manejan columnas como `sprint`, `story_points`, `tipo_de_incidente`, `fecha_creacion` y `fecha_cierre`.

## 4. Dependencias relevantes encontradas

Dependencias en `package.json`:

- `csv-parse`: parseo de CSV.
- `formidable`: recepción de archivos multipart.
- `pg`: conexión a PostgreSQL.

Dependencias no encontradas:

- Librerías de Excel como `xlsx` o `exceljs`.
- Librerías de gráficos como Chart.js, ECharts, Recharts, D3 o Highcharts.
- Framework frontend como React, Vue, Angular o Svelte.
- Framework backend como Express, Fastify o NestJS.
- Librerías de autenticación.
- Librerías de validación de esquemas como Zod, Joi o Yup.
- Frameworks de testing como Jest, Vitest, Mocha o Playwright.

## 5. Oportunidad de integración del nuevo módulo

El sistema actual ya resuelve parte de la ingesta de datos Jira, pero con alcance limitado a CSV y snapshot único. La oportunidad técnica para "QA Jira KPI Dashboard" es formalizar un flujo completo:

1. Carga manual de archivo Jira.
2. Validación estructural y semántica.
3. Normalización a un modelo interno estable.
4. Cálculo de KPIs QA.
5. Visualización interna o publicación hacia Grafana.
6. Persistencia de histórico para tendencias.

Inferencia técnica: por el tamaño actual del repositorio, el MVP debería reutilizar el patrón existente de `public/` + `api/` si se busca una evolución incremental. Si el módulo crecerá en UI, filtros, comparativas y múltiples proyectos, convendría evaluar una migración posterior a una estructura más modular con carpetas `api/services`, `api/models`, `public` organizado o un framework frontend.

No se debe asumir integración con Jira API en esta etapa.

## 6. Propuesta de ubicación técnica

### Vista principal del módulo

Recomendación MVP:

- `public/qa-jira-kpi-dashboard.html`

Motivo: el frontend actual es estático y no usa framework de rutas. Una nueva página HTML mantendría consistencia con la arquitectura actual sin introducir dependencias.

Recomendación escalable:

- Migrar a una estructura frontend organizada, por ejemplo `src/` o un framework definido, si se decide construir un dashboard interno complejo.

### Componente de carga de Excel

Recomendación MVP:

- En frontend estático: bloque de UI dentro de `public/qa-jira-kpi-dashboard.html`.
- Si se reorganiza sin framework: `public/assets/js/qa-jira-upload.js` y `public/assets/css/qa-jira-dashboard.css`.

No encontrado actualmente un sistema de componentes reutilizables.

### Servicio de procesamiento del archivo

Recomendación MVP:

- `api/qa-jira/upload.js` o `api/qa-jira-kpi-upload.js`.

Motivo: separar la nueva ingesta Excel del endpoint actual `/api/upload`, que hoy trunca `public.raw_jira` y está especializado en CSV.

No recomendado para MVP:

- Modificar directamente `api/upload.js` para mezclar CSV actual y Excel KPI, porque aumentaría acoplamiento y riesgo sobre el flujo existente.

### Servicio de análisis de tarjetas Jira

Recomendación MVP:

- `api/qa-jira/analyze.js` si se mantiene arquitectura serverless por endpoint.
- Alternativa modular: `api/_qaJiraAnalysis.js` como helper interno, siguiendo el patrón de `api/_db.js`.

Nota: Vercel trata archivos bajo `api/` como funciones si están expuestos; los helpers con prefijo `_` ya existen en el repositorio como patrón en `api/_db.js`.

### Modelo de datos interno

Recomendación MVP:

- Documentar primero el modelo en `docs/`.
- Si se implementa luego, crear un helper interno `api/_qaJiraModel.js` para normalización y validación.

Recomendación escalable:

- Crear tablas normalizadas o tablas de snapshots, por ejemplo:
  - `qa_jira_uploads`
  - `qa_jira_issues`
  - `qa_jira_issue_snapshots`
  - `qa_jira_kpi_results`

No encontrado actualmente un directorio de modelos ni migraciones.

### Dashboard visual

Recomendación MVP:

- Dashboard interno simple en HTML estático con KPIs resumidos.
- O mantener visualización en Grafana si se prioriza rapidez y los KPIs se calculan en SQL.

Recomendación escalable:

- Dashboard interno con filtros por proyecto, sprint, release, tipo de issue, severidad, responsable y fechas.
- Evaluar librería de gráficos solo cuando exista una decisión de framework o de UI.

### KPIs calculados

Recomendación MVP:

- Calcular KPIs en backend al momento de carga o consulta.
- Evitar cálculos complejos en el navegador si el Excel puede crecer.

Recomendación escalable:

- Persistir KPIs por snapshot/sprint/release para tendencias históricas.

### Validaciones del archivo

Recomendación MVP:

- Validar extensión y tipo esperado.
- Validar tamaño máximo.
- Validar cabeceras mínimas.
- Validar filas vacías.
- Validar fechas parseables.
- Validar duplicados por issue key.
- Validar campos numéricos como story points.
- Reportar columnas ignoradas, columnas faltantes y filas inválidas.

El sistema actual ya reporta columnas ignoradas y mapping de cabeceras para CSV.

### Manejo de errores

Recomendación MVP:

- Respuestas JSON consistentes: `{ ok: false, error, details }`.
- Clasificar errores de archivo, validación, parseo, base de datos y permisos.
- Mantener logs técnicos en backend sin exponer detalles sensibles de conexión.

El sistema actual devuelve `{ ok: false, error }` y registra `UPLOAD_ERROR` en consola.

### Pruebas unitarias o de integración

No encontrado framework de pruebas.

Recomendación MVP:

- Agregar pruebas unitarias para normalización de cabeceras, validación de campos, cálculo de KPIs y parsing de fechas.
- Agregar prueba de integración del endpoint de carga con un archivo pequeño controlado.

Recomendación técnica: antes de implementar tests habría que incorporar un framework de pruebas, lo cual está fuera del alcance de esta etapa documental.

## 7. Modelo preliminar de datos para tarjetas Jira

Modelo lógico sugerido para una tarjeta Jira normalizada:

| Campo interno | Tipo sugerido | Descripción |
| --- | --- | --- |
| `issue_key` | string | Clave de Jira, por ejemplo `ADN1-123`. |
| `issue_id` | string | ID interno de Jira si está disponible. |
| `issue_type` | string | Tipo: Bug, Story, Task, Test, Incident u otro. |
| `summary` | string | Resumen/título de la tarjeta. |
| `status` | string | Estado actual. |
| `priority` | string | Prioridad. |
| `severity` | string nullable | Severidad si existe como campo Jira. |
| `project_key` | string | Proyecto Jira. |
| `sprint` | string nullable | Sprint principal normalizado. |
| `release` | string nullable | Fix version, release o versión objetivo. |
| `assignee` | string nullable | Responsable asignado. |
| `reporter` | string nullable | Reportador. |
| `created_at` | date nullable | Fecha de creación. |
| `resolved_at` | date nullable | Fecha de resolución/cierre. |
| `updated_at` | date nullable | Última actualización Jira si existe. |
| `story_points` | number nullable | Story points o estimación equivalente. |
| `labels` | string[] | Etiquetas. |
| `components` | string[] | Componentes Jira. |
| `raw_payload` | object | Fila original normalizada para trazabilidad. |
| `upload_id` | string | Identificador de carga/snapshot. |

Inferencia técnica: el repositorio actual solo confirma algunas columnas por mapeos en `api/upload.js`, como sprint, story points, fecha de creación, fecha de cierre, tipo de incidente, ID y clave de incidencia. El resto del modelo debe validarse contra el formato real de exportación Jira antes de implementarse.

## 8. Campos mínimos esperados del Excel

Para un MVP de KPIs QA, el Excel debería incluir como mínimo:

| Campo esperado | Obligatorio | Uso |
| --- | --- | --- |
| `Issue key` / `Clave de incidencia` | Sí | Identificación única y deduplicación. |
| `Issue type` / `Tipo de incidencia` | Sí | Clasificación Bug/Story/Task/Test. |
| `Status` / `Estado` | Sí | Conteos por estado y flujo. |
| `Created` / `Fecha de creación` | Sí | Antigüedad, entrada de defectos, lead time. |
| `Resolved` / `Fecha de resolución` | No para carga, sí para KPIs de cierre | Tiempo de resolución y tasa de cierre. |
| `Priority` / `Prioridad` | Recomendado | Distribución de criticidad. |
| `Severity` / `Severidad` | Recomendado | KPIs QA orientados a impacto. |
| `Sprint` | Recomendado | KPIs por sprint. |
| `Project` / `Proyecto` | Recomendado | Soporte futuro multiproyecto. |
| `Assignee` / `Responsable` | Recomendado | Distribución operativa. |
| `Story points` | Opcional | Relación esfuerzo/calidad si aplica. |

No se debe asumir todavía que el archivo vendrá desde Jira API. Debe tratarse como archivo manual exportado por usuario.

## 9. KPIs QA recomendados para MVP

KPIs básicos recomendados:

- Total de tarjetas cargadas.
- Total de bugs.
- Bugs abiertos vs cerrados.
- Bugs por prioridad.
- Bugs por severidad, si el campo existe.
- Bugs por estado.
- Bugs creados por sprint.
- Bugs cerrados por sprint.
- Tiempo promedio de resolución de bugs, usando fecha de creación y fecha de resolución.
- Aging de bugs abiertos, usando fecha de creación contra fecha actual.
- Porcentaje de bugs cerrados sobre bugs totales.
- Top componentes o etiquetas con más bugs, si existen campos disponibles.

Inferencia técnica: estos KPIs son compatibles con carga manual y no requieren Jira API, siempre que el Excel incluya las columnas mínimas.

## 10. KPIs QA recomendados para fase escalable

KPIs avanzados recomendados:

- Tendencia de defectos por sprint/release.
- Defect leakage por ambiente o release.
- Reopen rate.
- Defect density por story points, componente o release.
- Tiempo medio de detección.
- Tiempo medio de resolución por prioridad/severidad.
- SLA compliance por severidad.
- Backlog de bugs envejecidos por rango de días.
- Throughput QA por sprint.
- Cumplimiento de cierre antes de release.
- Distribución de defectos por componente, equipo o responsable.
- Comparativa entre proyectos.
- Variación de bugs nuevos vs resueltos por periodo.
- Predictibilidad de calidad por tendencia histórica.

Estos KPIs requieren mayor consistencia de datos, histórico persistente y definiciones funcionales acordadas.

## 11. Riesgos técnicos identificados

### Riesgos de arquitectura

- El sistema actual es muy pequeño y no tiene capas formales de dominio, servicios, modelos o componentes.
- Mezclar Excel/KPIs dentro de `api/upload.js` aumentaría el acoplamiento con el flujo actual de CSV.
- No existe framework de pruebas ni estructura modular que facilite evolución controlada.
- No hay migraciones o contratos de base de datos versionados en el repositorio.

### Riesgos de rendimiento

- El backend actual lee el archivo completo en memoria.
- `csv-parse/sync` procesa de forma sincrónica; para archivos grandes puede bloquear la función serverless.
- Excel puede consumir más memoria que CSV al parsearse.
- Serverless puede tener límites de memoria, tiempo de ejecución y tamaño de request.
- La carga actual trunca e inserta todo el snapshot, lo cual no sirve para histórico ni cargas incrementales.

### Riesgos de inconsistencia de datos

- Jira permite campos personalizados y nombres localizados; el repositorio ya incluye equivalencias hardcodeadas para variantes y typos.
- Cabeceras duplicadas, especialmente `Sprint`, requieren reglas claras.
- Fechas pueden venir en formatos distintos por idioma, zona horaria o configuración de Jira.
- `story_points` puede variar por proyecto o configuración.
- El significado de `Resolved`, `Closed`, `Done` o estados equivalentes puede cambiar por workflow.

### Riesgos de acoplamiento

- `public.raw_jira` parece ser una tabla cruda compartida con Grafana.
- Cambiar su estructura o semántica podría romper dashboards externos.
- Reutilizar el endpoint actual para una necesidad distinta podría afectar el flujo operativo existente.

### Riesgos de seguridad por carga de archivos

- No se encontró autenticación ni autorización.
- El endpoint de carga permite reemplazar la tabla completa.
- No se encontró validación explícita de MIME real ni extensión en backend.
- El contenido se parsea en memoria.
- Archivos maliciosos o excesivamente grandes podrían afectar disponibilidad.
- Si se soporta Excel, deben considerarse fórmulas, macros, contenido inesperado y sanitización de valores mostrados en UI.

### Riesgos de mala interpretación de campos Jira

- `issue type` no siempre identifica con precisión si algo es bug, defecto, incidencia o tarea QA.
- Severidad puede no existir o estar como campo custom.
- Sprint puede contener valores múltiples.
- Una tarjeta puede moverse entre sprints.
- La fecha de resolución puede no equivaler a fecha real de despliegue o cierre QA.
- Estados Jira son configurables por proyecto, por lo que "Done" o "Cerrado" deben mapearse explícitamente.

## 12. Recomendación MVP

Objetivo mínimo viable:

Permitir cargar manualmente un archivo Jira en Excel o CSV, validar campos mínimos, normalizar tarjetas y mostrar KPIs QA básicos sin afectar el flujo actual de carga CSV hacia `public.raw_jira`.

Alcance recomendado:

- Crear una ruta/página separada para el módulo.
- Crear un endpoint separado para carga/análisis QA.
- No modificar `/api/upload` salvo que se decida formalmente unificar flujos.
- Aceptar inicialmente un formato de archivo controlado y documentado.
- Calcular KPIs en backend sobre los datos cargados.
- Mostrar resultados agregados y errores de validación.
- Mantener la carga como snapshot temporal o persistirla con `upload_id`, según decisión de base de datos.

Campos mínimos para empezar:

- Clave de incidencia.
- Tipo de incidencia.
- Estado.
- Fecha de creación.
- Fecha de resolución.
- Prioridad.
- Sprint.

KPIs mínimos:

- Total de bugs.
- Bugs abiertos.
- Bugs cerrados.
- Bugs por estado.
- Bugs por prioridad.
- Tiempo promedio de resolución.
- Aging de bugs abiertos.

Funcionalidades para fases posteriores:

- Integración Jira API.
- Histórico.
- Comparativas entre sprints.
- Tendencias.
- Multiproyecto.
- Exportación de reportes.
- Autenticación y roles.
- Dashboards avanzados.

## 13. Recomendación escalable

### Evolución de carga manual Excel a Jira API

Fase 1:

- Mantener carga manual Excel/CSV.
- Normalizar datos a un modelo interno estable.
- Registrar metadatos de carga.

Fase 2:

- Agregar persistencia histórica.
- Permitir comparar cargas por `upload_id`, sprint o release.
- Agregar validaciones configurables por proyecto.

Fase 3:

- Integrar Jira API como fuente adicional.
- Usar credenciales seguras por ambiente.
- Implementar sincronización por proyecto, JQL y ventana temporal.
- Mantener la carga manual como fallback operativo.

### Persistencia de histórico

Recomendación:

- No depender únicamente de `TRUNCATE` para el módulo KPI.
- Crear entidades de carga/snapshot.
- Guardar filas normalizadas con `upload_id`.
- Guardar resultados agregados si el volumen crece.

### Comparación de sprints/releases

Recomendación:

- Normalizar `sprint`, `release` y fechas.
- Permitir filtros por proyecto, sprint, release y periodo.
- Definir reglas de tarjetas con múltiples sprints.

### Tendencias

Recomendación:

- Calcular tendencias desde snapshots históricos o sincronizaciones Jira API.
- Separar métricas de conteo simple de métricas derivadas.
- Guardar la fecha de corte de cada carga.

### Múltiples proyectos

Recomendación:

- Incluir `project_key` como campo interno obligatorio para fase escalable.
- Soportar configuraciones por proyecto: estados cerrados, campos de severidad, JQL base y equivalencias de columnas.

### Exportación de reportes

Recomendación:

- Fase inicial: exportar JSON/CSV de KPIs.
- Fase posterior: exportar Excel/PDF si hay requerimiento funcional.
- Mantener trazabilidad entre KPI agregado y tarjetas fuente.

## 14. Preguntas abiertas para decisión funcional

- ¿El archivo objetivo será Excel `.xlsx`, CSV o ambos?
- ¿Qué exportación exacta de Jira usará el equipo?
- ¿Cuáles son los nombres reales de columnas para severidad, prioridad, sprint y resolución?
- ¿Qué estados deben considerarse cerrados para QA?
- ¿Qué tipos de issue deben considerarse bugs o defectos?
- ¿El módulo debe reemplazar el flujo actual o convivir con `/api/upload`?
- ¿Los KPIs se mostrarán internamente o seguirán consumiéndose desde Grafana?
- ¿Debe existir histórico o solo snapshot actual?
- ¿Quiénes podrán cargar archivos?
- ¿Se requiere autenticación antes de exponer la carga?
- ¿Cuántas tarjetas puede tener un archivo típico y un archivo máximo?
- ¿Se deben soportar múltiples proyectos desde el MVP?
- ¿La métrica principal será por sprint, release, fecha o proyecto?
- ¿Hay SLA definidos por severidad/prioridad?

## 15. Próximos pasos recomendados

1. Validar con negocio el formato real del archivo Jira y obtener un ejemplo anonimizado.
2. Definir el diccionario de campos mínimos y equivalencias por idioma/campo custom.
3. Definir qué estados Jira cuentan como abierto, cerrado, resuelto y reabierto.
4. Decidir si el MVP será CSV, Excel o ambos.
5. Decidir si el dashboard será interno o continuará en Grafana.
6. Diseñar el esquema de persistencia para snapshot o histórico.
7. Definir controles mínimos de seguridad para carga de archivos.
8. Incorporar pruebas para parsing, validación y cálculo de KPIs antes de producción.
9. Implementar el MVP en endpoints y vistas separados para no romper la carga actual.
10. Planificar una fase posterior de Jira API solo después de estabilizar el modelo de datos y los KPIs.
