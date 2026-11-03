// MV3 service worker: campaign store, studio launcher, Vyro sync orchestration and dev auto-reload.
import { mergeCampaign } from '../core/vyro';
import type { Campaign } from '../core/types';
import { DEFAULT_EXTENSION_OPTIONS, STORAGE_KEYS, type BackgroundRequest, type ExtensionOptions, type ExtensionState } from '../shared/protocol';

const BUILD = __BUILD_INFO__;
const VYRO_MATCH = 'https://app.vyro.com/*';

async function getCampaigns(): Promise<Record<string, Campaign>> {
  const r = await chrome.storage.local.get(STORAGE_KEYS.campaigns);
  return (r[STORAGE_KEYS.campaigns] as Record<string, Campaign> | undefined) ?? {};
}

async function getSelected(): Promise<string[]> {
  const r = await chrome.storage.local.get(STORAGE_KEYS.selected);
  return (r[STORAGE_KEYS.selected] as string[] | undefined) ?? [];
}

async function getOptions(): Promise<ExtensionOptions> {
  const r = await chrome.storage.local.get(STORAGE_KEYS.options);
  return { ...DEFAULT_EXTENSION_OPTIONS, ...((r[STORAGE_KEYS.options] as Partial<ExtensionOptions> | undefined) ?? {}) };
}

async function setBadge(count: number) {
  await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

async function upsert(list: Campaign[]): Promise<number> {
  const all = await getCampaigns();
  for (const c of list) {
    // Raw API payloads can be large; the studio only needs the normalised fields.
    const slim: Campaign = { ...c, raw: undefined };
    all[c.id] = mergeCampaign(all[c.id], slim);
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.campaigns]: all });
  const selected = await getSelected();
  await setBadge(selected.length);
  return Object.keys(all).length;
}

async function state(): Promise<ExtensionState> {
  const [campaigns, selected, options] = await Promise.all([getCampaigns(), getSelected(), getOptions()]);
  return {
    campaigns: Object.values(campaigns).sort((a, b) => b.updatedAt - a.updatedAt),
    selected,
    version: chrome.runtime.getManifest().version,
    commit: BUILD.commit,
    options,
  };
}

async function setSelected(ids: string[]) {
  const unique = [...new Set(ids)];
  await chrome.storage.local.set({ [STORAGE_KEYS.selected]: unique });
  await setBadge(unique.length);
}

async function openStudio(campaignIds?: string[]) {
  const opts = await getOptions();
  const hash = campaignIds?.length ? `#/campaigns?select=${campaignIds.map(encodeURIComponent).join(',')}` : '#/campaigns';
  const base = opts.studioUrl ? opts.studioUrl.replace(/\/+$/, '/') : chrome.runtime.getURL('studio.html');
  const url = `${base}${hash}`;
  const pattern = opts.studioUrl ? `${new URL(opts.studioUrl).origin}/*` : chrome.runtime.getURL('studio.html*');
  const tabs = await chrome.tabs.query({ url: pattern });
  const existing = tabs[0];
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { url, active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Finds (or opens) a logged-in app.vyro.com tab whose content script has seen the session. */
async function vyroTab(): Promise<number> {
  let tabs = await chrome.tabs.query({ url: VYRO_MATCH });
  let tabId = tabs.find((t) => t.active)?.id ?? tabs[0]?.id;
  if (tabId === undefined) {
    const tab = await chrome.tabs.create({ url: 'https://app.vyro.com/campaigns', active: false });
    tabId = tab.id!;
  }
  for (let i = 0; i < 40; i++) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, { type: 'vc:ping' })) as { ok: boolean; auth: boolean } | undefined;
      if (res?.auth) return tabId;
    } catch {
      /* content script not ready yet */
    }
    if (i === 8) {
      // An already-open tab loaded before the extension was installed: reload it so the hooks attach.
      tabs = await chrome.tabs.query({ url: VYRO_MATCH });
      if (tabs.some((t) => t.id === tabId)) await chrome.tabs.reload(tabId);
    }
    await sleep(750);
  }
  throw new Error('Could not find a logged-in Vyro session. Open app.vyro.com, log in, then try again.');
}

async function handle(msg: BackgroundRequest): Promise<unknown> {
  switch (msg.type) {
    case 'vc:upsert-campaigns':
      return { ok: true, total: await upsert(msg.campaigns) };
    case 'vc:get-state':
      return state();
    case 'vc:set-selected':
      await setSelected(msg.ids);
      return { ok: true };
    case 'vc:toggle-selected': {
      const sel = await getSelected();
      await setSelected(msg.selected ? [...sel, msg.id] : sel.filter((x) => x !== msg.id));
      return { ok: true };
    }
    case 'vc:open-studio':
      await openStudio(msg.campaignIds);
      return { ok: true };
    case 'vc:sync-vyro': {
      try {
        const tabId = await vyroTab();
        const res = (await chrome.tabs.sendMessage(tabId, { type: 'vc:fetch-all' })) as { ok: boolean; count?: number; error?: string };
        return res;
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'vc:fetch-campaign': {
      try {
        const tabId = await vyroTab();
        return await chrome.tabs.sendMessage(tabId, { type: 'vc:fetch-slug', slug: msg.slug });
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'vc:get-options':
      return getOptions();
    case 'vc:set-options': {
      const next = { ...(await getOptions()), ...msg.options };
      await chrome.storage.local.set({ [STORAGE_KEYS.options]: next });
      await registerStudioBridge(next);
      return next;
    }
    case 'vc:check-update':
      return checkForNewBuild();
    default:
      return { ok: false, error: 'unknown message' };
  }
}

chrome.runtime.onMessage.addListener((msg: BackgroundRequest, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err: Error) => sendResponse({ ok: false, error: err.message }));
  return true;
});

/** Lets a hosted (Docker) studio on a custom domain talk to the extension. localhost is covered by the manifest. */
async function registerStudioBridge(opts: ExtensionOptions) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['studio-bridge-custom'] }).catch(() => undefined);
    if (!opts.studioUrl) return;
    const origin = new URL(opts.studioUrl).origin;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return;
    await chrome.scripting.registerContentScripts([{ id: 'studio-bridge-custom', matches: [`${origin}/*`], js: ['studio-bridge.js'], runAt: 'document_start' }]);
  } catch (err) {
    console.warn('bridge registration failed', err);
  }
}

// ---------------------------------------------------------------------------------------------
// Auto-update for unpacked installs: when the build on disk changes (git commit → rebuild), reload.

async function checkForNewBuild(): Promise<{ current: string; onDisk?: string; reloading: boolean }> {
  try {
    const res = await fetch(chrome.runtime.getURL('build-info.json'), { cache: 'no-store' });
    const info = (await res.json()) as { commit?: string; builtAt?: string };
    const changed = !!info.commit && (info.commit !== BUILD.commit || (info.builtAt !== undefined && info.builtAt !== BUILD.builtAt));
    if (changed) setTimeout(() => chrome.runtime.reload(), 300);
    return { current: BUILD.commit, onDisk: info.commit, reloading: changed };
  } catch {
    return { current: BUILD.commit, reloading: false };
  }
}

chrome.alarms.create('vc-update-check', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'vc-update-check') return;
  const self = await chrome.management.getSelf();
  if (self.installType === 'development') await checkForNewBuild();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await registerStudioBridge(await getOptions());
  const selected = await getSelected();
  await setBadge(selected.length);
  if (details.reason === 'install') await chrome.tabs.create({ url: 'https://app.vyro.com/campaigns' });
});

chrome.runtime.onStartup.addListener(async () => {
  await registerStudioBridge(await getOptions());
});
