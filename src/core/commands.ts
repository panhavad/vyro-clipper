import { CAPTION_STYLES } from './captions';
import type { AspectRatio, Clip, EditSettings, LayoutMode } from './types';

export const COLOR_NAMES: Record<string, string> = {
  yellow: '#FFE81F',
  gold: '#FFC400',
  red: '#FF3B3B',
  green: '#3CFF6B',
  lime: '#B6FF3B',
  blue: '#29B6FF',
  cyan: '#22E3FF',
  teal: '#00FFC6',
  purple: '#9B5CFF',
  violet: '#7C3AED',
  pink: '#FF2D95',
  orange: '#FF9F1C',
  white: '#FFFFFF',
  black: '#000000',
};

export interface CommandResult {
  edit: Partial<EditSettings>;
  clip: Partial<Pick<Clip, 'title' | 'hook' | 'start' | 'end' | 'caption'>>;
  applied: string[];
  unknown: string[];
}

function colorFrom(text: string): string | undefined {
  const hex = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(text);
  if (hex) return hex[0].toUpperCase();
  const name = Object.keys(COLOR_NAMES).find((c) => new RegExp(`\\b${c}\\b`, 'i').test(text));
  return name ? COLOR_NAMES[name] : undefined;
}

function seconds(text: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?)\b/i.exec(text);
  return m ? parseFloat(m[1]!) : undefined;
}

/**
 * "Magic box" natural-language editing, e.g.
 * "make captions yellow and bigger, use beast style, remove filler words, zoom more, title: I quit my job".
 */
export function parseCommands(input: string, current: { edit: EditSettings; clip: Pick<Clip, 'start' | 'end'> }): CommandResult {
  const result: CommandResult = { edit: {}, clip: {}, applied: [], unknown: [] };
  // Free-text values (title: ..., hook: ...) may contain commas, so extract them first.
  let rest = input;
  const valueCmd = /\b(title|hook|cta|text on screen|on-screen text|caption)\s*[:=]\s*("[^"]*"|[^;\n]*)/gi;
  for (const m of input.matchAll(valueCmd)) {
    const key = m[1]!.toLowerCase();
    const value = m[2]!.replace(/^"|"$/g, '').trim();
    if (key === 'title') result.clip.title = value;
    else if (key === 'hook') {
      result.clip.hook = value;
      result.edit.hookTitle = true;
    } else if (key === 'cta') {
      result.edit.cta = true;
      result.edit.ctaText = value;
    } else if (key === 'caption') result.clip.caption = value;
    else {
      result.edit.onScreenText = true;
      result.edit.onScreenTextValue = value;
    }
    result.applied.push(`${key} → “${value}”`);
    rest = rest.replace(m[0], ' ');
  }

  const parts = rest
    .split(/\s*(?:,|;|\band\b|\bthen\b|\n)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const e = result.edit;
  const SUBJECT = /\b(captions?|subtitles?|text|font|words?|zoom|logo|progress ?bar|hook|emojis?|layout|cta)\b/;
  let lastSubject = '';
  for (const raw of parts) {
    let p = raw.toLowerCase();
    // "captions yellow and bigger": carry the subject over to follow-up fragments.
    const subject = SUBJECT.exec(p)?.[1];
    if (subject) lastSubject = subject;
    else if (lastSubject) p = `${lastSubject} ${p}`;
    const before = result.applied.length;
    const style = CAPTION_STYLES.find((s) => p.includes(s.id) || p.includes(s.name.toLowerCase()));
    const color = colorFrom(p);
    if (style && (/\b(style|use|look|font|template)\b/.test(p) || (!color && /caption/.test(p) && style.id !== 'subtitle'))) {
      e.captionStyle = style.id;
      result.applied.push(`caption style → ${style.name}`);
    }
    if (color && /caption|subtitle|text|word|highlight/.test(p)) {
      if (/highlight|active|keyword/.test(p)) e.highlightColor = color;
      else e.captionColor = color;
      result.applied.push(`caption colour → ${color}`);
    }
    if (/(bigger|larger|increase).*(caption|text|font)|(caption|text|font).*(bigger|larger)/.test(p)) {
      e.captionScale = Math.min(1.8, (current.edit.captionScale ?? 1) + 0.15);
      result.applied.push('captions bigger');
    } else if (/(smaller|decrease).*(caption|text|font)|(caption|text|font).*smaller/.test(p)) {
      e.captionScale = Math.max(0.6, (current.edit.captionScale ?? 1) - 0.15);
      result.applied.push('captions smaller');
    }
    if (/caption|subtitle/.test(p) && /\b(top|up|higher)\b/.test(p)) {
      e.captionY = /\btop\b/.test(p) ? 0.2 : Math.max(0.15, (current.edit.captionY ?? 0.7) - 0.1);
      result.applied.push('captions moved up');
    } else if (/caption|subtitle/.test(p) && /\b(bottom|down|lower)\b/.test(p)) {
      e.captionY = /\bbottom\b/.test(p) ? 0.82 : Math.min(0.88, (current.edit.captionY ?? 0.7) + 0.1);
      result.applied.push('captions moved down');
    } else if (/caption|subtitle/.test(p) && /\b(middle|center|centre)\b/.test(p)) {
      e.captionY = 0.5;
      result.applied.push('captions centred');
    }
    if (/(no|remove|hide|disable|turn off).*(caption|subtitle)/.test(p)) {
      e.captionsEnabled = false;
      result.applied.push('captions off');
    } else if (/(add|show|enable|turn on).*(caption|subtitle)/.test(p)) {
      e.captionsEnabled = true;
      result.applied.push('captions on');
    }
    if (/uppercase|all caps/.test(p)) {
      e.uppercase = true;
      result.applied.push('uppercase');
    }
    if (/lowercase|sentence case|normal case/.test(p)) {
      e.uppercase = false;
      result.applied.push('sentence case');
    }
    if (/filler/.test(p)) {
      e.removeFillers = !/(keep|don'?t remove|leave)/.test(p);
      result.applied.push(e.removeFillers ? 'remove filler words' : 'keep filler words');
    }
    if (/silence|jump ?cut|pauses?/.test(p)) {
      e.jumpCuts = !/(keep|no|off|disable|don'?t)/.test(p);
      result.applied.push(e.jumpCuts ? 'jump cuts on' : 'jump cuts off');
    }
    if (/emoji/.test(p)) {
      e.emojis = !/(no|remove|without|off|disable)/.test(p);
      result.applied.push(e.emojis ? 'emojis on' : 'emojis off');
    }
    if (/zoom/.test(p)) {
      if (/(no|off|disable|remove|stop)/.test(p)) e.autoZoom = false;
      else {
        e.autoZoom = true;
        e.zoomStrength = /(more|stronger|bigger|max)/.test(p) ? Math.min(1, (current.edit.zoomStrength ?? 0.6) + 0.25) : /(less|subtle|lighter)/.test(p) ? Math.max(0.15, (current.edit.zoomStrength ?? 0.6) - 0.25) : current.edit.zoomStrength;
      }
      result.applied.push(e.autoZoom === false ? 'zoom off' : 'zoom adjusted');
    }
    if (/progress ?bar/.test(p)) {
      e.progressBar = !/(no|remove|off|hide|disable)/.test(p);
      const c = colorFrom(p);
      if (c) e.progressColor = c;
      result.applied.push(e.progressBar ? 'progress bar on' : 'progress bar off');
    }
    if (/\bhook\b/.test(p) && /(no|remove|off|hide)/.test(p)) {
      e.hookTitle = false;
      result.applied.push('hook title off');
    } else if (/\bhook\b/.test(p) && /(add|show|on)/.test(p)) {
      e.hookTitle = true;
      result.applied.push('hook title on');
    }
    if (/\blogo\b/.test(p)) {
      e.logo = !/(no|remove|hide|off)/.test(p);
      const corner = /top ?left/.test(p) ? 'tl' : /top ?right/.test(p) ? 'tr' : /bottom ?left/.test(p) ? 'bl' : /bottom ?right/.test(p) ? 'br' : undefined;
      if (corner) e.logoCorner = corner;
      result.applied.push(e.logo ? 'logo on' : 'logo off');
    }
    if (/\bcta\b|call to action/.test(p) && /(no|remove|off)/.test(p)) {
      e.cta = false;
      result.applied.push('CTA off');
    }
    if (/censor|bleep|profanity|swear/.test(p)) {
      e.censorProfanity = !/(un-?censor|no|off|don'?t)/.test(p);
      result.applied.push(e.censorProfanity ? 'censor profanity' : 'no censoring');
    }
    const layout: LayoutMode | undefined = /\bsplit\b/.test(p) ? 'split' : /\bfit\b|blur(red)? background|letterbox/.test(p) ? 'fit' : /\bfill\b|full ?screen|crop/.test(p) ? 'fill' : undefined;
    if (layout) {
      e.layout = layout;
      result.applied.push(`layout → ${layout}`);
    }
    const aspect: AspectRatio | undefined = /1:1|square/.test(p) ? '1:1' : /16:9|landscape|horizontal/.test(p) ? '16:9' : /4:5|portrait/.test(p) ? '4:5' : /9:16|vertical/.test(p) ? '9:16' : undefined;
    if (aspect) {
      e.aspect = aspect;
      result.applied.push(`format → ${aspect}`);
    }
    if (/\b720p?\b/.test(p)) {
      e.resolution = 720;
      result.applied.push('720p');
    }
    if (/\b1080p?\b|full hd/.test(p)) {
      e.resolution = 1080;
      result.applied.push('1080p');
    }
    if (/\b60 ?fps\b/.test(p)) {
      e.fps = 60;
      result.applied.push('60 fps');
    }
    if (/\b30 ?fps\b/.test(p)) {
      e.fps = 30;
      result.applied.push('30 fps');
    }
    const secs = seconds(p);
    const len = current.clip.end - current.clip.start;
    if (/(start|begin).*(later|after)/.test(p)) {
      result.clip.start = Math.min(current.clip.end - 3, current.clip.start + (secs ?? 2));
      result.applied.push('start later');
    } else if (/(start|begin).*(earlier|before|sooner)/.test(p)) {
      result.clip.start = Math.max(0, current.clip.start - (secs ?? 2));
      result.applied.push('start earlier');
    }
    if (/(end|finish|stop).*(earlier|sooner|before)/.test(p)) {
      result.clip.end = Math.max((result.clip.start ?? current.clip.start) + 3, current.clip.end - (secs ?? 2));
      result.applied.push('end earlier');
    } else if (/(end|finish|stop).*(later|after)/.test(p)) {
      result.clip.end = current.clip.end + (secs ?? 2);
      result.applied.push('end later');
    }
    if (/\bshorter\b/.test(p)) {
      result.clip.end = current.clip.start + len * 0.8;
      result.applied.push('shorter');
    }
    if (/\blonger\b/.test(p)) {
      result.clip.end = current.clip.start + len * 1.2;
      result.applied.push('longer');
    }
    if (result.applied.length === before) result.unknown.push(raw);
  }
  return result;
}
