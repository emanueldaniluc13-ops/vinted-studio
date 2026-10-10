import { Router } from 'express';
import { prisma } from '../db.js';
import { encrypt } from '../crypto.js';
import { PROVIDERS, publicProviders } from '../providers.js';

const r = Router();

r.get('/status', async (_req, res) => {
  const s = await prisma.settings.findUnique({ where: { id: 1 } });
  const provider = PROVIDERS[s?.provider] ? s.provider : 'gemini';
  res.json({
    configured: !!s?.apiKeyEnc,
    isValid: !!s?.isValid,
    provider,
    model: s?.model || PROVIDERS[provider].defaultModel,
    validatedAt: s?.validatedAt || null,
    providers: publicProviders(),
  });
});

r.post('/models', async (req, res) => {
  const P = PROVIDERS[String(req.body?.provider || '')];
  if (!P) return res.status(400).json({ code: 'INVALID_PROVIDER', message: 'Proveedor no soportado.' });
  const apiKey = String(req.body?.apiKey || '').trim();
  if (apiKey.length < 20)
    return res.status(400).json({ code: 'INVALID_KEY', message: 'Introduce primero la clave de API completa.' });
  const out = await P.listModels(apiKey);
  if (!out.ok) return res.status(400).json({ code: 'INVALID_KEY', message: out.message });
  res.json({ models: out.models });
});

r.post('/api-key', async (req, res) => {
  const provider = String(req.body?.provider || 'gemini');
  const P = PROVIDERS[provider];
  if (!P) return res.status(400).json({ code: 'INVALID_PROVIDER', message: 'Proveedor no soportado.' });
  const apiKey = String(req.body?.apiKey || '').trim();
  const model = String(req.body?.model || '').trim() || P.defaultModel;
  if (apiKey.length < 20)
    return res.status(400).json({ code: 'INVALID_KEY', message: 'Introduce la clave de API completa.' });

  const check = await P.validate(apiKey, model);
  if (!check.ok) {
    await prisma.settings.upsert({
      where: { id: 1 }, create: { id: 1, provider, model, isValid: false }, update: { provider, model, isValid: false },
    });
    return res.status(400).json({ code: 'INVALID_KEY', message: check.message });
  }
  const data = { provider, apiKeyEnc: encrypt(apiKey), model, isValid: true, validatedAt: new Date() };
  await prisma.settings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  res.json({ isValid: true, provider, model });
});

r.delete('/api-key', async (_req, res) => {
  await prisma.settings.upsert({
    where: { id: 1 }, create: { id: 1 }, update: { apiKeyEnc: null, isValid: false, validatedAt: null },
  });
  res.json({ isValid: false });
});

export default r;
