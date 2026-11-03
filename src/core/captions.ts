import { EMOTION_WORDS, VALUE_WORDS, censorWord, emojiFor, endsSentence, isProfane, normalizeToken } from './text';
import type { Word } from './types';

export type CaptionAnimation = 'pop' | 'bounce' | 'karaoke' | 'fade' | 'typewriter' | 'slide' | 'none';

export interface CaptionStyle {
  id: string;
  name: string;
  description: string;
  font: string;
  weight: number;
  /** Font size as a fraction of the canvas width */
  sizeRatio: number;
  uppercase: boolean;
  color: string;
  activeColor: string;
  strokeColor: string;
  /** Stroke width as a fraction of font size */
  strokeRatio: number;
  shadow: { color: string; blur: number; dx: number; dy: number } | null;
  /** Rounded box behind the active word */
  activeBg?: string;
  /** Box behind the whole page (subtitle look) */
  pageBg?: string;
  animation: CaptionAnimation;
  maxWords: number;
  maxCharsPerLine: number;
  maxLines: number;
  activeScale: number;
  keywordColors: string[];
  lineHeight: number;
  /** Rotation in degrees applied to the active word (playful styles) */
  tilt?: number;
}

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: 'bold-pop',
    name: 'Bold Pop',
    description: 'Heavy uppercase words, active word pops in yellow (the classic viral-shorts look).',
    font: 'Montserrat',
    weight: 900,
    sizeRatio: 0.078,
    uppercase: true,
    color: '#FFFFFF',
    activeColor: '#FFE81F',
    strokeColor: '#000000',
    strokeRatio: 0.18,
    shadow: { color: 'rgba(0,0,0,0.55)', blur: 10, dx: 0, dy: 6 },
    animation: 'pop',
    maxWords: 3,
    maxCharsPerLine: 14,
    maxLines: 2,
    activeScale: 1.14,
    keywordColors: ['#3CFF6B', '#FFE81F'],
    lineHeight: 1.12,
  },
  {
    id: 'beast',
    name: 'Beast',
    description: 'Chunky comic font, one or two words at a time, colour-cycling highlights.',
    font: 'Luckiest Guy',
    weight: 400,
    sizeRatio: 0.092,
    uppercase: true,
    color: '#FFFFFF',
    activeColor: '#FFD400',
    strokeColor: '#000000',
    strokeRatio: 0.2,
    shadow: { color: 'rgba(0,0,0,0.7)', blur: 0, dx: 0, dy: 7 },
    animation: 'bounce',
    maxWords: 2,
    maxCharsPerLine: 12,
    maxLines: 1,
    activeScale: 1.2,
    keywordColors: ['#FFD400', '#38E54D', '#FF3B3B', '#29B6FF'],
    lineHeight: 1.05,
    tilt: -3,
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    description: 'Sentence chunks that fill with colour as each word is spoken.',
    font: 'Poppins',
    weight: 800,
    sizeRatio: 0.064,
    uppercase: false,
    color: '#FFFFFF',
    activeColor: '#22E3FF',
    strokeColor: '#000000',
    strokeRatio: 0.14,
    shadow: { color: 'rgba(0,0,0,0.5)', blur: 8, dx: 0, dy: 4 },
    animation: 'karaoke',
    maxWords: 6,
    maxCharsPerLine: 20,
    maxLines: 2,
    activeScale: 1,
    keywordColors: ['#22E3FF'],
    lineHeight: 1.18,
  },
  {
    id: 'boxed',
    name: 'Boxed',
    description: 'Active word sits on a vivid rounded box.',
    font: 'Archivo Black',
    weight: 400,
    sizeRatio: 0.07,
    uppercase: true,
    color: '#FFFFFF',
    activeColor: '#FFFFFF',
    strokeColor: '#000000',
    strokeRatio: 0.1,
    shadow: { color: 'rgba(0,0,0,0.45)', blur: 8, dx: 0, dy: 4 },
    activeBg: '#7C3AED',
    animation: 'pop',
    maxWords: 3,
    maxCharsPerLine: 15,
    maxLines: 2,
    activeScale: 1.06,
    keywordColors: ['#FFE81F'],
    lineHeight: 1.22,
  },
  {
    id: 'neon',
    name: 'Neon',
    description: 'Condensed glowing captions for night / gaming vibes.',
    font: 'Bebas Neue',
    weight: 400,
    sizeRatio: 0.1,
    uppercase: true,
    color: '#F5FFFD',
    activeColor: '#00FFC6',
    strokeColor: '#002B22',
    strokeRatio: 0.06,
    shadow: { color: 'rgba(0,255,198,0.85)', blur: 24, dx: 0, dy: 0 },
    animation: 'fade',
    maxWords: 3,
    maxCharsPerLine: 16,
    maxLines: 2,
    activeScale: 1.08,
    keywordColors: ['#FF4DF0'],
    lineHeight: 1.02,
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    description: 'Words appear one by one as they are spoken.',
    font: 'Anton',
    weight: 400,
    sizeRatio: 0.082,
    uppercase: true,
    color: '#FFFFFF',
    activeColor: '#FF4D4D',
    strokeColor: '#000000',
    strokeRatio: 0.15,
    shadow: { color: 'rgba(0,0,0,0.6)', blur: 6, dx: 0, dy: 5 },
    animation: 'typewriter',
    maxWords: 4,
    maxCharsPerLine: 16,
    maxLines: 2,
    activeScale: 1.05,
    keywordColors: ['#FFE81F'],
    lineHeight: 1.1,
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Clean sentence-case captions with a soft shadow.',
    font: 'Inter',
    weight: 700,
    sizeRatio: 0.054,
    uppercase: false,
    color: '#FFFFFF',
    activeColor: '#FFFFFF',
    strokeColor: 'rgba(0,0,0,0.0)',
    strokeRatio: 0,
    shadow: { color: 'rgba(0,0,0,0.85)', blur: 14, dx: 0, dy: 3 },
    animation: 'fade',
    maxWords: 7,
    maxCharsPerLine: 26,
    maxLines: 2,
    activeScale: 1,
    keywordColors: ['#FFD166'],
    lineHeight: 1.25,
  },
  {
    id: 'subtitle',
    name: 'Subtitle',
    description: 'Broadcast-style subtitles on a translucent bar (great for "subtitles required").',
    font: 'Inter',
    weight: 600,
    sizeRatio: 0.048,
    uppercase: false,
    color: '#FFFFFF',
    activeColor: '#FFFFFF',
    strokeColor: 'rgba(0,0,0,0)',
    strokeRatio: 0,
    shadow: null,
    pageBg: 'rgba(0,0,0,0.68)',
    animation: 'none',
    maxWords: 12,
    maxCharsPerLine: 32,
    maxLines: 2,
    activeScale: 1,
    keywordColors: [],
    lineHeight: 1.3,
  },
  {
    id: 'marker',
    name: 'Marker',
    description: 'Hand-drawn marker font with hot-pink highlights.',
    font: 'Permanent Marker',
    weight: 400,
    sizeRatio: 0.074,
    uppercase: false,
    color: '#FFFFFF',
    activeColor: '#FF2D95',
    strokeColor: '#111111',
    strokeRatio: 0.14,
    shadow: { color: 'rgba(0,0,0,0.5)', blur: 6, dx: 2, dy: 5 },
    animation: 'slide',
    maxWords: 3,
    maxCharsPerLine: 16,
    maxLines: 2,
    activeScale: 1.1,
    keywordColors: ['#FFE81F', '#2DE1FC'],
    lineHeight: 1.15,
    tilt: 2,
  },
  {
    id: 'comic',
    name: 'Comic',
    description: 'Yellow comic-book lettering with bold outline.',
    font: 'Bangers',
    weight: 400,
    sizeRatio: 0.095,
    uppercase: true,
    color: '#FFE600',
    activeColor: '#FFFFFF',
    strokeColor: '#000000',
    strokeRatio: 0.2,
    shadow: { color: 'rgba(0,0,0,0.8)', blur: 0, dx: 4, dy: 6 },
    animation: 'pop',
    maxWords: 3,
    maxCharsPerLine: 14,
    maxLines: 2,
    activeScale: 1.16,
    keywordColors: ['#FF3B3B'],
    lineHeight: 1.05,
  },
];

export const DEFAULT_CAPTION_STYLE = 'bold-pop';

export function getCaptionStyle(id: string | undefined): CaptionStyle {
  return CAPTION_STYLES.find((s) => s.id === id) ?? CAPTION_STYLES[0]!;
}

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
  keyword: boolean;
  colorIdx: number;
}

export interface CaptionPage {
  start: number;
  end: number;
  lines: CaptionWord[][];
  emoji?: string;
}

export interface PaginateOptions {
  emojis: boolean;
  keywordHighlight: boolean;
  uppercase?: boolean;
  maxWords?: number;
  censor: boolean;
  keywords?: string[];
}

function isKeyword(word: string, campaignKeywords: Set<string>): boolean {
  const n = normalizeToken(word);
  if (!n) return false;
  if (campaignKeywords.has(n)) return true;
  if (/\d/.test(n) || n.includes('$')) return true;
  if (n.length >= 4 && (EMOTION_WORDS.has(n) || VALUE_WORDS.has(n))) return true;
  return false;
}

export function displayWord(text: string, uppercase: boolean, censor: boolean): string {
  let t = text.replace(/[.,;:]+$/, '').replace(/^["“]|["”]$/g, '');
  if (censor && isProfane(t)) t = censorWord(t);
  return uppercase ? t.toUpperCase() : t;
}

/** Groups timed words into caption pages/lines according to a style. */
export function paginateCaptions(words: Word[], style: CaptionStyle, opts: PaginateOptions): CaptionPage[] {
  const maxWords = Math.max(1, opts.maxWords ?? style.maxWords);
  const maxChars = style.maxCharsPerLine * style.maxLines;
  const uppercase = opts.uppercase ?? style.uppercase;
  const campaignKeywords = new Set((opts.keywords ?? []).flatMap((k) => k.toLowerCase().split(/\s+/)).map(normalizeToken).filter((k) => k.length > 2));
  const pages: CaptionPage[] = [];
  let current: CaptionWord[] = [];
  let colorCursor = 0;
  let lastEmojiAt = -10;

  const flush = () => {
    if (!current.length) return;
    const lines: CaptionWord[][] = [[]];
    let lineLen = 0;
    for (const w of current) {
      const len = w.text.length + (lineLen ? 1 : 0);
      if (lineLen && lineLen + len > style.maxCharsPerLine && lines.length < style.maxLines) {
        lines.push([]);
        lineLen = 0;
      }
      lines[lines.length - 1]!.push(w);
      lineLen += w.text.length + (lineLen ? 1 : 0);
    }
    const page: CaptionPage = { start: current[0]!.start, end: current[current.length - 1]!.end, lines };
    if (opts.emojis) {
      const emo = current.map((w) => emojiFor(w.text)).find(Boolean);
      if (emo && page.start - lastEmojiAt > 2.2) {
        page.emoji = emo;
        lastEmojiAt = page.start;
      }
    }
    pages.push(page);
    current = [];
  };

  words.forEach((w, i) => {
    const text = displayWord(w.text, uppercase, opts.censor);
    if (!text) return;
    const prev = words[i - 1];
    const charsSoFar = current.reduce((n, c) => n + c.text.length + 1, 0);
    if (current.length && (current.length >= maxWords || (prev && w.start - prev.end > 0.6) || charsSoFar + text.length > maxChars)) flush();
    const keyword = opts.keywordHighlight && isKeyword(w.text, campaignKeywords);
    current.push({ text, start: w.start, end: w.end, keyword, colorIdx: keyword ? colorCursor++ : 0 });
    if (endsSentence(w.text)) flush();
  });
  flush();

  // Hold each page on screen until the next one starts (max 0.6s) so captions don't flicker.
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1];
    pages[i]!.end = next ? Math.min(Math.max(pages[i]!.end, next.start - 0.001), pages[i]!.end + 0.6) : pages[i]!.end + 0.5;
  }
  return pages;
}

export function pageAt(pages: CaptionPage[], t: number): CaptionPage | undefined {
  let lo = 0;
  let hi = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pages[mid]!;
    if (t < p.start) hi = mid - 1;
    else if (t > p.end) lo = mid + 1;
    else return p;
  }
  return undefined;
}
