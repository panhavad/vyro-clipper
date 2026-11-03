import { describe, expect, it } from 'vitest';
import { censorWord, emojiFor, htmlToText, isProfane, normalizeHashtag, slugify, titleCase, truncateWords } from '../../src/core/text';

describe('text utils', () => {
  it('converts brief HTML to readable text with bullets and links', () => {
    const html = '<p>Clip the <strong>best</strong> moments.</p><ul><li>Use #MrBeast</li><li>Link: <a href="https://x.com/a">here</a></li></ul><p>Tom &amp; Jerry&#39;s</p>';
    const text = htmlToText(html);
    expect(text).toContain('Clip the best moments.');
    expect(text).toContain('• Use #MrBeast');
    expect(text).toContain('here (https://x.com/a)');
    expect(text).toContain("Tom & Jerry's");
  });

  it('normalises hashtags', () => {
    expect(normalizeHashtag('##Mr Beast!')).toBe('#MrBeast');
    expect(normalizeHashtag('ad')).toBe('#ad');
    expect(normalizeHashtag('  ')).toBe('');
  });

  it('detects and censors profanity', () => {
    expect(isProfane('Fucking')).toBe(true);
    expect(isProfane('shitake')).toBe(true);
    expect(isProfane('hello')).toBe(false);
    expect(censorWord('shit!')).toBe('s***!');
  });

  it('maps words to emojis', () => {
    expect(emojiFor('money')).toBe('💰');
    expect(emojiFor('Million,')).toBe('🤑');
    expect(emojiFor('table')).toBeUndefined();
  });

  it('truncates on word boundaries and title-cases', () => {
    expect(truncateWords('the quick brown fox jumps over the lazy dog', 20)).toBe('the quick brown fox…');
    expect(titleCase('i gave away a MILLION dollars')).toBe('I Gave Away a MILLION Dollars');
    expect(slugify('I Gave Away $1M!')).toBe('i-gave-away-1m');
  });
});
