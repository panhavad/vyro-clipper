import { useMemo, useState } from 'react';
import type { Campaign } from '../../core/types';
import { effectiveRules, findCampaignsInPayload, normalizeVyroCampaign } from '../../core/vyro';
import { useStudio } from '../store';
import { Badge, Button, Empty, Field, Modal, cx, formatMoney } from './ui';

const PLATFORM_ICON: Record<string, string> = { tiktok: '♪', instagram: '◎', youtube: '▶', x: '𝕏' };

export function PlatformIcons({ platforms }: { platforms: string[] }) {
  return (
    <span className="platforms">
      {platforms.map((p) => (
        <span key={p} className={`plat plat-${p}`} title={p}>
          {PLATFORM_ICON[p] ?? p}
        </span>
      ))}
    </span>
  );
}

export function RuleChips({ campaign }: { campaign: Campaign }) {
  const r = effectiveRules(campaign);
  return (
    <div className="chips">
      {r.minDurationSec ? <Badge tone="accent">≥ {r.minDurationSec}s</Badge> : null}
      {r.maxDurationSec ? <Badge>≤ {r.maxDurationSec}s</Badge> : null}
      {r.subtitlesRequired && <Badge>Subtitles</Badge>}
      {r.textOnScreen && <Badge title={r.textOnScreen}>Text on screen</Badge>}
      {r.logoUrls.length > 0 && <Badge>Logo</Badge>}
      {r.hashtags.length > 0 && <Badge title={r.hashtags.join(' ')}>{r.hashtags.length} hashtag{r.hashtags.length > 1 ? 's' : ''}</Badge>}
      {r.disclosureHashtags.length > 0 && <Badge tone="warn">{r.disclosureHashtags.join(' ')}</Badge>}
      {r.audio.length > 0 && <Badge tone="warn">Campaign sound</Badge>}
      {r.caption && <Badge title={r.caption}>Caption</Badge>}
    </div>
  );
}

function CampaignCard({ c, clipCount, onToggle }: { c: Campaign; clipCount: number; onToggle: (v: boolean) => void }) {
  const navigate = useStudio((s) => s.navigate);
  const spentPct = c.budgetTotal ? Math.min(100, ((c.budgetTotal - (c.budgetRemaining ?? c.budgetTotal)) / c.budgetTotal) * 100) : undefined;
  return (
    <div className={cx('card campaign-card', c.selected && 'selected', c.locked && 'locked')}>
      <div className="campaign-top">
        <label className="check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={!!c.selected} onChange={(e) => onToggle(e.target.checked)} />
        </label>
        {c.brandImage || c.image ? <img className="brand-img" src={c.brandImage ?? c.image} alt="" referrerPolicy="no-referrer" /> : <div className="brand-img placeholder">{(c.brand ?? c.name).slice(0, 1)}</div>}
        <div className="campaign-meta" onClick={() => navigate({ name: 'campaign', id: c.id })}>
          <div className="muted small">
            {c.brand ?? (c.source === 'vyro' ? 'Vyro' : 'Manual')} {c.type && c.type !== 'clipping' ? `· ${c.type.toUpperCase()}` : ''}
            {c.enrolled ? ' · ✓ Joined' : ''}
            {c.locked ? ' · 🔒 Locked' : ''}
          </div>
          <h3 className="campaign-name">{c.name}</h3>
        </div>
      </div>
      <div className="campaign-stats" onClick={() => navigate({ name: 'campaign', id: c.id })}>
        <div>
          <span className="stat-big">
            {c.cpmIsRange ? <span className="small muted">up to </span> : null}
            {c.cpm !== undefined ? formatMoney(c.cpm) : '—'}
          </span>
          <span className="muted small"> / 1K views</span>
        </div>
        <PlatformIcons platforms={effectiveRules(c).platforms} />
      </div>
      {spentPct !== undefined && (
        <div className="budget" title={`${formatMoney(c.budgetRemaining)} remaining of ${formatMoney(c.budgetTotal)}`}>
          <div className="budget-bar">
            <div style={{ width: `${spentPct}%` }} />
          </div>
          <span className="muted small">{formatMoney(c.budgetRemaining)} left</span>
        </div>
      )}
      <RuleChips campaign={c} />
      <div className="campaign-foot">
        <span className="muted small">
          {c.media.length} source link{c.media.length === 1 ? '' : 's'} · {clipCount} clip{clipCount === 1 ? '' : 's'}
        </span>
        <Button size="sm" kind="ghost" onClick={() => navigate({ name: 'campaign', id: c.id })}>
          Open →
        </Button>
      </div>
    </div>
  );
}

export function NewCampaignModal({ onClose }: { onClose: () => void }) {
  const { createManualCampaign, upsertCampaigns, navigate, toast } = useStudio();
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [json, setJson] = useState('');
  const [mode, setMode] = useState<'manual' | 'json'>('manual');
  return (
    <Modal title="Add campaign" onClose={onClose}>
      <div className="row gap">
        <Button kind={mode === 'manual' ? 'primary' : 'subtle'} size="sm" onClick={() => setMode('manual')}>
          Write brief
        </Button>
        <Button kind={mode === 'json' ? 'primary' : 'subtle'} size="sm" onClick={() => setMode('json')}>
          Paste Vyro JSON
        </Button>
      </div>
      {mode === 'manual' ? (
        <>
          <Field label="Campaign name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Beast Games clips" autoFocus />
          </Field>
          <Field label="Brief & rules" hint="Paste the campaign brief. Durations, hashtags, @mentions, do's and don'ts are detected automatically — you can fine-tune them later.">
            <textarea className="input" rows={9} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={'Clip the funniest moments.\n• Videos must be at least 30 seconds.\n• Use #BeastGames and tag @MrBeast.\n• Do not add music.'} />
          </Field>
          <div className="row end">
            <Button
              kind="primary"
              disabled={!name.trim()}
              onClick={async () => {
                const c = await createManualCampaign(name.trim(), brief);
                onClose();
                navigate({ name: 'campaign', id: c.id, tab: 'media' });
              }}
            >
              Create campaign
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field label="Vyro API response" hint="From app.vyro.com → DevTools → Network → catalog/campaigns. Any response that contains campaigns works. The Chrome extension does this automatically.">
            <textarea className="input mono" rows={12} value={json} onChange={(e) => setJson(e.target.value)} placeholder='{"data":[{"id":"…","name":"…","requirements":{…},"media":{"links":[…]}}]}' />
          </Field>
          <div className="row end">
            <Button
              kind="primary"
              disabled={!json.trim()}
              onClick={async () => {
                try {
                  const found = findCampaignsInPayload(JSON.parse(json));
                  if (!found.length) throw new Error('No campaigns found in that JSON.');
                  const added = await upsertCampaigns(found.map((f) => normalizeVyroCampaign(f)));
                  toast('success', `Imported ${found.length} campaign(s) (${added} new).`);
                  onClose();
                } catch (err) {
                  toast('error', (err as Error).message);
                }
              }}
            >
              Import
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function CampaignsView({ extConnected, onSync, syncing }: { extConnected: boolean; onSync: () => void; syncing: boolean }) {
  const { campaigns, projects, updateCampaign, clipCampaign, deleteCampaign } = useStudio();
  const [query, setQuery] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [sort, setSort] = useState<'recent' | 'cpm' | 'budget'>('recent');
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const list = campaigns.filter((c) => !q || `${c.name} ${c.brand ?? ''} ${c.brief}`.toLowerCase().includes(q));
    if (sort === 'cpm') list.sort((a, b) => (b.cpm ?? 0) - (a.cpm ?? 0));
    if (sort === 'budget') list.sort((a, b) => (b.budgetRemaining ?? 0) - (a.budgetRemaining ?? 0));
    return list;
  }, [campaigns, query, sort]);
  const selected = campaigns.filter((c) => c.selected);
  const clipCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of projects) if (p.campaignId) m.set(p.campaignId, (m.get(p.campaignId) ?? 0) + p.clips.length);
    return m;
  }, [projects]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p className="muted">Select Vyro campaigns → VyroClipper reads the brief & rules, downloads the “Content to Use”, finds the viral moments and renders compliant shorts with virality scores.</p>
        </div>
        <div className="row gap">
          <Button kind="primary" onClick={onSync} disabled={syncing} title={extConnected ? 'Fetch all campaigns from your logged-in app.vyro.com session' : 'Requires the VyroClipper Chrome extension'}>
            {syncing ? 'Syncing…' : '⟳ Sync from Vyro'}
          </Button>
          <Button onClick={() => setShowNew(true)}>+ Add campaign</Button>
        </div>
      </div>

      {!extConnected && (
        <div className="callout">
          <b>Connect your Vyro account.</b> Install the VyroClipper Chrome extension (Load unpacked → <code>dist/extension</code>), open{' '}
          <a href="https://app.vyro.com" target="_blank" rel="noreferrer">
            app.vyro.com
          </a>{' '}
          while logged in, and click <i>Sync from Vyro</i>. You can also add campaigns manually or paste the Vyro API JSON.
        </div>
      )}

      <div className="toolbar">
        <input className="input search" placeholder="Search campaigns, brands, briefs…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="recent">Recently updated</option>
          <option value="cpm">Highest CPM</option>
          <option value="budget">Most budget left</option>
        </select>
      </div>

      {selected.length > 0 && (
        <div className="bulkbar">
          <span>
            <b>{selected.length}</b> campaign{selected.length > 1 ? 's' : ''} selected
          </span>
          <div className="row gap">
            <Button kind="primary" onClick={() => selected.forEach((c) => void clipCampaign(c.id))}>
              ✂ Generate clips for selected
            </Button>
            <Button kind="ghost" onClick={() => selected.forEach((c) => void updateCampaign(c.id, { selected: false }))}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <Empty icon="🎯" title="No campaigns yet">
          <p className="muted">Sync from Vyro with the extension, or add a campaign manually.</p>
          <Button kind="primary" onClick={() => setShowNew(true)}>
            + Add campaign
          </Button>
        </Empty>
      ) : (
        <div className="grid campaigns-grid">
          {filtered.map((c) => (
            <CampaignCard key={c.id} c={c} clipCount={clipCounts.get(c.id) ?? 0} onToggle={(v) => void updateCampaign(c.id, { selected: v })} />
          ))}
        </div>
      )}
      {showNew && <NewCampaignModal onClose={() => setShowNew(false)} />}
      {campaigns.length > 0 && (
        <p className="muted small center" style={{ marginTop: 24 }}>
          Campaigns, transcripts and videos stay in this browser (IndexedDB + private file storage). Nothing is uploaded.{' '}
          <button className="link" onClick={() => campaigns.filter((c) => !c.selected && c.source === 'manual' && !clipCounts.get(c.id)).forEach((c) => void deleteCampaign(c.id))}>
            Remove empty manual campaigns
          </button>
        </p>
      )}
    </div>
  );
}
