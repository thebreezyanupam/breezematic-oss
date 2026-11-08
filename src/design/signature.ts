/**
 * The channel's fixed identity. One source, read by everything.
 *
 * The rule this file exists to enforce is that the system never varies. Not
 * "rarely varies" -- never. A viewer should recognise one of these videos with
 * the sound off and the title cropped, and that only happens if the palette,
 * the type and the structural device are the same in the fortieth video as in
 * the first. Anything that wants to be different per video takes its variation
 * from `VARIATION` below, which moves composition, emphasis and direction
 * *within* the system rather than changing it.
 *
 * So: no stage constructs a colour. No stage picks a font. They ask here.
 */

/* ------------------------------------------------------------------ palette */

/**
 * Five colours, derived from ink on paper, and locked.
 *
 * Paper is warm rather than white because a true white ground reads as a slide
 * deck; ink is blue-black rather than black because carbon black on a lit
 * screen looks like a hole. The three that follow are the only accents that
 * ever appear, each with one job — and having exactly one job is what stops
 * them drifting into decoration.
 */
/**
 * What every picture in a book essay is made of.
 *
 * Here rather than in either of the two stages that need it, because the
 * backgrounds and the cuttings pasted over them have to be the same kind of
 * object. They were not: the backgrounds became inked comic art and the
 * cuttings were still being asked for as photographs, so a photoreal face
 * would have been stuck onto a hand-drawn frame four times a video. Nothing
 * about that reads as a cutting -- it reads as two videos.
 *
 * It is a locked signature, like the palette below it, and for the same
 * reason: the channel is recognisable or it is nothing.
 */
export const ILLUSTRATION_MEDIUM =
  'a dark, high-contrast inked comic-book illustration, drawn by hand in pen and ink ' +
  'with heavy black shadows, visible cross-hatching and rough inked linework, flat ' +
  'blocks of colour, and a restrained palette of deep near-black browns with ' +
  'burnt-orange and ochre highlights';

/**
 * What the pictures are made of in the cinematic look.
 *
 * Film stills rather than drawings, because the rest of the look -- the bars,
 * the grain, the teal-and-amber grade, the snap cuts -- is film grammar, and an
 * inked comic panel graded like a film reads as a comic with a filter on it.
 * The grade in the renderer does the final colour; this asks for pictures that
 * already want it: low-key light, shallow focus, anamorphic width.
 */
export const CINEMATIC_MEDIUM =
  'a cinematic film still, shot on anamorphic 35mm film, low-key dramatic lighting with ' +
  'deep shadows and warm practical light sources, shallow depth of field, rich contrast, ' +
  'muted teal and amber colour, subtle film grain, composed like a frame from a prestige drama';

/** The medium a look draws its pictures in. */
export function mediumFor(look: 'cinematic' | 'storybook'): string {
  return look === 'cinematic' ? CINEMATIC_MEDIUM : ILLUSTRATION_MEDIUM;
}

/**
 * What the pictures are made of, chosen separately from the look.
 *
 * The look is the edit -- bars, grade, grain, cuts, captions -- and it was
 * welded to one medium each: film stills for cinematic, inked comics for
 * storybook. They are independent. A cinematic edit over anime frames or old
 * master paintings is its own thing, and a channel wants to pick it.
 *
 * Each style's `not` clause matters as much as its medium: the image models
 * pull hard toward a glossy photoreal render, and a style that does not rule
 * it out comes back as one about a third of the time.
 */
export type PictureStyle =
  | 'film'
  | 'ink'
  | 'inkbw'
  | 'comic'
  | 'manga'
  | 'terracotta'
  | 'anime'
  | 'renaissance'
  | 'watercolor'
  | 'acrylic'
  | 'abstract';

export const PICTURE_STYLES: Record<PictureStyle, { label: string; medium: string; not: string }> = {
  film: {
    label: 'Film still',
    medium: CINEMATIC_MEDIUM,
    not: 'Not a drawing, not a painting, not a cartoon, not a 3D render',
  },
  ink: {
    label: 'Inked comic',
    medium: ILLUSTRATION_MEDIUM,
    not: 'Not a photograph. Not a 3D render. Not a glossy digital painting',
  },
  inkbw: {
    label: 'Ink, no colour',
    medium:
      'a black and white pen and ink illustration: confident brush and nib linework, dense ' +
      'cross-hatching and stippling for shadow, grey ink wash for the mid-tones, the white of ' +
      'the paper left for the light, no colour anywhere',
    not: 'Not a photograph. Not a 3D render. No colour, no tint, no sepia — black, white and grey only',
  },
  comic: {
    label: 'Comic book',
    medium:
      'a page from a printed comic book: heavy black inked outlines, dramatic low angles, ' +
      'flat bold primary colour laid inside the lines, visible halftone dot shading, deep ' +
      'solid black shadow shapes, slight off-register printing on cheap paper',
    not: 'Not a photograph. Not a 3D render. No panel borders, no speech bubbles, no lettering',
  },
  manga: {
    label: 'Manga',
    medium:
      'a black and white manga panel: clean confident linework of varying weight, screentone ' +
      'dots and gradients for the greys, dramatic speed lines and deep blacks, expressive ' +
      'faces, fine hatching for shadow, no colour at all',
    not: 'Not a photograph. Not a 3D render. No colour, no panel borders, no speech bubbles, no lettering',
  },
  terracotta: {
    label: 'Ink & terracotta',
    medium:
      'a hand-drawn editorial ink illustration: bold, expressive black ink linework with ' +
      'loose cross-hatching and dry-brush texture, skin and light rendered in flat burnt ' +
      'terracotta orange, highlights in warm cream, deep shadows in solid black, set against ' +
      'a dark oxblood-maroon ground with rough painted texture; a strictly limited palette of ' +
      'terracotta, cream, black and deep maroon, like a colourised etching',
    not: 'Not a photograph. Not a 3D render. Not a glossy digital painting. No other colours',
  },
  anime: {
    label: 'Anime',
    medium:
      'a frame from a hand-drawn 2D Japanese animated feature film: clean confident ' +
      'linework, cel-shaded characters with soft two-tone shading, lush hand-painted ' +
      'backgrounds, atmospheric light and colour, cinematic widescreen composition',
    not: 'Not a photograph. Not a 3D render. Not chibi, not a manga page, no speech bubbles',
  },
  renaissance: {
    label: 'Renaissance oil',
    medium:
      'an oil painting by an Italian or Flemish Renaissance old master: dramatic ' +
      'chiaroscuro, rich glazed pigments, soft sfumato modelling of faces, classical ' +
      'composition, visible varnish and fine craquelure on the canvas',
    not: 'Not a photograph. Not a 3D render. Not a modern digital painting',
  },
  watercolor: {
    label: 'Watercolour',
    medium:
      'a loose watercolour painting on textured cold-press paper: soft wet-in-wet washes, ' +
      'pigment blooms and granulation, colour pooling at the edges, a fine pencil ' +
      'underdrawing showing through, areas of bare white paper, a muted restrained palette',
    not: 'Not a photograph. Not a 3D render. Not a digital painting',
  },
  acrylic: {
    label: 'Acrylic',
    medium:
      'an expressive acrylic painting on canvas: thick visible brushstrokes and ' +
      'palette-knife texture, bold saturated blocks of colour, strong directional light ' +
      'and shadow, the canvas weave visible in thin passages',
    not: 'Not a photograph. Not a 3D render. Not a smooth digital painting',
  },
  abstract: {
    label: 'Abstract',
    medium:
      'an abstract expressionist painting: the scene and its figures suggested through bold ' +
      'gestural shapes, fractured geometric planes, drips and layered textured paint in a ' +
      'dramatic limited palette -- stylised, but the people and objects still readable',
    not: 'Not a photograph. Not a 3D render. Not a realistic painting',
  },
};

export function isPictureStyle(value: unknown): value is PictureStyle {
  return typeof value === 'string' && Object.hasOwn(PICTURE_STYLES, value);
}

/** What each look draws in when nobody chooses. */
export function defaultStyleFor(look: 'cinematic' | 'storybook' | 'stickman'): PictureStyle {
  return look === 'cinematic' ? 'film' : 'ink';
}

/**
 * Which folder of character drawings a style uses.
 *
 * A reference drawing is also a style reference -- an anime Gregor pulls a
 * watercolour panel of him back toward anime -- so every style keeps its own
 * cast. The two original styles keep the folder names they already had, so
 * nobody's saved characters are orphaned.
 */
export function memoryVariantFor(style: PictureStyle): string {
  return style === 'ink' ? '' : style === 'film' ? 'cinematic' : style;
}

export const PALETTE = {
  /** The ground. Almost everything sits on this. */
  paper: '#efe9dd',
  /** Type, rules, and anything that behaves like writing. */
  ink: '#14161c',
  /** Aged edge. Secondary type, dividers, anything receding. */
  foxed: '#8a7f6d',
  /** The argument. The thesis, the turn, the line being contested. */
  oxblood: '#7d2231',
  /** The evidence. Quotation, citation, what is demonstrably on the page. */
  indigo: '#2b3a67',
} as const;

export type PaletteName = keyof typeof PALETTE;

/**
 * Which colour carries which idea. Read this rather than naming a colour.
 *
 * The indirection is the point: `ROLE.thesis` can never be "whatever looked
 * good in this video", and a reviewer comparing two uploads sees the same
 * language used the same way, which is what a signature is.
 */
export const ROLE = {
  ground: 'paper',
  body: 'ink',
  secondary: 'foxed',
  thesis: 'oxblood',
  evidence: 'indigo',
} as const satisfies Record<string, PaletteName>;

/* --------------------------------------------------------------------- type */

/**
 * One family, two weights. No third weight, no second family.
 *
 * A serif, because the channel is about books and a geometric sans says
 * software. Source Serif is the bundled face; the two weights are the whole
 * range — emphasis is carried by colour, scale and motion, which are free,
 * rather than by a semibold nobody can tell from the regular at 1080p.
 */
export const TYPE = {
  family: 'SourceSerif',
  /** Body, and everything that is not being emphasised. */
  regular: 400,
  /** Emphasis. There is no weight between these two and there will not be. */
  bold: 700,
} as const;

/* ----------------------------------------------------------- the device */

/**
 * The recurring structural device: the same visual marks the same
 * argumentative beat in every video, forever.
 *
 * This is the half of the signature that a palette cannot carry. A viewer
 * learns, without being told, that type cut *into* the ground means the essay
 * is stating what it believes, and that type lifted *off* the ground means it
 * is handling somebody else's words. By the third video that is a grammar, and
 * a grammar is very hard to fake and very easy to recognise.
 */
export const DEVICE = {
  /** The thesis, and every restatement of it. Carved: an inset shadow, no fill. */
  thesis: 'carve',
  /** What the essay argues against. Set in foxed and struck through as it leaves. */
  counter: 'strike',
  /** Quotation and citation. Raised off the plane, casting a soft drop. */
  evidence: 'lift',
  /** The pivot. The ground itself inverts for the length of the line. */
  turn: 'invert',
  /** Ordinary narration. No device; type simply arrives. */
  plain: 'none',
} as const;

export type DeviceName = (typeof DEVICE)[keyof typeof DEVICE];

/* ---------------------------------------------------------------- the sound */

/**
 * One motif, on every thesis statement, in every video, forever.
 *
 * Half the brand, per the brief, and the cheapest half to get right — it costs
 * one sample and a rule about when it fires. The rule is narrow on purpose: if
 * it marks thesis statements *and* section openings *and* anything else that
 * felt important, it stops meaning anything within one video, let alone forty.
 */
export const MOTIF = {
  /** The file under assets/sfx. One sample, never varied, never randomised. */
  sample: 'signature',
  /** Fires only on a thesis beat. Nothing else may use it. */
  firesOn: 'thesis',
  /** Under the voice, like everything else. */
  gainDb: -16,
} as const;

/**
 * How far under the narration everything else sits.
 *
 * The brief says twelve, and twelve is right for a channel whose product is an
 * argument: the moment a viewer has to work to hear a word, the essay has
 * failed regardless of how good the edit looked.
 */
export const DUCK_DB = -12;

/* ----------------------------------------------------------- the variation */

/**
 * The three axes a video may differ along, and the only three.
 *
 * Seeded from the book, so the same book always looks the same and two books
 * never do. Everything here changes where things are and which way they move;
 * nothing here changes what the colours mean or what the device does.
 */
export const VARIATION = {
  /** Where the type block sits. */
  composition: ['left-low', 'left-high', 'centre', 'right-low', 'right-high'] as const,
  /**
   * Which accent leads this video. Both accents always exist and always mean
   * what they mean; this decides which one the compositions lean on.
   */
  emphasis: ['oxblood', 'indigo'] as const,
  /** Which way the slow motion travels. */
  direction: ['in', 'out', 'left', 'right', 'up'] as const,
} as const;

export type Variation = {
  composition: (typeof VARIATION.composition)[number];
  emphasis: (typeof VARIATION.emphasis)[number];
  direction: (typeof VARIATION.direction)[number];
};

/**
 * The look for one video, fixed by its seed.
 *
 * Deterministic rather than random: re-rendering a video must not restyle it,
 * and a book re-cut months later should come back the same. The three axes are
 * drawn off different multiples of the seed so they do not move together --
 * drawn off the same one, every left-low video would also drift left, which is
 * a pattern a viewer notices and a reviewer notices faster.
 */
export function variationFor(seed: number): Variation {
  const pick = <T>(list: readonly T[], salt: number): T =>
    list[Math.abs(Math.round(seed / salt)) % list.length] as T;

  return {
    composition: pick(VARIATION.composition, 1),
    emphasis: pick(VARIATION.emphasis, 7919),
    direction: pick(VARIATION.direction, 104_729),
  };
}
