// Text utilities and lexicons shared by scoring, captions and brief parsing.

export const STOPWORDS = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing down during each few for from further had has have having he her here hers herself him ' +
    'himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other ' +
    'our ours ourselves out over own same she should so some such than that the their theirs them themselves then there ' +
    'these they this those through to too under until up very was we were what when where which while who whom why will ' +
    'with would you your yours yourself yourselves im i\'m it\'s that\'s don\'t didn\'t can\'t won\'t gonna wanna gotta ' +
    'yeah yes okay ok oh um uh like really actually basically literally kind sort thing things stuff get got go going went ' +
    'know think mean say said see make made want one two also well right lot lots way much many even still back us let ' +
    'cause cuz there\'s here\'s what\'s we\'re they\'re you\'re i\'ve we\'ve i\'ll you\'ll'
  ).split(/\s+/),
);

export const FILLER_WORDS = new Set(['um', 'uh', 'erm', 'er', 'ah', 'hmm', 'mm', 'uhm', 'umm', 'uhh', 'mhm', 'eh', 'hm']);

export const CONJUNCTION_STARTS = new Set([
  'and', 'but', 'so', 'because', 'or', 'then', 'um', 'uh', 'like', 'also', 'yeah', 'okay', 'ok', 'right', 'well', 'anyway', 'which', 'cause',
]);

export const EMOTION_WORDS = new Set(
  (
    'wow omg insane crazy amazing incredible unbelievable love hate scared terrified shocked shocking hilarious funny laugh ' +
    'cry crying angry furious excited epic legendary wild ridiculous disgusting beautiful perfect worst best dead died win ' +
    'won winner lose lost million millions billion money free giveaway challenge prize surprise secret finally never ' +
    'impossible dangerous risk extreme huge massive giant fastest biggest craziest last first broke rich expensive cheap ' +
    'destroyed exploded scream screaming panic emotional tears heart insanely genius stupid dumb weird strange creepy ' +
    'nightmare dream miracle record viral famous mrbeast lamborghini ferrari island mansion jet'
  ).split(/\s+/),
);

export const VALUE_WORDS = new Set(
  (
    'tip tips step steps lesson lessons learned learn mistake mistakes advice strategy hack hacks trick tricks reason reasons ' +
    'important key rule rules method framework data study research percent fact facts truth example problem solution ' +
    'result results simple easy hard how why because therefore means system habit habits routine business invest investing ' +
    'grow growth success fail failure lesson secret skill skills money price cost save saved earn earned profit'
  ).split(/\s+/),
);

export const BOLD_CLAIM_WORDS = new Set(
  (
    'never always nobody everyone everybody everything nothing worst best biggest craziest most only secret truth mistake ' +
    'wrong actually literally insane crazy impossible unbelievable guaranteed forever ever every nobody\'s'
  ).split(/\s+/),
);

export const STORY_PATTERNS: RegExp[] = [
  /\bwhen i\b/i,
  /\bone day\b/i,
  /\bi remember\b/i,
  /\bso i\b/i,
  /\band then\b/i,
  /\bsuddenly\b/i,
  /\bturns out\b/i,
  /\bended up\b/i,
  /\bthat'?s when\b/i,
  /\bthe moment\b/i,
  /\bnext thing\b/i,
];

export const CURIOSITY_PATTERNS: RegExp[] = [
  /\bhere'?s (why|how|what|the)\b/i,
  /\bthis is (why|how|what)\b/i,
  /\bthe reason\b/i,
  /\bwhat happened\b/i,
  /\bwait (for it|till|until)\b/i,
  /\byou won'?t believe\b/i,
  /\bnobody (talks|tells|knows)\b/i,
  /\bi (bet|guarantee|promise)\b/i,
  /\blet me (tell|show)\b/i,
  /\bwatch (this|what)\b/i,
  /\bimagine\b/i,
  /\bdid you know\b/i,
  /\bthe truth\b/i,
  /\bthe secret\b/i,
  /\bbiggest mistake\b/i,
  /\bif you\b/i,
  /\bstop\b/i,
];

export const STAKES_PATTERN = /\bi (lost|won|spent|made|gave|quit|almost|never|got fired|bought|sold|built|survived|tried)\b/i;
export const NUMBER_PATTERN = /\$\s?\d|\d+(\.\d+)?\s?(k|m|bn|million|billion|thousand|hundred|percent|%|x)\b|\b\d{2,}\b/i;
export const LAUGH_PATTERN = /\b(ha(ha)+|lol|lmao|\[laugh(ter|s)?\]|\(laugh(ter|s)?\))\b/i;

const PROFANITY_PATTERNS: RegExp[] = [
  /^f+u+c+k/i,
  /^motherf/i,
  /^sh+i+t/i,
  /^bullshit/i,
  /^b+i+t+c+h/i,
  /^asshole/i,
  /^dick(head)?s?$/i,
  /^bastards?$/i,
  /^c+u+n+t/i,
  /^damn(it)?$/i,
];

export function isProfane(word: string): boolean {
  const w = normalizeToken(word);
  return w.length > 2 && PROFANITY_PATTERNS.some((re) => re.test(w));
}

export function censorWord(word: string): string {
  const m = /^([^A-Za-z]*)([A-Za-z])([A-Za-z']*)([^A-Za-z]*)$/.exec(word);
  if (!m) return word;
  return `${m[1]}${m[2]}${'*'.repeat(Math.max(1, m[3]!.length))}${m[4]}`;
}

const EMOJI_MAP: Array<[RegExp, string]> = [
  [/^(money|cash|dollars?|paid|pay|salary|rich|wealth|bucks)$/, '💰'],
  [/^(millions?|billions?|millionaire|billionaire)$/, '🤑'],
  [/^(fire|hot|lit|burn(ing)?|flames?)$/, '🔥'],
  [/^(love|loved|heart|hearts|romantic|crush)$/, '❤️'],
  [/^(laugh(ing)?|funny|hilarious|lol|haha+|joke|jokes)$/, '😂'],
  [/^(crazy|insane|insanely|wild|mind|unbelievable|nuts)$/, '🤯'],
  [/^(shock(ed|ing)?|omg|wow|surprised?|scary|terrified|scared)$/, '😱'],
  [/^(win|won|winner|winning|champion|victory|first)$/, '🏆'],
  [/^(cars?|lamborghini|ferrari|drive|driving|race|racing)$/, '🏎️'],
  [/^(food|eat|eating|pizza|burger|hungry|dinner|lunch|breakfast)$/, '🍔'],
  [/^(time|clock|hours?|minutes?|seconds?|deadline)$/, '⏰'],
  [/^(secret|secrets|hidden|nobody)$/, '🤫'],
  [/^(think|thinking|idea|ideas|smart|genius|brain|learn(ed)?)$/, '🧠'],
  [/^(strong|gym|muscles?|workout|fitness|power)$/, '💪'],
  [/^(house|home|mansion|apartment)$/, '🏠'],
  [/^(phone|iphone|text|call)$/, '📱'],
  [/^(video|camera|film|youtube|filming)$/, '🎥'],
  [/^(music|song|songs|sing|singing|rap)$/, '🎵'],
  [/^(world|earth|global|country|countries)$/, '🌍'],
  [/^(plane|fly|flying|travel|trip|airport)$/, '✈️'],
  [/^(dogs?|puppy)$/, '🐶'],
  [/^(cats?|kitten)$/, '🐱'],
  [/^(game|games|gaming|gamer|play|playing)$/, '🎮'],
  [/^(start|launch|rocket|grow|growth|scale|fast|faster)$/, '🚀'],
  [/^(gift|gifts|present|giveaway|giving)$/, '🎁'],
  [/^(party|celebrate|celebration|birthday)$/, '🎉'],
  [/^(sad|cry|crying|tears|depressed)$/, '😢'],
  [/^(angry|mad|furious|hate)$/, '😡'],
  [/^(sleep|tired|exhausted|bored)$/, '😴'],
  [/^(cold|ice|freezing|frozen)$/, '🥶'],
  [/^(look|watch|see|eyes|staring)$/, '👀'],
  [/^(correct|yes|agree|exactly|true)$/, '✅'],
  [/^(wrong|never|nope|fail|failed|failure|mistake)$/, '❌'],
  [/^(danger|dangerous|warning|careful|risk|risky)$/, '⚠️'],
  [/^(100|hundred|percent|perfect)$/, '💯'],
  [/^(school|study|studying|book|books|college|university)$/, '📚'],
  [/^(work|job|business|office|boss|ceo|company)$/, '💼'],
  [/^(diamond|diamonds|jewelry|luxury)$/, '💎'],
  [/^(king|queen|crown|royal)$/, '👑'],
  [/^(ball|football|soccer|basketball|sports?)$/, '🏀'],
  [/^(water|ocean|sea|swim|swimming|beach|island)$/, '🌊'],
  [/^(kids?|children|baby|babies|family)$/, '👨‍👩‍👧'],
  [/^(challenge|challenges|compete|competition)$/, '⚔️'],
  [/^(hundreds|thousands|tons|massive|huge|giant)$/, '📈'],
];

export function emojiFor(word: string): string | undefined {
  const w = normalizeToken(word);
  if (!w) return undefined;
  for (const [re, emoji] of EMOJI_MAP) if (re.test(w)) return emoji;
  return undefined;
}

/** Lower-cases and strips punctuation (keeps apostrophes and $). */
export function normalizeToken(word: string): string {
  return word
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'$%]/g, '')
    .replace(/^'+|'+$/g, '');
}

export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
}

export function contentWords(text: string): string[] {
  return tokenize(text).filter((w) => !STOPWORDS.has(w) && w.length > 2 && !/^\d+$/.test(w));
}

export function endsSentence(word: string): boolean {
  return /[.!?…]["')\]]*$/.test(word.trim());
}

export function isQuestion(text: string): boolean {
  return /\?["')\]]*\s*$/.test(text.trim());
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function truncateWords(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut.slice(0, maxChars)).replace(/[\s,;:.-]+$/, '') + '…';
}

export function titleCase(text: string): string {
  const small = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to', 'by', 'of', 'in', 'is']);
  return text
    .split(/\s+/)
    .map((w, i) => {
      if (/^[A-Z0-9$]{2,}$/.test(w)) return w;
      const lower = w.toLowerCase();
      if (i > 0 && small.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

export function cleanSpokenText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\b(um+|uh+|erm|uhm+|hmm+)\b[,.]?\s*/gi, '')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

export function normalizeHashtag(tag: string): string {
  const t = tag.trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  return t ? `#${t}` : '';
}

export function uniq<T>(items: T[], key: (t: T) => string = (t) => String(t).toLowerCase()): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Converts brief HTML (rich text editor output) into readable plain text with bullets and line breaks. */
export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html.replace(/\r/g, '');
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const text = label.replace(/<[^>]+>/g, '').trim();
    return text && text !== href ? `${text} (${href})` : href;
  });
  s = s.replace(/<li[^>]*>/gi, '\n• ');
  s = s.replace(/<\/(p|div|h[1-6]|li|ul|ol|blockquote|tr)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractUrls(text: string): string[] {
  return uniq(text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ''));
}

export function shortId(prefix = ''): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + rand.slice(0, 12);
}

export function formatTime(sec: number, withMs = false): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const base = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
  return withMs ? `${base}.${String(Math.floor((s % 1) * 10))}` : base;
}

export function slugify(text: string, max = 60): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, max)
      .replace(/-+$/, '') || 'clip'
  );
}
