import type { Platform } from './types';

export interface SocialAccount {
  platform: Platform;
  handle: string;
}

export interface PostSlot {
  clipId: string;
  clipTitle: string;
  platform: Platform;
  handle: string;
  at: string;
  /** Posts in the first batch wait for Vyro's first approval */
  phase: 'first-batch' | 'after-approval';
}

export interface ScheduleOptions {
  accounts: SocialAccount[];
  platforms: Platform[];
  start: Date;
  perAccountPerDay?: number;
  maxPendingBeforeApproval?: number;
  /** Local posting hours */
  hours?: number[];
}

const DEFAULT_HOURS = [9, 12, 15, 18, 21];

/**
 * Plans posts across accounts while honouring Vyro limits:
 * one post per clip per platform, ≤ N posts per account per 24h, and only a few pending clips before the first approval.
 */
export function planPosts(clips: Array<{ id: string; title: string }>, opts: ScheduleOptions): PostSlot[] {
  const perDay = opts.perAccountPerDay ?? 5;
  const firstBatch = opts.maxPendingBeforeApproval ?? 3;
  const hours = (opts.hours?.length ? opts.hours : DEFAULT_HOURS).slice().sort((a, b) => a - b);
  const slots: PostSlot[] = [];
  const accounts = opts.accounts.filter((a) => opts.platforms.includes(a.platform));
  if (!accounts.length) return slots;
  const usage = new Map<string, Map<number, number>>(); // handle -> dayIndex -> count
  const dayStart = new Date(opts.start);
  dayStart.setHours(0, 0, 0, 0);
  let posted = 0;

  for (const clip of clips) {
    for (const platform of opts.platforms) {
      const pool = accounts.filter((a) => a.platform === platform);
      if (!pool.length) continue;
      let placed = false;
      // Before approval only `firstBatch` posts go out on day 0; afterwards spread by daily limits.
      for (let day = posted < firstBatch ? 0 : 1; day < 365 && !placed; day++) {
        for (const acct of pool) {
          const key = `${acct.platform}:${acct.handle}`;
          const days = usage.get(key) ?? new Map<number, number>();
          const count = days.get(day) ?? 0;
          if (count >= perDay || count >= hours.length) continue;
          if (day === 0 && posted >= firstBatch) continue;
          const at = new Date(dayStart);
          at.setDate(at.getDate() + day);
          at.setHours(hours[count]!, 0, 0, 0);
          if (at < opts.start) continue;
          days.set(day, count + 1);
          usage.set(key, days);
          slots.push({ clipId: clip.id, clipTitle: clip.title, platform, handle: acct.handle, at: at.toISOString(), phase: posted < firstBatch ? 'first-batch' : 'after-approval' });
          posted++;
          placed = true;
          break;
        }
      }
    }
  }
  return slots.sort((a, b) => a.at.localeCompare(b.at));
}

function icsDate(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function toIcs(slots: PostSlot[], captions: Record<string, string>, campaignName: string): string {
  const now = icsDate(new Date().toISOString());
  const events = slots.map((s, i) => {
    const end = new Date(new Date(s.at).getTime() + 15 * 60000).toISOString();
    return [
      'BEGIN:VEVENT',
      `UID:vyroclipper-${s.clipId}-${s.platform}-${i}@vyroclipper`,
      `DTSTAMP:${now}`,
      `DTSTART:${icsDate(s.at)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsEscape(`Post on ${s.platform} (@${s.handle}): ${s.clipTitle}`)}`,
      `DESCRIPTION:${icsEscape(`${campaignName}\n\n${captions[s.clipId] ?? ''}\n\nAfter posting, submit the live URL on Vyro.`)}`,
      'END:VEVENT',
    ].join('\r\n');
  });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VyroClipper//Posting plan//EN', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n');
}
