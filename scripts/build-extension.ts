// Builds the Chrome MV3 extension into dist/extension.
//  - studio.html + popup.html: regular Vite pages (code-split ES modules)
//  - background.js: single-file ES module service worker
//  - content scripts: single-file IIFEs (content scripts cannot use ES imports)
import { build, type InlineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildInfoPlugin, getBuildInfo } from './lib/build-info.ts';

const root = process.cwd();
const outDir = resolve(root, process.env.EXTENSION_OUT_DIR ?? 'dist/extension');
const info = getBuildInfo('extension');
const define = { __BUILD_INFO__: JSON.stringify(info), 'process.env.NODE_ENV': JSON.stringify('production') };
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; description: string };

rmSync(outDir, { recursive: true, force: true });

const pages: InlineConfig = {
  configFile: false,
  root: resolve(root, 'src/extension'),
  base: './',
  publicDir: resolve(root, 'public'),
  plugins: [react(), buildInfoPlugin(info)],
  define: { __BUILD_INFO__: define.__BUILD_INFO__ },
  logLevel: 'warn',
  worker: { format: 'es' },
  build: {
    outDir,
    emptyOutDir: false,
    target: 'es2023',
    chunkSizeWarningLimit: 6000,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        studio: resolve(root, 'src/extension/studio.html'),
        popup: resolve(root, 'src/extension/popup.html'),
      },
    },
  },
};
await build(pages);

const scripts: Array<{ entry: string; file: string; format: 'es' | 'iife' }> = [
  { entry: 'background.ts', file: 'background.js', format: 'es' },
  { entry: 'vyro-main.ts', file: 'vyro-main.js', format: 'iife' },
  { entry: 'vyro-content.ts', file: 'vyro-content.js', format: 'iife' },
  { entry: 'studio-bridge.ts', file: 'studio-bridge.js', format: 'iife' },
];
for (const s of scripts) {
  await build({
    configFile: false,
    root,
    publicDir: false,
    define,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      minify: true,
      copyPublicDir: false,
      lib: {
        entry: resolve(root, 'src/extension', s.entry),
        formats: [s.format],
        name: `VyroClipper_${s.file.replace(/\W/g, '_')}`,
        fileName: () => s.file,
      },
    },
  });
}

const icons = Object.fromEntries([16, 32, 48, 128].map((n) => [String(n), `icons/icon-${n}.png`]));
const manifest = {
  manifest_version: 3,
  name: 'VyroClipper – AI clips for Vyro campaigns',
  short_name: 'VyroClipper',
  version: pkg.version,
  version_name: `${pkg.version} (${info.shortCommit})`,
  description: 'Pick Vyro campaigns, auto-download the source, find viral moments and render rule-compliant shorts with captions & virality scores.',
  minimum_chrome_version: '116',
  icons,
  action: { default_popup: 'popup.html', default_title: 'VyroClipper', default_icon: icons },
  background: { service_worker: 'background.js', type: 'module' },
  permissions: ['storage', 'unlimitedStorage', 'tabs', 'scripting', 'downloads', 'alarms'],
  // <all_urls>: the studio downloads campaign footage from any host (Drive, Dropbox, CDNs) without CORS limits.
  host_permissions: ['<all_urls>'],
  content_scripts: [
    { matches: ['https://app.vyro.com/*'], js: ['vyro-main.js'], run_at: 'document_start', world: 'MAIN' },
    { matches: ['https://app.vyro.com/*'], js: ['vyro-content.js'], run_at: 'document_start' },
    { matches: ['http://localhost/*', 'http://127.0.0.1/*'], js: ['studio-bridge.js'], run_at: 'document_start' },
  ],
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

for (const f of ['studio.html', 'popup.html', 'background.js', 'vyro-main.js', 'vyro-content.js', 'studio-bridge.js', 'build-info.json', 'icons/icon-128.png', 'models/blaze_face_short_range.tflite']) {
  if (!existsSync(join(outDir, f))) throw new Error(`Extension build is missing ${f}`);
}
console.log(`Extension built → ${outDir} (v${pkg.version}, ${info.shortCommit})`);
