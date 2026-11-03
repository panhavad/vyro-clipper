/// <reference lib="dom" />
// End-to-end test in real Chrome: import a Vyro campaign → add source video → transcribe (in-browser Whisper)
// → viral clip detection → face-tracked reframe → editor preview → MP4 export → validate output.
//
// Usage: node tests/e2e/run.ts            (CHROME_PATH, E2E_VIDEO, HEADED=1 optional)
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { chromium, type Download, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const ART = join(ROOT, 'tests', 'e2e', '.artifacts');
const VIDEO = resolve(process.env.E2E_VIDEO ?? join(ART, 'nasa-interview.mp4'));
const PORT = Number(process.env.E2E_PORT ?? 8123);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME =
  process.env.CHROME_PATH ??
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => existsSync(p));
const MODEL = process.env.E2E_MODEL ?? 'onnx-community/whisper-tiny.en_timestamped';

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[e2e ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const CAMPAIGN = {
  id: 'e2e-artemis',
  slug: 'artemis-clips',
  name: 'E2E – Artemis astronaut clips',
  type: 'clipping',
  displayOption: { workspaceName: 'NASA (test)' },
  headlineRate: 1.25,
  payoutModel: { model: 'cpm', payRate: 1.25 },
  budget: { value: 5000, spent: 1200 },
  targeting: { languages: ['en'], platforms: ['tiktok', 'instagram', 'youtube'] },
  requirements: {
    brief: '<p>Clip the most inspiring moments about the <b>Moon</b>, <b>Artemis</b> and exploration.</p><ul><li>Clips must be at least 20 seconds.</li><li>Do not add music.</li></ul>',
    text: { caption: 'Humanity is going back to the Moon', hashtags: ['Artemis', 'NASA'], textOnScreen: 'Artemis: back to the Moon', ftcDisclosureHashtags: ['#ad'] },
    subtitles: { required: true },
    video: { minLength: 20 },
    collaboration: { allowCollabAndTagging: true },
  },
  media: { links: [], notes: 'Use the interview soundbites' },
};

async function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

async function waitForClips(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const progress = await page.locator('.project .progress-text').first().textContent({ timeout: 500 }).catch(() => null);
    const error = await page.locator('.project .callout.error').first().textContent({ timeout: 200 }).catch(() => null);
    if (error) throw new Error(`Pipeline error: ${error}`);
    const cards = await page.locator('.clip-card').count();
    const status = progress?.replace(/\s+/g, ' ').trim() ?? `${cards} clip cards`;
    if (status !== last) {
      log(status);
      last = status;
    }
    if (!progress && cards > 0) return cards;
    await page.waitForTimeout(1500);
  }
  throw new Error('Timed out waiting for clips');
}

async function canvasStats(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector('.player-stage canvas') as HTMLCanvasElement | null;
    if (!c) return null;
    const ctx = c.getContext('2d')!;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    let yellow = 0;
    for (let i = 0; i < d.length; i += 16) {
      if (d[i]! + d[i + 1]! + d[i + 2]! > 60) lit++;
      if (d[i]! > 200 && d[i + 1]! > 180 && d[i + 2]! < 90) yellow++;
    }
    return { w: c.width, h: c.height, litRatio: lit / (d.length / 16), yellowRatio: yellow / (d.length / 16) };
  });
}

async function validateMp4(file: string) {
  const input = new Input({ source: new BufferSource(readFileSync(file)), formats: ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  const info = {
    duration: await input.computeDuration(),
    video: v ? { codec: v.codec, width: v.displayWidth, height: v.displayHeight, fps: (await v.computePacketStats(200)).averagePacketRate } : null,
    audio: a ? { codec: a.codec, sampleRate: a.sampleRate, channels: a.numberOfChannels } : null,
  };
  input.dispose();
  return info;
}

async function main() {
  assert(CHROME, 'Chrome not found; set CHROME_PATH');
  assert(existsSync(VIDEO), `Test video missing: ${VIDEO}`);
  assert(existsSync(join(ROOT, 'dist', 'web', 'index.html')), 'Run `npm run build` first');
  mkdirSync(ART, { recursive: true });
  const server = await startServer();
  log('server up', BASE);
  const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED, args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1100 } });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const results: Record<string, unknown> = {};
  try {
    await page.goto(BASE);
    await page.getByRole('heading', { name: 'Campaigns', exact: true }).waitFor({ timeout: 30000 });
    results.crossOriginIsolated = await page.evaluate(() => crossOriginIsolated);
    results.webgpu = await page.evaluate(async () => !!(navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu && !!(await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter()));
    log('studio loaded', results);

    // Faster speech model for tests.
    await page.locator('.nav-item', { hasText: 'Settings' }).click();
    await page.locator('select').first().selectOption(MODEL);
    log('model →', MODEL);

    // Import a Vyro-shaped campaign through the JSON importer (exercises the normaliser in-browser).
    await page.locator('.nav-item', { hasText: 'Campaigns' }).click();
    await page.getByRole('button', { name: '+ Add campaign' }).first().click();
    await page.getByRole('button', { name: 'Paste Vyro JSON' }).click();
    await page.locator('.modal textarea').fill(JSON.stringify({ data: [CAMPAIGN], meta: { page: { next: null } } }));
    await page.locator('.modal').getByRole('button', { name: 'Import' }).click();
    await page.locator('.campaign-card', { hasText: CAMPAIGN.name }).waitFor();
    log('campaign imported');
    await page.locator('.campaign-card', { hasText: CAMPAIGN.name }).locator('.campaign-name').click();
    await page.getByRole('heading', { name: CAMPAIGN.name, exact: true }).waitFor();
    const chips = await page.locator('.chips').first().innerText();
    log('rule chips:', chips.replace(/\s+/g, ' '));
    assert(/≥ 20s/.test(chips) && /Subtitles/.test(chips) && /Text on screen/.test(chips), 'campaign rule chips');

    await page.getByRole('button', { name: /Source videos/ }).click();
    await page.locator('.dropzone input[type=file]').setInputFiles(VIDEO);
    log('video added:', VIDEO);
    await page.getByRole('button', { name: /^Clips/ }).click();

    const cards = await waitForClips(page, 25 * 60 * 1000);
    results.clipCount = cards;
    log(`clips ready: ${cards}`);
    // Background work (reframe / thumbnails) must not clobber edits; log any job still running.
    const jobsAfter = await page.evaluate(() => {
      const s = (window as unknown as { __vyroclipper: { getState(): { jobs: Record<string, { label: string; kind: string }>; projects: Array<{ status: string }> } } }).__vyroclipper.getState();
      return { jobs: Object.values(s.jobs).map((j) => `${j.kind}: ${j.label}`), status: s.projects.map((p) => p.status) };
    });
    log('jobs after clips ready:', jobsAfter);
    await page.waitForTimeout(4000); // let thumbnails render
    await page.screenshot({ path: join(ART, '01-clip-grid.png'), fullPage: true });
    const scores = await page.locator('.clip-card .clip-score .score-ring span').allInnerTexts();
    const titles = await page.locator('.clip-card .clip-title').allInnerTexts();
    const compliance = await page.locator('.clip-card .chips').allInnerTexts();
    results.clips = titles.map((t, i) => ({ title: t, score: Number(scores[i]), compliance: compliance[i]?.replace(/\s+/g, ' ') }));
    log('clips:', JSON.stringify(results.clips, null, 1));
    assert(cards >= 2, 'at least two clips');
    assert(scores.every((s) => Number(s) >= 1 && Number(s) <= 99), 'scores within 1..99');
    assert(compliance.some((c) => /Campaign rules/.test(c)), 'at least one clip passes campaign rules');
    const textScan = await page.evaluate(() => {
      type S = { projects: Array<{ textScan?: { captions: boolean; frames: number }; clips: Array<{ edit: { captionsEnabled: boolean } }> }> };
      const p = (window as unknown as { __vyroclipper: { getState(): S } }).__vyroclipper.getState().projects[0]!;
      return { scanned: p.textScan?.frames ?? 0, burnedIn: p.textScan?.captions, ourCaptions: p.clips.every((c) => c.edit.captionsEnabled) };
    });
    log('burned-in text scan:', textScan);
    assert(textScan.scanned > 0 && textScan.burnedIn === false && textScan.ourCaptions, 'caption-free source keeps animated captions');

    // Editor
    await page.locator('.clip-card').first().getByRole('button', { name: 'Edit' }).click();
    await page.locator('.player-stage canvas').waitFor();
    await page.waitForTimeout(2500);
    results.previewBefore = await canvasStats(page);
    await page.screenshot({ path: join(ART, '02-editor.png') });
    log('preview canvas:', results.previewBefore);
    assert((results.previewBefore as { litRatio: number }).litRatio > 0.05, 'preview renders video pixels');
    // Play a little to exercise the playback loop.
    await page.locator('.player-controls .icon-btn').first().click();
    await page.waitForTimeout(3000);
    await page.locator('.player-controls .icon-btn').first().click();
    await page.locator('.magic input').fill('use beast style, captions bigger, zoom more, title: Back to the Moon');
    await page.locator('.magic input').press('Enter');
    await page.waitForTimeout(1500);
    results.titleAfterCommand = await page.locator('.title-input').inputValue();
    assert(results.titleAfterCommand === 'Back to the Moon', 'magic command updated title');
    await page.screenshot({ path: join(ART, '03-editor-after-command.png') });
    await page.getByRole('button', { name: /^Checks/ }).click();
    results.checks = (await page.locator('.checks li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
    log('checks:', results.checks);

    // Export
    const downloads: Download[] = [];
    page.on('download', (d) => downloads.push(d));
    const exportStart = Date.now();
    await page.getByRole('button', { name: '⬇ Export MP4' }).click();
    const deadline = Date.now() + 10 * 60 * 1000;
    while (!downloads.some((d) => d.suggestedFilename().endsWith('.mp4')) && Date.now() < deadline) {
      const p = await page.locator('.progress-text').first().textContent({ timeout: 300 }).catch(() => null);
      if (p) log('export:', p.replace(/\s+/g, ' '));
      await page.waitForTimeout(3000);
    }
    await page.waitForTimeout(2000);
    results.exportSeconds = Math.round((Date.now() - exportStart) / 1000);
    const saved: string[] = [];
    for (const d of downloads) {
      const target = join(ART, `export-${d.suggestedFilename()}`);
      await d.saveAs(target);
      saved.push(target);
    }
    results.downloads = downloads.map((d) => d.suggestedFilename());
    log('downloads:', results.downloads);
    const mp4 = saved.find((f) => f.endsWith('.mp4'));
    assert(mp4, 'mp4 exported');
    results.mp4 = await validateMp4(mp4);
    log('mp4:', results.mp4);
    const m = results.mp4 as Awaited<ReturnType<typeof validateMp4>>;
    assert(m.video && m.video.width === 1080 && m.video.height === 1920, '1080x1920 output');
    assert(m.audio, 'output has audio');
    assert(m.duration >= 20, 'respects campaign minimum length');
    const txt = saved.find((f) => f.endsWith('.txt'));
    if (txt) {
      const body = readFileSync(txt, 'utf8');
      assert(body.includes('#Artemis') && body.includes('#ad') && body.includes('Humanity is going back to the Moon'), 'caption file contains required caption + hashtags');
    }
    results.consoleErrors = consoleErrors.slice(0, 20);
    log('PASS');
  } catch (err) {
    results.error = (err as Error).message;
    results.consoleErrors = consoleErrors.slice(0, 30);
    await page.screenshot({ path: join(ART, 'failure.png'), fullPage: true }).catch(() => undefined);
    log('FAIL', err);
    process.exitCode = 1;
  } finally {
    writeFileSync(join(ART, 'e2e-results.json'), JSON.stringify(results, null, 2));
    await browser.close();
    server.kill();
  }
}

await main();
