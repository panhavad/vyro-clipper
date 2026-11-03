import { describe, expect, it } from 'vitest';
import { parseBrief } from '../../src/core/brief';

const BRIEF = `Clip the funniest moments from Beast Games Season 2.
• Videos must be at least 30 seconds and under 90 seconds.
• Always mention "Beast Games" in the caption and tag @MrBeast.
• Do not use copyrighted music.
• Don't add other brand logos.
• Focus on challenges where contestants win money.
Use #BeastGames #MrBeast. English subtitles required.`;

describe('brief parser', () => {
  it('extracts durations, dos and don’ts', () => {
    const b = parseBrief(BRIEF);
    expect(b.minDuration).toBe(30);
    expect(b.maxDuration).toBe(90);
    expect(b.donts.some((d) => /music/i.test(d))).toBe(true);
    expect(b.donts.some((d) => /logos/i.test(d))).toBe(true);
    expect(b.dos.some((d) => /mention/i.test(d))).toBe(true);
    expect(b.noMusic).toBe(true);
    expect(b.wantsSubtitles).toBe(true);
    expect(b.englishOnly).toBe(true);
  });

  it('extracts hashtags, mentions, keywords and focus', () => {
    const b = parseBrief(BRIEF);
    expect(b.hashtags).toEqual(['#BeastGames', '#MrBeast']);
    expect(b.mentions).toContain('@MrBeast');
    expect(b.keywords.map((k) => k.toLowerCase())).toContain('beast games');
    expect(b.focus.some((f) => /challenges/i.test(f))).toBe(true);
  });

  it('handles ranges and minutes', () => {
    expect(parseBrief('Keep clips between 20 and 45 seconds')).toMatchObject({ minDuration: 20, maxDuration: 45 });
    expect(parseBrief('Clips 30-60s please')).toMatchObject({ minDuration: 30, maxDuration: 60 });
    expect(parseBrief('no longer than 1.5 minutes').maxDuration).toBe(90);
  });
});
