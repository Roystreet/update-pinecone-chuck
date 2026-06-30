/**
 * Tests de la traduccion de errores tecnicos a mensajes para el usuario.
 * Ejecutar con: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, translateError } from '../src/utils/errors.js';

test('AppError conserva su mensaje y sugerencia', () => {
  const result = translateError(new AppError('El Excel está vacío.', 'Agrega filas de datos.'));
  assert.equal(result.message, 'El Excel está vacío.');
  assert.equal(result.hint, 'Agrega filas de datos.');
});

test('error 401 de OpenAI se traduce a mensaje de API key', () => {
  const err = Object.assign(new Error('Incorrect API key provided'), {
    name: 'AuthenticationError',
    status: 401,
  });
  const result = translateError(err);
  assert.match(result.message, /OpenAI/);
  assert.match(result.hint, /OPENAI_API_KEY/);
});

test('error 429 se traduce a mensaje de limite de uso', () => {
  const err = Object.assign(new Error('Rate limit reached'), { status: 429 });
  const result = translateError(err);
  assert.match(result.message, /límite de uso/);
});

test('error de autorizacion de Pinecone se traduce a mensaje de credenciales', () => {
  const err = Object.assign(new Error('{"status":401}'), { name: 'PineconeAuthorizationError' });
  const result = translateError(err);
  assert.match(result.message, /Pinecone/);
  assert.match(result.hint, /PINECONE_API_KEY/);
});

test('error de conexion se traduce a mensaje de red', () => {
  const err = Object.assign(new Error('getaddrinfo ENOTFOUND api.openai.com'), { code: 'ENOTFOUND' });
  const result = translateError(err);
  assert.match(result.message, /conexión/);
});

test('archivo corrupto se traduce a mensaje de Excel invalido', () => {
  const result = translateError(new Error('Corrupted zip: missing bytes'));
  assert.match(result.message, /Excel válido/);
  assert.match(result.hint, /xlsx/);
});

test('error desconocido conserva el detalle tecnico con guia generica', () => {
  const result = translateError(new Error('algo exploto'));
  assert.match(result.message, /algo exploto/);
  assert.ok(result.hint);
});
