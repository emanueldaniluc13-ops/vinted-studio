import { createClient } from '@supabase/supabase-js';

const BUCKET = process.env.SUPABASE_BUCKET || 'photos';
let sb;
function client() {
  if (!sb) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
      throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY en apps/api/.env');
    sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  }
  return sb;
}

export const nameOf = (url) => decodeURIComponent(new URL(url).pathname.split('/').pop());

export async function ensureBucket() {
  const { error } = await client().storage.createBucket(BUCKET, { public: true });
  if (error && !/already exists|duplicate/i.test(error.message)) console.warn('Aviso al crear el bucket:', error.message);
}

export async function putFile(name, buf, contentType) {
  const { error } = await client().storage.from(BUCKET).upload(name, buf, { contentType, upsert: true });
  if (error) throw new Error(`No se pudo guardar la imagen: ${error.message}`);
  return client().storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
}

export async function getFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo leer la imagen (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

export async function removeFiles(urls) {
  const names = urls.filter(Boolean).map(nameOf);
  if (names.length) await client().storage.from(BUCKET).remove(names);
}
