import { candidateToClip, llmSuggestionsToClips, type ClipFactoryContext } from '../core/clipFactory';
import { editSettingsForCampaign } from '../core/defaults';
import { buildClipPrompts, parseClipSuggestions, type LlmClipSuggestion } from '../core/llm';
import { buildSentences } from '../core/transcript';
import type { Campaign, CampaignRules, Clip, Project, SourceMeta, Transcript } from '../core/types';
import { detectByEnergy, detectViralMoments, type Candidate, type DetectOptions } from '../core/virality';
import { defaultRules, effectiveRules } from '../core/vyro';
import type { AppSettings } from '../shared/settings';
import { analyzeFaces } from './faces';
import { chatJson, llmConfig } from './llmClient';
import { probeMedia } from './media';
import { readMedia } from './storage';
import { transcribeFile } from './transcriber';

export interface PipelineDeps {
  settings: AppSettings;
  campaign?: Campaign;
  /** Persists the patch and refreshes the UI */
  update: (patch: Partial<Project>) => Promise<void>;
  /**
   * Applies a patch to one clip in the live state. Used for background results (face tracking) so
   * edits/deletions the user makes meanwhile are never overwritten. `expected` guards against stale ranges.
   */
  patchClip?: (clipId: string, patch: Partial<Clip>, expected?: { start: number; end: number }) => void;
  signal?: AbortSignal;
  /** Force re-detection even if clips exist */
  redetect?: boolean;
}

export async function getProjectFile(project: Project): Promise<File> {
  const file = project.source.storedAs ? await readMedia(project.source.storedAs) : undefined;
  if (!file) throw new Error('Source video is missing from browser storage. Re-add the file to this project.');
  return file;
}

export function rulesFor(campaign: Campaign | undefined): CampaignRules {
  return campaign ? effectiveRules(campaign) : defaultRules();
}

function evenlySpaced(duration: number, opts: DetectOptions): Candidate[] {
  const len = Math.min(duration, Math.max(opts.minDuration, Math.min(opts.maxDuration, 30)));
  const count = Math.max(1, Math.min(opts.targetCount || 5, Math.floor(duration / len)));
  const step = count > 1 ? (duration - len) / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) => ({
    start: i * step,
    end: i * step + len,
    s0: 0,
    s1: 0,
    effectiveDuration: len,
    text: '',
    scores: { total: 50, hook: 50, flow: 50, value: 50, trend: 50, relevance: 50 },
    reasons: ['Evenly spaced (no speech or audio detected)'],
  }));
}

/** Generates clips from an already transcribed project (fast; used for "Regenerate"). */
export async function detectClips(project: Project & { meta: SourceMeta; transcript: Transcript }, deps: PipelineDeps): Promise<Clip[]> {
  const { settings, campaign } = deps;
  const rules = rulesFor(campaign);
  const gen = project.settings;
  const words = project.transcript.words;
  const sentences = buildSentences(words);
  const edit = editSettingsForCampaign(settings.defaultEdit, rules, settings.brand);
  const detect: DetectOptions = {
    minDuration: gen.minDuration,
    maxDuration: gen.maxDuration,
    targetCount: gen.clipCount,
    keywords: rules.keywords,
    prompt: gen.prompt || undefined,
    rangeStart: gen.rangeStart,
    rangeEnd: gen.rangeEnd,
    silenceThreshold: edit.jumpCuts ? edit.silenceThreshold : undefined,
  };
  const ctx: ClipFactoryContext = { projectId: project.id, campaignId: campaign?.id, rules, edit, words, sentences, sourceDuration: project.meta.duration };

  const llm = gen.useLlm ? llmConfig(settings) : undefined;
  if (llm && sentences.length >= 6) {
    try {
      const prompts = buildClipPrompts(sentences, {
        campaign,
        rules,
        minDuration: gen.minDuration,
        maxDuration: gen.maxDuration,
        count: gen.clipCount || Math.max(3, Math.round(project.meta.duration / 75)),
        prompt: gen.prompt,
      });
      const suggestions: LlmClipSuggestion[] = [];
      for (let i = 0; i < prompts.length; i++) {
        const p = prompts[i]!;
        await deps.update({ progress: { step: 'AI is picking viral moments', pct: (i / prompts.length) * 100, detail: `Chunk ${i + 1} of ${prompts.length}` } });
        const text = await chatJson(llm, p.system, p.user, deps.signal);
        suggestions.push(...parseClipSuggestions(text, sentences, { first: p.firstSentence, last: p.lastSentence }));
      }
      const clips = llmSuggestionsToClips(suggestions, ctx, project.envelope, detect);
      if (clips.length) return clips;
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      console.warn('LLM clip detection failed, using built-in engine', err);
    }
  }
  let candidates: Candidate[];
  if (words.length >= 20) candidates = detectViralMoments(words, sentences, project.envelope, detect);
  else if (project.envelope?.rms.length) candidates = detectByEnergy(project.envelope, project.meta.duration, detect);
  else candidates = evenlySpaced(project.meta.duration, detect);
  return candidates.map((c) => candidateToClip(c, ctx));
}

/** Full pipeline: probe → transcribe → detect viral moments → face-track reframing. Resumable. */
export async function processProject(project: Project, deps: PipelineDeps): Promise<void> {
  const { settings, signal } = deps;
  const file = await getProjectFile(project);
  let meta = project.meta;
  if (!meta) {
    await deps.update({ status: 'probing', progress: { step: 'Reading video', pct: 0 }, error: undefined });
    const probed = await probeMedia(file);
    if (!probed.canDecodeVideo && probed.hasVideo && !probed.hasAudio) throw new Error(`This browser can't decode the video codec (${probed.videoCodec}).`);
    meta = {
      duration: probed.duration,
      width: probed.width,
      height: probed.height,
      fps: probed.fps,
      hasAudio: probed.hasAudio && probed.canDecodeAudio,
      hasVideo: probed.hasVideo && probed.canDecodeVideo,
      videoCodec: probed.videoCodec,
      audioCodec: probed.audioCodec,
    };
    await deps.update({ meta });
  }

  let transcript = project.transcript;
  let envelope = project.envelope;
  if (!transcript) {
    if (meta.hasAudio) {
      await deps.update({ status: 'transcribing', progress: { step: 'Transcribing speech', pct: 0 } });
      const res = await transcribeFile(file, {
        settings,
        language: project.settings.language,
        duration: meta.duration,
        start: project.settings.rangeStart,
        end: project.settings.rangeEnd,
        signal,
        onProgress: (p) => void deps.update({ progress: { step: p.stage === 'model' ? 'Loading AI speech model' : 'Transcribing speech', pct: p.pct, detail: p.detail } }),
      });
      transcript = res.transcript;
      envelope = res.envelope;
    } else {
      transcript = { words: [], language: project.settings.language, duration: meta.duration, engine: 'manual', createdAt: Date.now() };
    }
    await deps.update({ transcript, envelope });
  }

  let clips = project.clips;
  if (!clips.length || deps.redetect) {
    await deps.update({ status: 'detecting', progress: { step: 'Finding viral moments', pct: 0 } });
    clips = await detectClips({ ...project, meta, transcript, envelope }, deps);
    await deps.update({ clips });
  }

  const needsReframe = meta.hasVideo && Math.abs(meta.width / Math.max(1, meta.height) - 9 / 16) > 0.1;
  if (settings.faceTracking && needsReframe) {
    await deps.update({ status: 'reframing', progress: { step: 'AI reframing (tracking speakers)', pct: 0 } });
    const updated = [...clips];
    for (let i = 0; i < updated.length; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const c = updated[i]!;
      if (c.reframe) continue;
      try {
        const track = await analyzeFaces(file, {
          start: c.start,
          end: c.end,
          signal,
          onProgress: (pct) => void deps.update({ progress: { step: 'AI reframing (tracking speakers)', pct: ((i + pct / 100) / updated.length) * 100, detail: `Clip ${i + 1} of ${updated.length}` } }),
        });
        if (!track) continue;
        updated[i] = { ...c, reframe: track, updatedAt: Date.now() };
        if (deps.patchClip) deps.patchClip(c.id, { reframe: track }, { start: c.start, end: c.end });
        else await deps.update({ clips: [...updated] });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        console.warn('Face tracking failed; using centre crop', err);
        break;
      }
    }
  }
  await deps.update({ status: 'ready', progress: undefined, error: undefined });
}
