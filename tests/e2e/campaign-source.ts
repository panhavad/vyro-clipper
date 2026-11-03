/// <reference lib="dom" />
// Real-campaign end-to-end test against a running studio (e.g. the Docker deployment):
// import a Vyro API JSON → open the campaign → browse its Frame.io "Content to Use" → clip the smallest video
// → wait for viral clips → export one → validate the MP4 against the campaign's minimum length.
//
// Usage: E2E_CAMPAIGN_JSON=catalog.json E2E_CAMPAIGN="Joy 101" STUDIO_URL=http://127.0.0.1:8090 node tests/e2e/campaign-source.ts
// Optional: E2E_EXPECT_BURNED_IN=1|0 asserts whether the clipped source already has burned-in captions;
// E2E_FILE="Harry Connick" clips a specific file instead of the smallest one.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { chromium, type Download } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const ART = join(ROOT, 'tests', 'e2e', '.artifacts');
const JSON_PATH = process.env.E2E_CAMPAIGN_JSON ?? '';
const CAMPAIGN = process.env.E2E_CAMPAIGN ?? '';
const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:8090';
const CHROME = process.env.CHROME_PATH ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p));
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[live ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
const mb = (s: string) => {
  const m = /([\d.]+)\s*(GB|MB|KB)/.exec(s);
  return m ? parseFloat(m[1]!) * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1) : Infinity;
};

async function main() {
  assert(existsSync(JSON_PATH), 'Set E2E_CAMPAIGN_JSON to a Vyro API response file');
  assert(CHROME, 'Chrome not found');
  mkdirSync(ART, { recursive: true });
  const payload = readFileSync(JSON_PATH, 'utf8');
  // E2E_PERSISTENT=1 uses a normal on-disk profile (incognito-like contexts cap site storage at ~1 GB).
  const profileDir = process.env.E2E_PERSISTENT ? mkdtempSync(join(tmpdir(), 'vc-e2e-')) : undefined;
  const browser = profileDir ? undefined : await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED, args: ['--enable-unsafe-webgpu'] });
  const context = profileDir
    ? await chromium.launchPersistentContext(profileDir, { executablePath: CHROME, headless: !process.env.HEADED, args: ['--enable-unsafe-webgpu'], acceptDownloads: true, viewport: { width: 1500, height: 1100 } })
    : await browser!.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1100 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(STUDIO);
    await page.getByRole('heading', { name: 'Campaigns', exact: true }).waitFor();
    log('studio', STUDIO, await page.evaluate(() => fetch('./build-info.json').then((r) => r.json()).then((j: { shortCommit: string }) => j.shortCommit)));
    await page.locator('.nav-item', { hasText: 'Settings' }).click();
    await page.locator('select').first().selectOption(process.env.E2E_MODEL ?? 'onnx-community/whisper-tiny.en_timestamped');
    await page.locator('.nav-item', { hasText: 'Campaigns' }).click();
    await page.getByRole('button', { name: '+ Add campaign' }).first().click();
    await page.getByRole('button', { name: 'Paste Vyro JSON' }).click();
    await page.locator('.modal textarea').fill(payload);
    await page.locator('.modal').getByRole('button', { name: 'Import' }).click();
    const card = page.locator('.campaign-card', { hasText: CAMPAIGN }).first();
    await card.waitFor();
    log('campaigns imported:', await page.locator('.campaign-card').count());
    await card.locator('.campaign-name').click();
    await page.getByRole('button', { name: /Source videos/ }).click();
    await page.getByRole('button', { name: '📂 Browse files' }).first().click();
    await page.locator('.share-file').first().waitFor({ timeout: 60000 });
    const files = await page.locator('.share-file').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    log('Frame.io files:', files.map((f) => f.replace(/\s+/g, ' ').slice(0, 90)));
    let best = 0;
    files.forEach((f, i) => {
      if (mb(f) < mb(files[best]!)) best = i;
    });
    if (process.env.E2E_FILE) best = files.findIndex((f) => f.includes(process.env.E2E_FILE!));
    assert(best >= 0, `file containing “${process.env.E2E_FILE}” is listed`);
    await page.locator('.share-file').nth(best).getByRole('button', { name: '✂ Clip this' }).click();
    log('clipping:', files[best]!.replace(/\s+/g, ' ').slice(0, 90));
    await page.getByRole('button', { name: /^Clips/ }).click();
    let last = '';
    const deadline = Date.now() + Number(process.env.E2E_TIMEOUT_MIN ?? 30) * 60 * 1000;
    for (;;) {
      if (Date.now() > deadline) throw new Error('timeout');
      const err = await page.locator('.project .callout.error').first().textContent({ timeout: 300 }).catch(() => null);
      if (err) throw new Error(`Pipeline error: ${err}`);
      const prog = await page.locator('.project .progress-text').first().textContent({ timeout: 300 }).catch(() => null);
      const cards = await page.locator('.clip-card').count();
      const s = prog?.replace(/\s+/g, ' ') ?? `${cards} clips`;
      if (s !== last) {
        log(s);
        last = s;
      }
      if (!prog && cards > 0) break;
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(5000);
    await page.screenshot({ path: join(ART, 'live-01-clips.png'), fullPage: true });
    const titles = await page.locator('.clip-card .clip-title').allInnerTexts();
    const scores = await page.locator('.clip-card .clip-score .score-ring span').allInnerTexts();
    const chips = await page.locator('.clip-card .chips').allInnerTexts();
    titles.forEach((t, i) => log(`#${i + 1} ${scores[i]} — ${t} | ${chips[i]?.replace(/\s+/g, ' ')}`));
    const minLen = Number(/≥ (\d+)s/.exec(await page.locator('.chips').first().innerText())?.[1] ?? 0);
    const burnedIn = await page.evaluate(() => {
      type S = { projects: Array<{ textScan?: { captions: boolean; bands: Array<{ kind: string; y0: number; y1: number }> }; clips: Array<{ hook: string; edit: { captionsEnabled: boolean } }> }> };
      const p = (window as unknown as { __vyroclipper: { getState: () => S } }).__vyroclipper.getState().projects[0]!;
      return {
        captions: p.textScan?.captions,
        bands: p.textScan?.bands.map((b) => `${b.kind} ${b.y0.toFixed(2)}–${b.y1.toFixed(2)}`),
        ourCaptions: p.clips.map((c) => c.edit.captionsEnabled),
        hooks: p.clips.map((c) => c.hook),
      };
    });
    log('burned-in text:', burnedIn);
    if (process.env.E2E_EXPECT_BURNED_IN) {
      const expected = process.env.E2E_EXPECT_BURNED_IN === '1';
      assert(burnedIn.captions === expected, `burned-in captions detected = ${expected}`);
      assert(burnedIn.ourCaptions.every((on) => on === !expected), 'animated captions follow the source (off over burned-in captions)');
    }
    if (process.env.E2E_EVICT) {
      // Simulate the browser evicting the stored source: export must download it again by itself.
      const removed = await page.evaluate(async () => {
        type S = { projects: Array<{ source: { storedAs?: string } }> };
        const name = (window as unknown as { __vyroclipper: { getState: () => S } }).__vyroclipper.getState().projects[0]!.source.storedAs!;
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('media');
        await dir.removeEntry(name);
        return name;
      });
      log('evicted source from browser storage:', removed);
    }

    await page.locator('.clip-card').first().getByRole('button', { name: 'Edit' }).click();
    await page.locator('.player-stage canvas').waitFor();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(ART, 'live-02-editor.png') });
    if (process.env.E2E_EVICT) log('player overlay:', (await page.locator('.player-loading').textContent({ timeout: 1000 }).catch(() => null))?.replace(/\s+/g, ' '));
    await page.getByRole('button', { name: /^Checks/ }).click();
    log('checks:', (await page.locator('.checks li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')));
    const downloads: Download[] = [];
    page.on('download', (d) => downloads.push(d));
    await page.getByRole('button', { name: '⬇ Export MP4' }).click();
    for (let i = 0; i < 300 && !downloads.some((d) => d.suggestedFilename().endsWith('.mp4')); i++) await page.waitForTimeout(2000);
    await page.waitForTimeout(2000);
    const mp4 = downloads.find((d) => d.suggestedFilename().endsWith('.mp4'));
    assert(mp4, 'mp4 exported');
    const out = join(ART, `live-${mp4.suggestedFilename()}`);
    await mp4.saveAs(out);
    for (const d of downloads) if (d !== mp4) await d.saveAs(join(ART, `live-${d.suggestedFilename()}`));
    const input = new Input({ source: new BufferSource(readFileSync(out)), formats: ALL_FORMATS });
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();
    log('mp4:', { file: mp4.suggestedFilename(), duration, w: v?.displayWidth, h: v?.displayHeight, codec: v?.codec, audio: a?.codec });
    assert(v?.displayWidth === 1080 && v.displayHeight === 1920, '1080x1920');
    assert(duration >= minLen, `respects campaign minimum (${minLen}s)`);
    log('page errors:', errors.slice(0, 5));
    log('PASS');
  } catch (err) {
    log('FAIL', err, errors.slice(0, 5));
    await page.screenshot({ path: join(ART, 'live-failure.png'), fullPage: true }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser?.close();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  }
}

await main();
