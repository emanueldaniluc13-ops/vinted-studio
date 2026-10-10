# Vinted Studio

Next.js (web) + Express (API) + Supabase (base de datos PostgreSQL y fotos). Requisitos: Node.js 20 o superior.

## 1. Supabase (gratis)
1. Crea un proyecto en supabase.com. Apunta la contraseña de la base de datos.
2. Botón **Connect**: copia la cadena «Transaction pooler» (puerto 6543) y la «Session pooler» (puerto 5432).
3. **Project Settings > API**: copia la URL del proyecto y la clave secreta (service_role).
4. No hace falta crear el bucket de fotos: la API crea uno público llamado `photos` al arrancar.

## 2. En tu PC (D:\vinted-studio)
```
npm install
cd apps\api
copy .env.example .env      (rellena los valores; APP_PASSWORD puede quedar vacío en local)
npx prisma db push
cd ..\web
copy .env.local.example .env.local
cd ..\..
npm run dev:api
npm run dev:web             (en otra terminal)
```
Abre http://localhost:3000, ve a Ajustes y valida tu clave de IA.

## 3. Subirla a internet (todo gratis)
1. Sube el proyecto a un repositorio de GitHub (el `.gitignore` ya excluye `.env`).
2. **Render** > New > Blueprint > elige el repo (usa `render.yaml`). Rellena las variables: las de Supabase, `ENCRYPTION_SECRET`, `APP_PASSWORD` (tu contraseña de acceso) y `WEB_ORIGIN` (la URL de Vercel del paso siguiente; puedes ponerla después).
3. **Vercel** > Add New Project > el mismo repo > **Root Directory: `apps/web`** > variable `NEXT_PUBLIC_API_URL` con la URL de Render.
4. Vuelve a Render y pon `WEB_ORIGIN` con la URL de Vercel (sin barra final).
5. Entra a la URL de Vercel, escribe tu contraseña y valida tu clave de IA en Ajustes.

Nota: el plan gratuito de Render se duerme tras 15 minutos sin uso; la primera visita puede tardar cerca de un minuto.
