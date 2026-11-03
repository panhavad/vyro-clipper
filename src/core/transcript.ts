import type { Sentence, TimeRange, Word } from './types';
import { endsSentence } from './text';

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Cleans raw ASR words: trims text, drops empties, enforces monotonic, non-zero timings. */
export function normalizeWords(raw: Array<{ text: string; start: number | null | undefined; end: number | null | undefined; p?: number }>, duration?: number): Word[] {
  const out: Word[] = [];
  let lastEnd = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    const text = (r.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let start = Number.isFinite(r.start as number) ? (r.start as number) : lastEnd;
    let end = Number.isFinite(r.end as number) ? (r.end as number) : NaN;
    if (!Number.isFinite(end)) {
      const next = raw.slice(i + 1).find((n) => Number.isFinite(n.start as number));
      end = next ? (next.start as number) : start + 0.3;
    }
    if (start < lastEnd - 0.5) start = lastEnd; // ASR chunk overlap glitch
    start = Math.max(start, out.length ? out[out.length - 1]!.start : 0);
    if (end <= start) end = start + 0.08;
    if (duration && end > duration) end = Math.max(start + 0.05, duration);
    // Very long single words are almost always a timestamp glitch at a pause.
    if (end - start > 2.5) end = start + Math.min(2.5, 0.12 * Math.max(3, text.length));
    out.push(r.p !== undefined ? { text, start, end, p: r.p } : { text, start, end });
    lastEnd = end;
  }
  return out;
}

/** Splits a word stream into sentences using punctuation, long pauses and length limits. */
export function buildSentences(words: Word[], opts: { pause?: number; maxWords?: number; maxDuration?: number } = {}): Sentence[] {
  const pause = opts.pause ?? 1.0;
  const maxWords = opts.maxWords ?? 32;
  const maxDuration = opts.maxDuration ?? 16;
  const hasPunctuation = words.some((w) => endsSentence(w.text));
  const sentences: Sentence[] = [];
  let w0 = 0;
  const flush = (w1: number) => {
    if (w1 <= w0) return;
    const first = words[w0]!;
    const last = words[w1 - 1]!;
    sentences.push({
      index: sentences.length,
      start: first.start,
      end: last.end,
      text: words
        .slice(w0, w1)
        .map((w) => w.text)
        .join(' ')
        .replace(/\s+([,.!?])/g, '$1'),
      w0,
      w1,
    });
    w0 = w1;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    const count = i + 1 - w0;
    const dur = w.end - words[w0]!.start;
    const gap = next ? next.start - w.end : 0;
    const punctBreak = endsSentence(w.text);
    // Without punctuation (some ASR outputs), rely on shorter pauses.
    const pauseBreak = gap >= (hasPunctuation ? pause : Math.min(pause, 0.6));
    const hardBreak = count >= maxWords || dur >= maxDuration;
    const softBreak = count >= maxWords * 0.6 && /[,;:]$/.test(w.text);
    if (!next || punctBreak || pauseBreak || hardBreak || softBreak) flush(i + 1);
  }
  return sentences;
}

/** Index of the first word whose end is after t. */
export function wordIndexAt(words: Word[], t: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid]!.end <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Words whose midpoint lies inside [start, end]. */
export function wordsInRange(words: Word[], start: number, end: number): Word[] {
  const out: Word[] = [];
  for (let i = Math.max(0, wordIndexAt(words, start) - 1); i < words.length; i++) {
    const w = words[i]!;
    if (w.start > end) break;
    const mid = (w.start + w.end) / 2;
    if (mid >= start && mid <= end) out.push(w);
  }
  return out;
}

export function textInRange(words: Word[], start: number, end: number): string {
  return wordsInRange(words, start, end)
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+([,.!?])/g, '$1');
}

export function sentencesInRange(sentences: Sentence[], range: TimeRange): Sentence[] {
  return sentences.filter((s) => s.end > range.start && s.start < range.end);
}

/** Distributes a cue's duration over its words proportionally to their length (for subtitle imports / segment ASR). */
export function cueToWords(cue: Cue): Word[] {
  const tokens = cue.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const weights = tokens.map((t) => Math.max(2, t.replace(/[^\p{L}\p{N}]/gu, '').length) + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0.05, cue.end - cue.start);
  const words: Word[] = [];
  let t = cue.start;
  tokens.forEach((text, i) => {
    const d = (span * weights[i]!) / total;
    words.push({ text, start: t, end: t + d });
    t += d;
  });
  return words;
}

function parseTimestamp(ts: string): number {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/.exec(ts.trim());
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  return h * 3600 + parseInt(m[2]!, 10) * 60 + parseInt(m[3]!, 10) + ms / 1000;
}

/** Parses SRT or WebVTT text into cues. Strips styling tags. */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r/g, '').replace(/^\uFEFF/, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [a, b] = lines[timeIdx]!.split('-->');
    const start = parseTimestamp(a ?? '');
    const end = parseTimestamp((b ?? '').trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const body = lines
      .slice(timeIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]+\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (body) cues.push({ start, end, text: body });
  }
  // Rolling (YouTube auto-caption style) cues repeat the previous line; drop the repeated prefix.
  for (let i = 1; i < cues.length; i++) {
    const prev = cues[i - 1]!;
    const cur = cues[i]!;
    if (cur.text.startsWith(prev.text) && cur.text.length > prev.text.length) {
      cur.text = cur.text.slice(prev.text.length).trim();
    }
  }
  return cues.filter((c) => c.text);
}

export function subtitlesToWords(text: string): Word[] {
  return parseSubtitles(text).flatMap(cueToWords);
}

/** Groups words into readable subtitle cues. */
export function wordsToCues(words: Word[], maxChars = 42, maxDuration = 5): Cue[] {
  const cues: Cue[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((w) => w.text).join(' ') });
    cur = [];
  };
  for (const w of words) {
    const len = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (cur.length && (len > maxChars || w.end - cur[0]!.start > maxDuration || w.start - cur[cur.length - 1]!.end > 1.2)) flush();
    cur.push(w);
    if (endsSentence(w.text)) flush();
  }
  flush();
  return cues;
}

function fmt(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${fmt(c.start, ',')} --> ${fmt(c.end, ',')}\n${c.text}\n`).join('\n');
}

export function toVtt(cues: Cue[]): string {
  return 'WEBVTT\n\n' + cues.map((c) => `${fmt(c.start, '.')} --> ${fmt(c.end, '.')}\n${c.text}\n`).join('\n');
}

export function plainText(words: Word[]): string {
  return words
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+([,.!?])/g, '$1');
}
