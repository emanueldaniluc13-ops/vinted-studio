'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useStatus } from '../../components/Shell';

export default function Settings() {
  const st = useStatus();
  const providers = st.providers || [];
  const [provider, setProvider] = useState('gemini');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (st.provider) { setProvider(st.provider); setModel(st.model || ''); }
  }, [st.provider, st.model]);

  const P = providers.find((p) => p.id === provider);

  function pick(id) {
    setProvider(id); setModels([]); setMsg(null);
    setModel(providers.find((p) => p.id === id)?.defaultModel || '');
  }
  async function loadModels() {
    setBusy(true); setMsg({ text: 'Buscando los modelos de tu cuenta…' });
    try {
      const { models: list } = await api('/settings/models', { method: 'POST', body: JSON.stringify({ provider, apiKey }) });
      setModels(list);
      if (list.length && !list.includes(model)) setModel(list[0]);
      setMsg(list.length
        ? { ok: true, text: `${list.length} modelos de imagen disponibles. Elige uno.` }
        : { ok: false, text: 'Tu cuenta no tiene modelos de imagen disponibles. Escribe uno a mano.' });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  }
  async function validate() {
    setBusy(true); setMsg({ text: 'Validando…' });
    try {
      await api('/settings/api-key', { method: 'POST', body: JSON.stringify({ provider, apiKey, model }) });
      setApiKey(''); setMsg({ ok: true, text: 'Clave válida. Ya puedes añadir productos.' });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy(false); st.refresh();
  }
  async function remove() {
    await api('/settings/api-key', { method: 'DELETE' });
    setMsg({ ok: true, text: 'Clave eliminada.' }); st.refresh();
  }

  return (
    <div className="panel">
      <h2>Proveedor de IA y clave de API</h2>
      <p className="sub">Elige quién genera las imágenes y el modelo. La clave se guarda cifrada en tu servidor. Sin una clave validada, la app queda bloqueada.</p>
      <div className="row" style={{ marginTop: 0, marginBottom: 14 }}>
        {providers.map((p) => (
          <button key={p.id} className={`btn ${p.id === provider ? '' : 'ghost'}`} onClick={() => pick(p.id)}>{p.label}</button>
        ))}
      </div>
      <input type="password" placeholder={P?.keyHint || ''} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
      {P && <p className="sub" style={{ marginTop: 6 }}>Consigue la clave en {P.keyUrl}.</p>}
      <div className="row" style={{ marginTop: 0 }}>
        <button className="btn ghost" onClick={loadModels} disabled={busy || !apiKey}>Cargar modelos de mi cuenta</button>
      </div>
      <p className="sub" style={{ marginTop: 14 }}>Modelo de imagen</p>
      {models.length > 0 ? (
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      ) : (
        <input type="text" value={model} onChange={(e) => setModel(e.target.value)} />
      )}
      <div className="row">
        <button className="btn" onClick={validate} disabled={busy || !apiKey || !model}>Validar clave</button>
        {st.configured && <button className="btn ghost" onClick={remove}>Quitar clave</button>}
      </div>
      {msg && <div className={`msg ${msg.ok === true ? 'ok' : msg.ok === false ? 'bad' : ''}`}>{msg.text}</div>}
    </div>
  );
}
