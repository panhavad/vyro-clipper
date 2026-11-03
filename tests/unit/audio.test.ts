import { describe, expect, it } from 'vitest';
import { StreamingResampler, normalizeEnvelope } from '../../src/engine/audio';
import { buildClipAudio } from '../../src/engine/audioMix';
import { defaultEditSettings } from '../../src/core/defaults';
import { buildTimeline } from '../../src/core/timeline';

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function zeroCrossings(x: Float32Array): number {
  let n = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1]! < 0) !== (x[i]! < 0)) n++;
  return n;
}

describe('StreamingResampler', () => {
  it('downsamples 48k → 16k preserving frequency, amplitude and length (streamed in chunks)', () => {
    const input = sine(440, 48000, 2);
    const rs = new StreamingResampler(48000, 16000);
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 4097) parts.push(rs.push(input.subarray(i, i + 4097)));
    parts.push(rs.push(new Float32Array(0), true));
    const out = Float32Array.from(parts.flatMap((p) => [...p]));
    expect(Math.abs(out.length - 32000)).toBeLessThanOrEqual(2);
    expect(Math.abs(zeroCrossings(out) / 2 / 2 - 440)).toBeLessThan(3);
    const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThan(0.52);
  });

  it('handles non-integer ratios (44.1k → 16k) and upsampling (8k → 16k)', () => {
    const a = new StreamingResampler(44100, 16000);
    const outA = a.push(sine(300, 44100, 1), true);
    expect(Math.abs(outA.length - 16000)).toBeLessThanOrEqual(2);
    const b = new StreamingResampler(8000, 16000);
    const outB = b.push(sine(200, 8000, 1), true);
    expect(Math.abs(outB.length - 16000)).toBeLessThanOrEqual(2);
    expect(Math.abs(zeroCrossings(outB) / 2 - 200)).toBeLessThan(3);
  });
});

describe('envelope', () => {
  it('normalises to the 99th percentile and computes the median', () => {
    const env = normalizeEnvelope([0.1, 0.1, 0.2, 0.4, 0.2], 0.1);
    expect(Math.max(...env.rms)).toBe(1);
    expect(env.median).toBeCloseTo(0.5);
  });
});

describe('buildClipAudio', () => {
  const rate = 48000;
  const decoded = { sampleRate: rate, channels: [sine(220, rate, 10, 0.2), sine(220, rate, 10, 0.2)] as [Float32Array, Float32Array] };

  it('splices kept segments with click-free fades and normalises quiet audio', () => {
    const plan = buildTimeline({ start: 0, end: 10 }, [{ start: 3, end: 5 }]);
    const [L] = buildClipAudio(decoded, 0, plan, [], { ...defaultEditSettings(), musicEnabled: false });
    expect(L.length).toBe(8 * rate);
    expect(Math.abs(L[0]!)).toBeLessThan(1e-6); // fade-in starts at silence
    const peak = L.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.35); // quiet input was boosted (×2 max)
    expect(peak).toBeLessThanOrEqual(0.9);
  });

  it('bleeps profanity and ducks music under speech', () => {
    const plan = buildTimeline({ start: 0, end: 4 }, []);
    const words = [{ text: 'shit', start: 1, end: 1.5 }];
    const music: [Float32Array, Float32Array] = [sine(110, rate, 1, 0.5), sine(110, rate, 1, 0.5)];
    const silence = { sampleRate: rate, channels: [new Float32Array(4 * rate), new Float32Array(4 * rate)] as [Float32Array, Float32Array] };
    const edit = { ...defaultEditSettings(), censorProfanity: true, musicEnabled: true, musicVolume: 0.3 };
    const [L] = buildClipAudio(silence, 0, plan, words, edit, music);
    const rms = (a: number, b: number) => Math.sqrt(L.slice(a * rate, b * rate).reduce((s, v) => s + v * v, 0) / ((b - a) * rate));
    // the bleep dominates the censored word
    expect(rms(1.1, 1.4)).toBeGreaterThan(rms(2.5, 3));
    // music is quieter right after speech (ducked) than at the end of a long pause
    expect(rms(1.55, 1.7)).toBeLessThan(rms(2.8, 3.1));
  });
});
