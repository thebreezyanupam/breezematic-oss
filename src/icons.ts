import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Line drawings for the whiteboard mode, taken from Lucide (ISC).
 *
 * They are picked for one property: every icon is `fill="none"` with stroked
 * geometry, so each shape is the skeleton of the drawing rather than the
 * outline of a filled one. That is what makes them draw. Dash-offsetting a
 * normal filled glyph or logo traces its outline — a pen going around the edge
 * of a letter — which is the thing that makes naive attempts at this look
 * wrong. There is nothing to unpick here: the stroke is already the stroke.
 *
 * Everything is flattened to path data at pick time so the beat sheet carries
 * one kind of thing, and the renderer needs no icon library of its own.
 */

const require_ = createRequire(import.meta.url);

function iconDir(): string {
  // Resolved rather than joined onto node_modules, so a hoisted or linked
  // install finds it too.
  const entry = require_.resolve('lucide-static/package.json');
  return path.join(path.dirname(entry), 'icons');
}

const VIEW_BOX = 24;

function attr(source: string, name: string): number {
  const match = new RegExp(`${name}="(-?[0-9.]+)"`).exec(source);
  return match === null ? 0 : Number.parseFloat(match[1] ?? '0');
}

function points(source: string): string[] {
  const match = /points="([^"]+)"/.exec(source);
  if (match === null) return [];
  return (match[1] ?? '').trim().split(/[\s,]+/);
}

/** A closed round shape as two half arcs, which is also how it draws. */
function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return (
    `M ${cx - rx} ${cy} ` +
    `a ${rx} ${ry} 0 1 0 ${rx * 2} 0 ` +
    `a ${rx} ${ry} 0 1 0 ${-rx * 2} 0`
  );
}

function rectPath(x: number, y: number, w: number, h: number, r: number): string {
  if (r <= 0) return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
  const radius = Math.min(r, w / 2, h / 2);
  return (
    `M ${x + radius} ${y} H ${x + w - radius} A ${radius} ${radius} 0 0 1 ${x + w} ${y + radius} ` +
    `V ${y + h - radius} A ${radius} ${radius} 0 0 1 ${x + w - radius} ${y + h} ` +
    `H ${x + radius} A ${radius} ${radius} 0 0 1 ${x} ${y + h - radius} ` +
    `V ${y + radius} A ${radius} ${radius} 0 0 1 ${x + radius} ${y} Z`
  );
}

/** Every drawable in one icon, in the order the file lists them. */
function pathsOf(svg: string): string[] {
  const out: string[] = [];
  for (const [tag] of svg.matchAll(/<(path|circle|rect|line|ellipse|polyline|polygon)\b[^>]*>/g)) {
    if (tag.startsWith('<path')) {
      const d = /\sd="([^"]+)"/.exec(tag);
      if (d !== null) out.push((d[1] ?? '').replace(/\s+/g, ' ').trim());
      continue;
    }
    if (tag.startsWith('<circle')) {
      const r = attr(tag, 'r');
      out.push(ellipsePath(attr(tag, 'cx'), attr(tag, 'cy'), r, r));
      continue;
    }
    if (tag.startsWith('<ellipse')) {
      out.push(ellipsePath(attr(tag, 'cx'), attr(tag, 'cy'), attr(tag, 'rx'), attr(tag, 'ry')));
      continue;
    }
    if (tag.startsWith('<rect')) {
      const radius = /rx="/.test(tag) ? attr(tag, 'rx') : 0;
      out.push(rectPath(attr(tag, 'x'), attr(tag, 'y'), attr(tag, 'width'), attr(tag, 'height'), radius));
      continue;
    }
    if (tag.startsWith('<line')) {
      out.push(`M ${attr(tag, 'x1')} ${attr(tag, 'y1')} L ${attr(tag, 'x2')} ${attr(tag, 'y2')}`);
      continue;
    }
    const pts = points(tag);
    if (pts.length >= 4) {
      const pairs: string[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) pairs.push(`${pts[i]} ${pts[i + 1]}`);
      const [first, ...rest] = pairs;
      out.push(`M ${first} ${rest.map((p) => `L ${p}`).join(' ')}${tag.startsWith('<polygon') ? ' Z' : ''}`);
    }
  }
  return out;
}

export type Illustration = {
  /** The Lucide icon name, kept so a sheet says what it drew. */
  name: string;
  /** Stroke geometry in a 24x24 box, in draw order. */
  paths: string[];
};

let index: Map<string, string[]> | undefined;

/** Icon name -> its own name split into words, for matching. */
function nameIndex(): Map<string, string[]> {
  if (index !== undefined) return index;
  index = new Map();
  for (const file of fs.readdirSync(iconDir())) {
    if (!file.endsWith('.svg')) continue;
    const name = file.slice(0, -4);
    index.set(name, name.split('-'));
  }
  return index;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'why', 'how', 'what', 'when', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
  'you', 'your', 'we', 'our', 'they', 'their', 'it', 'its', 'this', 'that',
  'has', 'have', 'had', 'been', 'be', 'not', 'no', 'so', 'then', 'than', 'from',
  'about', 'into', 'over', 'under', 'his', 'her', 'him', 'she', 'he', 'them',
  'still', 'even', 'never', 'ever', 'more', 'most', 'just', 'only', 'all',
]);

function words(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const word = raw.replace(/(ing|ed|s)$/, '');
    if (word.length < 3 || STOPWORDS.has(raw) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/**
 * Narration does not say "book-open". It says buried, vanished, decades. Icon
 * names are literal and the words that carry a beat are not, so matching on
 * names alone found a drawing for two lines in seven and matched "words" to
 * "whole-word" on a third.
 *
 * This is the bridge: the ideas short scripts actually turn on, pointed at a
 * drawing that reads as them. Curated rather than inferred, because the
 * alternative is asking a model per beat, and a drawing that changes between
 * two runs of the same seed would break the one promise the pipeline makes.
 */
const CONCEPTS: Record<string, string> = {
  // time
  year: 'calendar', years: 'calendar', decade: 'hourglass', decades: 'hourglass',
  century: 'hourglass', centuries: 'hourglass', ancient: 'hourglass', old: 'hourglass',
  time: 'clock', hour: 'clock', minute: 'clock', today: 'calendar', history: 'scroll',
  // death and burial
  death: 'skull', dead: 'skull', died: 'skull', kill: 'skull', killed: 'skull',
  grave: 'shovel', buried: 'shovel', bury: 'shovel', burial: 'shovel', tomb: 'landmark',
  // conflict
  war: 'swords', battle: 'swords', army: 'swords', soldier: 'swords', fight: 'swords',
  conquer: 'crown', conquered: 'crown', empire: 'crown', king: 'crown', queen: 'crown',
  ruler: 'crown', throne: 'crown', weapon: 'sword',
  // discovery
  found: 'search', find: 'search', search: 'search', discover: 'telescope',
  secret: 'lock', hidden: 'eye-off', mystery: 'circle-question-mark', unknown: 'circle-question-mark',
  truth: 'badge-check', proof: 'badge-check', evidence: 'file-search',
  // place and travel
  world: 'globe', earth: 'globe', country: 'map', map: 'map', place: 'map-pin',
  mountain: 'mountain', river: 'waves', sea: 'waves', ocean: 'waves', desert: 'sun',
  road: 'route', journey: 'route', travel: 'plane', city: 'building-2',
  // science and knowledge
  science: 'flask-conical', research: 'microscope', study: 'book-open',
  data: 'chart-column', number: 'hash', numbers: 'hash', percent: 'percent',
  brain: 'brain', idea: 'lightbulb', think: 'brain', learn: 'graduation-cap',
  // money
  money: 'banknote', cost: 'banknote', price: 'tag', rich: 'gem', gold: 'gem',
  treasure: 'gem', buy: 'shopping-cart', sell: 'tag', pay: 'credit-card',
  // people
  people: 'users', person: 'user', crowd: 'users', family: 'users',
  // tech
  computer: 'monitor', phone: 'smartphone', internet: 'wifi', code: 'code',
  camera: 'camera', video: 'video', photo: 'image', music: 'music', sound: 'volume-2',
  // nature
  fire: 'flame', water: 'droplet', ice: 'snowflake', snow: 'snowflake',
  tree: 'trees', forest: 'trees', animal: 'paw-print', bird: 'bird', star: 'star',
  moon: 'moon', sun: 'sun', night: 'moon', storm: 'cloud-lightning',
  // abstract
  danger: 'triangle-alert', warning: 'triangle-alert', problem: 'triangle-alert',
  question: 'circle-question-mark', answer: 'message-circle', story: 'book-open',
  build: 'hammer', built: 'hammer', make: 'hammer', broken: 'unlink',
  fast: 'zap', power: 'zap', energy: 'zap', heart: 'heart', love: 'heart',
  eat: 'utensils', food: 'utensils', sleep: 'bed', work: 'briefcase',
};

/**
 * The best drawing for a line, or null when nothing fits well enough. A wrong
 * drawing is worse than none — a beat about a burial that draws a shopping cart
 * reads as a bug, where a beat with no drawing is just writing, which is this
 * mode's resting state anyway.
 */
export function pickIllustration(text: string, taken: ReadonlySet<string>): Illustration | null {
  const wanted = words(text);
  if (wanted.length === 0) return null;

  const names = nameIndex();
  const raw = text.toLowerCase().split(/[^a-z0-9]+/);

  // Concepts first, in the order the line says them, so the drawing follows
  // what the sentence is about rather than what it happens to end on.
  for (const word of raw) {
    const mapped = CONCEPTS[word];
    if (mapped !== undefined && !taken.has(mapped) && names.has(mapped)) {
      return read(mapped);
    }
  }

  // Then a literal name, but only a whole single-word one. Anything looser
  // matched "words" to "whole-word".
  for (const word of wanted) {
    if (!taken.has(word) && names.get(word)?.length === 1) return read(word);
  }

  return null;
}

function read(name: string): Illustration | null {
  const svg = fs.readFileSync(path.join(iconDir(), `${name}.svg`), 'utf8');
  const paths = pathsOf(svg);
  return paths.length === 0 ? null : { name, paths };
}

/** Every icon the concept map points at, so a typo cannot fail silently. */
export function missingConcepts(): string[] {
  const names = nameIndex();
  return [...new Set(Object.values(CONCEPTS))].filter((name) => !names.has(name)).sort();
}

export const ICON_VIEW_BOX = VIEW_BOX;

/** One named icon's stroke geometry, or null when Lucide has no icon by that name. */
export function iconPaths(name: string): string[] | null {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const file = path.join(iconDir(), `${name}.svg`);
  if (!fs.existsSync(file)) return null;
  const paths = pathsOf(fs.readFileSync(file, 'utf8'));
  return paths.length === 0 ? null : paths.slice(0, 16);
}
