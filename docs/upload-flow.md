# Flujo de carga CSV con Vercel Blob Client Upload

## Por que se usa Client Upload

Vercel Free rechaza requests grandes hacia Serverless Functions antes de que el handler pueda procesarlos. Por eso un CSV de Jira de aproximadamente 6MB puede fallar con `FUNCTION_PAYLOAD_TOO_LARGE` si se envia como multipart a `/api/upload`.

Para evitar ese limite, el navegador sube el CSV directamente a Vercel Blob. El backend recibe solo la URL publica del Blob y procesa el archivo desde esa URL.

## Flujo tecnico final

1. El usuario selecciona `Jira.csv` en `public/index.html`.
2. El frontend usa `upload()` de `@vercel/blob/client`.
3. `upload()` solicita el token de subida a `POST /api/blob-upload`.
4. El navegador sube el archivo directamente a Vercel Blob.
5. Vercel Blob devuelve `blob.url`.
6. El frontend llama a `POST /api/process-blob-upload` con:

```json
{
  "url": "URL_DEL_BLOB"
}
```

7. `api/process-blob-upload.js` descarga el CSV desde esa URL publica.
8. El backend parsea CSV y detecta delimitador coma o punto y coma.
9. El backend lee columnas reales de `public.raw_jira`.
10. El backend ejecuta `TRUNCATE TABLE public.raw_jira RESTART IDENTITY`.
11. El backend inserta filas en lotes, solo en columnas existentes.
12. El endpoint responde el resumen de carga.

## Endpoints involucrados

- `POST /api/blob-upload`: endpoint requerido por `@vercel/blob/client` para obtener el token de subida.
- `POST /api/process-blob-upload`: recibe solo la URL del Blob y actualiza el snapshot en `public.raw_jira`.
- `POST /api/upload`: deshabilitado para carga multipart directa; responde `410`.

La pantalla principal no envia el CSV completo a `/api/upload`.

## Variables de entorno necesarias

En Vercel:

- `BLOB_READ_WRITE_TOKEN`: creada al conectar un Blob Store al proyecto.
- `DATABASE_URL` o variables `PGUSER`, `PGPASSWORD`, `PGHOST`, `PGPORT`, `PGDATABASE`.

Si aparece `Vercel Blob: Failed to retrieve the client token`, revisar primero que `BLOB_READ_WRITE_TOKEN` exista en el proyecto de Vercel y que `POST /api/blob-upload` responda `200` con `clientToken`.

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
7. Verificar que la respuesta indique `mode: "blob_direct_upload_snapshot"`.

## Prueba en Vercel Free

1. Crear o conectar un Blob Store al proyecto.
2. Confirmar que existe `BLOB_READ_WRITE_TOKEN` en las variables del proyecto.
3. Confirmar las variables de PostgreSQL/Neon.
4. Desplegar.
5. Abrir la URL de Vercel.
6. Subir `Jira.csv` de aproximadamente 6MB.
7. Verificar que no aparezca `FUNCTION_PAYLOAD_TOO_LARGE`.
8. Verificar que `public.raw_jira` se trunque y vuelva a cargarse con el snapshot actualizado.

## Resultado esperado

La respuesta esperada contiene:

- `ok: true`
- `message: "CSV cargado correctamente desde Blob"`
- `mode: "blob_direct_upload_snapshot"`
- `blobUrl`
- `totalRowsReceived`
- `totalRowsInserted`
- `totalColumnsReceived`
- `totalColumnsInserted`
- `ignoredColumns`
- `missingImportantColumns`
