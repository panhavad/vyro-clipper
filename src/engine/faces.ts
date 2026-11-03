import { FaceDetector } from '@mediapipe/tasks-vision';
import visionWasmLoader from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import visionWasmBinary from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import { CanvasSink } from 'mediabunny';
import { buildReframeTrack, type FaceSample } from '../core/reframe';
import type { ReframeTrack } from '../core/types';
import { assetUrl } from '../shared/env';
import { openInput } from './media';

let detectorPromise: Promise<FaceDetector> | null = null;

async function getDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      // WASM is bundled (no CDN): required for the MV3 extension and keeps self-hosting offline-capable.
      const vision = { wasmLoaderPath: new URL(visionWasmLoader, location.href).href, wasmBinaryPath: new URL(visionWasmBinary, location.href).href };
      const base = { modelAssetPath: assetUrl('models/blaze_face_short_range.tflite') };
      try {
        return await FaceDetector.createFromOptions(vision, { baseOptions: { ...base, delegate: 'GPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.5 });
      } catch {
        return await FaceDetector.createFromOptions(vision, { baseOptions: { ...base, delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.5 });
      }
    })().catch((err) => {
      detectorPromise = null;
      throw err;
    });
  }
  return detectorPromise;
}

export interface FaceAnalysisOptions {
  start: number;
  end: number;
  interval?: number;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

/** Samples frames of [start, end] and detects faces to build a smooth reframing path. */
export async function analyzeFaces(file: Blob, opts: FaceAnalysisOptions): Promise<ReframeTrack | undefined> {
  const input = openInput(file);
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !(await video.canDecode())) return undefined;
    const detector = await getDetector();
    const interval = opts.interval ?? 0.25;
    const width = 512;
    const sink = new CanvasSink(video, { width, poolSize: 2 });
    const times: number[] = [];
    for (let t = opts.start; t < opts.end; t += interval) times.push(t);
    const samples: FaceSample[] = [];
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const t = times[i++]!;
      if (!wrapped) {
        samples.push({ t, faces: [] });
        continue;
      }
      const canvas = wrapped.canvas;
      const cw = canvas.width;
      const ch = canvas.height;
      const result = detector.detect(canvas as unknown as HTMLCanvasElement);
      samples.push({
        t,
        faces: result.detections
          .filter((d) => d.boundingBox)
          .map((d) => ({
            x: d.boundingBox!.originX / cw,
            y: d.boundingBox!.originY / ch,
            w: d.boundingBox!.width / cw,
            h: d.boundingBox!.height / ch,
            score: d.categories[0]?.score ?? 0.5,
          })),
      });
      if (i % 8 === 0) opts.onProgress?.((i / times.length) * 100);
    }
    return buildReframeTrack(samples, { sampleInterval: interval });
  } finally {
    input.dispose();
  }
}
