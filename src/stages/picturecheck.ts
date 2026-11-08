import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';

import { MODELS, env } from '../config.js';
import { cache } from '../cache.js';
import { log } from '../log.js';
import { generate } from '../providers/gemini.js';

/**
 * Does the picture show what was asked for?
 *
 * An image model is confidently wrong in a small number of recurring ways: two
 * of the one person, a sixth finger, a face melted into a collar, a sign with
 * words in no language, a telephone in 1890. None of that is visible from the
 * prompt or the response. It is visible from the picture, and a text model
 * that can see is a fraction of a cent to ask.
 *
 * So every newly drawn picture is looked at once before it is used, and one
 * that fails is drawn again with what was wrong said out loud. The verdict is
 * cached by the picture's own bytes, so a re-run never pays to look at the
 * same thing twice.
 *
 * Two lessons from the first real run, on a 64-picture video:
 *
 *   The check was a critic, not an editor. It failed 46 of 64 for things like
 *   "the expression is neutral rather than weary" and "short sleeves instead
 *   of long", and each of those was a paid redraw of a picture nobody would
 *   have noticed. It now fails only what a viewer sees at a glance.
 *
 *   A redraw can come back black -- the image service's safety filter answers
 *   with an empty frame rather than an error -- and the black frame was kept,
 *   because it had fewer "problems" listed than the original. Four black
 *   pictures went out in a published video. A blank frame now never wins.
 */

export type Verdict = { ok: boolean; problems: string[] };

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    problems: { type: 'array', items: { type: 'string' } },
    ok: { type: 'boolean' },
  },
  required: ['problems', 'ok'],
  propertyOrdering: ['problems', 'ok'],
};

const mimeOf = (file: string): string =>
  /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.webp$/i.test(file) ? 'image/webp' : 'image/png';

export function canCheck(): boolean {
  return env.GEMINI_API_KEY !== undefined;
}

/**
 * A black, white or single-colour frame: what a blocked or failed draw looks
 * like. Measured, not asked about, because it is free and certain.
 */
export async function isBlank(file: string): Promise<boolean> {
  try {
    const stats = await sharp(file).stats();
    const colour = stats.channels.slice(0, 3);
    const mean = colour.reduce((sum, channel) => sum + channel.mean, 0) / colour.length;
    const spread = colour.reduce((sum, channel) => sum + channel.stdev, 0) / colour.length;
    return mean < 10 || mean > 250 || spread < 4;
  } catch {
    return false;
  }
}

type CheckInput = { file: string; brief: string; must?: string };

function verdictKey(options: CheckInput, bytes: Buffer): Record<string, unknown> {
  const digest = crypto.createHash('sha1').update(bytes).digest('hex');
  return { v: 2, digest, brief: options.brief, must: options.must ?? '', model: MODELS.llm.script };
}

/** Whether this picture has been judged before, without judging it. */
function judgedBefore(options: CheckInput): boolean {
  try {
    const key = cache.key('picture-check', verdictKey(options, fs.readFileSync(options.file)));
    return fs.existsSync(cache.pathFor('picture-check', key, '.json'));
  } catch {
    return false;
  }
}

/**
 * Looks at one picture against the brief it was drawn from.
 *
 * Never throws: a check that cannot run passes the picture, because the
 * picture was fine before this existed and losing it to a network error would
 * be the check doing harm.
 */
export async function checkPicture(options: CheckInput): Promise<Verdict> {
  if (await isBlank(options.file)) {
    return { ok: false, problems: ['the picture came back blank'] };
  }
  if (!canCheck()) return { ok: true, problems: [] };
  try {
    const bytes = fs.readFileSync(options.file);
    const { value } = await cache.json<Verdict>('picture-check', verdictKey(options, bytes), async () => {
      const response = await generate({
        model: MODELS.llm.script,
        systemInstruction:
          'You are the picture editor for a documentary channel. You look at one generated ' +
          'illustration and decide whether it can go on air. You are not a critic: you reject ' +
          'only mistakes a viewer would notice at a glance. You return JSON only.',
        prompt: `The picture was commissioned from this brief:
"""
${options.brief.slice(0, 2400)}
"""
${options.must === undefined ? '' : `\nIt must also be: ${options.must}\n`}
Reject it ONLY for these, and only when they are obvious at a glance:
- it shows the wrong thing entirely: not the subject of the brief at all, or clearly the wrong
  number of main people;
- one character appears twice;
- obviously broken anatomy in the foreground: extra or missing arms or legs, a melted or smeared
  face, a large hand with clearly too many fingers;
- visible text: gibberish writing, captions, speech bubbles, signatures, logos, watermarks;
- something that cannot exist in the time and place of the brief (a car in a medieval scene);
- a collage, a split panel, or a border instead of one picture.

These are NOT problems, never list them: a different pose, gesture, expression, angle, framing or
composition from the brief; clothing details or colours; background details; small hands or
faces in the background; anything the brief does not mention; style or taste.

When in doubt, it is ok. "ok": true with an empty list is the normal answer.`,
        temperature: 0,
        seed: 0,
        maxOutputTokens: 400,
        responseSchema: SCHEMA,
        images: [{ bytes, mime: mimeOf(options.file) }],
      });
      const parsed = JSON.parse(response.text) as Partial<Verdict>;
      const problems = (parsed.problems ?? []).filter((p) => typeof p === 'string' && p.trim() !== '');
      return { ok: parsed.ok !== false || problems.length === 0, problems };
    });
    return value;
  } catch (error) {
    log.debug(`picture check could not run (${(error as Error).message}); passing the picture`);
    return { ok: true, problems: [] };
  }
}

/** What a failed picture is redrawn with: the brief, and what went wrong last time. */
export function correction(problems: readonly string[]): string {
  return problems.length === 0
    ? ''
    : ` Important corrections from the last attempt: ${problems.slice(0, 5).join('; ')}.`;
}

/**
 * Draw, look, and draw once more if it failed.
 *
 * Only a picture drawn now is judged. One already in the cache from before the
 * check existed is used as it is: re-voicing a video must not turn into paying
 * to redraw its pictures, which is what happened the first time.
 *
 * One redraw rather than a loop, because each draw is paid for. The redraw
 * replaces the first only when it is clearly better -- passes, or has strictly
 * fewer problems -- and never when it is blank.
 */
export async function drawChecked(options: {
  label: string;
  brief: string;
  must?: string;
  /** Draws a take; `fresh` is false when it came out of the cache. */
  draw: (fix: string, take: number) => Promise<{ file: string; fresh: boolean }>;
}): Promise<string> {
  const input = (file: string): CheckInput => ({
    file,
    brief: options.brief,
    ...(options.must === undefined ? {} : { must: options.must }),
  });

  const first = await options.draw('', 0);
  if (!first.fresh && !judgedBefore(input(first.file)) && !(await isBlank(first.file))) {
    return first.file;
  }
  const verdict = await checkPicture(input(first.file));
  if (verdict.ok) return first.file;

  log.info(`pictures: ${options.label} redrawn — ${verdict.problems.join('; ')}`);
  let second: string;
  try {
    second = (await options.draw(correction(verdict.problems), 1)).file;
  } catch (error) {
    log.warn(`pictures: ${options.label} redraw failed (${(error as Error).message}); keeping the first`);
    return first.file;
  }
  const again = await checkPicture(input(second));
  if (again.ok) return second;

  const secondBlank = await isBlank(second);
  const firstBlank = await isBlank(first.file);
  const better = !secondBlank && (firstBlank || again.problems.length < verdict.problems.length);
  log.warn(
    `pictures: ${options.label} still has problems after a redraw — ${again.problems.join('; ')}; ` +
      `keeping the ${better ? 'redraw' : 'first'}. Replace it in the editor if it matters.`,
  );
  return better ? second : first.file;
}
