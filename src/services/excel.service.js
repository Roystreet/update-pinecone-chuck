/**
 * Servicio de Excel: convierte un buffer .xlsx en chunks de texto.
 *
 * Cada fila de datos se transforma en "Columna1: valor | Columna2: valor ..."
 * usando la primera fila de cada hoja como encabezados. El id del chunk
 * (archivo:hoja:fila) es estable, y la metadata permite citar la fuente
 * desde el RAG.
 */

import * as XLSX from 'xlsx';

/**
 * Convierte una fila en el texto generico "Columna: valor | Columna: valor",
 * omitiendo las celdas vacias. Devuelve '' si la fila no tiene ningun valor.
 * Es la unica fuente de verdad del formato generico (la reutiliza tambien el
 * proceso de "base descripciones" en faq.service.js).
 */
export function genericRowText(headers, row) {
  return headers
    .map((h, c) => (row[c] != null && row[c] !== '' ? `${h}: ${row[c]}` : null))
    .filter(Boolean)
    .join(' | ');
}

export function excelToChunks(buffer, filename) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const chunks = [];

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
    if (rows.length < 2) continue;

    const headers = rows[0].map((h, i) => (h != null ? String(h) : `col${i + 1}`));

    rows.slice(1).forEach((row, i) => {
      const text = genericRowText(headers, row);
      if (text === '') return;

      const rowNum = i + 2; // numero de fila real en el Excel
      chunks.push({
        id: `${filename}:${sheetName}:${rowNum}`,
        text,
        metadata: { archivo: filename, hoja: sheetName, fila: rowNum },
      });
    });
  }
  return chunks;
}
