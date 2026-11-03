import type { TimelinePlan } from '../core/timeline';
import { isProfane } from '../core/text';
import type { EditSettings, Word } from '../core/types';

export interface DecodedAudio {
  sampleRate: number;
  channels: [Float32Array, Float32Array];
}

/** Splices kept segments into one continuous track with micro-fades, bleeps, music ducking and peak normalisation. */
export function buildClipAudio(decoded: DecodedAudio, rangeStart: number, plan: TimelinePlan, outWords: Word[], edit: EditSettings, music?: [Float32Array, Float32Array]): [Float32Array, Float32Array] {
  const rate = decoded.sampleRate;
  const total = Math.max(1, Math.round(plan.duration * rate));
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const fade = Math.round(0.006 * rate);
  const [srcL, srcR] = decoded.channels;
  for (const seg of plan.segments) {
    const s0 = Math.round((seg.srcStart - rangeStart) * rate);
    const o0 = Math.round(seg.outStart * rate);
    const len = Math.min(Math.round((seg.srcEnd - seg.srcStart) * rate), total - o0, srcL.length - s0);
    for (let i = 0; i < len; i++) {
      const g = i < fade ? i / fade : i > len - fade ? (len - i) / fade : 1;
      L[o0 + i] = (srcL[s0 + i] ?? 0) * g;
      R[o0 + i] = (srcR[s0 + i] ?? 0) * g;
    }
  }
  if (edit.censorProfanity) {
    for (const w of outWords) {
      if (!isProfane(w.text)) continue;
      const a = Math.max(0, Math.round(w.start * rate));
      const b = Math.min(total, Math.round(w.end * rate));
      for (let i = a; i < b; i++) {
        const v = 0.22 * Math.sin((2 * Math.PI * 1000 * (i - a)) / rate);
        L[i] = v;
        R[i] = v;
      }
    }
  }
  if (music && edit.musicEnabled) {
    const [mL, mR] = music;
    const block = Math.round(rate * 0.01);
    const speaking = new Uint8Array(Math.ceil(total / block));
    for (const w of outWords) {
      const a = Math.max(0, Math.floor((w.start - 0.15) * rate / block));
      const b = Math.min(speaking.length, Math.ceil((w.end + 0.25) * rate / block));
      speaking.fill(1, a, b);
    }
    let gain = edit.musicVolume;
    for (let bi = 0; bi < speaking.length; bi++) {
      const target = edit.musicVolume * (speaking[bi] ? 0.35 : 1);
      gain += (target - gain) * (target < gain ? 0.25 : 0.04);
      const end = Math.min(total, (bi + 1) * block);
      for (let i = bi * block; i < end; i++) {
        const mi = i % mL.length;
        // Fade music in/out at the clip edges.
        const edge = Math.min(1, i / (rate * 0.5), (total - i) / (rate * 0.8));
        L[i] += (mL[mi] ?? 0) * gain * edge;
        R[i] += (mR[mi] ?? 0) * gain * edge;
      }
    }
  }
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
  const targetPeak = 0.89; // ≈ -1 dBFS
  const gainAll = peak > targetPeak ? targetPeak / peak : peak > 0 && peak < 0.45 ? Math.min(2, targetPeak / peak) : 1;
  if (gainAll !== 1) {
    for (let i = 0; i < total; i++) {
      L[i] *= gainAll;
      R[i] *= gainAll;
    }
  }
  return [L, R];
}
