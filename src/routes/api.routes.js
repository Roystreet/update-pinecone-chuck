/**
 * Rutas de la API.
 *
 *   POST /api/upload     -> sube un Excel y arranca el pipeline (devuelve jobId)
 *   GET  /api/jobs       -> lista los ultimos jobs
 *   GET  /api/jobs/:id   -> estado detallado de un job (pasos + progreso)
 */

import { Router } from 'express';
import multer from 'multer';
import { uploadDocument, getJob, listJobs } from '../controllers/upload.controller.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith('.xlsx');
    cb(ok ? null : new Error('Solo se aceptan archivos .xlsx'), ok);
  },
});

const router = Router();

router.post('/upload', upload.single('archivo'), uploadDocument);
router.get('/jobs', listJobs);
router.get('/jobs/:id', getJob);

export default router;
