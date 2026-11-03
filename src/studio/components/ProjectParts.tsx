import { useMemo, useState } from 'react';
import { complianceSummary } from '../../core/compliance';
import type { Campaign, Clip, GenerateSettings, Project } from '../../core/types';
import { complianceFor, postCaptionFor } from '../../engine/exportService';
import { useClipThumbnail } from '../hooks';
import { useStudio, type ExportTarget } from '../store';
import { Badge, Button, Field, Modal, Progress, ScoreRing, SubScore, Toggle, copyText, cx, formatBytes } from './ui';
import { formatTime } from '../../core/text';

const STATUS_LABEL: Record<Project['status'], string> = {
  new: 'Ready to process',
  downloading: 'Downloading',
  probing: 'Reading video',
  transcribing: 'Transcribing',
  analyzing: 'Analyzing',
  detecting: 'Finding viral moments',
  reframing: 'AI reframing',
  ready: 'Ready',
  error: 'Stopped',
};

export function GenerateOptionsModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const { updateProject, regenerateClips, runPipeline, settings } = useStudio();
  const [g, setG] = useState<GenerateSettings>(project.settings);
  const llmReady = !!settings?.llm.enabled && !!settings.llm.model;
  const set = (patch: Partial<GenerateSettings>) => setG((x) => ({ ...x, ...patch }));
  return (
    <Modal title="Clip generation settings" onClose={onClose}>
      <div className="form-grid">
        <Field label="Number of clips" hint="0 = automatic (based on video length & quality)">
          <input className="input" type="number" min={0} max={60} value={g.clipCount} onChange={(e) => set({ clipCount: Math.max(0, Number(e.target.value)) })} />
        </Field>
        <Field label="Language">
          <input className="input" value={g.language} onChange={(e) => set({ language: e.target.value.slice(0, 5) })} />
        </Field>
        <Field label="Min length (s)">
          <input className="input" type="number" min={5} max={170} value={g.minDuration} onChange={(e) => set({ minDuration: Number(e.target.value) })} />
        </Field>
        <Field label="Max length (s)">
          <input className="input" type="number" min={10} max={180} value={g.maxDuration} onChange={(e) => set({ maxDuration: Number(e.target.value) })} />
        </Field>
        <Field label="Only analyse from (s)">
          <input className="input" type="number" min={0} value={g.rangeStart ?? ''} placeholder="start" onChange={(e) => set({ rangeStart: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </Field>
        <Field label="…to (s)">
          <input className="input" type="number" min={0} value={g.rangeEnd ?? ''} placeholder="end" onChange={(e) => set({ rangeEnd: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </Field>
      </div>
      <Field label="Find moments about… (optional prompt)" hint="e.g. “money challenges”, “funny reactions”, “the product reveal”. Boosts matching moments.">
        <input className="input" value={g.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="Describe what to clip" />
      </Field>
      <Toggle checked={g.useLlm && llmReady} disabled={!llmReady} onChange={(v) => set({ useLlm: v })} label={`Use AI model for clip picking${llmReady ? ` (${settings!.llm.model})` : ' — add an LLM key in Settings'}`} />
      <div className="row end gap">
        <Button
          onClick={async () => {
            await updateProject(project.id, { settings: g });
            onClose();
          }}
        >
          Save
        </Button>
        <Button
          kind="primary"
          onClick={async () => {
            const languageChanged = g.language !== project.settings.language || g.rangeStart !== project.settings.rangeStart || g.rangeEnd !== project.settings.rangeEnd;
            await updateProject(project.id, languageChanged ? { settings: g, transcript: undefined, envelope: undefined, clips: project.clips.filter((c) => c.favorite) } : { settings: g });
            onClose();
            if (project.transcript && !languageChanged) void regenerateClips(project.id);
            else void runPipeline(project.id, { redetect: true });
          }}
        >
          {project.transcript ? 'Regenerate clips' : 'Generate clips'}
        </Button>
      </div>
    </Modal>
  );
}

export function ClipCard({ project, clip, index, campaign, selected, onSelect }: { project: Project; clip: Clip; index: number; campaign?: Campaign; selected: boolean; onSelect: (v: boolean) => void }) {
  const { navigate, exportClips, updateClip, toast, jobs, deleteClip } = useStudio();
  const thumb = useClipThumbnail(project, clip, campaign);
  const job = jobs[clip.id];
  const { report, durationSec } = useMemo(() => complianceFor(clip, project, campaign), [clip, project, campaign]);
  const sum = complianceSummary(report);
  return (
    <div className={cx('card clip-card', selected && 'selected')}>
      <div className="clip-thumb" onClick={() => navigate({ name: 'clip', projectId: project.id, clipId: clip.id })}>
        {thumb ? <img src={thumb} alt={clip.title} /> : <div className="thumb-placeholder">Rendering preview…</div>}
        <div className="clip-rank">#{index + 1}</div>
        <div className="clip-dur">{formatTime(durationSec)}</div>
        <div className="clip-score">
          <ScoreRing score={clip.scores.total} size={50} />
        </div>
        {clip.engine === 'llm' && <div className="clip-ai">AI</div>}
      </div>
      <div className="clip-body">
        <div className="row between">
          <label className="check">
            <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
          </label>
          <div className="row">
            <button className={cx('star', clip.favorite && 'on')} title="Keep this clip when regenerating" onClick={() => updateClip(project.id, clip.id, { favorite: !clip.favorite })}>
              ★
            </button>
            <button className="star" title="Delete clip" onClick={() => void deleteClip(project.id, clip.id)}>
              🗑
            </button>
          </div>
        </div>
        <h4 className="clip-title" onClick={() => navigate({ name: 'clip', projectId: project.id, clipId: clip.id })}>
          {clip.title}
        </h4>
        <div className="subscores">
          <SubScore label="Hook" value={clip.scores.hook} />
          <SubScore label="Flow" value={clip.scores.flow} />
          <SubScore label="Value" value={clip.scores.value} />
          <SubScore label="Trend" value={clip.scores.trend} />
        </div>
        {clip.reasons.length > 0 && <p className="reasons">{clip.reasons.slice(0, 2).join(' · ')}</p>}
        <div className="chips">
          {campaign && (sum.fail ? <Badge tone="bad" title={report.items.filter((i) => i.status === 'fail').map((i) => i.label).join('\n')}>✕ {sum.fail} rule issue{sum.fail > 1 ? 's' : ''}</Badge> : <Badge tone="good">✓ Campaign rules</Badge>)}
          {sum.manual > 0 && campaign && <Badge tone="warn" title={report.items.filter((i) => i.status === 'manual').map((i) => i.label).join('\n')}>{sum.manual} to do when posting</Badge>}
          {clip.status === 'rendered' && <Badge tone="accent" title={clip.output?.fileName}>Exported {formatBytes(clip.output?.size)}</Badge>}
          {clip.status === 'error' && <Badge tone="bad" title={clip.error}>Export failed</Badge>}
        </div>
        {job ? (
          <div className="row gap center-v">
            <div style={{ flex: 1 }}>
              <Progress pct={job.pct} detail={job.detail} />
            </div>
            <Button size="sm" kind="ghost" onClick={() => job.controller.abort()}>
              Stop
            </Button>
          </div>
        ) : (
          <div className="row gap wrap">
            <Button size="sm" kind="primary" onClick={() => navigate({ name: 'clip', projectId: project.id, clipId: clip.id })}>
              Edit
            </Button>
            <Button size="sm" onClick={() => void exportClips(project.id, [clip.id], 'download')}>
              ⬇ Export
            </Button>
            <Button
              size="sm"
              kind="ghost"
              onClick={async () => {
                await copyText(postCaptionFor(clip, campaign).text);
                toast('success', 'Caption + hashtags copied');
              }}
            >
              Copy caption
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ProjectSection({ project, campaign }: { project: Project; campaign?: Campaign }) {
  const { runPipeline, deleteProject, exportClips, jobs, cancelJob } = useStudio();
  const [showOptions, setShowOptions] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [exportTarget, setExportTarget] = useState<ExportTarget>('folder');
  const job = jobs[project.id];
  const busy = !!job || project.status === 'downloading';
  const clips = useMemo(() => [...project.clips].sort((a, b) => b.scores.total - a.scores.total), [project.clips]);
  const toggle = (id: string, v: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (v) n.add(id);
      else n.delete(id);
      return n;
    });
  const avg = clips.length ? Math.round(clips.reduce((n, c) => n + c.scores.total, 0) / clips.length) : 0;
  return (
    <section className="project">
      <div className="project-head">
        <div>
          <h2>{project.name}</h2>
          <div className="muted small">
            {project.meta ? `${formatTime(project.meta.duration)} · ${project.meta.width}×${project.meta.height}` : project.source.url ?? project.source.fileName}
            {project.transcript ? ` · ${project.transcript.words.length.toLocaleString()} words` : ''}
            {clips.length ? ` · ${clips.length} clips · avg score ${avg}` : ''}
          </div>
        </div>
        <div className="row gap wrap">
          {project.status === 'new' && !busy && (
            <Button kind="primary" onClick={() => void runPipeline(project.id)}>
              ✂ Generate clips
            </Button>
          )}
          {project.status === 'error' && !busy && (
            <Button kind="primary" onClick={() => void runPipeline(project.id)}>
              ↻ Resume
            </Button>
          )}
          {busy && job && (
            <Button kind="danger" onClick={() => cancelJob(project.id)}>
              Stop
            </Button>
          )}
          <Button onClick={() => setShowOptions(true)} disabled={busy}>
            ⚙ Settings{project.transcript ? ' / Regenerate' : ''}
          </Button>
          <Button kind="ghost" onClick={() => confirm(`Delete “${project.name}” and its clips?`) && void deleteProject(project.id)}>
            🗑
          </Button>
        </div>
      </div>
      {project.progress && (
        <Progress pct={project.progress.pct} label={`${STATUS_LABEL[project.status]} — ${project.progress.step}`} detail={project.progress.detail} />
      )}
      {project.status === 'error' && project.error && <div className="callout error">{project.error}</div>}
      {clips.length > 0 && (
        <div className="bulkbar slim">
          <label className="check">
            <input type="checkbox" checked={sel.size === clips.length} onChange={(e) => setSel(e.target.checked ? new Set(clips.map((c) => c.id)) : new Set())} /> Select all
          </label>
          <div className="row gap center-v">
            <select className="input" value={exportTarget} onChange={(e) => setExportTarget(e.target.value as ExportTarget)}>
              <option value="folder">Save to a folder</option>
              <option value="download">Download files</option>
              <option value="zip">Download as ZIP</option>
            </select>
            <Button kind="primary" disabled={!sel.size} onClick={() => void exportClips(project.id, clips.filter((c) => sel.has(c.id)).map((c) => c.id), exportTarget)}>
              Export {sel.size || ''} clip{sel.size === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}
      {clips.length > 0 && (
        <div className="grid clips-grid">
          {clips.map((c, i) => (
            <ClipCard key={c.id} project={project} clip={c} index={i} campaign={campaign} selected={sel.has(c.id)} onSelect={(v) => toggle(c.id, v)} />
          ))}
        </div>
      )}
      {showOptions && <GenerateOptionsModal project={project} onClose={() => setShowOptions(false)} />}
    </section>
  );
}
