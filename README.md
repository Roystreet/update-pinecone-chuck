# Frontend de Actualización de Índices (Pinecone)

Aplicación web **monolítica** (Node.js + Express) que permite a cualquier persona subir un documento Excel desde el navegador para **regenerar un namespace de Pinecone** con su contenido, mostrando en pantalla cada paso del proceso y el estado de la carga en tiempo real.

## ¿Qué hace?

1. El usuario sube un `.xlsx` desde el frontend (arrastrar y soltar o selector de archivos), pudiendo indicar opcionalmente el namespace destino (si no existe, se crea automáticamente con la carga).
2. El servidor crea un **job** y responde de inmediato con su `jobId` — el procesamiento corre en segundo plano.
3. El pipeline ejecuta cuatro pasos:
   1. **Parseo** — formato estructurado obligatorio de dos hojas, en tres procesos (ver "Formato del Excel").
   2. **Embeddings** — los chunks se vectorizan con Azure OpenAI (`text-embedding-ada-002`, 1536 dimensiones), por lotes.
   3. **Limpieza** — se vacía el namespace en Pinecone (se borra la información anterior).
   4. **Upsert** — se cargan los vectores nuevos por lotes.
4. El frontend consulta el estado del job cada segundo y pinta los pasos, las barras de progreso y el resultado final. También muestra un historial de cargas recientes.

## Formato del Excel

El Excel **siempre debe tener dos hojas obligatorias** (los nombres se reconocen sin importar mayúsculas, tildes ni espacios). Si falta alguna, la carga se **detiene con error**:

| Hoja | Contenido | Requisito |
|---|---|---|
| `base actualizada` | Preguntas y respuestas | Debe tener columnas `PREGUNTA` y `RESPUESTA` (acepta mayúsculas/minúsculas, tildes y `question`/`answer`) |
| `base descripciones` | Descripciones (genérico) | Primera fila = encabezados; el resto, filas de datos |

La indexación se arma en **tres procesos** cuyo resultado se **acumula y se sube como suma total** (un solo embed → limpieza → upsert sobre la unión):

| Proceso | Origen | Texto del chunk |
|---|---|---|
| **P1** | `base actualizada` | `"PREGUNTA: ...\nRESPUESTA: ..."` (si la fila no tiene pregunta, solo `"RESPUESTA: ..."`) |
| **P2** | `base actualizada` | `"RESPUESTA: ..."` — chunk **adicional** (redundancia intencional) |
| **P3** | `base descripciones` | `"Columna: valor \| Columna: valor"` (formato genérico) |

La redundancia P1+P2 es **a propósito**: subir la pregunta+respuesta y además la respuesta sola mejora la confiabilidad de recuperación del RAG.

**Estructura del vector (idéntica para los tres procesos)** — `id`: UUID v4 · `metadata`: `{ text, docId, line, source: "blob", blobType: "" }`, **idéntica a la del namespace `contactoupn` del índice `upn`** (ver `docs/estructura-upn-contactoupn.md`), para mantener compatibilidad con los consumidores existentes. Todas las filas de una misma carga comparten el mismo `docId` (un UUID generado por carga).

En `base actualizada`: las filas sin respuesta se descartan (si tenían pregunta, se avisa con un warning) y las filas con respuesta pero sin pregunta se indexan solo como `RESPUESTA: ...`.

## Estructura del proyecto

```
frontend_actualizacion/
├── server.js                          # Punto de entrada: Express, estáticos y montaje de la API
├── package.json
├── .env.example                       # Plantilla de configuración (copiar a .env)
├── public/                            # Frontend estático
│   ├── index.html                     # Página de subida y seguimiento
│   ├── app.js                         # Subida + polling del job + render de pasos
│   └── styles.css
└── src/
    ├── routes/
    │   └── api.routes.js              # Definición de endpoints y configuración de multer
    ├── controllers/
    │   └── upload.controller.js       # Orquestación del pipeline (parseo → embeddings → limpieza → upsert)
    └── services/
        ├── job.service.js             # Estado de los jobs (pasos, progreso, historial)
        ├── excel.service.js           # Formato genérico: .xlsx → chunks "Columna: valor"
        ├── faq.service.js             # Formato FAQ: .xlsx → chunks con estructura contactoupn
        ├── embedding.service.js       # Textos → vectores (OpenAI, por lotes, con progreso)
        └── pinecone.service.js        # deleteAll del namespace + upsert por lotes
```

Carpetas adicionales:

```
├── docs/
│   └── estructura-upn-contactoupn.md  # Estructura documentada del namespace original (generado)
├── scripts/
│   ├── create-namespace.js            # Crea índice/namespace de prueba y verifica con stats
│   ├── inspect-namespace.js           # Documenta la estructura de cualquier namespace en un MD
│   ├── test-upload.js                 # Prueba e2e: Excel FAQ → pipeline completo → verificación
│   └── ejemplo-faq.xlsx               # Excel de ejemplo generado por la prueba e2e
└── tests/
    ├── faq.service.test.js            # Tests del formato FAQ (estructura contactoupn)
    └── excel.service.test.js          # Tests del formato genérico
```

## Servicios

| Servicio | Responsabilidad |
|---|---|
| **`job.service.js`** | Lleva el ciclo de vida de cada carga: crea el job con sus 4 pasos, registra inicio/fin/error de cada paso y el avance (`done/total`), y mantiene el historial de las últimas 50 cargas. Es lo que el frontend consulta para pintar el estado. Almacena en memoria (instancia única); para escalar a varias instancias, sustituir el `Map` por Redis. |
| **`excel.service.js`** | Formato genérico: transforma el `.xlsx` en chunks usando la primera fila de cada hoja como encabezados y convirtiendo cada fila en `"Columna: valor \| Columna: valor"` (helper `genericRowText`, reutilizado por el proceso de descripciones), con id estable (`archivo:hoja:fila`) y metadata para citar la fuente desde el RAG. |
| **`faq.service.js`** | Formato estructurado obligatorio (`parseStructuredExcel`): valida las dos hojas (`base actualizada`/`base descripciones`) y arma los tres procesos (P1 PREGUNTA+RESPUESTA, P2 solo RESPUESTA, P3 descripciones genéricas), todos con la metadata exacta del namespace `contactoupn` (`docId` UUID por documento, `line` con la fila, `source: "blob"`, `blobType: ""`) e ids UUID v4. Lanza `AppError` si falta una hoja o si `base actualizada` no tiene columnas `PREGUNTA`/`RESPUESTA`. También conserva `parseFaqExcel`/`detectFaqColumns` (detección por columnas, usados por los tests). |
| **`embedding.service.js`** | Genera los vectores con Azure OpenAI (`text-embedding-ada-002`, 1536 dims) usando la clase `AzureOpenAI` de la librería `openai`, en lotes de 100, informando el avance mediante callback para que el job refleje el progreso. |
| **`pinecone.service.js`** | Actualización por reemplazo total: `clearNamespace()` borra todo el contenido anterior del namespace (tolera el 404 de un namespace inexistente) y `upsertVectors()` inserta los vectores nuevos en lotes de 100, con callback de progreso. |
| **`upload.controller.js`** | El orquestador: recibe el archivo, crea el job, responde `202` con el `jobId` y ejecuta el pipeline en segundo plano encadenando los servicios anteriores. Cualquier fallo marca el job (y el paso activo) como error. |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/upload` | Multipart con el campo `archivo` (`.xlsx`, máx. 25 MB) y `namespace` opcional. Devuelve `202 { jobId }`. |
| `GET` | `/api/jobs/:id` | Estado detallado del job: pasos, progreso, resultado o error. |
| `GET` | `/api/jobs` | Historial resumido de las cargas recientes. |

## Puesta en marcha

```bash
cd frontend_actualizacion
npm install
copy .env.example .env        # y rellenar las claves
npm start                     # http://localhost:3000
```

## Tests

```bash
npm test                      # tests unitarios (node:test) de los servicios de parseo
node scripts/test-upload.js   # prueba e2e: sube un Excel FAQ real al namespace de prueba
                              # y verifica que la estructura almacenada es la de contactoupn
```

La prueba e2e usa el `PINECONE_NAMESPACE` del `.env` (el de prueba) y **borra su contenido** como parte del flujo normal — no apuntarla a un namespace productivo.

## Scripts utilitarios

| Script | Uso |
|---|---|
| `node scripts/create-namespace.js` | Crea el índice (si hay cupo) y el namespace del `.env` con vectores dummy; lista los índices del proyecto |
| `node scripts/inspect-namespace.js <índice> [namespace]` | Sin namespace: lista los namespaces del índice. Con namespace: muestrea sus vectores y genera `docs/estructura-<índice>-<namespace>.md` con el esquema de metadata |
| `node scripts/test-upload.js` | Prueba end-to-end del pipeline completo contra el namespace de prueba |

### Variables de entorno (`.env`)

| Variable | Descripción |
|---|---|
| `PORT` | Puerto del servidor (por defecto 3000) |
| `PINECONE_API_KEY` | API key de Pinecone |
| `PINECONE_INDEX` | Nombre del índice (debe existir, **dimensión 1536**, métrica cosine) |
| `PINECONE_NAMESPACE` | Namespace por defecto (el formulario puede sobreescribirlo) |
| `AZURE_OPENAI_API_KEY` | API key del recurso de Azure OpenAI para los embeddings |
| `AZURE_OPENAI_ENDPOINT` | Endpoint base del recurso (sin la ruta `/openai/deployments/...`) |
| `AZURE_OPENAI_DEPLOYMENT` | Nombre del deployment del modelo de embeddings (1536 dims) |
| `AZURE_OPENAI_API_VERSION` | Versión de la API (por defecto `2023-05-15`) |

## Notas y límites

- **La actualización es de reemplazo total**: subir un Excel borra todo lo que hubiera en el namespace y lo sustituye por el contenido del archivo nuevo.
- Los jobs viven **en memoria**: si el servidor se reinicia se pierde el historial (no afecta a los datos ya cargados en Pinecone).
- No incluye autenticación — si se expone fuera de la red interna, añadir al menos una capa de auth (basic auth, SSO corporativo o un reverse proxy).
- Si se cambia el modelo de embeddings, la dimensión del índice de Pinecone debe coincidir con la del modelo nuevo.
