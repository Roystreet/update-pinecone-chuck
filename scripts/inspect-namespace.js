/**
 * Inspecciona la estructura de un namespace de Pinecone y genera un MD
 * documentando el formato de los metadatos de sus vectores.
 *
 * Uso:
 *   node scripts/inspect-namespace.js <indice>               -> lista los namespaces del indice
 *   node scripts/inspect-namespace.js <indice> <namespace>   -> analiza y genera docs/estructura-<indice>-<namespace>.md
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pinecone } from '@pinecone-database/pinecone';

const SAMPLE_SIZE = 100;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [indexName, namespaceName] = process.argv.slice(2);
if (!indexName) {
  console.error('Uso: node scripts/inspect-namespace.js <indice> [namespace]');
  process.exit(1);
}

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(indexName);

// ---------------------------------------------------------------- listar namespaces

const stats = await index.describeIndexStats();

if (!namespaceName) {
  console.log(`Namespaces del indice '${indexName}' (dim=${stats.dimension}):`);
  for (const [name, info] of Object.entries(stats.namespaces ?? {})) {
    console.log(`  - '${name}': ${info.recordCount} vectores`);
  }
  process.exit(0);
}

const nsInfo = stats.namespaces?.[namespaceName];
if (!nsInfo) {
  console.error(`El namespace '${namespaceName}' no existe en '${indexName}'. Disponibles:`);
  for (const name of Object.keys(stats.namespaces ?? {})) console.error(`  - '${name}'`);
  process.exit(1);
}

// ---------------------------------------------------------------- muestrear vectores

console.log(`Analizando '${indexName}' / '${namespaceName}' (${nsInfo.recordCount} vectores)...`);
const ns = index.namespace(namespaceName);

const listed = await ns.listPaginated({ limit: SAMPLE_SIZE });
const ids = (listed.vectors ?? []).map(v => v.id);
if (ids.length === 0) {
  console.error('El namespace no devolvio IDs (esta vacio?).');
  process.exit(1);
}

const fetched = await ns.fetch(ids);
const records = Object.values(fetched.records ?? {});
console.log(`Muestra obtenida: ${records.length} vectores.`);

// ---------------------------------------------------------------- analizar esquema

function jsType(value) {
  if (Array.isArray(value)) return 'lista de strings';
  if (typeof value === 'number') return Number.isInteger(value) ? 'numero (entero)' : 'numero (decimal)';
  if (typeof value === 'boolean') return 'booleano';
  return 'string';
}

const fields = new Map(); // key -> { types:Set, examples:Set, count }
for (const rec of records) {
  for (const [key, value] of Object.entries(rec.metadata ?? {})) {
    if (!fields.has(key)) fields.set(key, { types: new Set(), examples: new Set(), count: 0 });
    const f = fields.get(key);
    f.types.add(jsType(value));
    f.count += 1;
    if (f.examples.size < 3) {
      const ex = JSON.stringify(value);
      f.examples.add(ex.length > 120 ? ex.slice(0, 120) + '…"' : ex);
    }
  }
}

// ---------------------------------------------------------------- generar el MD

const sample = records.slice(0, 3).map(r => ({
  id: r.id,
  metadata: r.metadata,
}));

const rows = [...fields.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .map(([key, f]) => {
    const presence = Math.round((f.count / records.length) * 100);
    const required = f.count === records.length ? 'Sí' : `No (${presence}%)`;
    return `| \`${key}\` | ${[...f.types].join(' / ')} | ${required} | ${[...f.examples].join(' · ')} |`;
  })
  .join('\n');

const md = `# Estructura del namespace \`${namespaceName}\` (índice \`${indexName}\`)

> Generado automáticamente el ${new Date().toISOString().slice(0, 10)} con \`scripts/inspect-namespace.js\`
> a partir de una muestra de **${records.length} vectores** (de ${nsInfo.recordCount} totales).
> Cualquier carga nueva sobre este namespace debe **respetar este formato** para mantener
> compatibilidad con los consumidores actuales del índice.

## Índice

| Propiedad | Valor |
|---|---|
| Índice | \`${indexName}\` |
| Namespace | \`${namespaceName}\` |
| Dimensión | ${stats.dimension} |
| Total de vectores | ${nsInfo.recordCount} |

## Formato del ID

Ejemplos de IDs reales:

${ids.slice(0, 5).map(id => `- \`${id}\``).join('\n')}

## Esquema de metadata

| Campo | Tipo | ¿Presente en todos? | Ejemplos |
|---|---|---|---|
${rows}

## Registros de muestra

\`\`\`json
${JSON.stringify(sample, null, 2)}
\`\`\`
`;

const outDir = path.join(__dirname, '..', 'docs');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `estructura-${indexName}-${namespaceName.replace(/[^a-z0-9_-]/gi, '_')}.md`);
fs.writeFileSync(outFile, md, 'utf8');
console.log(`✔ Documento generado: ${outFile}`);
