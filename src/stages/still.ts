import fs from 'node:fs';
import path from 'node:path';
import { cache } from '../cache.js';
import { env } from '../config.js';
import { log } from '../log.js';
import { generateImage, isConfigured } from '../providers/flux.js';
import { chooseImages, IMAGE_DIR, writeCredits, type CommonsImage } from './images.js';

/**
 * One picture for a long video.
 *
 * A short deals a different photograph to every beat; an hour of lore needs a
 * single image that holds for the whole runtime and rewards being looked at
 * once. It is generated wide rather than tall — long-form is watched on a
 * television or a second monitor — and asked for depth rather than a subject,
 * because the drift crops into it slowly and a face or a horizon line in the
 * middle becomes the only thing on screen for an hour.
 */

const WIDTH = 1920;
const HEIGHT = 1080;

function prompt(world: string): string {
  return [
    'A wide landscape painting, distant and atmospheric.',
    world,
    'Painted in muted, desaturated colour. Deep aerial perspective with several',
    'receding planes. Soft overcast or twilight light, no sun disc, no strong',
    'shadows. No people, no faces, no text, no lettering, no signage, no',
    'watermark. Nothing centred; interest spread across the frame.',
  ].join(' ');
}

export async function generateStill(options: {
  topic: string;
  world: string;
  seed: number;
  force: boolean;
  /** Generate one instead of finding one. Off by default: see below. */
  generated?: boolean;
  /**
   * The video it is for, so a found photograph's credit is written next to it.
   * A Commons photo is licensed on the condition of attribution, and a credit
   * nobody wrote down cannot make it into the description it belongs in.
   */
  slug?: string;
}): Promise<string> {
  // Whatever this returns, the credits file says so: a drawn still leaves no
  // stale credit behind for a photograph the video no longer shows.
  const credit = (image: CommonsImage | null): void => {
    if (options.slug !== undefined) writeCredits(options.slug, [image]);
  };
  cache.setForce(options.force);
  fs.mkdirSync(IMAGE_DIR, { recursive: true });

  /**
   * Stock first, and a generated picture only when asked for.
   *
   * A long video holds one image for its whole runtime, so the picture is
   * one-per-video rather than one-per-beat — which is exactly the case where
   * paying for generation buys least. Openly licensed landscape photography is
   * abundant, already free, and holds up better under a slow zoom than a
   * generated one, which tends to fall apart when you look at it for an hour.
   */
  if (options.generated === true && isConfigured()) {
    const text = prompt(options.world);
    const { path: file } = await cache.file(
      'lore-still',
      { prompt: text, seed: options.seed, model: env.FLUX_MODEL, size: `${WIDTH}x${HEIGHT}` },
      '.jpg',
      async (destination) => {
        const result = await generateImage({
          prompt: text,
          seed: options.seed,
          width: WIDTH,
          height: HEIGHT,
        });
        fs.writeFileSync(destination, result.bytes);
      },
    );
    credit(null);
    return file;
  }

  log.info('still: looking for an openly licensed photograph');
  const [picked] = await chooseImages({
    topic: `${options.topic} landscape`,
    seed: options.seed,
    beatTexts: [options.topic],
    force: options.force,
  });
  if (picked !== null && picked !== undefined) {
    credit(picked);
    return path.join(IMAGE_DIR, picked.file);
  }

  /**
   * Nothing found, so draw one rather than throw.
   *
   * This threw, and the cost of throwing here is not one picture: the still is
   * the last thing a long-form run needs, so a topic Commons happens to have no
   * landscape for -- "What Happens If You Fall Into a Black Hole?" searched as
   * "happens fall into" and found nothing -- destroyed forty-five minutes of
   * writing and reading at the final step, and left a message telling a person
   * using a web app to pass a command-line flag.
   *
   * Three tenths of a cent is the correct price for not doing that.
   */
  if (isConfigured()) {
    log.warn('still: nothing openly licensed for this one, so drawing it instead');
    const text = prompt(options.world);
    const { path: file } = await cache.file(
      'lore-still',
      { prompt: text, seed: options.seed, model: env.FLUX_MODEL, size: `${WIDTH}x${HEIGHT}` },
      '.jpg',
      async (destination) => {
        const result = await generateImage({
          prompt: text,
          seed: options.seed,
          width: WIDTH,
          height: HEIGHT,
        });
        fs.writeFileSync(destination, result.bytes);
      },
    );
    credit(null);
    return file;
  }

  throw new Error(
    'no picture could be found for this topic, and no image model is configured to draw one',
  );
}
