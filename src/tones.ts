/**
 * The register the script is written in.
 *
 * This is not the same knob as the voice. A character changes timbre, accent
 * and pace; a tone changes vocabulary, sentence shape and what counts as a
 * good hook. "Rae reading a documentary line" and "Rae reading a Gen Z line"
 * are different videos, and only one of those is the script's doing.
 *
 * Each tone contributes a paragraph to the writing prompt. They are written as
 * instructions to a writer, not as adjectives, because "be punchy" produces
 * nothing while "no sentence over nine words" produces punchy.
 */

export type Tone = {
  id: string;
  label: string;
  /** One line, shown under the picker. */
  blurb: string;
  /** Appended to the writing prompt. */
  direction: string;
};

export const TONES: readonly Tone[] = [
  {
    id: 'plain',
    label: 'Plain',
    blurb: 'the house voice — declarative, no decoration',
    direction:
      'Write plainly and declaratively. No jokes, no slang, no rhetorical flourishes. ' +
      'Every sentence states something. This is the default register: get out of the way of the fact.',
  },
  {
    id: 'genz',
    label: 'Gen Z',
    blurb: 'unserious delivery, serious facts',
    /**
     * The old version was mostly a banned-words list, so the model wrote Plain
     * and simply avoided saying "rizz". Bans do not create a voice. This leads
     * with the moves — how sentences are shaped, where the joke sits, what the
     * reaction is — and keeps the prohibitions to the two that actually matter.
     */
    direction:
      'Voice: chronically online, deadpan, unimpressed by things that should be impressive ' +
      'and personally offended by things that are trivial. You are not explaining to an ' +
      'audience, you are telling one friend something you cannot believe you just found out.\n' +
      'Sentence shape: short. Often one clause. Fragments are correct, not sloppy. Start beats ' +
      'mid-thought — "ok so", "and no", "which. sure.", "nobody warned me about this". ' +
      'Sentences can end on the surprising word and just stop.\n' +
      'React to the facts, do not only state them. A number lands, then you answer it: ' +
      '"forty percent." / "of everyone." / "cool cool cool." Rhetorical questions you ' +
      'immediately answer are good. So is correcting yourself mid-beat.\n' +
      'Scale is inverted for comedy: enormous things get "which is a bit much", tiny things ' +
      'get full outrage. Understate the disaster, overstate the inconvenience.\n' +
      'Slang, used sparingly and only where it fits naturally: no shot, it\'s giving, ate, ' +
      'the way that, not the, lowkey, bestie, unserious, crashing out, cooked, glazing, ' +
      'mid, aura, sending me, hits different. Never more than one per beat and never in ' +
      'the hook. Wrong slang is worse than none — if a beat does not want one, leave it out.\n' +
      'Two hard rules: no emoji and no hashtags, because this is read aloud and they are ' +
      'unspeakable. And every fact stays exactly as true as it was — the delivery is ' +
      'unserious, the information is not. Never explain the joke.',
  },
  {
    id: 'documentary',
    label: 'Documentary',
    blurb: 'measured, past tense, a narrator with time',
    direction:
      'Write as a documentary narrator. Measured, unhurried sentences with room in them. ' +
      'Prefer the concrete over the summary — name the thing, the place, the practice. ' +
      'Do not reach for the authority of research to do it: no researchers, no studies, ' +
      'no institutions, and no year attached to a finding. A date is only for when an ' +
      'event happened, never for when someone published. ' +
      'Let one sentence land before the next begins. No exclamation, no direct address, ' +
      'no questions to the viewer.',
  },
  {
    id: 'explainer',
    label: 'Explainer',
    blurb: 'teaches it — cause, then effect',
    direction:
      'Write as a patient explainer. Each beat is a step: state the thing, then why it follows. ' +
      'Use "because", "which means", "so". Introduce a mechanism, not just a fact. ' +
      'Assume the viewer is smart and knows nothing about this specific subject.',
  },
  {
    id: 'hype',
    label: 'Hype',
    blurb: 'high energy, builds to the turn',
    direction:
      'Write with rising energy. Short lines, hard consonants, momentum. Each beat should make ' +
      'the next one feel necessary, and the reversal should land like a drop. ' +
      'No filler adjectives — the pace comes from sentence length, not from words like "amazing".',
  },
  {
    id: 'deadpan',
    label: 'Deadpan',
    blurb: 'dry, understated, the joke never announced',
    direction:
      'Write dry and understated. Deliver the most absurd fact in the flattest possible sentence. ' +
      'Never signal the joke, never comment on how strange something is, and never use an ' +
      'exclamation mark. The humour is entirely in the restraint.',
  },
];

export const DEFAULT_TONE = 'plain';

export function isTone(id: string): boolean {
  return TONES.some((tone) => tone.id === id);
}

export function toneFor(id: string | undefined): Tone {
  return TONES.find((tone) => tone.id === id) ?? TONES.find((tone) => tone.id === DEFAULT_TONE)!;
}
