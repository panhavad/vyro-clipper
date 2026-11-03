import { resolveFrameioShare, type FrameioShare } from '../core/frameio';
import { isExtensionPage } from '../shared/env';
import type { AppSettings } from '../shared/settings';

const cache = new Map<string, { at: number; share: FrameioShare }>();
// Signed download URLs expire; re-resolve after a while.
const TTL_MS = 20 * 60 * 1000;

/**
 * Resolves a Frame.io share in the browser. GraphQL + downloads are CORS-enabled; only f.io short-link
 * redirects are not, so web pages fall back to the VyroClipper server's /api/resolve (the extension doesn't need it).
 */
export async function resolveShare(url: string, settings: AppSettings | null | undefined, signal?: AbortSignal): Promise<FrameioShare> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.share;
  const base = settings?.serverUrl?.replace(/\/+$/, '');
  const resolveRedirect =
    !isExtensionPage() && base
      ? async (u: string) => {
          const res = await fetch(`${base}/api/resolve?url=${encodeURIComponent(u)}`, { headers: settings?.serverToken ? { 'x-vyroclipper-token': settings.serverToken } : {}, signal });
          if (!res.ok) throw new Error(`resolve ${res.status}`);
          return ((await res.json()) as { url: string }).url;
        }
      : undefined;
  const share = await resolveFrameioShare(url, (input, init) => fetch(input, { ...init, signal }), { resolveRedirect });
  cache.set(url, { at: Date.now(), share });
  return share;
}
