// deno-lint-ignore-file no-explicit-any
// API de Vinted Studio como Edge Function de Supabase (sustituye al servidor Express).
// Rutas idénticas a las de antes: /api/auth/login, /api/settings/*, /api/products/*
import { Hono } from 'npm:hono@4.6.14';
import { cors } from 'npm:hono@4.6.14/cors';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { zipSync } from 'npm:fflate@0.8.2';
import { decodeBase64, encodeBase64 } from 'jsr:@std/encoding@1/base64';
import { decodeBase64Url, encodeBase64Url } from 'jsr:@std/encoding@1/base64url';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// ───────────────────────── Configuración ─────────────────────────
const env = (k: string) => Deno.env.get(k) ?? '';
const SB_URL = env('SUPABASE_URL');
const sb = createClient(SB_URL, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const BUCKET = 'photos';
const FN = 'vinted-api';
const SELF = `${SB_URL}/functions/v1/${FN}`;
const te = new TextEncoder();
const rand = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const must = <T>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};

// ───────────────────────── Prompts (en inglés: los modelos de imagen obedecen mejor) ─────────────────────────
const COMMON =
  'Edit the provided photo of a clothing item. Keep the garment EXACTLY as it is: same color, fabric texture, shape, proportions, logos, prints, text, labels, stitching, buttons, zippers and any real wear or flaws. Do not redraw, restyle, add, remove, translate or distort any text or logo. Keep the same side of the garment shown in the original photo. Show only this garment: no people, mannequins or other objects. Photorealistic, soft even studio lighting, sharp focus, natural realistic shadows. Square 1:1 composition, garment centered and fully visible with some margin. If the photo is a close-up of a detail (label, logo, fabric), keep that close framing and only replace the background.';
const STYLES: Record<string, string> = {
  HANGER:
    'Show the garment hanging from a simple neutral hanger, hooked to a wall-mounted hook, against a plain professional light-to-medium gray wall. The garment hangs naturally and neatly, with its shape held by the hanger and no distracting wrinkles. Soft shadow cast on the wall behind it.',
  SURFACE:
    'Show the garment lying flat, neatly arranged and smoothed, on a plain professional light-to-medium gray surface, photographed from directly above. Edges and sleeves tidy and symmetrical, with a subtle natural shadow underneath.',
};
const isStyle = (s: any) => typeof s === 'string' && s in STYLES;
function buildPrompt(style: string, refinement?: string | null) {
  let p = `${COMMON} ${STYLES[style]}`;
  if (refinement?.trim()) p += ` Additional adjustment requested by the user: ${refinement.trim()}`;
  return p;
}

// Plantilla fija para copiar y rellenar a mano. NO la genera ninguna IA.
const DESCRIPTION_TEMPLATE = [
  '___ (prenda) color ___.',
  'Detalles: ___.',
  'Muy buen estado.',
  'Talla: ___',
  '',
  'Envío rápido y seguro.',
  'Cualquier pregunta u oferta, escríbeme.',
].join('\n');

// ───────────────────────── Auth (sesión firmada con HMAC) ─────────────────────────
const secret = () => env('ENCRYPTION_SECRET');
const configured = () => secret().length >= 16;
// Sin APP_PASSWORD la app queda abierta: cualquiera con la URL puede usarla.
const authOn = () => !!env('APP_PASSWORD');

async function mac(data: string) {
  const key = await crypto.subtle.importKey('raw', te.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return encodeBase64Url(await crypto.subtle.sign('HMAC', key, te.encode(data)));
}
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const sha = async (s: unknown) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(String(s ?? '')))))
    .map((x) => x.toString(16).padStart(2, '0')).join('');
async function sign() {
  const b = encodeBase64Url(te.encode(JSON.stringify({ exp: Date.now() + 30 * 864e5 })));
  return `${b}.${await mac(b)}`;
}
async function verify(token: string) {
  const [b, sig] = String(token || '').split('.');
  if (!b || !sig || !safeEq(sig, await mac(b))) return false;
  try { return JSON.parse(new TextDecoder().decode(decodeBase64Url(b))).exp > Date.now(); } catch { return false; }
}

// Cifrado de la clave de IA guardada (AES-256-GCM)
let aesKey: CryptoKey | undefined;
async function aes() {
  if (!aesKey) {
    const base = await crypto.subtle.importKey('raw', te.encode(secret()), 'PBKDF2', false, ['deriveKey']);
    aesKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: te.encode('vinted-studio'), iterations: 100000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  }
  return aesKey;
}
async function encrypt(text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(), te.encode(text)));
  return `${encodeBase64(iv)}.${encodeBase64(ct)}`;
}
async function decrypt(payload: string) {
  const [iv, ct] = payload.split('.').map((p) => decodeBase64(p));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aes(), ct));
}

// ───────────────────────── Proveedores de IA ─────────────────────────
async function ping(url: string, headers: Record<string, string>) {
  try { return await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); } catch { return null; }
}
const NET = { ok: false, message: 'No se pudo conectar con el proveedor. Revisa tu conexión a internet.' };
const OTHER = (s: number) => ({ ok: false, message: `El proveedor respondió con el error ${s}.` });
const BAD_KEY = (where: string) => ({ ok: false, message: `Clave no válida. Cópiala de nuevo desde ${where}.` });

const PROVIDERS: Record<string, any> = {
  gemini: {
    label: 'Gemini (Google)', defaultModel: 'gemini-3.1-flash-image-preview', keyHint: 'AIza...', keyUrl: 'Google AI Studio',
    async listModels(key: string) {
      const res = await ping('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': key });
      if (!res) return NET;
      if ([400, 401, 403].includes(res.status)) return BAD_KEY('Google AI Studio');
      if (!res.ok) return OTHER(res.status);
      const j = await res.json();
      const models = (j.models || []).map((m: any) => String(m.name).replace(/^models\//, ''))
        .filter((n: string) => /image/i.test(n) && !/imagen/i.test(n)).sort();
      return { ok: true, models };
    },
    async validate(key: string, model: string) {
      const res = await ping(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, { 'x-goog-api-key': key });
      if (!res) return NET;
      if (res.ok) return { ok: true };
      if (res.status === 404) return { ok: false, message: `El modelo «${model}» no existe o no está disponible para tu clave. Elige otro.` };
      if ([400, 401, 403].includes(res.status)) return BAD_KEY('Google AI Studio');
      if (res.status === 429) return { ok: false, message: 'Google ha limitado las peticiones. Espera un minuto y reintenta.' };
      return OTHER(res.status);
    },
  },
  openai: {
    label: 'OpenAI', defaultModel: 'gpt-image-1-mini', keyHint: 'sk-...', keyUrl: 'platform.openai.com',
    async listModels(key: string) {
      const res = await ping('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` });
      if (!res) return NET;
      if (res.status === 401) return BAD_KEY('platform.openai.com');
      if (!res.ok) return OTHER(res.status);
      const j = await res.json();
      const models = (j.data || []).map((m: any) => m.id).filter((id: string) => id.startsWith('gpt-image')).sort();
      return { ok: true, models };
    },
    async validate(key: string, model: string) {
      const res = await ping(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { Authorization: `Bearer ${key}` });
      if (!res) return NET;
      if (res.ok) return { ok: true };
      if (res.status === 401) return BAD_KEY('platform.openai.com');
      if (res.status === 404 || res.status === 403) return { ok: false, message: `El modelo «${model}» no está disponible para tu cuenta (algunos exigen verificar la organización). Elige otro.` };
      if (res.status === 429) return { ok: false, message: 'OpenAI ha limitado las peticiones o no tienes saldo. Revisa tu cuenta.' };
      return OTHER(res.status);
    },
  },
  flux: {
    label: 'Flux.1 (Black Forest Labs)', defaultModel: 'flux-kontext-pro', keyHint: 'Clave de BFL', keyUrl: 'dashboard.bfl.ai',
    // BFL no tiene endpoint de «comprobar clave»: se consulta una tarea inexistente (clave inválida -> 401/403).
    async validate(key: string) {
      const res = await ping('https://api.bfl.ai/v1/get_result?id=comprobacion-de-clave', { 'x-key': key });
      if (!res) return NET;
      if ([401, 403].includes(res.status)) return BAD_KEY('dashboard.bfl.ai');
      if (res.status >= 500) return OTHER(res.status);
      return { ok: true };
    },
    async listModels(key: string) {
      const v: any = await (this as any).validate(key);
      if (!v.ok) return v;
      return { ok: true, models: ['flux-kontext-pro', 'flux-kontext-max', 'flux-2-pro', 'flux-2-flex', 'flux-2-max', 'flux-2-klein-9b', 'flux-2-klein-4b'] };
    },
  },
};
const publicProviders = () =>
  Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, defaultModel: p.defaultModel, keyHint: p.keyHint, keyUrl: p.keyUrl }));

// ───────────────────────── Generación de imágenes ─────────────────────────
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const extOf = (url: string) => /\.[a-z0-9]+$/i.exec(new URL(url).pathname)?.[0].toLowerCase() ?? '';
const mimeOf = (nameOrExt: string) => MIME[nameOrExt.slice(nameOrExt.lastIndexOf('.')).toLowerCase()] || 'image/jpeg';
type Gen = { apiKey: string; model: string; prompt: string; buf: Uint8Array; mime: string };

async function gemini({ apiKey, model, prompt, buf, mime }: Gen) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    signal: AbortSignal.timeout(100000),
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: encodeBase64(buf) } }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } },
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `Gemini respondió con el error ${res.status}`);
  const parts = j.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p: any) => p.inlineData || p.inline_data);
  if (!img) {
    const txt = parts.find((p: any) => p.text)?.text;
    throw new Error(txt ? `Gemini no devolvió imagen: ${txt.slice(0, 200)}` : 'Gemini no devolvió ninguna imagen (puede que un filtro de seguridad la bloqueara).');
  }
  const d = img.inlineData || img.inline_data;
  return { buf: decodeBase64(d.data), ext: (d.mimeType || d.mime_type || '').includes('jpeg') ? '.jpg' : '.png' };
}

async function openai({ apiKey, model, prompt, buf, mime }: Gen) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', '1024x1024');
  form.append('quality', 'medium');
  form.append('image', new Blob([buf], { type: mime }), `foto${mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg'}`);
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST', signal: AbortSignal.timeout(100000), headers: { Authorization: `Bearer ${apiKey}` }, body: form,
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `OpenAI respondió con el error ${res.status}`);
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI no devolvió ninguna imagen.');
  return { buf: decodeBase64(b64), ext: '.png' };
}

async function flux({ apiKey, model, prompt, buf }: Gen) {
  const body: any = { prompt, input_image: encodeBase64(buf), output_format: 'png' };
  if (model.startsWith('flux-kontext')) body.aspect_ratio = '1:1';
  else { body.width = 1024; body.height = 1024; }
  const res = await fetch(`https://api.bfl.ai/v1/${encodeURIComponent(model)}`, {
    method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'x-key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const sub: any = await res.json().catch(() => ({}));
  if (res.status === 402) throw new Error('Flux: no te quedan créditos en tu cuenta de BFL.');
  if (!res.ok || !sub.polling_url) throw new Error(`Flux respondió con el error ${res.status}: ${JSON.stringify(sub.detail || sub).slice(0, 200)}`);
  for (let i = 0; i < 55; i++) { // máx. ~80 s: cada invocación de la función tiene un límite de tiempo
    await sleep(1500);
    const s: any = await (await fetch(sub.polling_url, { headers: { 'x-key': apiKey }, signal: AbortSignal.timeout(15000) })).json().catch(() => ({}));
    if (s.status === 'Ready') {
      const img = await fetch(s.result.sample, { signal: AbortSignal.timeout(30000) });
      return { buf: new Uint8Array(await img.arrayBuffer()), ext: '.png' };
    }
    if (['Error', 'Failed', 'Request Moderated', 'Content Moderated'].includes(s.status)) throw new Error(`Flux: ${s.status}`);
  }
  throw new Error('Flux ha tardado demasiado.');
}

const PROVIDER_FN: Record<string, (g: Gen) => Promise<{ buf: Uint8Array; ext: string }>> = { gemini, openai, flux };

// ───────────────────────── Almacenamiento (Supabase Storage) ─────────────────────────
const nameOf = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop()!);
async function putFile(name: string, buf: Uint8Array, contentType: string) {
  const { error } = await sb.storage.from(BUCKET).upload(name, buf, { contentType, upsert: true });
  if (error) throw new Error(`No se pudo guardar la imagen: ${error.message}`);
  return sb.storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
}
async function getFile(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`No se pudo leer la imagen (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}
async function removeFiles(urls: (string | null)[]) {
  const names = urls.filter(Boolean).map((u) => nameOf(u as string));
  if (names.length) await sb.storage.from(BUCKET).remove(names);
}

// ───────────────────────── Datos ─────────────────────────
const getSettings = async () => must(await sb.from('Settings').select('*').eq('id', 1).maybeSingle()) as any;
const SELECT = '*, images:Image(*, generations:Generation(*))';
const STALE_MS = 8 * 60e3;

// Devuelve el producto con la misma forma que antes: imágenes ordenadas y solo la generación vigente de cada una.
function shape(p: any) {
  p.images = (p.images ?? []).sort((a: any, b: any) => a.position - b.position).map((i: any) => {
    const generations = (i.generations ?? [])
      .filter((g: any) => g.isCurrent)
      .sort((a: any, b: any) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, 1)
      .map((g: any) => g.status === 'PENDING' && Date.now() - +new Date(g.createdAt) > STALE_MS
        ? { ...g, status: 'FAILED', error: 'La generación se interrumpió. Vuelve a generarla.' } : g);
    return { ...i, generations };
  });
  return p;
}
async function getProduct(id: string) {
  const p = must(await sb.from('Product').select(SELECT).eq('id', id).maybeSingle()) as any;
  return p ? shape(p) : null;
}

async function queue(images: any[], style: string, refinement: string | null) {
  const ids: string[] = [];
  for (const img of images) {
    must(await sb.from('Generation').update({ isCurrent: false }).eq('imageId', img.id));
    const row = must(await sb.from('Generation').insert({
      imageId: img.id, prompt: buildPrompt(style, refinement), refinement: refinement || null, status: 'PENDING',
    }).select('id').single()) as any;
    ids.push(row.id);
  }
  return ids;
}

async function runOne(id: string) {
  try {
    const g = must(await sb.from('Generation').select('*, image:Image(originalUrl)').eq('id', id).single()) as any;
    const s = await getSettings();
    if (!s?.apiKeyEnc) throw new Error('No hay clave de API configurada.');
    const fn = PROVIDER_FN[s.provider];
    if (!fn) throw new Error('Proveedor no soportado.');
    const original = await getFile(g.image.originalUrl);
    const { buf, ext } = await fn({ apiKey: await decrypt(s.apiKeyEnc), model: s.model, prompt: g.prompt, buf: original, mime: mimeOf(g.image.originalUrl) });
    const resultUrl = await putFile(`gen-${id}${ext}`, buf, mimeOf(ext));
    must(await sb.from('Generation').update({ status: 'DONE', resultUrl, error: null }).eq('id', id));
  } catch (e) {
    await sb.from('Generation').update({ status: 'FAILED', error: String((e as Error).message || e).slice(0, 500) }).eq('id', id);
  }
}

// De 2 en 2 (límites de velocidad de los proveedores). Cada invocación procesa 2 y lanza otra con el resto,
// así ninguna supera el tiempo máximo de la función aunque haya muchas fotos.
async function runChain(ids: string[]) {
  await Promise.all(ids.slice(0, 2).map(runOne));
  const rest = ids.slice(2);
  if (!rest.length) return;
  try {
    await fetch(`${SELF}/internal/run`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', 'x-internal': await mac('run') },
      body: JSON.stringify({ ids: rest }),
    });
  } catch { /* si falla, las pendientes se marcan como interrumpidas al consultarlas */ }
}
const dispatch = (ids: string[]) => EdgeRuntime.waitUntil(runChain(ids));

// ───────────────────────── App ─────────────────────────
const app = new Hono().basePath(`/${FN}`);

app.use('*', cors({
  origin: (origin) => {
    const allowed = env('WEB_ORIGIN').split(',').map((s) => s.trim()).filter(Boolean);
    return allowed.length ? (allowed.includes(origin) ? origin : null) : '*';
  },
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Disposition'],
}));

app.get('/health', (c) => c.json({ ok: true, configured: configured(), passwordRequired: authOn() }));

// Sin ENCRYPTION_SECRET la API se niega a funcionar
app.use('*', async (_c, next) => {
  if (!configured()) throw new HttpError(500, 'NOT_CONFIGURED', 'Falta el secreto ENCRYPTION_SECRET (mínimo 16 caracteres) en la función.');
  await next();
});

const attempts = new Map<string, number[]>();
app.post('/api/auth/login', async (c) => {
  const ip = (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  if (recent.length >= 10) throw new HttpError(429, 'TOO_MANY', 'Demasiados intentos. Espera unos minutos.');
  attempts.set(ip, [...recent, now]);
  if (!authOn()) return c.json({ token: '' });
  const body: any = await c.req.json().catch(() => ({}));
  if (!safeEq(await sha(body?.password), await sha(env('APP_PASSWORD'))))
    throw new HttpError(401, 'BAD_PASSWORD', 'Contraseña incorrecta.');
  return c.json({ token: await sign() });
});

// Reanudación interna de la cola de generación (solo la propia función puede llamarla)
app.post('/internal/run', async (c) => {
  if (!safeEq(c.req.header('x-internal') || '', await mac('run'))) throw new HttpError(401, 'AUTH_REQUIRED', 'No autorizado.');
  const body: any = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'string') : [];
  if (ids.length) dispatch(ids);
  return c.json({ queued: ids.length }, 202);
});

// Todo lo demás exige sesión
app.use('/api/*', async (c, next) => {
  const token = (c.req.header('authorization') || '').replace(/^Bearer /, '');
  if (authOn() && !(await verify(token))) throw new HttpError(401, 'AUTH_REQUIRED', 'Inicia sesión para continuar.');
  await next();
});

// ── Ajustes ──
app.get('/api/settings/status', async (c) => {
  const s = await getSettings();
  const provider = PROVIDERS[s?.provider] ? s.provider : 'gemini';
  return c.json({
    configured: !!s?.apiKeyEnc,
    isValid: !!s?.isValid,
    provider,
    model: s?.model || PROVIDERS[provider].defaultModel,
    validatedAt: s?.validatedAt || null,
    providers: publicProviders(),
  });
});

app.post('/api/settings/models', async (c) => {
  const body: any = await c.req.json().catch(() => ({}));
  const P = PROVIDERS[String(body?.provider || '')];
  if (!P) throw new HttpError(400, 'INVALID_PROVIDER', 'Proveedor no soportado.');
  const apiKey = String(body?.apiKey || '').trim();
  if (apiKey.length < 20) throw new HttpError(400, 'INVALID_KEY', 'Introduce primero la clave de API completa.');
  const out = await P.listModels(apiKey);
  if (!out.ok) throw new HttpError(400, 'INVALID_KEY', out.message);
  return c.json({ models: out.models });
});

app.post('/api/settings/api-key', async (c) => {
  const body: any = await c.req.json().catch(() => ({}));
  const provider = String(body?.provider || 'gemini');
  const P = PROVIDERS[provider];
  if (!P) throw new HttpError(400, 'INVALID_PROVIDER', 'Proveedor no soportado.');
  const apiKey = String(body?.apiKey || '').trim();
  const model = String(body?.model || '').trim() || P.defaultModel;
  if (apiKey.length < 20) throw new HttpError(400, 'INVALID_KEY', 'Introduce la clave de API completa.');
  const check = await P.validate(apiKey, model);
  if (!check.ok) {
    must(await sb.from('Settings').upsert({ id: 1, provider, model, isValid: false }, { onConflict: 'id' }));
    throw new HttpError(400, 'INVALID_KEY', check.message);
  }
  must(await sb.from('Settings').upsert({
    id: 1, provider, model, apiKeyEnc: await encrypt(apiKey), isValid: true, validatedAt: new Date().toISOString(),
  }, { onConflict: 'id' }));
  return c.json({ isValid: true, provider, model });
});

app.delete('/api/settings/api-key', async (c) => {
  must(await sb.from('Settings').upsert({ id: 1, apiKeyEnc: null, isValid: false, validatedAt: null }, { onConflict: 'id' }));
  return c.json({ isValid: false });
});

// ── Productos (bloqueados sin una clave de API válida) ──
const requireApiKey = async (_c: any, next: () => Promise<void>) => {
  const s = await getSettings();
  if (!s || !s.isValid || !s.apiKeyEnc)
    throw new HttpError(403, 'API_KEY_REQUIRED', 'Configura una clave de API válida en Ajustes para usar la aplicación.');
  await next();
};
app.use('/api/products', requireApiKey);
app.use('/api/products/*', requireApiKey);

app.get('/api/products', async (c) => {
  const rows = must(await sb.from('Product').select(SELECT).order('createdAt', { ascending: false })) as any[];
  return c.json(rows.map(shape));
});

app.post('/api/products', async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new HttpError(400, 'UPLOAD', 'No se pudieron leer las fotos.');
  const style = String(form.get('style') || '');
  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (!files.length) throw new HttpError(400, 'NO_FILES', 'Añade al menos una foto.');
  if (files.length > 12) throw new HttpError(400, 'UPLOAD', 'Máximo 12 fotos por producto.');
  for (const f of files) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) throw new HttpError(400, 'UPLOAD', 'Usa fotos en formato JPG, PNG o WebP.');
    if (f.size > 10 * 1024 * 1024) throw new HttpError(400, 'UPLOAD', 'Cada foto puede pesar como máximo 10 MB.');
  }
  if (!isStyle(style)) throw new HttpError(400, 'NO_STYLE', 'Elige «Con percha» o «En superficie».');
  const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  const urls: string[] = [];
  for (const f of files) urls.push(await putFile(`orig-${rand()}${EXT[f.type]}`, new Uint8Array(await f.arrayBuffer()), f.type));
  const product = must(await sb.from('Product').insert({ style, description: DESCRIPTION_TEMPLATE }).select('id').single()) as any;
  must(await sb.from('Image').insert(urls.map((u, i) => ({ productId: product.id, originalUrl: u, position: i }))));
  return c.json(await getProduct(product.id), 201);
});

app.get('/api/products/generations/:id/download', async (c) => {
  const g = must(await sb.from('Generation').select('resultUrl').eq('id', c.req.param('id')).maybeSingle()) as any;
  if (!g?.resultUrl) return c.json({ message: 'Imagen no encontrada.' }, 404);
  const ext = extOf(g.resultUrl) || '.png';
  return c.body(await getFile(g.resultUrl), 200, {
    'Content-Type': mimeOf(ext),
    'Content-Disposition': `attachment; filename="imagen${ext}"`,
  });
});

app.post('/api/products/images/:imageId/refine', async (c) => {
  const img = must(await sb.from('Image').select('*, product:Product(style)').eq('id', c.req.param('imageId')).maybeSingle()) as any;
  if (!img) return c.json({ message: 'Imagen no encontrada.' }, 404);
  const body: any = await c.req.json().catch(() => ({}));
  const text = String(body?.text || '').trim();
  if (!text) throw new HttpError(400, 'NO_TEXT', 'Escribe qué quieres cambiar.');
  const ids = await queue([img], img.product.style, text);
  dispatch(ids);
  return c.json({ queued: ids.length }, 202);
});

app.get('/api/products/:id', async (c) => {
  const p = await getProduct(c.req.param('id'));
  return p ? c.json(p) : c.json({ message: 'Producto no encontrado.' }, 404);
});

app.patch('/api/products/:id', async (c) => {
  const id = c.req.param('id');
  const body: any = await c.req.json().catch(() => ({}));
  const upd: Record<string, unknown> = {};
  if (body.title !== undefined) upd.title = body.title;
  if (body.description !== undefined) upd.description = body.description;
  if (Object.keys(upd).length) must(await sb.from('Product').update(upd).eq('id', id));
  const p = await getProduct(id);
  return p ? c.json(p) : c.json({ message: 'Producto no encontrado.' }, 404);
});

app.post('/api/products/:id/generate', async (c) => {
  const p = await getProduct(c.req.param('id'));
  if (!p) return c.json({ message: 'Producto no encontrado.' }, 404);
  const body: any = await c.req.json().catch(() => ({}));
  const style = isStyle(body?.style) ? body.style : p.style;
  if (style !== p.style) must(await sb.from('Product').update({ style }).eq('id', p.id));
  const ids = await queue(p.images, style, null);
  dispatch(ids);
  return c.json({ queued: ids.length }, 202);
});

app.get('/api/products/:id/export', async (c) => {
  const p = await getProduct(c.req.param('id'));
  if (!p) return c.json({ message: 'Producto no encontrado.' }, 404);
  const done = p.images.map((i: any) => i.generations[0]).filter((g: any) => g?.status === 'DONE');
  if (!done.length) throw new HttpError(400, 'NOTHING', 'Aún no hay imágenes generadas.');
  const entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < done.length; i++) {
    entries[`${String(i + 1).padStart(2, '0')}${extOf(done[i].resultUrl) || '.png'}`] = await getFile(done[i].resultUrl);
  }
  if (p.title || p.description) entries['descripcion.txt'] = te.encode(`${p.title || ''}\n\n${p.description || ''}`);
  const slug = (p.title || 'producto').replace(/[^\w-]+/g, '-');
  return c.body(zipSync(entries, { level: 0 }), 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${slug}.zip"`,
  });
});

app.delete('/api/products/:id', async (c) => {
  const id = c.req.param('id');
  const p = must(await sb.from('Product').select('*, images:Image(originalUrl, generations:Generation(resultUrl))').eq('id', id).maybeSingle()) as any;
  if (!p) return c.json({ message: 'Producto no encontrado.' }, 404);
  const urls = p.images.flatMap((i: any) => [i.originalUrl, ...i.generations.map((g: any) => g.resultUrl)]);
  must(await sb.from('Product').delete().eq('id', id));
  await removeFiles(urls).catch(() => {});
  return c.json({ deleted: true });
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ code: err.code, message: err.message }, err.status as any);
  console.error(err);
  return c.json({ code: 'SERVER_ERROR', message: err.message }, 500);
});

Deno.serve(app.fetch);
