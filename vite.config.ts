import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { buildInfoPlugin, getBuildInfo } from './scripts/lib/build-info.ts';

// Cross-origin isolation enables SharedArrayBuffer => multi-threaded WASM for in-browser Whisper.
// `credentialless` keeps third-party images/models loadable without CORP headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig(() => {
  const info = getBuildInfo('web');
  return {
    base: './',
    plugins: [react(), buildInfoPlugin(info)],
    define: { __BUILD_INFO__: JSON.stringify(info) },
    build: {
      outDir: 'dist/web',
      emptyOutDir: true,
      target: 'es2023',
      chunkSizeWarningLimit: 6000,
    },
    worker: { format: 'es' as const },
    optimizeDeps: { exclude: ['@huggingface/transformers'] },
    server: { port: 5173, headers: isolationHeaders },
    preview: { port: 4173, headers: isolationHeaders },
  };
});
