// Frame.io (V4) public share resolver. Vyro campaigns ship their "Content to Use" as Frame.io share links
// (f.io/<code> → next.frame.io/share/<uuid>). The share's GraphQL API is CORS-enabled and only needs the
// share id (base64) as share authentication, so files can be listed and downloaded straight from the browser.

export const FRAMEIO_GRAPHQL = 'https://api.frame.io/graphql';

export type FrameioFileKind = 'video' | 'audio' | 'image' | 'other';

export interface FrameioRendition {
  /** Frame.io transcode key, e.g. h264_1080_best, h264_720 */
  key: string;
  width?: number;
  height?: number;
  size?: number;
  /** Signed URL (expires) */
  url: string;
}

export interface FrameioFile {
  id: string;
  name: string;
  kind: FrameioFileKind;
  size?: number;
  width?: number;
  height?: number;
  /** Seconds */
  duration?: number;
  mime?: string;
  thumbnail?: string;
  /** Signed URL to the original upload (expires) */
  downloadUrl?: string;
  /** Ready-made H.264 transcodes (much smaller than 4K / ProRes originals) */
  renditions?: FrameioRendition[];
}

export interface FrameioShare {
  shareId: string;
  name?: string;
  files: FrameioFile[];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function isFrameioUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'f.io' || host === 'next.frame.io' || host === 'app.frame.io' || host === 'frame.io';
  } catch {
    return false;
  }
}

export function frameioShareId(url: string): string | undefined {
  return /\/share\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(url)?.[1];
}

function b64(s: string): string {
  return btoa(s);
}

export function frameioHeaders(shareId: string, operation: string, password?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'apollographql-client-name': 'web-app',
    'x-gql-op': operation,
    'x-frameio-share-authentication': b64(password ? `${shareId}:${password}` : shareId),
  };
}

const LIST_QUERY = `query VyroClipperShareList($shareId: ID!, $folderId: ID, $assetType: ChildAssetTypeInput, $page: PageInput!) {
  share(shareId: $shareId) { id ... on Share { name collectionAssets(page: $page, assetType: $assetType, folderId: $folderId) { pageInfo { endCursor hasNextPage } nodes { id } } } }
}`;

const HYDRATE_QUERY = `query VyroClipperShareAssets($shareId: ID!, $ids: [ID!]!, $page: PageInput!) {
  share(by: {shareId: $shareId}) { assets(filter: {assetIds: $ids}, page: $page) { nodes { id name __typename
    ... on VideoAsset { thumbnailImageUrl { url } media { duration mimeType original { downloadUrl filesizeInBytes } metadata { originalWidth originalHeight }
      videoTranscodes { key encodeStatus filesizeInBytes width height downloadUrl } } }
    ... on AudioAsset { media { original { downloadUrl filesizeInBytes } } }
    ... on ImageAsset { media { original { downloadUrl filesizeInBytes } } }
  } } }
}`;

type Json = Record<string, unknown>;
const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Json)[k] : undefined), o);

export function parseListResponse(json: unknown): { name?: string; ids: string[]; endCursor?: string; hasNextPage: boolean } {
  const conn = get(json, 'data.share.collectionAssets');
  const nodes = (get(conn, 'nodes') as Array<{ id?: string }> | undefined) ?? [];
  return {
    name: get(json, 'data.share.name') as string | undefined,
    ids: nodes.map((n) => n.id).filter((id): id is string => typeof id === 'string'),
    endCursor: (get(conn, 'pageInfo.endCursor') as string | null | undefined) ?? undefined,
    hasNextPage: get(conn, 'pageInfo.hasNextPage') === true,
  };
}

export function parseHydrateResponse(json: unknown): FrameioFile[] {
  const nodes = (get(json, 'data.share.assets.nodes') as Json[] | undefined) ?? [];
  return nodes.map((n) => {
    const type = String(n.__typename ?? '');
    const kind: FrameioFileKind = type === 'VideoAsset' ? 'video' : type === 'AudioAsset' ? 'audio' : type === 'ImageAsset' ? 'image' : 'other';
    const file: FrameioFile = { id: String(n.id), name: String(n.name ?? 'file'), kind };
    const size = get(n, 'media.original.filesizeInBytes');
    const url = get(n, 'media.original.downloadUrl');
    const w = get(n, 'media.metadata.originalWidth');
    const h = get(n, 'media.metadata.originalHeight');
    if (typeof size === 'number') file.size = size;
    if (typeof url === 'string') file.downloadUrl = url;
    if (typeof w === 'number') file.width = w;
    if (typeof h === 'number') file.height = h;
    const duration = get(n, 'media.duration');
    const mime = get(n, 'media.mimeType');
    const thumb = get(n, 'thumbnailImageUrl.url');
    if (typeof duration === 'number' && duration > 0) file.duration = duration;
    if (typeof mime === 'string') file.mime = mime;
    if (typeof thumb === 'string') file.thumbnail = thumb;
    const transcodes = (get(n, 'media.videoTranscodes') as Json[] | undefined) ?? [];
    const renditions = transcodes
      .filter((t) => t.encodeStatus === 'SUCCESS' && typeof t.downloadUrl === 'string' && /^h264_\d+/.test(String(t.key)))
      .map((t) => {
        const r: FrameioRendition = { key: String(t.key), url: String(t.downloadUrl) };
        if (typeof t.width === 'number') r.width = t.width;
        if (typeof t.height === 'number') r.height = t.height;
        if (typeof t.filesizeInBytes === 'number') r.size = t.filesizeInBytes;
        return r;
      });
    if (renditions.length) file.renditions = renditions;
    return file;
  });
}

/** Originals above this size are swapped for Frame.io's 1080p H.264 transcode. */
export const MAX_ORIGINAL_BYTES = 2e9;

/**
 * Picks what to download for clipping: the original when the browser can decode it and it's a sensible
 * size, otherwise Frame.io's 1080p (or 720p) H.264 transcode — e.g. an 11 GB 4K ProRes .mov becomes ~1.3 GB.
 */
export function chooseRendition(file: FrameioFile, maxOriginalBytes = MAX_ORIGINAL_BYTES): { url: string; size?: number; label: string } | undefined {
  const longSide = Math.max(file.width ?? 0, file.height ?? 0);
  const decodable = !file.mime || /mp4|m4v|webm/i.test(file.mime) || (!/quicktime|mxf|prores/i.test(file.mime) && !/\.(mov|mxf)$/i.test(file.name));
  const originalOk = !!file.downloadUrl && decodable && longSide <= 1920 && (file.size ?? 0) <= maxOriginalBytes;
  if (originalOk) return { url: file.downloadUrl!, size: file.size, label: 'original' };
  const pick = (key: string) => file.renditions?.find((r) => r.key === key);
  const proxy = pick('h264_1080_best') ?? pick('h264_1080') ?? pick('h264_720');
  if (proxy) return { url: proxy.url, size: proxy.size, label: `${Math.min(proxy.width ?? 1080, proxy.height ?? 1080)}p H.264 copy` };
  return file.downloadUrl ? { url: file.downloadUrl, size: file.size, label: 'original' } : undefined;
}

/** Long-form originals (episodes, streams) are where viral moments are mined; short pre-cut edits are not. */
export function isLongForm(file: FrameioFile): boolean {
  if (file.duration) return file.duration >= 180;
  return (file.width ?? 0) > (file.height ?? 0) && (file.size ?? 0) >= 4e8;
}

/** Orders a share's videos for "clip this campaign": long-form originals first (by name), then short edits. */
export function rankForClipping(files: FrameioFile[]): FrameioFile[] {
  const videos = files.filter((f) => f.kind === 'video' && (f.downloadUrl || f.renditions?.length));
  const byName = (a: FrameioFile, b: FrameioFile) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const long = videos.filter(isLongForm).sort(byName);
  const short = videos.filter((f) => !isLongForm(f)).sort(byName);
  return [...long, ...short];
}

function graphqlError(json: unknown): string | undefined {
  const errors = get(json, 'errors') as Array<{ message?: string }> | undefined;
  return errors?.length ? errors.map((e) => e.message).join('; ') : undefined;
}

/** Follows f.io short links (and trailing redirects) to the canonical share URL. */
export async function resolveFrameioUrl(url: string, fetchFn: FetchLike, resolveRedirect?: (url: string) => Promise<string>): Promise<string> {
  if (frameioShareId(url)) return url;
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetchFn(url, { method, redirect: 'follow' });
      if (frameioShareId(res.url)) return res.url;
    } catch {
      /* CORS-blocked in web pages: fall through to the resolver */
    }
  }
  if (resolveRedirect) {
    const final = await resolveRedirect(url).catch(() => '');
    if (frameioShareId(final)) return final;
  }
  throw new Error('Could not open the Frame.io short link from this browser. Use the extension, run the VyroClipper server, or paste the full next.frame.io/share/… link.');
}

/** Lists every file of a Frame.io share (recursing into folders) with signed download URLs. */
export async function resolveFrameioShare(
  url: string,
  fetchFn: FetchLike = fetch,
  opts: { password?: string; maxFiles?: number; resolveRedirect?: (url: string) => Promise<string> } = {},
): Promise<FrameioShare> {
  const shareUrl = await resolveFrameioUrl(url, fetchFn, opts.resolveRedirect);
  const shareId = frameioShareId(shareUrl)!;
  const call = async (operation: string, query: string, variables: Json) => {
    const res = await fetchFn(FRAMEIO_GRAPHQL, { method: 'POST', headers: frameioHeaders(shareId, operation, opts.password), body: JSON.stringify({ operationName: operation, query, variables }) });
    const json = (await res.json()) as unknown;
    const err = graphqlError(json);
    if (err) throw new Error(/permission/i.test(err) ? 'This Frame.io share is private or password-protected.' : `Frame.io: ${err}`);
    return json;
  };
  const max = opts.maxFiles ?? 500;
  const fileIds: string[] = [];
  let name: string | undefined;
  const folders: Array<string | undefined> = [undefined];
  while (folders.length && fileIds.length < max) {
    const folderId = folders.shift();
    for (const assetType of ['FILE', 'FOLDER'] as const) {
      let after: string | undefined;
      for (let page = 0; page < 20; page++) {
        const json = await call('VyroClipperShareList', LIST_QUERY, { shareId, folderId, assetType, page: after ? { first: 200, after } : { first: 200 } });
        const parsed = parseListResponse(json);
        name ??= parsed.name;
        if (assetType === 'FILE') fileIds.push(...parsed.ids);
        else folders.push(...parsed.ids);
        if (!parsed.hasNextPage || !parsed.endCursor) break;
        after = parsed.endCursor;
      }
    }
  }
  const files: FrameioFile[] = [];
  for (let i = 0; i < Math.min(fileIds.length, max); i += 50) {
    const json = await call('VyroClipperShareAssets', HYDRATE_QUERY, { shareId, ids: fileIds.slice(i, i + 50), page: { first: 50 } });
    files.push(...parseHydrateResponse(json));
  }
  return { shareId, name, files };
}

/** Picks the file to clip when a share contains several (first long-form original, else the first video). */
export function pickFrameioFile(share: FrameioShare, fileId?: string): FrameioFile | undefined {
  if (fileId) return share.files.find((f) => f.id === fileId);
  return rankForClipping(share.files)[0];
}
