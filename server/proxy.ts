import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { HttpError, assertPublicUrl } from './util.ts';

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'last-modified', 'etag'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 VyroClipper';

/** fetch() that reports unreachable upstreams (DNS, refused, TLS…) as 502 instead of an internal error. */
async function upstreamFetch(url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    const code = (err as { cause?: { code?: string } }).cause?.code;
    throw new HttpError(502, `Upstream unreachable${code ? ` (${code})` : ''}`);
  }
}

/** Returns the final URL after following redirects (each hop re-validated against private networks). */
export async function resolveRedirects(target: string, allowPrivate: boolean): Promise<string> {
  let url = await assertPublicUrl(target, allowPrivate);
  for (let hop = 0; hop < 8; hop++) {
    const res = await upstreamFetch(url, { method: 'GET', headers: { 'user-agent': UA }, redirect: 'manual' });
    await res.body?.cancel();
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return url.toString();
    url = await assertPublicUrl(new URL(location, url).toString(), allowPrivate);
  }
  return url.toString();
}

/**
 * Streaming media proxy for hosts that block cross-origin downloads (Drive, Dropbox, CDNs).
 * Every redirect hop is re-validated against private networks. Range requests are passed through.
 */
export async function proxyMedia(req: IncomingMessage, res: ServerResponse, target: string, allowPrivate: boolean): Promise<void> {
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  let url = await assertPublicUrl(target, allowPrivate);
  let upstream: Response | undefined;
  for (let hop = 0; hop < 6; hop++) {
    const headers: Record<string, string> = { 'user-agent': UA, accept: '*/*' };
    if (typeof req.headers.range === 'string') headers.range = req.headers.range;
    upstream = await upstreamFetch(url, { headers, redirect: 'manual', signal: controller.signal });
    const location = upstream.headers.get('location');
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      url = await assertPublicUrl(new URL(location, url).toString(), allowPrivate);
      continue;
    }
    break;
  }
  if (!upstream) throw new HttpError(502, 'No response');
  if (upstream.status >= 400) throw new HttpError(upstream.status === 404 ? 404 : 502, `Upstream responded ${upstream.status}`);
  const out: Record<string, string> = {};
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve) => {
    const body = Readable.fromWeb(upstream!.body as unknown as WebReadableStream<Uint8Array>);
    body.on('error', () => {
      res.destroy();
      resolve();
    });
    res.on('close', () => {
      body.destroy();
      resolve();
    });
    body.pipe(res);
  });
}
