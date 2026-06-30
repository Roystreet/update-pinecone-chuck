/**
 * Servicio de jobs: lleva el estado de cada carga para que el frontend
 * pueda mostrar los pasos y el progreso en tiempo real (por polling).
 *
 * Almacenamiento en memoria — suficiente para un monolito de instancia unica.
 * Si en el futuro se escala a varias instancias, cambiar el Map por Redis.
 */

import crypto from 'node:crypto';

const STEPS = [
  { name: 'parseo', label: 'Leer y trocear el Excel' },
  { name: 'embeddings', label: 'Generar embeddings' },
  { name: 'limpieza', label: 'Vaciar el namespace en Pinecone' },
  { name: 'upsert', label: 'Cargar los vectores nuevos' },
];

const MAX_JOBS = 50; // retener solo los ultimos N jobs en memoria
const jobs = new Map();

export function createJob({ filename, namespace }) {
  const job = {
    id: crypto.randomUUID(),
    filename,
    namespace,
    status: 'en_proceso', // en_proceso | completado | error
    error: null,      // mensaje claro para el usuario
    errorHint: null,  // sugerencia de como resolverlo
    warnings: [],     // avisos no fatales (hojas ignoradas, filas descartadas, etc.)
    createdAt: new Date().toISOString(),
    finishedAt: null,
    steps: STEPS.map(s => ({
      name: s.name,
      label: s.label,
      status: 'pendiente', // pendiente | en_progreso | completado | error
      detail: null,
      progress: null, // { done, total } en pasos con avance medible
    })),
  };
  jobs.set(job.id, job);

  // Evitar crecimiento indefinido de la memoria
  if (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    jobs.delete(oldest);
  }
  return job;
}

function step(jobId, name) {
  return jobs.get(jobId)?.steps.find(s => s.name === name);
}

export function startStep(jobId, name) {
  const s = step(jobId, name);
  if (s) s.status = 'en_progreso';
}

export function setProgress(jobId, name, done, total) {
  const s = step(jobId, name);
  if (s) s.progress = { done, total };
}

export function completeStep(jobId, name, detail = null) {
  const s = step(jobId, name);
  if (s) {
    s.status = 'completado';
    s.detail = detail;
  }
}

export function addWarnings(jobId, warnings) {
  const job = jobs.get(jobId);
  if (job && warnings.length > 0) job.warnings.push(...warnings);
}

export function failJob(jobId, message, hint = null) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'error';
  job.error = message;
  job.errorHint = hint;
  job.finishedAt = new Date().toISOString();
  const current = job.steps.find(s => s.status === 'en_progreso');
  if (current) current.status = 'error';
}

export function finishJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'completado';
  job.finishedAt = new Date().toISOString();
}

export function getJob(jobId) {
  return jobs.get(jobId) ?? null;
}

export function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, filename, namespace, status, createdAt, finishedAt, error, warnings }) =>
      ({ id, filename, namespace, status, createdAt, finishedAt, error, warnings: warnings.length }));
}
