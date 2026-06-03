# Flujo de carga CSV con Vercel Blob

## Por que se usa Vercel Blob

Vercel Functions tienen limite de tamano para el body del request. Cuando el CSV de Jira supera ese limite, Vercel rechaza el request antes de que `api/upload.js` pueda procesarlo y aparece `FUNCTION_PAYLOAD_TOO_LARGE`.

Para evitarlo, el archivo ya no se envia completo a una Serverless Function. El navegador lo sube primero a Vercel Blob Storage y el backend recibe solo la URL del archivo.

## Por que no subir el CSV directo a Serverless Function

El flujo multipart directo hacia `/api/upload` funciona para archivos pequenos, pero no es confiable en Vercel Free para CSV de Jira de varios MB. El request puede ser rechazado antes de llegar al handler.

El endpoint `api/upload.js` se mantiene por compatibilidad, pero `public/index.html` usa el flujo Blob.

## Flujo tecnico actual

1. El usuario selecciona el CSV en `public/index.html`.
2. El frontend usa `upload()` de `@vercel/blob/client`.
3. El frontend solicita un token de subida a `POST /api/blob-upload`.
4. El navegador sube el archivo directamente a Vercel Blob.
5. Vercel Blob devuelve una URL del archivo subido.
6. El frontend llama a `POST /api/process-blob-upload` con:

```json
{
  "url": "URL_DEL_ARCHIVO_EN_BLOB"
}
```

7. `api/process-blob-upload.js` descarga el CSV desde la URL.
8. El backend parsea el CSV, detecta delimitador coma o punto y coma, y lee columnas reales de `public.raw_jira`.
9. El backend ejecuta `TRUNCATE TABLE public.raw_jira RESTART IDENTITY`.
10. El backend inserta solo columnas existentes en `public.raw_jira`.
11. El endpoint responde el resumen de filas, columnas cargadas, columnas ignoradas, duplicados y columnas importantes faltantes.
12. El endpoint intenta eliminar el Blob temporal al finalizar.

## Endpoints involucrados

- `POST /api/blob-upload`: genera el token seguro para client upload hacia Vercel Blob.
- `POST /api/process-blob-upload`: recibe la URL Blob, procesa el CSV y actualiza `public.raw_jira`.
- `POST /api/upload`: flujo legacy multipart. No lo usa la pantalla principal.

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
7. Verificar que la respuesta indique `source: "vercel_blob"` y `mode: "snapshot_truncate_reload"`.

Nota: el callback `onUploadCompleted` de Vercel Blob puede requerir URL publica para ejecutarse en local. El procesamiento no depende de ese callback; depende de la URL que devuelve el upload del frontend.

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
- `source: "vercel_blob"`
- `mode: "snapshot_truncate_reload"`
- `totalRowsReceived`
- `totalRowsInserted`
- `totalColumnsReceived`
- `totalColumnsInserted`
- `insertedColumns`
- `ignoredColumns`
- `duplicatedColumns`
- `missingImportantColumns`
- `blobDeleted`
