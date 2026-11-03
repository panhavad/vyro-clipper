import type { TimelinePlan } from './timeline';

function tc(sec: number, fps: number): string {
  const frames = Math.round(sec * fps);
  const f = frames % fps;
  const s = Math.floor(frames / fps) % 60;
  const m = Math.floor(frames / (fps * 60)) % 60;
  const h = Math.floor(frames / (fps * 3600));
  return [h, m, s, f].map((n) => String(n).padStart(2, '0')).join(':');
}

/** CMX3600 EDL of the kept segments – imports into Premiere Pro, DaVinci Resolve and Avid. */
export function toEdl(title: string, sourceName: string, plan: TimelinePlan, fps = 30): string {
  const reel = sourceName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase() || 'AX';
  const lines = [`TITLE: ${title.slice(0, 60)}`, 'FCM: NON-DROP FRAME', ''];
  plan.segments.forEach((seg, i) => {
    const n = String(i + 1).padStart(3, '0');
    const recIn = seg.outStart;
    const recOut = seg.outStart + (seg.srcEnd - seg.srcStart);
    lines.push(`${n}  ${reel.padEnd(8)} AA/V  C        ${tc(seg.srcStart, fps)} ${tc(seg.srcEnd, fps)} ${tc(recIn, fps)} ${tc(recOut, fps)}`);
    lines.push(`* FROM CLIP NAME: ${sourceName}`);
    lines.push('');
  });
  return lines.join('\n');
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function rational(sec: number, fps: number): string {
  return `${Math.round(sec * fps * 100)}/${fps * 100}s`;
}

/** FCPXML 1.10 timeline (Final Cut Pro / DaVinci Resolve) using the original source file. */
export function toFcpXml(opts: { title: string; sourceName: string; sourceUrl?: string; sourceDuration: number; width: number; height: number; outWidth: number; outHeight: number; plan: TimelinePlan; fps?: number }): string {
  const fps = opts.fps ?? 30;
  const src = xmlEscape(opts.sourceUrl ?? `file:///${opts.sourceName}`);
  const clips = opts.plan.segments
    .map(
      (seg) =>
        `          <asset-clip ref="r2" offset="${rational(seg.outStart, fps)}" start="${rational(seg.srcStart, fps)}" duration="${rational(seg.srcEnd - seg.srcStart, fps)}" name="${xmlEscape(opts.sourceName)}" tcFormat="NDF"/>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormatCustom" frameDuration="100/${fps * 100}s" width="${opts.outWidth}" height="${opts.outHeight}"/>
    <format id="r3" frameDuration="100/${fps * 100}s" width="${opts.width}" height="${opts.height}"/>
    <asset id="r2" name="${xmlEscape(opts.sourceName)}" start="0s" duration="${rational(opts.sourceDuration, fps)}" hasVideo="1" hasAudio="1" format="r3">
      <media-rep kind="original-media" src="${src}"/>
    </asset>
  </resources>
  <library>
    <event name="VyroClipper">
      <project name="${xmlEscape(opts.title)}">
        <sequence format="r1" duration="${rational(opts.plan.duration, fps)}" tcStart="0s" tcFormat="NDF">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
