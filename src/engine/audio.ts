import { AudioSampleSink, type AudioSample, type InputAudioTrack } from 'mediabunny';
import type { AudioEnvelope } from '../core/types';
import { openInput } from './media';

/** Streaming resampler: box-filter decimation when downsampling, linear interpolation when upsampling. */
export class StreamingResampler {
  private readonly ratio: number;
  private tail = new Float32Array(0);
  private tailStart = 0;
  private nextOut = 0;

  constructor(inRate: number, outRate: number) {
    this.ratio = inRate / outRate;
  }

  push(input: Float32Array, final = false): Float32Array {
    const r = this.ratio;
    const data = new Float32Array(this.tail.length + input.length);
    data.set(this.tail);
    data.set(input, this.tail.length);
    const base = this.tailStart;
    const end = base + data.length;
    const maxOut = Math.max(0, Math.ceil((end + r) / r) - this.nextOut + 1);
    const out = new Float32Array(maxOut);
    let n = 0;
    for (;;) {
      const center = this.nextOut * r;
      if (r >= 1) {
        const lo = Math.floor(center - r / 2);
        const hi = Math.ceil(center + r / 2);
        if (hi > end && !final) break;
        if (Math.max(lo, base) >= end) break;
        let s = 0;
        let c = 0;
        for (let i = Math.max(lo, base); i < Math.min(hi, end); i++) {
          s += data[i - base]!;
          c++;
        }
        out[n++] = c ? s / c : 0;
      } else {
        const i0 = Math.floor(center);
        if (i0 + 1 >= end && !final) break;
        if (i0 >= end) break;
        const f = center - i0;
        const a = data[Math.max(0, i0 - base)] ?? 0;
        const b = data[Math.min(data.length - 1, i0 + 1 - base)] ?? a;
        out[n++] = a + (b - a) * f;
      }
      this.nextOut++;
      if (n >= out.length) break;
    }
    const keepFrom = Math.max(base, Math.floor(this.nextOut * r - Math.max(1, r)) - 1);
    this.tail = data.slice(Math.min(data.length, keepFrom - base));
    this.tailStart = keepFrom;
    return out.subarray(0, n);
  }
}

function sampleToMono(sample: AudioSample, scratch: { buf: Float32Array }): Float32Array {
  const frames = sample.numberOfFrames;
  const channels = sample.numberOfChannels;
  if (scratch.buf.length < frames) scratch.buf = new Float32Array(frames);
  const mono = new Float32Array(frames);
  for (let c = 0; c < channels; c++) {
    sample.copyTo(scratch.buf, { planeIndex: c, format: 'f32-planar', frameCount: frames });
    for (let i = 0; i < frames; i++) mono[i] += scratch.buf[i]!;
  }
  if (channels > 1) for (let i = 0; i < frames; i++) mono[i] /= channels;
  return mono;
}

export interface SpeechDecodeOptions {
  start?: number;
  end?: number;
  /** Size of the chunks handed to the transcriber */
  chunkSeconds: number;
  rate?: number;
  onChunk: (pcm: Float32Array, startTime: number) => Promise<void>;
  onProgress?: (decodedUntil: number) => void;
  signal?: AbortSignal;
}

/**
 * Decodes the audio track to 16 kHz mono in fixed-size chunks (bounded memory for multi-hour sources)
 * and computes a 100 ms loudness envelope along the way.
 */
export async function decodeSpeechAudio(file: Blob, opts: SpeechDecodeOptions): Promise<AudioEnvelope> {
  const rate = opts.rate ?? 16000;
  const input = openInput(file);
  const hop = 0.1;
  const hopSamples = Math.round(rate * hop);
  const rms: number[] = [];
  let acc = 0;
  let accN = 0;
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('The source has no audio track.');
    const start = Math.max(0, opts.start ?? 0);
    const end = opts.end ?? (await input.computeDuration());
    const resampler = new StreamingResampler(track.sampleRate, rate);
    const chunkLen = Math.round(opts.chunkSeconds * rate);
    let chunk = new Float32Array(chunkLen);
    let chunkFill = 0;
    let emitted = 0;
    let expected = start;
    const scratch = { buf: new Float32Array(0) };

    const appendPcm = async (pcm: Float32Array) => {
      for (let i = 0; i < pcm.length; i++) {
        const v = pcm[i]!;
        acc += v * v;
        if (++accN === hopSamples) {
          rms.push(Math.sqrt(acc / accN));
          acc = 0;
          accN = 0;
        }
      }
      let offset = 0;
      while (offset < pcm.length) {
        const n = Math.min(chunkLen - chunkFill, pcm.length - offset);
        chunk.set(pcm.subarray(offset, offset + n), chunkFill);
        chunkFill += n;
        offset += n;
        if (chunkFill === chunkLen) {
          await opts.onChunk(chunk, start + emitted / rate);
          emitted += chunkLen;
          chunk = new Float32Array(chunkLen);
          chunkFill = 0;
        }
      }
    };

    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples(start, end)) {
      try {
        if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        let mono = sampleToMono(sample, scratch);
        let ts = sample.timestamp;
        if (ts < start) {
          const skip = Math.min(mono.length, Math.round((start - ts) * track.sampleRate));
          mono = mono.subarray(skip);
          ts = start;
        }
        if (ts > expected + 0.05) {
          // Gap in the stream: keep timestamps aligned with silence.
          await appendPcm(resampler.push(new Float32Array(Math.round((ts - expected) * track.sampleRate))));
        }
        expected = ts + mono.length / track.sampleRate;
        await appendPcm(resampler.push(mono));
        opts.onProgress?.(Math.min(end, expected));
      } finally {
        sample.close();
      }
    }
    await appendPcm(resampler.push(new Float32Array(0), true));
    if (chunkFill > 0) await opts.onChunk(chunk.slice(0, chunkFill), start + emitted / rate);
    if (accN) rms.push(Math.sqrt(acc / accN));
  } finally {
    input.dispose();
  }
  return normalizeEnvelope(rms, hop);
}

export function normalizeEnvelope(rms: number[], hop: number): AudioEnvelope {
  if (!rms.length) return { hop, rms: [], median: 0 };
  const sorted = [...rms].sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1] || 1;
  const norm = rms.map((v) => Math.min(1, v / (ref || 1)));
  const sortedNorm = [...norm].sort((a, b) => a - b);
  return { hop, rms: norm.map((v) => Math.round(v * 1000) / 1000), median: sortedNorm[Math.floor(sortedNorm.length / 2)] ?? 0 };
}

import type { DecodedAudio } from './audioMix';
export type { DecodedAudio };

/** Decodes [start, end) as stereo float PCM at 44.1/48 kHz for export. */
export async function decodeAudioRange(track: InputAudioTrack, start: number, end: number): Promise<DecodedAudio> {
  const srcRate = track.sampleRate;
  const rate = srcRate === 44100 || srcRate === 48000 ? srcRate : 48000;
  const frames = Math.max(1, Math.round((end - start) * rate));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const sink = new AudioSampleSink(track);
  const resamplers = rate === srcRate ? null : [new StreamingResampler(srcRate, rate), new StreamingResampler(srcRate, rate)];
  let writePos = 0;
  let scratch = new Float32Array(0);
  for await (const sample of sink.samples(start, end)) {
    try {
      const n = sample.numberOfFrames;
      if (scratch.length < n) scratch = new Float32Array(n);
      const chans = sample.numberOfChannels;
      const planes: Float32Array[] = [];
      for (let c = 0; c < Math.min(2, chans); c++) {
        const buf = new Float32Array(n);
        sample.copyTo(buf, { planeIndex: c, format: 'f32-planar', frameCount: n });
        planes.push(buf);
      }
      if (planes.length === 1) planes.push(planes[0]!);
      if (resamplers) {
        const l = resamplers[0]!.push(planes[0]!);
        const r = resamplers[1]!.push(planes[1]!);
        const count = Math.min(l.length, r.length, frames - writePos);
        left.set(l.subarray(0, count), writePos);
        right.set(r.subarray(0, count), writePos);
        writePos += count;
      } else {
        // Place by timestamp so decoder gaps don't shift audio against video.
        const offset = Math.round((sample.timestamp - start) * rate);
        const from = Math.max(0, -offset);
        const to = Math.min(n, frames - offset);
        if (to > from) {
          left.set(planes[0]!.subarray(from, to), offset + from);
          right.set(planes[1]!.subarray(from, to), offset + from);
        }
      }
    } finally {
      sample.close();
    }
  }
  return { sampleRate: rate, channels: [left, right] };
}

/** Decodes an entire music/audio asset as stereo PCM at the given rate. */
export async function decodeAudioFile(file: Blob, rate: number): Promise<[Float32Array, Float32Array] | undefined> {
  const input = openInput(file);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return undefined;
    const dur = await input.computeDuration();
    const decoded = await decodeAudioRange(track, 0, Math.min(dur, 600));
    if (decoded.sampleRate === rate) return decoded.channels;
    const l = new StreamingResampler(decoded.sampleRate, rate).push(decoded.channels[0], true);
    const r = new StreamingResampler(decoded.sampleRate, rate).push(decoded.channels[1], true);
    return [l, r];
  } finally {
    input.dispose();
  }
}
