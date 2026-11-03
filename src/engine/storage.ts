import { createStore, del, entries, get, set } from 'idb-keyval';
import type { Campaign, Project } from '../core/types';
import { mergeSettings, type AppSettings } from '../shared/settings';

// Metadata lives in IndexedDB; large media lives in the Origin Private File System (OPFS).
const kv = createStore('vyroclipper', 'kv');

export const db = {
  async listCampaigns(): Promise<Campaign[]> {
    const all = await entries<string, Campaign>(kv);
    return all.filter(([k]) => k.startsWith('campaign:')).map(([, v]) => v);
  },
  getCampaign: (id: string) => get<Campaign>(`campaign:${id}`, kv),
  putCampaign: (c: Campaign) => set(`campaign:${c.id}`, c, kv),
  deleteCampaign: (id: string) => del(`campaign:${id}`, kv),

  async listProjects(): Promise<Project[]> {
    const all = await entries<string, Project>(kv);
    return all.filter(([k]) => k.startsWith('project:')).map(([, v]) => v);
  },
  getProject: (id: string) => get<Project>(`project:${id}`, kv),
  putProject: (p: Project) => set(`project:${p.id}`, p, kv),
  deleteProject: (id: string) => del(`project:${id}`, kv),

  async getSettings(): Promise<AppSettings> {
    return mergeSettings(await get<Partial<AppSettings>>('settings', kv));
  },
  putSettings: (s: AppSettings) => set('settings', s, kv),

  getAsset: (id: string) => get<Blob>(`asset:${id}`, kv),
  putAsset: (id: string, blob: Blob) => set(`asset:${id}`, blob, kv),
};

async function mediaDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('media', { create: true });
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

/** Streams data into OPFS (never holds the whole file in memory). */
export async function writeMedia(name: string, data: Blob | ReadableStream<Uint8Array>, onBytes?: (n: number) => void): Promise<File> {
  const dir = await mediaDir();
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    if (data instanceof Blob) {
      await writable.write(data);
      onBytes?.(data.size);
    } else {
      const reader = data.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value as Uint8Array<ArrayBuffer>);
        total += value.byteLength;
        onBytes?.(total);
      }
    }
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => undefined);
    throw err;
  }
  return handle.getFile();
}

export async function readMedia(name: string): Promise<File | undefined> {
  try {
    const dir = await mediaDir();
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return undefined;
  }
}

export async function deleteMedia(name: string): Promise<void> {
  try {
    const dir = await mediaDir();
    await dir.removeEntry(name);
  } catch {
    /* already gone */
  }
}
