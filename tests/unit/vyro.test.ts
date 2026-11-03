import { describe, expect, it } from 'vitest';
import { classifyMediaUrl, directDownloadUrl, findCampaignsInPayload, mergeCampaign, normalizeVyroCampaign, effectiveRules } from '../../src/core/vyro';
import { VYRO_CAMPAIGN } from './fixtures';

describe('vyro normalizer', () => {
  it('maps the catalog campaign into the internal model', () => {
    const c = normalizeVyroCampaign(VYRO_CAMPAIGN, 1000);
    expect(c.id).toBe(VYRO_CAMPAIGN.id);
    expect(c.brand).toBe('MrBeast');
    expect(c.cpm).toBe(1.5);
    expect(c.budgetRemaining).toBe(37500);
    expect(c.url).toBe('https://app.vyro.com/campaigns?c=beast-games-clips');
    expect(c.submitUrl).toBe(`https://app.vyro.com/campaigns/add-clips/${VYRO_CAMPAIGN.id}`);
    expect(c.brief).toContain('Clip the craziest moments from Beast Games.');
    expect(c.rules.minDurationSec).toBe(30);
    expect(c.rules.maxDurationSec).toBe(90);
    expect(c.rules.hashtags).toEqual(['#BeastGames', '#MrBeast']);
    expect(c.rules.disclosureHashtags).toEqual(['#ad']);
    expect(c.rules.textOnScreen).toBe('Beast Games – now streaming');
    expect(c.rules.logoUrls).toEqual(['https://cdn.vyro.com/logo.png']);
    expect(c.rules.audio[0]).toEqual({ platform: 'tiktok', url: 'https://www.tiktok.com/music/beast-123' });
    expect(c.rules.subtitlesRequired).toBe(true);
    expect(c.rules.allowCollab).toBe(false);
    expect(c.rules.platforms).toEqual(['tiktok', 'instagram', 'youtube']);
    expect(c.rules.disclosureMode).toBe('hashtag');
    expect(c.rules.briefDonts.some((d) => /music/.test(d))).toBe(true);
    expect(c.media.map((m) => m.kind)).toEqual(['gdrive', 'youtube']);
    expect(c.media[1]!.url).toBe('https://youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('finds campaigns inside paginated API payloads', () => {
    const payload = { data: [VYRO_CAMPAIGN, { ...VYRO_CAMPAIGN, id: 'x2', slug: 's2' }, { id: 'nope', name: 'not a campaign' }], meta: { page: { next: 2 } } };
    expect(findCampaignsInPayload(payload)).toHaveLength(2);
    expect(findCampaignsInPayload({ campaign: VYRO_CAMPAIGN })).toHaveLength(1);
    expect(findCampaignsInPayload({ id: 1, name: 'user', email: 'x' })).toHaveLength(0);
  });

  it('classifies media links and builds direct download URLs', () => {
    expect(classifyMediaUrl('https://youtu.be/abc')).toBe('youtube');
    expect(classifyMediaUrl('https://drive.google.com/drive/folders/xyz')).toBe('gdrive-folder');
    expect(classifyMediaUrl('https://cdn.site.com/video.MP4')).toBe('video');
    expect(classifyMediaUrl('https://www.tiktok.com/@a/video/1')).toBe('social');
    expect(classifyMediaUrl('https://example.com/page')).toBe('page');
    expect(directDownloadUrl({ url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view', kind: 'gdrive' })).toBe(
      'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOpQr&export=download&confirm=t',
    );
    expect(directDownloadUrl({ url: 'https://www.dropbox.com/s/abc/v.mp4?dl=0', kind: 'dropbox' })).toBe('https://www.dropbox.com/s/abc/v.mp4?raw=1');
  });

  it('keeps local overrides when re-synced', () => {
    const a = normalizeVyroCampaign(VYRO_CAMPAIGN, 1);
    a.overrides = { minDurationSec: 45 };
    a.selected = true;
    const merged = mergeCampaign(a, normalizeVyroCampaign(VYRO_CAMPAIGN, 2));
    expect(merged.selected).toBe(true);
    expect(effectiveRules(merged).minDurationSec).toBe(45);
    expect(merged.capturedAt).toBe(1);
  });
});
