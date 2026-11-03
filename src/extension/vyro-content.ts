// Isolated-world content script on app.vyro.com: bridges captured data to the extension and adds a small overlay.
import { campaignSlugFromUrl, findCampaignsInPayload, normalizeVyroCampaign } from '../core/vyro';
import type { Campaign } from '../core/types';
import type { BackgroundRequest, ContentRequest, VyroPageMessage } from '../shared/protocol';

let authReady = false;
const known = new Map<string, Campaign>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const send = <T,>(msg: BackgroundRequest) => chrome.runtime.sendMessage(msg) as Promise<T>;

function ingest(payload: unknown): Campaign[] {
  const found = findCampaignsInPayload(payload).map((raw) => normalizeVyroCampaign(raw));
  if (!found.length) return [];
  for (const c of found) known.set(c.id, c);
  void send({ type: 'vc:upsert-campaigns', campaigns: found }).catch(() => undefined);
  renderOverlay();
  return found;
}

function requestMain(kind: 'all' | 'slug', slug?: string): Promise<unknown> {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ __vyroclipper: 'fetch-request', id, kind, slug } satisfies VyroPageMessage, location.origin);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('Timed out talking to the Vyro page.'));
    }, 90000);
  });
}

window.addEventListener('message', (ev: MessageEvent<VyroPageMessage>) => {
  if (ev.source !== window || !ev.data?.__vyroclipper) return;
  const d = ev.data;
  if (d.__vyroclipper === 'captured') ingest((d.payload as { json: unknown }).json);
  else if (d.__vyroclipper === 'auth') {
    authReady = true;
    renderOverlay();
  } else if (d.__vyroclipper === 'fetch-result' && d.id) {
    const p = pending.get(d.id);
    pending.delete(d.id);
    if (!p) return;
    if (d.error) p.reject(new Error(d.error));
    else p.resolve(d.payload);
  }
});

chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
  if (msg.type === 'vc:ping') {
    sendResponse({ ok: true, auth: authReady });
    return false;
  }
  if (msg.type === 'vc:fetch-all' || msg.type === 'vc:fetch-slug') {
    requestMain(msg.type === 'vc:fetch-all' ? 'all' : 'slug', msg.type === 'vc:fetch-slug' ? msg.slug : undefined)
      .then((payload) => sendResponse({ ok: true, count: ingest(payload).length, ids: [...known.keys()] }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------------------------
// Overlay (Shadow DOM so Vyro's styles and ours never clash)

let host: HTMLDivElement | null = null;
let root: ShadowRoot | null = null;
let busy = '';
let overlayEnabled = true;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function currentCampaign(): Campaign | undefined {
  const slug = campaignSlugFromUrl(location.href);
  if (!slug) return undefined;
  return [...known.values()].find((c) => c.slug === slug);
}

async function clipCurrent() {
  const slug = campaignSlugFromUrl(location.href);
  if (!slug) return;
  let c = currentCampaign();
  if (!c) {
    busy = 'Loading campaign…';
    renderOverlay();
    try {
      const payload = await requestMain('slug', slug);
      c = ingest(payload)[0];
    } catch (err) {
      busy = '';
      alert(`VyroClipper: ${(err as Error).message}`);
      renderOverlay();
      return;
    }
  }
  busy = '';
  renderOverlay();
  if (c) {
    await send({ type: 'vc:toggle-selected', id: c.id, selected: true });
    await send({ type: 'vc:open-studio', campaignIds: [c.id] });
  }
}

async function syncAll() {
  busy = 'Syncing…';
  renderOverlay();
  try {
    const payload = await requestMain('all');
    const n = ingest(payload).length;
    busy = `Synced ${n} campaigns ✓`;
  } catch (err) {
    busy = (err as Error).message;
  }
  renderOverlay();
  setTimeout(() => {
    busy = '';
    renderOverlay();
  }, 4000);
}

function renderOverlay() {
  if (!document.body || !overlayEnabled) return;
  if (!host) {
    host = document.createElement('div');
    host.id = 'vyroclipper-overlay';
    host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;';
    root = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
  }
  const c = currentCampaign();
  const onCampaign = !!campaignSlugFromUrl(location.href);
  root!.innerHTML = `
    <style>
      .box{font:600 13px/1.3 Inter,system-ui,sans-serif;color:#fff;background:#12121c;border:1px solid #2c2c44;border-radius:16px;padding:10px;box-shadow:0 12px 30px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:8px;min-width:230px}
      .head{display:flex;align-items:center;gap:8px}
      .logo{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:linear-gradient(135deg,#7c3aed,#22d3ee)}
      .muted{color:#9b9bb4;font-weight:500;font-size:12px}
      button{font:700 13px Inter,system-ui,sans-serif;border:0;border-radius:10px;padding:9px 12px;cursor:pointer;color:#fff;background:#24243a}
      button.primary{background:linear-gradient(135deg,#7c3aed,#6d28d9)}
      button:disabled{opacity:.6;cursor:default}
      .row{display:flex;gap:6px}
      .row button{flex:1}
      .dot{width:8px;height:8px;border-radius:50%;background:${authReady ? '#22c55e' : '#f59e0b'};display:inline-block;margin-right:4px}
    </style>
    <div class="box">
      <div class="head"><div class="logo">✂</div><div><div>VyroClipper</div><div class="muted"><span class="dot"></span>${authReady ? 'Session ready' : 'Waiting for login'} · ${known.size} campaigns</div></div></div>
      ${onCampaign ? `<button class="primary" id="clip" ${busy ? 'disabled' : ''}>✂ Clip ${c ? `“${esc(c.name.slice(0, 26))}${c.name.length > 26 ? '…' : ''}”` : 'this campaign'}</button>` : ''}
      <div class="row"><button id="sync" ${busy || !authReady ? 'disabled' : ''}>⟳ Sync all</button><button id="studio">Open studio</button></div>
      ${busy ? `<div class="muted">${esc(busy)}</div>` : ''}
    </div>`;
  root!.getElementById('clip')?.addEventListener('click', () => void clipCurrent());
  root!.getElementById('sync')?.addEventListener('click', () => void syncAll());
  root!.getElementById('studio')?.addEventListener('click', () => void send({ type: 'vc:open-studio' }));
}

// SPA navigation: re-render when the URL changes (e.g. opening a campaign sets ?c=slug).
let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    renderOverlay();
  }
}, 700);

void chrome.storage.local.get('vc:options').then((o) => {
  const opts = o['vc:options'] as { overlay?: boolean } | undefined;
  overlayEnabled = opts?.overlay !== false;
  if (!overlayEnabled) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderOverlay);
  else renderOverlay();
});
