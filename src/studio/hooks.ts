import { useEffect, useState } from 'react';
import type { Campaign, Clip, Project } from '../core/types';
import { clipThumbnail } from '../engine/exportService';
import { useStudio } from './store';

// Thumbnails are rendered one at a time (decoder friendly) and cached per clip version.
const thumbCache = new Map<string, string>();
let thumbQueue: Promise<unknown> = Promise.resolve();

function thumbKey(clip: Clip): string {
  const e = clip.edit;
  return `${clip.id}:${clip.start.toFixed(2)}:${clip.end.toFixed(2)}:${e.captionStyle}:${e.layout}:${e.aspect}:${clip.hook}:${clip.reframe?.analyzedAt ?? 0}:${e.captionColor ?? ''}:${e.highlightColor ?? ''}`;
}

/** Clip thumbnail URL; `null` when it can't be rendered (e.g. the source video is unavailable). */
export function useClipThumbnail(project: Project, clip: Clip, campaign?: Campaign): string | null | undefined {
  const settings = useStudio((s) => s.settings);
  const key = thumbKey(clip);
  const [url, setUrl] = useState<string | null | undefined>(() => thumbCache.get(key));
  useEffect(() => {
    if (thumbCache.has(key)) {
      setUrl(thumbCache.get(key));
      return;
    }
    if (!settings || !project.meta || !project.source.storedAs) return;
    let alive = true;
    thumbQueue = thumbQueue
      .then(async () => {
        if (!alive) return;
        const blob = await clipThumbnail(project, clip, settings, campaign, 0.34);
        const u = URL.createObjectURL(blob);
        thumbCache.set(key, u);
        if (alive) setUrl(u);
      })
      .catch((err) => {
        console.warn('thumbnail failed', err);
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, settings, project.meta, project.source.storedAs, project.source.restoredAt]);
  return url;
}

export function useInterval(fn: () => void, ms: number, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, [fn, ms, enabled]);
}

export function useProject(id: string | undefined): Project | undefined {
  return useStudio((s) => s.projects.find((p) => p.id === id));
}

export function useCampaign(id: string | undefined): Campaign | undefined {
  return useStudio((s) => s.campaigns.find((c) => c.id === id));
}
