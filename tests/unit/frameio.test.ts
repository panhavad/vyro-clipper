import { describe, expect, it } from 'vitest';
import { FRAMEIO_GRAPHQL, frameioShareId, isFrameioUrl, parseHydrateResponse, pickFrameioFile, resolveFrameioShare } from '../../src/core/frameio';

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

  it('picks the requested file or the largest video', async () => {
    const { fn } = mockFetch();
    const share = await resolveFrameioShare('https://f.io/AbCd', fn as typeof fetch);
    expect(pickFrameioFile(share, 'f1')!.id).toBe('f1');
    const largestVideo = pickFrameioFile(share)!;
    expect(largestVideo.kind).toBe('video');
    expect(largestVideo.size).toBe(Math.max(...share.files.filter((f) => f.kind === 'video').map((f) => f.size!)));
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
