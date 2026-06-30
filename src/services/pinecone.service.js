/**
 * Servicio de Pinecone: vaciar el namespace y cargar los vectores nuevos.
 *
 * La actualizacion es de reemplazo total: deleteAll() borra la informacion
 * anterior del namespace y upsertVectors() inserta la nueva por lotes,
 * informando el avance via callback.
 */

import { Pinecone } from '@pinecone-database/pinecone';

const UPSERT_BATCH = 100;

let pc;
function getNamespace(namespace) {
  if (!pc) pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  return pc.index(process.env.PINECONE_INDEX).namespace(namespace);
}

export async function clearNamespace(namespace) {
  try {
    await getNamespace(namespace).deleteAll();
  } catch (err) {
    // Pinecone devuelve 404 si el namespace aun no existe; no es un error real.
    if (!String(err.message).includes('404')) throw err;
  }
}

export async function upsertVectors(namespace, chunks, embeddings, onProgress = () => {}) {
  const ns = getNamespace(namespace);
  const vectors = chunks.map((c, i) => ({
    id: c.id,
    values: embeddings[i],
    metadata: { ...c.metadata, text: c.text },
  }));

  for (let i = 0; i < vectors.length; i += UPSERT_BATCH) {
    await ns.upsert(vectors.slice(i, i + UPSERT_BATCH));
    onProgress(Math.min(i + UPSERT_BATCH, vectors.length), vectors.length);
  }
}
