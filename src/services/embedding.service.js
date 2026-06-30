/**
 * Servicio de embeddings: convierte textos en vectores con OpenAI.
 *
 * Modelo: text-embedding-3-small (1536 dimensiones) — el indice de Pinecone
 * debe tener esa misma dimension. Procesa por lotes e informa el avance via
 * callback para que el job pueda mostrar el progreso.
 */

import OpenAI from 'openai';

const EMBED_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;

let client;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export async function embedTexts(texts, onProgress = () => {}) {
  const openai = getClient();
  const vectors = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const resp = await openai.embeddings.create({ model: EMBED_MODEL, input: batch });
    vectors.push(...resp.data.map(d => d.embedding));
    onProgress(vectors.length, texts.length);
  }
  return vectors;
}
