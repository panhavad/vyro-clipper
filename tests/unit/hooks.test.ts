import { describe, expect, it } from 'vitest';
import { makeHookOverlay, makeTitle, topicalHashtags } from '../../src/core/hooks';

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

  it('derives topical hashtags from keywords and repeated words', () => {
    const tags = topicalHashtags('rockets rockets rockets are cool and the moon is far', ['Artemis', 'Moon base']);
    expect(tags[0]).toBe('#Artemis');
    expect(tags).toContain('#Moonbase');
  });
});
