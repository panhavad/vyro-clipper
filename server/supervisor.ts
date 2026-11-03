// Auto-update supervisor: serves the current release and redeploys on every new git commit.
//
//   source   GIT_REPO_URL (remote) or REPO_DIR (local repo, e.g. bind-mounted at /repo)
//   trigger  polling every GIT_POLL_SECONDS and POST /api/hooks/git (webhook, see server/index.ts)
//   deploy   git checkout → npm ci (if lockfile changed) → npm run build → releases/<commit> → restart server
//
// The studio is client-executed JS: browsers notice the new build-info.json and reload;
// the unpacked Chrome extension reloads itself when EXTENSION_EXPORT_DIR receives a new build.
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { envBool, envInt, log, run } from './util.ts';

const APP_DIR = resolve(import.meta.dirname, '..');
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(APP_DIR, '.data'));
const WORK_DIR = join(DATA_DIR, 'work');
const RELEASES = join(DATA_DIR, 'releases');
const CURRENT_FILE = join(RELEASES, 'current.json');
const REPO_DIR = process.env.REPO_DIR ?? '/repo';
const SOURCE = process.env.GIT_REPO_URL || (existsSync(join(REPO_DIR, '.git')) ? REPO_DIR : '');
const BRANCH = process.env.GIT_BRANCH ?? 'main';
const POLL_SECONDS = Math.max(5, envInt('GIT_POLL_SECONDS', 60));
const AUTO_UPDATE = envBool('AUTO_UPDATE', true) && !!SOURCE;
const EXPORT_EXTENSION_DIR = process.env.EXTENSION_EXPORT_DIR ?? '';
const KEEP_RELEASES = envInt('KEEP_RELEASES', 3);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let child: ChildProcess | null = null;
let restarting = false;
let stopping = false;
let updating = false;
let pendingUpdate = false;
let deployedCommit = '';
let serverDir = APP_DIR;

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function hashFile(file: string): string {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : '';
}

function currentRelease(): { commit: string; dir: string } | undefined {
  const cur = readJson<{ commit: string }>(CURRENT_FILE);
  if (!cur) return undefined;
  const dir = join(RELEASES, cur.commit);
  return existsSync(join(dir, 'web', 'index.html')) ? { commit: cur.commit, dir } : undefined;
}

function setCurrent(commit: string) {
  const tmp = `${CURRENT_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ commit, deployedAt: new Date().toISOString() }));
  // rename is atomic on POSIX and replaces the old pointer on Windows too.
  renameSync(tmp, CURRENT_FILE);
}

function startServer() {
  const rel = currentRelease();
  const staticDir = rel ? join(rel.dir, 'web') : join(APP_DIR, 'dist', 'web');
  const extensionDir = rel ? join(rel.dir, 'extension') : join(APP_DIR, 'dist', 'extension');
  const entry = join(serverDir, 'server', 'index.ts');
  log('supervisor', `starting server (${entry}) static=${staticDir}`);
  child = fork(entry, [], { env: { ...process.env, STATIC_DIR: staticDir, EXTENSION_DIR: extensionDir }, stdio: 'inherit' });
  child.on('message', (msg: { type?: string; reason?: string }) => {
    if (msg?.type === 'update-now') void update(msg.reason ?? 'webhook');
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping || restarting) return;
    log('supervisor', `server exited (${code ?? signal}); restarting in 1s`);
    setTimeout(startServer, 1000);
  });
}

async function restartServer() {
  restarting = true;
  const old = child;
  if (old) {
    await new Promise<void>((resolveExit) => {
      old.once('exit', () => resolveExit());
      old.kill('SIGTERM');
      setTimeout(() => old.kill('SIGKILL'), 5000).unref();
    });
  }
  restarting = false;
  startServer();
}

/** First boot in Docker: publish the build baked into the image so the app is up immediately. */
function seedFromImage() {
  const rel = currentRelease();
  if (rel) {
    deployedCommit = rel.commit;
    return;
  }
  const baked = join(APP_DIR, 'dist');
  const info = readJson<{ commit?: string }>(join(baked, 'web', 'build-info.json'));
  if (!info) return;
  const commit = info.commit && info.commit !== 'dev' ? info.commit : 'baked';
  const dir = join(RELEASES, commit);
  mkdirSync(RELEASES, { recursive: true });
  if (!existsSync(dir)) cpSync(baked, dir, { recursive: true });
  setCurrent(commit);
  deployedCommit = commit;
  log('supervisor', `seeded release ${commit.slice(0, 7)} from image`);
}

function exportExtension(from: string) {
  if (!EXPORT_EXTENSION_DIR || !existsSync(from)) return;
  mkdirSync(EXPORT_EXTENSION_DIR, { recursive: true });
  for (const name of readdirSync(EXPORT_EXTENSION_DIR)) if (name !== 'build-info.json') rmSync(join(EXPORT_EXTENSION_DIR, name), { recursive: true, force: true });
  for (const name of readdirSync(from)) if (name !== 'build-info.json') cpSync(join(from, name), join(EXPORT_EXTENSION_DIR, name), { recursive: true });
  // Written last: the installed extension reloads itself when this file changes.
  copyFileSync(join(from, 'build-info.json'), join(EXPORT_EXTENSION_DIR, 'build-info.json'));
  log('supervisor', `extension exported → ${EXPORT_EXTENSION_DIR}`);
}

function pruneReleases() {
  const keep = new Set([deployedCommit]);
  const dirs = readdirSync(RELEASES)
    .filter((d) => !d.endsWith('.json') && !d.endsWith('.tmp'))
    .map((d) => ({ d, t: statSync(join(RELEASES, d)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { d } of dirs) {
    if (keep.size < KEEP_RELEASES) keep.add(d);
    if (!keep.has(d)) rmSync(join(RELEASES, d), { recursive: true, force: true });
  }
}

async function update(reason: string): Promise<void> {
  if (!AUTO_UPDATE) return;
  if (updating) {
    pendingUpdate = true;
    return;
  }
  updating = true;
  try {
    if (!existsSync(join(WORK_DIR, '.git'))) {
      log('supervisor', `cloning ${SOURCE} (${BRANCH})`);
      mkdirSync(DATA_DIR, { recursive: true });
      rmSync(WORK_DIR, { recursive: true, force: true });
      await run('git', ['clone', '--branch', BRANCH, '--single-branch', SOURCE, WORK_DIR], { quiet: true });
    }
    await run('git', ['-C', WORK_DIR, 'fetch', '--prune', 'origin', BRANCH], { quiet: true });
    const head = await run('git', ['-C', WORK_DIR, 'rev-parse', 'FETCH_HEAD'], { quiet: true });
    if (head === deployedCommit) return;
    const message = await run('git', ['-C', WORK_DIR, 'log', '-1', '--pretty=%s', head], { quiet: true });
    log('supervisor', `new commit ${head.slice(0, 7)} “${message}” (${reason}) — building…`);
    const lockBefore = hashFile(join(WORK_DIR, 'package-lock.json'));
    await run('git', ['-C', WORK_DIR, 'reset', '--hard', head], { quiet: true });
    await run('git', ['-C', WORK_DIR, 'clean', '-fdx', '-e', 'node_modules'], { quiet: true });
    const nodeModules = join(WORK_DIR, 'node_modules');
    let needInstall = hashFile(join(WORK_DIR, 'package-lock.json')) !== lockBefore || !existsSync(nodeModules);
    if (!existsSync(nodeModules) && existsSync(join(APP_DIR, 'node_modules')) && hashFile(join(APP_DIR, 'package-lock.json')) === hashFile(join(WORK_DIR, 'package-lock.json'))) {
      log('supervisor', 'seeding node_modules from image');
      cpSync(join(APP_DIR, 'node_modules'), nodeModules, { recursive: true });
      needInstall = false;
    }
    if (needInstall) await run(npm, ['ci', '--no-audit', '--no-fund', '--include=dev', '--ignore-scripts'], { cwd: WORK_DIR });
    const started = Date.now();
    await run(npm, ['run', 'build'], { cwd: WORK_DIR, env: { GIT_COMMIT: head, GIT_BRANCH: BRANCH, GIT_MESSAGE: message } });
    const dir = join(RELEASES, head);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(RELEASES, { recursive: true });
    cpSync(join(WORK_DIR, 'dist'), dir, { recursive: true });
    setCurrent(head);
    deployedCommit = head;
    serverDir = WORK_DIR;
    exportExtension(join(dir, 'extension'));
    pruneReleases();
    await restartServer();
    log('supervisor', `deployed ${head.slice(0, 7)} in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    log('supervisor', `update failed — keeping ${deployedCommit.slice(0, 7) || 'current'} live:`, (err as Error).message);
  } finally {
    updating = false;
    if (pendingUpdate) {
      pendingUpdate = false;
      void update('queued');
    }
  }
}

async function main() {
  mkdirSync(RELEASES, { recursive: true });
  seedFromImage();
  // Run the server code that matches the deployed release when the work tree is on it.
  if (deployedCommit && existsSync(join(WORK_DIR, 'server', 'index.ts'))) {
    const head = await run('git', ['-C', WORK_DIR, 'rev-parse', 'HEAD'], { quiet: true }).catch(() => '');
    if (head === deployedCommit) serverDir = WORK_DIR;
  }
  startServer();
  if (!AUTO_UPDATE) {
    log('supervisor', SOURCE ? 'auto-update disabled (AUTO_UPDATE=false)' : 'auto-update off: set GIT_REPO_URL or mount a repo at REPO_DIR');
    return;
  }
  log('supervisor', `auto-update on: watching ${SOURCE} (${BRANCH}) every ${POLL_SECONDS}s`);
  await update('startup');
  setInterval(() => void update('poll'), POLL_SECONDS * 1000);
}

const stop = () => {
  stopping = true;
  child?.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
  child?.once('exit', () => process.exit(0));
  if (!child) process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

void main();
