import type { Campaign, CampaignRules, Sentence } from './types';
import { formatTime } from './text';

export interface LlmClipSuggestion {
  s0: number;
  s1: number;
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  scores: { hook: number; flow: number; value: number; trend: number };
  why: string;
}

export interface PromptChunk {
  system: string;
  user: string;
  firstSentence: number;
  lastSentence: number;
}

function rulesSummary(rules: CampaignRules): string {
  const lines = [
    rules.minDurationSec ? `- Minimum length: ${rules.minDurationSec}s` : '',
    rules.maxDurationSec ? `- Maximum length: ${rules.maxDurationSec}s` : '',
    rules.keywords.length ? `- Brand/topic keywords: ${rules.keywords.slice(0, 12).join(', ')}` : '',
    rules.briefDos.length ? `- Do: ${rules.briefDos.slice(0, 8).join(' | ')}` : '',
    rules.briefDonts.length ? `- Don't: ${rules.briefDonts.slice(0, 8).join(' | ')}` : '',
  ].filter(Boolean);
  return lines.join('\n') || '- (no extra rules)';
}

/**
 * Builds prompts asking an LLM to pick viral segments. The transcript is given as numbered sentences
 * so the model returns sentence indices (robust: no hallucinated timestamps).
 */
export function buildClipPrompts(sentences: Sentence[], opts: { campaign?: Pick<Campaign, 'name' | 'brand' | 'brief'>; rules: CampaignRules; minDuration: number; maxDuration: number; count: number; prompt?: string; maxChars?: number }): PromptChunk[] {
  const maxChars = opts.maxChars ?? 48000;
  const chunks: Sentence[][] = [];
  let cur: Sentence[] = [];
  let size = 0;
  for (const s of sentences) {
    const line = s.text.length + 16;
    if (size + line > maxChars && cur.length) {
      chunks.push(cur);
      // Overlap a little so moments on a boundary aren't lost.
      cur = cur.slice(-6);
      size = cur.reduce((n, x) => n + x.text.length + 16, 0);
    }
    cur.push(s);
    size += line;
  }
  if (cur.length) chunks.push(cur);
  const totalDur = Math.max(1, (sentences[sentences.length - 1]?.end ?? 1) - (sentences[0]?.start ?? 0));
  const brief = (opts.campaign?.brief ?? '').slice(0, 4000);
  const system = `You are a world-class short-form video editor (TikTok, Reels, YouTube Shorts) who finds the most viral moments in long videos for paid clipping campaigns.
Rules for every clip:
- It must be a self-contained moment with a strong hook in the first 3 seconds and a satisfying payoff/ending.
- Length between ${opts.minDuration}s and ${opts.maxDuration}s (use the [start-end] times to check).
- Start at the beginning of a sentence; never start mid-thought ("and", "so", "but").
- Prefer emotional peaks, surprising facts, conflict, humour, big numbers, strong opinions, story payoffs.
- Clips must not overlap.
Score each clip 0-100 on: hook (scroll-stopping opening), flow (coherent, complete), value (insight/entertainment), trend (emotion, shareability).
Reply with JSON only: {"clips":[{"start":<first sentence #>,"end":<last sentence #>,"title":"<max 60 chars>","hook":"<on-screen hook, max 40 chars>","caption":"<1-2 sentence post caption>","hashtags":["#tag"],"scores":{"hook":0,"flow":0,"value":0,"trend":0},"why":"<short reason>"}]}`;
  return chunks.map((chunk) => {
    const chunkDur = Math.max(1, chunk[chunk.length - 1]!.end - chunk[0]!.start);
    const want = Math.max(1, Math.round((opts.count * chunkDur) / totalDur));
    const transcript = chunk.map((s) => `#${s.index} [${formatTime(s.start)}-${formatTime(s.end)}] ${s.text}`).join('\n');
    const user = `Campaign: ${opts.campaign?.name ?? 'n/a'}${opts.campaign?.brand ? ` (brand: ${opts.campaign.brand})` : ''}
Campaign rules:
${rulesSummary(opts.rules)}
${brief ? `Campaign brief (excerpt):\n${brief}\n` : ''}${opts.prompt ? `Editor request: find moments about "${opts.prompt}".\n` : ''}
Return the ${want} best clip${want > 1 ? 's' : ''} from this transcript:
${transcript}`;
    return { system, user, firstSentence: chunk[0]!.index, lastSentence: chunk[chunk.length - 1]!.index };
  });
}

/** Extracts the first JSON object from a model response (tolerates code fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in model response');
  return JSON.parse(body.slice(start, end + 1));
}

const n100 = (v: unknown, d = 60) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.max(0, Math.min(100, Math.round(x))) : d;
};

export function parseClipSuggestions(text: string, sentences: Sentence[], bounds?: { first: number; last: number }): LlmClipSuggestion[] {
  const json = extractJson(text) as { clips?: unknown[] };
  const list = Array.isArray(json?.clips) ? json.clips : Array.isArray(json) ? (json as unknown[]) : [];
  const first = bounds?.first ?? 0;
  const last = bounds?.last ?? sentences.length - 1;
  const out: LlmClipSuggestion[] = [];
  for (const item of list) {
    const c = item as Record<string, unknown>;
    let s0 = Math.round(Number(c.start ?? c.s0 ?? c.from));
    let s1 = Math.round(Number(c.end ?? c.s1 ?? c.to));
    if (!Number.isFinite(s0) || !Number.isFinite(s1)) continue;
    if (s1 < s0) [s0, s1] = [s1, s0];
    s0 = Math.max(first, Math.min(last, s0));
    s1 = Math.max(s0, Math.min(last, s1));
    const scores = (c.scores ?? {}) as Record<string, unknown>;
    out.push({
      s0,
      s1,
      title: String(c.title ?? '').slice(0, 80),
      hook: String(c.hook ?? c.title ?? '').slice(0, 60),
      caption: String(c.caption ?? '').slice(0, 400),
      hashtags: Array.isArray(c.hashtags) ? c.hashtags.map(String).slice(0, 8) : [],
      scores: { hook: n100(scores.hook), flow: n100(scores.flow), value: n100(scores.value), trend: n100(scores.trend) },
      why: String(c.why ?? c.reason ?? '').slice(0, 200),
    });
  }
  return out;
}

export function buildTranslationPrompt(lines: string[], language: string): { system: string; user: string } {
  return {
    system: `Translate each numbered subtitle line into ${language}. Keep the numbering, keep lines short and natural for on-screen captions. Reply with JSON only: {"lines":["..."]}`,
    user: lines.map((l, i) => `${i + 1}. ${l}`).join('\n'),
  };
}
