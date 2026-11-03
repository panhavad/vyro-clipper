// Runtime environment detection shared by the studio and engine.

export const BUILD_INFO: VyroClipperBuildInfo =
  typeof __BUILD_INFO__ !== 'undefined'
    ? __BUILD_INFO__
    : { name: 'vyroclipper', version: '0.0.0', commit: 'dev', shortCommit: 'dev', branch: 'dev', message: '', builtAt: new Date(0).toISOString(), target: 'web' };

export function isExtensionPage(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
}

export function hasChromeRuntime(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}

/** Base URL for static assets (vendor wasm, models) that works in the web app and the extension. */
export function assetUrl(path: string): string {
  const clean = path.replace(/^\/+/, '');
  if (isExtensionPage()) return chrome.runtime.getURL(clean);
  return new URL(clean, document.baseURI).toString();
}

export async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

export function supportsWebCodecs(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
}
