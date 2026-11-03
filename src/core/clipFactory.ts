import { makeHookOverlay, makeTitle, topicalHashtags } from './hooks';
import { buildSentenceFeatures, calibrateTotal, scoreWindow, type Candidate, type DetectOptions } from './virality';
import { planClip } from './timeline';
import { shortId, truncateWords, cleanSpokenText } from './text';
import type { AudioEnvelope, CampaignRules, Clip, EditSettings, Sentence, Word } from './types';
import type { LlmClipSuggestion } from './llm';

export interface ClipFactoryContext {
  projectId: string;
  campaignId?: string;
  rules: CampaignRules;
  edit: EditSettings;
  words: Word[];
  sentences: Sentence[];
  sourceDuration: number;
}

/** Extends a clip (by whole sentences) until its post-jump-cut duration satisfies the campaign minimum. */
export function ensureMinDuration(range: { start: number; end: number }, ctx: ClipFactoryContext, minDuration: number): { start: number; end: number } {
  const r = { ...range };
  const opts = { jumpCuts: ctx.edit.jumpCuts, silenceThreshold: ctx.edit.silenceThreshold, removeFillers: ctx.edit.removeFillers };
  for (let guard = 0; guard < 40; guard++) {
    const dur = planClip(r, ctx.words, [], opts).duration;
    if (dur >= minDuration + 0.5) break;
    const next = ctx.sentences.find((s) => s.start >= r.end - 0.05);
    const prev = [...ctx.sentences].reverse().find((s) => s.end <= r.start + 0.05);
    if (next) r.end = Math.min(ctx.sourceDuration, next.end + 0.3);
    else if (prev) r.start = Math.max(0, prev.start - 0.12);
    else {
      r.end = Math.min(ctx.sourceDuration, r.end + (minDuration + 0.5 - dur));
      if (r.end >= ctx.sourceDuration) r.start = Math.max(0, r.start - (minDuration + 0.5 - dur));
      break;
    }
  }
  return r;
}

export function candidateToClip(c: Candidate, ctx: ClipFactoryContext, extra?: Partial<Pick<Clip, 'title' | 'hook' | 'caption' | 'hashtags' | 'engine'>>): Clip {
  const now = Date.now();
  const range = ctx.rules.minDurationSec ? ensureMinDuration(c, ctx, ctx.rules.minDurationSec) : { start: c.start, end: c.end };
  const title = extra?.title?.trim() || makeTitle(c.text);
  // The hook box wraps to up to three lines, so a whole question/sentence usually fits without "…".
  const hook = extra?.hook?.trim() ? extra.hook.trim().toUpperCase() : makeHookOverlay(makeTitle(c.text, 52), 54);
  const caption = extra?.caption?.trim() || truncateWords(cleanSpokenText(title), 120);
  return {
    id: shortId('clip_'),
    projectId: ctx.projectId,
    campaignId: ctx.campaignId,
    start: range.start,
    end: range.end,
    title,
    hook,
    caption,
    hashtags: extra?.hashtags?.length ? extra.hashtags : topicalHashtags(c.text, ctx.rules.keywords),
    scores: c.scores,
    reasons: c.reasons,
    transcript: c.text,
    manualCuts: [],
    edit: { ...ctx.edit },
    status: 'draft',
    engine: extra?.engine ?? 'heuristic',
    createdAt: now,
    updatedAt: now,
  };
}

/** Merges LLM suggestions with heuristic scoring (60% model / 40% signal-based) for stable virality scores. */
export function llmSuggestionsToClips(
  suggestions: LlmClipSuggestion[],
  ctx: ClipFactoryContext,
  env: AudioEnvelope | undefined,
  detect: DetectOptions,
): Clip[] {
  const clips: Clip[] = [];
  const used: Array<{ start: number; end: number }> = [];
  const feats = buildSentenceFeatures(ctx.sentences, detect.keywords);
  for (const s of suggestions) {
    if (!ctx.sentences[s.s0] || !ctx.sentences[s.s1]) continue;
    const heur = scoreWindow(ctx.sentences, feats, ctx.words, env, s.s0, s.s1, detect);
    if (used.some((u) => Math.min(u.end, heur.end) - Math.max(u.start, heur.start) > 0.3 * Math.min(u.end - u.start, heur.end - heur.start))) continue;
    const llmRaw = 0.32 * s.scores.hook + 0.22 * s.scores.flow + 0.22 * s.scores.value + 0.24 * s.scores.trend;
    const total = Math.round(0.6 * calibrateTotal(llmRaw) + 0.4 * heur.scores.total);
    const blended: Candidate = {
      ...heur,
      scores: {
        total: Math.min(99, total),
        hook: Math.round((s.scores.hook + heur.scores.hook) / 2),
        flow: Math.round((s.scores.flow + heur.scores.flow) / 2),
        value: Math.round((s.scores.value + heur.scores.value) / 2),
        trend: Math.round((s.scores.trend + heur.scores.trend) / 2),
        relevance: heur.scores.relevance,
      },
      reasons: [s.why, ...heur.reasons].filter(Boolean).slice(0, 5),
    };
    used.push(heur);
    clips.push(candidateToClip(blended, ctx, { title: s.title, hook: s.hook, caption: s.caption, hashtags: s.hashtags, engine: 'llm' }));
  }
  return clips.sort((a, b) => b.scores.total - a.scores.total);
}
