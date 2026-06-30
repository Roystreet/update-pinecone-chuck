/**
 * Prueba end-to-end contra el namespace de prueba:
 *
 *   1. Genera un Excel FAQ de ejemplo (columnas PREGUNTA/RESPUESTA) en scripts/ejemplo-faq.xlsx
 *   2. Lo procesa con el MISMO pipeline del frontend:
 *        faq.service -> embedding.service -> pinecone.service (clear + upsert)
 *   3. Lee de vuelta los vectores desde Pinecone y valida que la metadata
 *      tiene exactamente la estructura de 'contactoupn'
 *      (text, docId, line, source, blobType) y que el text esta en formato
 *      PREGUNTA/RESPUESTA.
 *
 * Uso:
 *   node scripts/test-upload.js                      -> genera y usa el Excel de ejemplo
 *   node scripts/test-upload.js ../categorias.xlsx   -> usa un Excel existente
 * (usa PINECONE_INDEX y PINECONE_NAMESPACE del .env — el namespace de prueba)
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { Pinecone } from '@pinecone-database/pinecone';
import { parseFaqExcel } from '../src/services/faq.service.js';
import { embedTexts } from '../src/services/embedding.service.js';
import { clearNamespace, upsertVectors } from '../src/services/pinecone.service.js';

const NAMESPACE = process.env.PINECONE_NAMESPACE;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_FILE = path.join(__dirname, 'ejemplo-faq.xlsx');

const EXPECTED_KEYS = ['blobType', 'docId', 'line', 'source', 'text'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- 1. excel a usar

let excelPath = process.argv[2];
if (excelPath) {
  excelPath = path.resolve(excelPath);
  if (!fs.existsSync(excelPath)) {
    console.error(`No existe el archivo: ${excelPath}`);
    process.exit(1);
  }
  console.log(`✔ Usando Excel existente: ${excelPath}`);
} else {
  const faqRows = [
    ['PREGUNTA', 'RESPUESTA'],
    ['¿Qué es este sistema?', 'Un frontend para actualizar namespaces de Pinecone subiendo archivos Excel.'],
    ['¿Qué formato deben tener los Excel de FAQ?', 'Deben tener una columna PREGUNTA y una columna RESPUESTA; cada fila se indexa como un vector.'],
    ['¿Qué pasa con la información anterior del namespace?', 'Se elimina por completo antes de cargar la nueva (actualización por reemplazo total).'],
    ['¿Cómo se mantiene la compatibilidad con los índices existentes?', 'La metadata replica la estructura del namespace contactoupn: text, docId, line, source y blobType.'],
    ['¿Dónde se ve el avance de la carga?', 'En la pantalla principal: cada paso del pipeline muestra su estado y barra de progreso.'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(faqRows), 'FAQ');
  XLSX.writeFile(wb, SAMPLE_FILE);
  excelPath = SAMPLE_FILE;
  console.log(`✔ Excel de ejemplo generado: ${SAMPLE_FILE} (${faqRows.length - 1} preguntas)`);
}

// ---------------------------------------------------------------- 2. pipeline real

const buffer = fs.readFileSync(excelPath);

const { chunks, sheets } = parseFaqExcel(buffer);
console.log(`✔ Parseo: ${chunks.length} chunks en formato FAQ.`);
for (const sheet of sheets) {
  const extra = sheet.descartadas > 0 ? ` · ${sheet.descartadas} fila(s) descartadas sin respuesta` : '';
  console.log(`  - Hoja "${sheet.name}": ${sheet.status} (${sheet.chunks} chunks)${extra}`);
}
if (chunks.length === 0) {
  console.error('El Excel no tiene contenido FAQ indexable.');
  process.exit(1);
}

console.log('  Generando embeddings...');
const embeddings = await embedTexts(chunks.map(c => c.text));
console.log(`✔ Embeddings: ${embeddings.length} vectores de ${embeddings[0].length} dimensiones.`);

console.log(`  Vaciando namespace '${NAMESPACE}'...`);
await clearNamespace(NAMESPACE);

console.log('  Cargando vectores...');
await upsertVectors(NAMESPACE, chunks, embeddings);
console.log(`✔ Upsert completado en '${NAMESPACE}'.`);

// ---------------------------------------------------------------- 3. verificacion

console.log('Esperando 10s para que Pinecone indexe...');
await new Promise(r => setTimeout(r, 10_000));

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const ns = pc.index(process.env.PINECONE_INDEX).namespace(NAMESPACE);

// fetch admite un numero limitado de ids por llamada: verificamos una muestra
const sampleIds = chunks.slice(0, 50).map(c => c.id);
const fetched = await ns.fetch(sampleIds);
const records = Object.values(fetched.records ?? {});

let errores = 0;
const fail = msg => { errores += 1; console.error(`  ✕ ${msg}`); };

if (records.length !== sampleIds.length) {
  fail(`Se esperaban ${sampleIds.length} vectores en la muestra y se recuperaron ${records.length}`);
}

const stats = await pc.index(process.env.PINECONE_INDEX).describeIndexStats();
const totalNs = stats.namespaces?.[NAMESPACE]?.recordCount ?? 0;
console.log(`Vectores totales en '${NAMESPACE}': ${totalNs} (esperados: ${chunks.length})`);
if (totalNs !== chunks.length) {
  fail(`El namespace tiene ${totalNs} vectores y se cargaron ${chunks.length}`);
}

for (const rec of records) {
  if (!UUID_RE.test(rec.id)) fail(`id no es UUID v4: ${rec.id}`);

  const keys = Object.keys(rec.metadata ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_KEYS)) {
    fail(`metadata de ${rec.id} tiene claves ${keys.join(',')} (esperado: ${EXPECTED_KEYS.join(',')})`);
  }
  if (rec.metadata.source !== 'blob') fail(`source != 'blob' en ${rec.id}`);
  if (rec.metadata.blobType !== '') fail(`blobType != '' en ${rec.id}`);
  if (!UUID_RE.test(rec.metadata.docId)) fail(`docId no es UUID en ${rec.id}`);
  if (!/^(PREGUNTA: [\s\S]+\n)?RESPUESTA: [\s\S]+$/.test(rec.metadata.text)) {
    fail(`text sin formato PREGUNTA/RESPUESTA en ${rec.id}`);
  }
}

console.log('\nEjemplo de vector almacenado:');
console.log(JSON.stringify({ id: records[0]?.id, metadata: records[0]?.metadata }, null, 2));

if (errores === 0) {
  console.log(`\n✔ PRUEBA SUPERADA: ${records.length} vectores en '${NAMESPACE}' con la estructura de contactoupn.`);
} else {
  console.error(`\n✕ PRUEBA FALLIDA: ${errores} error(es).`);
  process.exit(1);
}
