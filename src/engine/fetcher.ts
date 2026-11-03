import { directDownloadUrl, googleDriveId, needsServerResolver } from '../core/vyro';
import { pickFrameioFile, resolveFrameioShare } from '../core/frameio';
import type { MediaLink } from '../core/types';
import type { AppSettings } from '../shared/settings';
import { isExtensionPage } from '../shared/env';
import { writeMedia } from './storage';

export interface FetchProgress {
  stage: 'resolving' | 'downloading' | 'server';
  loaded: number;
  total?: number;
  detail?: string;
}

export interface FetchedMedia {
  file: File;
  storedAs: string;
  mime: string;
  size: number;
  name: string;
}

export class MediaFetchError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.hint = hint;
  }
}

function serverHeaders(settings: AppSettings): HeadersInit {
  return settings.serverToken ? { 'x-vyroclipper-token': settings.serverToken } : {};
}

function serverBase(settings: AppSettings): string {
  return settings.serverUrl.replace(/\/+$/, '');
}

function extFromMime(mime: string, url: string): string {
  if (/mp4/.test(mime)) return 'mp4';
  if (/webm/.test(mime)) return 'webm';
  if (/quicktime/.test(mime)) return 'mov';
  if (/matroska/.test(mime)) return 'mkv';
  if (/mpeg/.test(mime) && /audio/.test(mime)) return 'mp3';
  const m = /\.([a-z0-9]{2,4})(?:$|[?#])/i.exec(url);
  return m ? m[1]!.toLowerCase() : 'mp4';
}

function nameFromResponse(res: Response, url: string): string {
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (m) return decodeURIComponent(m[1]!);
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last && /\./.test(last)) return decodeURIComponent(last);
  } catch {
    /* ignore */
  }
  return 'source';
}

async function tryFetch(url: string, init: RequestInit): Promise<Response | undefined> {
  try {
    const res = await fetch(url, init);
    return res.ok ? res : undefined;
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return undefined; // CORS or network failure
  }
}

/** Google Drive serves an HTML "can't scan for viruses" page for big files; follow its form. */
async function followDriveConfirm(html: string, link: MediaLink): Promise<string | undefined> {
  const id = googleDriveId(link.url);
  if (!id) return undefined;
  const uuid = /name="uuid" value="([^"]+)"/.exec(html)?.[1];
  const confirm = /name="confirm" value="([^"]+)"/.exec(html)?.[1] ?? 't';
  return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${confirm}${uuid ? `&uuid=${uuid}` : ''}`;
}

async function viaServerJob(link: MediaLink, settings: AppSettings, onProgress: (p: FetchProgress) => void, signal?: AbortSignal): Promise<Response> {
  const base = serverBase(settings);
  let res: Response;
  try {
    res = await fetch(`${base}/api/media/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serverHeaders(settings) },
      body: JSON.stringify({ url: link.url }),
      signal,
    });
  } catch {
    throw new MediaFetchError(
      `Can't reach the VyroClipper server at ${base}.`,
      'YouTube/TikTok/Instagram links need the Docker server (yt-dlp). Start it with `docker compose up -d`, set its URL in Settings, or download the video yourself and drop the file here.',
    );
  }
  if (!res.ok) throw new MediaFetchError(`Server rejected the download (${res.status}).`, await res.text().catch(() => ''));
  const { id } = (await res.json()) as { id: string };
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await new Promise((r) => setTimeout(r, 1500));
    const st = await fetch(`${base}/api/media/jobs/${id}`, { headers: serverHeaders(settings), signal });
    const job = (await st.json()) as { status: string; progress?: number; error?: string; message?: string };
    if (job.status === 'error') throw new MediaFetchError(job.error ?? 'Download failed on the server.', 'Check the link is public, or download it manually and drop the file here.');
    onProgress({ stage: 'server', loaded: job.progress ?? 0, total: 100, detail: job.message ?? 'Downloading on server…' });
    if (job.status === 'done') break;
  }
  const file = await fetch(`${base}/api/media/jobs/${id}/file`, { headers: serverHeaders(settings), signal });
  if (!file.ok || !file.body) throw new MediaFetchError('Server finished but the file is unavailable.', 'Try again.');
  return file;
}

/** Downloads a campaign media link into OPFS using the best available route. */
export async function fetchMediaToOpfs(
  link: MediaLink,
  opts: { settings: AppSettings; storedAs: string; onProgress: (p: FetchProgress) => void; signal?: AbortSignal },
): Promise<FetchedMedia> {
  const { settings, onProgress, signal } = opts;
  onProgress({ stage: 'resolving', loaded: 0, detail: 'Resolving link…' });
  let res: Response | undefined;
  let url = directDownloadUrl(link);
  let knownName: string | undefined;

  if (link.kind === 'frameio') {
    onProgress({ stage: 'resolving', loaded: 0, detail: 'Opening Frame.io share…' });
    let share;
    try {
      share = await resolveFrameioShare(link.url, (input, init) => fetch(input, { ...init, signal }));
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new MediaFetchError((err as Error).message, 'Open the Frame.io link, download the video, then drop the file here.');
    }
    const file = pickFrameioFile(share, link.fileId);
    if (!file?.downloadUrl) {
      throw new MediaFetchError('No downloadable video found in this Frame.io share (downloads may be disabled).', 'Open the link, download the file manually, then drop it here.');
    }
    url = file.downloadUrl;
    knownName = file.name;
  }

  if (needsServerResolver(link.kind)) {
    res = await viaServerJob(link, settings, onProgress, signal);
  } else {
    const init: RequestInit = { signal, credentials: 'omit', redirect: 'follow' };
    res = await tryFetch(url, init);
    if (!res && !isExtensionPage()) {
      res = await tryFetch(`${serverBase(settings)}/api/proxy?url=${encodeURIComponent(url)}`, { ...init, headers: serverHeaders(settings) });
    }
    if (res && /text\/html/i.test(res.headers.get('content-type') ?? '')) {
      const html = await res.text();
      const confirmUrl = link.kind === 'gdrive' ? await followDriveConfirm(html, link) : undefined;
      res = undefined;
      if (confirmUrl) {
        url = confirmUrl;
        res = (await tryFetch(url, init)) ?? (!isExtensionPage() ? await tryFetch(`${serverBase(settings)}/api/proxy?url=${encodeURIComponent(url)}`, { ...init, headers: serverHeaders(settings) }) : undefined);
        if (res && /text\/html/i.test(res.headers.get('content-type') ?? '')) res = undefined;
      }
      if (!res) {
        throw new MediaFetchError(
          'This link opens a web page, not a video file.',
          link.kind === 'gdrive-folder' || link.kind === 'page'
            ? 'Open the link, download the video, then drop the file into the project.'
            : 'Make sure the file is shared publicly ("Anyone with the link"), or download it and drop the file here.',
        );
      }
    }
    if (!res) {
      throw new MediaFetchError(
        'The video could not be downloaded from this browser.',
        isExtensionPage()
          ? 'The host blocked the download. Download it manually and drop the file here.'
          : 'The host blocks cross-origin downloads. Run the VyroClipper server (Docker) for proxying, use the Chrome extension, or drop the file here.',
      );
    }
  }

  if (!res.body) throw new MediaFetchError('Empty response.', 'Try again.');
  const total = Number(res.headers.get('content-length')) || undefined;
  const mime = (res.headers.get('content-type') ?? 'video/mp4').split(';')[0]!.trim();
  const name = knownName ?? nameFromResponse(res, url);
  const storedAs = `${opts.storedAs}.${extFromMime(mime, name || url)}`;
  const file = await writeMedia(storedAs, res.body, (loaded) => onProgress({ stage: 'downloading', loaded, total, detail: 'Downloading…' }));
  return { file, storedAs, mime, size: file.size, name };
}
