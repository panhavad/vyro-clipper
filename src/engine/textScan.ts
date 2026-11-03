import { CanvasSink, type InputVideoTrack } from 'mediabunny';
import { analyzeTextFrames, type GrayFrame, type TextScan } from '../core/textScan';
import { openInput } from './media';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Seconds between a sample and its "pair" frame: captions don't change that fast, moving hands/bodies do. */
const PAIR_GAP = 0.12;

export interface SampledFrames {
  frames: GrayFrame[];
  pairs: Array<GrayFrame | undefined>;
  /** Source time of each frame */
  times: number[];
  /** Canvas snapshots (only when requested, for debugging) */
  bitmaps?: ImageBitmap[];
}

/** Decodes ~12–32 frames (plus a pair frame 0.12 s later for each) spread across the video, as brightness maps. */
export async function sampleGrayFrames(video: InputVideoTrack, duration: number, opts: { signal?: AbortSignal; keepBitmaps?: boolean } = {}): Promise<SampledFrames> {
  const vertical = video.displayHeight > video.displayWidth;
  const sink = new CanvasSink(video, vertical ? { width: 540, poolSize: 1 } : { height: 540, poolSize: 1 });
  const n = Math.max(12, Math.min(32, Math.round(duration / 2)));
  const base = Array.from({ length: n }, (_, i) => duration * (0.03 + (0.94 * (i + 0.5)) / n));
  const times = base.flatMap((t) => (t + PAIR_GAP < duration ? [t, t + PAIR_GAP] : [t]));
  const out: SampledFrames = { frames: [], pairs: [], times: [], bitmaps: opts.keepBitmaps ? [] : undefined };
  let i = 0;
  for await (const wrapped of sink.canvasesAtTimestamps(times)) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const t = times[i++]!;
    const isPair = !base.includes(t);
    if (!wrapped) {
      if (isPair && out.pairs.length < out.frames.length) out.pairs.push(undefined);
      continue;
    }
    const canvas = wrapped.canvas;
    const ctx = canvas.getContext('2d') as Ctx2D | null;
    if (!ctx) continue;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const gray = new Uint8Array(canvas.width * canvas.height);
    for (let p = 0, j = 0; j < gray.length; p += 4, j++) gray[j] = Math.max(px[p]!, px[p + 1]!, px[p + 2]!);
    const frame: GrayFrame = { width: canvas.width, height: canvas.height, data: gray };
    if (isPair) {
      if (out.pairs.length < out.frames.length) out.pairs.push(frame);
    } else {
      // A base frame whose pair was missing: keep the arrays aligned.
      while (out.pairs.length < out.frames.length) out.pairs.push(undefined);
      out.frames.push(frame);
      out.times.push(t);
      if (out.bitmaps) out.bitmaps.push(await createImageBitmap(canvas));
    }
  }
  while (out.pairs.length < out.frames.length) out.pairs.push(undefined);
  return out;
}

/** Samples frames across the whole source and detects burned-in captions / titles / logos. */
export async function scanBurnedInText(file: Blob, duration: number, opts: { signal?: AbortSignal } = {}): Promise<TextScan | undefined> {
  const input = openInput(file);
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !(await video.canDecode()) || !(duration > 0)) return undefined;
    const { frames, pairs } = await sampleGrayFrames(video, duration, opts);
    return analyzeTextFrames(frames, { pairs });
  } finally {
    input.dispose();
  }
}
