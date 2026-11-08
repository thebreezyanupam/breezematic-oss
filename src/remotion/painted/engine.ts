import * as brush from 'p5.brush/standalone';
import { GROUND_LINE, type Atmosphere, type Ground, type PaintSubject, type Sky } from '../../painted.js';

/**
 * The painter: one scene, painted live with p5.brush at a moment in its beat.
 *
 * Every frame is painted from nothing. Remotion renders frames out of order
 * and in parallel tabs, so there is no "the canvas so far" to add to -- the
 * scene at 1.4 s has to be reproducible on its own. That is affordable because
 * p5.brush is fast (a small watercolour fill is about a millisecond), and it is
 * stable because every element reseeds the brush with its own number before it
 * paints: a wash that is 40% in has exactly the texture it will have at 100%,
 * and a stroke drawn halfway is the first half of the stroke it will become.
 *
 * Order is the order a painter works in: the wet washes first (sky, then the
 * ground), the subject's colour, then ink over the top, then the dry work --
 * hatched shadow and the marks that say wind, rain or water.
 *
 * The brush draws into one shared WebGL canvas per page (the library is a
 * singleton), which is copied into each beat's own 2D canvas straight after
 * brush.render(), inside the same task, while the drawing buffer still holds
 * the frame.
 */

export type Subject = Omit<PaintSubject, 'icon' | 'author' | 'flip' | 'paths'> & { paths: readonly string[]; flip?: boolean };

export type Scene = {
  sky: Sky;
  ground: Ground;
  atmosphere: Atmosphere;
  subjects: readonly Subject[];
  /** Where the light comes from: shadows fall the other way. */
  light: 'left' | 'right';
  /** Sky and ground already painted (the same place as the beat before). */
  settled?: boolean;
  seed: number;
};

export const PAPER = '#f4ecdc';
const INK = '#1f1a17';


const SKY_COLORS: Record<Sky, { top: string; horizon: string; body: string | null }> = {
  dawn: { top: '#c9a3c7', horizon: '#f8c99a', body: '#fbe3a6' },
  day: { top: '#7fb2de', horizon: '#d9ebf2', body: '#ffe08a' },
  dusk: { top: '#5d4c8e', horizon: '#ef9a6a', body: '#f7c46c' },
  night: { top: '#1d2948', horizon: '#3f5584', body: '#f1ead2' },
  storm: { top: '#5c6672', horizon: '#9aa3a8', body: null },
  interior: { top: '#e2cfae', horizon: '#ecdcc0', body: null },
};

/* ---------------------------------------------------------------- canvas */

let canvas: HTMLCanvasElement | null = null;
let size = { w: 0, h: 0 };

function target(w: number, h: number): void {
  if (canvas !== null && size.w === w && size.h === h) return;
  canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  brush.load(canvas);
  brush.angleMode(brush.DEGREES);
  // Brushes are sized for a 600px canvas; scale them to this one.
  brush.scaleBrushes((Math.min(w, h) / 600) * 2.2);
  size = { w, h };
}

/* ---------------------------------------------------------------- helpers */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
/** Progress through a window of the paint time, eased. */
function phase(p: number, from: number, to: number): number {
  const t = clamp01((p - from) / (to - from));
  return t * t * (3 - 2 * t);
}

type Pt = [number, number];

/** Silhouette paths turned into closed loops, sampled once and kept. */
const loops = new Map<string, Pt[][]>();
let sampler: SVGPathElement | null = null;

function loopsOf(d: string): Pt[][] {
  const known = loops.get(d);
  if (known !== undefined) return known;
  if (sampler === null) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    sampler = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(sampler);
    document.body.appendChild(svg);
  }
  sampler.setAttribute('d', d);
  const total = sampler.getTotalLength();
  const step = 3;
  const out: Pt[][] = [];
  let current: Pt[] = [];
  let last: DOMPoint | null = null;
  for (let at = 0; at <= total; at += step) {
    const point = sampler.getPointAtLength(at);
    // A jump far longer than a step is a move to the next sub-path.
    if (last !== null && Math.hypot(point.x - last.x, point.y - last.y) > step * 4) {
      if (current.length > 3) out.push(current);
      current = [];
    }
    current.push([point.x, point.y]);
    last = point;
  }
  if (current.length > 3) out.push(current);
  loops.set(d, out);
  return out;
}

function area(loop: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i]!;
    const [x2, y2] = loop[(i + 1) % loop.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function inside([x, y]: Pt, loop: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i]!;
    const [xj, yj] = loop[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Outer shapes and holes (a hole is a loop inside an odd number of others). */
function split(all: Pt[][]): { outer: Pt[][]; holes: Pt[][] } {
  const outer: Pt[][] = [];
  const holes: Pt[][] = [];
  for (const loop of all) {
    if (area(loop) < 40) continue;
    const depth = all.filter((other) => other !== loop && area(other) > area(loop) && inside(loop[0]!, other)).length;
    (depth % 2 === 0 ? outer : holes).push(loop);
  }
  return { outer, holes };
}

/** Fewer points for the brush: it smooths between them anyway. */
function thin(loop: Pt[], every: number): Pt[] {
  return loop.filter((_, i) => i % every === 0);
}

/* ---------------------------------------------------------------- layers */

function paintSky(scene: Scene, pIn: number, W: number, H: number): void {
  const p = scene.settled ? 1 : pIn;
  const colors = SKY_COLORS[scene.sky];
  const wet = phase(p, 0, 0.3);
  if (wet <= 0) return;
  // Two washes with soft, wandering edges -- a ruled band reads as a flag.
  brush.noStroke();
  const upper = ridge(scene.seed + 5, W, H * 0.46, H * 0.03, 0.8);
  brush.seed(scene.seed + 1);
  brush.fill(colors.top, 165 * wet);
  brush.fillBleed(0.3);
  brush.fillTexture(0.3, 0.2, false);
  brush.polygon([[-W * 0.05, -H * 0.05], [W * 1.05, -H * 0.05], ...[...upper].reverse()]);
  const lower = ridge(scene.seed + 6, W, H * 0.3, H * 0.025, 1.1);
  brush.seed(scene.seed + 2);
  brush.fill(colors.horizon, 150 * wet);
  brush.fillBleed(0.35);
  brush.fillTexture(0.3, 0.2, false);
  brush.polygon([...lower, ...[...ridge(scene.seed + 7, W, H * 0.8, H * 0.02, 0.7)].reverse()]);
  brush.noFill();

  // The sun, the moon, or the lamp: a single wet circle, bled.
  const glow = phase(p, 0.08, 0.36);
  if (colors.body !== null && glow > 0) {
    const r = rng(scene.seed + 3);
    const sx = scene.light === 'left' ? W * (0.18 + r() * 0.12) : W * (0.7 + r() * 0.12);
    brush.seed(scene.seed + 4);
    brush.fill(colors.body, 200 * glow);
    brush.fillBleed(0.25);
    brush.fillTexture(0.2, 0.5);
    brush.circle(sx, H * (0.16 + r() * 0.08), W * 0.09, 0.4);
    brush.noFill();
  }
}

/** A ridge line across the frame from seeded smooth noise. */
function ridge(seed: number, W: number, base: number, amp: number, freq: number): Pt[] {
  const r = rng(seed);
  const phases = [r() * 10, r() * 10, r() * 10];
  const pts: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const x = -W * 0.05 + (i / 24) * W * 1.1;
    const u = i / 24;
    const y =
      base -
      amp * (0.6 * Math.sin(u * freq * 6.28 + phases[0]!) + 0.3 * Math.sin(u * freq * 13 + phases[1]!) + 0.1 * Math.sin(u * 31 + phases[2]!));
    pts.push([x, y]);
  }
  return pts;
}

function band(top: Pt[], W: number, H: number): Pt[] {
  return [...top, [W * 1.05, H * 1.05], [-W * 0.05, H * 1.05]];
}

function wash(points: Pt[], color: string, opacity: number, seed: number, bleed = 0.2): void {
  if (opacity <= 0) return;
  brush.seed(seed);
  brush.noStroke();
  brush.fill(color, opacity);
  brush.fillBleed(bleed);
  brush.fillTexture(0.45, 0.45);
  brush.polygon(points);
  brush.noFill();
}

function paintGround(scene: Scene, pIn: number, W: number, H: number): void {
  const p = scene.settled ? 1 : pIn;
  const g = phase(p, 0.12, 0.42);
  const s = scene.seed;
  switch (scene.ground) {
    case 'hills':
      wash(band(ridge(s + 10, W, H * 0.6, H * 0.05, 1.2), W, H), '#9bb58a', 150 * g, s + 11);
      wash(band(ridge(s + 12, W, H * 0.72, H * 0.06, 0.8), W, H), '#6f9a62', 170 * g, s + 13);
      wash(band(ridge(s + 14, W, H * 0.84, H * 0.03, 0.6), W, H), '#4f7a4a', 180 * g, s + 15);
      break;
    case 'field':
      wash(band(ridge(s + 10, W, H * 0.66, H * 0.015, 0.7), W, H), '#b9c46c', 160 * g, s + 11);
      wash(band(ridge(s + 12, W, H * 0.8, H * 0.02, 0.5), W, H), '#8fa64f', 170 * g, s + 13);
      break;
    case 'desert':
      wash(band(ridge(s + 10, W, H * 0.62, H * 0.06, 0.9), W, H), '#e8c58c', 160 * g, s + 11);
      wash(band(ridge(s + 12, W, H * 0.76, H * 0.05, 0.6), W, H), '#d9a565', 170 * g, s + 13);
      break;
    case 'snow':
      wash(band(ridge(s + 10, W, H * 0.6, H * 0.06, 1.1), W, H), '#dfe8f0', 170 * g, s + 11);
      wash(band(ridge(s + 12, W, H * 0.76, H * 0.04, 0.7), W, H), '#c3d3e2', 160 * g, s + 13);
      break;
    case 'sea': {
      const horizon = H * 0.58;
      wash([[-W * 0.05, horizon], [W * 1.05, horizon], [W * 1.05, H * 1.05], [-W * 0.05, H * 1.05]], '#4f86a8', 160 * g, s + 11, 0.15);
      wash([[-W * 0.05, H * 0.74], [W * 1.05, H * 0.72], [W * 1.05, H * 1.05], [-W * 0.05, H * 1.05]], '#2f5f80', 150 * g, s + 13, 0.25);
      break;
    }
    case 'city': {
      const r = rng(s + 20);
      let x = -W * 0.04;
      let n = 0;
      while (x < W * 1.04) {
        const bw = W * (0.08 + r() * 0.1);
        const bh = H * (0.12 + r() * 0.26);
        const local = phase(p, 0.12 + (n % 7) * 0.02, 0.4 + (n % 7) * 0.02);
        wash([[x, H * 0.7 - bh], [x + bw, H * 0.7 - bh], [x + bw, H * 1.05], [x, H * 1.05]], n % 2 ? '#7f8aa0' : '#5f6b84', 150 * local, s + 30 + n, 0.12);
        x += bw + W * 0.01;
        n++;
      }
      wash([[-W * 0.05, H * 0.7], [W * 1.05, H * 0.7], [W * 1.05, H * 1.05], [-W * 0.05, H * 1.05]], '#8c8277', 150 * g, s + 12);
      break;
    }
    case 'room':
      wash([[-W * 0.05, H * 0.68], [W * 1.05, H * 0.68], [W * 1.05, H * 1.05], [-W * 0.05, H * 1.05]], '#b48a62', 150 * g, s + 11);
      wash([[W * 0.62, H * 0.14], [W * 0.88, H * 0.14], [W * 0.88, H * 0.4], [W * 0.62, H * 0.4]], '#cfe2ec', 170 * g, s + 13, 0.08);
      break;
    case 'none':
      break;
  }
}

function paintSubjects(scene: Scene, p: number, W: number, H: number): void {
  scene.subjects.forEach((subject, index) => {
    const { outer, holes } = split(subject.paths.flatMap(loopsOf));
    if (outer.length === 0) return;
    const scale = (subject.size * W) / 512;
    const ox = subject.x * W;
    // Grounded things stand on the ground: their lowest point goes on the line.
    const lowest = Math.max(...outer.flatMap((loop) => loop.map((q) => q[1])));
    const oy =
      subject.place === 'ground'
        ? GROUND_LINE[scene.ground] * H - (lowest - 256) * scale
        : subject.y * H;
    const place = (loop: Pt[]): Pt[] =>
      loop.map(([x, y]) => [ox + (subject.flip ? 256 - x : x - 256) * scale, oy + (y - 256) * scale]);
    const lag = index * 0.06;

    // The cast shadow, hatched, falling away from the light.
    // Only what stands on something casts a shadow on it.
    const shade = subject.place === 'ground' ? phase(p, 0.52 + lag, 0.8 + lag) : 0;
    if (shade > 0) {
      const dir = scene.light === 'left' ? 1 : -1;
      const sw = subject.size * W * 0.55;
      const sx = ox + dir * sw * 0.3;
      const sy = subject.place === 'ground' ? GROUND_LINE[scene.ground] * H + H * 0.006 : oy + subject.size * W * 0.62;
      const ellipse: Pt[] = Array.from({ length: 28 }, (_, i) => {
        const a = (i / 28) * Math.PI * 2;
        return [sx + Math.cos(a) * sw, sy + Math.sin(a) * sw * 0.14];
      });
      brush.seed(scene.seed + 200 + index);
      // The hatch sweeps in from the light's side rather than appearing.
      const left = Math.min(...ellipse.map((q) => q[0]));
      const right = Math.max(...ellipse.map((q) => q[0]));
      const reach = left + (right - left) * shade;
      brush.clip(dir > 0 ? [left - 4, 0, reach, H] : [right - (right - left) * shade, 0, right + 4, H]);
      brush.noStroke();
      brush.hatchStyle('2B', '#5b4a3f', 0.7);
      brush.hatch(W * 0.008, 35, { rand: 0.25, continuous: true });
      brush.polygon(ellipse);
      brush.noHatch();
      brush.noClip();
    }

    // Colour first, wet, then the paper showing through where the drawing is open.
    const fillIn = phase(p, 0.24 + lag, 0.52 + lag);
    outer.forEach((loop, i) => {
      // Two coats: a full one, and a darker glaze off the lit side for form.
      wash(place(thin(loop, 2)), subject.color, 235 * fillIn, scene.seed + 100 + index * 17 + i, 0.08);
    });
    const glaze = phase(p, 0.4 + lag, 0.62 + lag);
    if (glaze > 0) {
      const dir = scene.light === 'left' ? 1 : -1;
      outer.forEach((loop, i) => {
        const pts = place(thin(loop, 2));
        const cx = pts.reduce((sum, q) => sum + q[0], 0) / pts.length;
        const side = pts.filter((q) => (q[0] - cx) * dir > 0);
        if (side.length < 4) return;
        wash([...side, [cx, side[side.length - 1]![1]], [cx, side[0]![1]]], INK, 38 * glaze, scene.seed + 160 + index * 17 + i, 0.3);
      });
    }
    if (fillIn > 0) {
      holes.forEach((loop, i) => {
        brush.seed(scene.seed + 150 + index * 17 + i);
        brush.noStroke();
        brush.wash(PAPER, 235 * fillIn);
        brush.polygon(place(thin(loop, 2)));
        brush.noWash();
      });
    }

    // Ink over the top, drawn: each loop's line runs out to where the pen is.
    const ink = phase(p, 0.34 + lag, 0.78 + lag);
    if (ink > 0) {
      const all = [...outer, ...holes];
      all.forEach((loop, i) => {
        const pts = place(thin(loop, 3));
        const shown = Math.floor(pts.length * clamp01(ink * 1.15 - (i / all.length) * 0.15));
        if (shown < 3) return;
        brush.seed(scene.seed + 300 + index * 31 + i);
        brush.set(i < outer.length ? 'pen' : 'rotring', INK, i < outer.length ? 2.4 : 1.4);
        brush.noFill();
        brush.spline(pts.slice(0, shown), 0.4);
      });
    }
  });
}

function paintAtmosphere(scene: Scene, p: number, W: number, H: number): void {
  const a = phase(p, 0.55, 0.95);
  if (a <= 0 || scene.atmosphere === 'none') return;
  const r = rng(scene.seed + 500);
  const count = (n: number): number => Math.floor(n * a);
  switch (scene.atmosphere) {
    case 'wind':
      brush.field('curved');
      brush.set('HB', '#6d7f8c', 0.8);
      for (let i = 0; i < count(9); i++) {
        brush.seed(scene.seed + 510 + i);
        brush.flowLine(W * r() * 0.8, H * (0.08 + r() * 0.4), W * (0.2 + r() * 0.25), 0);
      }
      brush.noField();
      break;
    case 'waves':
      brush.field('waves');
      brush.set('2B', '#e9f2f6', 1);
      for (let i = 0; i < count(14); i++) {
        brush.seed(scene.seed + 510 + i);
        brush.flowLine(W * r() * 0.85, H * (0.62 + r() * 0.34), W * (0.12 + r() * 0.2), 0);
      }
      brush.noField();
      break;
    case 'rain':
      brush.set('HB', '#5d6f80', 0.7);
      for (let i = 0; i < count(46); i++) {
        brush.seed(scene.seed + 510 + i);
        const x = W * r();
        const y = H * r() * 0.8;
        brush.line(x, y, x - W * 0.025, y + H * 0.05);
      }
      break;
    case 'snow':
    case 'stars':
      brush.noStroke();
      for (let i = 0; i < count(scene.atmosphere === 'snow' ? 40 : 30); i++) {
        brush.seed(scene.seed + 510 + i);
        brush.fill(scene.atmosphere === 'snow' ? '#ffffff' : '#fff6d6', 220);
        brush.fillBleed(0.05);
        brush.circle(W * r(), H * r() * (scene.atmosphere === 'snow' ? 0.95 : 0.5), W * (0.004 + r() * 0.006), 0.3);
      }
      brush.noFill();
      break;
  }
}

/**
 * Paints the scene at progress p (0..1 through its painting) into `out`.
 * Returns nothing; the 2D canvas holds the frame.
 */
export function paint(out: HTMLCanvasElement, scene: Scene, p: number): void {
  const W = out.width;
  const H = out.height;
  target(W, H);
  brush.seed(scene.seed);
  brush.noiseSeed(scene.seed);
  brush.clear(PAPER);
  brush.push();
  brush.translate(-W / 2, -H / 2);
  paintSky(scene, p, W, H);
  paintGround(scene, p, W, H);
  paintSubjects(scene, p, W, H);
  paintAtmosphere(scene, p, W, H);
  brush.pop();
  brush.render();
  const ctx = out.getContext('2d');
  if (ctx !== null && canvas !== null) {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(canvas, 0, 0);
  }
}
