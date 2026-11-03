// Generates the extension/app icons (PNG) procedurally — no image tooling required.
// Usage: node scripts/make-icons.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
}

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

function roundedRectInside(u: number, v: number, r: number): boolean {
  const qx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const qy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  return Math.hypot(qx, qy) <= r;
}

/** Returns [r,g,b,a] in 0..1 for a sample position. */
function shade(u: number, v: number): [number, number, number, number] {
  if (!roundedRectInside(u, v, 0.22)) return [0, 0, 0, 0];
  const t = (u + v) / 2;
  const a = [0x7c, 0x3a, 0xed];
  const b = [0x22, 0xd3, 0xee];
  let col: [number, number, number] = [0, 1, 2].map((i) => (a[i]! + (b[i]! - a[i]!) * t) / 255) as [number, number, number];
  const blade = Math.min(segDist(u, v, 0.31, 0.15, 0.6, 0.64), segDist(u, v, 0.69, 0.15, 0.4, 0.64));
  const ring = Math.min(Math.abs(Math.hypot(u - 0.35, v - 0.75) - 0.1), Math.abs(Math.hypot(u - 0.65, v - 0.75) - 0.1));
  if (blade < 0.045 || ring < 0.03) col = [1, 1, 1];
  if (Math.hypot(u - 0.5, v - 0.458) < 0.03) col = [0x7c / 255, 0x3a / 255, 0xed / 255];
  return [col[0], col[1], col[2], 1];
}

function render(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [cr, cg, cb, ca] = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const i = (y * size + x) * 4;
      const n = ss * ss;
      out[i] = a ? Math.round((r / a) * 255) : 0;
      out[i + 1] = a ? Math.round((g / a) * 255) : 0;
      out[i + 2] = a ? Math.round((b / a) * 255) : 0;
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const dir = join(process.cwd(), 'public', 'icons');
mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128, 192, 512]) {
  writeFileSync(join(dir, `icon-${size}.png`), encodePng(size, render(size)));
  console.log(`icon-${size}.png`);
}
