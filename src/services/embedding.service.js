/**
 * Servicio de embeddings: convierte textos en vectores con Azure OpenAI.
 *
 * Usa la misma libreria `openai` mediante la clase AzureOpenAI. El deployment
 * `text-embed-ada-tutores` (text-embedding-ada-002) produce 1536 dimensiones
 * — el indice de Pinecone debe tener esa misma dimension. Procesa por lotes e
 * informa el avance via callback para que el job pueda mostrar el progreso.
 */

import { AzureOpenAI } from 'openai';

const BATCH_SIZE = 100;

let client;
function getClient() {
  if (!client) {
    client = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2023-05-15',
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    });
  }
  return client;
}

export async function embedTexts(texts, onProgress = () => {}) {
  const azure = getClient();
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const vectors = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    // En Azure, `model` es el nombre del deployment.
    const resp = await azure.embeddings.create({ model: deployment, input: batch });
    vectors.push(...resp.data.map(d => d.embedding));
    onProgress(vectors.length, texts.length);
  }
  return vectors;
}
