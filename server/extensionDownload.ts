// Chrome blocks downloads whose page or URL chain is plain HTTP on anything but localhost
// ("the file may have been tampered with" – often read as a virus warning). That covers
// http://<server-ip>:8019/extension.zip and also blob/HTTPS links clicked from such a page,
// so insecure browser visits get a page pointing at an HTTPS copy instead of a blocked file.
import type { IncomingMessage } from 'node:http';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True when a browser navigates to the zip over plain HTTP from a non-loopback host. */
export function isBlockedInsecureDownload(req: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return false;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim().toLowerCase();
  if (proto === 'https') return false;
  const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (!host || LOOPBACK.has(host) || host.endsWith('.localhost')) return false;
  return /\btext\/html\b/.test(String(req.headers.accept ?? ''));
}

/** GitHub release page that CI publishes the extension zip to, derived from the watched repo URL. */
export function extensionReleasePage(repoUrl: string | undefined): string {
  const m = /^(?:https?:\/\/|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(repoUrl?.trim() ?? '');
  return m ? `https://github.com/${m[1]}/${m[2]}/releases/tag/extension-latest` : '';
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function insecureDownloadPage(opts: { releasePage: string; host: string }): string {
  const host = escapeHtml(opts.host);
  const release = escapeHtml(opts.releasePage);
  const mirror = release
    ? `<p><a class="btn" href="${release}" target="_blank" rel="noopener">Open the download on GitHub (HTTPS)</a></p>
       <p class="muted">Click <b>vyroclipper-extension.zip</b> under <i>Assets</i>. It is built from the same commit by CI.</p>`
    : '<p>Set <code>EXTENSION_DOWNLOAD_PAGE</code> (or <code>GIT_REPO_URL</code> to a GitHub repo) to offer an HTTPS download here.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download the VyroClipper extension</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#1f2328}
.btn{display:inline-block;background:#1f6feb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600}
.muted{color:#59636e;font-size:14px}code{background:#f0f2f4;padding:1px 5px;border-radius:4px}</style></head><body>
<h1>Download the VyroClipper extension</h1>
<p>This server is opened over plain HTTP (<code>${host}</code>), so Chrome would block the zip with
<i>“the site isn't using a secure connection and the file may have been tampered with”</i>. The file itself is safe;
Chrome only accepts it over HTTPS.</p>
${mirror}
<p class="muted">Or open VyroClipper through an HTTPS address (e.g. a Cloudflare tunnel hostname) and download
<code>/extension.zip</code> there. Advanced: <a href="?force=1">download over HTTP anyway</a>.</p>
</body></html>`;
}
