import { create } from 'zustand';
import { generateSettingsForCampaign } from '../core/defaults';
import { shortId } from '../core/text';
import type { Campaign, Clip, EditSettings, MediaLink, Project } from '../core/types';
import { manualCampaign, mergeCampaign } from '../core/vyro';
import { fetchMediaToOpfs, MediaFetchError } from '../engine/fetcher';
import { clipBaseName, downloadFiles, exportClipPackage, saveToDirectory, zipFiles, type ExportedFile } from '../engine/exportService';
import { detectClips, processProject, rulesFor } from '../engine/pipeline';
import { db, deleteMedia, requestPersistentStorage, writeMedia } from '../engine/storage';
import type { AppSettings } from '../shared/settings';

export type View =
  | { name: 'campaigns' }
  | { name: 'projects' }
  | { name: 'campaign'; id: string; tab?: 'clips' | 'rules' | 'brief' | 'media' }
  | { name: 'project'; id: string }
  | { name: 'clip'; projectId: string; clipId: string }
  | { name: 'schedule'; campaignId?: string }
  | { name: 'brand' }
  | { name: 'settings' };

export interface Job {
  id: string;
  kind: 'pipeline' | 'download' | 'export';
  label: string;
  pct: number;
  detail?: string;
  controller: AbortController;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  text: string;
  hint?: string;
}

export type ExportTarget = 'folder' | 'download' | 'zip';

interface StudioState {
  ready: boolean;
  settings: AppSettings | null;
  campaigns: Campaign[];
  projects: Project[];
  view: View;
  jobs: Record<string, Job>;
  toasts: Toast[];
  init(): Promise<void>;
  navigate(view: View): void;
  saveSettings(s: AppSettings): Promise<void>;
  upsertCampaigns(list: Campaign[]): Promise<number>;
  updateCampaign(id: string, patch: Partial<Campaign>): Promise<void>;
  createManualCampaign(name: string, brief: string): Promise<Campaign>;
  deleteCampaign(id: string): Promise<void>;
  createProjectFromFile(file: File, campaignId?: string): Promise<Project>;
  createProjectFromLink(link: MediaLink, campaignId?: string): Promise<Project>;
  updateProject(id: string, patch: Partial<Project>, persist?: boolean): Promise<void>;
  deleteProject(id: string): Promise<void>;
  runPipeline(projectId: string, opts?: { redetect?: boolean }): Promise<void>;
  regenerateClips(projectId: string): Promise<void>;
  updateClip(projectId: string, clipId: string, patch: Partial<Clip>): void;
  updateClipEdit(projectId: string, clipId: string, patch: Partial<EditSettings>): void;
  deleteClip(projectId: string, clipId: string): Promise<void>;
  exportClips(projectId: string, clipIds: string[], target: ExportTarget): Promise<void>;
  clipCampaign(campaignId: string): Promise<void>;
  cancelJob(id: string): void;
  toast(kind: Toast['kind'], text: string, hint?: string): void;
  dismissToast(id: string): void;
}

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastPersist = new Map<string, number>();
let queue: Promise<unknown> = Promise.resolve();

/** Heavy jobs (transcription, rendering) run one after another to keep the GPU/decoders responsive. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function extOf(name: string): string {
  return /\.([a-z0-9]{2,4})$/i.exec(name)?.[1]?.toLowerCase() ?? 'mp4';
}

export const useStudio = create<StudioState>((set, get) => {
  const setJob = (job: Job | null, id: string) =>
    set((s) => {
      const jobs = { ...s.jobs };
      if (job) jobs[id] = job;
      else delete jobs[id];
      return { jobs };
    });

  const persistProject = (id: string, immediate: boolean) => {
    const doPersist = () => {
      persistTimers.delete(id);
      lastPersist.set(id, Date.now());
      const p = get().projects.find((x) => x.id === id);
      if (p) void db.putProject(p);
    };
    if (immediate) {
      clearTimeout(persistTimers.get(id));
      doPersist();
    } else if (!persistTimers.has(id)) {
      const wait = Math.max(300, 4000 - (Date.now() - (lastPersist.get(id) ?? 0)));
      persistTimers.set(id, setTimeout(doPersist, wait));
    }
  };

  return {
    ready: false,
    settings: null,
    campaigns: [],
    projects: [],
    view: { name: 'campaigns' },
    jobs: {},
    toasts: [],

    async init() {
      const [settings, campaigns, projects] = await Promise.all([db.getSettings(), db.listCampaigns(), db.listProjects()]);
      // Jobs don't survive reloads: mark interrupted projects so they can be resumed.
      const fixed = projects.map((p) => (p.status !== 'ready' && p.status !== 'error' && p.status !== 'new' ? { ...p, status: 'error' as const, error: 'Interrupted — click “Resume” to continue where it stopped.', progress: undefined } : p));
      set({ settings, campaigns: campaigns.sort((a, b) => b.updatedAt - a.updatedAt), projects: fixed.sort((a, b) => b.createdAt - a.createdAt), ready: true });
      void requestPersistentStorage();
    },

    navigate(view) {
      set({ view });
      window.scrollTo?.({ top: 0 });
    },

    async saveSettings(s) {
      set({ settings: s });
      await db.putSettings(s);
    },

    async upsertCampaigns(list) {
      const current = new Map(get().campaigns.map((c) => [c.id, c]));
      let added = 0;
      for (const incoming of list) {
        if (!current.has(incoming.id)) added++;
        const merged = mergeCampaign(current.get(incoming.id), incoming);
        current.set(incoming.id, merged);
        await db.putCampaign(merged);
      }
      set({ campaigns: [...current.values()].sort((a, b) => b.updatedAt - a.updatedAt) });
      return added;
    },

    async updateCampaign(id, patch) {
      const c = get().campaigns.find((x) => x.id === id);
      if (!c) return;
      const next = { ...c, ...patch, updatedAt: Date.now() };
      set({ campaigns: get().campaigns.map((x) => (x.id === id ? next : x)) });
      await db.putCampaign(next);
    },

    async createManualCampaign(name, brief) {
      const c = manualCampaign({ name, brief });
      await get().upsertCampaigns([c]);
      return c;
    },

    async deleteCampaign(id) {
      set({ campaigns: get().campaigns.filter((c) => c.id !== id) });
      await db.deleteCampaign(id);
    },

    async createProjectFromFile(file, campaignId) {
      const settings = get().settings!;
      const campaign = get().campaigns.find((c) => c.id === campaignId);
      const id = shortId('prj_');
      const storedAs = `${id}.${extOf(file.name)}`;
      const now = Date.now();
      const project: Project = {
        id,
        campaignId,
        name: file.name.replace(/\.[^.]+$/, ''),
        source: { kind: 'file', fileName: file.name, size: file.size, mime: file.type, storedAs },
        clips: [],
        status: 'new',
        settings: generateSettingsForCampaign(settings.defaultGenerate, rulesFor(campaign)),
        createdAt: now,
        updatedAt: now,
      };
      set({ projects: [project, ...get().projects] });
      await writeMedia(storedAs, file);
      await db.putProject(project);
      return project;
    },

    async createProjectFromLink(link, campaignId) {
      const settings = get().settings!;
      const campaign = get().campaigns.find((c) => c.id === campaignId);
      const id = shortId('prj_');
      const now = Date.now();
      const project: Project = {
        id,
        campaignId,
        name: link.label || (campaign ? `${campaign.name} – source` : 'Linked video'),
        source: { kind: 'url', url: link.url },
        clips: [],
        status: 'downloading',
        progress: { step: 'Downloading source video', pct: 0 },
        settings: generateSettingsForCampaign(settings.defaultGenerate, rulesFor(campaign)),
        createdAt: now,
        updatedAt: now,
      };
      set({ projects: [project, ...get().projects] });
      await db.putProject(project);
      const controller = new AbortController();
      setJob({ id, kind: 'download', label: `Downloading ${project.name}`, pct: 0, controller }, id);
      try {
        const fetched = await fetchMediaToOpfs(link, {
          settings,
          storedAs: id,
          signal: controller.signal,
          onProgress: (p) => {
            const pct = p.total ? (p.loaded / p.total) * 100 : p.stage === 'server' ? p.loaded : 0;
            const detail = p.stage === 'downloading' ? `${(p.loaded / 1e6).toFixed(1)} MB${p.total ? ` / ${(p.total / 1e6).toFixed(1)} MB` : ''}` : p.detail;
            void get().updateProject(id, { progress: { step: 'Downloading source video', pct, detail } }, false);
          },
        });
        await get().updateProject(id, {
          status: 'new',
          progress: undefined,
          name: fetched.name && fetched.name !== 'source' ? fetched.name.replace(/\.[^.]+$/, '') : project.name,
          source: { ...project.source, storedAs: fetched.storedAs, size: fetched.size, mime: fetched.mime, fileName: fetched.name },
        });
      } catch (err) {
        const e = err as Error;
        const hint = err instanceof MediaFetchError ? err.hint : undefined;
        await get().updateProject(id, { status: 'error', error: hint ? `${e.message} ${hint}` : e.message, progress: undefined });
        if (e.name !== 'AbortError') get().toast('error', e.message, hint);
        throw err;
      } finally {
        setJob(null, id);
      }
      return get().projects.find((p) => p.id === id)!;
    },

    async updateProject(id, patch, persist = true) {
      set({ projects: get().projects.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)) });
      const onlyProgress = Object.keys(patch).every((k) => k === 'progress');
      persistProject(id, persist && !onlyProgress);
    },

    async deleteProject(id) {
      const p = get().projects.find((x) => x.id === id);
      get().jobs[id]?.controller.abort();
      set({ projects: get().projects.filter((x) => x.id !== id) });
      await db.deleteProject(id);
      if (p?.source.storedAs) await deleteMedia(p.source.storedAs);
    },

    async runPipeline(projectId, opts) {
      const project = get().projects.find((p) => p.id === projectId);
      if (!project || get().jobs[projectId]) return;
      const controller = new AbortController();
      setJob({ id: projectId, kind: 'pipeline', label: `Processing ${project.name}`, pct: 0, controller }, projectId);
      await get().updateProject(projectId, { status: 'probing', error: undefined, progress: { step: 'Queued', pct: 0 } });
      try {
        await enqueue(async () => {
          const fresh = get().projects.find((p) => p.id === projectId);
          if (!fresh) return;
          await processProject(fresh, {
            settings: get().settings!,
            campaign: get().campaigns.find((c) => c.id === fresh.campaignId),
            signal: controller.signal,
            redetect: opts?.redetect,
            update: (patch) => get().updateProject(projectId, patch),
            patchClip: (clipId, patch, expected) => {
              const current = get().projects.find((p) => p.id === projectId)?.clips.find((c) => c.id === clipId);
              if (!current) return; // deleted meanwhile
              if (expected && (Math.abs(current.start - expected.start) > 0.01 || Math.abs(current.end - expected.end) > 0.01)) return; // re-trimmed meanwhile
              get().updateClip(projectId, clipId, patch);
            },
          });
        });
        const done = get().projects.find((p) => p.id === projectId);
        get().toast('success', `${done?.clips.length ?? 0} clips ready for “${done?.name}”`);
      } catch (err) {
        const e = err as Error;
        const cancelled = e.name === 'AbortError';
        await get().updateProject(projectId, { status: 'error', error: cancelled ? 'Cancelled — click “Resume” to continue.' : e.message, progress: undefined });
        if (!cancelled) get().toast('error', `Processing failed: ${e.message}`);
      } finally {
        setJob(null, projectId);
      }
    },

    async regenerateClips(projectId) {
      const p = get().projects.find((x) => x.id === projectId);
      if (!p?.meta || !p.transcript) return get().runPipeline(projectId);
      const keep = p.clips.filter((c) => c.favorite || c.status === 'rendered');
      const detected = await detectClips({ ...p, meta: p.meta, transcript: p.transcript }, {
        settings: get().settings!,
        campaign: get().campaigns.find((c) => c.id === p.campaignId),
        update: (patch) => get().updateProject(projectId, patch),
      });
      const fresh = detected.filter((d) => !keep.some((k) => Math.min(k.end, d.end) - Math.max(k.start, d.start) > 0.5 * (d.end - d.start)));
      await get().updateProject(projectId, { clips: [...keep, ...fresh].sort((a, b) => b.scores.total - a.scores.total), progress: undefined });
      return get().runPipeline(projectId);
    },

    updateClip(projectId, clipId, patch) {
      const p = get().projects.find((x) => x.id === projectId);
      if (!p) return;
      const clips = p.clips.map((c) => (c.id === clipId ? { ...c, ...patch, updatedAt: Date.now() } : c));
      set({ projects: get().projects.map((x) => (x.id === projectId ? { ...x, clips } : x)) });
      clearTimeout(persistTimers.get(projectId));
      persistTimers.set(projectId, setTimeout(() => persistProject(projectId, true), 400));
    },

    updateClipEdit(projectId, clipId, patch) {
      const clip = get().projects.find((x) => x.id === projectId)?.clips.find((c) => c.id === clipId);
      if (clip) get().updateClip(projectId, clipId, { edit: { ...clip.edit, ...patch } });
    },

    async deleteClip(projectId, clipId) {
      const p = get().projects.find((x) => x.id === projectId);
      if (p) await get().updateProject(projectId, { clips: p.clips.filter((c) => c.id !== clipId) });
    },

    async exportClips(projectId, clipIds, target) {
      const project = get().projects.find((p) => p.id === projectId);
      if (!project) return;
      let dir: FileSystemDirectoryHandle | undefined;
      if (target === 'folder') {
        if (!window.showDirectoryPicker) {
          get().toast('info', 'Folder export is not supported here; downloading files instead.');
          target = 'download';
        } else {
          try {
            dir = await window.showDirectoryPicker({ id: 'vyroclipper-export', mode: 'readwrite' });
          } catch {
            return; // user cancelled
          }
        }
      }
      const campaign = get().campaigns.find((c) => c.id === project.campaignId);
      const folderName = campaign?.name ?? project.name;
      const zipped: ExportedFile[] = [];
      let ok = 0;
      for (const clipId of clipIds) {
        const controller = new AbortController();
        const clip = get().projects.find((p) => p.id === projectId)?.clips.find((c) => c.id === clipId);
        if (!clip) continue;
        setJob({ id: clipId, kind: 'export', label: `Rendering “${clip.title}”`, pct: 0, controller }, clipId);
        get().updateClip(projectId, clipId, { status: 'rendering', error: undefined });
        try {
          await enqueue(async () => {
            const fresh = get().projects.find((p) => p.id === projectId)!;
            const freshClip = fresh.clips.find((c) => c.id === clipId)!;
            const index = fresh.clips.findIndex((c) => c.id === clipId);
            const { files, result } = await exportClipPackage(fresh, freshClip, index, get().settings!, campaign, (pct, detail) => setJob({ id: clipId, kind: 'export', label: `Rendering “${freshClip.title}”`, pct, detail, controller }, clipId), controller.signal);
            if (target === 'folder' && dir) await saveToDirectory(dir, files, folderName.replace(/[\\/:*?"<>|]/g, '').slice(0, 80));
            else if (target === 'download') downloadFiles(files, folderName);
            else zipped.push(...files);
            get().updateClip(projectId, clipId, { status: 'rendered', output: { fileName: `${clipBaseName(freshClip, index)}.mp4`, size: result.blob.size, renderedAt: Date.now(), durationSec: result.durationSec } });
          });
          ok++;
        } catch (err) {
          const e = err as Error;
          get().updateClip(projectId, clipId, { status: e.name === 'AbortError' ? 'draft' : 'error', error: e.name === 'AbortError' ? undefined : e.message });
          if (e.name !== 'AbortError') get().toast('error', `Export failed: ${e.message}`);
        } finally {
          setJob(null, clipId);
        }
      }
      if (target === 'zip' && zipped.length) downloadFiles([{ name: `${folderName.replace(/[^\w-]+/g, '-').slice(0, 60)}-clips.zip`, blob: await zipFiles(zipped) }]);
      if (ok) get().toast('success', `Exported ${ok} clip${ok > 1 ? 's' : ''}${target === 'folder' ? ' to your folder' : ''}.`);
    },

    async clipCampaign(campaignId) {
      const campaign = get().campaigns.find((c) => c.id === campaignId);
      if (!campaign) return;
      const videoLinks = campaign.media.filter((m) => ['video', 'gdrive', 'dropbox', 'youtube', 'social'].includes(m.kind));
      if (!videoLinks.length) {
        get().toast('info', `“${campaign.name}” has no downloadable video links. Open the campaign and drop the source file.`);
        get().navigate({ name: 'campaign', id: campaignId, tab: 'media' });
        return;
      }
      const existing = get().projects.filter((p) => p.campaignId === campaignId).map((p) => p.source.url);
      for (const link of videoLinks) {
        if (existing.includes(link.url)) continue;
        try {
          const project = await get().createProjectFromLink(link, campaignId);
          void get().runPipeline(project.id);
        } catch {
          /* toast already shown */
        }
      }
    },

    cancelJob(id) {
      get().jobs[id]?.controller.abort();
    },

    toast(kind, text, hint) {
      const id = shortId('t');
      set({ toasts: [...get().toasts, hint ? { id, kind, text, hint } : { id, kind, text }] });
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 12000 : 5000);
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  };
});
