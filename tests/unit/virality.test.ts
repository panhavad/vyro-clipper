import { describe, expect, it } from 'vitest';
import { buildSentences } from '../../src/core/transcript';
import { detectByEnergy, detectViralMoments, hookScore } from '../../src/core/virality';
import type { AudioEnvelope } from '../../src/core/types';
import { BORING, VIRAL, fakeWords } from './fixtures';

function flatEnvelope(duration: number, level = 0.3): AudioEnvelope {
  return { hop: 0.1, rms: Array.from({ length: Math.ceil(duration * 10) }, () => level), median: level };
}

describe('virality', () => {
  it('scores hooks: questions, numbers and bold claims beat filler openings', () => {
    expect(hookScore('What would you do with one million dollars?')).toBeGreaterThan(hookScore('So basically we went to the store.'));
    expect(hookScore('Nobody tells you the secret to getting rich')).toBeGreaterThan(60);
    expect(hookScore('and um yeah')).toBeLessThan(25);
  });

  it('ranks the viral segment above the boring one and respects durations', () => {
    const text = BORING.repeat(3) + VIRAL + BORING.repeat(3);
    const words = fakeWords(text);
    const sentences = buildSentences(words);
    const duration = words[words.length - 1]!.end;
    const env = flatEnvelope(duration);
    const clips = detectViralMoments(words, sentences, env, { minDuration: 12, maxDuration: 30, targetCount: 3, keywords: [] });
    expect(clips.length).toBeGreaterThan(0);
    const best = clips[0]!;
    expect(best.text).toMatch(/million/i);
    expect(best.scores.total).toBeGreaterThan(clips[clips.length - 1]!.scores.total - 1);
    for (const c of clips) {
      expect(c.end - c.start).toBeGreaterThanOrEqual(12);
      expect(c.end - c.start).toBeLessThanOrEqual(32);
      expect(c.scores.total).toBeGreaterThanOrEqual(1);
      expect(c.scores.total).toBeLessThanOrEqual(99);
    }
    // Non-overlapping selection
    const sorted = [...clips].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const overlap = Math.max(0, sorted[i - 1]!.end - sorted[i]!.start);
      expect(overlap / Math.min(sorted[i]!.end - sorted[i]!.start, sorted[i - 1]!.end - sorted[i - 1]!.start)).toBeLessThanOrEqual(0.15 + 1e-9);
    }
  });

  it('boosts clips that match campaign keywords and explains why', () => {
    const text = BORING + 'The Feastables chocolate bar challenge was the best part of the whole show. Everyone wanted to win the Feastables prize. ' + BORING + VIRAL;
    const words = fakeWords(text);
    const sentences = buildSentences(words);
    const env = flatEnvelope(words[words.length - 1]!.end);
    const withKw = detectViralMoments(words, sentences, env, { minDuration: 8, maxDuration: 20, targetCount: 5, keywords: ['Feastables'], prompt: 'feastables' });
    const feast = withKw.find((c) => /Feastables/.test(c.text));
    expect(feast).toBeDefined();
    expect(feast!.reasons.join(' ')).toMatch(/On-brief/);
    expect(feast!.scores.relevance).toBeGreaterThan(50);
  });

  it('returns the whole source when it is shorter than the minimum', () => {
    const words = fakeWords('Short video. Only a few words here.');
    const clips = detectViralMoments(words, buildSentences(words), undefined, { minDuration: 30, maxDuration: 60, targetCount: 0, keywords: [] });
    expect(clips).toHaveLength(1);
  });

  it('finds energetic windows when there is no speech', () => {
    const rms = Array.from({ length: 1200 }, (_, i) => (i > 600 && i < 900 ? 0.4 + 0.5 * Math.abs(Math.sin(i)) : 0.15));
    const env: AudioEnvelope = { hop: 0.1, rms, median: 0.2 };
    const clips = detectByEnergy(env, 120, { minDuration: 20, maxDuration: 40, targetCount: 2, keywords: [] });
    expect(clips.length).toBe(2);
    expect(clips[0]!.start).toBeGreaterThanOrEqual(45);
    expect(clips[0]!.start).toBeLessThan(90);
  });
});
