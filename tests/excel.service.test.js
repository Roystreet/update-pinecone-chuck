/**
 * Tests del servicio generico de Excel.
 * Ejecutar con: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { excelToChunks } from '../src/services/excel.service.js';

function buildXlsx(rows, sheetName = 'Hoja1') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('convierte filas en chunks "Columna: valor | Columna: valor"', () => {
  const buffer = buildXlsx([
    ['Nombre', 'Cargo'],
    ['Ana', 'Directora'],
    ['Luis', 'Analista'],
  ]);
  const chunks = excelToChunks(buffer, 'equipo.xlsx');

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'Nombre: Ana | Cargo: Directora');
  assert.equal(chunks[0].id, 'equipo.xlsx:Hoja1:2');
  assert.deepEqual(chunks[0].metadata, { archivo: 'equipo.xlsx', hoja: 'Hoja1', fila: 2 });
});

test('omite filas vacias y celdas sin valor', () => {
  const buffer = buildXlsx([
    ['A', 'B'],
    [null, null],
    ['x', null],
  ]);
  const chunks = excelToChunks(buffer, 'datos.xlsx');

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'A: x');
  assert.equal(chunks[0].metadata.fila, 3);
});

test('hoja sin datos devuelve []', () => {
  const buffer = buildXlsx([['Solo', 'Encabezados']]);
  assert.deepEqual(excelToChunks(buffer, 'vacio.xlsx'), []);
});
