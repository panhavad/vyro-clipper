import { describe, expect, it } from 'vitest';
import { HttpError, assertPublicUrl, isPrivateAddress } from '../../../server/util.ts';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a00:1',
    '::FFFF:A9FE:A9FE',
    '::127.0.0.1',
    '::ffff:0:7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::169.254.169.254',
    '64:ff9b:1::1',
    '2002:7f00:1::1',
    '2002:c0a8:101::1',
    '2001:0:4136:e378::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'fec0::1',
    'ff02::1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.215.14', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1'])('allows %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  const rejects = async (url: string) => {
    const err = await assertPublicUrl(url, false).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    return (err as HttpError).status;
  };

  it('rejects private hosts however they are written', async () => {
    for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]:8080/', 'http://[::ffff:169.254.169.254]/', 'http://[64:ff9b::a00:1]/', 'http://localhost/']) {
      expect(await rejects(url)).toBe(403);
    }
  });

  it('rejects non-http(s) and malformed URLs', async () => {
    expect(await rejects('file:///etc/passwd')).toBe(400);
    expect(await rejects('not a url')).toBe(400);
  });

  it('accepts public addresses, and anything when private networks are allowed', async () => {
    expect((await assertPublicUrl('https://93.184.215.14/video.mp4', false)).hostname).toBe('93.184.215.14');
    expect((await assertPublicUrl('http://[2606:4700:4700::1111]/', false)).hostname).toBe('[2606:4700:4700::1111]');
    expect((await assertPublicUrl('http://[::ffff:127.0.0.1]/', true)).hostname).toBe('[::ffff:7f00:1]');
  });
});
