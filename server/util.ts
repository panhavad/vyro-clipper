import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function log(scope: string, ...args: unknown[]): void {
  console.log(new Date().toISOString(), `[${scope}]`, ...args);
}

export function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Runs a command, streaming output to the log; resolves with stdout. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, shell: process.platform === 'win32' });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (!opts.quiet) process.stdout.write(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (!opts.quiet) process.stderr.write(d);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}: ${err.slice(-2000)}`))));
  });
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, p) => (n << 8) + parseInt(p, 10), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/') as [string, string];
  const mask = bits === '0' ? 0 : (~0 << (32 - parseInt(bits, 10))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4'];

/** Parses an IPv6 address (incl. `::` and dotted IPv4 tails) into its eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (tail) {
    if (isIP(tail) !== 4) return undefined;
    const n = ipv4ToInt(tail);
    s = `${s.slice(0, -tail.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  return groups.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? groups.map((g) => parseInt(g, 16)) : undefined;
}

function isPrivateV6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // Addresses that embed an IPv4 address are judged by it: ::, ::1, ::a.b.c.d, ::ffff:a.b.c.d (mapped),
  // ::ffff:0:a.b.c.d (SIIT), 64:ff9b::a.b.c.d (NAT64) and 2002:aabb:ccdd:: (6to4).
  if (zero(0, 6)) return v4(g[6]!, g[7]!);
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return (
    (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) || // local-use NAT64
    (g[0] === 0x2001 && g[1] === 0) || // Teredo
    (g[0] === 0x2001 && g[1] === 0xdb8) || // documentation
    (g[0] === 0x100 && zero(1, 4)) || // discard-only
    (g[0]! & 0xfe00) === 0xfc00 || // unique local
    (g[0]! & 0xffc0) === 0xfe80 || // link-local
    (g[0]! & 0xffc0) === 0xfec0 || // site-local
    (g[0]! & 0xff00) === 0xff00 // multicast
  );
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((c) => inCidr(ip, c));
  return isPrivateV6(ip);
}

/** Rejects URLs that resolve to internal networks (SSRF protection) unless explicitly allowed. */
export async function assertPublicUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Only http(s) URLs are allowed');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new HttpError(400, `Cannot resolve ${host}`);
  if (addresses.some(isPrivateAddress)) throw new HttpError(403, 'Refusing to fetch private network addresses');
  return url;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
