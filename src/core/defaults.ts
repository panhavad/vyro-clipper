import { DEFAULT_CAPTION_STYLE } from './captions';
import type { BrandKit, CampaignRules, EditSettings, GenerateSettings } from './types';

export function defaultEditSettings(): EditSettings {
  return {
    aspect: '9:16',
    layout: 'auto',
    captionsEnabled: true,
    captionStyle: DEFAULT_CAPTION_STYLE,
    captionY: 0.7,
    captionScale: 1,
    emojis: true,
    keywordHighlight: true,
    hookTitle: true,
    hookDuration: 3.2,
    progressBar: true,
    progressColor: '#FFE81F',
    autoZoom: true,
    zoomStrength: 0.6,
    jumpCuts: true,
    removeFillers: true,
    silenceThreshold: 0.55,
    logo: false,
    logoCorner: 'tr',
    logoScale: 1,
    onScreenText: false,
    onScreenTextValue: '',
    onScreenTextPosition: 'top',
    cta: false,
    ctaText: 'Follow for more 🔥',
    censorProfanity: false,
    musicEnabled: false,
    musicVolume: 0.18,
    resolution: 1080,
    fps: 30,
  };
}

export function defaultGenerateSettings(): GenerateSettings {
  return {
    clipCount: 0,
    minDuration: 20,
    maxDuration: 75,
    prompt: '',
    language: 'en',
    useLlm: false,
  };
}

export function defaultBrandKit(): BrandKit {
  return {
    name: 'My brand',
    primaryColor: '#7C3AED',
    accentColor: '#FFE81F',
    ctaText: 'Follow for more 🔥',
    defaultCaptionStyle: DEFAULT_CAPTION_STYLE,
  };
}

/** Applies campaign rules to edit settings so every generated clip is compliant by default. */
export function editSettingsForCampaign(base: EditSettings, rules: CampaignRules, brand?: BrandKit): EditSettings {
  const e: EditSettings = { ...base, aspect: rules.aspectRatio };
  if (rules.subtitlesRequired) e.captionsEnabled = true;
  if (rules.textOnScreen) {
    e.onScreenText = true;
    e.onScreenTextValue = rules.textOnScreen;
  }
  if (rules.logoUrls.length) {
    e.logo = true;
    e.logoUrl = rules.logoUrls[0];
  } else if (brand?.logoDataUrl && !e.logoUrl) {
    e.logoUrl = brand.logoDataUrl;
  }
  if (rules.briefDonts.some((d) => /\bmusic\b/i.test(d))) e.musicEnabled = false;
  if (rules.briefDonts.some((d) => /\bemoji/i.test(d))) e.emojis = false;
  if (rules.briefDonts.some((d) => /\b(profanity|swear|curse|cursing)\b/i.test(d))) e.censorProfanity = true;
  if (brand) {
    e.captionStyle = brand.defaultCaptionStyle || e.captionStyle;
    e.progressColor = brand.accentColor || e.progressColor;
    e.ctaText = brand.ctaText || e.ctaText;
  }
  return e;
}

export function generateSettingsForCampaign(base: GenerateSettings, rules: CampaignRules): GenerateSettings {
  const g = { ...base };
  if (rules.minDurationSec) g.minDuration = Math.max(g.minDuration, Math.ceil(rules.minDurationSec + 2));
  if (rules.maxDurationSec) g.maxDuration = Math.min(g.maxDuration, Math.floor(rules.maxDurationSec - 1));
  if (g.maxDuration < g.minDuration + 5) g.maxDuration = g.minDuration + 25;
  if (rules.languages[0]) g.language = rules.languages[0].slice(0, 2).toLowerCase();
  return g;
}
