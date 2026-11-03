import { zipSync } from 'fflate';
import { checkCompliance } from '../core/compliance';
import { toEdl, toFcpXml } from '../core/exporters';
import { buildPostCaption } from '../core/hooks';
import { planClip, remapWords } from '../core/timeline';
import { slugify } from '../core/text';
import { toSrt, wordsToCues } from '../core/transcript';
import type { Campaign, Clip, Project } from '../core/types';
import { outputSize } from '../core/reframe';
import { isExtensionPage } from '../shared/env';
import type { AppSettings } from '../shared/settings';
import { loadImageBitmap } from './images';
import { getProjectFile, rulesFor } from './pipeline';
import { renderClip, renderStill, type RenderResult } from './render';
import { db } from './storage';

export interface ExportedFile {
  name: string;
  blob: Blob;
}

export function clipBaseName(clip: Clip, index?: number): string {
  const score = String(clip.scores.total).padStart(2, '0');
  return `${index !== undefined ? String(index + 1).padStart(2, '0') + '-' : ''}${score}-${slugify(clip.title, 48)}`;
}

export function postCaptionFor(clip: Clip, campaign: Campaign | undefined) {
  return buildPostCaption({ hookLine: clip.caption || clip.title, rules: rulesFor(campaign), extraHashtags: clip.hashtags });
}

export function complianceFor(clip: Clip, project: Project, campaign: Campaign | undefined) {
  const words = project.transcript?.words ?? [];
  const plan = planClip({ start: clip.start, end: clip.end }, words, clip.manualCuts, {
    jumpCuts: clip.edit.jumpCuts,
    silenceThreshold: clip.edit.silenceThreshold,
    removeFillers: clip.edit.removeFillers,
  });
  const caption = postCaptionFor(clip, campaign);
  return {
    report: checkCompliance({
      rules: rulesFor(campaign),
      edit: clip.edit,
      durationSec: plan.duration,
      postCaption: caption.text,
      transcriptLanguage: project.transcript?.language,
      fromCampaignMedia: campaign ? project.source.kind === 'url' && campaign.media.some((m) => m.url === project.source.url) : undefined,
    }),
    durationSec: plan.duration,
    caption,
  };
}

async function renderInputs(project: Project, clip: Clip, settings: AppSettings, campaign?: Campaign) {
  const file = await getProjectFile(project);
  const logoUrl = clip.edit.logo ? clip.edit.logoUrl || settings.brand.logoDataUrl : undefined;
  const logo = logoUrl ? await loadImageBitmap(logoUrl, settings) : undefined;
  const music = clip.edit.musicEnabled && clip.edit.musicAssetId ? await db.getAsset(clip.edit.musicAssetId) : undefined;
  return {
    file,
    clip,
    words: project.transcript?.words ?? [],
    meta: project.meta!,
    keywords: rulesFor(campaign).keywords,
    logo,
    music,
    envelope: project.envelope,
    brandColors: [settings.brand.primaryColor, settings.brand.accentColor] as [string, string],
  };
}

export async function exportClipVideo(project: Project, clip: Clip, settings: AppSettings, campaign: Campaign | undefined, onProgress: (pct: number, detail: string) => void, signal?: AbortSignal): Promise<RenderResult> {
  const inputs = await renderInputs(project, clip, settings, campaign);
  return renderClip({ ...inputs, onProgress, signal });
}

export async function clipThumbnail(project: Project, clip: Clip, settings: AppSettings, campaign?: Campaign, scale = 0.4): Promise<Blob> {
  const inputs = await renderInputs(project, clip, settings, campaign);
  return renderStill({ ...inputs, scale });
}

/** MP4 + post caption + SRT + cover + editor timelines for one clip. */
export async function exportClipPackage(project: Project, clip: Clip, index: number, settings: AppSettings, campaign: Campaign | undefined, onProgress: (pct: number, detail: string) => void, signal?: AbortSignal): Promise<{ files: ExportedFile[]; result: RenderResult }> {
  const base = clipBaseName(clip, index);
  const result = await exportClipVideo(project, clip, settings, campaign, onProgress, signal);
  const words = project.transcript?.words ?? [];
  const plan = planClip({ start: clip.start, end: clip.end }, words, clip.manualCuts, { jumpCuts: clip.edit.jumpCuts, silenceThreshold: clip.edit.silenceThreshold, removeFillers: clip.edit.removeFillers });
  const srt = toSrt(wordsToCues(remapWords(words, plan)));
  const { caption, report } = complianceFor(clip, project, campaign);
  const lines = [
    `TITLE: ${clip.title}`,
    `VIRALITY SCORE: ${clip.scores.total}/99 (hook ${clip.scores.hook}, flow ${clip.scores.flow}, value ${clip.scores.value}, trend ${clip.scores.trend})`,
    campaign ? `CAMPAIGN: ${campaign.name}${campaign.submitUrl ? `\nSUBMIT: ${campaign.submitUrl}` : ''}` : '',
    '',
    '--- TikTok / Instagram caption ---',
    caption.variants.tiktok,
    '',
    '--- YouTube Shorts title ---',
    caption.variants.youtube,
    '',
    '--- X caption ---',
    caption.variants.x,
    '',
    '--- Compliance checklist ---',
    ...report.items.map((i) => `[${i.status.toUpperCase()}] ${i.label}${i.detail ? ` — ${i.detail}` : ''}`),
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  const out = outputSize(clip.edit.aspect, clip.edit.resolution);
  const files: ExportedFile[] = [
    { name: `${base}.mp4`, blob: result.blob },
    { name: `${base}.txt`, blob: new Blob([lines.join('\n')], { type: 'text/plain' }) },
    { name: `${base}.srt`, blob: new Blob([srt], { type: 'application/x-subrip' }) },
    { name: `${base}.edl`, blob: new Blob([toEdl(clip.title, project.source.fileName ?? project.name, plan)], { type: 'text/plain' }) },
    {
      name: `${base}.fcpxml`,
      blob: new Blob([toFcpXml({ title: clip.title, sourceName: project.source.fileName ?? project.name, sourceDuration: project.meta?.duration ?? clip.end, width: project.meta?.width ?? 1920, height: project.meta?.height ?? 1080, outWidth: out.width, outHeight: out.height, plan })], { type: 'application/xml' }),
    },
  ];
  try {
    files.push({ name: `${base}.jpg`, blob: await clipThumbnail(project, clip, settings, campaign, 1) });
  } catch {
    /* cover is optional */
  }
  return { files, result };
}

export async function saveToDirectory(dir: FileSystemDirectoryHandle, files: ExportedFile[], subfolder?: string): Promise<void> {
  const target = subfolder ? await dir.getDirectoryHandle(subfolder, { create: true }) : dir;
  for (const f of files) {
    const fh = await target.getFileHandle(f.name, { create: true });
    const w = await fh.createWritable();
    await w.write(f.blob);
    await w.close();
  }
}

export function downloadFiles(files: ExportedFile[], folder?: string): void {
  for (const f of files) {
    const url = URL.createObjectURL(f.blob);
    if (isExtensionPage() && chrome.downloads) {
      const filename = `${folder ? `VyroClipper/${slugify(folder, 60)}/` : 'VyroClipper/'}${f.name}`;
      chrome.downloads.download({ url, filename, saveAs: false }, () => setTimeout(() => URL.revokeObjectURL(url), 60000));
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }
}

export async function zipFiles(files: ExportedFile[]): Promise<Blob> {
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    entries[f.name] = [data, { level: /\.(mp4|jpg|png)$/i.test(f.name) ? 0 : 6 }];
  }
  return new Blob([zipSync(entries) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}
