import type { AppSettings } from '../shared/settings';
import { isExtensionPage } from '../shared/env';

const cache = new Map<string, Promise<ImageBitmap | undefined>>();

/**
 * Loads an image as an ImageBitmap via fetch (CORS) so canvases never get tainted:
 * a tainted canvas would make WebCodecs frame capture fail. Falls back to the server proxy.
 */
export function loadImageBitmap(url: string, settings?: AppSettings): Promise<ImageBitmap | undefined> {
  if (!url) return Promise.resolve(undefined);
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      const tryUrl = async (u: string, headers?: HeadersInit) => {
        try {
          const res = await fetch(u, { credentials: 'omit', headers });
          if (!res.ok) return undefined;
          return await createImageBitmap(await res.blob());
        } catch {
          return undefined;
        }
      };
      let bmp = await tryUrl(url);
      if (!bmp && settings && !isExtensionPage() && /^https?:/.test(url)) {
        bmp = await tryUrl(`${settings.serverUrl.replace(/\/+$/, '')}/api/proxy?url=${encodeURIComponent(url)}`, settings.serverToken ? { 'x-vyroclipper-token': settings.serverToken } : undefined);
      }
      return bmp;
    })();
    cache.set(url, p);
  }
  return p;
}
