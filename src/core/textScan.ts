/**
 * Finds text burned into a source video (captions, lower-thirds, logos) from a handful of sampled frames,
 * so pre-edited footage doesn't get a second set of captions and overlays avoid the existing text.
 *
 * Text = rows with many bright↔dark stroke transitions, grouped into bands of letter height. Bands that
 * appear in the same place across frames are classified by how much their content changes:
 * captions change between samples, logos/titles don't.
 */

export interface GrayFrame {
  width: number;
  height: number;
  /** Row-major brightness (max of R, G, B), 0..255 */
  data: Uint8Array | Uint8ClampedArray;
}

export type TextBandKind = 'captions' | 'static' | 'text';

export interface TextBand {
  /** Normalised vertical extent (0 = top, 1 = bottom) */
  y0: number;
  y1: number;
  /** Normalised horizontal extent */
  x0: number;
  x1: number;
  /** Fraction of sampled frames that show text in this band */
  presence: number;
  /** 0 = the same text in every sample (logo, title), 1 = different text in every sample (captions) */
  change: number;
  /** How unchanged the band is ~0.1 s later (text ≈ 1, moving hands/bodies lower) */
  stability?: number;
  /** Median drift of the band's vertical centre between samples (fraction of height) */
  jitter?: number;
  kind: TextBandKind;
}

export interface TextScan {
  frames: number;
  bands: TextBand[];
  /** The source already has burned-in captions / subtitles */
  captions: boolean;
  scannedAt: number;
}

const BRIGHT = 165;
const CONTRAST = 95;
// Calibrated on real campaign footage (pre-captioned shorts, textless shorts, UGC with UI screenshots, episodes).
const MIN_CAPTION_PRESENCE = 0.45;
const MAX_CAPTION_JITTER = 0.012;
const PINNED_JITTER = 0.004;
const MIN_STABILITY = 0.45;

/**
 * Marks bright pixels that have a much darker pixel close by (text strokes with an outline, shadow, glow or
 * box). Expects frames sampled at ~540 px on the short side.
 */
export function textMask(f: GrayFrame): Uint8Array {
  const { width: W, height: H, data } = f;
  const mask = new Uint8Array(W * H);
  for (let y = 2; y < H - 2; y++) {
    const row = y * W;
    for (let x = 3; x < W - 3; x++) {
      const i = row + x;
      const v = data[i]!;
      if (v < BRIGHT) continue;
      const lim = v - CONTRAST;
      if (
        data[i - 1]! <= lim ||
        data[i + 1]! <= lim ||
        data[i - 2]! <= lim ||
        data[i + 2]! <= lim ||
        data[i - 3]! <= lim ||
        data[i + 3]! <= lim ||
        data[i - W]! <= lim ||
        data[i + W]! <= lim ||
        data[i - 2 * W]! <= lim ||
        data[i + 2 * W]! <= lim
      )
        mask[i] = 1;
    }
  }
  return mask;
}

interface PxBand {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

/** Bands of consecutive "text rows" (many separate strokes) with a plausible letter height. */
export function frameTextBands(mask: Uint8Array, W: number, H: number): PxBand[] {
  // A stroke is one run whatever the resolution, so short one-word captions ("THE", "CAN") must still qualify.
  const minRuns = Math.max(4, Math.round(W / 160));
  const isText = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    let runs = 0;
    let prev = 0;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const m = mask[row + x]!;
      if (m && !prev) runs++;
      prev = m;
    }
    if (runs >= minRuns) isText[y] = 1;
  }
  const gap = Math.max(2, Math.round(H * 0.008));
  const minH = Math.max(3, Math.round(H * 0.01));
  const maxH = Math.round(H * 0.18);
  const bands: PxBand[] = [];
  const push = (y0: number, y1: number) => {
    const h = y1 - y0 + 1;
    if (h < minH || h > maxH) return;
    const cols = new Uint32Array(W);
    let total = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) if (mask[row + x]) {
        cols[x]!++;
        total++;
      }
    }
    let acc = 0;
    let x0 = 0;
    let x1 = W - 1;
    for (let x = 0; x < W; x++) {
      acc += cols[x]!;
      if (acc >= total * 0.03) {
        x0 = x;
        break;
      }
    }
    acc = 0;
    for (let x = W - 1; x >= 0; x--) {
      acc += cols[x]!;
      if (acc >= total * 0.03) {
        x1 = x;
        break;
      }
    }
    bands.push({ y0, y1, x0, x1 });
  };
  let start = -1;
  let last = -1;
  for (let y = 0; y < H; y++) {
    if (isText[y]) {
      if (start < 0) start = y;
      last = y;
    } else if (start >= 0 && y - last > gap) {
      push(start, last);
      start = -1;
    }
  }
  if (start >= 0) push(start, last);
  return bands;
}

/** Share of the smaller mask's pixels that are also set in the other mask, within rows [y0, y1]. */
function maskMatch(a: Uint8Array, b: Uint8Array, W: number, y0: number, y1: number): number {
  let na = 0;
  let nb = 0;
  let both = 0;
  for (let i = y0 * W; i < (y1 + 1) * W; i++) {
    const p = a[i]!;
    const q = b[i]!;
    na += p;
    nb += q;
    both += p & q;
  }
  const small = Math.min(na, nb);
  return small ? both / small : 0;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};

export interface TextScanOptions {
  /** Minimum share of frames a band must appear in */
  minPresence?: number;
  /** For each frame, a frame ~0.1 s later (same size): separates steady text from moving objects */
  pairs?: Array<GrayFrame | undefined>;
}

/** Analyses frames sampled across the video (in time order, all the same size). */
export function analyzeTextFrames(frames: GrayFrame[], opts: TextScanOptions = {}): TextScan {
  const scan: TextScan = { frames: frames.length, bands: [], captions: false, scannedAt: Date.now() };
  if (frames.length < 3) return scan;
  const W = frames[0]!.width;
  const H = frames[0]!.height;
  const sameSize = (f: GrayFrame | undefined): f is GrayFrame => !!f && f.width === W && f.height === H;
  const keep = frames.map((f, i) => i).filter((i) => sameSize(frames[i]));
  const masks = keep.map((i) => textMask(frames[i]!));
  const pairMasks = keep.map((i) => {
    const p = opts.pairs?.[i];
    return sameSize(p) ? textMask(p) : undefined;
  });
  // Dense stacks of text rows (screen recordings, slides, documents) are not captions or titles.
  const perFrame = masks.map((m) => {
    const bands = frameTextBands(m, W, H);
    const centre = (b: PxBand) => (b.y0 + b.y1) / 2;
    return bands.filter((b) => bands.filter((o) => Math.abs(centre(o) - centre(b)) <= H * 0.1).length < 5);
  });
  const n = masks.length;
  const minPresence = opts.minPresence ?? 0.3;

  // Rows covered by a text band in enough frames form a persistent region.
  const cover = new Uint16Array(H);
  for (const bands of perFrame) for (const b of bands) for (let y = b.y0; y <= b.y1; y++) cover[y]!++;
  const need = Math.max(2, Math.ceil(n * minPresence * 0.6));
  const regions: Array<{ y0: number; y1: number }> = [];
  let start = -1;
  for (let y = 0; y <= H; y++) {
    const on = y < H && cover[y]! >= need;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      regions.push({ y0: start, y1: y - 1 });
      start = -1;
    }
  }

  for (const r of regions) {
    const hits: Array<{ f: number; band: PxBand }> = [];
    perFrame.forEach((bands, f) => {
      const overlapping = bands.filter((b) => Math.min(b.y1, r.y1) - Math.max(b.y0, r.y0) >= 0);
      if (!overlapping.length) return;
      hits.push({
        f,
        band: {
          y0: Math.min(...overlapping.map((b) => b.y0)),
          y1: Math.max(...overlapping.map((b) => b.y1)),
          x0: Math.min(...overlapping.map((b) => b.x0)),
          x1: Math.max(...overlapping.map((b) => b.x1)),
        },
      });
    });
    const presence = hits.length / n;
    if (presence < minPresence) continue;
    const y0 = Math.max(0, Math.min(r.y0, median(hits.map((h) => h.band.y0))));
    const y1 = Math.min(H - 1, Math.max(r.y1, median(hits.map((h) => h.band.y1))));
    const matches: number[] = [];
    for (let i = 1; i < hits.length; i++) matches.push(maskMatch(masks[hits[i - 1]!.f]!, masks[hits[i]!.f]!, W, y0, y1));
    const change = Math.max(0, Math.min(1, 1 - median(matches)));
    const steady: number[] = [];
    for (const h of hits) {
      const pm = pairMasks[h.f];
      if (pm) steady.push(maskMatch(masks[h.f]!, pm, W, y0, y1));
    }
    const band: TextBand = {
      y0: y0 / H,
      y1: (y1 + 1) / H,
      // Wide percentiles: captions revealed word by word only light up part of the line in each frame.
      x0: quantile(hits.map((h) => h.band.x0), 0.2) / W,
      x1: (quantile(hits.map((h) => h.band.x1), 0.8) + 1) / W,
      presence: Math.round(presence * 100) / 100,
      change: Math.round(change * 100) / 100,
      kind: 'text',
    };
    if (steady.length) band.stability = Math.round(median(steady) * 100) / 100;
    // Burned-in captions sit at a fixed height (anchored by their top, centre or bottom line); hands, bodies
    // and set pieces drift between samples.
    const mad = (vals: number[]) => {
      const m = median(vals);
      return median(vals.map((v) => Math.abs(v - m)));
    };
    band.jitter =
      Math.round(Math.min(mad(hits.map((h) => h.band.y0 / H)), mad(hits.map((h) => (h.band.y0 + h.band.y1) / 2 / H)), mad(hits.map((h) => h.band.y1 / H))) * 1000) / 1000;
    const cx = (band.x0 + band.x1) / 2;
    const cy = (band.y0 + band.y1) / 2;
    // Captions: in most samples, different text each time, at a fixed height, and (unless pinned exactly in
    // place) unchanged a fraction of a second later — unlike hands, bodies or occasional screenshots.
    const fixed = (band.jitter ?? 0) <= MAX_CAPTION_JITTER;
    const steadyOrPinned = (band.stability ?? 1) >= MIN_STABILITY || (band.jitter ?? 0) <= PINNED_JITTER;
    const captionLike =
      band.presence >= MIN_CAPTION_PRESENCE &&
      band.change >= 0.45 &&
      fixed &&
      steadyOrPinned &&
      cy >= 0.3 &&
      cy <= 0.96 &&
      band.x1 - band.x0 >= 0.2 &&
      Math.abs(cx - 0.5) <= 0.15 &&
      band.y1 - band.y0 <= 0.2;
    if (captionLike) band.kind = 'captions';
    else if (band.change < 0.35) band.kind = 'static';
    scan.bands.push(band);
  }
  scan.captions = scan.bands.some((b) => b.kind === 'captions');
  return scan;
}

/**
 * Picks the vertical centre (fraction of height) for a box of height `h` closest to `preferred`
 * that does not overlap any of the `avoid` bands, staying within [min, max].
 */
export function placeAvoiding(preferred: number, h: number, avoid: Array<{ y0: number; y1: number }>, min: number, max: number, margin = 0.012): number {
  const free = (c: number) => avoid.every((b) => c + h / 2 + margin <= b.y0 || c - h / 2 - margin >= b.y1);
  const clampC = (c: number) => Math.min(max, Math.max(min, c));
  if (free(clampC(preferred))) return clampC(preferred);
  const options: number[] = [];
  for (const b of avoid) options.push(b.y1 + h / 2 + margin + 0.001, b.y0 - h / 2 - margin - 0.001);
  const ok = options.map(clampC).filter(free).sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
  return ok[0] ?? clampC(preferred);
}

export const EMPTY_TEXT_SCAN = (): TextScan => ({ frames: 0, bands: [], captions: false, scannedAt: Date.now() });

/**
 * Adapts clip edit defaults to the source: no second set of captions over burned-in ones, and captions
 * kept clear of persistent on-screen text (lower-thirds, logos). Coordinates map 1:1 for the default fill layout.
 */
export function editForSource<T extends { captionsEnabled: boolean; captionY: number }>(edit: T, scan: TextScan | undefined, src?: { width: number; height: number }): T {
  if (!scan) return edit;
  if (scan.captions) return { ...edit, captionsEnabled: false };
  const vertical = src ? src.height >= src.width : true;
  // Horizontal sources are cropped to the centre: only text across the middle stays visible.
  const visible = scan.bands.filter((b) => b.presence >= 0.5 && (vertical || (b.x1 > 0.32 && b.x0 < 0.68)));
  if (!visible.length) return edit;
  const captionY = Math.round(placeAvoiding(edit.captionY, 0.1, visible, 0.4, 0.86) * 100) / 100;
  return captionY === edit.captionY ? edit : { ...edit, captionY };
}
