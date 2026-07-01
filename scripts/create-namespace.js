/**
 * Script de prueba: crea el indice de Pinecone (si no existe) y el namespace.
 *
 * En Pinecone los namespaces se crean implicitamente con el primer upsert,
 * asi que este script:
 *   1. Crea el indice serverless (1536 dims, cosine) si aun no existe.
 *   2. Hace un upsert de 4 registros de prueba en el namespace -> esto lo crea.
 *   3. Muestra las estadisticas del indice para verificar.
 *
 * Uso:  node scripts/create-namespace.js
 */

import 'dotenv/config';
import { Pinecone } from '@pinecone-database/pinecone';

const INDEX = process.env.PINECONE_INDEX;
const NAMESPACE = process.env.PINECONE_NAMESPACE || 'example-namespace';
const DIMENSION = 1536; // text-embedding-ada-002 (Azure OpenAI)

if (!process.env.PINECONE_API_KEY || !INDEX) {
  console.error('Faltan PINECONE_API_KEY o PINECONE_INDEX en el .env');
  process.exit(1);
}

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

// ---------------------------------------------------------------- 1. indice

const { indexes = [] } = await pc.listIndexes();

console.log(`Indices existentes en el proyecto (${indexes.length}):`);
for (const i of indexes) {
  console.log(`  - ${i.name} | dim=${i.dimension} | metric=${i.metric} | ${i.status?.state}`);
}
console.log('');

const found = indexes.find(i => i.name === INDEX);
if (found) {
  if (found.dimension !== DIMENSION) {
    console.error(
      `✕ El indice '${INDEX}' existe pero tiene dimension ${found.dimension}, ` +
      `y los embeddings del proyecto son de ${DIMENSION}. Elige otro indice en el .env.`
    );
    process.exit(1);
  }
  console.log(`✔ El indice '${INDEX}' ya existe (dim=${found.dimension}).`);
} else {
  console.log(`Creando indice '${INDEX}' (serverless, ${DIMENSION} dims, cosine)...`);
  try {
    await pc.createIndex({
      name: INDEX,
      dimension: DIMENSION,
      metric: 'cosine',
      spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
      waitUntilReady: true,
    });
    console.log(`✔ Indice '${INDEX}' creado y listo.`);
  } catch (err) {
    if (String(err.message).includes('max serverless indexes')) {
      console.error(
        `✕ No se pudo crear '${INDEX}': el proyecto llego al limite de indices del plan Starter.\n` +
        `  Opciones:\n` +
        `   1) Reutiliza uno de los indices de dim=${DIMENSION} listados arriba (cambia PINECONE_INDEX en el .env)\n` +
        `   2) Borra un indice que no uses desde https://app.pinecone.io\n` +
        `   3) Sube de plan en Pinecone`
      );
      process.exit(1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- 2. upsert de prueba (crea el namespace)

// Vectores dummy deterministas con la dimension correcta del indice
const dummyVector = seed =>
  Array.from({ length: DIMENSION }, (_, i) => Math.sin(seed * (i + 1)) * 0.1);

const records = [
  { id: 'A', values: dummyVector(1), metadata: { genre: 'comedy', year: 2020 } },
  { id: 'B', values: dummyVector(2), metadata: { genre: 'documentary', year: 2019 } },
  { id: 'C', values: dummyVector(3), metadata: { genre: 'comedy', year: 2019 } },
  { id: 'D', values: dummyVector(4), metadata: { genre: 'drama' } },
];

const ns = pc.index(INDEX).namespace(NAMESPACE);
await ns.upsert(records);
console.log(`✔ ${records.length} registros de prueba insertados en el namespace '${NAMESPACE}'.`);

// ---------------------------------------------------------------- 3. verificacion

// Las estadisticas son eventualmente consistentes; esperamos unos segundos
console.log('Esperando 10s para que las estadisticas se actualicen...');
await new Promise(r => setTimeout(r, 10_000));

const stats = await pc.index(INDEX).describeIndexStats();
console.log('\nEstado del indice:');
console.log(`  Total de vectores: ${stats.totalRecordCount}`);
console.log('  Namespaces:');
for (const [name, info] of Object.entries(stats.namespaces ?? {})) {
  console.log(`    - '${name}': ${info.recordCount} vectores`);
}
