import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

function key() {
  const s = process.env.ENCRYPTION_SECRET;
  if (!s || s.length < 16) throw new Error('Falta ENCRYPTION_SECRET (mínimo 16 caracteres) en apps/api/.env');
  return scryptSync(s, 'vinted-studio', 32);
}

export function encrypt(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
