import { useCallback, useEffect, useState } from 'react';
import { extensionStatus, onExtensionCampaignsChanged, pullExtensionCampaigns, syncFromVyro, type ExtensionStatus } from './bridge';
import { useStudio, type View } from './store';
import { useUpdateCheck } from './updates';
import { CampaignsView } from './components/CampaignsView';
import { CampaignView } from './components/CampaignView';
import { ClipEditor } from './components/ClipEditor';
import { BrandView, ProjectsView, ScheduleView, SettingsView, SingleProjectView } from './components/Views';
import { Button, cx } from './components/ui';
import { BUILD_INFO, isExtensionPage, supportsWebCodecs } from '../shared/env';

function viewToHash(v: View): string {
  switch (v.name) {
    case 'campaign':
      return `#/campaign/${encodeURIComponent(v.id)}${v.tab ? `?tab=${v.tab}` : ''}`;
    case 'project':
      return `#/project/${encodeURIComponent(v.id)}`;
    case 'clip':
      return `#/clip/${encodeURIComponent(v.projectId)}/${encodeURIComponent(v.clipId)}`;
    case 'schedule':
      return `#/schedule${v.campaignId ? `/${encodeURIComponent(v.campaignId)}` : ''}`;
    default:
      return `#/${v.name}`;
  }
}

function hashToView(hash: string): { view: View; select?: string[] } {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query ?? '');
  const parts = (path ?? '').split('/').map(decodeURIComponent);
  const select = params.get('select')?.split(',').filter(Boolean);
  switch (parts[0]) {
    case 'campaign':
      return { view: parts[1] ? { name: 'campaign', id: parts[1], tab: (params.get('tab') as 'clips' | null) ?? undefined } : { name: 'campaigns' } };
    case 'project':
      return { view: parts[1] ? { name: 'project', id: parts[1] } : { name: 'projects' } };
    case 'clip':
      return { view: parts[1] && parts[2] ? { name: 'clip', projectId: parts[1], clipId: parts[2] } : { name: 'campaigns' } };
    case 'schedule':
      return { view: { name: 'schedule', campaignId: parts[1] } };
    case 'projects':
    case 'brand':
    case 'settings':
      return { view: { name: parts[0] } };
    default:
      return { view: { name: 'campaigns' }, select };
  }
}

function Toasts() {
  const { toasts, dismissToast } = useStudio();
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `toast-${t.kind}`)} onClick={() => dismissToast(t.id)}>
          <div>{t.text}</div>
          {t.hint && <div className="toast-hint">{t.hint}</div>}
        </div>
      ))}
    </div>
  );
}

function JobsIndicator() {
  // Select the stable map: deriving a new array inside the selector would re-render forever (zustand v5).
  const jobMap = useStudio((s) => s.jobs);
  const jobs = Object.values(jobMap);
  if (!jobs.length) return null;
  return (
    <div className="jobs-indicator" title={jobs.map((j) => `${j.label} ${Math.round(j.pct)}%`).join('\n')}>
      <span className="spinner" /> {jobs.length} running
    </div>
  );
}

export function App() {
  const { ready, init, view, navigate, upsertCampaigns, toast, campaigns, updateCampaign } = useStudio();
  const [ext, setExt] = useState<ExtensionStatus>({ connected: false });
  const [syncing, setSyncing] = useState(false);
  const [pendingSelect, setPendingSelect] = useState<string[] | undefined>(() => hashToView(location.hash).select);
  const update = useUpdateCheck();

  useEffect(() => {
    // Read-only debugging/automation handle (used by the e2e tests).
    (window as Window & { __vyroclipper?: unknown }).__vyroclipper = { getState: useStudio.getState };
  }, []);

  useEffect(() => {
    void init().then(() => {
      const { view: v } = hashToView(location.hash);
      useStudio.setState({ view: v });
    });
  }, [init]);

  // Keep the URL hash in sync (refresh-safe deep links, browser back/forward).
  useEffect(() => {
    if (!ready) return;
    const h = viewToHash(view);
    if (location.hash.split('?select=')[0] !== h) history.replaceState(null, '', h);
  }, [view, ready]);
  useEffect(() => {
    const onHash = () => {
      const { view: v, select } = hashToView(location.hash);
      useStudio.setState({ view: v });
      if (select) setPendingSelect(select);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const pullFromExtension = useCallback(async () => {
    try {
      const { campaigns: list, selected } = await pullExtensionCampaigns();
      if (list.length) await upsertCampaigns(list.map((c) => ({ ...c, selected: c.selected || selected.includes(c.id) })));
    } catch (err) {
      console.warn('extension pull failed', err);
    }
  }, [upsertCampaigns]);

  useEffect(() => {
    if (!ready) return;
    let stop: (() => void) | undefined;
    void (async () => {
      const st = await extensionStatus();
      setExt(st);
      if (!st.connected) return;
      await pullFromExtension();
      stop = onExtensionCampaignsChanged(() => void pullFromExtension());
    })();
    return () => stop?.();
  }, [ready, pullFromExtension]);

  // Campaigns chosen in the extension popup ("Clip selected") arrive as ?select=…
  useEffect(() => {
    if (!ready || !pendingSelect?.length) return;
    const known = pendingSelect.filter((id) => campaigns.some((c) => c.id === id));
    if (!known.length) return;
    for (const id of known) void updateCampaign(id, { selected: true });
    setPendingSelect(undefined);
    if (known.length === 1) navigate({ name: 'campaign', id: known[0]! });
    else toast('info', `${known.length} campaigns selected from the extension — click “Generate clips for selected”.`);
  }, [ready, pendingSelect, campaigns, updateCampaign, navigate, toast]);

  const onSync = async () => {
    if (!ext.connected) {
      toast('info', 'Install the VyroClipper Chrome extension to sync campaigns from app.vyro.com.', 'Load unpacked → dist/extension, then reload this page.');
      return;
    }
    setSyncing(true);
    try {
      const r = await syncFromVyro();
      if (!r.ok) throw new Error(r.error ?? 'Sync failed');
      await pullFromExtension();
      toast('success', `Synced ${r.count ?? 0} campaigns from Vyro.`);
    } catch (err) {
      toast('error', (err as Error).message, 'Make sure you are logged in at app.vyro.com in this browser.');
    } finally {
      setSyncing(false);
    }
  };

  if (!ready) return <div className="boot">Loading VyroClipper…</div>;
  const nav: Array<{ name: View['name']; label: string; icon: string }> = [
    { name: 'campaigns', label: 'Campaigns', icon: '🎯' },
    { name: 'projects', label: 'Quick clip', icon: '✂️' },
    { name: 'schedule', label: 'Posting plan', icon: '📅' },
    { name: 'brand', label: 'Brand kit', icon: '🎨' },
    { name: 'settings', label: 'Settings', icon: '⚙️' },
  ];
  const active = view.name === 'campaign' || view.name === 'clip' ? 'campaigns' : view.name === 'project' ? 'projects' : view.name;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo" onClick={() => navigate({ name: 'campaigns' })}>
          <span className="logo-mark">✂</span>
          <span>
            Vyro<b>Clipper</b>
          </span>
        </div>
        <nav>
          {nav.map((n) => (
            <button key={n.name} className={cx('nav-item', active === n.name && 'active')} onClick={() => navigate({ name: n.name } as View)}>
              <span>{n.icon}</span> {n.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <JobsIndicator />
          <div className={cx('ext-status', ext.connected && 'on')} title={ext.connected ? `Extension v${ext.version} connected` : 'Chrome extension not detected'}>
            <span className="dot" /> {isExtensionPage() ? 'Extension studio' : ext.connected ? 'Extension connected' : 'No extension'}
          </div>
          <div className="muted small">
            v{BUILD_INFO.version} · {BUILD_INFO.shortCommit}
          </div>
        </div>
      </aside>
      <main className="main">
        {update.available && (
          <div className="update-banner">
            New version deployed ({update.available.shortCommit}
            {update.available.message ? `: ${update.available.message}` : ''}).{' '}
            <Button size="sm" kind="primary" onClick={update.reload}>
              Reload now
            </Button>
          </div>
        )}
        {!supportsWebCodecs() && <div className="callout error">This browser lacks WebCodecs — use the latest Chrome or Edge to render videos.</div>}
        {view.name === 'campaigns' && <CampaignsView extConnected={ext.connected} onSync={() => void onSync()} syncing={syncing} />}
        {view.name === 'campaign' && <CampaignView key={view.id} id={view.id} tab={view.tab} />}
        {view.name === 'projects' && <ProjectsView />}
        {view.name === 'project' && <SingleProjectView id={view.id} />}
        {view.name === 'clip' && <ClipEditor key={view.clipId} projectId={view.projectId} clipId={view.clipId} />}
        {view.name === 'schedule' && <ScheduleView campaignId={view.campaignId} />}
        {view.name === 'brand' && <BrandView />}
        {view.name === 'settings' && <SettingsView />}
      </main>
      <Toasts />
    </div>
  );
}
