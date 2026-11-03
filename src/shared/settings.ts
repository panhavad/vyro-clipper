import { defaultBrandKit, defaultEditSettings, defaultGenerateSettings } from '../core/defaults';
import type { SocialAccount } from '../core/schedule';
import type { BrandKit, EditSettings, GenerateSettings } from '../core/types';
import { isExtensionPage } from './env';

export interface WhisperModelOption {
  id: string;
  label: string;
  multilingual: boolean;
  approxMb: number;
}

export const WHISPER_MODELS: WhisperModelOption[] = [
  { id: 'onnx-community/whisper-tiny.en_timestamped', label: 'Tiny (English, fastest)', multilingual: false, approxMb: 75 },
  { id: 'onnx-community/whisper-base.en_timestamped', label: 'Base (English, balanced)', multilingual: false, approxMb: 140 },
  { id: 'onnx-community/whisper-small.en_timestamped', label: 'Small (English, most accurate)', multilingual: false, approxMb: 420 },
  { id: 'onnx-community/whisper-base_timestamped', label: 'Base (multilingual)', multilingual: true, approxMb: 140 },
  { id: 'onnx-community/whisper-small_timestamped', label: 'Small (multilingual)', multilingual: true, approxMb: 420 },
];

export interface AppSettings {
  asr: {
    engine: 'local' | 'openai';
    localModel: string;
    device: 'auto' | 'webgpu' | 'wasm';
    /** OpenAI-compatible speech-to-text (OpenAI, Groq, local servers) */
    openai: { baseUrl: string; apiKey: string; model: string };
  };
  llm: { enabled: boolean; baseUrl: string; apiKey: string; model: string };
  /** VyroClipper server (Docker) used for media proxying and yt-dlp downloads */
  serverUrl: string;
  serverToken: string;
  defaultEdit: EditSettings;
  defaultGenerate: GenerateSettings;
  brand: BrandKit;
  accounts: SocialAccount[];
  autoReloadOnUpdate: boolean;
  faceTracking: boolean;
}

export function defaultSettings(): AppSettings {
  return {
    asr: {
      engine: 'local',
      localModel: WHISPER_MODELS[1]!.id,
      device: 'auto',
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'whisper-1' },
    },
    llm: { enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
    serverUrl: isExtensionPage() || typeof location === 'undefined' ? 'http://localhost:8080' : location.origin,
    serverToken: '',
    defaultEdit: defaultEditSettings(),
    defaultGenerate: defaultGenerateSettings(),
    brand: defaultBrandKit(),
    accounts: [],
    autoReloadOnUpdate: false,
    faceTracking: true,
  };
}

/** Deep-merges persisted settings over defaults so new fields get sensible values after updates. */
export function mergeSettings(saved: Partial<AppSettings> | undefined): AppSettings {
  const d = defaultSettings();
  if (!saved) return d;
  return {
    ...d,
    ...saved,
    asr: { ...d.asr, ...(saved.asr ?? {}), openai: { ...d.asr.openai, ...(saved.asr?.openai ?? {}) } },
    llm: { ...d.llm, ...(saved.llm ?? {}) },
    defaultEdit: { ...d.defaultEdit, ...(saved.defaultEdit ?? {}) },
    defaultGenerate: { ...d.defaultGenerate, ...(saved.defaultGenerate ?? {}) },
    brand: { ...d.brand, ...(saved.brand ?? {}) },
    accounts: saved.accounts ?? d.accounts,
  };
}
