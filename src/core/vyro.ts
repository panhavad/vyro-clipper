import { parseBrief } from './brief';
import { htmlToText, normalizeHashtag, uniq } from './text';
import type { Campaign, CampaignRules, MediaKind, MediaLink, Platform } from './types';
import { PLATFORMS } from './types';

export const VYRO_APP = 'https://app.vyro.com';
export const VYRO_API = 'https://api.vyro.com';

export function defaultRules(): CampaignRules {
  return {
    hashtags: [],
    disclosureHashtags: [],
    logoUrls: [],
    audio: [],
    subtitlesRequired: false,
    allowCollab: true,
    languages: ['en'],
    platforms: ['tiktok', 'instagram', 'youtube'],
    aspectRatio: '9:16',
    postsPerAccountPerDay: 5,
    maxPendingBeforeApproval: 3,
    briefDos: [],
    briefDonts: [],
    keywords: [],
    mentions: [],
  };
}

export function effectiveRules(c: Pick<Campaign, 'rules' | 'overrides'>): CampaignRules {
  return { ...c.rules, ...(c.overrides ?? {}) } as CampaignRules;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((cur, k) => obj(cur)?.[k], o);
const platformOfUrl = (u: string): string => (/tiktok\./i.test(u) ? 'tiktok' : /instagram\./i.test(u) ? 'instagram' : /youtube\.|youtu\.be/i.test(u) ? 'youtube' : 'unknown');

export function classifyMediaUrl(url: string): MediaKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'unknown';
  }
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname.toLowerCase();
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return 'youtube';
  if (host === 'drive.google.com' || host === 'docs.google.com') return path.includes('/folders/') ? 'gdrive-folder' : 'gdrive';
  if (host === 'drive.usercontent.google.com') return 'gdrive';
  if (/(^|\.)dropbox(usercontent)?\.com$/.test(host)) return 'dropbox';
  if (/(^|\.)(tiktok\.com|instagram\.com|x\.com|twitter\.com|twitch\.tv|kick\.com|facebook\.com|vimeo\.com|rumble\.com)$/.test(host)) return 'social';
  if (/\.(mp4|mov|m4v|webm|mkv|avi|ts|m3u8)$/.test(path)) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|opus|flac)$/.test(path)) return 'audio';
  if (/\.(png|jpe?g|webp|gif|avif)$/.test(path)) return 'image';
  return 'page';
}

export function googleDriveId(url: string): string | undefined {
  const m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(url) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(url);
  return m?.[1];
}

/** Converts share links into URLs that return the file bytes directly (when the host allows it). */
export function directDownloadUrl(link: Pick<MediaLink, 'url' | 'kind'>): string {
  if (link.kind === 'gdrive') {
    const id = googleDriveId(link.url);
    if (id) return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  }
  if (link.kind === 'dropbox') {
    try {
      const u = new URL(link.url);
      u.searchParams.delete('dl');
      u.searchParams.set('raw', '1');
      return u.toString();
    } catch {
      return link.url;
    }
  }
  return link.url;
}

export function isDownloadable(kind: MediaKind): boolean {
  return kind === 'video' || kind === 'audio' || kind === 'gdrive' || kind === 'dropbox';
}

export function needsServerResolver(kind: MediaKind): boolean {
  return kind === 'youtube' || kind === 'social';
}

function toMediaLinks(raw: unknown): MediaLink[] {
  const links = arr(get(raw, 'media.links')).length ? arr(get(raw, 'media.links')) : arr(get(raw, 'media'));
  const out: MediaLink[] = [];
  for (const l of links) {
    const url = typeof l === 'string' ? l : str(obj(l)?.url) ?? str(obj(l)?.href);
    if (!url) continue;
    const fixed = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const label = str(obj(l)?.title) ?? str(obj(l)?.name) ?? str(obj(l)?.label);
    out.push(label ? { url: fixed, kind: classifyMediaUrl(fixed), label } : { url: fixed, kind: classifyMediaUrl(fixed) });
  }
  return uniq(out, (l) => l.url);
}

function toPlatforms(v: unknown): Platform[] {
  const list = arr(v)
    .map((p) => (typeof p === 'string' ? p.toLowerCase() : str(obj(p)?.platform)?.toLowerCase()))
    .map((p) => (p === 'twitter' ? 'x' : p))
    .filter((p): p is Platform => !!p && (PLATFORMS as string[]).includes(p));
  return uniq(list);
}

function disclosureModeOf(req: unknown): string | undefined {
  const ftc = get(req, 'platformRules.ftcDisclosure');
  if (!ftc) return arr(get(req, 'text.ftcDisclosureHashtags')).length ? 'hashtag' : undefined;
  if (typeof ftc === 'string') return ftc;
  const values = Object.values(obj(ftc) ?? {}).map((v) => (typeof v === 'string' ? v : str(obj(v)?.method) ?? str(obj(v)?.type) ?? ''));
  if (values.some((v) => /flex/i.test(v))) return 'flexible';
  if (values.some((v) => /hashtag/i.test(v))) return 'hashtag';
  if (values.length) return 'platform';
  return undefined;
}

/** True when an object looks like a Vyro campaign from the catalog/campaign APIs. */
export function looksLikeVyroCampaign(v: unknown): boolean {
  const o = obj(v);
  if (!o) return false;
  const hasId = typeof o.id === 'string' || typeof o.id === 'number' || typeof o._id === 'string';
  const hasName = typeof o.name === 'string';
  const signals = ['requirements', 'payoutModel', 'budget', 'media', 'targeting', 'headlineRate'].filter((k) => k in o).length;
  return hasId && hasName && (signals >= 2 || (typeof o.slug === 'string' && signals >= 1));
}

/** Walks any API payload and returns every campaign-shaped object (handles {data: [...]}, nested, arrays). */
export function findCampaignsInPayload(payload: unknown, depth = 0, out: Json[] = []): Json[] {
  if (depth > 6 || payload === null || typeof payload !== 'object') return out;
  if (looksLikeVyroCampaign(payload)) {
    out.push(payload as Json);
    return out;
  }
  if (Array.isArray(payload)) {
    for (const item of payload.slice(0, 500)) findCampaignsInPayload(item, depth + 1, out);
    return out;
  }
  for (const value of Object.values(payload as Json)) findCampaignsInPayload(value, depth + 1, out);
  return out;
}

export function normalizeVyroCampaign(raw: unknown, now = Date.now()): Campaign {
  const o = obj(raw) ?? {};
  const req = obj(o.requirements) ?? {};
  const id = String(o.id ?? o._id ?? str(o.slug) ?? `vyro-${now}`);
  const slug = str(o.slug);
  const briefHtml = str(req.brief) ?? str(o.brief) ?? str(o.description) ?? '';
  const brief = /<[a-z][\s\S]*>/i.test(briefHtml) ? htmlToText(briefHtml) : briefHtml;
  const insights = parseBrief(brief);
  const budgetValue = num(get(o, 'budget.value')) ?? num(get(o, 'budget.total'));
  const budgetSpent = num(get(o, 'budget.spent')) ?? num(get(o, 'budget.used'));
  const budgetRemaining = num(get(o, 'budget.remaining')) ?? (budgetValue !== undefined && budgetSpent !== undefined ? Math.max(0, budgetValue - budgetSpent) : undefined);
  const model = str(get(o, 'payoutModel.model'));
  const cpm = num(o.headlineRate) ?? num(get(o, 'payoutModel.payRate'));
  const minLength = num(get(req, 'video.minLength'));
  const audio = arr(get(req, 'audio.links'))
    .map((l) => (typeof l === 'string' ? { platform: platformOfUrl(l), url: l } : { platform: str(obj(l)?.platform) ?? platformOfUrl(str(obj(l)?.url) ?? ''), url: str(obj(l)?.url) ?? '' }))
    .filter((l) => l.url);
  const platforms = toPlatforms(get(o, 'targeting.platforms') ?? o.platforms ?? o.targetedPlatforms);
  const languages = arr(get(o, 'targeting.languages') ?? o.languages)
    .map((l) => (typeof l === 'string' ? l : str(obj(l)?.code) ?? ''))
    .filter(Boolean);
  const captionHashtags = arr(get(req, 'text.hashtags')).map((h) => normalizeHashtag(String(h))).filter(Boolean);
  const disclosure = arr(get(req, 'text.ftcDisclosureHashtags')).map((h) => normalizeHashtag(String(h))).filter(Boolean);
  const socialAccount = obj(req.socialAccount);
  const rules: CampaignRules = {
    ...defaultRules(),
    minDurationSec: minLength,
    maxDurationSec: insights.maxDuration,
    caption: str(get(req, 'text.caption')),
    hashtags: uniq(captionHashtags).slice(0, 5),
    disclosureHashtags: uniq(disclosure),
    disclosureMode: disclosureModeOf(req),
    textOnScreen: str(get(req, 'text.textOnScreen')),
    logoUrls: arr(get(req, 'logo.urls')).map(String).filter((u) => /^https?:/.test(u)),
    logoNotes: str(get(req, 'logo.notes')),
    audio,
    audioNotes: str(get(req, 'audio.notes')),
    subtitlesRequired: get(req, 'subtitles.required') === true || insights.wantsSubtitles,
    allowCollab: get(req, 'collaboration.allowCollabAndTagging') !== false,
    languages: languages.length ? languages : ['en'],
    platforms: platforms.length ? platforms : ['tiktok', 'instagram', 'youtube', 'x'],
    briefDos: insights.dos,
    briefDonts: insights.donts,
    keywords: insights.keywords,
    mentions: insights.mentions,
    socialAccount: socialAccount
      ? {
          displayName: str(socialAccount.displayName),
          bio: str(socialAccount.bio),
          requireFreshProfile: socialAccount.requireFreshProfile === true,
        }
      : undefined,
  };
  if (rules.minDurationSec === undefined && insights.minDuration !== undefined) rules.minDurationSec = insights.minDuration;
  const brand =
    str(get(o, 'displayOption.workspaceName')) ?? str(get(o, 'workspace.name')) ?? str(get(o, 'brand.name')) ?? str(get(o, 'client.name')) ?? str(o.brandName);
  return {
    id,
    source: 'vyro',
    slug,
    name: str(o.name) ?? 'Untitled campaign',
    brand,
    brandImage: str(get(o, 'displayOption.workspaceImage')) ?? str(get(o, 'workspace.image')) ?? str(get(o, 'workspace.logo')) ?? str(get(o, 'workspace.avatar')),
    image: str(o.image) ?? str(o.thumbnail) ?? str(o.thumbnailUrl) ?? str(o.coverImage) ?? str(o.campaignImage) ?? str(get(o, 'image.url')),
    type: str(o.type),
    status: str(o.status),
    url: slug ? `${VYRO_APP}/campaigns?c=${encodeURIComponent(slug)}` : undefined,
    submitUrl: `${VYRO_APP}/campaigns/add-clips/${encodeURIComponent(id)}`,
    cpm: model && !/cpm/i.test(model) && o.headlineRate === undefined ? undefined : cpm,
    payoutModel: model,
    budgetTotal: budgetValue,
    budgetSpent,
    budgetRemaining,
    startDate: str(o.startDate) ?? str(o.targetStartDate),
    endDate: str(o.endDate),
    briefHtml: briefHtml || undefined,
    brief,
    mediaNotes: str(get(o, 'media.notes')),
    media: toMediaLinks(o),
    rules,
    capturedAt: now,
    updatedAt: now,
    raw,
  };
}

/** Merges a fresh capture into an existing campaign, keeping local edits and selection. */
export function mergeCampaign(existing: Campaign | undefined, incoming: Campaign): Campaign {
  if (!existing) return incoming;
  return {
    ...incoming,
    overrides: existing.overrides,
    selected: existing.selected,
    capturedAt: existing.capturedAt,
    updatedAt: incoming.updatedAt,
    // Keep links the user added manually.
    media: uniq([...incoming.media, ...existing.media.filter((m) => m.label === 'added')], (l) => l.url),
  };
}

export function catalogListUrl(page: number, limit = 50, sort = 'startDate.desc'): string {
  return `${VYRO_API}/catalog/campaigns?sort=${encodeURIComponent(sort)}&limit=${limit}&page=${page}`;
}

export function catalogBySlugUrl(slug: string): string {
  return `${VYRO_API}/catalog/campaigns/slug/${encodeURIComponent(slug)}`;
}

export function campaignSlugFromUrl(href: string): string | undefined {
  try {
    const u = new URL(href);
    return u.searchParams.get('c') ?? undefined;
  } catch {
    return undefined;
  }
}

export function manualCampaign(partial: Partial<Campaign> & { name: string }, now = Date.now()): Campaign {
  const brief = partial.brief ?? '';
  const insights = parseBrief(brief);
  const base = defaultRules();
  return {
    id: partial.id ?? `manual-${now.toString(36)}`,
    source: partial.source ?? 'manual',
    name: partial.name,
    brand: partial.brand,
    brief,
    media: partial.media ?? [],
    rules: {
      ...base,
      minDurationSec: insights.minDuration,
      maxDurationSec: insights.maxDuration,
      hashtags: insights.hashtags.slice(0, 5),
      briefDos: insights.dos,
      briefDonts: insights.donts,
      keywords: insights.keywords,
      mentions: insights.mentions,
      subtitlesRequired: insights.wantsSubtitles,
      ...(partial.rules ?? {}),
    },
    cpm: partial.cpm,
    capturedAt: now,
    updatedAt: now,
  };
}
