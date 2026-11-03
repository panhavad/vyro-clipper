import { normalizeHashtag } from './text';
import type { CampaignRules, ComplianceItem, ComplianceReport, EditSettings, Platform } from './types';

export interface ComplianceInput {
  rules: CampaignRules;
  edit: EditSettings;
  /** Final output duration in seconds (after jump cuts) */
  durationSec: number;
  postCaption: string;
  transcriptLanguage?: string;
  /** Whether the source footage came from the campaign's "Content to Use" links */
  fromCampaignMedia?: boolean;
}

const PLATFORM_MAX: Record<Platform, number> = { youtube: 180, tiktok: 600, instagram: 180, x: 140 };
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function checkCompliance(input: ComplianceInput): ComplianceReport {
  const { rules, edit, durationSec } = input;
  const caption = input.postCaption ?? '';
  const captionLower = norm(caption);
  const items: ComplianceItem[] = [];
  const add = (id: string, label: string, status: ComplianceItem['status'], detail?: string) => items.push(detail ? { id, label, status, detail } : { id, label, status });

  if (rules.minDurationSec) {
    add(
      'min-length',
      `At least ${rules.minDurationSec}s long`,
      durationSec + 0.05 >= rules.minDurationSec ? 'pass' : 'fail',
      `Clip is ${durationSec.toFixed(1)}s`,
    );
  }
  if (rules.maxDurationSec) {
    add('max-length', `At most ${rules.maxDurationSec}s long`, durationSec <= rules.maxDurationSec + 0.05 ? 'pass' : 'fail', `Clip is ${durationSec.toFixed(1)}s`);
  }
  const tooLong = rules.platforms.filter((p) => durationSec > PLATFORM_MAX[p]);
  if (tooLong.length) add('platform-length', 'Fits platform length limits', 'warn', `Too long for: ${tooLong.join(', ')}`);

  add('aspect', `Format ${rules.aspectRatio}`, edit.aspect === rules.aspectRatio ? 'pass' : 'warn', edit.aspect !== rules.aspectRatio ? `Clip is ${edit.aspect}` : undefined);

  if (rules.subtitlesRequired) add('subtitles', 'Subtitles burned in', edit.captionsEnabled ? 'pass' : 'fail');
  else if (edit.captionsEnabled) add('subtitles', 'Animated captions', 'pass');

  if (rules.textOnScreen) {
    const ok = edit.onScreenText && norm(edit.onScreenTextValue).includes(norm(rules.textOnScreen));
    add('text-on-screen', 'Required on-screen text', ok ? 'pass' : 'fail', `“${rules.textOnScreen}”`);
  }
  if (rules.logoUrls.length) {
    add('logo', 'Campaign logo in video', edit.logo && !!edit.logoUrl ? 'pass' : 'fail', rules.logoNotes);
  }
  if (rules.caption) {
    add('caption', 'Required caption text', captionLower.includes(norm(rules.caption)) ? 'pass' : 'fail', rules.caption);
  }
  if (rules.hashtags.length) {
    const missing = rules.hashtags.map(normalizeHashtag).filter((h) => !captionLower.includes(h.toLowerCase()));
    add('hashtags', `Required hashtags (${rules.hashtags.length})`, missing.length ? 'fail' : 'pass', missing.length ? `Missing ${missing.join(' ')}` : rules.hashtags.join(' '));
  }
  if (rules.disclosureHashtags.length) {
    const has = rules.disclosureHashtags.some((h) => captionLower.includes(normalizeHashtag(h).toLowerCase()));
    add('disclosure', 'Ad disclosure hashtag', has ? 'pass' : 'fail', rules.disclosureHashtags.join(' ') + (rules.disclosureMode === 'flexible' ? ' (or the paid-partnership label)' : ''));
  }
  if (rules.disclosureMode === 'platform') {
    add('disclosure-toggle', 'Turn on the platform “Paid partnership / Branded content” toggle when posting', 'manual');
  }
  if (rules.mentions.length) {
    const missing = rules.mentions.filter((m) => !captionLower.includes(m.toLowerCase()));
    add('mentions', `Tag ${rules.mentions.join(' ')}`, missing.length ? 'warn' : 'pass', missing.length ? `Missing ${missing.join(' ')}` : undefined);
  }
  if (rules.audio.length) {
    add('audio', 'Use the campaign sound in-app when posting', 'manual', rules.audio.map((a) => `${a.platform}: ${a.url}`).join('  ') + (rules.audioNotes ? ` — ${rules.audioNotes}` : ''));
    if (edit.musicEnabled) add('audio-music', 'Background music may clash with the required sound', 'warn');
  }
  if (rules.languages.length) {
    const lang = (input.transcriptLanguage ?? 'en').slice(0, 2).toLowerCase();
    const ok = rules.languages.some((l) => l.slice(0, 2).toLowerCase() === lang);
    add('language', `Language: ${rules.languages.join(', ')}`, ok ? 'pass' : 'warn', ok ? undefined : `Detected ${lang}`);
  }
  if (input.fromCampaignMedia === false) add('source', 'Footage from the campaign “Content to Use”', 'warn', 'Source was added manually');
  else if (input.fromCampaignMedia) add('source', 'Footage from the campaign “Content to Use”', 'pass');
  if (!rules.allowCollab) add('collab', 'Do not add collaborators or tag other accounts', 'manual');
  if (rules.briefDonts.some((d) => /\bmusic\b/i.test(d)) && edit.musicEnabled) add('no-music', 'Brief says no added music', 'fail');
  for (const dont of rules.briefDonts.slice(0, 4)) add(`brief-${items.length}`, dont, 'manual');

  return { ok: !items.some((i) => i.status === 'fail'), items };
}

export function complianceSummary(report: ComplianceReport): { pass: number; fail: number; warn: number; manual: number } {
  const c = { pass: 0, fail: 0, warn: 0, manual: 0 };
  for (const i of report.items) c[i.status]++;
  return c;
}
