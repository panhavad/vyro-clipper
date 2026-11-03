import { hookScore } from './virality';
import { EMOTION_WORDS, cleanSpokenText, contentWords, normalizeHashtag, titleCase, tokenize, truncateWords, uniq } from './text';
import type { CampaignRules, Platform } from './types';

export const PLATFORM_CAPTION_LIMITS: Record<Platform, number> = {
  tiktok: 2200,
  instagram: 2200,
  youtube: 100, // Shorts title
  x: 280,
};

interface TitleCandidate {
  text: string;
  /** A whole sentence (as opposed to a comma-separated fragment) */
  complete: boolean;
  /** Fragment that is part of a list / dangling modifier ("We have a very diverse, very qualified…") */
  weak: boolean;
  order: number;
}

// A clause that starts with (or is followed by) one of these continues a phrase rather than standing alone.
const CONTINUATION = new Set(['very', 'really', 'so', 'more', 'most', 'and', 'or', 'but', 'which', 'that', 'who', 'as', 'than', 'extremely', 'super', 'quite', 'too', 'also', 'plus']);

function titleCandidates(text: string): TitleCandidate[] {
  const out: TitleCandidate[] = [];
  const strip = (c: string) => cleanSpokenText(c).replace(/^(and|but|so|because|or|then|like|also|yeah|okay|ok|well)\s+/i, '');
  const firstWord = (s: string) => tokenize(s)[0] ?? '';
  text
    .split(/(?<=[.!?])\s+/)
    .slice(0, 14)
    .forEach((sentence, order) => {
      const whole = strip(sentence);
      if (tokenize(whole).length >= 3) out.push({ text: whole, complete: true, weak: false, order });
      const parts = sentence.split(/[,;:—–]\s+/);
      if (parts.length > 1) {
        parts.forEach((p, i) => {
          const frag = strip(p);
          if (tokenize(frag).length < 3) return;
          const weak = CONTINUATION.has(firstWord(p)) || (i < parts.length - 1 && CONTINUATION.has(firstWord(parts[i + 1]!)));
          out.push({ text: frag, complete: false, weak, order });
        });
      }
    });
  return out;
}

/** Normalised form used to compare titles ("Why'd You Pick That Date?" ≈ "why'd you pick that date"). */
export const titleKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Picks the punchiest line of a clip as its title (Opus-style "AI hook").
 * `exclude` holds titleKey()s already used by other clips, so a batch never repeats a title.
 */
export function makeTitle(clipText: string, maxChars = 60, exclude?: ReadonlySet<string>): string {
  const all = titleCandidates(clipText);
  // Lines without substance ("What was it?", "How old are you?") only qualify when nothing better exists.
  const specific = all.filter((c) => contentWords(c.text).length >= 2);
  const options = specific.length ? specific : all;
  if (!options.length) return truncateWords(titleCase(cleanSpokenText(clipText) || 'Watch this'), maxChars);
  const ranked = options
    .map((c) => {
      const words = tokenize(c.text).length;
      let s = hookScore(c.text) - c.order * 3;
      // Over-long lines get truncated with "…"; prefer a phrase that fits, the further over the worse.
      if (c.text.length <= maxChars) s += 6;
      else s -= 10 + (c.text.length - maxChars) / 3;
      if (c.complete) s += 8;
      else if (c.weak) s -= 12; // reads as cut off
      else if (words < 4) s -= 4;
      if (words >= 4 && words <= 12) s += 5;
      s += Math.min(6, contentWords(c.text).length * 1.5);
      return { c, s };
    })
    .sort((a, b) => b.s - a.s);
  const finalise = (text: string) => truncateWords(titleCase(text.replace(/[.!]+$/, '')), maxChars);
  const fresh = exclude?.size ? ranked.find((r) => !exclude.has(titleKey(finalise(r.c.text)))) : undefined;
  return finalise((fresh ?? ranked[0]!).c.text);
}

const EMOJI_BY_MOOD: Array<[RegExp, string]> = [
  [/\$|money|million|billion|rich|paid|cash/i, '💰'],
  [/insane|crazy|unbelievable|impossible|wild/i, '🤯'],
  [/shock|omg|wow|scared|terrified/i, '😱'],
  [/funny|laugh|hilarious|lol/i, '😂'],
  [/love|heart/i, '❤️'],
  [/win|won|champion|first/i, '🏆'],
  [/secret|nobody|truth/i, '🤫'],
  [/\?/, '🤔'],
];

/** Short, uppercase on-screen hook shown in the first seconds. */
export function makeHookOverlay(title: string, maxChars = 42, withEmoji = true): string {
  const base = truncateWords(title.replace(/[“”"]/g, ''), maxChars).toUpperCase();
  if (!withEmoji) return base;
  const emoji = EMOJI_BY_MOOD.find(([re]) => re.test(title))?.[1] ?? (tokenize(title).some((t) => EMOTION_WORDS.has(t)) ? '🔥' : '');
  // No-break space keeps the emoji on the same line as the last word when the hook wraps.
  return emoji ? `${base}\u00A0${emoji}` : base;
}

export function topicalHashtags(text: string, keywords: string[], max = 3): string[] {
  const fromKeywords = keywords
    .filter((k) => k.length <= 24 && !/\s{2,}/.test(k))
    .map((k) => normalizeHashtag(k.replace(/\s+/g, '')))
    .filter((h) => h.length > 3);
  const counts = new Map<string, number>();
  for (const w of contentWords(text)) if (w.length > 4 && /^[a-z]+$/.test(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const fromText = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => normalizeHashtag(w));
  return uniq([...fromKeywords, ...fromText]).slice(0, max);
}

export interface PostCaption {
  /** Main caption (TikTok / Instagram) */
  text: string;
  hashtags: string[];
  /** Per-platform variants trimmed to platform limits */
  variants: Record<Platform, string>;
}

/**
 * Builds the post caption: hook line + campaign-required caption + required hashtags + disclosure.
 * Required elements are never trimmed; only the free-form hook line shrinks to fit limits.
 */
export function buildPostCaption(opts: { hookLine: string; rules: CampaignRules; extraHashtags?: string[]; platforms?: Platform[] }): PostCaption {
  const required = opts.rules.caption?.trim() ?? '';
  const requiredTags = uniq(opts.rules.hashtags.map(normalizeHashtag).filter(Boolean));
  const disclosure = uniq(opts.rules.disclosureHashtags.map(normalizeHashtag).filter(Boolean));
  const extras = uniq((opts.extraHashtags ?? []).map(normalizeHashtag).filter(Boolean)).filter(
    (t) => !requiredTags.some((r) => r.toLowerCase() === t.toLowerCase()) && !disclosure.some((d) => d.toLowerCase() === t.toLowerCase()),
  );
  const mentions = opts.rules.mentions.filter((m) => !required.includes(m));
  const tags = [...requiredTags, ...extras, ...disclosure];
  const compose = (hook: string, tagList: string[]) =>
    [hook, required, mentions.join(' '), tagList.join(' ')]
      .map((p) => p.trim())
      .filter(Boolean)
      .join('\n\n');
  const fit = (limit: number, tagList: string[]) => {
    let hook = opts.hookLine.trim();
    let out = compose(hook, tagList);
    while (out.length > limit && hook.length > 0) {
      hook = hook.length > 12 ? truncateWords(hook, Math.max(0, hook.length - 12)) : '';
      out = compose(hook, tagList);
    }
    return out.length > limit ? out.slice(0, limit) : out;
  };
  const mandatory = [...requiredTags, ...disclosure];
  const variants = {
    tiktok: fit(PLATFORM_CAPTION_LIMITS.tiktok, tags),
    instagram: fit(PLATFORM_CAPTION_LIMITS.instagram, tags),
    youtube: fit(PLATFORM_CAPTION_LIMITS.youtube, mandatory),
    x: fit(PLATFORM_CAPTION_LIMITS.x, mandatory.length ? mandatory : tags.slice(0, 2)),
  } satisfies Record<Platform, string>;
  return { text: variants.tiktok, hashtags: tags, variants };
}
