# Flujo de carga CSV con Vercel Blob Server Upload

## Por que se usa Server Upload

El sistema usa Vercel Blob como almacenamiento temporal del CSV antes de procesarlo. En este proyecto no se usan subidas directas del navegador a Blob ni tokens generados para el cliente.

El archivo se recibe en `POST /api/upload`, el backend lo guarda con el SDK oficial `@vercel/blob` usando `put()`, lee inmediatamente la URL publica generada y procesa el CSV para actualizar el snapshot QA.

## Flujo tecnico final

1. El usuario selecciona el CSV en `public/index.html`.
2. El frontend envia un `POST multipart` a `/api/upload`.
3. `api/upload.js` recibe el archivo con `formidable`.
4. `api/upload.js` ejecuta:

```js
const blob = await put(filename, fileBuffer, {
  access: 'public'
});
```

5. El endpoint obtiene `blob.url`.
6. El endpoint lee inmediatamente el CSV desde esa URL.
7. El backend parsea el CSV, detecta delimitador coma o punto y coma, y lee columnas reales de `public.raw_jira`.
8. El backend ejecuta `TRUNCATE TABLE public.raw_jira RESTART IDENTITY`.
9. El backend inserta solo columnas existentes en `public.raw_jira`.
10. El endpoint responde el resumen de filas, columnas cargadas, columnas ignoradas, duplicados y columnas importantes faltantes.

## Endpoints involucrados

- `POST /api/upload`: unico endpoint de carga usado por la pantalla principal.

No existen endpoints para generar tokens de cliente ni para procesar URLs enviadas desde el navegador.

## Variables de entorno necesarias

En Vercel:

- `BLOB_READ_WRITE_TOKEN`: creada al conectar un Blob Store al proyecto.
- `DATABASE_URL` o variables `PGUSER`, `PGPASSWORD`, `PGHOST`, `PGPORT`, `PGDATABASE`.

En local:

- Ejecutar `vercel env pull` para traer `BLOB_READ_WRITE_TOKEN` y variables de base.
- Ejecutar localmente con `vercel dev`.

## Prueba local

1. Instalar dependencias con `npm install`.
2. Ejecutar `vercel env pull`.
3. Ejecutar `vercel dev`.
4. Abrir `http://localhost:3000`.
5. Seleccionar `Jira.csv`.
6. Presionar `Subir y cargar`.
7. Verificar que la respuesta indique `source: "server_upload_blob"` y `mode: "snapshot_truncate_reload"`.

## Prueba en Vercel

1. Crear o conectar un Blob Store al proyecto.
2. Confirmar que existe `BLOB_READ_WRITE_TOKEN` en las variables del proyecto.
3. Confirmar las variables de PostgreSQL/Neon.
4. Desplegar.
5. Abrir la URL de Vercel.
6. Subir `Jira.csv`.
7. Verificar que `public.raw_jira` se trunque y vuelva a cargarse con el snapshot actualizado.

## Resultado esperado

La respuesta esperada contiene:

- `ok: true`
- `source: "server_upload_blob"`
- `blobUrl`
- `mode: "snapshot_truncate_reload"`
- `totalRowsReceived`
- `totalRowsInserted`
- `totalColumnsReceived`
- `totalColumnsInserted`
- `insertedColumns`
- `ignoredColumns`
- `duplicatedColumns`
- `missingImportantColumns`
