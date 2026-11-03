// Core domain model shared by the studio, the media engine and the Chrome extension.

import type { TextScan } from './textScan';

export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'x';
export const PLATFORMS: Platform[] = ['tiktok', 'instagram', 'youtube', 'x'];

export type AspectRatio = '9:16' | '1:1' | '4:5' | '16:9';

export interface AudioRequirement {
  platform: string;
  url: string;
}

export interface CampaignRules {
  /** Shortest accepted video length in seconds (Vyro: requirements.video.minLength). */
  minDurationSec?: number;
  /** Longest video we should produce (derived from brief / platform limits). */
  maxDurationSec?: number;
  /** Caption text that must appear in the post caption. */
  caption?: string;
  /** Hashtags that must appear in the post caption (max 5 on Vyro). */
  hashtags: string[];
  /** FTC disclosure hashtags (e.g. #ad). */
  disclosureHashtags: string[];
  /** How disclosure is handled: 'hashtag' | 'platform' (paid-partnership toggle) | 'flexible'. */
  disclosureMode?: string;
  /** Text that must be burned into the video. */
  textOnScreen?: string;
  /** Logo images that must appear in the video. */
  logoUrls: string[];
  logoNotes?: string;
  /** Platform sounds that must be used (added in-app when posting). */
  audio: AudioRequirement[];
  audioNotes?: string;
  subtitlesRequired: boolean;
  allowCollab: boolean;
  languages: string[];
  platforms: Platform[];
  aspectRatio: AspectRatio;
  /** Vyro: up to 5 posts per social account, per campaign, every 24h. */
  postsPerAccountPerDay: number;
  /** Vyro: until a first approval, at most 3 clips can wait for review. */
  maxPendingBeforeApproval: number;
  /** Instructions extracted from the brief. */
  briefDos: string[];
  briefDonts: string[];
  keywords: string[];
  mentions: string[];
  socialAccount?: { displayName?: string; bio?: string; requireFreshProfile?: boolean };
}

export type MediaKind = 'video' | 'audio' | 'image' | 'frameio' | 'youtube' | 'gdrive' | 'gdrive-folder' | 'dropbox' | 'social' | 'page' | 'unknown';

export interface MediaLink {
  url: string;
  label?: string;
  kind: MediaKind;
  /** A specific file inside a multi-file share (e.g. one Frame.io asset) */
  fileId?: string;
  size?: number;
}

export type CampaignSource = 'vyro' | 'manual' | 'demo';

export interface Campaign {
  id: string;
  source: CampaignSource;
  slug?: string;
  name: string;
  brand?: string;
  brandImage?: string;
  image?: string;
  type?: string;
  status?: string;
  /** Link to the campaign on app.vyro.com */
  url?: string;
  /** Link to the Vyro "add clips" (submission) page */
  submitUrl?: string;
  /** Pay per 1,000 views in USD */
  cpm?: number;
  /** CPM is a range ("up to") */
  cpmIsRange?: boolean;
  payoutModel?: string;
  budgetTotal?: number;
  budgetSpent?: number;
  budgetRemaining?: number;
  /** Views a clip needs before it starts earning */
  minViewsPerClip?: number;
  /** Vyro locks campaigns whose budget ran out / that are paused */
  locked?: boolean;
  /** The user already joined this campaign on Vyro */
  enrolled?: boolean;
  /** Accepted post formats, e.g. INSTAGRAM_REEL */
  formats?: string[];
  startDate?: string;
  endDate?: string;
  briefHtml?: string;
  brief: string;
  mediaNotes?: string;
  media: MediaLink[];
  rules: CampaignRules;
  /** Local edits made in the studio; survive re-syncs from Vyro. */
  overrides?: Partial<CampaignRules>;
  selected?: boolean;
  capturedAt: number;
  updatedAt: number;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Transcript

export interface Word {
  text: string;
  start: number;
  end: number;
  /** Optional confidence 0..1 */
  p?: number;
}

export interface Sentence {
  index: number;
  start: number;
  end: number;
  text: string;
  /** Word index range [w0, w1) */
  w0: number;
  w1: number;
}

export type TranscriptEngine = 'whisper-local' | 'openai' | 'subtitles' | 'manual';

export interface Transcript {
  words: Word[];
  language: string;
  duration: number;
  engine: TranscriptEngine;
  model?: string;
  createdAt: number;
}

/** Loudness envelope used for excitement detection and silence detection. */
export interface AudioEnvelope {
  /** Seconds between samples */
  hop: number;
  /** RMS level per hop, 0..1 normalised to the loudest hop */
  rms: number[];
  /** Median RMS of the whole file (0..1) */
  median: number;
}

// ---------------------------------------------------------------------------
// Clips & editing

export interface TimeRange {
  start: number;
  end: number;
}

export interface ViralScores {
  /** Overall virality score 0..99 */
  total: number;
  hook: number;
  flow: number;
  value: number;
  trend: number;
  /** Fit with campaign brief / prompt keywords */
  relevance: number;
}

export type LayoutMode = 'auto' | 'fill' | 'fit' | 'split';
export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface EditSettings {
  aspect: AspectRatio;
  layout: LayoutMode;
  captionsEnabled: boolean;
  captionStyle: string;
  /** Vertical centre of captions as fraction of height (0 top .. 1 bottom) */
  captionY: number;
  captionScale: number;
  captionColor?: string;
  highlightColor?: string;
  uppercase?: boolean;
  maxWordsPerPage?: number;
  emojis: boolean;
  keywordHighlight: boolean;
  hookTitle: boolean;
  hookDuration: number;
  progressBar: boolean;
  progressColor: string;
  autoZoom: boolean;
  zoomStrength: number;
  jumpCuts: boolean;
  removeFillers: boolean;
  /** Pauses longer than this (seconds) are shortened when jumpCuts is on */
  silenceThreshold: number;
  logo: boolean;
  logoUrl?: string;
  logoCorner: Corner;
  logoScale: number;
  onScreenText: boolean;
  onScreenTextValue: string;
  onScreenTextPosition: 'top' | 'bottom';
  cta: boolean;
  ctaText: string;
  censorProfanity: boolean;
  musicEnabled: boolean;
  musicAssetId?: string;
  musicVolume: number;
  resolution: 1080 | 720;
  fps: 30 | 60;
}

export interface ReframeKeyframe {
  /** source time (s) */
  t: number;
  /** normalised crop centre (0..1) in source frame */
  cx: number;
  cy: number;
  /** face height relative to frame height (for zoom decisions) */
  fh: number;
  /** number of faces visible */
  faces: number;
}

export interface ReframeTrack {
  keyframes: ReframeKeyframe[];
  /** Two-speaker centres when a split layout is appropriate */
  split?: { a: { cx: number; cy: number }; b: { cx: number; cy: number } };
  suggestedLayout: Exclude<LayoutMode, 'auto'>;
  analyzedAt: number;
}

export type ClipStatus = 'draft' | 'rendering' | 'rendered' | 'error';

export interface Clip {
  id: string;
  projectId: string;
  campaignId?: string;
  /** Source range in seconds */
  start: number;
  end: number;
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  scores: ViralScores;
  reasons: string[];
  transcript: string;
  /** Source ranges removed by transcript editing (in addition to automatic jump cuts) */
  manualCuts: TimeRange[];
  edit: EditSettings;
  reframe?: ReframeTrack;
  status: ClipStatus;
  error?: string;
  output?: { fileName: string; size: number; renderedAt: number; durationSec: number };
  engine: 'heuristic' | 'llm';
  favorite?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface GenerateSettings {
  /** Desired number of clips (0 = auto) */
  clipCount: number;
  minDuration: number;
  maxDuration: number;
  /** Optional free-text prompt, e.g. "moments about money" */
  prompt: string;
  /** Only analyse this portion of the source (seconds) */
  rangeStart?: number;
  rangeEnd?: number;
  language: string;
  useLlm: boolean;
}

export type ProjectStatus =
  | 'new'
  | 'downloading'
  | 'probing'
  | 'transcribing'
  | 'analyzing'
  | 'detecting'
  | 'reframing'
  | 'ready'
  | 'error';

export interface SourceMeta {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
  videoCodec?: string | null;
  audioCodec?: string | null;
}

export interface Project {
  id: string;
  campaignId?: string;
  name: string;
  source: {
    kind: 'file' | 'url';
    url?: string;
    /** Specific file inside a multi-file share (Frame.io) */
    fileId?: string;
    fileName?: string;
    size?: number;
    mime?: string;
    /** File name inside the origin-private file system */
    storedAs?: string;
  };
  meta?: SourceMeta;
  /** Text already burned into the source (captions, titles, logos) */
  textScan?: TextScan;
  transcript?: Transcript;
  envelope?: AudioEnvelope;
  clips: Clip[];
  status: ProjectStatus;
  progress?: { step: string; pct: number; detail?: string };
  error?: string;
  settings: GenerateSettings;
  createdAt: number;
  updatedAt: number;
}

export interface BrandKit {
  name: string;
  logoDataUrl?: string;
  primaryColor: string;
  accentColor: string;
  ctaText: string;
  defaultCaptionStyle: string;
  watermarkText?: string;
}

export interface ComplianceItem {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warn' | 'manual';
  detail?: string;
}

export interface ComplianceReport {
  ok: boolean;
  items: ComplianceItem[];
}
