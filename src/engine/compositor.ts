import { getCaptionStyle, pageAt, paginateCaptions, type CaptionPage, type CaptionStyle } from '../core/captions';
import { planZooms, zoomAt, type ZoomPlan } from '../core/effects';
import { cameraAt, computeCrop, outputSize } from '../core/reframe';
import { outToSrc, planClip, remapWords, type TimelinePlan } from '../core/timeline';
import { clamp } from '../core/text';
import type { AudioEnvelope, Clip, EditSettings, LayoutMode, Word } from '../core/types';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Drawable = CanvasImageSource;

export interface RenderPlan {
  clip: Clip;
  edit: EditSettings;
  plan: TimelinePlan;
  outWords: Word[];
  pages: CaptionPage[];
  style: CaptionStyle;
  zoom?: ZoomPlan;
  width: number;
  height: number;
  srcW: number;
  srcH: number;
  layout: Exclude<LayoutMode, 'auto'>;
  logo?: ImageBitmap;
  envelope?: AudioEnvelope;
  brandColors: [string, string];
}

export interface RenderPlanInput {
  clip: Clip;
  words: Word[];
  srcW: number;
  srcH: number;
  keywords?: string[];
  logo?: ImageBitmap;
  envelope?: AudioEnvelope;
  brandColors?: [string, string];
  /** Preview renders at a lower resolution */
  scale?: number;
}

export function resolveLayout(edit: EditSettings, clip: Clip, srcW: number, srcH: number, targetAspect: number): Exclude<LayoutMode, 'auto'> {
  if (srcW > 0 && srcH > 0 && Math.abs(srcW / srcH - targetAspect) / targetAspect < 0.15) return 'fill';
  if (edit.layout !== 'auto') return edit.layout;
  return clip.reframe?.suggestedLayout ?? 'fill';
}

export function buildRenderPlan(input: RenderPlanInput): RenderPlan {
  const { clip } = input;
  const edit = clip.edit;
  const plan = planClip({ start: clip.start, end: clip.end }, input.words, clip.manualCuts, {
    jumpCuts: edit.jumpCuts,
    silenceThreshold: edit.silenceThreshold,
    removeFillers: edit.removeFillers,
  });
  const outWords = remapWords(input.words, plan);
  const style = getCaptionStyle(edit.captionStyle);
  const pages = paginateCaptions(outWords, style, {
    emojis: edit.emojis,
    keywordHighlight: edit.keywordHighlight,
    uppercase: edit.uppercase,
    maxWords: edit.maxWordsPerPage,
    censor: edit.censorProfanity,
    keywords: input.keywords,
  });
  const size = outputSize(edit.aspect, edit.resolution);
  const scale = input.scale ?? 1;
  const width = Math.round((size.width * scale) / 2) * 2;
  const height = Math.round((size.height * scale) / 2) * 2;
  return {
    clip,
    edit,
    plan,
    outWords,
    pages,
    style,
    zoom: edit.autoZoom ? planZooms(outWords, plan, edit.zoomStrength) : undefined,
    width,
    height,
    srcW: input.srcW,
    srcH: input.srcH,
    layout: resolveLayout(edit, clip, input.srcW, input.srcH, width / height),
    logo: input.logo,
    envelope: input.envelope,
    brandColors: input.brandColors ?? ['#7C3AED', '#0EA5E9'],
  };
}

export interface DrawCache {
  blur?: OffscreenCanvas;
  blurCtx?: OffscreenCanvasRenderingContext2D;
}

const easeOut = (x: number) => 1 - (1 - x) ** 3;
const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};

function wrapText(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  // Split on regular spaces only so no-break spaces (e.g. "WORD\u00A0🔥") stay together.
  const words = text.split(/ +/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function drawCover(ctx: Ctx2D, img: Drawable, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, cx = 0.5, cy = 0.5, zoom = 1) {
  const crop = computeCrop(sw, sh, dw / dh, cx, cy, zoom);
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, dx, dy, dw, dh);
}

function drawVideoLayer(ctx: Ctx2D, frame: Drawable, rp: RenderPlan, srcT: number, t: number, cache: DrawCache) {
  const W = rp.width;
  const H = rp.height;
  const cam = cameraAt(rp.clip.reframe, srcT);
  const z = zoomAt(rp.zoom, t);
  if (rp.layout === 'fill') {
    drawCover(ctx, frame, rp.srcW, rp.srcH, 0, 0, W, H, cam.cx, cam.cy, z);
    return;
  }
  if (rp.layout === 'split') {
    const half = Math.round(H / 2);
    const a = rp.clip.reframe?.split?.a ?? { cx: 0.27, cy: 0.42 };
    const b = rp.clip.reframe?.split?.b ?? { cx: 0.73, cy: 0.42 };
    drawCover(ctx, frame, rp.srcW, rp.srcH, 0, 0, W, half, a.cx, a.cy, z);
    drawCover(ctx, frame, rp.srcW, rp.srcH, 0, half, W, H - half, b.cx, b.cy, z);
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(0, half - Math.max(2, W * 0.003), W, Math.max(4, W * 0.006));
    return;
  }
  // 'fit': blurred, darkened cover background + the whole frame in the middle.
  if (!cache.blur) {
    cache.blur = new OffscreenCanvas(Math.max(8, Math.round(W / 14)), Math.max(8, Math.round(H / 14)));
    cache.blurCtx = cache.blur.getContext('2d')!;
  }
  const bctx = cache.blurCtx!;
  bctx.imageSmoothingQuality = 'high';
  drawCover(bctx, frame, rp.srcW, rp.srcH, 0, 0, cache.blur.width, cache.blur.height, cam.cx, 0.5, 1.1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cache.blur, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.fillRect(0, 0, W, H);
  let fw = W;
  let fh = (W * rp.srcH) / rp.srcW;
  if (fh > H * 0.64) {
    fh = H * 0.64;
    fw = (fh * rp.srcW) / rp.srcH;
  }
  const crop = computeCrop(rp.srcW, rp.srcH, rp.srcW / rp.srcH, 0.5, 0.5, z);
  ctx.drawImage(frame, crop.sx, crop.sy, crop.sw, crop.sh, (W - fw) / 2, H * 0.47 - fh / 2, fw, fh);
}

function drawAudioOnly(ctx: Ctx2D, rp: RenderPlan, srcT: number, t: number) {
  const W = rp.width;
  const H = rp.height;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, rp.brandColors[0]);
  g.addColorStop(1, rp.brandColors[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const env = rp.envelope;
  const bars = 32;
  const bw = (W * 0.8) / bars;
  for (let i = 0; i < bars; i++) {
    const idx = env ? Math.floor((srcT + (i - bars / 2) * 0.05) / env.hop) : 0;
    const v = env?.rms[idx] ?? 0.3 + 0.2 * Math.sin(t * 6 + i);
    const h = Math.max(W * 0.01, v * H * 0.22);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.roundRect(W * 0.1 + i * bw + bw * 0.15, H * 0.45 - h / 2, bw * 0.7, h, bw * 0.35);
    ctx.fill();
  }
}

function drawPill(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function drawTextBox(ctx: Ctx2D, text: string, cx: number, cy: number, opts: { font: string; size: number; maxWidth: number; color: string; bg: string; radius: number; pad: number; maxLines?: number }) {
  ctx.font = `${opts.font.replace('{size}', String(opts.size))}`;
  const lines = wrapText(ctx, text, opts.maxWidth).slice(0, opts.maxLines ?? 4);
  const lh = opts.size * 1.18;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const bw = Math.max(...widths, 1) + opts.pad * 2;
  const bh = lh * lines.length + opts.pad * 1.3;
  drawPill(ctx, cx - bw / 2, cy - bh / 2, bw, bh, opts.radius, opts.bg);
  ctx.fillStyle = opts.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, cx, cy - bh / 2 + opts.pad * 0.65 + lh * (i + 0.5)));
  return bh;
}

function drawCaptions(ctx: Ctx2D, rp: RenderPlan, page: CaptionPage, t: number) {
  const W = rp.width;
  const H = rp.height;
  const style = rp.style;
  const e = rp.edit;
  let fontSize = style.sizeRatio * W * (e.captionScale || 1);
  const family = `"${style.font}", "Montserrat", sans-serif`;
  const setFont = () => (ctx.font = `${style.weight} ${fontSize}px ${family}`);
  setFont();
  const maxWidth = W * 0.88;
  // Some display fonts have very narrow spaces; keep a readable minimum gap between words.
  let space = Math.max(ctx.measureText(' ').width, fontSize * 0.24);
  const measureLine = (line: CaptionPage['lines'][number]) => line.reduce((s, w, i) => s + ctx.measureText(w.text).width + (i ? space : 0), 0);
  let widest = Math.max(...page.lines.map(measureLine));
  if (widest * style.activeScale > maxWidth) {
    fontSize *= maxWidth / (widest * style.activeScale);
    setFont();
    space = Math.max(ctx.measureText(' ').width, fontSize * 0.24);
    widest = Math.max(...page.lines.map(measureLine));
  }
  const lineH = fontSize * style.lineHeight;
  const blockH = lineH * page.lines.length;
  const age = t - page.start;
  let y = e.captionY * H - blockH / 2 + lineH / 2;
  let alpha = 1;
  if (style.animation === 'fade') alpha = clamp(age / 0.12, 0, 1);
  if (style.animation === 'slide') y += (1 - easeOut(clamp(age / 0.16, 0, 1))) * fontSize * 0.45;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  if (style.pageBg) {
    const pad = fontSize * 0.4;
    drawPill(ctx, W / 2 - widest / 2 - pad, y - lineH / 2 - pad * 0.5, widest + pad * 2, blockH + pad, fontSize * 0.3, style.pageBg);
  }
  if (page.emoji) {
    const pop = easeOutBack(clamp(age / 0.25, 0, 1));
    const es = fontSize * 1.35 * Math.max(0.2, pop);
    ctx.save();
    ctx.font = `${es}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(page.emoji, W / 2, y - lineH / 2 - fontSize * 0.95);
    ctx.restore();
    setFont();
  }

  const words = page.lines.flat();
  let active = -1;
  words.forEach((w, i) => {
    if (w.start <= t) active = i;
  });
  const baseColor = e.captionColor ?? style.color;
  const hiColor = e.highlightColor ?? style.activeColor;
  let idx = 0;
  for (const line of page.lines) {
    // The active word "pops" (scales up); lay the line out with current scales so neighbours make room.
    const metrics = line.map((w, j) => {
      const i = idx + j;
      const ww = ctx.measureText(w.text).width;
      const isActive = i === active;
      const s = isActive ? 1 + (style.activeScale - 1) * easeOutBack(clamp((t - w.start) / 0.14, 0, 1)) : 1;
      return { w, i, ww, isActive, s };
    });
    const lw = metrics.reduce((sum, m, j) => sum + m.ww * m.s + (j ? space : 0), 0);
    let x = W / 2 - lw / 2;
    for (const { w, i, ww, isActive, s } of metrics) {
      const slot = ww * s;
      if (style.animation === 'typewriter' && i > active) {
        x += slot + space;
        continue;
      }
      let color = baseColor;
      if (e.keywordHighlight && w.keyword && style.keywordColors.length) color = style.keywordColors[w.colorIdx % style.keywordColors.length]!;
      if (style.animation === 'karaoke') {
        if (i < active) color = hiColor;
      } else if (isActive) {
        color = style.id === 'beast' && style.keywordColors.length ? style.keywordColors[i % style.keywordColors.length]! : hiColor;
      }
      const dy = style.animation === 'bounce' && isActive ? -Math.sin(clamp((t - w.start) / 0.28, 0, 1) * Math.PI) * fontSize * 0.14 : 0;
      ctx.save();
      ctx.translate(x + slot / 2, y + dy);
      if (isActive && style.tilt) ctx.rotate((style.tilt * Math.PI) / 180);
      ctx.scale(s, s);
      if (isActive && style.activeBg) {
        const padX = fontSize * 0.16;
        const padY = fontSize * 0.08;
        drawPill(ctx, -ww / 2 - padX, -fontSize * 0.55 - padY, ww + padX * 2, fontSize * 1.1 + padY * 2, fontSize * 0.2, style.activeBg);
      }
      if (style.strokeRatio > 0) {
        if (style.shadow) {
          ctx.shadowColor = style.shadow.color;
          ctx.shadowBlur = style.shadow.blur * (W / 1080);
          ctx.shadowOffsetX = style.shadow.dx * (W / 1080);
          ctx.shadowOffsetY = style.shadow.dy * (W / 1080);
        }
        ctx.lineWidth = fontSize * style.strokeRatio;
        ctx.strokeStyle = style.strokeColor;
        ctx.strokeText(w.text, -ww / 2, 0);
        ctx.shadowColor = 'transparent';
      } else if (style.shadow) {
        ctx.shadowColor = style.shadow.color;
        ctx.shadowBlur = style.shadow.blur * (W / 1080);
        ctx.shadowOffsetX = style.shadow.dx * (W / 1080);
        ctx.shadowOffsetY = style.shadow.dy * (W / 1080);
      }
      ctx.fillStyle = color;
      ctx.fillText(w.text, -ww / 2, 0);
      if (style.animation === 'karaoke' && isActive) {
        const fill = clamp((t - w.start) / Math.max(0.05, w.end - w.start), 0, 1);
        ctx.shadowColor = 'transparent';
        ctx.beginPath();
        ctx.rect(-ww / 2 - 2, -fontSize, ww * fill + 2, fontSize * 2);
        ctx.clip();
        ctx.fillStyle = hiColor;
        ctx.fillText(w.text, -ww / 2, 0);
      }
      ctx.restore();
      x += slot + space;
    }
    idx += line.length;
    y += lineH;
  }
  ctx.restore();
}

function drawOverlays(ctx: Ctx2D, rp: RenderPlan, t: number) {
  const W = rp.width;
  const H = rp.height;
  const e = rp.edit;
  const k = W / 1080;
  const duration = rp.plan.duration;
  let topY = H * 0.09;

  if (e.onScreenText && e.onScreenTextValue.trim()) {
    const y = e.onScreenTextPosition === 'top' ? H * 0.085 : H * 0.9;
    const bh = drawTextBox(ctx, e.onScreenTextValue.trim(), W / 2, y, {
      font: '800 {size}px Inter, sans-serif',
      size: Math.round(40 * k),
      maxWidth: W * 0.8,
      color: '#FFFFFF',
      bg: 'rgba(0,0,0,0.62)',
      radius: 18 * k,
      pad: 22 * k,
      maxLines: 3,
    });
    if (e.onScreenTextPosition === 'top') topY = y + bh / 2 + 24 * k;
  }

  if (e.hookTitle && rp.clip.hook && t < e.hookDuration) {
    const inP = easeOutBack(clamp(t / 0.32, 0, 1));
    const outP = clamp((e.hookDuration - t) / 0.35, 0, 1);
    ctx.save();
    ctx.globalAlpha = outP;
    const size = Math.round(52 * k);
    ctx.font = `900 ${size}px Montserrat, sans-serif`;
    const lines = wrapText(ctx, rp.clip.hook, W * 0.78).slice(0, 3);
    const bh = size * 1.2 * lines.length + 40 * k;
    const cy = Math.max(topY + bh / 2 + 10 * k, H * 0.2);
    ctx.translate(W / 2, cy);
    ctx.scale(0.6 + 0.4 * inP, 0.6 + 0.4 * inP);
    ctx.rotate((-2 * Math.PI) / 180);
    drawTextBox(ctx, rp.clip.hook, 0, 0, { font: '900 {size}px Montserrat, sans-serif', size, maxWidth: W * 0.78, color: '#0B0B12', bg: '#FFFFFF', radius: 22 * k, pad: 28 * k, maxLines: 3 });
    ctx.restore();
  }

  if (e.captionsEnabled) {
    const page = pageAt(rp.pages, t);
    if (page) drawCaptions(ctx, rp, page, t);
  }

  if (e.logo && rp.logo) {
    const maxW = W * 0.16 * (e.logoScale || 1);
    const ratio = rp.logo.width / Math.max(1, rp.logo.height);
    const lw = ratio >= 1 ? maxW : maxW * ratio;
    const lh = lw / ratio;
    const m = W * 0.045;
    const x = e.logoCorner === 'tl' || e.logoCorner === 'bl' ? m : W - m - lw;
    const top = e.onScreenText && e.onScreenTextValue.trim() && e.onScreenTextPosition === 'top' ? topY : m;
    const y = e.logoCorner === 'tl' || e.logoCorner === 'tr' ? top : H - m - lh - 20 * k;
    ctx.save();
    ctx.globalAlpha = 0.96;
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 12 * k;
    ctx.drawImage(rp.logo, x, y, lw, lh);
    ctx.restore();
  }

  if (e.cta && e.ctaText && t > duration - 2.8) {
    const p = easeOut(clamp((t - (duration - 2.8)) / 0.35, 0, 1));
    ctx.save();
    ctx.globalAlpha = p;
    drawTextBox(ctx, e.ctaText, W / 2, H * 0.86 + (1 - p) * 40 * k, { font: '800 {size}px Inter, sans-serif', size: Math.round(42 * k), maxWidth: W * 0.8, color: '#0B0B12', bg: e.progressColor || '#FFE81F', radius: 40 * k, pad: 26 * k, maxLines: 2 });
    ctx.restore();
  }

  if (e.progressBar && duration > 0) {
    const h = Math.max(4, Math.round(10 * k));
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(0, H - h, W, h);
    ctx.fillStyle = e.progressColor || '#FFE81F';
    ctx.fillRect(0, H - h, W * clamp(t / duration, 0, 1), h);
  }
}

/** Composes one output frame at output time `t`. `frame` is the decoded source frame (or null for audio-only). */
export function drawFrame(ctx: Ctx2D, frame: Drawable | null, t: number, rp: RenderPlan, cache: DrawCache): void {
  const srcT = outToSrc(rp.plan, t);
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, rp.width, rp.height);
  if (frame && rp.srcW > 0 && rp.srcH > 0) drawVideoLayer(ctx, frame, rp, srcT, t, cache);
  else drawAudioOnly(ctx, rp, srcT, t);
  drawOverlays(ctx, rp, t);
  ctx.restore();
}
