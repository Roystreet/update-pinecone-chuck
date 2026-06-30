/**
 * Tests del servicio FAQ (estructura contactoupn).
 * Ejecutar con: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  excelToFaqChunks,
  parseFaqExcel,
  detectFaqColumns,
  parseStructuredExcel,
} from '../src/services/faq.service.js';
import { AppError } from '../src/utils/errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildXlsx(rows, sheetName = 'Hoja1') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Construye un .xlsx con varias hojas: [{ name, rows }]. */
function buildMultiSheetXlsx(sheets) {
  const wb = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('detecta columnas PREGUNTA/RESPUESTA sin importar mayusculas ni tildes', () => {
  assert.deepEqual(detectFaqColumns(['PREGUNTA', 'RESPUESTA']), { question: 0, answer: 1 });
  assert.deepEqual(detectFaqColumns(['Pregunta', 'Respuesta']), { question: 0, answer: 1 });
  assert.deepEqual(detectFaqColumns(['ID', 'Respuesta', 'Pregunta']), { question: 2, answer: 1 });
  assert.equal(detectFaqColumns(['Nombre', 'Telefono']), null);
});

test('genera chunks con la estructura contactoupn exacta', () => {
  const buffer = buildXlsx([
    ['PREGUNTA', 'RESPUESTA'],
    ['¿Qué es UPN?', 'La Universidad Privada del Norte.'],
    ['¿Dónde queda?', 'En Perú.'],
  ]);
  const chunks = excelToFaqChunks(buffer);

  assert.equal(chunks.length, 2);

  for (const chunk of chunks) {
    // id: UUID v4 (como en contactoupn)
    assert.match(chunk.id, UUID_RE, 'el id debe ser UUID v4');

    // metadata: exactamente las claves del namespace original (text se agrega en el upsert)
    assert.deepEqual(
      Object.keys(chunk.metadata).sort(),
      ['blobType', 'docId', 'line', 'source'],
    );
    assert.equal(chunk.metadata.blobType, '');
    assert.equal(chunk.metadata.source, 'blob');
    assert.match(chunk.metadata.docId, UUID_RE, 'docId debe ser UUID v4');
    assert.equal(typeof chunk.metadata.line, 'number');
  }

  // texto en formato PREGUNTA/RESPUESTA
  assert.equal(chunks[0].text, 'PREGUNTA: ¿Qué es UPN?\nRESPUESTA: La Universidad Privada del Norte.');
  assert.equal(chunks[1].text, 'PREGUNTA: ¿Dónde queda?\nRESPUESTA: En Perú.');

  // line = numero de fila real del Excel (encabezado es la fila 1)
  assert.equal(chunks[0].metadata.line, 2);
  assert.equal(chunks[1].metadata.line, 3);

  // mismo docId para todo el documento, ids distintos por chunk
  assert.equal(chunks[0].metadata.docId, chunks[1].metadata.docId);
  assert.notEqual(chunks[0].id, chunks[1].id);
});

test('fila sin respuesta se descarta; fila sin pregunta genera solo RESPUESTA', () => {
  const buffer = buildXlsx([
    ['PREGUNTA', 'RESPUESTA'],
    ['Pregunta sin respuesta', null],
    [null, 'Respuesta huérfana (continuación de un chunk).'],
    ['', '   '],
  ]);
  const chunks = excelToFaqChunks(buffer);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'RESPUESTA: Respuesta huérfana (continuación de un chunk).');
  assert.equal(chunks[0].metadata.line, 3);
});

test('Excel sin columnas PREGUNTA/RESPUESTA devuelve [] (cae al formato generico)', () => {
  const buffer = buildXlsx([
    ['Nombre', 'Edad'],
    ['Ana', 30],
  ]);
  assert.deepEqual(excelToFaqChunks(buffer), []);
});

test('parseFaqExcel reporta hojas ignoradas y filas descartadas (caso categorias.xlsx)', () => {
  // Reproduce la estructura del Excel real "categorias.xlsx":
  // una hoja FAQ valida, una hoja con otras columnas y una hoja sin encabezados
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['ID', 'PREGUNTA', 'RESPUESTA', 'PROCESO'],
      [1, '¿P1?', 'R1', 'Matrícula'],
      [2, '¿P2 sin respuesta?', null, 'Pagos'],
    ]),
    'BASE ACTUALIZADA',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['ID', 'title', 'summary'], [0, 'Doc', 'Resumen']]),
    'BASE DESCRIPCIONES',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([[646, 'pregunta suelta sin encabezado', null]]),
    'BASE POR COMPLETAR',
  );
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const { chunks, sheets } = parseFaqExcel(buffer);

  assert.equal(chunks.length, 1); // solo la fila con respuesta
  assert.deepEqual(sheets, [
    { name: 'BASE ACTUALIZADA', status: 'procesada', chunks: 1, descartadas: 1 },
    { name: 'BASE DESCRIPCIONES', status: 'sin_columnas', chunks: 0, descartadas: 0 },
    { name: 'BASE POR COMPLETAR', status: 'vacia', chunks: 0, descartadas: 0 },
  ]);
});

test('procesa varias hojas y mantiene un solo docId por documento', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['PREGUNTA', 'RESPUESTA'], ['P1', 'R1']]),
    'HojaA',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['Pregunta', 'Respuesta'], ['P2', 'R2']]),
    'HojaB',
  );
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const chunks = excelToFaqChunks(buffer);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].metadata.docId, chunks[1].metadata.docId);
});

// ----------------------------------------------------------------- parseStructuredExcel

test('parseStructuredExcel: 3 procesos acumulan P1 + P2 + descripciones', () => {
  const buffer = buildMultiSheetXlsx([
    {
      name: 'Base Actualizada', // con tildes/mayusculas/espacios: se reconoce igual
      rows: [
        ['ID', 'PREGUNTA', 'RESPUESTA'],
        [1, '¿Qué es UPN?', 'La Universidad Privada del Norte.'],
        [2, null, 'Respuesta huérfana.'],        // sin pregunta -> solo RESPUESTA en P1 y P2
        [3, 'Pregunta sin respuesta', null],      // descartada
      ],
    },
    {
      name: 'BASE DESCRIPCIONES',
      rows: [
        ['ID', 'title', 'summary'],
        [10, 'Matrícula', 'Proceso de inscripción.'],
        [11, 'Pagos', 'Cuotas y pensiones.'],
      ],
    },
  ]);

  const { chunks, processes, warnings } = parseStructuredExcel(buffer);

  // 2 filas con respuesta -> P1=2, P2=2 ; 2 filas de descripciones -> 2
  assert.deepEqual(processes, { p1: 2, p2: 2, descripciones: 2, total: 6 });
  assert.equal(chunks.length, 6);

  // todos los chunks: metadata contactoupn + un unico docId
  const docIds = new Set();
  for (const chunk of chunks) {
    assert.match(chunk.id, UUID_RE);
    assert.deepEqual(Object.keys(chunk.metadata).sort(), ['blobType', 'docId', 'line', 'source']);
    assert.equal(chunk.metadata.blobType, '');
    assert.equal(chunk.metadata.source, 'blob');
    assert.match(chunk.metadata.docId, UUID_RE);
    assert.equal(typeof chunk.metadata.line, 'number');
    docIds.add(chunk.metadata.docId);
  }
  assert.equal(docIds.size, 1, 'un unico docId para toda la carga');

  // P1 (PREGUNTA+RESPUESTA) y P2 (solo RESPUESTA) de la primera fila
  assert.equal(chunks[0].text, 'PREGUNTA: ¿Qué es UPN?\nRESPUESTA: La Universidad Privada del Norte.');
  assert.equal(chunks[1].text, 'RESPUESTA: La Universidad Privada del Norte.');
  assert.equal(chunks[0].metadata.line, 2);
  assert.equal(chunks[1].metadata.line, 2);

  // fila sin pregunta -> P1 y P2 ambos solo RESPUESTA
  assert.equal(chunks[2].text, 'RESPUESTA: Respuesta huérfana.');
  assert.equal(chunks[3].text, 'RESPUESTA: Respuesta huérfana.');

  // P3 descripciones en formato generico "Columna: valor | ..."
  assert.equal(chunks[4].text, 'ID: 10 | title: Matrícula | summary: Proceso de inscripción.');
  assert.equal(chunks[4].metadata.line, 2);

  // aviso por la fila con pregunta pero sin respuesta
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /descartaron 1 fila/);
});

test('parseStructuredExcel: falta una hoja obligatoria -> AppError', () => {
  const soloActualizada = buildMultiSheetXlsx([
    { name: 'base actualizada', rows: [['PREGUNTA', 'RESPUESTA'], ['P1', 'R1']] },
  ]);
  assert.throws(() => parseStructuredExcel(soloActualizada), AppError);

  const soloDescripciones = buildMultiSheetXlsx([
    { name: 'base descripciones', rows: [['title'], ['x']] },
  ]);
  assert.throws(() => parseStructuredExcel(soloDescripciones), AppError);
});

test('parseStructuredExcel: "base actualizada" sin PREGUNTA/RESPUESTA -> AppError', () => {
  const buffer = buildMultiSheetXlsx([
    { name: 'base actualizada', rows: [['Nombre', 'Edad'], ['Ana', 30]] },
    { name: 'base descripciones', rows: [['title'], ['x']] },
  ]);
  assert.throws(() => parseStructuredExcel(buffer), AppError);
});

test('parseStructuredExcel: "base descripciones" vacia genera warning, no error', () => {
  const buffer = buildMultiSheetXlsx([
    { name: 'base actualizada', rows: [['PREGUNTA', 'RESPUESTA'], ['P1', 'R1']] },
    { name: 'base descripciones', rows: [['title']] }, // solo encabezado, sin datos
  ]);
  const { processes, warnings } = parseStructuredExcel(buffer);
  assert.deepEqual(processes, { p1: 1, p2: 1, descripciones: 0, total: 2 });
  assert.ok(warnings.some(w => /no tiene filas de datos/.test(w)));
});
