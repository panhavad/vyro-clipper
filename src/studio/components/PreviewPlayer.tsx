import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { outToSrc, srcToOut } from '../../core/timeline';
import { formatTime } from '../../core/text';
import type { Campaign, Clip, Project } from '../../core/types';
import { buildRenderPlan, drawFrame, type DrawCache } from '../../engine/compositor';
import { ensureFontsLoaded } from '../../engine/fonts';
import { loadImageBitmap } from '../../engine/images';
import { getProjectFile, rulesFor } from '../../engine/pipeline';
import { useStudio } from '../store';

export interface PlayerHandle {
  seekSrc(t: number): void;
  play(): void;
  pause(): void;
}

const srcUrls = new Map<string, { url: string; refs: number }>();

function useSourceUrl(project: Project): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const key = project.source.storedAs;
    if (!key) return;
    let alive = true;
    const cached = srcUrls.get(key);
    if (cached) {
      cached.refs++;
      setUrl(cached.url);
    } else {
      void getProjectFile(project).then((f) => {
        if (!alive) return;
        const entry = srcUrls.get(key) ?? { url: URL.createObjectURL(f), refs: 0 };
        entry.refs++;
        srcUrls.set(key, entry);
        setUrl(entry.url);
      });
    }
    return () => {
      alive = false;
      const e = srcUrls.get(key);
      if (e && --e.refs <= 0) {
        URL.revokeObjectURL(e.url);
        srcUrls.delete(key);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.source.storedAs]);
  return url;
}

export const PreviewPlayer = forwardRef<PlayerHandle, { project: Project; clip: Clip; campaign?: Campaign; onSrcTime?: (t: number) => void }>(function PreviewPlayer({ project, clip, campaign, onSrcTime }, ref) {
  const settings = useStudio((s) => s.settings)!;
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef<DrawCache>({});
  const src = useSourceUrl(project);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [outT, setOutT] = useState(0);
  const [logo, setLogo] = useState<ImageBitmap>();
  const [videoDims, setVideoDims] = useState<{ w: number; h: number }>();
  const [fontsReady, setFontsReady] = useState(false);
  const lastUi = useRef(0);

  useEffect(() => {
    void ensureFontsLoaded().then(() => setFontsReady(true));
  }, []);
  const logoUrl = clip.edit.logo ? clip.edit.logoUrl || settings.brand.logoDataUrl : undefined;
  useEffect(() => {
    if (!logoUrl) return setLogo(undefined);
    void loadImageBitmap(logoUrl, settings).then(setLogo);
  }, [logoUrl, settings]);

  const rp = useMemo(
    () =>
      buildRenderPlan({
        clip,
        words: project.transcript?.words ?? [],
        srcW: videoDims?.w ?? project.meta?.width ?? 0,
        srcH: videoDims?.h ?? project.meta?.height ?? 0,
        keywords: rulesFor(campaign).keywords,
        logo,
        envelope: project.envelope,
        brandColors: [settings.brand.primaryColor, settings.brand.accentColor],
        scale: 0.5,
      }),
    [clip, project.transcript, project.meta, project.envelope, videoDims, campaign, logo, settings.brand],
  );

  const draw = useCallback(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    let t = srcToOut(rp.plan, v.currentTime);
    if (t < 0) t = rp.plan.duration;
    const hasFrame = v.readyState >= 2 && project.meta?.hasVideo;
    drawFrame(ctx, hasFrame ? v : null, Math.min(t, rp.plan.duration), rp, cacheRef.current);
    const now = performance.now();
    if (now - lastUi.current > 80) {
      lastUi.current = now;
      setOutT(t);
      onSrcTime?.(v.currentTime);
    }
  }, [rp, project.meta?.hasVideo, onSrcTime]);

  // Keep the still preview in sync with edits while paused.
  useEffect(() => {
    if (!playing) draw();
  }, [draw, playing, fontsReady]);

  // Playback loop: skip removed ranges (jump cuts) and stop at the clip end.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (!v) return;
      const segs = rp.plan.segments;
      const cur = v.currentTime;
      const inside = segs.some((s) => cur >= s.srcStart - 0.04 && cur < s.srcEnd);
      if (!inside) {
        const next = segs.find((s) => s.srcStart > cur);
        if (next) v.currentTime = next.srcStart;
        else {
          v.pause();
          setPlaying(false);
        }
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rp, draw]);

  const seekOut = useCallback(
    (t: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = outToSrc(rp.plan, Math.max(0, Math.min(rp.plan.duration - 0.01, t)));
    },
    [rp],
  );

  const play = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const t = srcToOut(rp.plan, v.currentTime);
    if (t < 0 || t >= rp.plan.duration - 0.05) v.currentTime = rp.plan.segments[0]!.srcStart;
    void v.play().then(() => setPlaying(true));
  }, [rp]);

  useImperativeHandle(
    ref,
    () => ({
      seekSrc: (t) => {
        const v = videoRef.current;
        if (v) v.currentTime = t;
      },
      play,
      pause: () => {
        videoRef.current?.pause();
        setPlaying(false);
      },
    }),
    [play],
  );

  // Jump to the clip start whenever the clip range changes.
  useEffect(() => {
    const v = videoRef.current;
    if (v && v.readyState >= 1) v.currentTime = rp.plan.segments[0]!.srcStart;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, clip.start]);

  return (
    <div className="player">
      <div className="player-stage" style={{ aspectRatio: `${rp.width} / ${rp.height}` }}>
        <canvas ref={canvasRef} width={rp.width} height={rp.height} onClick={() => (playing ? (videoRef.current?.pause(), setPlaying(false)) : play())} />
        {!src && <div className="player-loading">Loading video…</div>}
      </div>
      <video
        ref={videoRef}
        src={src}
        muted={muted}
        playsInline
        preload="auto"
        style={{ display: 'none' }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth) setVideoDims({ w: v.videoWidth, h: v.videoHeight });
          v.currentTime = rp.plan.segments[0]!.srcStart;
        }}
        onSeeked={() => draw()}
        onLoadedData={() => draw()}
        onPause={() => setPlaying(false)}
      />
      <div className="player-controls">
        <button className="icon-btn" onClick={() => (playing ? (videoRef.current?.pause(), setPlaying(false)) : play())} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <input className="scrub" type="range" min={0} max={rp.plan.duration} step={0.01} value={Math.min(outT, rp.plan.duration)} onChange={(e) => seekOut(Number(e.target.value))} />
        <span className="mono small">
          {formatTime(outT)} / {formatTime(rp.plan.duration)}
        </span>
        <button className="icon-btn" onClick={() => setMuted((m) => !m)} aria-label="Mute">
          {muted ? '🔇' : '🔊'}
        </button>
      </div>
      {rp.plan.segments.length > 1 && (
        <div className="muted small center">
          {rp.plan.segments.length - 1} jump cut{rp.plan.segments.length > 2 ? 's' : ''} · {Math.round(clip.end - clip.start - rp.plan.duration)}s of silence/fillers removed
        </div>
      )}
    </div>
  );
});
