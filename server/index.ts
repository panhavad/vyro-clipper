// VyroClipper server: static hosting for the client-side studio + optional helper APIs.
// All video processing happens in the browser; the server only serves files, proxies CORS-blocked
// downloads, runs yt-dlp for social links and triggers git-based auto-updates.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { proxyMedia, resolveRedirects } from './proxy.ts';
import { HttpError, envBool, envInt, log } from './util.ts';
import { MediaJobs } from './ytdlp.ts';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = envInt('PORT', 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? join(ROOT, 'dist', 'web'));
const EXTENSION_DIR = resolve(process.env.EXTENSION_DIR ?? join(STATIC_DIR, '..', 'extension'));
const API_TOKEN = process.env.API_TOKEN ?? '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';
const ALLOW_PRIVATE = envBool('ALLOW_PRIVATE_NETWORK', false);
const startedAt = new Date().toISOString();

const jobs = new MediaJobs({
  ytdlp: process.env.YTDLP_PATH ?? 'yt-dlp',
  cacheDir: resolve(process.env.MEDIA_CACHE_DIR ?? join(ROOT, '.cache', 'media')),
  maxConcurrent: envInt('YTDLP_CONCURRENCY', 2),
  maxCacheBytes: envInt('MEDIA_CACHE_MAX_GB', 10) * 1024 ** 3,
  ttlMs: envInt('MEDIA_CACHE_TTL_HOURS', 24) * 3600 * 1000,
  allowPrivate: ALLOW_PRIVATE,
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.tflite': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.wasm', '.svg', '.txt']);
const gzCache = new Map<string, Buffer>();
let gzCacheBytes = 0;

function buildInfo(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(STATIC_DIR, 'build-info.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return { commit: 'unknown' };
  }
}

function setCommonHeaders(res: ServerResponse) {
  // Cross-origin isolation → SharedArrayBuffer for multi-threaded in-browser Whisper.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function setCors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, range, x-vyroclipper-token');
  res.setHeader('Access-Control-Expose-Headers', 'content-length, content-range, content-type, content-disposition, accept-ranges');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!API_TOKEN) return true;
  const given = (req.headers['x-vyroclipper-token'] as string | undefined) ?? url.searchParams.get('token') ?? '';
  return safeEqual(given, API_TOKEN);
}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
  const ext = extname(file).toLowerCase();
  const st = statSync(file);
  const immutable = /[\\/]assets[\\/]/.test(file);
  res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
  res.setHeader('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('last-modified', st.mtime.toUTCString());
  res.setHeader('accept-ranges', 'bytes');
  if (!immutable && req.headers['if-modified-since'] === st.mtime.toUTCString()) {
    res.writeHead(304);
    res.end();
    return;
  }
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [a, b] = range.slice(6).split('-');
    const start = a ? parseInt(a, 10) : Math.max(0, st.size - parseInt(b!, 10));
    const end = a && b ? Math.min(parseInt(b, 10), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && st.size > 1024) {
    const key = `${file}:${st.mtimeMs}`;
    let gz = gzCache.get(key);
    if (!gz) {
      gz = gzipSync(readFileSync(file), { level: 6 });
      if (gzCacheBytes + gz.length < 400 * 1024 * 1024) {
        gzCache.set(key, gz);
        gzCacheBytes += gz.length;
      }
    }
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': gz.length, vary: 'accept-encoding' });
    res.end(req.method === 'HEAD' ? undefined : gz);
    return;
  }
  res.writeHead(200, { 'content-length': st.size });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const decoded = decodeURIComponent(pathname);
  const target = normalize(join(STATIC_DIR, decoded));
  const rel = relative(STATIC_DIR, target);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) throw new HttpError(403, 'Forbidden');
  let file = target;
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    // SPA uses hash routing; unknown non-asset paths fall back to the app shell.
    if (extname(decoded)) throw new HttpError(404, 'Not found');
    file = join(STATIC_DIR, 'index.html');
    if (!existsSync(file)) throw new HttpError(503, 'Studio is not built yet. Run `npm run build`.');
  }
  sendFile(req, res, file);
}

function zipDirectory(dir: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(dir, p).split(sep).join('/')] = readFileSync(p);
    }
  };
  walk(dir);
  return zipSync(files, { level: 6 });
}

function safeEqual(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** GitHub/Gitea/Forgejo: X-Hub-Signature-256 HMAC · GitLab: X-Gitlab-Token · anything else: ?secret= */
function verifyWebhook(req: IncomingMessage, url: URL, body: Buffer): boolean {
  if (!WEBHOOK_SECRET) return false;
  const hub = req.headers['x-hub-signature-256'];
  if (typeof hub === 'string') return safeEqual(hub, `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`);
  const token = (req.headers['x-gitlab-token'] as string | undefined) ?? url.searchParams.get('secret') ?? '';
  return !!token && safeEqual(token, WEBHOOK_SECRET);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname;
  if (path === '/api/health') {
    return json(res, 200, { ok: true, version: buildInfo(), ytdlp: jobs.available, ytdlpVersion: jobs.version, startedAt, supervised: !!process.send });
  }
  if (path === '/api/version') return json(res, 200, { ...buildInfo(), serverStartedAt: startedAt });
  if (path === '/api/hooks/git' && req.method === 'POST') {
    const body = await readBody(req);
    if (!verifyWebhook(req, url, body)) throw new HttpError(401, 'Invalid webhook signature (set WEBHOOK_SECRET)');
    if (!process.send) return json(res, 202, { ok: true, note: 'Server is not supervised; nothing to update.' });
    process.send({ type: 'update-now', reason: 'webhook' });
    return json(res, 202, { ok: true, queued: true });
  }
  if (!authorized(req, url)) throw new HttpError(401, 'Missing or invalid x-vyroclipper-token');
  if (path === '/api/proxy' && (req.method === 'GET' || req.method === 'HEAD')) {
    const target = url.searchParams.get('url');
    if (!target) throw new HttpError(400, 'url parameter required');
    return proxyMedia(req, res, target, ALLOW_PRIVATE);
  }
  if (path === '/api/resolve' && req.method === 'GET') {
    // Follows redirects (e.g. f.io short links) that browsers can't inspect cross-origin.
    const target = url.searchParams.get('url');
    if (!target) throw new HttpError(400, 'url parameter required');
    return json(res, 200, { url: await resolveRedirects(target, ALLOW_PRIVATE) });
  }
  if (path === '/api/media/jobs' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}') as { url?: string };
    if (!body.url) throw new HttpError(400, 'url required');
    const job = await jobs.create(body.url);
    return json(res, 201, { id: job.id, status: job.status });
  }
  const m = /^\/api\/media\/jobs\/([\w-]+)(\/file)?$/.exec(path);
  if (m) {
    const job = jobs.get(m[1]!);
    if (!job) throw new HttpError(404, 'Job not found');
    if (!m[2]) return json(res, 200, { id: job.id, status: job.status, progress: job.progress, message: job.message, error: job.error, size: job.size });
    if (job.status !== 'done' || !job.file) throw new HttpError(409, 'Job not finished');
    res.setHeader('content-disposition', `attachment; filename="source-${job.id.slice(0, 8)}.mp4"`);
    return sendFile(req, res, job.file);
  }
  throw new HttpError(404, 'Unknown API route');
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  setCommonHeaders(res);
  const isApi = url.pathname.startsWith('/api/');
  if (isApi || url.pathname === '/extension.zip') setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  void (async () => {
    try {
      if (isApi) return await handleApi(req, res, url);
      if (url.pathname === '/extension.zip') {
        if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) throw new HttpError(404, 'Extension build not found');
        const zip = zipDirectory(EXTENSION_DIR);
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="vyroclipper-extension.zip"', 'content-length': zip.length, 'cache-control': 'no-store' });
        return void res.end(zip);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log('http', req.method, url.pathname, err);
      if (!res.headersSent) json(res, status, { error: (err as Error).message });
      else res.destroy();
    }
  })();
});

void jobs.detect().then((ok) => log('server', ok ? `yt-dlp ${jobs.version} available` : 'yt-dlp not found (YouTube/TikTok links disabled)'));
server.listen(PORT, HOST, () => log('server', `VyroClipper ${String(buildInfo().shortCommit ?? '')} listening on http://${HOST}:${PORT} (static: ${STATIC_DIR})`));

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('message', (msg: { type?: string }) => {
  if (msg?.type === 'shutdown') shutdown();
});
