import { describe, expect, it } from 'vitest';
import { buildReframeTrack, cameraAt, computeCrop, outputSize, type FaceSample } from '../../src/core/reframe';

const face = (cx: number, w = 0.12, score = 0.9) => ({ x: cx - w / 2, y: 0.3, w, h: w * 1.6, score });

describe('reframe', () => {
  it('follows a single face smoothly', () => {
    const samples: FaceSample[] = Array.from({ length: 40 }, (_, i) => ({ t: i * 0.25, faces: [face(0.3 + i * 0.003)] }));
    const track = buildReframeTrack(samples);
    expect(track.suggestedLayout).toBe('fill');
    const end = cameraAt(track, 9.75);
    expect(end.cx).toBeGreaterThan(0.3);
    expect(end.cx).toBeLessThan(0.45);
  });

  it('switches speakers with a hard cut only after the new face persists', () => {
    const samples: FaceSample[] = [];
    for (let i = 0; i < 20; i++) samples.push({ t: i * 0.25, faces: [face(0.25, 0.15), face(0.75, 0.08)] });
    for (let i = 20; i < 40; i++) samples.push({ t: i * 0.25, faces: [face(0.25, 0.06), face(0.75, 0.16)] });
    const track = buildReframeTrack(samples);
    expect(cameraAt(track, 4.0).cx).toBeCloseTo(0.25, 1);
    expect(cameraAt(track, 9.5).cx).toBeCloseTo(0.75, 1);
    // A single-sample blip must not move the camera.
    const blip: FaceSample[] = Array.from({ length: 12 }, (_, i) => ({ t: i * 0.25, faces: i === 6 ? [face(0.8, 0.2)] : [face(0.3, 0.12)] }));
    const t2 = buildReframeTrack(blip);
    expect(cameraAt(t2, 1.75).cx).toBeCloseTo(0.3, 1);
  });

  it('suggests split for two balanced speakers and fit for no faces', () => {
    const two: FaceSample[] = Array.from({ length: 20 }, (_, i) => ({ t: i * 0.25, faces: [face(0.25, 0.12), face(0.75, 0.11)] }));
    const t = buildReframeTrack(two);
    expect(t.suggestedLayout).toBe('split');
    expect(t.split!.a.cx).toBeLessThan(t.split!.b.cx);
    const none: FaceSample[] = Array.from({ length: 20 }, (_, i) => ({ t: i * 0.25, faces: [] }));
    expect(buildReframeTrack(none).suggestedLayout).toBe('fit');
  });

  it('computes crops inside the frame and output sizes', () => {
    const c = computeCrop(1920, 1080, 9 / 16, 0.99, 0.5);
    expect(c.sw).toBeCloseTo(607.5);
    expect(c.sh).toBe(1080);
    expect(c.sx + c.sw).toBeLessThanOrEqual(1920);
    const z = computeCrop(1920, 1080, 9 / 16, 0.5, 0.5, 1.2);
    expect(z.sh).toBeCloseTo(900);
    expect(outputSize('9:16', 1080)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize('16:9', 720)).toEqual({ width: 1280, height: 720 });
    expect(outputSize('1:1', 1080)).toEqual({ width: 1080, height: 1080 });
  });
});
