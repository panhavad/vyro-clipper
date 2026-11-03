import { describe, expect, it } from 'vitest';
import { checkCompliance } from '../../src/core/compliance';
import { buildPostCaption } from '../../src/core/hooks';
import { defaultEditSettings, editSettingsForCampaign, generateSettingsForCampaign, defaultGenerateSettings } from '../../src/core/defaults';
import { normalizeVyroCampaign } from '../../src/core/vyro';
import { planPosts, toIcs } from '../../src/core/schedule';
import { parseCommands } from '../../src/core/commands';
import { parseClipSuggestions, buildClipPrompts } from '../../src/core/llm';
import { toEdl, toFcpXml } from '../../src/core/exporters';
import { buildTimeline } from '../../src/core/timeline';
import { buildSentences } from '../../src/core/transcript';
import { ensureMinDuration } from '../../src/core/clipFactory';
import { fakeWords, VIRAL, BORING, VYRO_CAMPAIGN } from './fixtures';

const campaign = normalizeVyroCampaign(VYRO_CAMPAIGN);

describe('campaign-aware defaults + compliance', () => {
  it('makes default edits compliant with the campaign', () => {
    const edit = editSettingsForCampaign(defaultEditSettings(), campaign.rules);
    expect(edit.onScreenText).toBe(true);
    expect(edit.logo).toBe(true);
    expect(edit.captionsEnabled).toBe(true);
    const caption = buildPostCaption({ hookLine: 'He gave away a million dollars', rules: campaign.rules, extraHashtags: ['#viral'] });
    const report = checkCompliance({ rules: campaign.rules, edit, durationSec: 42, postCaption: caption.text, transcriptLanguage: 'en', fromCampaignMedia: true });
    expect(report.items.filter((i) => i.status === 'fail')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.items.some((i) => i.id === 'audio' && i.status === 'manual')).toBe(true);
    expect(report.items.some((i) => i.id === 'collab')).toBe(true);
  });

  it('flags violations', () => {
    const edit = { ...defaultEditSettings(), captionsEnabled: false, musicEnabled: true };
    const report = checkCompliance({ rules: campaign.rules, edit, durationSec: 20, postCaption: 'no tags here' });
    const failed = report.items.filter((i) => i.status === 'fail').map((i) => i.id);
    expect(failed).toEqual(expect.arrayContaining(['min-length', 'subtitles', 'text-on-screen', 'logo', 'caption', 'hashtags', 'disclosure', 'no-music']));
    expect(report.ok).toBe(false);
  });

  it('accepts captions already burned into the source and warns before doubling them', () => {
    const base = editSettingsForCampaign(defaultEditSettings(), campaign.rules);
    const postCaption = buildPostCaption({ hookLine: 'x', rules: campaign.rules }).text;
    const off = checkCompliance({ rules: campaign.rules, edit: { ...base, captionsEnabled: false }, durationSec: 42, postCaption, burnedInCaptions: true });
    expect(off.items.find((i) => i.id === 'subtitles')).toMatchObject({ status: 'pass', detail: 'Already in the source video' });
    expect(off.items.some((i) => i.id === 'double-captions')).toBe(false);
    const both = checkCompliance({ rules: campaign.rules, edit: base, durationSec: 42, postCaption, burnedInCaptions: true });
    expect(both.items.find((i) => i.id === 'double-captions')?.status).toBe('warn');
  });

  it('keeps required caption parts within platform limits', () => {
    const caption = buildPostCaption({ hookLine: 'x'.repeat(400), rules: campaign.rules, extraHashtags: ['#a', '#b'] });
    expect(caption.variants.x.length).toBeLessThanOrEqual(280);
    expect(caption.variants.x).toContain('#ad');
    expect(caption.variants.x).toContain('Watch Beast Games on Prime Video');
    expect(caption.variants.youtube.length).toBeLessThanOrEqual(100);
    expect(caption.hashtags).toEqual(['#BeastGames', '#MrBeast', '#a', '#b', '#ad']);
  });

  it('derives generation settings from rules', () => {
    const g = generateSettingsForCampaign(defaultGenerateSettings(), campaign.rules);
    expect(g.minDuration).toBe(32);
    expect(g.maxDuration).toBe(75);
  });
});

describe('posting schedule', () => {
  it('respects first-batch and daily limits', () => {
    const clips = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, title: `Clip ${i}` }));
    const start = new Date('2026-11-03T08:00:00');
    const slots = planPosts(clips, { accounts: [{ platform: 'tiktok', handle: 'me' }], platforms: ['tiktok'], start });
    expect(slots).toHaveLength(12);
    expect(slots.filter((s) => s.phase === 'first-batch')).toHaveLength(3);
    const perDay = new Map<string, number>();
    for (const s of slots) perDay.set(s.at.slice(0, 10), (perDay.get(s.at.slice(0, 10)) ?? 0) + 1);
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(5);
    expect(toIcs(slots, { c0: 'caption' }, 'Camp')).toContain('BEGIN:VEVENT');
  });
});

describe('magic commands', () => {
  it('parses multiple edit commands', () => {
    const r = parseCommands('make captions yellow and bigger, use beast style, remove filler words, zoom more, no emojis, title: I Quit My Job', {
      edit: defaultEditSettings(),
      clip: { start: 10, end: 40 },
    });
    expect(r.edit.captionColor).toBe('#FFE81F');
    expect(r.edit.captionScale).toBeCloseTo(1.15);
    expect(r.edit.captionStyle).toBe('beast');
    expect(r.edit.removeFillers).toBe(true);
    expect(r.edit.zoomStrength).toBeGreaterThan(0.6);
    expect(r.edit.emojis).toBe(false);
    expect(r.clip.title).toBe('I Quit My Job');
    expect(r.unknown).toEqual([]);
  });

  it('does not confuse subtitle colour with the subtitle style', () => {
    const r = parseCommands('make subtitles red', { edit: defaultEditSettings(), clip: { start: 0, end: 10 } });
    expect(r.edit.captionStyle).toBeUndefined();
    expect(r.edit.captionColor).toBe('#FF3B3B');
  });
});

describe('llm + exporters + min duration', () => {
  it('parses fenced JSON suggestions and clamps indices', () => {
    const words = fakeWords(VIRAL + BORING);
    const sentences = buildSentences(words);
    const text = 'Sure!\n```json\n{"clips":[{"start":0,"end":2,"title":"Million dollar test","hook":"WOULD YOU?","caption":"c","hashtags":["#money"],"scores":{"hook":90,"flow":80,"value":70,"trend":95},"why":"big stakes"},{"start":99,"end":120}]}\n```';
    const parsed = parseClipSuggestions(text, sentences);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ s0: 0, s1: 2, title: 'Million dollar test' });
    expect(parsed[1]!.s1).toBe(sentences.length - 1);
    const prompts = buildClipPrompts(sentences, { rules: campaign.rules, minDuration: 30, maxDuration: 60, count: 3 });
    expect(prompts[0]!.user).toContain('#0 [0:00');
  });

  it('exports EDL and FCPXML', () => {
    const plan = buildTimeline({ start: 10, end: 20 }, [{ start: 12, end: 13 }]);
    const edl = toEdl('Clip', 'source.mp4', plan, 30);
    expect(edl).toContain('001  SOURCE');
    expect(edl).toContain('00:00:10:00 00:00:12:00 00:00:00:00 00:00:02:00');
    const xml = toFcpXml({ title: 'Clip', sourceName: 'source.mp4', sourceDuration: 60, width: 1920, height: 1080, outWidth: 1080, outHeight: 1920, plan });
    expect(xml).toContain('<asset-clip');
    expect(xml.match(/<asset-clip/g)).toHaveLength(2);
  });

  it('extends clips that jump cuts would push under the campaign minimum', () => {
    const words = fakeWords((VIRAL + BORING).repeat(3), { sentencePause: 1.5 });
    const sentences = buildSentences(words);
    const edit = { ...defaultEditSettings(), jumpCuts: true, silenceThreshold: 0.5 };
    const ctx = { projectId: 'p', rules: campaign.rules, edit, words, sentences, sourceDuration: words[words.length - 1]!.end };
    const r = ensureMinDuration({ start: sentences[0]!.start, end: sentences[3]!.end }, ctx, 30);
    expect(r.end).toBeGreaterThan(sentences[3]!.end);
  });
});
