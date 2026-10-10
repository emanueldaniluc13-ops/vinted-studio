import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import settings from './routes/settings.js';
import products from './routes/products.js';
import { requireApiKey } from './middleware.js';
import { requireAuth, login, authEnabled } from './auth.js';
import { ensureBucket } from './storage.js';

if (process.env.NODE_ENV === 'production' && !authEnabled()) {
  console.error('Falta APP_PASSWORD: en producción la app necesita contraseña para no quedar abierta a cualquiera.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(cors({
  origin: (process.env.WEB_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()),
  exposedHeaders: ['Content-Disposition'],
}));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/api/auth/login', login);
app.use('/api', requireAuth);                               // todo lo demás exige sesión
app.use('/api/settings', settings);                         // aquí se configura la API de IA
app.use('/api/products', requireApiKey, products);          // bloqueada sin API válida

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ code: 'SERVER_ERROR', message: err.message });
});

await ensureBucket();
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API lista en http://localhost:${port}`));
