// Content script on a hosted studio (localhost or a configured domain): relays window messages to the extension.
import { STORAGE_KEYS, type BackgroundRequest, type BridgeMessage } from '../shared/protocol';

const ALLOWED: Array<BackgroundRequest['type']> = ['vc:get-state', 'vc:sync-vyro', 'vc:set-selected', 'vc:toggle-selected', 'vc:fetch-campaign'];

document.documentElement.dataset.vyroclipperExt = chrome.runtime.getManifest().version;

window.addEventListener('message', (ev: MessageEvent<BridgeMessage>) => {
  const m = ev.data;
  if (ev.source !== window || !m || m.__vc !== 'req' || !m.id) return;
  const payload = (m.payload ?? { type: m.type }) as BackgroundRequest;
  const reply = (r: Omit<BridgeMessage, '__vc' | 'id'>) => window.postMessage({ __vc: 'res', id: m.id, ...r } satisfies BridgeMessage, location.origin);
  if (!ALLOWED.includes(payload.type)) {
    reply({ ok: false, error: `Not allowed: ${payload.type}` });
    return;
  }
  chrome.runtime.sendMessage(payload).then(
    (data) => reply({ ok: true, data }),
    (err: Error) => reply({ ok: false, error: err.message }),
  );
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[STORAGE_KEYS.campaigns] || changes[STORAGE_KEYS.selected])) {
    window.postMessage({ __vc: 'event', type: 'campaigns-changed' } satisfies BridgeMessage, location.origin);
  }
});
