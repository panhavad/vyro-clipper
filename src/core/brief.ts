import { contentWords, extractUrls, normalizeHashtag, uniq } from './text';

export interface BriefInsights {
  dos: string[];
  donts: string[];
  hashtags: string[];
  mentions: string[];
  urls: string[];
  minDuration?: number;
  maxDuration?: number;
  keywords: string[];
  focus: string[];
  wantsSubtitles: boolean;
  englishOnly: boolean;
  noMusic: boolean;
}

const DONT_RE = /\b(do not|don'?t|dont|never|avoid|not allowed|prohibited|must not|mustn'?t|shouldn'?t|should not|refrain|forbidden|banned|no (other |third[- ]party )?(music|logos?|brands?|watermarks?|profanity|swearing|cursing|nsfw|reposts?|ai|voice ?overs?|edits?|filters?)|without permission)\b/i;
const DO_RE = /\b(must|should|need to|needs to|have to|has to|make sure|ensure|required?|always|only|include|mention|use|tag|add|show|feature|focus on|highlight|clip|post|keep|put|start with|end with|credit|link)\b/i;
const GENERIC = new Set(
  (
    'tiktok tiktoks instagram youtube shorts reels reel video videos clip clips clipping content post posts posting campaign ' +
    'campaigns views view account accounts brand brands caption captions hashtag hashtags link links bio please make sure ' +
    'must should need dont don\'t do not use the this that these those your you our we they it its are is be with for from ' +
    'and but or any all each every only also when what where who how why x twitter vyro creator creators clipper clippers ' +
    'submit submission approved rejected rules rule brief guidelines guideline example examples note notes thanks thank'
  ).split(/\s+/),
);
const SENTENCE_STARTERS = new Set(
  'the a an please make do don\'t dont use only keep add include post clip if when this that these all every each no never always be try avoid focus ensure remember note'.split(' '),
);

function toSeconds(value: string, unit: string): number {
  const n = parseFloat(value);
  return /^m/i.test(unit) ? n * 60 : n;
}

function parseDurations(text: string): { min?: number; max?: number } {
  const t = text.toLowerCase();
  const unit = '(seconds?|secs?|s|minutes?|mins?|m)\\b';
  let min: number | undefined;
  let max: number | undefined;
  const between = new RegExp(`(?:between\\s+)?(\\d+(?:\\.\\d+)?)\\s*(?:${unit})?\\s*(?:-|–|to|and)\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`, 'i').exec(t);
  if (between) {
    const u2 = between[4]!;
    const u1 = between[2] ?? u2;
    const a = toSeconds(between[1]!, u1);
    const b = toSeconds(between[3]!, u2);
    if (a > 0 && b > a && b <= 600) {
      min = a;
      max = b;
    }
  }
  const minRe = new RegExp(`(?:at least|minimum(?: of)?|min(?:imum)?\\.?|(?<!no )longer than|over|more than|no shorter than)\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`, 'i').exec(t);
  if (minRe) min = toSeconds(minRe[1]!, minRe[2]!);
  const maxRe = new RegExp(`(?:under|less than|max(?:imum)?(?: of)?\\.?|no longer than|(?<!no )shorter than|up to|at most|below)\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`, 'i').exec(t);
  if (maxRe) max = toSeconds(maxRe[1]!, maxRe[2]!);
  if (min !== undefined && max !== undefined && max <= min) max = undefined;
  return { min, max };
}

function splitInstructions(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z•\-*])/)
    .map((l) => l.replace(/^[\s•\-*\d.)]+/, '').trim())
    .filter((l) => l.length >= 6 && l.length <= 400);
}

function extractKeywords(text: string): string[] {
  const counts = new Map<string, { label: string; n: number }>();
  const add = (label: string, weight: number) => {
    const key = label.toLowerCase();
    if (GENERIC.has(key) || key.length < 3) return;
    const cur = counts.get(key);
    if (cur) cur.n += weight;
    else counts.set(key, { label, n: weight });
  };
  for (const m of text.matchAll(/["“]([^"”\n]{3,40})["”]/g)) add(m[1]!.trim(), 3);
  for (const line of text.split(/\n|(?<=[.!?])\s+/)) {
    const tokens = line.split(/\s+/);
    tokens.forEach((tok, i) => {
      const clean = tok.replace(/[^\p{L}\p{N}'&-]/gu, '');
      if (!/^\p{Lu}[\p{L}\p{N}'&-]{2,}$/u.test(clean)) return;
      if (i === 0 && SENTENCE_STARTERS.has(clean.toLowerCase())) return;
      add(clean, 2);
    });
  }
  for (const w of contentWords(text)) if (w.length > 4) add(w, 0.5);
  return [...counts.values()]
    .filter((c) => c.n >= 1.5)
    .sort((a, b) => b.n - a.n)
    .slice(0, 15)
    .map((c) => c.label);
}

function extractFocus(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = /\b(?:focus on|clip|highlight|moments? (?:where|when|of|about|with)|feature|featuring|about)\s+([^.;\n]{4,90})/i.exec(line);
    if (m && !DONT_RE.test(line)) out.push(m[1]!.trim().replace(/[,:]+$/, ''));
  }
  return uniq(out).slice(0, 6);
}

export function parseBrief(text: string): BriefInsights {
  const lines = splitInstructions(text);
  const donts: string[] = [];
  const dos: string[] = [];
  for (const line of lines) {
    if (DONT_RE.test(line)) donts.push(line);
    else if (DO_RE.test(line)) dos.push(line);
  }
  const { min, max } = parseDurations(text);
  const hashtags = uniq((text.match(/(?:^|\s)#[\p{L}\p{N}_]{2,}/gu) ?? []).map((h) => normalizeHashtag(h)).filter(Boolean));
  const mentions = uniq((text.match(/(?:^|[\s(])@[A-Za-z0-9_.]{2,30}/g) ?? []).map((m) => m.trim().replace(/^\(/, '').replace(/[.]+$/, '')));
  const lower = text.toLowerCase();
  return {
    dos: uniq(dos).slice(0, 25),
    donts: uniq(donts).slice(0, 25),
    hashtags,
    mentions,
    urls: extractUrls(text),
    minDuration: min,
    maxDuration: max,
    keywords: extractKeywords(text),
    focus: extractFocus(lines),
    wantsSubtitles: /\b(subtitles?|captions? on screen|closed captions?|burned[- ]in captions?)\b/.test(lower),
    englishOnly: /\benglish\b/.test(lower) && /\b(only|must|required?|audio|subtitles?)\b/.test(lower),
    noMusic: /\b(no|without|avoid|don'?t (add|use|include)|do not (add|use|include))\s+(any\s+)?(background |copyrighted |other |added |extra )?music\b/.test(lower),
  };
}
