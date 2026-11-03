import { cueToWords, normalizeWords, subtitlesToWords } from '../core/transcript';
import type { AudioEnvelope, Transcript, Word } from '../core/types';
import { hasWebGPU } from '../shared/env';
import { WHISPER_MODELS, type AppSettings } from '../shared/settings';
import { decodeSpeechAudio } from './audio';

export interface TranscribeProgress {
  stage: 'model' | 'decode' | 'asr';
  pct: number;
  detail: string;
}

export interface TranscribeOptions {
  settings: AppSettings;
  language: string;
  duration: number;
  start?: number;
  end?: number;
  onProgress: (p: TranscribeProgress) => void;
  onPartial?: (words: Word[]) => void;
  signal?: AbortSignal;
}

const CHUNK_SECONDS = 120;
const OVERLAP_SECONDS = 1.5;

// ---------------------------------------------------------------------------------------------
// Local Whisper worker (singleton, model stays warm between projects)

type Pending = { resolve: (words: Word[]) => void; reject: (e: Error) => void };
let worker: Worker | null = null;
let workerKey = '';
let readyPromise: Promise<string> | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;
let downloadListener: ((p: TranscribeProgress) => void) | null = null;
const downloadState = new Map<string, { loaded: number; total: number }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as Record<string, unknown>;
    if (msg.type === 'download' && msg.status === 'progress' && typeof msg.file === 'string') {
      downloadState.set(msg.file, { loaded: Number(msg.loaded) || 0, total: Number(msg.total) || 0 });
      let loaded = 0;
      let total = 0;
      for (const v of downloadState.values()) {
        loaded += v.loaded;
        total += v.total;
      }
      downloadListener?.({ stage: 'model', pct: total ? (loaded / total) * 100 : 0, detail: `Downloading speech model ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB (cached after first use)` });
    } else if (msg.type === 'result') {
      const p = pending.get(msg.id as number);
      pending.delete(msg.id as number);
      p?.resolve(msg.words as Word[]);
    } else if (msg.type === 'error') {
      const err = new Error(String(msg.message));
      if (typeof msg.id === 'number') {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        p?.reject(err);
      } else readyReject?.(err);
    } else if (msg.type === 'ready') readyResolve?.(String(msg.device));
  };
  return worker;
}

let readyResolve: ((device: string) => void) | null = null;
let readyReject: ((e: Error) => void) | null = null;

async function ensureModel(settings: AppSettings, onProgress: (p: TranscribeProgress) => void): Promise<string> {
  const device = settings.asr.device === 'auto' ? ((await hasWebGPU()) ? 'webgpu' : 'wasm') : settings.asr.device;
  const key = `${settings.asr.localModel}|${device}`;
  downloadListener = onProgress;
  if (readyPromise && workerKey === key) return readyPromise;
  const w = getWorker();
  workerKey = key;
  downloadState.clear();
  readyPromise = new Promise<string>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  w.postMessage({
    type: 'load',
    model: settings.asr.localModel,
    device,
  });
  try {
    return await readyPromise;
  } catch (err) {
    readyPromise = null;
    if (device === 'webgpu') {
      // Some GPUs/drivers fail to initialise; fall back to WASM transparently.
      return ensureModel({ ...settings, asr: { ...settings.asr, device: 'wasm' } }, onProgress);
    }
    throw err;
  }
}

function runLocal(audio: Float32Array, offset: number, language: string, multilingual: boolean): Promise<Word[]> {
  const id = nextId++;
  return new Promise<Word[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ type: 'transcribe', id, audio, offset, language, multilingual }, [audio.buffer]);
  });
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible cloud transcription (OpenAI, Groq, self-hosted faster-whisper servers...)

export function encodeWav(pcm: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buffer);
  const writeStr = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function runCloud(audio: Float32Array, offset: number, settings: AppSettings, language: string, signal?: AbortSignal): Promise<Word[]> {
  const cfg = settings.asr.openai;
  if (!cfg.apiKey) throw new Error('Add your speech-to-text API key in Settings (or switch to the free in-browser Whisper).');
  const form = new FormData();
  form.append('file', encodeWav(audio, 16000), 'audio.wav');
  form.append('model', cfg.model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    body: form,
    signal,
  });
  if (!res.ok) throw new Error(`Transcription API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { words?: Array<{ word: string; start: number; end: number }>; segments?: Array<{ text: string; start: number; end: number }> };
  if (json.words?.length) return json.words.map((w) => ({ text: w.word, start: w.start + offset, end: w.end + offset }));
  return (json.segments ?? []).flatMap((s) => cueToWords({ start: s.start + offset, end: s.end + offset, text: s.text }));
}

// ---------------------------------------------------------------------------------------------

/** Transcribes a media file with word timestamps and returns the loudness envelope. */
export async function transcribeFile(file: Blob, opts: TranscribeOptions): Promise<{ transcript: Transcript; envelope: AudioEnvelope }> {
  const { settings } = opts;
  const local = settings.asr.engine === 'local';
  const model = WHISPER_MODELS.find((m) => m.id === settings.asr.localModel) ?? WHISPER_MODELS[1]!;
  if (local) {
    opts.onProgress({ stage: 'model', pct: 0, detail: 'Loading speech model…' });
    const device = await ensureModel(settings, opts.onProgress);
    opts.onProgress({ stage: 'model', pct: 100, detail: `Speech model ready (${device === 'webgpu' ? 'GPU' : 'CPU'})` });
  }
  const start = opts.start ?? 0;
  const end = opts.end ?? opts.duration;
  const span = Math.max(1, end - start);
  const words: Word[] = [];
  let overlap = new Float32Array(0);
  let decodedUntil = start;

  const envelope = await decodeSpeechAudio(file, {
    start,
    end,
    chunkSeconds: CHUNK_SECONDS,
    signal: opts.signal,
    onProgress: (t) => {
      decodedUntil = t;
    },
    onChunk: async (pcm, chunkStart) => {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const audio = new Float32Array(overlap.length + pcm.length);
      audio.set(overlap);
      audio.set(pcm, overlap.length);
      const offset = chunkStart - overlap.length / 16000;
      overlap = pcm.slice(Math.max(0, pcm.length - Math.round(OVERLAP_SECONDS * 16000)));
      opts.onProgress({ stage: 'asr', pct: ((chunkStart - start) / span) * 100, detail: `Transcribing ${Math.round(chunkStart - start)}s / ${Math.round(span)}s (decoded ${Math.round(decodedUntil - start)}s)` });
      const got = local ? await runLocal(audio, offset, opts.language, model.multilingual) : await runCloud(audio, offset, settings, opts.language, opts.signal);
      // Overlap de-duplication: words of the previous chunk that run past the boundary may be truncated,
      // so drop them and let this chunk (which has 1.5s of extra context) provide them again.
      while (words.length && words[words.length - 1]!.end > chunkStart - 0.05) words.pop();
      let lastEnd = words.length ? words[words.length - 1]!.end : -Infinity;
      for (const w of got) {
        if (w.start >= lastEnd - 0.05) {
          words.push(w);
          lastEnd = w.end;
        }
      }
      opts.onPartial?.(words);
    },
  });

  const transcript: Transcript = {
    words: normalizeWords(words, opts.duration),
    language: opts.language || 'en',
    duration: opts.duration,
    engine: local ? 'whisper-local' : 'openai',
    model: local ? model.id : settings.asr.openai.model,
    createdAt: Date.now(),
  };
  opts.onProgress({ stage: 'asr', pct: 100, detail: `Transcribed ${transcript.words.length} words` });
  return { transcript, envelope };
}

export function transcriptFromSubtitles(text: string, duration: number, language = 'en'): Transcript {
  return { words: normalizeWords(subtitlesToWords(text), duration), language, duration, engine: 'subtitles', createdAt: Date.now() };
}
