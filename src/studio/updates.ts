import { useEffect, useState } from 'react';
import { BUILD_INFO, isExtensionPage } from '../shared/env';
import { useStudio } from './store';

export interface DeployedVersion {
  commit: string;
  shortCommit: string;
  message?: string;
  builtAt?: string;
}

/**
 * Detects new deployments: the server rebuilds on every git commit and publishes build-info.json.
 * Client-executed JS is then refreshed (automatically when idle, if enabled).
 */
export function useUpdateCheck(intervalMs = 60000): { available?: DeployedVersion; reload: () => void } {
  const [available, setAvailable] = useState<DeployedVersion>();
  const autoReload = useStudio((s) => s.settings?.autoReloadOnUpdate);
  const busy = useStudio((s) => Object.keys(s.jobs).length > 0);

  useEffect(() => {
    if (isExtensionPage() || BUILD_INFO.commit === 'dev') return;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch(`./build-info.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const info = (await res.json()) as DeployedVersion;
        if (!stopped && info.commit && info.commit !== BUILD_INFO.commit) setAvailable(info);
      } catch {
        /* offline */
      }
    };
    void check();
    const id = setInterval(check, intervalMs);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      stopped = true;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [intervalMs]);

  useEffect(() => {
    if (available && autoReload && !busy) location.reload();
  }, [available, autoReload, busy]);

  return { available, reload: () => location.reload() };
}
