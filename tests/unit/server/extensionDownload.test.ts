import { describe, expect, it } from 'vitest';
import { extensionReleasePage, insecureDownloadPage, isBlockedInsecureDownload } from '../../../server/extensionDownload.ts';

const NAV = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const req = (headers: Record<string, string>, encrypted = false) => ({ headers, socket: { encrypted } }) as unknown as Parameters<typeof isBlockedInsecureDownload>[0];

describe('isBlockedInsecureDownload', () => {
  it('flags browser navigations over plain HTTP to a LAN/public host', () => {
    expect(isBlockedInsecureDownload(req({ host: '192.168.1.50:8019', accept: NAV }))).toBe(true);
    expect(isBlockedInsecureDownload(req({ host: 'vyro.example.com', accept: NAV, 'x-forwarded-proto': 'http' }))).toBe(true);
  });

  it('serves the zip over HTTPS, behind a TLS proxy and on localhost', () => {
    expect(isBlockedInsecureDownload(req({ host: 'vyro.example.com', accept: NAV }, true))).toBe(false);
    expect(isBlockedInsecureDownload(req({ host: 'vyro.example.com', accept: NAV, 'x-forwarded-proto': 'https' }))).toBe(false);
    for (const host of ['localhost:8080', '127.0.0.1:8019', '[::1]:8019', 'app.localhost']) expect(isBlockedInsecureDownload(req({ host, accept: NAV }))).toBe(false);
  });

  it('does not intercept non-browser clients (curl, scripts)', () => {
    expect(isBlockedInsecureDownload(req({ host: '192.168.1.50:8019', accept: '*/*' }))).toBe(false);
    expect(isBlockedInsecureDownload(req({ host: '192.168.1.50:8019' }))).toBe(false);
  });
});

describe('extensionReleasePage', () => {
  it.each([
    'https://github.com/panhavad/vyro-clipper.git',
    'https://github.com/panhavad/vyro-clipper',
    'https://github.com/panhavad/vyro-clipper/',
    'git@github.com:panhavad/vyro-clipper.git',
  ])('derives the release page from %s', (url) => {
    expect(extensionReleasePage(url)).toBe('https://github.com/panhavad/vyro-clipper/releases/tag/extension-latest');
  });

  it('returns nothing for non-GitHub or missing repos', () => {
    expect(extensionReleasePage('https://gitlab.com/a/b.git')).toBe('');
    expect(extensionReleasePage(undefined)).toBe('');
  });
});

describe('insecureDownloadPage', () => {
  it('links to the HTTPS release and escapes the Host header', () => {
    const html = insecureDownloadPage({ releasePage: 'https://github.com/a/b/releases/tag/extension-latest', host: '<script>x</script>' });
    expect(html).toContain('href="https://github.com/a/b/releases/tag/extension-latest"');
    expect(html).not.toContain('<script>x');
  });
});
