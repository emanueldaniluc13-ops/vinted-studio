const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gemini({ apiKey, model, prompt, buf, mime }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: buf.toString('base64') } }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } },
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `Gemini respondió con el error ${res.status}`);
  const parts = j.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData || p.inline_data);
  if (!img) {
    const txt = parts.find((p) => p.text)?.text;
    throw new Error(txt ? `Gemini no devolvió imagen: ${txt.slice(0, 200)}` : 'Gemini no devolvió ninguna imagen (puede que un filtro de seguridad la bloqueara).');
  }
  const d = img.inlineData || img.inline_data;
  return { buf: Buffer.from(d.data, 'base64'), ext: (d.mimeType || d.mime_type || '').includes('jpeg') ? '.jpg' : '.png' };
}

async function openai({ apiKey, model, prompt, buf, mime }) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', '1024x1024');
  form.append('quality', 'medium');
  form.append('image', new Blob([buf], { type: mime }), `foto${mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg'}`);
  const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `OpenAI respondió con el error ${res.status}`);
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI no devolvió ninguna imagen.');
  return { buf: Buffer.from(b64, 'base64'), ext: '.png' };
}

async function flux({ apiKey, model, prompt, buf }) {
  const body = { prompt, input_image: buf.toString('base64'), output_format: 'png' };
  if (model.startsWith('flux-kontext')) body.aspect_ratio = '1:1';
  else { body.width = 1024; body.height = 1024; }
  const res = await fetch(`https://api.bfl.ai/v1/${encodeURIComponent(model)}`, {
    method: 'POST', headers: { 'x-key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const sub = await res.json().catch(() => ({}));
  if (res.status === 402) throw new Error('Flux: no te quedan créditos en tu cuenta de BFL.');
  if (!res.ok || !sub.polling_url) throw new Error(`Flux respondió con el error ${res.status}: ${JSON.stringify(sub.detail || sub).slice(0, 200)}`);
  for (let i = 0; i < 100; i++) {
    await sleep(1500);
    const s = await (await fetch(sub.polling_url, { headers: { 'x-key': apiKey } })).json().catch(() => ({}));
    if (s.status === 'Ready') {
      const img = await fetch(s.result.sample);
      return { buf: Buffer.from(await img.arrayBuffer()), ext: '.png' };
    }
    if (['Error', 'Failed', 'Request Moderated', 'Content Moderated'].includes(s.status)) throw new Error(`Flux: ${s.status}`);
  }
  throw new Error('Flux ha tardado demasiado.');
}

const PROVIDER_FN = { gemini, openai, flux };

export const mimeOf = (nameOrExt) => MIME[nameOrExt.slice(nameOrExt.lastIndexOf('.')).toLowerCase()] || 'image/jpeg';

export async function generateImage({ provider, apiKey, model, prompt, buf, mime }) {
  const fn = PROVIDER_FN[provider];
  if (!fn) throw new Error('Proveedor no soportado.');
  return fn({ apiKey, model, prompt, buf, mime });
}
