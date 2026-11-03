import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, assertPublicUrl, log } from './util.ts';

export interface MediaJob {
  id: string;
  url: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  message: string;
  file?: string;
  size?: number;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface JobManagerOptions {
  ytdlp: string;
  cacheDir: string;
  maxConcurrent: number;
  maxCacheBytes: number;
  ttlMs: number;
  allowPrivate: boolean;
}

export class MediaJobs {
  private readonly jobs = new Map<string, MediaJob>();
  private readonly queue: MediaJob[] = [];
  private running = 0;
  private readonly opts: JobManagerOptions;
  available = false;
  version = '';

  constructor(opts: JobManagerOptions) {
    this.opts = opts;
    mkdirSync(opts.cacheDir, { recursive: true });
    setInterval(() => this.cleanup(), 10 * 60 * 1000).unref();
  }

  async detect(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn(this.opts.ytdlp, ['--version']);
      let out = '';
      p.stdout.on('data', (d: Buffer) => (out += d.toString()));
      p.on('error', () => resolve((this.available = false)));
      p.on('close', (code) => {
        this.available = code === 0;
        this.version = out.trim();
        resolve(this.available);
      });
    });
  }

  get(id: string): MediaJob | undefined {
    return this.jobs.get(id);
  }

  async create(url: string): Promise<MediaJob> {
    if (!this.available) throw new HttpError(501, 'yt-dlp is not installed on the server. Use the Docker image or install yt-dlp.');
    await assertPublicUrl(url, this.opts.allowPrivate);
    const reuse = [...this.jobs.values()].find((j) => j.url === url && j.status !== 'error' && Date.now() - j.createdAt < this.opts.ttlMs);
    if (reuse) return reuse;
    const job: MediaJob = { id: randomUUID(), url, status: 'queued', progress: 0, message: 'Queued', createdAt: Date.now() };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.pump();
    return job;
  }

  private pump() {
    while (this.running < this.opts.maxConcurrent && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void this.execute(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private execute(job: MediaJob): Promise<void> {
    return new Promise((resolve) => {
      job.status = 'running';
      job.message = 'Starting download';
      const template = join(this.opts.cacheDir, `${job.id}.%(ext)s`);
      const args = [
        '--no-playlist',
        '--newline',
        '-f',
        'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b',
        '--merge-output-format',
        'mp4',
        '--max-filesize',
        '6G',
        '-o',
        template,
        '--',
        job.url,
      ];
      log('ytdlp', `job ${job.id} ← ${job.url}`);
      const child = spawn(this.opts.ytdlp, args);
      let stderr = '';
      const onLine = (line: string) => {
        const m = /\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\w+))?/.exec(line);
        if (m) {
          job.progress = Math.min(99, parseFloat(m[1]!));
          job.message = `Downloading ${m[1]}%${m[2] ? ` of ${m[2]}` : ''}`;
        } else if (/\[Merger\]|Merging formats/.test(line)) job.message = 'Merging audio & video';
      };
      child.stdout.on('data', (d: Buffer) => d.toString().split(/\r?\n/).forEach(onLine));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => {
        job.status = 'error';
        job.error = err.message;
        resolve();
      });
      child.on('close', (code) => {
        const produced = readdirSync(this.opts.cacheDir).filter((f) => f.startsWith(job.id) && !/\.(part|ytdl|temp)$/.test(f));
        const file = produced.find((f) => f.endsWith('.mp4')) ?? produced[0];
        if (code === 0 && file) {
          job.file = join(this.opts.cacheDir, file);
          job.size = statSync(job.file).size;
          job.status = 'done';
          job.progress = 100;
          job.message = 'Ready';
        } else {
          job.status = 'error';
          job.error = (stderr.split('\n').filter((l) => /ERROR/.test(l)).pop() ?? stderr.slice(-400) ?? `yt-dlp exited with ${code}`).trim();
          log('ytdlp', `job ${job.id} failed: ${job.error}`);
        }
        job.finishedAt = Date.now();
        resolve();
      });
    });
  }

  /** Expires old downloads and keeps the cache under its size limit (oldest first). */
  cleanup(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.finishedAt && now - job.finishedAt > this.opts.ttlMs) {
        if (job.file) rmSync(job.file, { force: true });
        this.jobs.delete(job.id);
      }
    }
    const files = readdirSync(this.opts.cacheDir)
      .map((f) => {
        const p = join(this.opts.cacheDir, f);
        const s = statSync(p);
        return { p, size: s.size, mtime: s.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files) {
      if (total <= this.opts.maxCacheBytes) break;
      rmSync(f.p, { force: true });
      total -= f.size;
    }
  }
}
