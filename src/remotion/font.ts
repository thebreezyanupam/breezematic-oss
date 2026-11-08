import { useEffect, useState } from 'react';
import { continueRender, delayRender } from 'remotion';
import interVariable from './fonts/inter-latin-wght-normal.woff2';
import caveatRegular from './fonts/caveat-latin-400-normal.woff2';
import caveatBold from './fonts/caveat-latin-700-normal.woff2';
import devanagariRegular from './fonts/noto-sans-devanagari-devanagari-400-normal.woff2';
import devanagariBold from './fonts/noto-sans-devanagari-devanagari-700-normal.woff2';
import serifRegular from './fonts/source-serif-4-latin-400-normal.woff2';
import serifBold from './fonts/source-serif-4-latin-700-normal.woff2';
import monoRegular from './fonts/ibm-plex-mono-latin-400-normal.woff2';
import monoMedium from './fonts/ibm-plex-mono-latin-500-normal.woff2';

export const FONT_FAMILY = 'InterVariable';
/** The whiteboard mode writes in this. SIL Open Font License. */
export const HAND_FONT_FAMILY = 'Caveat';
/**
 * Devanagari, because Inter has none of it.
 *
 * Not a fallback in the CSS sense — it is named directly for a Hindi video and
 * never reached for otherwise. A missing-glyph fallback would be worse than
 * useless here: the type is measured to fit the frame, and measuring tofu boxes
 * would lay out every beat wrong and then draw it wrong on top. SIL Open Font
 * License, same as Caveat.
 */
export const DEVANAGARI_FONT_FAMILY = 'NotoSansDevanagari';

/**
 * The books channel's face, and the only one it uses.
 *
 * A serif because the subject is books and a geometric sans says software. Two
 * weights and no more: emphasis is carried by colour, scale and motion, which
 * cost nothing, rather than by a third weight nobody can tell from the regular
 * at 1080p. SIL Open Font License, like the others here.
 */
export const SERIF_FONT_FAMILY = 'SourceSerif';

/**
 * The cinematic title card's face: a modern typewriter.
 *
 * Monospaced so the title can be typed into place -- every character has the
 * same width, so a letter arriving never nudges the ones before it. IBM Plex
 * Mono rather than a distressed typewriter face, because the look is a film
 * trailer, not a ransom note. SIL Open Font License.
 */
export const MONO_FONT_FAMILY = 'PlexMono';

/** Which face draws a video's words, by the language it was written in. */
export function familyForLanguage(font: 'latin' | 'devanagari'): string {
  return font === 'devanagari' ? DEVANAGARI_FONT_FAMILY : FONT_FAMILY;
}

// Declared in CSS with the bytes inlined, so the face exists the moment the
// bundle is evaluated and no request ever leaves the page.
const style = document.createElement('style');
style.textContent = [
  '@font-face {',
  `  font-family: '${FONT_FAMILY}';`,
  `  src: url(${interVariable}) format('woff2-variations');`,
  '  font-weight: 100 900;',
  '  font-style: normal;',
  '  font-display: block;',
  '}',
  '@font-face {',
  `  font-family: '${HAND_FONT_FAMILY}';`,
  `  src: url(${caveatRegular}) format('woff2');`,
  '  font-weight: 400;',
  '  font-style: normal;',
  '  font-display: block;',
  '}',
  '@font-face {',
  `  font-family: '${HAND_FONT_FAMILY}';`,
  `  src: url(${caveatBold}) format('woff2');`,
  '  font-weight: 700;',
  '  font-style: normal;',
  '  font-display: block;',
  '}',
  '@font-face {',
  `  font-family: '${DEVANAGARI_FONT_FAMILY}';`,
  `  src: url(${devanagariRegular}) format('woff2');`,
  '  font-weight: 400;',
  '  font-style: normal;',
  '  font-display: block;',
  '}',
  '@font-face {',
  `  font-family: '${DEVANAGARI_FONT_FAMILY}';`,
  `  src: url(${devanagariBold}) format('woff2');`,
  '  font-weight: 700;',
  '  font-style: normal;',
  '  font-display: block;',
  '}',
  '@font-face {',
  `  font-family: '${SERIF_FONT_FAMILY}';`,
  `  src: url(${serifRegular}) format('woff2');`,
  '  font-weight: 400;',
  '  font-style: normal;',
  '  font-display: block;',
  '}',
  '@font-face {',
  `  font-family: '${SERIF_FONT_FAMILY}';`,
  `  src: url(${serifBold}) format('woff2');`,
  '  font-weight: 700;',
  '  font-style: normal;',
  '  font-display: block;',
  '}',
  '@font-face {',
  `  font-family: '${MONO_FONT_FAMILY}';`,
  `  src: url(${monoRegular}) format('woff2');`,
  '  font-weight: 400;',
  '  font-style: normal;',
  '  font-display: block;',
  '}',
  '@font-face {',
  `  font-family: '${MONO_FONT_FAMILY}';`,
  `  src: url(${monoMedium}) format('woff2');`,
  '  font-weight: 500;',
  '  font-style: normal;',
  '  font-display: block;',
  '}',
].join('\n');
document.head.appendChild(style);

/**
 * The gate has to live in a component, not at module scope. Remotion keeps a
 * pool of pages and every one of them evaluates this bundle, but a page the
 * pool never hands a frame to also never runs anything past module init — a
 * delayRender() registered up there is left uncleared and eventually times the
 * whole render out. Mounting the wait means only pages that actually draw a
 * frame ever open a handle.
 */
export function useInterFont(): boolean {
  const [handle] = useState(() => delayRender('loading fonts'));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Both faces, because a whiteboard sheet measures its lines in Caveat and
    // measuring against fallback metrics sizes every beat wrong.
    Promise.all([
      document.fonts.load(`700 100px '${FONT_FAMILY}'`),
      document.fonts.load(`400 100px '${HAND_FONT_FAMILY}'`),
      document.fonts.load(`700 100px '${HAND_FONT_FAMILY}'`),
      // Loaded unconditionally rather than per video: the gate is what holds
      // the first frame back until type can be measured truly, and a face that
      // arrives after that gate opens is a face the layout never saw.
      document.fonts.load(`400 100px '${DEVANAGARI_FONT_FAMILY}'`),
      document.fonts.load(`700 100px '${DEVANAGARI_FONT_FAMILY}'`),
      document.fonts.load(`400 100px '${SERIF_FONT_FAMILY}'`),
      document.fonts.load(`700 100px '${SERIF_FONT_FAMILY}'`),
      document.fonts.load(`400 100px '${MONO_FONT_FAMILY}'`),
      document.fonts.load(`500 100px '${MONO_FONT_FAMILY}'`),
    ])
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cleared only once a render with the real font has committed. Type is
  // measured to fit the frame, and measuring against fallback metrics would
  // size every beat wrong.
  useEffect(() => {
    if (ready) continueRender(handle);
  }, [ready, handle]);

  return ready;
}
