import { describe, expect, it } from 'vitest';
import { makeHookOverlay, makeTitle, titleKey, topicalHashtags } from '../../src/core/hooks';
import { uniqueTitles } from '../../src/core/clipFactory';
import type { Clip } from '../../src/core/types';

describe('titles & hooks', () => {
  it('prefers complete sentences over cut-off comma fragments', () => {
    const t = makeTitle("We have a very diverse, talented team. That's why we're building the Gateway to the Moon.");
    expect(t).not.toBe('We Have a Very Diverse');
    expect(t.split(' ').length).toBeGreaterThanOrEqual(4);
  });

  it('keeps strong question hooks and strips leading fillers', () => {
    expect(makeTitle('So what would you do with a million dollars? I would buy an island.')).toBe('What Would You Do With a Million Dollars?');
  });

  it('builds an uppercase on-screen hook with a mood emoji glued to the last word', () => {
    expect(makeHookOverlay('I made a million dollars')).toBe('I MADE A MILLION DOLLARS\u00A0💰');
    expect(makeHookOverlay('A very long title that keeps going and going beyond the limit', 30).length).toBeLessThanOrEqual(34);
  });

  it('prefers a fitting phrase over a long sentence that would be truncated', () => {
    const text = 'Everybody is excited about this, everybody is talking about this. So there is kind of this wave of excitement being generated just by saying we are going back.';
    expect(makeTitle(text, 40)).toBe('Everybody is Excited About This');
  });

  it('prefers a specific line over a generic question', () => {
    const t = makeTitle('What was it? I spent three years building rockets in my garage.');
    expect(t).not.toBe('What Was It?');
    expect(t).toContain('Rockets');
  });

  it('skips titles already used by other clips', () => {
    const text = "Why'd you pick that date? Because my grandmother was born on that exact day in Louisiana.";
    const first = makeTitle(text);
    const second = makeTitle(text, 60, new Set([titleKey(first)]));
    expect(second).not.toBe(first);
    expect(titleKey("Why'd You Pick That Date?")).toBe("why'd you pick that date");
  });

  it('derives topical hashtags from keywords and repeated words', () => {
    const tags = topicalHashtags('rockets rockets rockets are cool and the moon is far', ['Artemis', 'Moon base']);
    expect(tags[0]).toBe('#Artemis');
    expect(tags).toContain('#Moonbase');
  });

  it('never turns repeated generic words into hashtags', () => {
    const tags = topicalHashtags('Everybody is excited about this, everybody is talking about rockets. Rockets, everyone! Everyone loves something, something big.', []);
    expect(tags).toEqual(['#rockets']);
  });

  it('keeps titles and hooks unique across a batch of clips (best clip keeps its own)', () => {
    const transcript = "Why'd you pick that date? Because my grandmother was born on that exact day in Louisiana.";
    const clip = (id: string, total: number): Clip => {
      const title = makeTitle(transcript);
      return { id, title, hook: makeHookOverlay(makeTitle(transcript, 52), 54), caption: title, transcript, scores: { total } } as unknown as Clip;
    };
    const [a, b] = uniqueTitles([clip('a', 70), clip('b', 81)]);
    expect(b!.title).toBe(makeTitle(transcript));
    expect(a!.title).not.toBe(b!.title);
    expect(titleKey(a!.hook)).not.toBe(titleKey(b!.hook));
    expect(a!.caption).toBe(a!.title);
  });
});
