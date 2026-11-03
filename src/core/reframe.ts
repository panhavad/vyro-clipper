import { clamp } from './text';
import type { AspectRatio, LayoutMode, ReframeKeyframe, ReframeTrack } from './types';

export interface FaceBox {
  /** Normalised (0..1) top-left corner and size in the source frame */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export interface FaceSample {
  t: number;
  faces: FaceBox[];
}

export function aspectValue(a: AspectRatio): number {
  const [w, h] = a.split(':').map(Number) as [number, number];
  return w / h;
}

export function outputSize(a: AspectRatio, resolution: number): { width: number; height: number } {
  const v = aspectValue(a);
  // `resolution` is the short side (1080 => 1080x1920 for 9:16).
  const even = (n: number) => Math.round(n / 2) * 2;
  if (v <= 1) return { width: resolution, height: even(resolution / v) };
  return { width: even(resolution * v), height: resolution };
}

const centerOf = (f: FaceBox) => ({ cx: f.x + f.w / 2, cy: f.y + f.h / 2 });

/**
 * Converts raw face detections into a smooth virtual-camera path:
 * primary-face selection with hysteresis, dead-zone, easing, and hard cuts on speaker switches.
 */
export function buildReframeTrack(samples: FaceSample[], opts: { sampleInterval?: number } = {}): ReframeTrack {
  const interval = opts.sampleInterval ?? 0.25;
  const switchSamples = Math.max(2, Math.round(1.2 / interval));
  const holdSamples = Math.round(2 / interval);
  const keyframes: ReframeKeyframe[] = [];
  let primary: { cx: number; cy: number; size: number } | null = null;
  let challenger: { cx: number; cy: number; size: number; count: number } | null = null;
  let missing = 0;
  let camX = 0.5;
  let camY = 0.42;
  let facesSeen = 0;
  let splitVotes = 0;
  const lefts: Array<{ cx: number; cy: number }> = [];
  const rights: Array<{ cx: number; cy: number }> = [];

  for (const s of samples) {
    const faces = s.faces.filter((f) => f.score >= 0.5 && f.w > 0.025);
    if (faces.length) facesSeen++;
    if (faces.length >= 2) {
      const sorted = [...faces].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 2);
      const [a, b] = sorted as [FaceBox, FaceBox];
      const ca = centerOf(a);
      const cb = centerOf(b);
      const sizeRatio = Math.min(a.w, b.w) / Math.max(a.w, b.w);
      if (Math.abs(ca.cx - cb.cx) > 0.3 && sizeRatio > 0.5) {
        splitVotes++;
        const [l, r] = ca.cx < cb.cx ? [ca, cb] : [cb, ca];
        lefts.push(l);
        rights.push(r);
      }
    }

    let target: { cx: number; cy: number; size: number } | null = null;
    if (faces.length) {
      const scored = faces.map((f) => {
        const c = centerOf(f);
        const size = f.w * f.h;
        const near = primary ? Math.hypot(c.cx - primary.cx, c.cy - primary.cy) < 0.12 : false;
        return { ...c, size, weight: size * f.score * (near ? 1.6 : 1) };
      });
      scored.sort((a, b) => b.weight - a.weight);
      const best = scored[0]!;
      const bestIsPrimary = primary && Math.hypot(best.cx - primary.cx, best.cy - primary.cy) < 0.12;
      if (!primary || bestIsPrimary) {
        primary = { cx: best.cx, cy: best.cy, size: best.size };
        challenger = null;
      } else {
        // A different face dominates: only switch after it persists (avoids ping-ponging).
        if (challenger && Math.hypot(challenger.cx - best.cx, challenger.cy - best.cy) < 0.12) challenger.count++;
        else challenger = { cx: best.cx, cy: best.cy, size: best.size, count: 1 };
        const currentStillVisible = scored.find((f) => Math.hypot(f.cx - primary!.cx, f.cy - primary!.cy) < 0.12);
        if (challenger.count >= switchSamples || !currentStillVisible) {
          primary = { cx: challenger.cx, cy: challenger.cy, size: challenger.size };
          challenger = null;
        } else if (currentStillVisible) {
          primary = { cx: currentStillVisible.cx, cy: currentStillVisible.cy, size: currentStillVisible.size };
        }
      }
      missing = 0;
      target = primary;
    } else {
      missing++;
      if (missing > holdSamples) primary = null;
      target = primary;
    }

    const tx = target ? target.cx : missing > holdSamples ? 0.5 : camX;
    const ty = target ? clamp(target.cy, 0.2, 0.8) : camY;
    const jump = Math.abs(tx - camX);
    if (jump > 0.22 && keyframes.length) {
      // Hard cut: hold the old framing until the cut instant.
      keyframes.push({ t: Math.max(keyframes[keyframes.length - 1]!.t + 0.001, s.t - 0.001), cx: camX, cy: camY, fh: keyframes[keyframes.length - 1]!.fh, faces: faces.length });
      camX = tx;
      camY = ty;
    } else if (jump > 0.035) {
      camX += (tx - camX) * 0.38;
      camY += (ty - camY) * 0.3;
    }
    keyframes.push({ t: s.t, cx: camX, cy: camY, fh: target ? Math.sqrt(target.size) : 0, faces: faces.length });
  }

  const median = (vals: number[]) => {
    const v = [...vals].sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)]! : 0.5;
  };
  const n = Math.max(1, samples.length);
  let suggestedLayout: Exclude<LayoutMode, 'auto'> = 'fill';
  if (facesSeen / n < 0.25) suggestedLayout = 'fit';
  if (splitVotes / n > 0.55) suggestedLayout = 'split';
  const track: ReframeTrack = { keyframes, suggestedLayout, analyzedAt: Date.now() };
  if (lefts.length >= 3) {
    track.split = {
      a: { cx: median(lefts.map((l) => l.cx)), cy: median(lefts.map((l) => l.cy)) },
      b: { cx: median(rights.map((r) => r.cx)), cy: median(rights.map((r) => r.cy)) },
    };
  }
  return track;
}

/** Interpolated camera centre at source time t. */
export function cameraAt(track: ReframeTrack | undefined, t: number): { cx: number; cy: number; fh: number } {
  const k = track?.keyframes;
  if (!k || !k.length) return { cx: 0.5, cy: 0.42, fh: 0 };
  if (t <= k[0]!.t) return k[0]!;
  const last = k[k.length - 1]!;
  if (t >= last.t) return last;
  let lo = 0;
  let hi = k.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (k[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = k[lo]!;
  const b = k[hi]!;
  const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
  const ease = f * f * (3 - 2 * f);
  return { cx: a.cx + (b.cx - a.cx) * ease, cy: a.cy + (b.cy - a.cy) * ease, fh: a.fh + (b.fh - a.fh) * ease };
}

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Source rectangle to draw so that it fills an output of aspect `targetAspect` centred on (cx, cy). */
export function computeCrop(srcW: number, srcH: number, targetAspect: number, cx: number, cy: number, zoom = 1): CropRect {
  let sw: number;
  let sh: number;
  if (srcW / srcH > targetAspect) {
    sh = srcH;
    sw = srcH * targetAspect;
  } else {
    sw = srcW;
    sh = srcW / targetAspect;
  }
  sw /= zoom;
  sh /= zoom;
  // Keep the face slightly above centre (natural headroom).
  const sx = clamp(cx * srcW - sw / 2, 0, srcW - sw);
  const sy = clamp(cy * srcH - sh * 0.42, 0, srcH - sh);
  return { sx, sy, sw, sh };
}
