import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildInfo {
  name: string;
  version: string;
  commit: string;
  shortCommit: string;
  branch: string;
  message: string;
  builtAt: string;
  target: 'web' | 'extension';
}

function git(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

export function getBuildInfo(target: BuildInfo['target'], cwd = process.cwd()): BuildInfo {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name: string; version: string };
  const commit = process.env.GIT_COMMIT || git('rev-parse HEAD', cwd) || 'dev';
  return {
    name: pkg.name,
    version: pkg.version,
    commit,
    shortCommit: commit.slice(0, 7),
    branch: process.env.GIT_BRANCH || git('rev-parse --abbrev-ref HEAD', cwd) || 'unknown',
    message: (process.env.GIT_MESSAGE || git('log -1 --pretty=%s', cwd)).slice(0, 200),
    builtAt: new Date().toISOString(),
    target,
  };
}

/** Vite plugin that writes build-info.json next to the bundle so clients can detect new deployments. */
export function buildInfoPlugin(info: BuildInfo) {
  return {
    name: 'vyroclipper-build-info',
    generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): string }) {
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(info, null, 2) });
    },
  };
}
