import { describe, expect, it } from 'vitest';
import { buildSentences, normalizeWords, parseSubtitles, subtitlesToWords, textInRange, toSrt, toVtt, wordsToCues } from '../../src/core/transcript';
import { fakeWords } from './fixtures';

describe('transcript', () => {
  it('normalises raw ASR words', () => {
    const words = normalizeWords([
      { text: ' Hello', start: 0, end: 0.4 },
      { text: ' ', start: 0.4, end: 0.5 },
      { text: ' world.', start: 0.5, end: null },
      { text: ' Next', start: 1.2, end: 1.2 },
    ]);
    expect(words.map((w) => w.text)).toEqual(['Hello', 'world.', 'Next']);
    expect(words[1]!.end).toBeCloseTo(1.2);
    expect(words[2]!.end).toBeGreaterThan(words[2]!.start);
  });

  it('builds sentences from punctuation and pauses', () => {
    const words = fakeWords('Hello there. How are you doing today? I am great!');
    const s = buildSentences(words);
    expect(s.map((x) => x.text)).toEqual(['Hello there.', 'How are you doing today?', 'I am great!']);
    expect(s[1]!.w0).toBe(2);
    expect(s[2]!.end).toBeCloseTo(words[words.length - 1]!.end);
  });

  it('splits unpunctuated speech on pauses', () => {
    const words = [
      { text: 'one', start: 0, end: 0.3 },
      { text: 'two', start: 0.35, end: 0.6 },
      { text: 'three', start: 1.6, end: 1.9 },
    ];
    expect(buildSentences(words).length).toBe(2);
  });

  it('parses SRT and VTT and removes rolling duplicates', () => {
    const srt = `1\n00:00:01,000 --> 00:00:02,500\nHello <i>world</i>\n\n2\n00:00:02,500 --> 00:00:04,000\nHello world again\n`;
    const cues = parseSubtitles(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 1, end: 2.5, text: 'Hello world' });
    expect(cues[1]!.text).toBe('again');
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:03.000 align:start\nHi there\n';
    expect(parseSubtitles(vtt)[0]).toMatchObject({ start: 1, end: 3, text: 'Hi there' });
    const words = subtitlesToWords(srt);
    expect(words[0]!.start).toBeCloseTo(1);
    expect(words[words.length - 1]!.end).toBeCloseTo(4);
  });

  it('round-trips cues to SRT/VTT', () => {
    const words = fakeWords('This is a fairly long sentence that should be split into readable subtitle cues for viewers.');
    const cues = wordsToCues(words, 30);
    expect(cues.length).toBeGreaterThan(1);
    const srt = toSrt(cues);
    expect(srt).toMatch(/^1\n00:00:00,000 --> /);
    expect(parseSubtitles(srt)).toHaveLength(cues.length);
    expect(toVtt(cues).startsWith('WEBVTT')).toBe(true);
    expect(textInRange(words, 0, 1.2)).toBe('This is a');
  });
});
