import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../config.js';
import { log } from '../log.js';
import { BEHIND_BAND } from '../stages/compose.js';

/**
 * Two small vision models, run locally on the CPU through transformers.js.
 *
 *   depth      Depth Anything V2 Small (Apache-2.0): how far away each pixel
 *              of a still is, which is what lets the renderer move the near
 *              part of a picture past the far part -- a camera move rather
 *              than a zoom on a flat print.
 *   cutouts    BiRefNet lite (MIT): the subject of a picture, separated from
 *              whatever it stands on. It replaced colour keying, which only
 *              worked on a flat backdrop and punched holes through any figure
 *              that shared a colour with it -- every photoreal face did.
 *
 * Both licences allow commercial use, which ruled out the better-known
 * alternatives (RMBG-2.0 and the larger Depth Anything models are
 * non-commercial). Both run in a second or two to ten on a laptop CPU, so a
 * GPU is never needed and nothing is paid for.
 *
 * The weights are fetched from Hugging Face on first use -- about 100 MB and
 * 210 MB -- and kept in assets/models, so every later run is offline. Loading
 * is lazy and shared: a video that uses neither model never pays for loading
 * one.
 */

const MODEL_DIR = path.join(ROOT, 'assets', 'models');
const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small';
const CUTOUT_MODEL = 'onnx-community/BiRefNet_lite-ONNX';

type Transformers = typeof import('@huggingface/transformers');
type AnyPipeline = (input: string) => Promise<unknown>;

let library: Promise<Transformers> | null = null;
const pipelines = new Map<string, Promise<AnyPipeline>>();

async function transformers(): Promise<Transformers> {
  library ??= import('@huggingface/transformers').then((module) => {
    module.env.cacheDir = MODEL_DIR;
    module.env.allowLocalModels = true;
    return module;
  });
  return library;
}

async function load(task: 'depth-estimation' | 'background-removal', model: string): Promise<AnyPipeline> {
  const key = `${task}|${model}`;
  let loading = pipelines.get(key);
  if (loading === undefined) {
    loading = (async () => {
      const { pipeline } = await transformers();
      const started = Date.now();
      const made = (await pipeline(task, model, { dtype: 'fp32' })) as unknown as AnyPipeline;
      log.info(`vision: ${model.split('/')[1]} ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return made;
    })();
    // A failed load is not cached, so a network blip does not disable the
    // model for the rest of the process.
    loading.catch(() => pipelines.delete(key));
    pipelines.set(key, loading);
  }
  return loading;
}

/** What transformers.js hands back for an image: raw pixels and their layout. */
type RawImage = { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: number };

/* ------------------------------------------------------------------ depth -- */

/**
 * Grows the near parts of a depth map outward by `radius` pixels.
 *
 * A depth map's edges sit exactly on the subject's silhouette, and the
 * renderer samples it with filtering -- so the outermost ring of the subject
 * reads as half-near and stretches like taffy when the camera moves. Pushing
 * the near depth a few pixels past the silhouette moves that stretch onto the
 * background just behind it, where a smear is invisible. A separable max
 * filter: two passes of a 1-D window instead of one 2-D one.
 */
function dilate(data: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const across = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let best = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const sx = Math.min(width - 1, Math.max(0, x + dx));
        const value = data[row + sx]!;
        if (value > best) best = value;
      }
      across[row + x] = best;
    }
  }
  const down = new Uint8Array(data.length);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let best = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = Math.min(height - 1, Math.max(0, y + dy));
        const value = across[sy * width + x]!;
        if (value > best) best = value;
      }
      down[y * width + x] = best;
    }
  }
  return down;
}

/**
 * A depth map for one picture, written next to it as `<file>.depth.png`.
 *
 * White is near. Stretched to the full range, grown past the silhouettes and
 * softened, because the renderer wants smooth layers rather than the model's
 * exact per-pixel answer: an exact map puts every stray hair on its own plane.
 * Returns the depth file's name, or null if the model could not run -- the
 * picture then moves as a flat image, exactly as it did before this existed.
 */
export async function depthMapFor(imageFile: string, options: { force?: boolean } = {}): Promise<string | null> {
  const out = `${imageFile}.depth.png`;
  if (options.force !== true && fs.existsSync(out)) return path.basename(out);
  try {
    const estimate = await load('depth-estimation', DEPTH_MODEL);
    const result = (await estimate(imageFile)) as { depth: RawImage };
    const { width, height, channels } = result.depth;
    const grey = new Uint8Array(width * height);
    let low = 255;
    let high = 0;
    for (let i = 0; i < grey.length; i++) {
      const value = result.depth.data[i * channels]!;
      grey[i] = value;
      if (value < low) low = value;
      if (value > high) high = value;
    }
    const span = Math.max(1, high - low);
    for (let i = 0; i < grey.length; i++) grey[i] = Math.round(((grey[i]! - low) / span) * 255);

    const radius = Math.max(2, Math.round(width / 280));
    await sharp(Buffer.from(dilate(grey, width, height, radius)), {
      raw: { width, height, channels: 1 },
    })
      .blur(Math.max(1, width / 520))
      .png()
      .toFile(out);
    return path.basename(out);
  } catch (error) {
    log.warn(`vision: no depth for ${path.basename(imageFile)} (${(error as Error).message})`);
    return null;
  }
}

/* ---------------------------------------------------------- depth mattes -- */

export type DepthMatte = {
  /** Depth (0 far, 1 near) above which a surface is in front of the caption. */
  threshold: number;
  /** How much of the caption band the near layer covers. */
  cover: number;
  /**
   * How much of the middle of the band -- where the words actually are -- the
   * near layer covers. A doorframe or a wall at the side of the shot covers
   * the band's edges and none of this.
   */
  centre: number;
  /** How much of the whole picture the near layer is. */
  whole: number;
  /** Mean depth of the near layer minus the far one: how layered the picture is. */
  separation: number;
};

/**
 * Whether a picture has a subject a caption can go behind, and where the cut is.
 *
 * The cut is Otsu's threshold on the depth map -- the depth that best splits
 * the picture into two layers -- because a fixed depth would slice through
 * the middle of whatever happened to sit at it. Returned as numbers rather
 * than a yes or no; `canGoBehind` decides.
 */
export async function depthMatte(depthFile: string): Promise<DepthMatte | null> {
  try {
    const { data, info } = await sharp(depthFile).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const count = width * height;
    const histogram = new Array<number>(256).fill(0);
    for (let i = 0; i < count; i++) histogram[data[i * channels]!]!++;

    let total = 0;
    for (let v = 0; v < 256; v++) total += v * histogram[v]!;
    let below = 0;
    let belowSum = 0;
    let best = 0;
    let threshold = 128;
    for (let v = 0; v < 256; v++) {
      below += histogram[v]!;
      if (below === 0) continue;
      const above = count - below;
      if (above === 0) break;
      belowSum += v * histogram[v]!;
      const meanBelow = belowSum / below;
      const meanAbove = (total - belowSum) / above;
      const between = below * above * (meanBelow - meanAbove) ** 2;
      if (between > best) {
        best = between;
        threshold = v;
      }
    }

    let near = 0;
    let nearSum = 0;
    let farSum = 0;
    let inBand = 0;
    let bandNear = 0;
    let inCentre = 0;
    let centreNear = 0;
    const y0 = Math.floor(height * BEHIND_BAND.top);
    const y1 = Math.ceil(height * BEHIND_BAND.bottom);
    const x0 = Math.floor(width * BEHIND_BAND.left);
    const x1 = Math.ceil(width * BEHIND_BAND.right);
    const c0 = Math.floor(width * 0.3);
    const c1 = Math.ceil(width * 0.7);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = data[(y * width + x) * channels]!;
        const isNear = v > threshold;
        if (isNear) {
          near++;
          nearSum += v;
        } else {
          farSum += v;
        }
        if (y >= y0 && y < y1 && x >= x0 && x < x1) {
          inBand++;
          if (isNear) bandNear++;
          if (x >= c0 && x < c1) {
            inCentre++;
            if (isNear) centreNear++;
          }
        }
      }
    }
    const far = count - near;
    return {
      threshold: threshold / 255,
      cover: inBand === 0 ? 0 : bandNear / inBand,
      centre: inCentre === 0 ? 0 : centreNear / inCentre,
      whole: near / count,
      separation: near === 0 || far === 0 ? 0 : (nearSum / near - farSum / far) / 255,
    };
  } catch (error) {
    log.warn(`vision: could not read ${path.basename(depthFile)} (${(error as Error).message})`);
    return null;
  }
}

/**
 * The picture has a subject the words can pass behind, and not so much of one
 * that they vanish.
 *
 * Too little cover and the caption is just large type on a picture -- fine,
 * but not the effect. Too much and the claim is unreadable, which is the one
 * thing a punch cannot be. A picture that is near almost everywhere is a
 * close-up with nothing behind it; one without two distinct layers is a
 * depth map of a flat thing, and cutting it would carve noise into the words.
 *
 * And the near thing has to be in the middle, where the words are. The depth
 * model often rates a doorframe or a wall at the side of the shot nearer than
 * the person standing in it -- measured on a close-up of a man in a doorway,
 * where the frame was the "subject" and the caption went straight over his
 * face while its first letter vanished behind the jamb.
 */
export function canGoBehind(matte: DepthMatte): boolean {
  return (
    matte.separation >= 0.3 &&
    matte.whole <= 0.6 &&
    matte.cover >= 0.08 &&
    matte.cover <= 0.42 &&
    matte.centre >= 0.15
  );
}

/* ---------------------------------------------------------------- cutouts -- */

export type CutResult =
  | { ok: true; width: number; height: number }
  | { ok: false; why: string };

/**
 * Below this share of the frame the model found no subject; above it, it
 * could not tell the subject from the backdrop and kept both.
 */
const MIN_SUBJECT_SHARE = 0.03;
const MAX_SUBJECT_SHARE = 0.92;
/** A subject whose longest side is shorter than this is a speck, not a cutting. */
const MIN_SUBJECT_EDGE = 240;

/**
 * The subject of a picture on a transparent ground, trimmed to its own edges.
 *
 * `border` adds the white paper edge of a thing cut out with scissors: the
 * silhouette grown by that share of the subject's longest side and filled
 * white, under the subject -- a share rather than pixels, so a small portrait
 * and a tall full-length figure get the same edge once they are on screen.
 * It is what makes a pasted person read as a cutting rather than as a
 * compositing trick, and it hides the one or two pixels of original
 * background any matte leaves at a hairline.
 */
export async function cutOutSubject(
  source: string,
  destination: string,
  options: { border?: number } = {},
): Promise<CutResult> {
  let matte: RawImage;
  try {
    const remove = await load('background-removal', CUTOUT_MODEL);
    const result = (await remove(source)) as RawImage[];
    const first = result[0];
    if (first === undefined) return { ok: false, why: 'the model returned nothing' };
    matte = first;
  } catch (error) {
    return { ok: false, why: `the cutout model could not run (${(error as Error).message})` };
  }

  const { width, height, channels } = matte;
  if (channels !== 4) return { ok: false, why: `expected RGBA, got ${channels} channels` };

  // The subject's bounding box, and how much of the frame it is.
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let solid = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = matte.data[(y * width + x) * 4 + 3]!;
      if (alpha < 128) continue;
      solid++;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  const share = solid / (width * height);
  if (right < 0 || share < MIN_SUBJECT_SHARE) {
    return { ok: false, why: `found a subject in only ${(share * 100).toFixed(1)}% of the picture` };
  }
  if (share > MAX_SUBJECT_SHARE) {
    return { ok: false, why: `kept ${(share * 100).toFixed(0)}% of the picture, so it found no edge` };
  }
  const boxWidth = right - left + 1;
  const boxHeight = bottom - top + 1;
  if (Math.max(boxWidth, boxHeight) < MIN_SUBJECT_EDGE) {
    return { ok: false, why: `the subject is only ${boxWidth}x${boxHeight}` };
  }

  const border = Math.max(0, Math.round((options.border ?? 0) * Math.max(boxWidth, boxHeight)));
  const pad = border + 2;
  const cropped = sharp(Buffer.from(matte.data), { raw: { width, height, channels: 4 } })
    .extract({ left, top, width: boxWidth, height: boxHeight })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } });
  const subject = await cropped.png().toBuffer();
  const outWidth = boxWidth + pad * 2;
  const outHeight = boxHeight + pad * 2;

  if (border === 0) {
    fs.writeFileSync(destination, subject);
    return { ok: true, width: outWidth, height: outHeight };
  }

  /**
   * The paper edge: the alpha, blurred by the border width and thresholded
   * low, is the silhouette grown outward with rounded corners -- the way
   * scissors go round a shape rather than into every notch of it.
   */
  // Two pipelines, because sharp runs its operations in its own fixed order
  // rather than the order they are called in: chained, the threshold ran
  // first and the blur softened it back into a glow.
  const spread = await sharp(subject).extractChannel(3).blur(border / 2).png().toBuffer();
  const alpha = await sharp(spread).threshold(24).toColourspace('b-w').png().toBuffer();
  const paper = await sharp({
    create: { width: outWidth, height: outHeight, channels: 3, background: { r: 246, g: 242, b: 234 } },
  })
    .joinChannel(alpha)
    .png()
    .toBuffer();
  await sharp(paper).composite([{ input: subject }]).png().toFile(destination);
  return { ok: true, width: outWidth, height: outHeight };
}

/* ------------------------------------------------------------ full mattes -- */

export type SubjectMatte = {
  ok: true;
  /** Share of the picture the subject covers. */
  share: number;
  /** The subject's bounding box, as shares of the picture's width and height. */
  box: { left: number; top: number; right: number; bottom: number };
  /** The centre of the subject's mass, as shares of width and height. */
  centre: { x: number; y: number };
};

/**
 * The subject's alpha at the picture's own size, not trimmed.
 *
 * What a thumbnail's "text behind the character" needs: the picture, the words
 * over it, and then the subject again on top -- which only lines up if the
 * matte is the same size as the picture, pixel for pixel. Written as a white
 * PNG whose alpha is the subject, so it can be used directly as a CSS mask.
 */
export async function subjectMatte(
  source: string,
  destination: string,
): Promise<SubjectMatte | { ok: false; why: string }> {
  let matte: RawImage;
  try {
    const remove = await load('background-removal', CUTOUT_MODEL);
    const result = (await remove(source)) as RawImage[];
    const first = result[0];
    if (first === undefined) return { ok: false, why: 'the model returned nothing' };
    matte = first;
  } catch (error) {
    return { ok: false, why: `the cutout model could not run (${(error as Error).message})` };
  }
  const { width, height, channels } = matte;
  if (channels !== 4) return { ok: false, why: `expected RGBA, got ${channels} channels` };

  const alpha = Buffer.alloc(width * height);
  let solid = 0;
  let sumX = 0;
  let sumY = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = matte.data[(y * width + x) * 4 + 3]!;
      alpha[y * width + x] = a;
      if (a < 128) continue;
      solid++;
      sumX += x;
      sumY += y;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (solid === 0) return { ok: false, why: 'no subject found' };

  const white = await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(await sharp(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer())
    .png()
    .toBuffer();
  fs.writeFileSync(destination, white);
  return {
    ok: true,
    share: solid / (width * height),
    box: { left: left / width, top: top / height, right: (right + 1) / width, bottom: (bottom + 1) / height },
    centre: { x: sumX / solid / width, y: sumY / solid / height },
  };
}
