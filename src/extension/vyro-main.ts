// Runs in the page's MAIN world on app.vyro.com at document_start (before the Vyro app boots).
// Vyro keeps its Bearer token in memory, so we observe the app's own API traffic:
//  1. capture campaign JSON the app already loads (catalog/campaigns, campaigns, enrollments)
//  2. remember the auth headers so the extension can page through the catalog on request (read-only GETs).
import type { VyroPageMessage } from '../shared/protocol';

(() => {
  const w = window as Window & { __vyroclipperHooked?: boolean };
  if (w.__vyroclipperHooked) return;
  w.__vyroclipperHooked = true;

  const API_HOST = 'api.vyro.com';
  const API = `https://${API_HOST}`;
  const CAPTURE_HEADERS = ['authorization', 'ap-workspace', 'x-realm', 'x-app-context'];
  const CAMPAIGN_PATH = /\/(catalog\/(public\/)?campaigns|campaigns|enrollments)(\/|\?|$)/;
  const headers: Record<string, string> = {};
  const nativeFetch = window.fetch.bind(window);

  const post = (msg: VyroPageMessage) => window.postMessage(msg, location.origin);
  const isApi = (url: string | undefined): boolean => {
    try {
      return !!url && new URL(url, location.href).host === API_HOST;
    } catch {
      return false;
    }
  };

  function captureHeader(name: string, value: string) {
    const n = name.toLowerCase();
    if (!CAPTURE_HEADERS.includes(n) || !value) return;
    const changed = headers[n] !== value;
    headers[n] = value;
    if (n === 'authorization' && changed) post({ __vyroclipper: 'auth', payload: { ready: true } });
  }

  function onApiJson(url: string, json: unknown) {
    try {
      if (!CAMPAIGN_PATH.test(new URL(url).pathname)) return;
      post({ __vyroclipper: 'captured', payload: { url, json } });
    } catch {
      /* ignore */
    }
  }

  // --- XHR (axios uses XHR in browsers)
  type TrackedXhr = XMLHttpRequest & { __vcUrl?: string; __vcMethod?: string };
  const xOpen = XMLHttpRequest.prototype.open;
  const xSend = XMLHttpRequest.prototype.send;
  const xHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (this: TrackedXhr, method: string, url: string | URL, ...rest: unknown[]) {
    this.__vcMethod = String(method).toUpperCase();
    this.__vcUrl = new URL(String(url), location.href).toString();
    return (xOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.setRequestHeader = function (this: TrackedXhr, name: string, value: string) {
    if (isApi(this.__vcUrl)) captureHeader(name, value);
    return xHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (this: TrackedXhr, body?: XMLHttpRequestBodyInit | null) {
    if (isApi(this.__vcUrl) && this.__vcMethod === 'GET') {
      this.addEventListener('load', () => {
        if (this.status < 200 || this.status >= 300) return;
        try {
          const json = this.responseType === 'json' ? this.response : this.responseType === '' || this.responseType === 'text' ? JSON.parse(this.responseText) : undefined;
          if (json) onApiJson(this.__vcUrl!, json);
        } catch {
          /* not JSON */
        }
      });
    }
    return xSend.call(this, body);
  };

  // --- fetch
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const res = await nativeFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (isApi(url)) {
        const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        h.forEach((v, k) => captureHeader(k, v));
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (res.ok && method === 'GET' && /json/.test(res.headers.get('content-type') ?? '')) {
          void res
            .clone()
            .json()
            .then((j) => onApiJson(new URL(url, location.href).toString(), j))
            .catch(() => undefined);
        }
      }
    } catch {
      /* never break the app */
    }
    return res;
  };

  async function apiGet(path: string): Promise<{ status: number; json?: unknown }> {
    const res = await nativeFetch(`${API}${path}`, { headers: { ...headers, accept: 'application/json' }, credentials: 'include' });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  async function fetchAll(): Promise<unknown[]> {
    const all: unknown[] = [];
    let limit = 50;
    for (let page = 1; page <= 40; page++) {
      let r = await apiGet(`/catalog/campaigns?sort=startDate.desc&limit=${limit}&page=${page}`);
      if (r.status === 400 && limit !== 12) {
        limit = 12; // fall back to the page size the Vyro app itself uses
        r = await apiGet(`/catalog/campaigns?sort=startDate.desc&limit=${limit}&page=${page}`);
      }
      if (r.status === 401 || r.status === 403) throw new Error('Vyro session expired — reload app.vyro.com and try again.');
      if (r.status >= 400) throw new Error(`Vyro API error ${r.status}`);
      const body = r.json as { data?: unknown[]; meta?: { page?: { next?: number | null } } } | undefined;
      const items = body?.data ?? (Array.isArray(r.json) ? (r.json as unknown[]) : []);
      all.push(...items);
      if (!body?.meta?.page?.next || !items.length) break;
    }
    return all;
  }

  window.addEventListener('message', (ev: MessageEvent<VyroPageMessage>) => {
    if (ev.source !== window || ev.data?.__vyroclipper !== 'fetch-request') return;
    const { id, kind, slug } = ev.data;
    void (async () => {
      try {
        if (!headers.authorization) throw new Error('Not signed in yet — log in to app.vyro.com (or open the Campaigns page) and retry.');
        let payload: unknown;
        if (kind === 'slug' && slug) {
          const r = await apiGet(`/catalog/campaigns/slug/${encodeURIComponent(slug)}`);
          if (r.status >= 400) throw new Error(`Vyro API error ${r.status}`);
          payload = { data: [r.json] };
        } else {
          payload = { data: await fetchAll() };
        }
        post({ __vyroclipper: 'fetch-result', id, payload });
      } catch (err) {
        post({ __vyroclipper: 'fetch-result', id, error: (err as Error).message });
      }
    })();
  });
})();
