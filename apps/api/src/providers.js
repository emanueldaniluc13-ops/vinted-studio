// Proveedores de IA para las imágenes. Cada uno sabe validar la clave y listar los modelos de imagen
// disponibles para ESA clave, sin consumir cuota de generación.
async function ping(url, headers) {
  try { return await fetch(url, { headers }); } catch { return null; }
}
const NET = { ok: false, message: 'No se pudo conectar con el proveedor. Revisa tu conexión a internet.' };
const OTHER = (s) => ({ ok: false, message: `El proveedor respondió con el error ${s}.` });
const BAD_KEY = (where) => ({ ok: false, message: `Clave no válida. Cópiala de nuevo desde ${where}.` });

export const PROVIDERS = {
  gemini: {
    label: 'Gemini (Google)',
    defaultModel: 'gemini-3.1-flash-image-preview',
    keyHint: 'AIza...',
    keyUrl: 'Google AI Studio',
    async listModels(key) {
      const res = await ping('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': key });
      if (!res) return NET;
      if ([400, 401, 403].includes(res.status)) return BAD_KEY('Google AI Studio');
      if (!res.ok) return OTHER(res.status);
      const j = await res.json();
      const models = (j.models || [])
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((n) => /image/i.test(n) && !/imagen/i.test(n)) // modelos que editan imágenes (no Imagen, que solo crea)
        .sort();
      return { ok: true, models };
    },
    async validate(key, model) {
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
    label: 'OpenAI',
    defaultModel: 'gpt-image-1-mini',
    keyHint: 'sk-...',
    keyUrl: 'platform.openai.com',
    async listModels(key) {
      const res = await ping('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` });
      if (!res) return NET;
      if (res.status === 401) return BAD_KEY('platform.openai.com');
      if (!res.ok) return OTHER(res.status);
      const j = await res.json();
      const models = (j.data || []).map((m) => m.id).filter((id) => id.startsWith('gpt-image')).sort();
      return { ok: true, models };
    },
    async validate(key, model) {
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
    label: 'Flux.1 (Black Forest Labs)',
    defaultModel: 'flux-kontext-pro',
    keyHint: 'Clave de BFL',
    keyUrl: 'dashboard.bfl.ai',
    // BFL no tiene endpoint de «comprobar clave» ni de listar modelos.
    // Clave: se consulta una tarea inexistente (inválida -> 401/403; válida -> cualquier otra respuesta).
    async validate(key) {
      const res = await ping('https://api.bfl.ai/v1/get_result?id=comprobacion-de-clave', { 'x-key': key });
      if (!res) return NET;
      if ([401, 403].includes(res.status)) return BAD_KEY('dashboard.bfl.ai');
      if (res.status >= 500) return OTHER(res.status);
      return { ok: true };
    },
    // Lista fija (BFL no publica un endpoint de modelos).
    async listModels(key) {
      const v = await this.validate(key);
      if (!v.ok) return v;
      return { ok: true, models: ['flux-kontext-pro', 'flux-kontext-max', 'flux-2-pro', 'flux-2-flex', 'flux-2-max', 'flux-2-klein-9b', 'flux-2-klein-4b'] };
    },
  },
};

export const publicProviders = () =>
  Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, defaultModel: p.defaultModel, keyHint: p.keyHint, keyUrl: p.keyUrl }));
