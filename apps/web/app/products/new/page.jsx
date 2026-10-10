'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, upload } from '../../../lib/api';

const STYLES = [
  { id: 'HANGER', name: 'Con percha', desc: 'Colgada en la pared, fondo gris' },
  { id: 'SURFACE', name: 'En superficie', desc: 'Plana sobre superficie gris' },
];

export default function NewProduct() {
  const router = useRouter();
  const [files, setFiles] = useState([]);
  const [style, setStyle] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function go() {
    setBusy(true); setErr('');
    try {
      const fd = new FormData();
      fd.append('style', style);
      files.forEach((f) => fd.append('files', f));
      const p = await upload('/products', fd);
      await api(`/products/${p.id}/generate`, { method: 'POST', body: JSON.stringify({ style }) });
      router.push(`/products/${p.id}`);
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <>
      <div className="panel">
        <h2>1. Fotos del producto</h2>
        <p className="sub">Selecciona todas las fotos de una vez (hasta 12, JPG, PNG o WebP, máx. 10 MB cada una).</p>
        <label className="drop">
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => setFiles(Array.from(e.target.files))} />
          {files.length ? `${files.length} fotos seleccionadas. Toca para cambiarlas` : 'Toca para elegir fotos'}
        </label>
        <div className="thumbs">
          {files.map((f, i) => <img key={i} src={URL.createObjectURL(f)} alt="" />)}
        </div>
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <h2>2. Estilo de presentación</h2>
        <div className="opts">
          {STYLES.map((s) => (
            <button key={s.id} className="opt" aria-pressed={style === s.id} onClick={() => setStyle(s.id)}>
              <b>{s.name}</b><span>{s.desc}</span>
            </button>
          ))}
        </div>
        <div className="row">
          <button className="btn" disabled={busy || !files.length || !style} onClick={go}>
            {busy ? 'Subiendo…' : '3. Generar imágenes'}
          </button>
        </div>
        {err && <div className="msg bad">{err}</div>}
      </div>
    </>
  );
}
