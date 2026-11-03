import { describe, expect, it } from 'vitest';
import { CAPTION_STYLES, getCaptionStyle, pageAt, paginateCaptions } from '../../src/core/captions';
import { fakeWords } from './fixtures';

describe('captions', () => {
  it('has unique style ids and a sane default', () => {
    expect(new Set(CAPTION_STYLES.map((s) => s.id)).size).toBe(CAPTION_STYLES.length);
    expect(getCaptionStyle('nope').id).toBe('bold-pop');
  });

  it('paginates by max words and sentence ends', () => {
    const words = fakeWords('I made one million dollars in a single day. Crazy right?');
    const pages = paginateCaptions(words, getCaptionStyle('bold-pop'), { emojis: true, keywordHighlight: true, censor: false });
    for (const p of pages) expect(p.lines.flat().length).toBeLessThanOrEqual(3);
    // sentence boundary: "DAY" ends a page
    expect(pages.some((p) => p.lines.flat().at(-1)!.text === 'DAY')).toBe(true);
    // uppercase + punctuation stripped
    expect(pages[0]!.lines[0]![0]!.text).toBe('I');
    // keyword + emoji detection
    expect(pages.flatMap((p) => p.lines.flat()).some((w) => w.keyword)).toBe(true);
    expect(pages.some((p) => p.emoji)).toBe(true);
    // non-overlapping pages
    for (let i = 1; i < pages.length; i++) expect(pages[i]!.start).toBeGreaterThanOrEqual(pages[i - 1]!.end - 1e-6);
    expect(pageAt(pages, words[0]!.start + 0.01)).toBe(pages[0]);
  });

  it('censors profanity when asked', () => {
    const words = fakeWords('that was shit');
    const pages = paginateCaptions(words, getCaptionStyle('minimal'), { emojis: false, keywordHighlight: false, censor: true });
    expect(pages.flatMap((p) => p.lines.flat()).map((w) => w.text)).toContain('s***');
  });
});
