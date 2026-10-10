import crypto from 'node:crypto';

const DAYS = 30;
const secret = () => process.env.ENCRYPTION_SECRET;
export const authEnabled = () => !!process.env.APP_PASSWORD;
const mac = (b) => crypto.createHmac('sha256', secret()).update(b).digest('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function sign() {
  const b = Buffer.from(JSON.stringify({ exp: Date.now() + DAYS * 864e5 })).toString('base64url');
  return `${b}.${mac(b)}`;
}
function verify(token) {
  const [b, sig] = String(token || '').split('.');
  if (!b || !sig) return false;
  const exp = mac(b);
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return false;
  try { return JSON.parse(Buffer.from(b, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}

export function requireAuth(req, res, next) {
  if (!authEnabled()) return next();
  if (verify((req.headers.authorization || '').replace(/^Bearer /, ''))) return next();
  res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Inicia sesión para continuar.' });
}

const attempts = new Map(); // ip -> [timestamps]
export function login(req, res) {
  const now = Date.now();
  const recent = (attempts.get(req.ip) || []).filter((t) => now - t < 15 * 60e3);
  if (recent.length >= 10) return res.status(429).json({ code: 'TOO_MANY', message: 'Demasiados intentos. Espera unos minutos.' });
  attempts.set(req.ip, [...recent, now]);
  if (!authEnabled()) return res.json({ token: '' });
  if (!crypto.timingSafeEqual(sha(req.body?.password), sha(process.env.APP_PASSWORD)))
    return res.status(401).json({ code: 'BAD_PASSWORD', message: 'Contraseña incorrecta.' });
  res.json({ token: sign() });
}
