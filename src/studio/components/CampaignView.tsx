import { useMemo, useState } from 'react';
import { parseBrief } from '../../core/brief';
import { chooseRendition, isLongForm, rankForClipping, type FrameioShare } from '../../core/frameio';
import { resolveShare } from '../../engine/frameioClient';
import type { Campaign, CampaignRules, MediaLink, Platform } from '../../core/types';
import { PLATFORMS } from '../../core/types';
import { classifyMediaUrl, effectiveRules, isDownloadable, needsServerResolver } from '../../core/vyro';
import { formatTime, normalizeHashtag } from '../../core/text';
import { useCampaign } from '../hooks';
import { useStudio } from '../store';
import { PlatformIcons, RuleChips } from './CampaignsView';
import { ProjectSection } from './ProjectParts';
import { Badge, Button, DropZone, Empty, Field, Tabs, Toggle, formatBytes, formatMoney } from './ui';

type Tab = 'clips' | 'rules' | 'brief' | 'media';

function RulesEditor({ campaign }: { campaign: Campaign }) {
  const updateCampaign = useStudio((s) => s.updateCampaign);
  const rules = effectiveRules(campaign);
  const set = (patch: Partial<CampaignRules>) => void updateCampaign(campaign.id, { overrides: { ...(campaign.overrides ?? {}), ...patch } });
  const list = (v: string) =>
    v
      .split(/[\s,]+/)
      .map(normalizeHashtag)
      .filter(Boolean);
  return (
    <div className="panel">
      <p className="muted">Rules imported from Vyro. Edits are saved locally and survive re-syncs. Every generated clip is checked against these.</p>
      <div className="form-grid">
        <Field label="Minimum length (s)">
          <input className="input" type="number" value={rules.minDurationSec ?? ''} onChange={(e) => set({ minDurationSec: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
        <Field label="Maximum length (s)">
          <input className="input" type="number" value={rules.maxDurationSec ?? ''} onChange={(e) => set({ maxDurationSec: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
        <Field label="Required hashtags (max 5)">
          <input className="input" defaultValue={rules.hashtags.join(' ')} onBlur={(e) => set({ hashtags: list(e.target.value).slice(0, 5) })} />
        </Field>
        <Field label="Disclosure hashtag">
          <input className="input" defaultValue={rules.disclosureHashtags.join(' ')} onBlur={(e) => set({ disclosureHashtags: list(e.target.value) })} placeholder="#ad" />
        </Field>
      </div>
      <Field label="Required caption text">
        <textarea className="input" rows={2} defaultValue={rules.caption ?? ''} onBlur={(e) => set({ caption: e.target.value.trim() || undefined })} maxLength={300} />
      </Field>
      <Field label="Required text on screen (burned into the video)">
        <input className="input" defaultValue={rules.textOnScreen ?? ''} onBlur={(e) => set({ textOnScreen: e.target.value.trim() || undefined })} maxLength={300} />
      </Field>
      <Field label="Logo image URLs (shown in the video)" hint={rules.logoNotes}>
        <input className="input" defaultValue={rules.logoUrls.join(' ')} onBlur={(e) => set({ logoUrls: e.target.value.split(/\s+/).filter((u) => /^https?:|^data:/.test(u)) })} />
      </Field>
      <div className="row gap wrap">
        <Toggle checked={rules.subtitlesRequired} onChange={(v) => set({ subtitlesRequired: v })} label="Subtitles required" />
        <Toggle checked={rules.allowCollab} onChange={(v) => set({ allowCollab: v })} label="Collab / tagging allowed" />
      </div>
      <Field label="Platforms">
        <div className="row gap wrap">
          {PLATFORMS.map((p) => (
            <Toggle key={p} checked={rules.platforms.includes(p)} onChange={(v) => set({ platforms: v ? [...rules.platforms, p] : rules.platforms.filter((x: Platform) => x !== p) })} label={p} />
          ))}
        </div>
      </Field>
      {rules.audio.length > 0 && (
        <div className="callout">
          <b>Campaign sound required</b> — add it in the TikTok/Instagram app when posting:
          <ul>
            {rules.audio.map((a) => (
              <li key={a.url}>
                {a.platform}:{' '}
                <a href={a.url} target="_blank" rel="noreferrer">
                  {a.url}
                </a>
              </li>
            ))}
          </ul>
          {rules.audioNotes && <p>{rules.audioNotes}</p>}
        </div>
      )}
      <div className="two-col">
        <div>
          <h4>Do ✓</h4>
          <ul className="rule-list">{rules.briefDos.length ? rules.briefDos.map((d) => <li key={d}>{d}</li>) : <li className="muted">Nothing detected</li>}</ul>
        </div>
        <div>
          <h4>Don't ✕</h4>
          <ul className="rule-list bad">{rules.briefDonts.length ? rules.briefDonts.map((d) => <li key={d}>{d}</li>) : <li className="muted">Nothing detected</li>}</ul>
        </div>
      </div>
      {campaign.overrides && Object.keys(campaign.overrides).length > 0 && (
        <Button kind="ghost" onClick={() => void updateCampaign(campaign.id, { overrides: undefined })}>
          Reset to Vyro rules
        </Button>
      )}
    </div>
  );
}

function FrameioBrowser({ link, campaign, used, onClip }: { link: MediaLink; campaign: Campaign; used: Set<string>; onClip: (l: MediaLink) => void }) {
  const settings = useStudio((s) => s.settings);
  const [state, setState] = useState<{ loading: boolean; error?: string; share?: FrameioShare }>({ loading: false });
  const load = async () => {
    setState({ loading: true });
    try {
      setState({ loading: false, share: await resolveShare(link.url, settings) });
    } catch (err) {
      setState({ loading: false, error: (err as Error).message });
    }
  };
  if (!state.share) {
    return (
      <div className="row gap center-v">
        <Button size="sm" kind="primary" onClick={() => void load()} disabled={state.loading}>
          {state.loading ? 'Opening…' : state.error ? 'Retry' : '📂 Browse files'}
        </Button>
        {state.error && <span className="small bad">{state.error}</span>}
      </div>
    );
  }
  const ranked = rankForClipping(state.share.files);
  const files = [...ranked, ...state.share.files.filter((f) => f.kind === 'audio')];
  const hasLong = ranked.some(isLongForm);
  return (
    <div className="share-files">
      <div className="muted small">
        {state.share.name ?? 'Frame.io share'} · {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(files.reduce((n, f) => n + (f.size ?? 0), 0))}
        {hasLong && ranked.some((f) => !isLongForm(f)) ? ' · full episodes first (pre-cut shorts below)' : ''}
      </div>
      {files.map((f) => {
        const pick = chooseRendition(f);
        return (
          <div key={f.id} className="share-file">
            {f.thumbnail ? <img className="share-thumb" src={f.thumbnail} alt="" loading="lazy" crossOrigin="anonymous" /> : <span className="share-thumb">{f.kind === 'audio' ? '🎧' : '🎬'}</span>}
            <span className="media-url" title={f.name}>
              {f.name}
            </span>
            {f.kind === 'video' && <Badge tone={isLongForm(f) ? 'good' : 'default'}>{isLongForm(f) ? 'Full length' : 'Short edit'}</Badge>}
            <span className="muted small" title={pick && pick.label !== 'original' ? `Original: ${formatBytes(f.size)}${f.mime ? ` (${f.mime})` : ''}` : undefined}>
              {f.duration ? `${formatTime(f.duration)} · ` : ''}
              {formatBytes(pick?.size ?? f.size)}
              {f.width ? ` · ${f.width}×${f.height}` : ''}
              {pick && pick.label !== 'original' ? ` · ${pick.label}` : ''}
            </span>
            {used.has(`${link.url}#${f.id}`) ? (
              <Badge tone="accent">Added</Badge>
            ) : (
              <Button size="sm" kind="primary" disabled={!pick} title={pick ? undefined : 'Downloads are disabled for this file'} onClick={() => onClip({ url: link.url, kind: 'frameio', fileId: f.id, label: f.name, size: pick?.size ?? f.size })}>
                ✂ Clip this
              </Button>
            )}
          </div>
        );
      })}
      {!files.length && <span className="muted small">No video files in this share.</span>}
      <span className="muted small">Campaign: {campaign.name}</span>
    </div>
  );
}

function MediaPanel({ campaign }: { campaign: Campaign }) {
  const { createProjectFromLink, createProjectFromFile, runPipeline, updateCampaign, projects, toast } = useStudio();
  const [url, setUrl] = useState('');
  const campaignProjects = projects.filter((p) => p.campaignId === campaign.id);
  const used = new Set(campaignProjects.map((p) => p.source.url));
  const usedFiles = new Set(campaignProjects.map((p) => `${p.source.url}#${p.source.fileId ?? ''}`));
  const clipLink = async (link: MediaLink) => {
    try {
      const p = await createProjectFromLink(link, campaign.id);
      void runPipeline(p.id);
      void updateCampaign(campaign.id, {});
    } catch {
      /* toast shown by store */
    }
  };
  return (
    <div className="panel">
      <h3>Content to use</h3>
      {campaign.mediaNotes && <p className="callout">{campaign.mediaNotes}</p>}
      {campaign.media.length === 0 && <p className="muted">This campaign has no source links. Drop the source video below.</p>}
      <div className="media-list">
        {campaign.media.map((m) => (
          <div key={m.url} className="media-item column">
            <div className="row gap center-v">
              <Badge tone={isDownloadable(m.kind) ? 'good' : needsServerResolver(m.kind) ? 'warn' : 'default'}>{m.kind === 'frameio' ? 'Frame.io' : m.kind}</Badge>
              <a href={m.url} target="_blank" rel="noreferrer" className="media-url" title={m.url}>
                {m.label && m.label !== 'added' ? m.label : m.url}
              </a>
              {m.kind === 'frameio' ? null : used.has(m.url) ? (
                <Badge tone="accent">Added</Badge>
              ) : m.kind === 'gdrive-folder' || m.kind === 'page' || m.kind === 'image' ? (
                <span className="muted small">Open & download, then drop the file</span>
              ) : (
                <Button size="sm" kind="primary" onClick={() => void clipLink(m)} title={needsServerResolver(m.kind) ? 'Downloads through the VyroClipper server (yt-dlp)' : undefined}>
                  ✂ Clip this
                </Button>
              )}
            </div>
            {m.kind === 'frameio' && <FrameioBrowser link={m} campaign={campaign} used={usedFiles} onClip={(l) => void clipLink(l)} />}
          </div>
        ))}
      </div>
      <div className="row gap">
        <input className="input" placeholder="Paste a video link (MP4, Google Drive, Dropbox, YouTube…)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Button
          disabled={!/^https?:\/\//.test(url)}
          onClick={async () => {
            const link: MediaLink = { url, kind: classifyMediaUrl(url), label: 'added' };
            await updateCampaign(campaign.id, { media: [...campaign.media, link] });
            setUrl('');
            void clipLink(link);
          }}
        >
          Add & clip
        </Button>
      </div>
      <DropZone
        accept="video/*,audio/*,.mkv,.mov"
        onFiles={async (files) => {
          for (const f of files) {
            const p = await createProjectFromFile(f, campaign.id);
            void runPipeline(p.id);
          }
          toast('info', `Added ${files.length} file${files.length > 1 ? 's' : ''}. Processing starts automatically.`);
        }}
      >
        <div className="drop-inner">
          <div className="drop-icon">⬆</div>
          <b>Drop the source video here</b>
          <span className="muted small">MP4, MOV, WebM, MKV · long-form videos, streams & podcasts · stays on your device</span>
        </div>
      </DropZone>
    </div>
  );
}

export function CampaignView({ id, tab: initialTab }: { id: string; tab?: Tab }) {
  const campaign = useCampaign(id);
  const { projects, navigate, clipCampaign, updateCampaign, deleteCampaign } = useStudio();
  const [tab, setTab] = useState<Tab>(initialTab ?? 'clips');
  const campaignProjects = useMemo(() => projects.filter((p) => p.campaignId === id), [projects, id]);
  const insights = useMemo(() => parseBrief(campaign?.brief ?? ''), [campaign?.brief]);
  if (!campaign) return <Empty icon="🤷" title="Campaign not found" />;
  const rules = effectiveRules(campaign);
  return (
    <div className="page">
      <button className="link back" onClick={() => navigate({ name: 'campaigns' })}>
        ← Campaigns
      </button>
      <div className="page-head">
        <div className="row gap center-v">
          {(campaign.brandImage || campaign.image) && <img className="brand-img lg" src={campaign.brandImage ?? campaign.image} alt="" referrerPolicy="no-referrer" />}
          <div>
            <div className="muted small">{campaign.brand ?? (campaign.source === 'vyro' ? 'Vyro campaign' : 'Manual campaign')}</div>
            <h1>{campaign.name}</h1>
            <div className="row gap center-v wrap">
              {campaign.cpm !== undefined && <Badge tone="accent">{campaign.cpmIsRange ? 'up to ' : ''}{formatMoney(campaign.cpm)} / 1K views</Badge>}
              {campaign.budgetRemaining !== undefined && <Badge>{formatMoney(campaign.budgetRemaining)} budget left</Badge>}
              {campaign.minViewsPerClip ? <Badge title="Views a clip needs before it starts earning">Min {campaign.minViewsPerClip.toLocaleString()} views / clip</Badge> : null}
              {campaign.enrolled && <Badge tone="good">Joined</Badge>}
              {campaign.locked && <Badge tone="bad">Locked</Badge>}
              {campaign.endDate && <Badge>Ends {new Date(campaign.endDate).toLocaleDateString()}</Badge>}
              <PlatformIcons platforms={rules.platforms} />
            </div>
          </div>
        </div>
        <div className="row gap wrap">
          {campaign.url && (
            <a className="btn btn-ghost" href={campaign.url} target="_blank" rel="noreferrer">
              Open on Vyro ↗
            </a>
          )}
          {campaign.submitUrl && campaign.source === 'vyro' && (
            <a className="btn btn-subtle" href={campaign.submitUrl} target="_blank" rel="noreferrer">
              Submit clips ↗
            </a>
          )}
          <Button kind="primary" onClick={() => void clipCampaign(campaign.id)}>
            ✂ Clip campaign videos
          </Button>
        </div>
      </div>
      <RuleChips campaign={campaign} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'clips', label: `Clips (${campaignProjects.reduce((n, p) => n + p.clips.length, 0)})` },
          { value: 'media', label: `Source videos (${campaign.media.length})` },
          { value: 'rules', label: 'Rules' },
          { value: 'brief', label: 'Brief' },
        ]}
      />
      {tab === 'clips' &&
        (campaignProjects.length ? (
          campaignProjects.map((p) => <ProjectSection key={p.id} project={p} campaign={campaign} />)
        ) : (
          <Empty icon="✂️" title="No clips yet">
            <p className="muted">Download the campaign's source videos or drop a file to start.</p>
            <div className="row gap center">
              <Button kind="primary" onClick={() => void clipCampaign(campaign.id)}>
                Clip campaign videos
              </Button>
              <Button onClick={() => setTab('media')}>Add a source video</Button>
            </div>
          </Empty>
        ))}
      {tab === 'media' && <MediaPanel campaign={campaign} />}
      {tab === 'rules' && <RulesEditor campaign={campaign} />}
      {tab === 'brief' && (
        <div className="panel">
          <div className="chips">
            {insights.keywords.map((k) => (
              <Badge key={k}>{k}</Badge>
            ))}
          </div>
          {insights.focus.length > 0 && (
            <p>
              <b>Focus:</b> {insights.focus.join(' · ')}
            </p>
          )}
          <pre className="brief">{campaign.brief || 'No brief.'}</pre>
          {campaign.source !== 'vyro' && (
            <Field label="Edit brief">
              <textarea className="input" rows={8} defaultValue={campaign.brief} onBlur={(e) => void updateCampaign(campaign.id, { brief: e.target.value })} />
            </Field>
          )}
          <Button
            kind="ghost"
            onClick={() => {
              if (confirm(`Remove campaign “${campaign.name}” from VyroClipper? (Clips/projects are kept)`)) {
                void deleteCampaign(campaign.id);
                navigate({ name: 'campaigns' });
              }
            }}
          >
            Remove campaign
          </Button>
        </div>
      )}
    </div>
  );
}
