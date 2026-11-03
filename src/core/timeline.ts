import { FILLER_WORDS, normalizeToken } from './text';
import type { TimeRange, Word } from './types';
import { wordsInRange } from './transcript';

export interface Segment {
  srcStart: number;
  srcEnd: number;
  outStart: number;
}

export interface TimelinePlan {
  segments: Segment[];
  duration: number;
}

export interface TimelineOptions {
  jumpCuts: boolean;
  silenceThreshold: number;
  removeFillers: boolean;
  /** Seconds of breathing room kept around speech at each cut */
  pad?: number;
}

export function mergeRanges(ranges: TimeRange[], tolerance = 0.05): TimeRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + tolerance) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Computes the ranges removed from a clip by jump cuts, filler removal and manual transcript edits. */
export function computeCuts(range: TimeRange, words: Word[], manualCuts: TimeRange[], opts: TimelineOptions): TimeRange[] {
  const pad = opts.pad ?? 0.12;
  const cuts: TimeRange[] = manualCuts.map((c) => ({ start: Math.max(range.start, c.start), end: Math.min(range.end, c.end) }));
  const inRange = wordsInRange(words, range.start, range.end);
  if (opts.jumpCuts && inRange.length) {
    const lead = inRange[0]!.start - range.start;
    if (lead > opts.silenceThreshold) cuts.push({ start: range.start, end: inRange[0]!.start - pad });
    for (let i = 1; i < inRange.length; i++) {
      const a = inRange[i - 1]!;
      const b = inRange[i]!;
      const gap = b.start - a.end;
      if (gap > opts.silenceThreshold) cuts.push({ start: a.end + pad, end: b.start - pad });
    }
    const last = inRange[inRange.length - 1]!;
    const tail = range.end - last.end;
    if (tail > opts.silenceThreshold + 0.3) cuts.push({ start: last.end + 0.3, end: range.end });
  }
  if (opts.removeFillers) {
    inRange.forEach((w, i) => {
      if (!FILLER_WORDS.has(normalizeToken(w.text))) return;
      const prevEnd = inRange[i - 1]?.end ?? range.start;
      const nextStart = inRange[i + 1]?.start ?? range.end;
      cuts.push({ start: Math.max(prevEnd, w.start - 0.03), end: Math.min(nextStart, w.end + 0.03) });
    });
  }
  return mergeRanges(cuts.filter((c) => c.end - c.start > 0.04));
}

export function buildTimeline(range: TimeRange, cuts: TimeRange[]): TimelinePlan {
  const merged = mergeRanges(cuts);
  const segments: Segment[] = [];
  let cursor = range.start;
  let out = 0;
  const push = (a: number, b: number) => {
    if (b - a < 0.08) return;
    segments.push({ srcStart: a, srcEnd: b, outStart: out });
    out += b - a;
  };
  for (const c of merged) {
    if (c.end <= range.start || c.start >= range.end) continue;
    push(cursor, Math.max(cursor, c.start));
    cursor = Math.max(cursor, c.end);
  }
  push(cursor, range.end);
  if (!segments.length) {
    segments.push({ srcStart: range.start, srcEnd: range.end, outStart: 0 });
    out = range.end - range.start;
  }
  return { segments, duration: out };
}

export function planClip(range: TimeRange, words: Word[], manualCuts: TimeRange[], opts: TimelineOptions): TimelinePlan {
  return buildTimeline(range, computeCuts(range, words, manualCuts, opts));
}

/** Output time -> source time. */
export function outToSrc(plan: TimelinePlan, t: number): number {
  const segs = plan.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid]!.outStart <= t) lo = mid;
    else hi = mid - 1;
  }
  const s = segs[lo]!;
  return Math.min(s.srcEnd, s.srcStart + Math.max(0, t - s.outStart));
}

/** Source time -> output time (times inside a cut snap to the next kept segment). Returns -1 outside the clip. */
export function srcToOut(plan: TimelinePlan, t: number): number {
  for (const s of plan.segments) {
    if (t < s.srcStart) return s.outStart;
    if (t <= s.srcEnd) return s.outStart + (t - s.srcStart);
  }
  return -1;
}

export function segmentIndexAtSrc(plan: TimelinePlan, t: number): number {
  return plan.segments.findIndex((s) => t >= s.srcStart && t < s.srcEnd);
}

/** Words re-timed onto the output timeline (words inside cuts are dropped). */
export function remapWords(words: Word[], plan: TimelinePlan): Word[] {
  const out: Word[] = [];
  if (!plan.segments.length) return out;
  const first = plan.segments[0]!.srcStart;
  const last = plan.segments[plan.segments.length - 1]!.srcEnd;
  for (const w of wordsInRange(words, first, last)) {
    const mid = (w.start + w.end) / 2;
    const seg = plan.segments.find((s) => mid >= s.srcStart && mid <= s.srcEnd);
    if (!seg) continue;
    const start = seg.outStart + Math.max(0, w.start - seg.srcStart);
    const end = seg.outStart + Math.min(seg.srcEnd, w.end) - seg.srcStart;
    out.push({ ...w, start, end: Math.max(start + 0.04, end) });
  }
  return out;
}

/** Source timestamps for every output frame (monotonic, suitable for sequential decoding). */
export function frameSchedule(plan: TimelinePlan, fps: number): Array<{ out: number; src: number; seg: number }> {
  const frames: Array<{ out: number; src: number; seg: number }> = [];
  const total = Math.round(plan.duration * fps);
  let segIdx = 0;
  for (let i = 0; i < total; i++) {
    const out = i / fps;
    while (segIdx < plan.segments.length - 1 && plan.segments[segIdx + 1]!.outStart <= out + 1e-9) segIdx++;
    const s = plan.segments[segIdx]!;
    frames.push({ out, src: Math.min(s.srcEnd - 1e-4, s.srcStart + (out - s.outStart)), seg: segIdx });
  }
  return frames;
}
