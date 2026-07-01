/**
 * Punto de entrada del monolito.
 * Sirve el frontend estatico (public/) y monta la API (src/routes/).
 */

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import apiRoutes from './src/routes/api.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

for (const name of ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'PINECONE_API_KEY', 'PINECONE_INDEX']) {
  if (!process.env[name]) {
    console.error(`Falta la variable de entorno ${name} (revisa tu archivo .env)`);
    process.exit(1);
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRoutes);

// Manejador de errores central (incluye errores de multer, p. ej. archivo muy grande)
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Frontend de actualizacion escuchando en http://localhost:${port}`);
});
