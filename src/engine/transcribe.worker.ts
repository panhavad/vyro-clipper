/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';

type LoadMsg = { type: 'load'; model: string; device: 'webgpu' | 'wasm' };
type RunMsg = { type: 'transcribe'; id: number; audio: Float32Array; offset: number; language?: string; multilingual: boolean };
type InMsg = LoadMsg | RunMsg;

interface AsrChunk {
  text: string;
  timestamp: [number, number | null];
}
type Asr = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string; chunks?: AsrChunk[] }>;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let asr: Asr | null = null;
let loadedKey = '';

function post(msg: unknown) {
  ctx.postMessage(msg);
}

async function load(msg: LoadMsg) {
  const key = `${msg.model}|${msg.device}`;
  if (asr && loadedKey === key) return post({ type: 'ready', device: msg.device });
  env.allowLocalModels = false;
  // Import the ORT loader from its real URL instead of a blob: URL (blocked by the extension CSP).
  env.useWasmCache = false;
  // Self-hosted ONNX Runtime (no CDN code: required by Chrome MV3 and nicer for self-hosting).
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown } };
  if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: new URL(ortMjsUrl, self.location.href).href, wasm: new URL(ortWasmUrl, self.location.href).href };
  const dtype = msg.device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : { encoder_model: 'q8', decoder_model_merged: 'q8' };
  const create = pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<Asr>;
  asr = await create('automatic-speech-recognition', msg.model, {
    device: msg.device,
    dtype,
    progress_callback: (p: Record<string, unknown>) => post({ type: 'download', ...p }),
  });
  loadedKey = key;
  post({ type: 'ready', device: msg.device });
}

async function run(msg: RunMsg) {
  if (!asr) throw new Error('Model not loaded');
  const options: Record<string, unknown> = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
  if (msg.multilingual && msg.language) {
    options.language = msg.language;
    options.task = 'transcribe';
  }
  const out = await asr(msg.audio, options);
  const words = (out.chunks ?? []).map((c) => ({
    text: c.text,
    start: (c.timestamp[0] ?? 0) + msg.offset,
    end: (c.timestamp[1] ?? c.timestamp[0] ?? 0) + msg.offset,
  }));
  post({ type: 'result', id: msg.id, words, text: out.text });
}

ctx.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') await load(msg);
    else if (msg.type === 'transcribe') await run(msg);
  } catch (err) {
    post({ type: 'error', id: msg.type === 'transcribe' ? msg.id : undefined, message: (err as Error)?.message ?? String(err) });
  }
};
