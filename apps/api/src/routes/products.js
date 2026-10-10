import { Router } from 'express';
import multer from 'multer';
import archiver from 'archiver';
import path from 'node:path';
import { prisma } from '../db.js';
import { decrypt } from '../crypto.js';
import { buildPrompt, isStyle } from '../prompts.js';
import { generateImage, mimeOf } from '../generate.js';
import { putFile, getFile, removeFiles } from '../storage.js';
import { DESCRIPTION_TEMPLATE } from '../template.js';

const r = Router();
const include = {
  images: { orderBy: { position: 'asc' }, include: { generations: { where: { isCurrent: true }, orderBy: { createdAt: 'desc' }, take: 1 } } },
};
const rand = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 },
  fileFilter: (_q, f, cb) =>
    ['image/jpeg', 'image/png', 'image/webp'].includes(f.mimetype) ? cb(null, true) : cb(new Error('Usa fotos en formato JPG, PNG o WebP.')),
});

async function queue(images, style, refinement) {
  const jobs = [];
  for (const img of images) {
    await prisma.generation.updateMany({ where: { imageId: img.id }, data: { isCurrent: false } });
    const gen = await prisma.generation.create({
      data: { imageId: img.id, prompt: buildPrompt(style, refinement), refinement: refinement || null, status: 'PENDING' },
    });
    jobs.push({ gen, url: img.originalUrl });
  }
  return jobs;
}

// De 2 en 2 para no chocar con los límites de velocidad de los proveedores.
async function runJobs(jobs, s) {
  const apiKey = decrypt(s.apiKeyEnc);
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const { gen, url } = jobs[i++];
      try {
        const original = await getFile(url);
        const { buf, ext } = await generateImage({ provider: s.provider, apiKey, model: s.model, prompt: gen.prompt, buf: original, mime: mimeOf(url) });
        const resultUrl = await putFile(`gen-${gen.id}${ext}`, buf, mimeOf(ext));
        await prisma.generation.update({ where: { id: gen.id }, data: { status: 'DONE', resultUrl, error: null } });
      } catch (e) {
        await prisma.generation
          .update({ where: { id: gen.id }, data: { status: 'FAILED', error: String(e.message || e).slice(0, 500) } })
          .catch(() => {});
      }
    }
  };
  await Promise.all([worker(), worker()]);
}

r.get('/', async (_req, res) => {
  res.json(await prisma.product.findMany({ orderBy: { createdAt: 'desc' }, include }));
});

r.post('/', (req, res) => {
  upload.array('files', 12)(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ code: 'UPLOAD', message: err.message });
      const style = String(req.body?.style || '');
      if (!req.files?.length) return res.status(400).json({ code: 'NO_FILES', message: 'Añade al menos una foto.' });
      if (!isStyle(style)) return res.status(400).json({ code: 'NO_STYLE', message: 'Elige «Con percha» o «En superficie».' });
      const urls = [];
      for (const f of req.files) urls.push(await putFile(`orig-${rand()}${path.extname(f.originalname).toLowerCase()}`, f.buffer, f.mimetype));
      const product = await prisma.product.create({
        data: { style, description: DESCRIPTION_TEMPLATE, images: { create: urls.map((u, i) => ({ originalUrl: u, position: i })) } },
        include,
      });
      res.status(201).json(product);
    } catch (e) { res.status(500).json({ code: 'SERVER_ERROR', message: e.message }); }
  });
});

r.get('/generations/:id/download', async (req, res) => {
  const g = await prisma.generation.findUnique({ where: { id: req.params.id } });
  if (!g?.resultUrl) return res.status(404).json({ message: 'Imagen no encontrada.' });
  const ext = path.extname(g.resultUrl) || '.png';
  res.setHeader('Content-Type', mimeOf(ext));
  res.setHeader('Content-Disposition', `attachment; filename="imagen${ext}"`);
  res.send(await getFile(g.resultUrl));
});

r.post('/images/:imageId/refine', async (req, res) => {
  const img = await prisma.image.findUnique({ where: { id: req.params.imageId }, include: { product: true } });
  if (!img) return res.status(404).json({ message: 'Imagen no encontrada.' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ code: 'NO_TEXT', message: 'Escribe qué quieres cambiar.' });
  const jobs = await queue([img], img.product.style, text);
  res.status(202).json({ queued: jobs.length });
  runJobs(jobs, req.settings);
});

r.get('/:id', async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: req.params.id }, include });
  if (!p) return res.status(404).json({ message: 'Producto no encontrado.' });
  res.json(p);
});

r.patch('/:id', async (req, res) => {
  const { title, description } = req.body || {};
  res.json(await prisma.product.update({ where: { id: req.params.id }, data: { title, description }, include }));
});

r.post('/:id/generate', async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: req.params.id }, include });
  if (!p) return res.status(404).json({ message: 'Producto no encontrado.' });
  const style = isStyle(req.body?.style) ? req.body.style : p.style;
  if (style !== p.style) await prisma.product.update({ where: { id: p.id }, data: { style } });
  const jobs = await queue(p.images, style, null);
  res.status(202).json({ queued: jobs.length });
  runJobs(jobs, req.settings);
});

r.get('/:id/export', async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: req.params.id }, include });
  if (!p) return res.status(404).json({ message: 'Producto no encontrado.' });
  const done = p.images.map((i) => i.generations[0]).filter((g) => g?.status === 'DONE');
  if (!done.length) return res.status(400).json({ code: 'NOTHING', message: 'Aún no hay imágenes generadas.' });
  const files = [];
  for (const g of done) files.push(await getFile(g.resultUrl));
  const slug = (p.title || 'producto').replace(/[^\w-]+/g, '-');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}.zip"`);
  const z = archiver('zip');
  z.pipe(res);
  files.forEach((buf, i) => z.append(buf, { name: `${String(i + 1).padStart(2, '0')}${path.extname(done[i].resultUrl)}` }));
  if (p.title || p.description) z.append(`${p.title || ''}\n\n${p.description || ''}`, { name: 'descripcion.txt' });
  await z.finalize();
});

r.delete('/:id', async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: req.params.id }, include: { images: { include: { generations: true } } } });
  if (!p) return res.status(404).json({ message: 'Producto no encontrado.' });
  const urls = p.images.flatMap((i) => [i.originalUrl, ...i.generations.map((g) => g.resultUrl)]);
  await prisma.product.delete({ where: { id: p.id } });
  await removeFiles(urls).catch(() => {});
  res.json({ deleted: true });
});

export default r;
