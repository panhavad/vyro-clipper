import { EMOTION_WORDS, NUMBER_PATTERN, normalizeToken } from './text';
import type { Word } from './types';
import type { TimelinePlan } from './timeline';

export interface ZoomEvent {
  start: number;
  end: number;
  scale: number;
}

export interface ZoomPlan {
  /** Instant zoom level changes at jump-cut boundaries (hides the cut) */
  steps: Array<{ t: number; scale: number }>;
  /** Smooth punch-ins on emphasised words */
  punches: ZoomEvent[];
}

function isEmphasis(w: Word): boolean {
  const n = normalizeToken(w.text);
  return /!$/.test(w.text) || EMOTION_WORDS.has(n) || NUMBER_PATTERN.test(w.text) || /^[A-Z]{3,}[!?.,]*$/.test(w.text);
}

/** Plans dynamic zoom on the output timeline. `strength` 0..1. */
export function planZooms(outWords: Word[], plan: TimelinePlan, strength: number): ZoomPlan {
  const s = Math.max(0, Math.min(1, strength));
  const steps: Array<{ t: number; scale: number }> = [{ t: 0, scale: 1 }];
  let zoomed = false;
  for (let i = 1; i < plan.segments.length; i++) {
    const seg = plan.segments[i]!;
    const prev = plan.segments[i - 1]!;
    // Only alternate on visible cuts (segments with a real gap between them).
    if (seg.srcStart - prev.srcEnd < 0.2) continue;
    zoomed = !zoomed;
    steps.push({ t: seg.outStart, scale: zoomed ? 1 + 0.09 * s : 1 });
  }
  const punches: ZoomEvent[] = [];
  let lastEnd = -10;
  for (const w of outWords) {
    if (!isEmphasis(w) || w.start - lastEnd < 2.6) continue;
    const start = Math.max(0, w.start - 0.06);
    const end = Math.min(plan.duration, w.start + 1.6);
    punches.push({ start, end, scale: 1 + 0.14 * s });
    lastEnd = end;
  }
  return { steps, punches };
}

const easeOut = (x: number) => 1 - (1 - x) ** 3;

export function zoomAt(z: ZoomPlan | undefined, t: number): number {
  if (!z) return 1;
  let base = 1;
  for (const step of z.steps) {
    if (step.t <= t) base = step.scale;
    else break;
  }
  let punch = 1;
  for (const p of z.punches) {
    if (t < p.start || t > p.end) continue;
    const rampIn = 0.18;
    const rampOut = 0.3;
    const amt = p.scale - 1;
    if (t < p.start + rampIn) punch = 1 + amt * easeOut((t - p.start) / rampIn);
    else if (t > p.end - rampOut) punch = 1 + amt * easeOut((p.end - t) / rampOut);
    else punch = p.scale;
    break;
  }
  return base * punch;
}
