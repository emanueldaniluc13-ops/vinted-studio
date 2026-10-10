# Vinted Studio

Next.js (web, en Vercel) + API como **Edge Function de Supabase** (`supabase/functions/vinted-api`) + base de datos PostgreSQL y fotos en Supabase.
Sin servidores que mantener y sin tarjeta.

## Backend (Supabase) — ya desplegado
- Tablas `Settings`, `Product`, `Image`, `Generation` y bucket público `photos`.
- Función `vinted-api` (sin verificación JWT de Supabase: usa su propia sesión con `APP_PASSWORD`).
- **Secretos de la función** (Supabase > Edge Functions > Secrets):
  - `APP_PASSWORD` (opcional): contraseña para entrar. **Si no la pones, la app no pide contraseña** y cualquiera con la URL puede usarla (y gastar tu clave de IA).
  - `ENCRYPTION_SECRET` (obligatorio): texto largo y secreto (mínimo 16 caracteres). Cifra la clave de IA y firma las sesiones.
  - `WEB_ORIGIN` (opcional): URL de Vercel sin barra final; si la pones, solo esa web podrá llamar a la API.
- Comprobación: abre `https://owhnowwgygdvxdojnqph.supabase.co/functions/v1/vinted-api/health`; debe responder `{"ok":true,"configured":true}`.
- Redesplegar tras cambios: `supabase functions deploy vinted-api --no-verify-jwt` (la configuración está en `supabase/config.toml`).

## Frontend (Vercel)
1. Sube el proyecto a GitHub.
2. Vercel > Add New Project > el repo > **Root Directory: `apps/web`**.
3. Variable de entorno `NEXT_PUBLIC_API_URL` = `https://owhnowwgygdvxdojnqph.supabase.co/functions/v1/vinted-api`.
4. Entra en la URL de Vercel, escribe tu contraseña y valida tu clave de IA en Ajustes.

## En local
```
npm install
cd apps/web && copy .env.local.example .env.local   (o cp en Mac/Linux)
cd ../.. && npm run dev:web
```
Abre http://localhost:3000 (si usas `WEB_ORIGIN`, incluye también `http://localhost:3000`, separado por comas).
