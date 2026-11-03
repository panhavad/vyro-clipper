import { describe, expect, it } from 'vitest';
import { buildTimeline, computeCuts, frameSchedule, mergeRanges, outToSrc, planClip, remapWords, srcToOut } from '../../src/core/timeline';
import type { Word } from '../../src/core/types';

const words: Word[] = [
  { text: 'Hello', start: 1.0, end: 1.4 },
  { text: 'um', start: 1.5, end: 1.8 },
  { text: 'world.', start: 1.9, end: 2.3 },
  // 2s silence
  { text: 'This', start: 4.3, end: 4.6 },
  { text: 'is', start: 4.65, end: 4.8 },
  { text: 'great.', start: 4.85, end: 5.3 },
];

describe('timeline', () => {
  it('merges overlapping ranges', () => {
    expect(mergeRanges([{ start: 3, end: 4 }, { start: 1, end: 2 }, { start: 1.5, end: 3.02 }])).toEqual([{ start: 1, end: 4 }]);
  });

  it('computes jump cuts and filler removal', () => {
    const cuts = computeCuts({ start: 0, end: 6 }, words, [], { jumpCuts: true, silenceThreshold: 0.5, removeFillers: true });
    // leading silence, the "um", the 2s gap, trailing silence
    expect(cuts.some((c) => c.start === 0)).toBe(true);
    expect(cuts.some((c) => c.start <= 1.5 && c.end >= 1.8)).toBe(true);
    expect(cuts.some((c) => c.start >= 2.3 && c.end <= 4.3 && c.end - c.start > 1.5)).toBe(true);
  });

  it('maps between output and source time', () => {
    const plan = buildTimeline({ start: 0, end: 10 }, [{ start: 2, end: 4 }, { start: 6, end: 7 }]);
    expect(plan.segments).toEqual([
      { srcStart: 0, srcEnd: 2, outStart: 0 },
      { srcStart: 4, srcEnd: 6, outStart: 2 },
      { srcStart: 7, srcEnd: 10, outStart: 4 },
    ]);
    expect(plan.duration).toBe(7);
    expect(outToSrc(plan, 2.5)).toBeCloseTo(4.5);
    expect(outToSrc(plan, 4.5)).toBeCloseTo(7.5);
    expect(srcToOut(plan, 4.5)).toBeCloseTo(2.5);
    expect(srcToOut(plan, 3)).toBeCloseTo(2); // inside a cut snaps forward
    expect(srcToOut(plan, 11)).toBe(-1);
  });

  it('remaps words and drops removed ones', () => {
    const plan = planClip({ start: 0.8, end: 5.6 }, words, [], { jumpCuts: true, silenceThreshold: 0.5, removeFillers: true });
    const out = remapWords(words, plan);
    expect(out.map((w) => w.text)).toEqual(['Hello', 'world.', 'This', 'is', 'great.']);
    expect(out[0]!.start).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.start);
    expect(out[out.length - 1]!.end).toBeLessThanOrEqual(plan.duration + 0.05);
    expect(plan.duration).toBeLessThan(4.8 - 1.5);
  });

  it('produces a monotonic frame schedule', () => {
    const plan = buildTimeline({ start: 0, end: 5 }, [{ start: 1, end: 2 }]);
    const frames = frameSchedule(plan, 30);
    expect(frames).toHaveLength(120);
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.src).toBeGreaterThan(frames[i - 1]!.src);
    expect(frames[30]!.src).toBeCloseTo(2);
  });
});
