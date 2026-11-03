import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import { frameSchedule } from '../core/timeline';
import type { TextBand } from '../core/textScan';
import type { AudioEnvelope, Clip, SourceMeta, Word } from '../core/types';
import { decodeAudioFile, decodeAudioRange } from './audio';
import { buildClipAudio } from './audioMix';
import { buildRenderPlan, drawFrame, type DrawCache } from './compositor';
import { ensureFontsLoaded } from './fonts';
import { openInput } from './media';

export interface RenderOptions {
  file: Blob;
  clip: Clip;
  words: Word[];
  meta: SourceMeta;
  keywords?: string[];
  logo?: ImageBitmap;
  music?: Blob;
  envelope?: AudioEnvelope;
  /** Text already burned into the source, kept clear of overlays */
  textBands?: TextBand[];
  brandColors?: [string, string];
  onProgress?: (pct: number, detail: string) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  blob: Blob;
  durationSec: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec?: string;
}

/** Renders a clip to an MP4 entirely in the browser (WebCodecs + Mediabunny). */
export async function renderClip(opts: RenderOptions): Promise<RenderResult> {
  const { clip, meta, signal } = opts;
  await ensureFontsLoaded();
  const input = openInput(opts.file);
  try {
    const vtrack = meta.hasVideo ? await input.getPrimaryVideoTrack() : null;
    const atrack = meta.hasAudio ? await input.getPrimaryAudioTrack() : null;
    const rp = buildRenderPlan({
      clip,
      words: opts.words,
      srcW: vtrack ? vtrack.displayWidth : 0,
      srcH: vtrack ? vtrack.displayHeight : 0,
      keywords: opts.keywords,
      logo: opts.logo,
      envelope: opts.envelope,
      textBands: opts.textBands,
      brandColors: opts.brandColors,
    });
    const { width, height } = rp;
    const fps = clip.edit.fps;
    const frames = frameSchedule(rp.plan, fps);
    if (!frames.length) throw new Error('Clip is empty after cuts.');

    const videoCodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height });
    if (!videoCodec) throw new Error('This browser cannot encode video. Use a recent Chrome/Edge (WebCodecs).');

    opts.onProgress?.(1, 'Preparing audio…');
    let audio: [Float32Array, Float32Array] | undefined;
    let rate = 48000;
    let audioCodec: string | undefined;
    if (atrack && (await atrack.canDecode())) {
      const first = rp.plan.segments[0]!.srcStart;
      const last = rp.plan.segments[rp.plan.segments.length - 1]!.srcEnd;
      const decoded = await decodeAudioRange(atrack, first, last);
      rate = decoded.sampleRate;
      const music = opts.music && clip.edit.musicEnabled ? await decodeAudioFile(opts.music, rate) : undefined;
      audio = buildClipAudio(decoded, first, rp.plan, rp.outWords, clip.edit, music);
      audioCodec = (await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: rate })) ?? undefined;
      if (!audioCodec) audio = undefined;
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(videoSource, { frameRate: fps });
    const audioSource = audio && audioCodec ? new AudioSampleSource({ codec: audioCodec as 'aac' | 'opus', quality: QUALITY_HIGH }) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    let audioCursor = 0;
    const totalAudio = audio ? audio[0].length : 0;
    const pushAudioUntil = async (t: number) => {
      if (!audio || !audioSource) return;
      const until = Math.min(totalAudio, Math.round(t * rate));
      while (audioCursor < until) {
        const n = Math.min(rate, until - audioCursor);
        const data = new Float32Array(n * 2);
        data.set(audio[0].subarray(audioCursor, audioCursor + n), 0);
        data.set(audio[1].subarray(audioCursor, audioCursor + n), n);
        const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: rate, timestamp: audioCursor / rate });
        await audioSource.add(sample);
        sample.close();
        audioCursor += n;
      }
    };

    const cache: DrawCache = {};
    const sink = vtrack && (await vtrack.canDecode()) ? new CanvasSink(vtrack, { poolSize: 3 }) : null;
    const iterator = sink ? sink.canvasesAtTimestamps(frames.map((f) => f.src)) : null;
    let lastFrame: CanvasImageSource | null = null;
    try {
      for (let i = 0; i < frames.length; i++) {
        if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
        if (iterator) {
          const r = await iterator.next();
          if (!r.done && r.value) lastFrame = r.value.canvas;
        }
        const f = frames[i]!;
        drawFrame(ctx, lastFrame, f.out, rp, cache);
        await videoSource.add(f.out, 1 / fps);
        if (i % fps === 0) await pushAudioUntil(f.out + 1);
        if (i % 10 === 0) opts.onProgress?.(2 + (i / frames.length) * 96, `Rendering ${Math.round(f.out)}s / ${Math.round(rp.plan.duration)}s`);
      }
      await pushAudioUntil(Infinity);
      videoSource.close();
      audioSource?.close();
      opts.onProgress?.(99, 'Finalizing MP4…');
      await output.finalize();
    } catch (err) {
      await iterator?.return?.(undefined);
      await output.cancel().catch(() => undefined);
      throw err;
    }
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('Encoder produced no data.');
    opts.onProgress?.(100, 'Done');
    return { blob: new Blob([buffer], { type: 'video/mp4' }), durationSec: rp.plan.duration, width, height, videoCodec, audioCodec };
  } finally {
    input.dispose();
  }
}

/** Renders a single still (thumbnail / cover) of a clip. */
export async function renderStill(opts: Omit<RenderOptions, 'onProgress' | 'signal' | 'music'> & { at?: number; scale?: number; type?: string }): Promise<Blob> {
  await ensureFontsLoaded();
  const input = openInput(opts.file);
  try {
    const vtrack = opts.meta.hasVideo ? await input.getPrimaryVideoTrack() : null;
    const rp = buildRenderPlan({
      clip: opts.clip,
      words: opts.words,
      srcW: vtrack?.displayWidth ?? 0,
      srcH: vtrack?.displayHeight ?? 0,
      keywords: opts.keywords,
      logo: opts.logo,
      envelope: opts.envelope,
      textBands: opts.textBands,
      brandColors: opts.brandColors,
      scale: opts.scale ?? 0.5,
    });
    const t = Math.min(rp.plan.duration - 0.05, opts.at ?? Math.min(1.2, rp.plan.duration / 3));
    const srcT = frameSchedule(rp.plan, 30).find((f) => f.out >= t)?.src ?? opts.clip.start;
    let frame: CanvasImageSource | null = null;
    if (vtrack && (await vtrack.canDecode())) {
      const sink = new CanvasSink(vtrack, { width: Math.min(vtrack.displayWidth, 1280), poolSize: 1 });
      frame = (await sink.getCanvas(srcT))?.canvas ?? null;
    }
    // Draw with the decoded frame's own size so crops stay correct after downscaling.
    if (frame && 'width' in frame) {
      rp.srcW = (frame as { width: number }).width;
      rp.srcH = (frame as { height: number }).height;
    }
    const canvas = new OffscreenCanvas(rp.width, rp.height);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    drawFrame(ctx, frame, t, rp, {});
    return await canvas.convertToBlob({ type: opts.type ?? 'image/jpeg', quality: 0.85 });
  } finally {
    input.dispose();
  }
}
