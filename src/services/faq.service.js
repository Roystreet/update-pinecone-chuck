/**
 * Servicio de formato FAQ: convierte un Excel de preguntas/respuestas en
 * chunks con la MISMA estructura del namespace 'contactoupn' del indice 'upn'
 * (documentada en docs/estructura-upn-contactoupn.md):
 *
 *   id:        UUID v4
 *   metadata:  {
 *     text:     "PREGUNTA: ...\nRESPUESTA: ...",
 *     docId:    UUID del documento de origen (uno por carga),
 *     line:     numero de fila en el documento,
 *     source:   "blob",
 *     blobType: ""
 *   }
 *
 * El Excel debe tener una columna de pregunta y una de respuesta
 * (se aceptan los encabezados: pregunta/question y respuesta/answer,
 * sin distinguir mayusculas ni tildes).
 */

import crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import { genericRowText } from './excel.service.js';
import { AppError } from '../utils/errors.js';

const QUESTION_HEADERS = ['pregunta', 'preguntas', 'question'];
const ANSWER_HEADERS = ['respuesta', 'respuestas', 'answer'];

// Nombres (normalizados) de las dos hojas obligatorias del formato estructurado.
const SHEET_ACTUALIZADA = 'base actualizada';
const SHEET_DESCRIPCIONES = 'base descripciones';

function normalizeHeader(h) {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // quitar tildes (diacriticos combinantes)
}

/** Devuelve los indices de las columnas pregunta/respuesta, o null si no existen. */
export function detectFaqColumns(headers) {
  const normalized = headers.map(normalizeHeader);
  const q = normalized.findIndex(h => QUESTION_HEADERS.includes(h));
  const a = normalized.findIndex(h => ANSWER_HEADERS.includes(h));
  return q !== -1 && a !== -1 ? { question: q, answer: a } : null;
}

/**
 * Convierte el buffer .xlsx en chunks con la estructura contactoupn y
 * devuelve ademas un reporte por hoja para informar al usuario que se
 * proceso, que se ignoro y por que.
 *
 * Retorno: {
 *   chunks: [...],
 *   sheets: [{ name, status: 'procesada'|'sin_columnas'|'vacia', chunks, descartadas }]
 * }
 *
 * Si ninguna hoja tiene columnas PREGUNTA/RESPUESTA, chunks queda []
 * (el controlador usa eso para caer al formato generico).
 */
export function parseFaqExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const docId = crypto.randomUUID(); // un docId por documento subido, como en el original
  const chunks = [];
  const sheets = [];

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
    if (rows.length < 2) {
      sheets.push({ name: sheetName, status: 'vacia', chunks: 0, descartadas: 0 });
      continue;
    }

    const cols = detectFaqColumns(rows[0]);
    if (!cols) {
      sheets.push({ name: sheetName, status: 'sin_columnas', chunks: 0, descartadas: 0 });
      continue;
    }

    let added = 0;
    let descartadas = 0;
    rows.slice(1).forEach((row, i) => {
      const pregunta = row[cols.question];
      const respuesta = row[cols.answer];
      const hayPregunta = pregunta != null && String(pregunta).trim() !== '';
      const hayRespuesta = respuesta != null && String(respuesta).trim() !== '';

      if (!hayRespuesta) {
        // sin respuesta no hay chunk; si la fila tenia pregunta, avisamos que se descarto
        if (hayPregunta) descartadas += 1;
        return;
      }

      const parts = [];
      if (hayPregunta) parts.push(`PREGUNTA: ${String(pregunta).trim()}`);
      parts.push(`RESPUESTA: ${String(respuesta).trim()}`);

      chunks.push({
        id: crypto.randomUUID(),
        text: parts.join('\n'),
        metadata: {
          blobType: '',
          docId,
          line: i + 2, // numero de fila real en el Excel
          source: 'blob',
        },
      });
      added += 1;
    });

    sheets.push({ name: sheetName, status: 'procesada', chunks: added, descartadas });
  }
  return { chunks, sheets };
}

/** Busca una hoja por su nombre normalizado (tolera mayusculas/tildes/espacios). */
function findSheet(wb, normalizedName) {
  return wb.SheetNames.find(n => normalizeHeader(n) === normalizedName) ?? null;
}

/**
 * Formato estructurado obligatorio: el Excel debe traer SIEMPRE dos hojas,
 * "base actualizada" y "base descripciones". La indexacion se arma en tres
 * procesos cuyo resultado se ACUMULA (la suma total se sube en un solo upsert):
 *
 *   P1 — base actualizada, PREGUNTA + RESPUESTA  (texto "PREGUNTA: ...\nRESPUESTA: ...")
 *   P2 — base actualizada, solo RESPUESTA        (texto "RESPUESTA: ...", redundante a proposito)
 *   P3 — base descripciones, generico            (texto "Columna: valor | Columna: valor")
 *
 * Todos los chunks usan la metadata contactoupn (text, docId, line, source, blobType)
 * y comparten un unico docId por carga. La redundancia P1+P2 es intencional: mejora
 * la confiabilidad de recuperacion del RAG.
 *
 * Lanza AppError si falta alguna hoja obligatoria o si "base actualizada" no tiene
 * columnas PREGUNTA/RESPUESTA.
 *
 * Retorno: {
 *   chunks: [...],
 *   processes: { p1, p2, descripciones, total },
 *   warnings: [string]
 * }
 */
export function parseStructuredExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });

  const actualizadaName = findSheet(wb, SHEET_ACTUALIZADA);
  const descripcionesName = findSheet(wb, SHEET_DESCRIPCIONES);

  const faltantes = [];
  if (!actualizadaName) faltantes.push('"base actualizada"');
  if (!descripcionesName) faltantes.push('"base descripciones"');
  if (faltantes.length > 0) {
    throw new AppError(
      `El Excel debe tener las hojas obligatorias ${faltantes.join(' y ')}.`,
      'El archivo siempre debe contener una hoja "base actualizada" (con columnas ' +
      'PREGUNTA y RESPUESTA) y una hoja "base descripciones". Revisa los nombres de las hojas.',
    );
  }

  const docId = crypto.randomUUID(); // un docId por documento subido
  const chunks = [];
  const warnings = [];
  const counts = { p1: 0, p2: 0, descripciones: 0 };

  // ---- Procesos 1 y 2: hoja "base actualizada" (PREGUNTA/RESPUESTA) ----
  const rowsA = XLSX.utils.sheet_to_json(wb.Sheets[actualizadaName], { header: 1, defval: null });
  const cols = rowsA.length > 0 ? detectFaqColumns(rowsA[0]) : null;
  if (!cols) {
    throw new AppError(
      `La hoja "${actualizadaName}" no tiene columnas PREGUNTA y RESPUESTA.`,
      'Asegurate de que la primera fila de "base actualizada" tenga los encabezados ' +
      'PREGUNTA y RESPUESTA (se aceptan mayusculas/minusculas, tildes y question/answer).',
    );
  }

  let descartadas = 0;
  rowsA.slice(1).forEach((row, i) => {
    const pregunta = row[cols.question];
    const respuesta = row[cols.answer];
    const hayPregunta = pregunta != null && String(pregunta).trim() !== '';
    const hayRespuesta = respuesta != null && String(respuesta).trim() !== '';

    if (!hayRespuesta) {
      // sin respuesta no hay chunk; si la fila tenia pregunta, avisamos que se descarto
      if (hayPregunta) descartadas += 1;
      return;
    }

    const line = i + 2; // numero de fila real en el Excel
    const respuestaText = `RESPUESTA: ${String(respuesta).trim()}`;

    // P1: PREGUNTA + RESPUESTA (si no hay pregunta, queda solo RESPUESTA)
    const p1Parts = [];
    if (hayPregunta) p1Parts.push(`PREGUNTA: ${String(pregunta).trim()}`);
    p1Parts.push(respuestaText);
    chunks.push(buildContactoupnChunk(p1Parts.join('\n'), docId, line));
    counts.p1 += 1;

    // P2: solo RESPUESTA (chunk adicional, redundancia intencional)
    chunks.push(buildContactoupnChunk(respuestaText, docId, line));
    counts.p2 += 1;
  });

  if (descartadas > 0) {
    warnings.push(
      `En la hoja "${actualizadaName}" se descartaron ${descartadas} fila(s) que tienen pregunta pero no respuesta.`
    );
  }

  // ---- Proceso 3: hoja "base descripciones" (generico) ----
  const rowsD = XLSX.utils.sheet_to_json(wb.Sheets[descripcionesName], { header: 1, defval: null });
  if (rowsD.length < 2) {
    warnings.push(`La hoja "${descripcionesName}" no tiene filas de datos; no se indexo ninguna descripcion.`);
  } else {
    const headers = rowsD[0].map((h, i) => (h != null ? String(h) : `col${i + 1}`));
    rowsD.slice(1).forEach((row, i) => {
      const text = genericRowText(headers, row);
      if (text === '') return;
      chunks.push(buildContactoupnChunk(text, docId, i + 2));
      counts.descripciones += 1;
    });
  }

  return {
    chunks,
    processes: { ...counts, total: chunks.length },
    warnings,
  };
}

/** Crea un chunk con la estructura de metadata contactoupn. */
function buildContactoupnChunk(text, docId, line) {
  return {
    id: crypto.randomUUID(),
    text,
    metadata: { blobType: '', docId, line, source: 'blob' },
  };
}

/** Version simple que devuelve solo los chunks (retrocompatibilidad). */
export function excelToFaqChunks(buffer) {
  return parseFaqExcel(buffer).chunks;
}
