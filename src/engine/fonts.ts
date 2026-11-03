// Caption fonts (SIL Open Font License) bundled via Fontsource so rendering works offline and in the extension.
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/900.css';
import '@fontsource/luckiest-guy/400.css';
import '@fontsource/poppins/800.css';
import '@fontsource/archivo-black/400.css';
import '@fontsource/bebas-neue/400.css';
import '@fontsource/anton/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/permanent-marker/400.css';
import '@fontsource/bangers/400.css';
import { CAPTION_STYLES } from '../core/captions';

let loaded: Promise<void> | null = null;

/** Ensures every caption/overlay font is ready before drawing on canvas (canvas text does not wait for fonts). */
export function ensureFontsLoaded(): Promise<void> {
  if (!loaded) {
    const specs = new Set<string>(['800 40px Inter', '700 40px Inter', '900 40px Montserrat', '700 40px Montserrat']);
    for (const s of CAPTION_STYLES) specs.add(`${s.weight} 40px "${s.font}"`);
    loaded = Promise.all([...specs].map((spec) => document.fonts.load(spec, 'ABC abc 123 ✓').catch(() => []))).then(() => undefined);
  }
  return loaded;
}
