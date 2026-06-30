/**
 * Controlador: orquesta el pipeline de actualizacion.
 *
 * El POST responde de inmediato con un jobId (202 Accepted) y el pipeline
 * corre en segundo plano actualizando el estado del job, que el frontend
 * consulta por polling para pintar el progreso paso a paso.
 *
 * Pipeline:  parseo -> embeddings -> limpieza del namespace -> upsert
 */

import * as jobService from '../services/job.service.js';
import { parseStructuredExcel } from '../services/faq.service.js';
import { embedTexts } from '../services/embedding.service.js';
import { clearNamespace, upsertVectors } from '../services/pinecone.service.js';
import { AppError, translateError } from '../utils/errors.js';

export function uploadDocument(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibio ningun archivo (campo "archivo")' });
  }
  const namespace = (req.body.namespace || process.env.PINECONE_NAMESPACE || '').trim();
  if (!namespace) {
    return res.status(400).json({ error: 'Falta el namespace (formulario o PINECONE_NAMESPACE)' });
  }

  const job = jobService.createJob({ filename: req.file.originalname, namespace });
  res.status(202).json({ jobId: job.id });

  runPipeline(job.id, namespace, req.file).catch(err => {
    console.error(`[job ${job.id}]`, err);
    const friendly = translateError(err);
    jobService.failJob(job.id, friendly.message, friendly.hint);
  });
}

async function runPipeline(jobId, namespace, file) {
  // 1. Parseo del Excel — formato estructurado obligatorio: dos hojas
  //    ("base actualizada" y "base descripciones") procesadas en tres procesos
  //    (P1 PREGUNTA+RESPUESTA, P2 solo RESPUESTA, P3 descripciones genericas)
  //    cuyo resultado se acumula y se sube como suma total.
  jobService.startStep(jobId, 'parseo');
  const { chunks, processes, warnings } = parseStructuredExcel(file.buffer);

  jobService.addWarnings(jobId, warnings);

  if (chunks.length === 0) {
    throw new AppError(
      'El Excel no contiene filas de datos indexables.',
      'La hoja "base actualizada" necesita al menos una fila con respuesta y/o la hoja ' +
      '"base descripciones" al menos una fila de datos.'
    );
  }
  jobService.completeStep(
    jobId,
    'parseo',
    `P1 P+R: ${processes.p1} · P2 R: ${processes.p2} · descripciones: ${processes.descripciones} · total ${processes.total}`,
  );

  // 2. Embeddings
  jobService.startStep(jobId, 'embeddings');
  const embeddings = await embedTexts(
    chunks.map(c => c.text),
    (done, total) => jobService.setProgress(jobId, 'embeddings', done, total),
  );
  jobService.completeStep(jobId, 'embeddings', `${embeddings.length} vectores generados`);

  // 3. Vaciar el namespace (borrar la informacion anterior)
  jobService.startStep(jobId, 'limpieza');
  await clearNamespace(namespace);
  jobService.completeStep(jobId, 'limpieza', `namespace '${namespace}' vaciado`);

  // 4. Cargar los vectores nuevos
  jobService.startStep(jobId, 'upsert');
  await upsertVectors(
    namespace,
    chunks,
    embeddings,
    (done, total) => jobService.setProgress(jobId, 'upsert', done, total),
  );
  jobService.completeStep(jobId, 'upsert', `${chunks.length} vectores cargados`);

  jobService.finishJob(jobId);
}

export function getJob(req, res) {
  const job = jobService.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
}

export function listJobs(_req, res) {
  res.json(jobService.listJobs());
}
