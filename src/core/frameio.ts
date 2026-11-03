// Frame.io (V4) public share resolver. Vyro campaigns ship their "Content to Use" as Frame.io share links
// (f.io/<code> → next.frame.io/share/<uuid>). The share's GraphQL API is CORS-enabled and only needs the
// share id (base64) as share authentication, so files can be listed and downloaded straight from the browser.

export const FRAMEIO_GRAPHQL = 'https://api.frame.io/graphql';

export type FrameioFileKind = 'video' | 'audio' | 'image' | 'other';

export interface FrameioFile {
  id: string;
  name: string;
  kind: FrameioFileKind;
  size?: number;
  width?: number;
  height?: number;
  /** Signed URL to the original upload (expires) */
  downloadUrl?: string;
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
    ... on VideoAsset { media { original { downloadUrl filesizeInBytes } metadata { originalWidth originalHeight } } }
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
    return file;
  });
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

/** Picks the file to clip when a share contains several (largest video first). */
export function pickFrameioFile(share: FrameioShare, fileId?: string): FrameioFile | undefined {
  if (fileId) return share.files.find((f) => f.id === fileId);
  return [...share.files].filter((f) => f.kind === 'video' && f.downloadUrl).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
}
