import fs from 'node:fs';
import { cache } from '../cache.js';
import { ffmpeg, probeDurationMs } from '../ffmpeg.js';
import { log } from '../log.js';

/**
 * Turns a track into one that can be looped without a seam.
 *
 * `-stream_loop -1` repeats a file perfectly, and that is exactly the problem:
 * the last sample is followed by the first, and unless the track was written to
 * end where it begins there is a step in the waveform there. A step is a click,
 * and a click every ninety seconds under a quiet narration is more noticeable
 * than the music itself.
 *
 * The fix is the standard fold. Take a track of length L and a crossfade of X:
 * the last X seconds are faded out and mixed over the first X seconds faded in,
 * and the result is trimmed to L - X. The join that used to be audible now
 * happens inside a crossfade, and the new end of the file is a point that
 * already flows into the new beginning -- because that beginning contains it.
 *
 * Done once and cached against the source, so a track dropped in assets/music
 * is folded the first time it is used and never again.
 */

/** Long enough to hide a join, short enough not to smear the music. */
const CROSSFADE_MS = 3_000;

/**
 * Below this there is nothing to fold: the crossfade would be most of the
 * track, and what came out would be a wash rather than a loop.
 */
const MIN_LENGTH_MS = 10_000;

export async function seamlessLoop(source: string): Promise<string> {
  const totalMs = await probeDurationMs(source);
  if (totalMs < MIN_LENGTH_MS) {
    log.warn(
      `music: ${Math.round(totalMs / 1000)}s is too short to fold, so the loop will have a seam`,
    );
    return source;
  }

  const fadeMs = Math.min(CROSSFADE_MS, Math.floor(totalMs / 6));
  const fade = fadeMs / 1000;
  const total = totalMs / 1000;
  const keep = total - fade;

  const { path: looped, hit } = await cache.file(
    'seamless-loop',
    { source, totalMs, fadeMs, v: 1 },
    '.wav',
    async (destination) => {
      /**
       * Three streams off one input: the head to fade in, the tail to fade out
       * over it, and the body that follows unchanged. `asetpts` on each because
       * atrim keeps the original timestamps, and concat on streams that do not
       * start at zero produces silence where the gap used to be.
       */
      await ffmpeg([
        '-i', source,
        '-filter_complex',
        [
          `[0:a]atrim=0:${fade},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade}[head]`,
          `[0:a]atrim=${keep}:${total},asetpts=PTS-STARTPTS,afade=t=out:st=0:d=${fade}[tail]`,
          `[head][tail]amix=inputs=2:normalize=0[join]`,
          `[0:a]atrim=${fade}:${keep},asetpts=PTS-STARTPTS[body]`,
          `[join][body]concat=n=2:v=0:a=1[out]`,
        ].join(';'),
        '-map', '[out]',
        '-c:a', 'pcm_s16le',
        // Named explicitly: the cache writes through a temporary path ending
        // in .tmp, so there is no extension for ffmpeg to infer a muxer from.
        '-f', 'wav',
        '-y', destination,
      ]);
    },
  );

  if (hit !== true) {
    log.info(
      `music: folded a ${Math.round(totalMs / 1000)}s track into a ` +
        `${Math.round(keep)}s seamless loop`,
    );
  }
  return fs.existsSync(looped) ? looped : source;
}
