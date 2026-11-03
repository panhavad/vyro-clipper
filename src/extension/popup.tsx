import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/700.css';
import type { BackgroundRequest, ExtensionState } from '../shared/protocol';
import { effectiveRules } from '../core/vyro';

const send = <T,>(msg: BackgroundRequest) => chrome.runtime.sendMessage(msg) as Promise<T>;

function Popup() {
  const [st, setSt] = useState<ExtensionState>();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [studioUrl, setStudioUrl] = useState('');
  const [showOptions, setShowOptions] = useState(false);
  const refresh = () =>
    void send<ExtensionState>({ type: 'vc:get-state' }).then((s) => {
      setSt(s);
      setStudioUrl(s.options.studioUrl);
    });
  useEffect(refresh, []);
  if (!st) return <div className="pad muted">Loading…</div>;
  const selected = new Set(st.selected);
  const list = st.campaigns.filter((c) => !query || `${c.name} ${c.brand ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const toggle = async (id: string, v: boolean) => {
    await send({ type: 'vc:toggle-selected', id, selected: v });
    refresh();
  };
  return (
    <div className="popup">
      <header>
        <div className="logo">✂</div>
        <div>
          <b>VyroClipper</b>
          <div className="muted small">
            v{st.version} · {st.commit.slice(0, 7)}
          </div>
        </div>
        <button className="ghost" title="Options" onClick={() => setShowOptions((v) => !v)}>
          ⚙
        </button>
      </header>

      {showOptions && (
        <div className="options">
          <label className="small muted">Hosted studio URL (Docker) — leave empty to use the built-in studio</label>
          <input value={studioUrl} onChange={(e) => setStudioUrl(e.target.value)} placeholder="http://localhost:8080" />
          <button
            onClick={async () => {
              await send({ type: 'vc:set-options', options: { studioUrl: studioUrl.trim() } });
              refresh();
              setShowOptions(false);
            }}
          >
            Save
          </button>
        </div>
      )}

      <div className="row">
        <button
          className="primary"
          disabled={!!busy}
          onClick={async () => {
            setBusy('Syncing from Vyro…');
            const r = await send<{ ok: boolean; count?: number; error?: string }>({ type: 'vc:sync-vyro' });
            setBusy(r.ok ? `Synced ${r.count ?? 0} campaigns ✓` : r.error ?? 'Sync failed');
            refresh();
            setTimeout(() => setBusy(''), 4000);
          }}
        >
          ⟳ Sync from Vyro
        </button>
        <button onClick={() => void send({ type: 'vc:open-studio' }).then(() => window.close())}>Open studio</button>
      </div>
      {busy && <div className="status">{busy}</div>}

      <input className="search" placeholder={`Search ${st.campaigns.length} campaigns…`} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="list">
        {list.length === 0 && (
          <div className="muted small pad">
            No campaigns captured yet. Open <a href="https://app.vyro.com/campaigns" target="_blank" rel="noreferrer">app.vyro.com</a> while logged in, then press Sync.
          </div>
        )}
        {list.map((c) => {
          const r = effectiveRules(c);
          return (
            <label key={c.id} className={`item ${selected.has(c.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={selected.has(c.id)} onChange={(e) => void toggle(c.id, e.target.checked)} />
              <div className="item-body">
                <div className="name">
                  {c.name}
                  {c.enrolled && <span className="tag good">Joined</span>}
                  {c.locked && <span className="tag">🔒 Locked</span>}
                </div>
                <div className="muted small">
                  {c.brand ? `${c.brand} · ` : ''}
                  {c.cpm !== undefined ? `$${c.cpm.toFixed(2)}/1K` : ''} {r.minDurationSec ? `· ≥${r.minDurationSec}s` : ''} · {c.media.length} source{c.media.length === 1 ? '' : 's'}
                </div>
              </div>
            </label>
          );
        })}
      </div>
      <footer>
        <button className="primary wide" disabled={!selected.size} onClick={() => void send({ type: 'vc:open-studio', campaignIds: [...selected] }).then(() => window.close())}>
          ✂ Clip {selected.size || ''} selected campaign{selected.size === 1 ? '' : 's'}
        </button>
      </footer>
    </div>
  );
}

const css = `
body{margin:0;width:380px;background:#0b0b12;color:#ececf4;font:13px/1.4 Inter,system-ui,sans-serif}
.popup{display:flex;flex-direction:column;gap:10px;padding:12px}
header{display:flex;align-items:center;gap:10px}
header .ghost{margin-left:auto}
.logo{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(135deg,#7c3aed,#22d3ee);font-size:16px}
.muted{color:#9b9bb4}.small{font-size:11px}.pad{padding:10px}
button{font:700 12px Inter,system-ui,sans-serif;border:1px solid #2c2c44;background:#1a1a28;color:#fff;border-radius:10px;padding:9px 10px;cursor:pointer}
button.primary{background:linear-gradient(135deg,#7c3aed,#6d28d9);border-color:transparent}
button.ghost{background:none}
button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:8px}.row button{flex:1}
.wide{width:100%}
input{font:inherit;color:#fff;background:#191926;border:1px solid #2c2c44;border-radius:10px;padding:8px 10px;outline:none;width:100%;box-sizing:border-box}
.list{max-height:330px;overflow:auto;display:flex;flex-direction:column;gap:6px}
.item{display:flex;gap:10px;align-items:flex-start;padding:9px;border:1px solid #29293f;border-radius:12px;background:#12121c;cursor:pointer}
.item.on{border-color:#7c3aed;background:rgba(124,58,237,.12)}
.item input{width:16px;margin-top:2px;accent-color:#7c3aed}
.name{font-weight:700}
.tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;font-size:10px;font-weight:700;background:#26263a;color:#c9c9dc;vertical-align:1px}
.tag.good{background:rgba(34,197,94,.15);color:#4ade80}
.status{background:rgba(34,211,238,.1);border:1px solid rgba(34,211,238,.3);padding:8px;border-radius:10px;font-size:12px}
.options{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid #29293f;border-radius:12px}
a{color:#22d3ee}`;

const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
