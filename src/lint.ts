import fs from 'node:fs';
import path from 'node:path';
import { EXPLAINER_BEAT_MS, EXPLAINER_WORDS, OUTRO_MS } from './explainer.js';
import {
  HIGH_CONTRAST_TEMPLATES,
  HOOK_TEMPLATES,
  PLAN,
  TREATMENT,
  AUDIO,
  SFX_LEAD_MS,
  dirs,
} from './config.js';
import { beatWords, isFootageFile, type BeatSheet, type TemplateName } from './schema.js';

export type LintLevel = 'warn' | 'info';

export type LintFinding = {
  level: LintLevel;
  rule: string;
  where: string;
  message: string;
};

export type LintOptions = {
  checkFiles?: boolean;
};

const HIGH_CONTRAST = new Set<TemplateName>(HIGH_CONTRAST_TEMPLATES);
const HOOK_OK = new Set<TemplateName>(HOOK_TEMPLATES);

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function nearestGridDistanceMs(grid: readonly number[], atMs: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const tick of grid) {
    const distance = Math.abs(tick - atMs);
    if (distance < best) best = distance;
    if (tick > atMs && distance > best) break;
  }
  return best;
}

export function lintBeatSheet(sheet: BeatSheet, options: LintOptions = {}): LintFinding[] {
  const findings: LintFinding[] = [];
  const add = (level: LintLevel, rule: string, where: string, message: string): void => {
    findings.push({ level, rule, where, message });
  };

  const { durationMs } = sheet.meta;
  /**
   * The targets are the format's. An explainer is a minute of whole sentences,
   * so judging it against a forty-second short warned on every beat it had.
   */
  const explainer = sheet.meta.mode === 'explainer';
  // Painted beats are whole sentences too: a painting needs time to come in.
  const sentences = explainer || sheet.meta.mode === 'painted';
  const target = sheet.meta.mode === 'painted'
    ? { ...PLAN, beatMsMin: EXPLAINER_BEAT_MS.min, beatMsMax: EXPLAINER_BEAT_MS.max }
    : explainer
    ? {
        durationMsMin: 45_000,
        durationMsMax: 80_000 + OUTRO_MS,
        scriptWordsMin: EXPLAINER_WORDS.min - 15,
        scriptWordsMax: EXPLAINER_WORDS.max + 15,
        beatMsMin: EXPLAINER_BEAT_MS.min,
        beatMsMax: EXPLAINER_BEAT_MS.max + OUTRO_MS,
        hookMaxMs: 4_500,
      }
    : PLAN;

  if (durationMs < target.durationMsMin || durationMs > target.durationMsMax) {
    add(
      'warn',
      'duration-range',
      'meta.durationMs',
      `${durationMs}ms is outside the ${target.durationMsMin}-${target.durationMsMax}ms target`,
    );
  }

  const hookWords = wordCount(sheet.script.hook);
  if (hookWords > PLAN.hookMaxWords) {
    add(
      'warn',
      'hook-length',
      'script.hook',
      `${hookWords} words, limit is ${PLAN.hookMaxWords}`,
    );
  }

  const totalWords = wordCount(sheet.script.fullText);
  if (totalWords < target.scriptWordsMin || totalWords > target.scriptWordsMax) {
    add(
      'warn',
      'script-length',
      'script.fullText',
      `${totalWords} words, target is ${target.scriptWordsMin}-${target.scriptWordsMax}`,
    );
  }

  const expectedFullText = `${sheet.script.hook} ${sheet.script.body}`.replace(/\s+/g, ' ').trim();
  if (sheet.script.fullText.replace(/\s+/g, ' ').trim() !== expectedFullText) {
    add(
      'warn',
      'script-consistency',
      'script.fullText',
      'fullText is not hook + " " + body; TTS and captions can drift apart',
    );
  }

  const firstBeat = sheet.beats[0];
  if (firstBeat !== undefined) {
    if (firstBeat.startMs !== 0) {
      add('warn', 'timeline-cover', 'beats[0].startMs', `first beat starts at ${firstBeat.startMs}ms, not 0`);
    }
    if (firstBeat.endMs > target.hookMaxMs) {
      add(
        'warn',
        'hook-window',
        'beats[0].endMs',
        `hook beat runs to ${firstBeat.endMs}ms, should land inside ${target.hookMaxMs}ms`,
      );
    }
    if (!HOOK_OK.has(firstBeat.template)) {
      add(
        'warn',
        'hook-template',
        'beats[0].template',
        `hook uses "${firstBeat.template}", expected one of ${HOOK_TEMPLATES.join(' | ')}`,
      );
    }
  }

  const lastBeat = sheet.beats[sheet.beats.length - 1];
  if (lastBeat !== undefined && lastBeat.endMs !== durationMs) {
    add(
      'warn',
      'timeline-cover',
      `beats[${sheet.beats.length - 1}].endMs`,
      `last beat ends at ${lastBeat.endMs}ms but meta.durationMs is ${durationMs}ms`,
    );
  }

  for (const [i, beat] of sheet.beats.entries()) {
    const where = `beats[${i}] (${beat.id})`;
    const length = beat.endMs - beat.startMs;

    if (length < target.beatMsMin || length > target.beatMsMax) {
      add(
        'warn',
        'beat-length',
        where,
        `${length}ms, target is ${target.beatMsMin}-${target.beatMsMax}ms`,
      );
    }

    const previous = sheet.beats[i - 1];
    if (previous !== undefined) {
      if (previous.endMs !== beat.startMs) {
        add(
          'warn',
          'timeline-cover',
          where,
          `gap of ${beat.startMs - previous.endMs}ms after ${previous.id}; every frame must belong to a beat`,
        );
      }
      if (previous.template === beat.template) {
        add(
          'warn',
          'template-repeat',
          where,
          `repeats template "${beat.template}" from ${previous.id}`,
        );
      }
      if (previous.motion.kind === beat.motion.kind) {
        add(
          'warn',
          'motion-repeat',
          where,
          `repeats motion "${beat.motion.kind}" from ${previous.id}`,
        );
      }
    }

    const snapDistance = nearestGridDistanceMs(sheet.music.beatGridMs, beat.startMs);
    // An explainer cuts between sentences on purpose, so the grid is not its measure.
    if (i > 0 && !sentences && snapDistance > PLAN.snapToleranceMs) {
      add(
        'warn',
        'beat-snap',
        where,
        `starts ${Math.round(snapDistance)}ms from the nearest music beat, tolerance is ${PLAN.snapToleranceMs}ms`,
      );
    }

    // Photographs are blurred less than procedural fields, and footage less
    // again, so the acceptable range moves with the imagery mode and with what
    // this particular beat is showing rather than being fixed. Without the
    // footage term this rule fired on every beat of every video-backed sheet --
    // 31 warnings describing the treatment working as designed, which is worse
    // than no rule at all.
    // Per beat, from the file itself: under "mix" one sheet holds both kinds,
    // so the sheet's source no longer answers this for every beat in it.
    const image = beat.background.image;
    const footage = image !== null && isFootageFile(image.file);
    const blurScale =
      (TREATMENT.imageBlurScale[sheet.meta.imagery] ?? 1) *
      (TREATMENT.effectBlurScale[sheet.meta.effect] ?? 1) *
      (footage ? TREATMENT.footageBlurScale : 1);
    const blurMin = Math.floor(TREATMENT.blurPxMin * blurScale);
    const blurMax = Math.ceil(TREATMENT.blurPxMax * blurScale);
    if (beat.background.blurPx < blurMin || beat.background.blurPx > blurMax) {
      add(
        'warn',
        'treatment-blur',
        where,
        `blurPx ${beat.background.blurPx} is outside ${blurMin}-${blurMax} for "${sheet.meta.effect}" at imagery "${sheet.meta.imagery}"`,
      );
    }

    const scrimScale = footage ? TREATMENT.footageScrimScale : 1;
    const scrimMin = Math.round(TREATMENT.scrimOpacityMin * scrimScale * 100) / 100;
    const scrimMax = Math.round(TREATMENT.scrimOpacityMax * scrimScale * 100) / 100;
    if (beat.background.scrimOpacity < scrimMin || beat.background.scrimOpacity > scrimMax) {
      add(
        'warn',
        'treatment-scrim',
        where,
        `scrimOpacity ${beat.background.scrimOpacity} is outside ${scrimMin}-${scrimMax}`,
      );
    }

    if (beat.emphasisWordIndex === null) {
      add('info', 'emphasis-missing', where, 'no emphasis word chosen');
    }

    if (beat.lines.every((line) => !line.emphasis)) {
      add('info', 'emphasis-flat', where, 'no line is flagged emphasis; the beat will read uniform');
    }

    const words = beatWords(beat.lines);
    if (words.length === 0) {
      add('warn', 'beat-empty', where, 'beat has no words');
    }
  }

  const window = PLAN.patternInterruptEveryBeats;
  for (let i = 0; i + window <= sheet.beats.length; i++) {
    const slice = sheet.beats.slice(i, i + window);
    if (!slice.some((beat) => HIGH_CONTRAST.has(beat.template))) {
      add(
        'warn',
        'pattern-interrupt',
        `beats[${i}..${i + window - 1}]`,
        `${window} beats without a high-contrast template (${HIGH_CONTRAST_TEMPLATES.join(' | ')})`,
      );
    }
  }

  /**
   * A whoosh starts before the cut, not on it.
   *
   * This used to look for a cue whose atMs equalled the beat's start, which
   * was right while the sample was a hit. It is a swell now, and it leads the
   * cut by its own length so the top of the rise and the change of picture are
   * the same frame — so the cue that belongs to a cut sits SFX_LEAD_MS before
   * it, and the old check warned on every beat in every video.
   */
  const whooshAt = new Set(sheet.sfx.filter((c) => c.cue === 'whoosh').map((c) => c.atMs));
  for (const [i, beat] of sheet.beats.entries()) {
    if (i === 0) continue;
    const wanted = Math.max(0, beat.startMs - SFX_LEAD_MS.whoosh);
    if (!whooshAt.has(wanted)) {
      add(
        'warn',
        'sfx-cut',
        `beats[${i}] (${beat.id})`,
        `no whoosh leading the cut at ${beat.startMs}ms (expected one at ${wanted}ms)`,
      );
    }
  }

  for (const [i, cue] of sheet.sfx.entries()) {
    const under = -cue.gainDb;
    if (under < AUDIO.sfxUnderNarrationDbMin || under > AUDIO.sfxUnderNarrationDbMax) {
      add(
        'warn',
        'sfx-gain',
        `sfx[${i}] ${cue.cue}`,
        `gainDb ${cue.gainDb} sits ${under}dB under narration, target is ${AUDIO.sfxUnderNarrationDbMin}-${AUDIO.sfxUnderNarrationDbMax}dB`,
      );
    }
  }

  const lastWord = sheet.words[sheet.words.length - 1];
  if (sheet.words.length === 0) {
    add('warn', 'words-missing', 'words', 'no word timings; captions cannot be rendered');
  } else if (lastWord !== undefined && lastWord.endMs > durationMs) {
    add(
      'warn',
      'words-overrun',
      'words',
      `last word ends at ${lastWord.endMs}ms, past meta.durationMs ${durationMs}ms`,
    );
  }

  if (options.checkFiles === true) {
    for (const [where, target] of [
      ['voice.audioPath', sheet.voice.audioPath],
      ['music.trackPath', sheet.music.trackPath],
    ] as const) {
      const resolved = path.isAbsolute(target) ? target : path.resolve(dirs.root, target);
      if (!fs.existsSync(resolved)) {
        add('warn', 'asset-missing', where, `file not found: ${resolved}`);
      }
    }
  }

  return findings;
}

export function formatFindings(findings: readonly LintFinding[]): string {
  return findings
    .map((f) => `  [${f.level}] ${f.rule} @ ${f.where}: ${f.message}`)
    .join('\n');
}

export function countByLevel(findings: readonly LintFinding[]): Record<LintLevel, number> {
  return findings.reduce<Record<LintLevel, number>>(
    (acc, f) => {
      acc[f.level] += 1;
      return acc;
    },
    { warn: 0, info: 0 },
  );
}
