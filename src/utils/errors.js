/**
 * Manejo de errores amigable para el usuario.
 *
 * - AppError: error de negocio con mensaje claro y una sugerencia (hint)
 *   de como resolverlo.
 * - translateError: convierte cualquier error tecnico (OpenAI, Pinecone,
 *   red, etc.) en { message, hint } entendible para quien usa el frontend.
 */

export class AppError extends Error {
  constructor(message, hint = null) {
    super(message);
    this.name = 'AppError';
    this.hint = hint;
  }
}

export function translateError(err) {
  // Errores de negocio ya escritos para el usuario
  if (err instanceof AppError) {
    return { message: err.message, hint: err.hint };
  }

  const msg = String(err?.message ?? err);
  const name = String(err?.name ?? '');
  const status = err?.status ?? err?.statusCode ?? null;

  // ---- OpenAI (embeddings) ----
  if (name === 'AuthenticationError' || (status === 401 && msg.toLowerCase().includes('api key'))) {
    return {
      message: 'La API key de OpenAI no es válida o fue revocada.',
      hint: 'Revisa OPENAI_API_KEY en el archivo .env del servidor.',
    };
  }
  if (name === 'RateLimitError' || status === 429) {
    return {
      message: 'Se alcanzó el límite de uso de la API de embeddings (OpenAI).',
      hint: 'Espera unos minutos y reintenta. Si persiste, revisa la cuota/billing de la cuenta de OpenAI.',
    };
  }

  // ---- Pinecone ----
  if (name === 'PineconeAuthorizationError' || msg.includes('"status":401') || msg.includes('"status":403')) {
    return {
      message: 'Pinecone rechazó las credenciales.',
      hint: 'Revisa PINECONE_API_KEY en el .env y que la key pertenezca al proyecto correcto.',
    };
  }
  if (name === 'PineconeNotFoundError' || (msg.toLowerCase().includes('not found') && msg.toLowerCase().includes('index'))) {
    return {
      message: `El índice de Pinecone configurado no existe (${process.env.PINECONE_INDEX ?? 'sin configurar'}).`,
      hint: 'Revisa PINECONE_INDEX en el .env o crea el índice en app.pinecone.io.',
    };
  }
  if (name === 'PineconeConnectionError') {
    return {
      message: 'No se pudo conectar con Pinecone.',
      hint: 'Revisa la conexión a internet del servidor y el estado de Pinecone (status.pinecone.io).',
    };
  }

  // ---- Red en general ----
  if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED' || msg.includes('fetch failed')) {
    return {
      message: 'Falló la conexión con un servicio externo (OpenAI o Pinecone).',
      hint: 'Revisa la conexión a internet del servidor y reintenta.',
    };
  }

  // ---- Archivos / parseo ----
  if (msg.includes('Unsupported file') || msg.includes('Corrupted zip') || msg.includes('End of data')) {
    return {
      message: 'El archivo no se pudo leer como un Excel válido (.xlsx).',
      hint: 'Vuelve a guardarlo desde Excel como "Libro de Excel (*.xlsx)" y súbelo de nuevo.',
    };
  }

  // ---- Por defecto: mostrar el error tecnico con una guia ----
  return {
    message: `Error inesperado: ${msg}`,
    hint: 'Reintenta la carga. Si el problema persiste, revisa los logs del servidor.',
  };
}
