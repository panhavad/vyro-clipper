import type { Word } from '../../src/core/types';

/** Builds a timed word list from text: ~wps words/second, with a pause after each sentence. */
export function fakeWords(text: string, opts: { start?: number; wps?: number; sentencePause?: number } = {}): Word[] {
  const wps = opts.wps ?? 2.8;
  const pause = opts.sentencePause ?? 0.35;
  let t = opts.start ?? 0;
  const words: Word[] = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    const d = 1 / wps;
    words.push({ text: tok, start: t, end: t + d * 0.9 });
    t += d;
    if (/[.!?]$/.test(tok)) t += pause;
  }
  return words;
}

export const BORING =
  'So basically we went to the store. And then we looked at some shelves. It was fine I guess. There were some items there. We walked around for a while. Then we left the store and went home. ';

export const VIRAL =
  'What would you do with one million dollars? I gave away $1,000,000 to a total stranger and the reaction was insane! He started crying. Nobody believed it was real. Here is the secret behind why this works. ';

// Shape reverse-engineered from app.vyro.com (catalog/campaigns + brand campaign form mapper).
export const VYRO_CAMPAIGN = {
  id: '6650f1c2a1b2c3d4e5f60718',
  slug: 'beast-games-clips',
  name: 'Beast Games – Clip the craziest moments',
  type: 'clipping',
  status: 'active',
  startDate: '2026-10-20T00:00:00.000Z',
  endDate: '2026-11-30T00:00:00.000Z',
  workspace: { name: 'Beast Industries', image: 'https://cdn.vyro.com/ws.png' },
  displayOption: { workspaceName: 'MrBeast', workspaceImage: 'https://cdn.vyro.com/mrbeast.png' },
  headlineRate: 1.5,
  payoutModel: { model: 'cpm', payRate: 1.5 },
  budget: { value: 50000, spent: 12500 },
  targeting: { languages: ['en'], platforms: ['tiktok', 'instagram', 'youtube'] },
  requirements: {
    brief: '<p>Clip the <b>craziest</b> moments from <strong>Beast Games</strong>.</p><ul><li>Clips must be under 90 seconds.</li><li>Do not add music.</li></ul>',
    logo: { urls: ['https://cdn.vyro.com/logo.png'], notes: 'Top right corner' },
    text: { caption: 'Watch Beast Games on Prime Video', hashtags: ['BeastGames', '#MrBeast'], textOnScreen: 'Beast Games – now streaming', ftcDisclosureHashtags: ['#ad'] },
    audio: { links: [{ platform: 'tiktok', url: 'https://www.tiktok.com/music/beast-123' }], notes: 'Use at 10% volume' },
    subtitles: { required: true },
    video: { minLength: 30 },
    collaboration: { allowCollabAndTagging: false },
    platformRules: { ftcDisclosure: { instagram: 'platform', tiktok: 'hashtag' } },
  },
  media: { links: [{ url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view?usp=sharing' }, { url: 'youtube.com/watch?v=dQw4w9WgXcQ' }], notes: 'Episode 1 and 2' },
};

