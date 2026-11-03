import { useEffect, useMemo, useState } from 'react';
import type { Platform } from '../../core/types';
import { PLATFORMS } from '../../core/types';
import { planPosts, toIcs } from '../../core/schedule';
import { CAPTION_STYLES } from '../../core/captions';
import { downloadFiles, postCaptionFor } from '../../engine/exportService';
import { storageEstimate } from '../../engine/storage';
import { WHISPER_MODELS, type AppSettings } from '../../shared/settings';
import { BUILD_INFO } from '../../shared/env';
import { useProject } from '../hooks';
import { useStudio } from '../store';
import { ProjectSection } from './ProjectParts';
import { Badge, Button, DropZone, Empty, Field, Select, Toggle, formatBytes } from './ui';

export function ProjectsView() {
  const { projects, createProjectFromFile, runPipeline, campaigns } = useStudio();
  const loose = projects.filter((p) => !p.campaignId || !campaigns.some((c) => c.id === p.campaignId));
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Quick clip</h1>
          <p className="muted">Drop any long video, stream or podcast to get viral clips without a campaign. For Vyro campaigns, open the campaign instead so rules are applied.</p>
        </div>
      </div>
      <DropZone
        accept="video/*,audio/*,.mkv,.mov"
        onFiles={async (files) => {
          for (const f of files) {
            const p = await createProjectFromFile(f);
            void runPipeline(p.id);
          }
        }}
      >
        <div className="drop-inner">
          <div className="drop-icon">⬆</div>
          <b>Drop videos here or click to choose</b>
          <span className="muted small">Processing happens 100% in your browser.</span>
        </div>
      </DropZone>
      {loose.map((p) => (
        <ProjectSection key={p.id} project={p} />
      ))}
    </div>
  );
}

export function SingleProjectView({ id }: { id: string }) {
  const project = useProject(id);
  const navigate = useStudio((s) => s.navigate);
  if (!project) return <Empty icon="🤷" title="Project not found" />;
  return (
    <div className="page">
      <button className="link back" onClick={() => navigate({ name: 'campaigns' })}>
        ← Back
      </button>
      <ProjectSection project={project} />
    </div>
  );
}

export function ScheduleView({ campaignId: initial }: { campaignId?: string }) {
  const { campaigns, projects, settings, saveSettings } = useStudio();
  const [campaignId, setCampaignId] = useState(initial ?? campaigns[0]?.id ?? '');
  const [handle, setHandle] = useState('');
  const [platform, setPlatform] = useState<Platform>('tiktok');
  const [onlyRendered, setOnlyRendered] = useState(true);
  const campaign = campaigns.find((c) => c.id === campaignId);
  const clips = useMemo(
    () =>
      projects
        .filter((p) => p.campaignId === campaignId)
        .flatMap((p) => p.clips)
        .filter((c) => !onlyRendered || c.status === 'rendered')
        .sort((a, b) => b.scores.total - a.scores.total),
    [projects, campaignId, onlyRendered],
  );
  if (!settings) return null;
  const platforms = (campaign?.rules.platforms ?? PLATFORMS).filter((p) => settings.accounts.some((a) => a.platform === p));
  const slots = planPosts(
    clips.map((c) => ({ id: c.id, title: c.title })),
    { accounts: settings.accounts, platforms, start: new Date(), perAccountPerDay: campaign?.rules.postsPerAccountPerDay, maxPendingBeforeApproval: campaign?.rules.maxPendingBeforeApproval },
  );
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Posting plan</h1>
          <p className="muted">Vyro limits: max 5 posts per account per campaign every 24h, and only 3 clips can wait for review until your first approval. Don't post the same video twice on one platform.</p>
        </div>
      </div>
      <div className="panel">
        <h3>Your social accounts</h3>
        <div className="row gap wrap">
          {settings.accounts.map((a, i) => (
            <Badge key={`${a.platform}-${a.handle}`}>
              {a.platform} @{a.handle}{' '}
              <button className="link" onClick={() => void saveSettings({ ...settings, accounts: settings.accounts.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </Badge>
          ))}
          {!settings.accounts.length && <span className="muted">Add the accounts you post from.</span>}
        </div>
        <div className="row gap">
          <Select value={platform} onChange={setPlatform} options={PLATFORMS.map((p) => ({ value: p, label: p }))} />
          <input className="input" placeholder="handle" value={handle} onChange={(e) => setHandle(e.target.value.replace(/^@/, ''))} />
          <Button
            disabled={!handle}
            onClick={() => {
              void saveSettings({ ...settings, accounts: [...settings.accounts, { platform, handle }] });
              setHandle('');
            }}
          >
            Add account
          </Button>
        </div>
      </div>
      <div className="panel">
        <div className="row gap wrap center-v">
          <Field label="Campaign">
            <Select value={campaignId} onChange={setCampaignId} options={campaigns.map((c) => ({ value: c.id, label: c.name }))} />
          </Field>
          <Toggle checked={onlyRendered} onChange={setOnlyRendered} label="Only exported clips" />
          <Button
            kind="primary"
            disabled={!slots.length}
            onClick={() => {
              const caps = Object.fromEntries(clips.map((c) => [c.id, postCaptionFor(c, campaign).text]));
              downloadFiles([{ name: 'vyroclipper-posting-plan.ics', blob: new Blob([toIcs(slots, caps, campaign?.name ?? '')], { type: 'text/calendar' }) }]);
            }}
          >
            📅 Download calendar (.ics)
          </Button>
        </div>
        {slots.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Platform</th>
                <th>Account</th>
                <th>Clip</th>
                <th>Phase</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((s) => (
                <tr key={`${s.clipId}-${s.platform}`}>
                  <td>{new Date(s.at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{s.platform}</td>
                  <td>@{s.handle}</td>
                  <td>{s.clipTitle}</td>
                  <td>{s.phase === 'first-batch' ? <Badge tone="warn">Before 1st approval</Badge> : <Badge>After approval</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">{settings.accounts.length ? 'No clips to schedule yet — export some clips first (or untick “Only exported clips”).' : 'Add at least one account for the campaign platforms.'}</p>
        )}
      </div>
    </div>
  );
}

export function BrandView() {
  const { settings, saveSettings, toast } = useStudio();
  if (!settings) return null;
  const b = settings.brand;
  const set = (patch: Partial<AppSettings['brand']>) => void saveSettings({ ...settings, brand: { ...b, ...patch } });
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Brand kit</h1>
          <p className="muted">Default look for every new clip: caption template, colours, watermark logo and call-to-action. Campaign requirements (logo, on-screen text) always take priority.</p>
        </div>
      </div>
      <div className="panel">
        <div className="form-grid">
          <Field label="Brand name">
            <input className="input" value={b.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Default caption style">
            <Select value={b.defaultCaptionStyle} onChange={(v) => set({ defaultCaptionStyle: v })} options={CAPTION_STYLES.map((s) => ({ value: s.id, label: s.name }))} />
          </Field>
          <Field label="Primary colour">
            <input type="color" value={b.primaryColor} onChange={(e) => set({ primaryColor: e.target.value })} />
          </Field>
          <Field label="Accent colour (progress bar, CTA)">
            <input type="color" value={b.accentColor} onChange={(e) => set({ accentColor: e.target.value })} />
          </Field>
        </div>
        <Field label="Call-to-action text">
          <input className="input" value={b.ctaText} onChange={(e) => set({ ctaText: e.target.value })} />
        </Field>
        <Field label="Watermark logo (PNG with transparency works best)">
          <div className="row gap center-v">
            {b.logoDataUrl && <img src={b.logoDataUrl} alt="logo" className="logo-preview" />}
            <input
              type="file"
              accept="image/*"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 1.5e6) return toast('error', 'Logo must be under 1.5 MB');
                const reader = new FileReader();
                reader.onload = () => set({ logoDataUrl: String(reader.result) });
                reader.readAsDataURL(f);
              }}
            />
            {b.logoDataUrl && (
              <Button kind="ghost" onClick={() => set({ logoDataUrl: undefined })}>
                Remove
              </Button>
            )}
          </div>
        </Field>
      </div>
    </div>
  );
}

export function SettingsView() {
  const { settings, saveSettings, toast } = useStudio();
  const [usage, setUsage] = useState<{ usage: number; quota: number }>();
  useEffect(() => {
    void storageEstimate().then(setUsage);
  }, []);
  if (!settings) return null;
  const s = settings;
  const save = (patch: Partial<AppSettings>) => void saveSettings({ ...s, ...patch });
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">
            Everything runs in your browser. API keys are stored locally and only sent to the provider you configure. Version {BUILD_INFO.version} ({BUILD_INFO.shortCommit}).
          </p>
        </div>
      </div>
      <div className="panel">
        <h3>Speech-to-text (captions & transcript)</h3>
        <div className="row gap">
          <Button kind={s.asr.engine === 'local' ? 'primary' : 'subtle'} onClick={() => save({ asr: { ...s.asr, engine: 'local' } })}>
            In-browser Whisper (free, private)
          </Button>
          <Button kind={s.asr.engine === 'openai' ? 'primary' : 'subtle'} onClick={() => save({ asr: { ...s.asr, engine: 'openai' } })}>
            Cloud API (faster)
          </Button>
        </div>
        {s.asr.engine === 'local' ? (
          <div className="form-grid">
            <Field label="Model" hint="Downloaded once from Hugging Face and cached by the browser.">
              <Select value={s.asr.localModel} onChange={(v) => save({ asr: { ...s.asr, localModel: v } })} options={WHISPER_MODELS.map((m) => ({ value: m.id, label: `${m.label} · ~${m.approxMb} MB` }))} />
            </Field>
            <Field label="Device">
              <Select value={s.asr.device} onChange={(v) => save({ asr: { ...s.asr, device: v } })} options={[{ value: 'auto', label: 'Auto (GPU when available)' }, { value: 'webgpu', label: 'WebGPU (GPU)' }, { value: 'wasm', label: 'WASM (CPU)' }]} />
            </Field>
          </div>
        ) : (
          <div className="form-grid">
            <Field label="Base URL" hint="OpenAI: https://api.openai.com/v1 · Groq: https://api.groq.com/openai/v1">
              <input className="input" value={s.asr.openai.baseUrl} onChange={(e) => save({ asr: { ...s.asr, openai: { ...s.asr.openai, baseUrl: e.target.value } } })} />
            </Field>
            <Field label="Model" hint="whisper-1 (OpenAI) · whisper-large-v3-turbo (Groq)">
              <input className="input" value={s.asr.openai.model} onChange={(e) => save({ asr: { ...s.asr, openai: { ...s.asr.openai, model: e.target.value } } })} />
            </Field>
            <Field label="API key">
              <input className="input" type="password" value={s.asr.openai.apiKey} onChange={(e) => save({ asr: { ...s.asr, openai: { ...s.asr.openai, apiKey: e.target.value } } })} />
            </Field>
          </div>
        )}
      </div>
      <div className="panel">
        <h3>AI clip picking (optional)</h3>
        <p className="muted small">The built-in virality engine works offline. Add any OpenAI-compatible model (OpenAI, Groq, OpenRouter, Ollama, LM Studio) for LLM-picked moments, titles and captions.</p>
        <Toggle checked={s.llm.enabled} onChange={(v) => save({ llm: { ...s.llm, enabled: v } })} label="Use an LLM" />
        <div className="form-grid">
          <Field label="Base URL">
            <input className="input" value={s.llm.baseUrl} onChange={(e) => save({ llm: { ...s.llm, baseUrl: e.target.value } })} />
          </Field>
          <Field label="Model">
            <input className="input" value={s.llm.model} onChange={(e) => save({ llm: { ...s.llm, model: e.target.value } })} />
          </Field>
          <Field label="API key">
            <input className="input" type="password" value={s.llm.apiKey} onChange={(e) => save({ llm: { ...s.llm, apiKey: e.target.value } })} />
          </Field>
        </div>
      </div>
      <div className="panel">
        <h3>VyroClipper server</h3>
        <p className="muted small">Optional Docker server: proxies downloads that browsers block (CORS) and fetches YouTube/TikTok links with yt-dlp. Rendering still happens in your browser.</p>
        <div className="form-grid">
          <Field label="Server URL">
            <input className="input" value={s.serverUrl} onChange={(e) => save({ serverUrl: e.target.value })} />
          </Field>
          <Field label="Access token (if API_TOKEN is set on the server)">
            <input className="input" type="password" value={s.serverToken} onChange={(e) => save({ serverToken: e.target.value })} />
          </Field>
        </div>
        <Button
          onClick={async () => {
            try {
              const r = await fetch(`${s.serverUrl.replace(/\/+$/, '')}/api/health`, { headers: s.serverToken ? { 'x-vyroclipper-token': s.serverToken } : {} });
              const j = (await r.json()) as { ok: boolean; ytdlp?: boolean; version?: { shortCommit?: string } };
              toast(j.ok ? 'success' : 'error', `Server ${j.ok ? 'OK' : 'error'} · yt-dlp ${j.ytdlp ? 'available' : 'missing'} · build ${j.version?.shortCommit ?? '?'}`);
            } catch (err) {
              toast('error', `Server unreachable: ${(err as Error).message}`);
            }
          }}
        >
          Test connection
        </Button>
      </div>
      <div className="panel">
        <h3>Processing</h3>
        <Toggle checked={s.faceTracking} onChange={(v) => save({ faceTracking: v })} label="AI reframe: track faces to keep speakers in frame (MediaPipe, on-device)" />
        <Toggle checked={s.autoReloadOnUpdate} onChange={(v) => save({ autoReloadOnUpdate: v })} label="Auto-reload when a new version is deployed (only when idle)" />
        {usage && (
          <p className="muted small">
            Browser storage used: {formatBytes(usage.usage)} of {formatBytes(usage.quota)}
          </p>
        )}
      </div>
    </div>
  );
}
