import { useMemo, useRef, useState } from 'react';
import { CAPTION_STYLES } from '../../core/captions';
import { parseCommands } from '../../core/commands';
import type { AspectRatio, Clip, Corner, EditSettings, LayoutMode } from '../../core/types';
import { PLATFORM_CAPTION_LIMITS } from '../../core/hooks';
import { complianceFor, postCaptionFor } from '../../engine/exportService';
import { analyzeFaces } from '../../engine/faces';
import { getProjectFile, rulesFor } from '../../engine/pipeline';
import { db } from '../../engine/storage';
import { shortId } from '../../core/text';
import { useCampaign, useProject } from '../hooks';
import { useStudio } from '../store';
import { PreviewPlayer, type PlayerHandle } from './PreviewPlayer';
import { TranscriptEditor } from './TranscriptEditor';
import { Badge, Button, Empty, Field, Progress, ScoreRing, Select, Slider, SubScore, Tabs, Toggle, copyText, cx } from './ui';

type Panel = 'captions' | 'layout' | 'text' | 'audio' | 'post' | 'checks';

function StylePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="style-grid">
      {CAPTION_STYLES.map((s) => (
        <button key={s.id} type="button" className={cx('style-card', value === s.id && 'active')} onClick={() => onChange(s.id)} title={s.description}>
          <span
            className="style-sample"
            style={{
              fontFamily: `"${s.font}"`,
              fontWeight: s.weight,
              color: s.color,
              textTransform: s.uppercase ? 'uppercase' : 'none',
              WebkitTextStroke: s.strokeRatio ? `${Math.max(1, s.strokeRatio * 8)}px ${s.strokeColor}` : undefined,
              background: s.pageBg,
            }}
          >
            Wow <span style={{ color: s.activeColor, background: s.activeBg, borderRadius: 4, padding: s.activeBg ? '0 3px' : 0 }}>this</span>
          </span>
          <span className="style-name">{s.name}</span>
        </button>
      ))}
    </div>
  );
}

export function ClipEditor({ projectId, clipId }: { projectId: string; clipId: string }) {
  const project = useProject(projectId);
  const campaign = useCampaign(project?.campaignId);
  const { navigate, updateClip, updateClipEdit, exportClips, toast, jobs, settings } = useStudio();
  const clip = project?.clips.find((c) => c.id === clipId);
  const player = useRef<PlayerHandle>(null);
  const [srcTime, setSrcTime] = useState(0);
  const [panel, setPanel] = useState<Panel>('captions');
  const [command, setCommand] = useState('');
  const [reframing, setReframing] = useState<number | null>(null);
  const compliance = useMemo(() => (clip && project ? complianceFor(clip, project, campaign) : undefined), [clip, project, campaign]);
  if (!project || !clip || !settings) return <Empty icon="🤷" title="Clip not found" />;
  const e = clip.edit;
  const setEdit = (patch: Partial<EditSettings>) => updateClipEdit(projectId, clipId, patch);
  const setClip = (patch: Partial<Clip>) => updateClip(projectId, clipId, patch);
  const job = jobs[clipId];
  const sorted = [...project.clips].sort((a, b) => b.scores.total - a.scores.total);
  const idx = sorted.findIndex((c) => c.id === clipId);
  const rules = rulesFor(campaign);
  const caption = postCaptionFor(clip, campaign);

  const runCommand = () => {
    if (!command.trim()) return;
    const r = parseCommands(command, { edit: e, clip });
    if (Object.keys(r.edit).length) setEdit(r.edit);
    const clipPatch: Partial<Clip> = { ...r.clip };
    if (clipPatch.start !== undefined || clipPatch.end !== undefined) clipPatch.reframe = undefined;
    if (Object.keys(clipPatch).length) setClip(clipPatch);
    toast(r.applied.length ? 'success' : 'info', r.applied.length ? `Applied: ${r.applied.join(', ')}` : 'No edits recognised', r.unknown.length ? `Not understood: ${r.unknown.join(' · ')}` : undefined);
    setCommand('');
  };

  const rerunReframe = async () => {
    setReframing(0);
    try {
      const file = await getProjectFile(project);
      const track = await analyzeFaces(file, { start: clip.start, end: clip.end, onProgress: setReframing });
      if (track) setClip({ reframe: track });
      toast('success', track ? `Face tracking done — suggested layout: ${track.suggestedLayout}` : 'No video track to analyse');
    } catch (err) {
      toast('error', `Face tracking failed: ${(err as Error).message}`);
    } finally {
      setReframing(null);
    }
  };

  return (
    <div className="page editor">
      <div className="editor-top">
        <button className="link back" onClick={() => navigate(project.campaignId ? { name: 'campaign', id: project.campaignId } : { name: 'project', id: project.id })}>
          ← Back
        </button>
        <div className="row gap center-v grow">
          <ScoreRing score={clip.scores.total} size={46} />
          <input className="input title-input" value={clip.title} onChange={(ev) => setClip({ title: ev.target.value })} />
        </div>
        <div className="row gap">
          <Button size="sm" disabled={idx <= 0} onClick={() => navigate({ name: 'clip', projectId, clipId: sorted[idx - 1]!.id })}>
            ‹ Prev
          </Button>
          <Button size="sm" disabled={idx >= sorted.length - 1} onClick={() => navigate({ name: 'clip', projectId, clipId: sorted[idx + 1]!.id })}>
            Next ›
          </Button>
          <Button kind="primary" disabled={!!job} onClick={() => void exportClips(projectId, [clipId], 'download')}>
            ⬇ Export MP4
          </Button>
          <Button disabled={!!job} onClick={() => void exportClips(projectId, [clipId], 'folder')}>
            Save package…
          </Button>
        </div>
      </div>
      {job && <Progress pct={job.pct} label={job.label} detail={job.detail} />}

      <div className="editor-grid">
        <div className="editor-left">
          <PreviewPlayer ref={player} project={project} clip={clip} campaign={campaign} onSrcTime={setSrcTime} />
          <div className="subscores compact">
            <SubScore label="Hook" value={clip.scores.hook} />
            <SubScore label="Flow" value={clip.scores.flow} />
            <SubScore label="Value" value={clip.scores.value} />
            <SubScore label="Trend" value={clip.scores.trend} />
            {campaign && <SubScore label="On-brief" value={clip.scores.relevance} />}
          </div>
          {clip.reasons.length > 0 && (
            <ul className="reasons-list">
              {clip.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="editor-right">
          <div className="magic">
            <input className="input" placeholder='✨ Tell the editor what to change — e.g. "captions yellow and bigger, beast style, zoom more, title: I quit"' value={command} onChange={(ev) => setCommand(ev.target.value)} onKeyDown={(ev) => ev.key === 'Enter' && runCommand()} />
            <Button kind="primary" onClick={runCommand}>
              Apply
            </Button>
          </div>
          <Tabs
            value={panel}
            onChange={setPanel}
            tabs={[
              { value: 'captions', label: 'Captions' },
              { value: 'layout', label: 'Layout & cuts' },
              { value: 'text', label: 'Text & brand' },
              { value: 'audio', label: 'Audio' },
              { value: 'post', label: 'Post' },
              { value: 'checks', label: compliance?.report.ok ? 'Checks ✓' : `Checks (${compliance?.report.items.filter((i) => i.status === 'fail').length ?? 0}✕)` },
            ]}
          />
          <div className="panel-body">
            {panel === 'captions' && (
              <>
                {project.textScan?.captions && (
                  <div className="callout small">
                    This video already has captions burned in, so animated captions start off to avoid doubling them.
                    {e.captionsEnabled ? ' Yours are on — make sure they don’t cover the originals (move them with “Vertical position”).' : ' Turn them on to add yours anyway.'}
                  </div>
                )}
                <Toggle checked={e.captionsEnabled} onChange={(v) => setEdit({ captionsEnabled: v })} label={`Animated captions${rules.subtitlesRequired ? ' (required by campaign)' : ''}`} />
                <StylePicker value={e.captionStyle} onChange={(id) => setEdit({ captionStyle: id })} />
                <Slider label="Vertical position" min={0.12} max={0.9} step={0.01} value={e.captionY} onChange={(v) => setEdit({ captionY: v })} format={(v) => `${Math.round(v * 100)}%`} />
                <Slider label="Size" min={0.6} max={1.8} step={0.05} value={e.captionScale} onChange={(v) => setEdit({ captionScale: v })} format={(v) => `${Math.round(v * 100)}%`} />
                <Slider label="Words per caption" min={1} max={8} value={e.maxWordsPerPage ?? CAPTION_STYLES.find((s) => s.id === e.captionStyle)?.maxWords ?? 3} onChange={(v) => setEdit({ maxWordsPerPage: v })} />
                <div className="row gap wrap">
                  <Field label="Text colour">
                    <input type="color" value={e.captionColor ?? '#ffffff'} onChange={(ev) => setEdit({ captionColor: ev.target.value })} />
                  </Field>
                  <Field label="Highlight colour">
                    <input type="color" value={e.highlightColor ?? CAPTION_STYLES.find((s) => s.id === e.captionStyle)?.activeColor ?? '#ffe81f'} onChange={(ev) => setEdit({ highlightColor: ev.target.value })} />
                  </Field>
                  <Button size="sm" kind="ghost" onClick={() => setEdit({ captionColor: undefined, highlightColor: undefined, uppercase: undefined, maxWordsPerPage: undefined })}>
                    Reset style
                  </Button>
                </div>
                <div className="row gap wrap">
                  <Toggle checked={e.uppercase ?? CAPTION_STYLES.find((s) => s.id === e.captionStyle)?.uppercase ?? true} onChange={(v) => setEdit({ uppercase: v })} label="UPPERCASE" />
                  <Toggle checked={e.emojis} onChange={(v) => setEdit({ emojis: v })} label="Auto emojis" />
                  <Toggle checked={e.keywordHighlight} onChange={(v) => setEdit({ keywordHighlight: v })} label="Keyword highlights" />
                  <Toggle checked={e.censorProfanity} onChange={(v) => setEdit({ censorProfanity: v })} label="Censor profanity (bleep)" />
                </div>
              </>
            )}
            {panel === 'layout' && (
              <>
                <Field label="Format">
                  <div className="row gap">
                    {(['9:16', '1:1', '4:5', '16:9'] as AspectRatio[]).map((a) => (
                      <Button key={a} size="sm" kind={e.aspect === a ? 'primary' : 'subtle'} onClick={() => setEdit({ aspect: a })}>
                        {a}
                      </Button>
                    ))}
                  </div>
                </Field>
                <Field label={`Layout${clip.reframe ? ` (AI suggests: ${clip.reframe.suggestedLayout})` : ''}`}>
                  <div className="row gap">
                    {(['auto', 'fill', 'fit', 'split'] as LayoutMode[]).map((l) => (
                      <Button key={l} size="sm" kind={e.layout === l ? 'primary' : 'subtle'} onClick={() => setEdit({ layout: l })} title={{ auto: 'AI picks', fill: 'Speaker-tracked full screen', fit: 'Whole frame on blurred background', split: 'Two speakers stacked' }[l]}>
                        {l}
                      </Button>
                    ))}
                  </div>
                </Field>
                <div className="row gap center-v">
                  <Button size="sm" onClick={() => void rerunReframe()} disabled={reframing !== null}>
                    {reframing !== null ? `Tracking faces… ${Math.round(reframing)}%` : clip.reframe ? '↻ Re-run AI reframe' : '🎯 Run AI reframe (face tracking)'}
                  </Button>
                  {clip.reframe && <span className="muted small">{clip.reframe.keyframes.filter((k) => k.faces > 0).length} face samples</span>}
                </div>
                <Toggle checked={e.autoZoom} onChange={(v) => setEdit({ autoZoom: v })} label="Dynamic zoom (punch-ins on emphasis)" />
                {e.autoZoom && <Slider label="Zoom strength" min={0.1} max={1} step={0.05} value={e.zoomStrength} onChange={(v) => setEdit({ zoomStrength: v })} format={(v) => `${Math.round(v * 100)}%`} />}
                <Toggle checked={e.jumpCuts} onChange={(v) => setEdit({ jumpCuts: v })} label="Remove silences (jump cuts)" />
                {e.jumpCuts && <Slider label="Cut pauses longer than" min={0.25} max={1.5} step={0.05} value={e.silenceThreshold} onChange={(v) => setEdit({ silenceThreshold: v })} format={(v) => `${v.toFixed(2)}s`} />}
                <Toggle checked={e.removeFillers} onChange={(v) => setEdit({ removeFillers: v })} label="Remove filler words (um, uh…)" />
                <div className="row gap">
                  <Field label="Resolution">
                    <Select value={String(e.resolution) as '1080' | '720'} onChange={(v) => setEdit({ resolution: Number(v) as 1080 | 720 })} options={[{ value: '1080', label: '1080p' }, { value: '720', label: '720p (faster)' }]} />
                  </Field>
                  <Field label="Frame rate">
                    <Select value={String(e.fps) as '30' | '60'} onChange={(v) => setEdit({ fps: Number(v) as 30 | 60 })} options={[{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }]} />
                  </Field>
                </div>
              </>
            )}
            {panel === 'text' && (
              <>
                <Toggle checked={e.hookTitle} onChange={(v) => setEdit({ hookTitle: v })} label="AI hook title (first seconds)" />
                {e.hookTitle && (
                  <>
                    <input className="input" value={clip.hook} onChange={(ev) => setClip({ hook: ev.target.value })} />
                    <Slider label="Show hook for" min={1} max={8} step={0.1} value={e.hookDuration} onChange={(v) => setEdit({ hookDuration: v })} format={(v) => `${v.toFixed(1)}s`} />
                  </>
                )}
                <Toggle checked={e.onScreenText} onChange={(v) => setEdit({ onScreenText: v })} label={`Text on screen${rules.textOnScreen ? ' (required by campaign)' : ''}`} />
                {e.onScreenText && (
                  <div className="row gap">
                    <input className="input grow" value={e.onScreenTextValue} onChange={(ev) => setEdit({ onScreenTextValue: ev.target.value })} maxLength={300} />
                    <Select value={e.onScreenTextPosition} onChange={(v) => setEdit({ onScreenTextPosition: v })} options={[{ value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }]} />
                  </div>
                )}
                <Toggle checked={e.logo} onChange={(v) => setEdit({ logo: v })} label={`Logo / watermark${rules.logoUrls.length ? ' (required by campaign)' : ''}`} />
                {e.logo && (
                  <>
                    <div className="row gap wrap">
                      {[...rules.logoUrls, ...(settings.brand.logoDataUrl ? [settings.brand.logoDataUrl] : [])].map((u) => (
                        <button key={u.slice(0, 80)} className={cx('logo-pick', e.logoUrl === u && 'active')} onClick={() => setEdit({ logoUrl: u })} type="button">
                          <img src={u} alt="logo" referrerPolicy="no-referrer" />
                        </button>
                      ))}
                    </div>
                    <div className="row gap">
                      <Select value={e.logoCorner} onChange={(v) => setEdit({ logoCorner: v as Corner })} options={[{ value: 'tl', label: 'Top left' }, { value: 'tr', label: 'Top right' }, { value: 'bl', label: 'Bottom left' }, { value: 'br', label: 'Bottom right' }]} />
                      <Slider label="Logo size" min={0.5} max={2} step={0.05} value={e.logoScale} onChange={(v) => setEdit({ logoScale: v })} format={(v) => `${Math.round(v * 100)}%`} />
                    </div>
                  </>
                )}
                <Toggle checked={e.cta} onChange={(v) => setEdit({ cta: v })} label="Call-to-action at the end" />
                {e.cta && <input className="input" value={e.ctaText} onChange={(ev) => setEdit({ ctaText: ev.target.value })} />}
                <Toggle checked={e.progressBar} onChange={(v) => setEdit({ progressBar: v })} label="Progress bar" />
                {e.progressBar && <input type="color" value={e.progressColor} onChange={(ev) => setEdit({ progressColor: ev.target.value })} />}
              </>
            )}
            {panel === 'audio' && (
              <>
                {rules.audio.length > 0 && (
                  <div className="callout">
                    This campaign requires a platform sound ({rules.audio.map((a) => a.platform).join(', ')}). Add it in the app when posting; keep background music off.
                  </div>
                )}
                <Toggle checked={e.musicEnabled} onChange={(v) => setEdit({ musicEnabled: v })} label="Background music (auto-ducked under speech)" />
                {e.musicEnabled && (
                  <>
                    <Field label="Music file (royalty-free MP3/M4A/WAV)" hint={e.musicAssetId ? 'Music attached ✓' : 'No music file yet'}>
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={async (ev) => {
                          const f = ev.target.files?.[0];
                          if (!f) return;
                          const id = shortId('music_');
                          await db.putAsset(id, f);
                          setEdit({ musicAssetId: id });
                          toast('success', `Music “${f.name}” attached`);
                        }}
                      />
                    </Field>
                    <Slider label="Music volume" min={0.02} max={0.6} step={0.01} value={e.musicVolume} onChange={(v) => setEdit({ musicVolume: v })} format={(v) => `${Math.round(v * 100)}%`} />
                  </>
                )}
                <p className="muted small">Audio is loudness-normalised and spliced with micro-fades so jump cuts never click.</p>
              </>
            )}
            {panel === 'post' && (
              <>
                <Field label="Caption line">
                  <textarea className="input" rows={2} value={clip.caption} onChange={(ev) => setClip({ caption: ev.target.value })} />
                </Field>
                <Field label="Extra hashtags" hint="Campaign hashtags and the ad disclosure are always added automatically.">
                  <input className="input" defaultValue={clip.hashtags.join(' ')} onBlur={(ev) => setClip({ hashtags: ev.target.value.split(/[\s,]+/).filter(Boolean).map((h) => (h.startsWith('#') ? h : `#${h}`)) })} />
                </Field>
                {(['tiktok', 'instagram', 'youtube', 'x'] as const)
                  .filter((p) => rules.platforms.includes(p))
                  .map((p) => (
                    <div key={p} className="caption-variant">
                      <div className="row between">
                        <b>{p === 'youtube' ? 'YouTube Shorts title' : p === 'x' ? 'X' : p === 'tiktok' ? 'TikTok' : 'Instagram'}</b>
                        <span className={cx('small', caption.variants[p].length > PLATFORM_CAPTION_LIMITS[p] ? 'bad' : 'muted')}>
                          {caption.variants[p].length}/{PLATFORM_CAPTION_LIMITS[p]}
                        </span>
                      </div>
                      <pre>{caption.variants[p]}</pre>
                      <Button
                        size="sm"
                        onClick={async () => {
                          await copyText(caption.variants[p]);
                          toast('success', 'Copied');
                        }}
                      >
                        Copy
                      </Button>
                    </div>
                  ))}
                {campaign?.submitUrl && campaign.source === 'vyro' && (
                  <a className="btn btn-primary" href={campaign.submitUrl} target="_blank" rel="noreferrer">
                    After posting: submit the live URL on Vyro ↗
                  </a>
                )}
              </>
            )}
            {panel === 'checks' && compliance && (
              <>
                <p className="muted small">Final length after cuts: {compliance.durationSec.toFixed(1)}s. Vyro reviews every post against the brief — failing items get rejected.</p>
                <ul className="checks">
                  {compliance.report.items.map((i) => (
                    <li key={i.id} className={`check-${i.status}`}>
                      <span className="check-icon">{{ pass: '✓', fail: '✕', warn: '!', manual: '☐' }[i.status]}</span>
                      <div>
                        <div>{i.label}</div>
                        {i.detail && <div className="muted small">{i.detail}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
                {!campaign && <Badge>Not linked to a campaign — generic checks only</Badge>}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <TranscriptEditor project={project} clip={clip} srcTime={srcTime} onSeek={(t) => player.current?.seekSrc(t)} onChange={setClip} />
      </div>
    </div>
  );
}
