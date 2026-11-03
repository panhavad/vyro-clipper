import { describe, expect, it } from 'vitest';
import {
  FRAMEIO_GRAPHQL,
  chooseRendition,
  frameioShareId,
  isFrameioUrl,
  isLongForm,
  parseHydrateResponse,
  pickFrameioFile,
  rankForClipping,
  renditionFallbacks,
  resolveFrameioShare,
  type FrameioFile,
} from '../../src/core/frameio';

const SHARE = '420b7f6e-7019-4e7d-9609-c90124d0963a';

function mockFetch() {
  const calls: Array<{ op: string; headers: Record<string, string>; variables: Record<string, unknown> }> = [];
  const fn = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input === 'https://f.io/AbCd') {
      // fetch() follows redirects; the final URL is exposed as res.url
      const res = new Response('', { status: 200 });
      Object.defineProperty(res, 'url', { value: `https://next.frame.io/share/${SHARE}/` });
      return res;
    }
    if (input === FRAMEIO_GRAPHQL) {
      const body = JSON.parse(String(init?.body)) as { operationName: string; variables: Record<string, unknown> };
      calls.push({ op: body.operationName, headers: init?.headers as Record<string, string>, variables: body.variables });
      const v = body.variables;
      if (body.operationName === 'VyroClipperShareList') {
        if (v.assetType === 'FOLDER') {
          return Response.json({ data: { share: { name: 'Episodes', collectionAssets: { pageInfo: { hasNextPage: false }, nodes: v.folderId ? [] : [{ id: 'folder-1' }] } } } });
        }
        if (v.folderId === 'folder-1') return Response.json({ data: { share: { collectionAssets: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'f3' }] } } } });
        const page = v.page as { after?: string };
        return Response.json({ data: { share: { name: 'Episodes', collectionAssets: page.after ? { pageInfo: { hasNextPage: false }, nodes: [{ id: 'f2' }] } : { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ id: 'f1' }] } } } });
      }
      const ids = v.ids as string[];
      return Response.json({
        data: {
          share: {
            assets: {
              nodes: ids.map((id, i) => ({
                id,
                name: `Episode ${id}.mp4`,
                __typename: id === 'f3' ? 'AudioAsset' : 'VideoAsset',
                media: { original: { downloadUrl: `https://assets.frame.io/uploads/${id}/original.mp4?sig=x`, filesizeInBytes: (i + 1) * 1e8 }, metadata: { originalWidth: 1920, originalHeight: 1080 } },
              })),
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${input}`);
  };
  return { fn, calls };
}

describe('frame.io share resolver', () => {
  it('recognises share links', () => {
    expect(isFrameioUrl('https://f.io/RWHt_IEp')).toBe(true);
    expect(isFrameioUrl(`https://next.frame.io/share/${SHARE}/`)).toBe(true);
    expect(isFrameioUrl('https://example.com')).toBe(false);
    expect(frameioShareId(`https://next.frame.io/share/${SHARE}/view/abc`)).toBe(SHARE);
  });

  it('follows short links, paginates, recurses folders and hydrates download URLs', async () => {
    const { fn, calls } = mockFetch();
    const share = await resolveFrameioShare('https://f.io/AbCd', fn as typeof fetch);
    expect(share.shareId).toBe(SHARE);
    expect(share.name).toBe('Episodes');
    expect(share.files.map((f) => f.id).sort()).toEqual(['f1', 'f2', 'f3']);
    expect(share.files.find((f) => f.id === 'f3')!.kind).toBe('audio');
    expect(share.files[0]!.downloadUrl).toMatch(/^https:\/\/assets\.frame\.io\//);
    // Share auth is the base64 share id and the Apollo client name is required by the API.
    expect(calls[0]!.headers['x-frameio-share-authentication']).toBe(btoa(SHARE));
    expect(calls[0]!.headers['apollographql-client-name']).toBe('web-app');
    expect(calls.some((c) => (c.variables.page as { after?: string }).after === 'c1')).toBe(true);
  });

  it('picks the requested file or the first video', async () => {
    const { fn } = mockFetch();
    const share = await resolveFrameioShare('https://f.io/AbCd', fn as typeof fetch);
    expect(pickFrameioFile(share, 'f2')!.id).toBe('f2');
    const first = pickFrameioFile(share)!;
    expect(first.kind).toBe('video');
    expect(first.id).toBe('f1');
  });

  it('prefers full-length originals over pre-cut shorts', () => {
    const files: FrameioFile[] = [
      { id: 's1', name: 'Shorts-Clip-1.mp4', kind: 'video', duration: 54, width: 1080, height: 1920, downloadUrl: 'u' },
      { id: 'e2', name: 'Seth Meyers.mp4', kind: 'video', duration: 3312, width: 1280, height: 720, downloadUrl: 'u' },
      { id: 'e1', name: 'Harry Connick Jr.mp4', kind: 'video', duration: 2822, width: 1280, height: 720, downloadUrl: 'u' },
      { id: 'a1', name: 'music.wav', kind: 'audio', downloadUrl: 'u' },
      { id: 'n1', name: 'no-download.mp4', kind: 'video', duration: 999 },
    ];
    expect(rankForClipping(files).map((f) => f.id)).toEqual(['e1', 'e2', 's1']);
    expect(isLongForm(files[0]!)).toBe(false);
    // Without a duration, a big landscape file counts as long-form
    expect(isLongForm({ id: 'x', name: 'x.mp4', kind: 'video', width: 1920, height: 1080, size: 8e8 })).toBe(true);
  });

  it("uses Frame.io's H.264 copy when the original is huge, 4K or ProRes", () => {
    const renditions = [
      { key: 'h264_2160', width: 3840, height: 2160, size: 4.1e9, url: 'r2160' },
      { key: 'h264_1080_best', width: 1920, height: 1080, size: 1.3e9, url: 'r1080' },
      { key: 'h264_720', width: 1280, height: 720, size: 8.2e8, url: 'r720' },
    ];
    const base = { id: 'x', kind: 'video' as const, downloadUrl: 'orig', renditions };
    expect(chooseRendition({ ...base, name: 'ep.mp4', mime: 'video/mp4', width: 1280, height: 720, size: 1.03e9 })!.url).toBe('orig');
    expect(chooseRendition({ ...base, name: 'solo.mov', mime: 'video/quicktime', width: 3840, height: 2160, size: 1.12e10 })).toMatchObject({ url: 'r1080', label: '1080p H.264 copy' });
    expect(chooseRendition({ ...base, name: 'game.mp4', mime: 'video/mp4', width: 1920, height: 1080, size: 7.5e9 })!.url).toBe('r1080');
    expect(chooseRendition({ ...base, name: 'ugc.mp4', mime: 'video/mp4', width: 2160, height: 3840, size: 7.5e8 })!.url).toBe('r1080');
    expect(chooseRendition({ id: 'y', name: 'big.mp4', kind: 'video', downloadUrl: 'orig', size: 9e9 })!.url).toBe('orig');
    expect(chooseRendition({ id: 'z', name: 'none.mp4', kind: 'video' })).toBeUndefined();
  });

  it('falls back to progressively smaller H.264 copies (for when browser storage runs out)', () => {
    const f: FrameioFile = {
      id: 'e',
      name: 'Harry Connick Jr.mp4',
      kind: 'video',
      mime: 'video/mp4',
      width: 1280,
      height: 720,
      size: 1.03e9,
      downloadUrl: 'orig',
      renditions: [
        { key: 'h264_1080_best', width: 1280, height: 720, size: 1.2e9, url: 'r1080' },
        { key: 'h264_360', width: 640, height: 360, size: 2e8, url: 'r360' },
        { key: 'h264_720', width: 1280, height: 720, size: 6e8, url: 'r720' },
        { key: 'h264_540', width: 960, height: 540, size: 4e8, url: 'r540' },
      ],
    };
    expect(renditionFallbacks(f).map((r) => r.url)).toEqual(['orig', 'r720', 'r540', 'r360']);
    expect(renditionFallbacks(f)[1]!.label).toBe('720p H.264 copy');
    expect(renditionFallbacks({ id: 'z', name: 'z.mp4', kind: 'video' })).toEqual([]);
  });

  it('parses duration, thumbnail and successful H.264 transcodes', () => {
    const [f] = parseHydrateResponse({
      data: {
        share: {
          assets: {
            nodes: [
              {
                id: 'v',
                name: 'v.mov',
                __typename: 'VideoAsset',
                thumbnailImageUrl: { url: 'https://picture2.frame.io/t.webp' },
                media: {
                  duration: 1799.5,
                  mimeType: 'video/quicktime',
                  original: { downloadUrl: 'orig', filesizeInBytes: 1.1e10 },
                  metadata: { originalWidth: 3840, originalHeight: 2160 },
                  videoTranscodes: [
                    { key: 'h264_1080_best', encodeStatus: 'SUCCESS', width: 1920, height: 1080, filesizeInBytes: 1.3e9, downloadUrl: 'r1080' },
                    { key: 'h264_540', encodeStatus: 'FAILED', downloadUrl: 'bad' },
                    { key: 'original', encodeStatus: 'UNKNOWN', downloadUrl: 'o' },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    expect(f).toMatchObject({ duration: 1799.5, mime: 'video/quicktime', thumbnail: 'https://picture2.frame.io/t.webp', width: 3840 });
    expect(f!.renditions).toEqual([{ key: 'h264_1080_best', width: 1920, height: 1080, size: 1.3e9, url: 'r1080' }]);
  });

  it('falls back to a redirect resolver when the browser blocks the short link (CORS)', async () => {
    const { fn } = mockFetch();
    const blocked = (async (input: string, init?: RequestInit) => {
      if (input.startsWith('https://f.io/')) throw new TypeError('Failed to fetch');
      return fn(input, init);
    }) as typeof fetch;
    await expect(resolveFrameioShare('https://f.io/Zz', blocked)).rejects.toThrow(/short link/);
    const share = await resolveFrameioShare('https://f.io/Zz', blocked, { resolveRedirect: async () => `https://next.frame.io/share/${SHARE}/` });
    expect(share.files.length).toBe(3);
  });

  it('parses hydrate payloads defensively', () => {
    expect(parseHydrateResponse({ data: { share: { assets: { nodes: [{ id: 'x', name: 'a.png', __typename: 'ImageAsset', media: {} }] } } } })[0]).toEqual({ id: 'x', name: 'a.png', kind: 'image' });
    expect(parseHydrateResponse({})).toEqual([]);
  });
});
