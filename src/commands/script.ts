import { out } from '../log.js';
import { table } from '../report.js';
import { hashString } from '../rng.js';
import { slugify, truncate } from '../text.js';
import { toSpoken } from '../pronounce.js';
import { draftWarnings, generateScriptVariants } from '../stages/script.js';

export type ScriptOptions = {
  topic: string;
  seed?: number;
  variants: number;
  force: boolean;
};

export async function scriptCommand(options: ScriptOptions): Promise<number> {
  const slug = slugify(options.topic);
  const seed = options.seed ?? hashString(slug);

  const { variants, ledger } = await generateScriptVariants({
    topic: options.topic,
    seed,
    count: options.variants,
    force: options.force,
  });

  for (const variant of variants) {
    const warnings = draftWarnings(variant);
    out('');
    out(
      `--- variant ${variant.index + 1}/${variants.length}  seed ${variant.seed}${variant.cached ? '  (cached)' : ''}`,
    );
    out('');
    out(`HOOK  ${variant.hook}`);
    out('');
    out(
      table(
        ['#', 'template hint', 'emphasis', 'text'],
        variant.draft.beats.map((beat, i) => [
          String(i + 1).padStart(2, '0'),
          beat.template_hint ?? '-',
          beat.emphasis_word ?? '-',
          truncate(beat.text, 62),
        ]),
      ),
    );
    out('');
    out(`words       ${variant.words} (hook ${variant.hookWords})`);
    out(`beats       ${variant.draft.beats.length}`);
    out(
      `checks      ${warnings.length === 0 ? 'all passed' : `${warnings.length} issue(s)`}`,
    );
    for (const warning of warnings) out(`  - ${warning}`);

    if (variant.pronunciation.length > 0) {
      out('');
      out('spoken form rewrites:');
      out(
        table(
          ['rule', 'on screen', 'spoken'],
          variant.pronunciation.map((entry) => [entry.rule, entry.display, entry.spoken]),
        ),
      );
    }
  }

  out('');
  out(ledger.report());
  return 0;
}

export async function pronounceCommand(text: string): Promise<number> {
  const { spoken, substitutions } = toSpoken(text);
  out(`display  ${text}`);
  out(`spoken   ${spoken}`);
  if (substitutions.length === 0) {
    out('');
    out('no rewrites needed');
    return 0;
  }
  out('');
  out(
    table(
      ['rule', 'from', 'to'],
      substitutions.map((entry) => [entry.rule, entry.from, entry.to]),
    ),
  );
  return 0;
}
