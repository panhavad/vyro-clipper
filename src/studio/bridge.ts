import type { Campaign } from '../core/types';
import { hasChromeRuntime, isExtensionPage } from '../shared/env';
import { STORAGE_KEYS, type BackgroundRequest, type BridgeMessage, type ExtensionState } from '../shared/protocol';

export interface ExtensionStatus {
  connected: boolean;
  version?: string;
  commit?: string;
}

const inExtension = () => isExtensionPage() && hasChromeRuntime();

function sendToBackground<T>(msg: BackgroundRequest): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

/** Web mode: request/response through the studio-bridge content script via window.postMessage. */
function viaBridge<T>(type: string, payload?: unknown, timeoutMs = 4000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMsg);
      reject(new Error('VyroClipper extension not detected'));
    }, timeoutMs);
    function onMsg(ev: MessageEvent) {
      const m = ev.data as BridgeMessage;
      if (ev.source !== window || !m || m.__vc !== 'res' || m.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      if (m.ok) resolve(m.data as T);
      else reject(new Error(m.error ?? 'Extension error'));
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ __vc: 'req', id, type, payload } satisfies BridgeMessage, window.location.origin);
  });
}

function request<T>(msg: BackgroundRequest, timeoutMs?: number): Promise<T> {
  if (inExtension()) return sendToBackground<T>(msg);
  return viaBridge<T>(msg.type, msg, timeoutMs);
}

export async function extensionStatus(): Promise<ExtensionStatus> {
  if (!inExtension() && !document.documentElement.dataset.vyroclipperExt) {
    // The bridge marks the page once it is injected; give it a moment on first load.
    await new Promise((r) => setTimeout(r, 300));
    if (!document.documentElement.dataset.vyroclipperExt) return { connected: false };
  }
  try {
    const state = await request<ExtensionState>({ type: 'vc:get-state' }, 2500);
    return { connected: true, version: state.version, commit: state.commit };
  } catch {
    return { connected: false };
  }
}

export async function pullExtensionCampaigns(): Promise<{ campaigns: Campaign[]; selected: string[] }> {
  const state = await request<ExtensionState>({ type: 'vc:get-state' });
  return { campaigns: state.campaigns, selected: state.selected };
}

export function syncFromVyro(): Promise<{ ok: boolean; count?: number; error?: string }> {
  return request({ type: 'vc:sync-vyro' }, 120000);
}

export function setExtensionSelection(ids: string[]): Promise<unknown> {
  return request({ type: 'vc:set-selected', ids });
}

export function onExtensionCampaignsChanged(cb: () => void): () => void {
  if (inExtension()) {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (changes[STORAGE_KEYS.campaigns] || changes[STORAGE_KEYS.selected])) cb();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
  const onMsg = (ev: MessageEvent) => {
    const m = ev.data as BridgeMessage;
    if (ev.source === window && m?.__vc === 'event' && m.type === 'campaigns-changed') cb();
  };
  window.addEventListener('message', onMsg);
  return () => window.removeEventListener('message', onMsg);
}
