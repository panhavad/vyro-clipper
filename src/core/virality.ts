import {
  BOLD_CLAIM_WORDS,
  CONJUNCTION_STARTS,
  CURIOSITY_PATTERNS,
  EMOTION_WORDS,
  FILLER_WORDS,
  LAUGH_PATTERN,
  NUMBER_PATTERN,
  STAKES_PATTERN,
  STORY_PATTERNS,
  VALUE_WORDS,
  clamp,
  isQuestion,
  normalizeToken,
  tokenize,
} from './text';
import { wordsInRange } from './transcript';
import type { AudioEnvelope, Sentence, ViralScores, Word } from './types';

export interface DetectOptions {
  minDuration: number;
  maxDuration: number;
  /** Desired clip count; 0 = automatic */
  targetCount: number;
  /** Campaign keywords + prompt terms used for relevance */
  keywords: string[];
  prompt?: string;
  rangeStart?: number;
  rangeEnd?: number;
  /** Max allowed overlap between selected clips (fraction of the shorter clip) */
  maxOverlap?: number;
  /** When jump cuts are on, pauses above this are shortened; used to estimate final duration */
  silenceThreshold?: number;
  /** Ideal duration in seconds (defaults to platform sweet spot inside [min, max]) */
  idealDuration?: number;
}

export interface Candidate {
  start: number;
  end: number;
  s0: number;
  s1: number;
  /** Estimated duration after jump cuts */
  effectiveDuration: number;
  text: string;
  scores: ViralScores;
  reasons: string[];
}

interface SentenceFeatures {
  hook: number;
  emotion: number;
  value: number;
  story: number;
  numbers: number;
  laugh: boolean;
  exclaim: number;
  question: boolean;
  conjStart: boolean;
  complete: boolean;
  danglingEnd: boolean;
  relevance: number;
  wordCount: number;
  tokens: string[];
}

export type { SentenceFeatures };

export function buildSentenceFeatures(sentences: Sentence[], keywords: string[]): SentenceFeatures[] {
  return sentences.map((s) => sentenceFeatures(s, keywords));
}

/** Scores how strongly a line works as the opening of a short (0..100). */
export function hookScore(text: string): number {
  const tokens = tokenize(text);
  if (!tokens.length) return 0;
  let s = 30;
  const first = tokens[0]!;
  if (isQuestion(text)) s += 22;
  if (/^(what|why|how|who|when|where|which|did|do|does|is|are|can|could|would|should|have|has|imagine)$/.test(first)) s += 8;
  if (tokens.some((t) => t === 'you' || t === 'your' || t === "you're")) s += 8;
  const bold = tokens.filter((t) => BOLD_CLAIM_WORDS.has(t)).length;
  s += Math.min(3, bold) * 7;
  if (NUMBER_PATTERN.test(text)) s += 12;
  if (CURIOSITY_PATTERNS.some((re) => re.test(text))) s += 16;
  if (STAKES_PATTERN.test(text)) s += 12;
  const emo = tokens.filter((t) => EMOTION_WORDS.has(t)).length;
  s += Math.min(2, emo) * 6;
  if (/!/.test(text)) s += 5;
  if (CONJUNCTION_STARTS.has(first) || FILLER_WORDS.has(first)) s -= 18;
  if (tokens.length < 3) s -= 12;
  else if (tokens.length > 28) s -= 8;
  return clamp(Math.round(s), 0, 100);
}

function relevanceHits(text: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  const lower = ` ${text.toLowerCase()} `;
  let hits = 0;
  for (const k of keywords) {
    const kk = k.toLowerCase().trim();
    if (!kk) continue;
    if (kk.includes(' ') ? lower.includes(kk) : new RegExp(`[^a-z0-9]${kk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es|ed|ing)?[^a-z0-9]`).test(lower)) hits++;
  }
  return hits;
}

function sentenceFeatures(s: Sentence, keywords: string[]): SentenceFeatures {
  const tokens = tokenize(s.text);
  const trimmed = s.text.trim();
  return {
    hook: hookScore(trimmed),
    emotion: tokens.filter((t) => EMOTION_WORDS.has(t)).length + (trimmed.match(/\b[A-Z]{3,}\b/g)?.length ?? 0) * 0.5,
    value: tokens.filter((t) => VALUE_WORDS.has(t)).length,
    story: STORY_PATTERNS.filter((re) => re.test(trimmed)).length,
    numbers: (trimmed.match(/\$?\d[\d,.]*\s?(k|m|million|billion|thousand|percent|%)?/gi) ?? []).length,
    laugh: LAUGH_PATTERN.test(trimmed),
    exclaim: (trimmed.match(/!/g) ?? []).length,
    question: isQuestion(trimmed),
    conjStart: tokens.length > 0 && (CONJUNCTION_STARTS.has(tokens[0]!) || FILLER_WORDS.has(tokens[0]!)),
    complete: /[.!?…]["')\]]*$/.test(trimmed),
    danglingEnd: /[,;:-]$/.test(trimmed) || CONJUNCTION_STARTS.has(normalizeToken(trimmed.split(/\s+/).pop() ?? '')),
    relevance: relevanceHits(trimmed, keywords),
    wordCount: tokens.length,
    tokens,
  };
}

function energyAt(env: AudioEnvelope | undefined, start: number, end: number): { mean: number; peak: number; variance: number } {
  if (!env || !env.rms.length) return { mean: 0, peak: 0, variance: 0 };
  const a = clamp(Math.floor(start / env.hop), 0, env.rms.length - 1);
  const b = clamp(Math.ceil(end / env.hop), a + 1, env.rms.length);
  let sum = 0;
  let peak = 0;
  for (let i = a; i < b; i++) {
    const v = env.rms[i]!;
    sum += v;
    if (v > peak) peak = v;
  }
  const mean = sum / (b - a);
  let varSum = 0;
  for (let i = a; i < b; i++) varSum += (env.rms[i]! - mean) ** 2;
  return { mean, peak, variance: Math.sqrt(varSum / (b - a)) };
}

function effectiveDurationOf(words: Word[], start: number, end: number, silenceThreshold?: number): number {
  const raw = end - start;
  if (!silenceThreshold) return raw;
  const inRange = wordsInRange(words, start, end);
  let removed = 0;
  for (let i = 1; i < inRange.length; i++) {
    const gap = inRange[i]!.start - inRange[i - 1]!.end;
    if (gap > silenceThreshold) removed += gap - 0.15;
  }
  return Math.max(0, raw - removed);
}

function overlapFraction(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return inter / Math.max(0.001, Math.min(a.end - a.start, b.end - b.start));
}

/** Converts the weighted sub-score average into the 0..99 virality scale (most usable clips land 60–95). */
export function calibrateTotal(raw: number): number {
  return clamp(Math.round(18 + raw * 0.86), 1, 99);
}

export function scoreWindow(
  sentences: Sentence[],
  feats: SentenceFeatures[],
  words: Word[],
  env: AudioEnvelope | undefined,
  s0: number,
  s1: number,
  opts: DetectOptions,
): Candidate {
  const first = sentences[s0]!;
  const last = sentences[s1]!;
  const start = Math.max(0, first.start - 0.12);
  const nextStart = sentences[s1 + 1]?.start ?? last.end + 1;
  const end = Math.min(last.end + 0.3, Math.max(last.end, nextStart - 0.05));
  const duration = end - start;
  const effective = effectiveDurationOf(words, start, end, opts.silenceThreshold);
  const fs = feats.slice(s0, s1 + 1);
  const totalWords = Math.max(1, fs.reduce((n, f) => n + f.wordCount, 0));
  const reasons: string[] = [];
  const median = env?.median ?? 0;

  // ---- Hook: what's said in the first ~4 seconds + delivery energy
  const hookText = wordsInRange(words, start, start + 4.5)
    .map((w) => w.text)
    .join(' ');
  let hook = Math.max(hookScore(hookText), feats[s0]!.hook * 0.95);
  if (feats[s0]!.question) reasons.push('Opens with a question');
  const openEnergy = energyAt(env, start, start + 3);
  if (median > 0 && openEnergy.mean > 0) {
    const lift = openEnergy.mean / median - 1;
    hook += clamp(lift * 25, -8, 12);
    if (lift > 0.25) reasons.push(`Energetic opening (+${Math.round(lift * 100)}% louder than average)`);
  }
  if (feats[s0]!.conjStart) {
    hook -= 6;
  } else if (hook >= 70) reasons.push('Strong hook in the first seconds');
  hook = clamp(hook, 0, 100);

  // ---- Flow: complete thought, pacing, length fit
  let flow = 55;
  if (last.text && feats[s1]!.complete) flow += 12;
  if (feats[s1]!.danglingEnd) flow -= 14;
  if (feats[s0]!.conjStart) flow -= 10;
  let longPauses = 0;
  const inRange = wordsInRange(words, start, end);
  for (let i = 1; i < inRange.length; i++) if (inRange[i]!.start - inRange[i - 1]!.end > 1.5) longPauses++;
  flow -= Math.min(4, longPauses) * 5;
  const wps = totalWords / Math.max(1, effective);
  if (wps >= 2.1 && wps <= 3.9) flow += 10;
  else if (wps < 1.5) flow -= 14;
  else if (wps > 4.6) flow -= 6;
  const ideal = opts.idealDuration ?? clamp(38, opts.minDuration, opts.maxDuration);
  const fit = 1 - Math.min(1, Math.abs(effective - ideal) / Math.max(10, ideal));
  flow += Math.round(fit * 14);
  const lastIsQuestion = feats[s1]!.question;
  if (!lastIsQuestion && fs.some((f) => f.question) && s1 > s0) {
    flow += 6; // question answered inside the clip
    reasons.push('Sets up a question and pays it off');
  }
  flow = clamp(flow, 0, 100);

  // ---- Value: information density, specifics, storytelling
  const valueDensity = fs.reduce((n, f) => n + f.value, 0) / totalWords;
  const numbers = fs.reduce((n, f) => n + f.numbers, 0);
  const story = fs.reduce((n, f) => n + f.story, 0);
  const entities = (inRange.map((w) => w.text).join(' ').match(/(?<![.!?]\s)\b[A-Z][a-z]{2,}\b/g) ?? []).length;
  let value = 38 + valueDensity * 260 + Math.min(4, numbers) * 6 + Math.min(3, story) * 8 + Math.min(5, entities) * 1.5;
  if (numbers >= 2) reasons.push('Concrete numbers / stakes');
  if (story >= 2) reasons.push('Story arc (setup → payoff)');
  if (valueDensity > 0.05) reasons.push('Actionable / insight-dense');
  value = clamp(value, 0, 100);

  // ---- Trend: emotion, excitement, laughter, energy dynamics
  const emoDensity = fs.reduce((n, f) => n + f.emotion, 0) / totalWords;
  const exclaims = fs.reduce((n, f) => n + f.exclaim, 0);
  const laughs = fs.filter((f) => f.laugh).length;
  const e = energyAt(env, start, end);
  let trend = 34 + emoDensity * 320 + Math.min(4, exclaims) * 4 + Math.min(2, laughs) * 9;
  if (median > 0) {
    trend += clamp((e.mean / median - 1) * 22, -10, 14);
    trend += clamp((e.variance / Math.max(0.02, median)) * 8, 0, 10);
    if (e.peak > 0.92) trend += 4;
  }
  if (emoDensity > 0.04) reasons.push('Emotional / high-intensity language');
  if (laughs) reasons.push('Laughter / funny moment');
  trend = clamp(trend, 0, 100);

  // ---- Relevance to campaign brief / prompt
  const hits = fs.reduce((n, f) => n + f.relevance, 0);
  const hasKeywords = opts.keywords.length > 0;
  const relevance = hasKeywords ? clamp(35 + hits * 16, 0, 100) : 50;
  if (hasKeywords && hits > 0) {
    const matched = opts.keywords.filter((k) => relevanceHits(fs.map((f) => f.tokens.join(' ')).join(' '), [k]) > 0 || relevanceHits(inRange.map((w) => w.text).join(' '), [k]) > 0);
    if (matched.length) reasons.push(`On-brief: ${matched.slice(0, 3).join(', ')}`);
  }

  let raw = 0.32 * hook + 0.22 * flow + 0.22 * value + 0.24 * trend;
  if (hasKeywords) raw = opts.prompt ? raw * 0.65 + relevance * 0.35 : raw * 0.85 + relevance * 0.15;
  const total = calibrateTotal(raw);

  return {
    start,
    end,
    s0,
    s1,
    effectiveDuration: effective,
    text: sentences
      .slice(s0, s1 + 1)
      .map((s) => s.text)
      .join(' '),
    scores: {
      total,
      hook: Math.round(hook),
      flow: Math.round(flow),
      value: Math.round(value),
      trend: Math.round(trend),
      relevance: Math.round(relevance),
    },
    reasons: [...new Set(reasons)].slice(0, 5),
  };
}

export function autoClipCount(analyzedDuration: number): number {
  return clamp(Math.round(analyzedDuration / 75), 3, 30);
}

export function promptKeywords(prompt: string | undefined): string[] {
  if (!prompt) return [];
  return tokenize(prompt).filter((t) => t.length > 3 && !['moments', 'moment', 'clips', 'clip', 'about', 'where', 'when', 'with', 'that', 'find', 'funny', 'best'].includes(t));
}

/** Finds the most viral, non-overlapping moments in a transcript. */
export function detectViralMoments(words: Word[], sentences: Sentence[], env: AudioEnvelope | undefined, opts: DetectOptions): Candidate[] {
  const minD = Math.max(3, Math.min(opts.minDuration, opts.maxDuration));
  const maxD = Math.max(minD + 2, opts.maxDuration);
  const rangeStart = opts.rangeStart ?? 0;
  const rangeEnd = opts.rangeEnd ?? Infinity;
  const keywords = [...opts.keywords, ...promptKeywords(opts.prompt)];
  const o: DetectOptions = { ...opts, minDuration: minD, maxDuration: maxD, keywords };
  const usable = sentences.filter((s) => s.start >= rangeStart - 0.01 && s.end <= rangeEnd + 0.01);
  if (!usable.length) return [];
  const feats = sentences.map((s) => sentenceFeatures(s, keywords));
  const firstIdx = usable[0]!.index;
  const lastIdx = usable[usable.length - 1]!.index;

  const candidates: Candidate[] = [];
  for (let i = firstIdx; i <= lastIdx; i++) {
    for (let j = i; j <= lastIdx; j++) {
      const span = sentences[j]!.end - sentences[i]!.start;
      if (span > maxD + 6) break;
      const c = scoreWindow(sentences, feats, words, env, i, j, o);
      const d = opts.silenceThreshold ? c.effectiveDuration : c.end - c.start;
      if (d < minD || c.end - c.start > maxD + 2) continue;
      candidates.push(c);
    }
  }

  // Whole source is shorter than the minimum: return it as a single clip.
  if (!candidates.length) {
    const c = scoreWindow(sentences, feats, words, env, firstIdx, lastIdx, o);
    return [c];
  }

  candidates.sort((a, b) => b.scores.total - a.scores.total || b.scores.hook - a.scores.hook);
  const analyzed = usable[usable.length - 1]!.end - usable[0]!.start;
  const want = opts.targetCount > 0 ? opts.targetCount : autoClipCount(analyzed);
  const maxOverlap = opts.maxOverlap ?? 0.15;
  const picked: Candidate[] = [];
  for (const c of candidates) {
    if (picked.length >= want) break;
    if (picked.some((p) => overlapFraction(p, c) > maxOverlap)) continue;
    picked.push(c);
  }
  // Automatic mode drops weak clips but always keeps a few.
  const result = opts.targetCount > 0 ? picked : picked.filter((c, idx) => idx < 3 || c.scores.total >= 55);
  return result.sort((a, b) => b.scores.total - a.scores.total);
}

/** Fallback for sources without speech (gameplay, music): picks the most dynamic windows by loudness. */
export function detectByEnergy(env: AudioEnvelope, duration: number, opts: DetectOptions): Candidate[] {
  const len = clamp(opts.idealDuration ?? Math.max(opts.minDuration, 30), opts.minDuration, opts.maxDuration);
  if (duration <= len) {
    return [{ start: 0, end: duration, s0: 0, s1: 0, effectiveDuration: duration, text: '', scores: { total: 50, hook: 50, flow: 50, value: 40, trend: 50, relevance: 50 }, reasons: ['Whole video'] }];
  }
  const step = Math.max(2, len / 3);
  const windows: Candidate[] = [];
  for (let t = opts.rangeStart ?? 0; t + len <= Math.min(duration, opts.rangeEnd ?? duration); t += step) {
    const e = energyAt(env, t, t + len);
    const open = energyAt(env, t, t + 3);
    const hook = clamp(40 + (open.mean / Math.max(0.01, env.median) - 1) * 40, 0, 100);
    const trend = clamp(35 + (e.variance / Math.max(0.02, env.median)) * 30 + (e.peak > 0.9 ? 10 : 0), 0, 100);
    const flow = 55;
    const value = 40;
    const total = calibrateTotal(0.35 * hook + 0.2 * flow + 0.15 * value + 0.3 * trend);
    windows.push({ start: t, end: t + len, s0: 0, s1: 0, effectiveDuration: len, text: '', scores: { total, hook: Math.round(hook), flow, value, trend: Math.round(trend), relevance: 50 }, reasons: ['High audio energy'] });
  }
  windows.sort((a, b) => b.scores.total - a.scores.total);
  const want = opts.targetCount > 0 ? opts.targetCount : Math.min(10, autoClipCount(duration));
  const picked: Candidate[] = [];
  for (const w of windows) {
    if (picked.length >= want) break;
    if (picked.some((p) => overlapFraction(p, w) > 0.1)) continue;
    picked.push(w);
  }
  return picked;
}
