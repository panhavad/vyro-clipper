// Message protocol shared by the extension (background, content scripts, popup) and the studio.
import type { Campaign } from '../core/types';

export const STORAGE_KEYS = {
  campaigns: 'vc:campaigns',
  selected: 'vc:selected',
  options: 'vc:options',
  auth: 'vc:auth-seen',
} as const;

export interface ExtensionOptions {
  /** Hosted studio (Docker) URL; empty = use the studio bundled in the extension */
  studioUrl: string;
  /** Show the floating "Clip with VyroClipper" button on app.vyro.com */
  overlay: boolean;
}

export const DEFAULT_EXTENSION_OPTIONS: ExtensionOptions = { studioUrl: '', overlay: true };

export type BackgroundRequest =
  | { type: 'vc:upsert-campaigns'; campaigns: Campaign[] }
  | { type: 'vc:get-state' }
  | { type: 'vc:set-selected'; ids: string[] }
  | { type: 'vc:toggle-selected'; id: string; selected: boolean }
  | { type: 'vc:open-studio'; campaignIds?: string[] }
  | { type: 'vc:sync-vyro' }
  | { type: 'vc:fetch-campaign'; slug: string }
  | { type: 'vc:get-options' }
  | { type: 'vc:set-options'; options: Partial<ExtensionOptions> }
  | { type: 'vc:check-update' };

export interface ExtensionState {
  campaigns: Campaign[];
  selected: string[];
  version: string;
  commit: string;
  options: ExtensionOptions;
}

export type ContentRequest = { type: 'vc:fetch-all' } | { type: 'vc:fetch-slug'; slug: string } | { type: 'vc:ping' };

/** window.postMessage envelope between a web page and the studio bridge content script */
export interface BridgeMessage {
  __vc: 'req' | 'res' | 'event';
  id?: string;
  type?: string;
  payload?: unknown;
  ok?: boolean;
  data?: unknown;
  error?: string;
}

/** window.postMessage envelope between app.vyro.com MAIN world and the isolated content script */
export interface VyroPageMessage {
  __vyroclipper: 'captured' | 'auth' | 'fetch-result' | 'fetch-request';
  id?: string;
  payload?: unknown;
  error?: string;
  kind?: 'all' | 'slug';
  slug?: string;
}
