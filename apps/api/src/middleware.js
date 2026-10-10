import { prisma } from './db.js';

// Bloquea cualquier ruta protegida si no hay una clave de API validada.
export async function requireApiKey(req, res, next) {
  const s = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!s || !s.isValid || !s.apiKeyEnc) {
    return res.status(403).json({
      code: 'API_KEY_REQUIRED',
      message: 'Configura una clave de API válida en Ajustes para usar la aplicación.',
    });
  }
  req.settings = s;
  next();
}
