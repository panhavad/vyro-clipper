/// <reference lib="dom" />
/// <reference types="chrome" />
// Extension end-to-end test with a mocked app.vyro.com (same API shapes/auth behaviour as the real site):
//  1. MAIN-world hook captures campaigns the app loads → stored by the background worker
//  2. overlay "Sync all" pages through the catalog API with the captured Bearer token
//  3. "Clip this campaign" on ?c=<slug> opens the bundled studio with the campaign selected
//  4. the hosted studio (Docker server) detects the extension through the bridge
//
// Usage: node tests/e2e/extension.ts   (STUDIO_URL=http://127.0.0.1:8090 to also test the hosted bridge)
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Route } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const ART = join(ROOT, 'tests', 'e2e', '.artifacts');
const EXT = resolve(process.env.EXTENSION_DIR ?? join(ROOT, 'dist', 'extension'));
const STUDIO_URL = process.env.STUDIO_URL ?? '';
const TOKEN = 'Bearer test-token-123';
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[ext ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const campaign = (n: number) => ({
  id: `66aa00000000000000000${n}`,
  slug: `mock-campaign-${n}`,
  name: `Mock Campaign ${n}${n === 1 ? ' <img src=x onerror=alert(1)>' : ''}`,
  type: 'clipping',
  workspace: { name: `Brand ${n}` },
  headlineRate: 1 + n / 10,
  payoutModel: { model: 'cpm', payRate: 1 + n / 10 },
  budget: { value: 10000, spent: 1000 * n },
  startDate: '2026-10-01T00:00:00.000Z',
  targeting: { languages: ['en'], platforms: ['tiktok', 'youtube'] },
  requirements: {
    brief: `<p>Brief for campaign ${n}. Clips must be at least 30 seconds.</p>`,
    text: { hashtags: [`Mock${n}`], ftcDisclosureHashtags: ['#ad'] },
    video: { minLength: 30 },
    subtitles: { required: n % 2 === 0 },
  },
  media: { links: [{ url: `https://cdn.example.com/source-${n}.mp4` }] },
});
const ALL = Array.from({ length: 15 }, (_, i) => campaign(i + 1));

// Minimal stand-in for the Vyro SPA: axios-style XHR with a Bearer token, campaign modal via ?c=slug.
const APP_HTML = `<!doctype html><html><head><title>Vyro</title></head><body><div id="root">Vyro mock</div>
<script>
  function get(path) {
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('GET', 'https://api.vyro.com' + path);
      x.setRequestHeader('Authorization', '${TOKEN}');
      x.setRequestHeader('x-realm', 'vyro-app');
      x.onload = () => resolve(JSON.parse(x.responseText));
      x.send();
    });
  }
  get('/catalog/campaigns?sort=startDate.desc&limit=12&page=1').then((j) => (document.getElementById('root').textContent = 'loaded ' + j.data.length));
</script></body></html>`;

async function mockVyro(context: BrowserContext) {
  await context.route('https://app.vyro.com/**', (route: Route) => route.fulfill({ status: 200, contentType: 'text/html', body: APP_HTML }));
  await context.route('https://api.vyro.com/**', (route: Route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': 'https://app.vyro.com', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'authorization, x-realm, ap-workspace, x-app-context, accept' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (req.headers().authorization !== TOKEN) return route.fulfill({ status: 401, headers: cors, contentType: 'application/json', body: '{"message":"Unauthorized"}' });
    const url = new URL(req.url());
    const slug = /\/catalog\/campaigns\/slug\/([^/]+)/.exec(url.pathname)?.[1];
    if (slug) {
      const c = ALL.find((x) => x.slug === slug);
      return route.fulfill({ status: c ? 200 : 404, headers: cors, contentType: 'application/json', body: JSON.stringify(c ?? { message: 'not found' }) });
    }
    if (url.pathname === '/catalog/campaigns') {
      const limit = Number(url.searchParams.get('limit') ?? 12);
      const page = Number(url.searchParams.get('page') ?? 1);
      const data = ALL.slice((page - 1) * limit, page * limit);
      const next = page * limit < ALL.length ? page + 1 : null;
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ data, meta: { page: { current: page, next } } }) });
    }
    return route.fulfill({ status: 404, headers: cors, body: '{}' });
  });
}

async function extensionState(page: Page) {
  return page.evaluate(() => chrome.runtime.sendMessage({ type: 'vc:get-state' })) as Promise<{ campaigns: Array<{ id: string; name: string; rules: { minDurationSec?: number } }>; selected: string[] }>;
}

async function main() {
  assert(existsSync(join(EXT, 'manifest.json')), `Extension not built at ${EXT}`);
  mkdirSync(ART, { recursive: true });
  // Branded Chrome ignores --load-extension (Chrome 137+); Playwright's Chromium build supports it.
  const userDataDir = mkdtempSync(join(tmpdir(), 'vc-ext-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: { width: 1400, height: 1000 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  const extId = new URL(sw.url()).host;
  log('extension loaded', extId);
  await mockVyro(context);
  for (const p of context.pages()) if (p.url() === 'about:blank') await p.close().catch(() => undefined);
  let failed = false;
  try {
    // 1) Passive capture from the app's own API call
    const vyro = await context.newPage();
    const dialogs: string[] = [];
    vyro.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await vyro.goto('https://app.vyro.com/campaigns');
    await vyro.getByText('loaded 12').waitFor({ timeout: 15000 });
    const overlay = vyro.locator('#vyroclipper-overlay');
    await overlay.waitFor({ state: 'attached', timeout: 10000 });
    await vyro.waitForTimeout(800);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    let st = await extensionState(popup);
    log('captured passively:', st.campaigns.length);
    assert(st.campaigns.length === 12, 'MAIN-world hook captured the 12 campaigns the app loaded');
    assert(st.campaigns.every((c) => c.rules.minDurationSec === 30), 'rules normalised');

    // 2) Sync all via the overlay (paginates with the captured token; limit=50 → one page of 15)
    const overlayText = await overlay.evaluate((el) => el.shadowRoot?.textContent ?? '');
    assert(/Session ready/.test(overlayText), 'overlay shows session ready');
    await overlay.evaluate((el) => (el.shadowRoot!.getElementById('sync') as HTMLButtonElement).click());
    for (let i = 0; i < 30 && (await extensionState(popup)).campaigns.length < 15; i++) await popup.waitForTimeout(300);
    st = await extensionState(popup);
    log('after Sync all:', st.campaigns.length);
    assert(st.campaigns.length === 15, 'Sync all fetched every catalog page');
    assert(dialogs.length === 0, 'campaign names are escaped (no XSS dialog)');

    // Popup UI lists campaigns
    await popup.reload();
    await popup.locator('.item').first().waitFor();
    const items = await popup.locator('.item').count();
    log('popup items:', items);
    assert(items === 15, 'popup lists all campaigns');
    await popup.screenshot({ path: join(ART, 'ext-popup.png') });

    // 3) "Clip this campaign" on a campaign page opens the studio with it selected
    await vyro.goto('https://app.vyro.com/campaigns?c=mock-campaign-3');
    await vyro.waitForTimeout(1500);
    const studioPromise = context.waitForEvent('page', { predicate: (p) => p.url().includes('studio.html'), timeout: 15000 });
    await overlay.evaluate((el) => (el.shadowRoot!.getElementById('clip') as HTMLButtonElement).click());
    const studio = await studioPromise;
    await studio.getByRole('heading', { name: 'Mock Campaign 3', exact: true }).waitFor({ timeout: 20000 });
    log('studio opened on campaign:', studio.url());
    st = await extensionState(popup);
    assert(st.selected.includes(campaign(3).id), 'campaign selected in extension');
    const chips = await studio.locator('.chips').first().innerText();
    assert(/≥ 30s/.test(chips), 'studio shows campaign rules');
    await studio.screenshot({ path: join(ART, 'ext-studio.png') });

    // 4) Hosted studio bridge
    if (STUDIO_URL) {
      const hosted = await context.newPage();
      await hosted.goto(STUDIO_URL);
      await hosted.locator('.ext-status.on').waitFor({ timeout: 15000 });
      await hosted.locator('.campaign-card', { hasText: 'Mock Campaign 7' }).waitFor({ timeout: 15000 });
      const cards = await hosted.locator('.campaign-card').count();
      log('hosted studio sees extension; campaign cards:', cards);
      assert(cards >= 15, 'hosted studio pulled campaigns through the bridge');
      await hosted.screenshot({ path: join(ART, 'ext-hosted-studio.png') });
    }
    log('PASS');
  } catch (err) {
    failed = true;
    log('FAIL', err);
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
    if (failed) process.exitCode = 1;
  }
}

await main();
