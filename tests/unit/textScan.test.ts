import { describe, expect, it } from 'vitest';
import { analyzeTextFrames, editForSource, frameTextBands, placeAvoiding, textMask, type GrayFrame, type TextScan } from '../../src/core/textScan';
import { bandsInOutput } from '../../src/engine/compositor';

const W = 540;
const H = 960;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** Smooth, text-free background (never bright enough to look like a text stroke). */
function background(seed: number): Uint8Array {
  const r = rng(seed);
  const d = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = 75 + Math.round(35 * Math.sin(x / 90 + seed) + 25 * Math.cos(y / 140)) + Math.floor(r() * 8);
  return d;
}

function fillRect(d: Uint8Array, x: number, y: number, w: number, h: number, v: number) {
  for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) d[yy * W + xx] = v;
}

/** Outlined white "text": letters made of 1–3 vertical strokes, words separated by gaps. */
function drawText(d: Uint8Array, cx: number, cy: number, letterH: number, letters: number, seed: number) {
  const r = rng(seed);
  const strokes: number[] = [];
  let x = 0;
  for (let i = 0; i < letters; i++) {
    if (i > 0 && r() < 0.2) x += Math.round(letterH * 0.4);
    const n = 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      strokes.push(x);
      x += 7 + Math.floor(r() * 4);
    }
    x += 5;
  }
  const x0 = Math.round(cx * W - x / 2);
  const y0 = Math.round(cy * H - letterH / 2);
  for (const sx of strokes) fillRect(d, x0 + sx - 2, y0 - 2, 7, letterH + 4, 12);
  for (const sx of strokes) fillRect(d, x0 + sx, y0, 3, letterH, 245);
}

/** Dark fingers in front of a white shirt: text-like stripes that move between frames. */
function drawHand(d: Uint8Array, cx: number, cy: number) {
  const x0 = Math.round(cx * W - 100);
  const y0 = Math.round(cy * H - 45);
  fillRect(d, x0 - 20, y0 - 20, 240, 130, 225);
  for (let f = 0; f < 6; f++) fillRect(d, x0 + f * 34, y0, 16, 90, 45);
}

const frame = (data: Uint8Array): GrayFrame => ({ width: W, height: H, data });

describe('burned-in text detection', () => {
  it('marks outlined text strokes and finds the text band', () => {
    const d = background(1);
    drawText(d, 0.5, 0.8, 30, 14, 7);
    const mask = textMask(frame(d));
    const bands = frameTextBands(mask, W, H);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.y0 / H).toBeGreaterThan(0.77);
    expect(bands[0]!.y1 / H).toBeLessThan(0.83);
    expect(frameTextBands(textMask(frame(background(2))), W, H)).toHaveLength(0);
  });

  it('detects captions (changing text at a fixed height) and a static logo', () => {
    const frames: GrayFrame[] = [];
    for (let i = 0; i < 24; i++) {
      const d = background(i);
      if (i % 5 !== 4) drawText(d, 0.5, 0.78, 30, 10 + (i % 4), 100 + i);
      drawText(d, 0.8, 0.06, 22, 6, 42);
      frames.push(frame(d));
    }
    const scan = analyzeTextFrames(frames, { pairs: frames });
    expect(scan.captions).toBe(true);
    const caps = scan.bands.find((b) => b.kind === 'captions')!;
    expect(caps.y0).toBeGreaterThan(0.75);
    expect(caps.y1).toBeLessThan(0.81);
    expect(caps.presence).toBeCloseTo(0.79, 1);
    const logo = scan.bands.find((b) => b.kind === 'static')!;
    expect(logo.y1).toBeLessThan(0.1);
    expect(logo.x0).toBeGreaterThan(0.6);
  });

  it('does not mistake moving hands or occasional screenshots for captions', () => {
    const r = rng(9);
    const frames: GrayFrame[] = [];
    const pairs: GrayFrame[] = [];
    for (let i = 0; i < 24; i++) {
      const cy = 0.62 + (r() - 0.5) * 0.1;
      const cx = 0.5 + (r() - 0.5) * 0.1;
      const d = background(i);
      const p = background(i);
      drawHand(d, cx, cy);
      drawHand(p, cx + 0.015, cy + 0.008);
      // A dense block of UI text (screen recording) in a third of the frames
      if (i % 3 === 0) for (let row = 0; row < 8; row++) drawText(d, 0.5, 0.25 + row * 0.022, 12, 16, 500 + i * 10 + row);
      frames.push(frame(d));
      pairs.push(frame(p));
    }
    const scan = analyzeTextFrames(frames, { pairs });
    // The fingers do look like text strokes; they're rejected because they drift and move, not because they're missed.
    expect(scan.bands.some((b) => b.y0 < 0.65 && b.y1 > 0.6 && b.kind === 'text')).toBe(true);
    expect(scan.captions).toBe(false);
    expect(scan.bands.some((b) => b.kind === 'captions')).toBe(false);
  });

  it('returns an empty scan for too few frames', () => {
    expect(analyzeTextFrames([frame(background(1))]).bands).toEqual([]);
  });
});

describe('placing overlays around burned-in text', () => {
  it('keeps the preferred spot when free, otherwise moves to the nearest free one', () => {
    expect(placeAvoiding(0.7, 0.1, [{ y0: 0.2, y1: 0.3 }], 0.4, 0.86)).toBe(0.7);
    const c = placeAvoiding(0.7, 0.1, [{ y0: 0.68, y1: 0.76 }], 0.4, 0.86);
    expect(c + 0.05 <= 0.68 || c - 0.05 >= 0.76).toBe(true);
    expect(c).toBeGreaterThanOrEqual(0.4);
    expect(c).toBeLessThanOrEqual(0.86);
  });

  const scan = (bands: TextScan['bands'], captions = false): TextScan => ({ frames: 24, bands, captions, scannedAt: 0 });
  const edit = { captionsEnabled: true, captionY: 0.7 };

  it('turns animated captions off when the source already has captions', () => {
    expect(editForSource(edit, scan([], true))).toEqual({ captionsEnabled: false, captionY: 0.7 });
    expect(editForSource(edit, undefined)).toBe(edit);
  });

  it('moves captions off persistent on-screen text, ignoring text cropped away from landscape sources', () => {
    const lowerThird = { y0: 0.66, y1: 0.75, x0: 0.1, x1: 0.9, presence: 0.9, change: 0.1, kind: 'static' as const };
    const moved = editForSource(edit, scan([lowerThird]), { width: 1080, height: 1920 });
    expect(moved.captionsEnabled).toBe(true);
    expect(moved.captionY + 0.05 <= 0.66 || moved.captionY - 0.05 >= 0.75).toBe(true);
    const cornerLogo = { ...lowerThird, x0: 0.82, x1: 0.97 };
    expect(editForSource(edit, scan([cornerLogo]), { width: 1920, height: 1080 })).toBe(edit);
  });

  it('maps source bands into the vertical output frame', () => {
    const band = { y0: 0.8, y1: 0.85, x0: 0.3, x1: 0.7, presence: 1, change: 0.7, kind: 'captions' as const };
    expect(bandsInOutput([band], 1080, 1920, 9 / 16)[0]).toMatchObject({ y0: 0.8, y1: 0.85 });
    const landscape = bandsInOutput([band], 1920, 1080, 9 / 16)[0]!;
    expect(landscape.y0).toBeCloseTo(0.8);
    expect(landscape.x0).toBeLessThan(0);
    expect(landscape.x1).toBeGreaterThan(1);
    expect(bandsInOutput([{ ...band, x0: 0.9, x1: 0.97 }], 1920, 1080, 9 / 16)).toEqual([]);
  });
});
