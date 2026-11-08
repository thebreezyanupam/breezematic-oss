import { z } from 'zod';
import { MODELS } from '../config.js';
import { priceOf } from '../cost.js';
import { generate, toInt32Seed } from '../providers/gemini.js';

export type TopicSuggestions = {
  topics: string[];
  model: string;
  usd: number | null;
};

const SYSTEM_INSTRUCTION = [
  'You suggest topics for 30-50 second vertical shorts.',
  'You are judged on one thing: whether someone scrolling past would stop.',
  'A topic that is merely true and merely obscure is a failure.',
  'You return JSON and nothing else. No preamble, no markdown, no code fences.',
].join(' ');

/**
 * What this optimises for, and what it used to.
 *
 * The first version varied by field — one topic each from plumbing, insurance,
 * noise regulation, papermaking, building codes — on the theory that obscurity
 * produces surprise. It produces museum placards. Measured output included
 * "why fabric durability is measured in rubs" and "how firehose diameters
 * became an international standard": both true, both genuinely little-known,
 * and nobody alive stops scrolling for either.
 *
 * Obscurity is not the axis. Appetite is. People stop for danger, for secrets,
 * for something happening inside their own body, for a person who did what
 * nobody could survive — and the subject matter is downstream of that. So the
 * lens now names the appetite, and the subject list is broad and visceral
 * rather than narrow and technical.
 */
/**
 * Every angle names the kind of thing it wants, because vagueness is where the
 * model invents.
 *
 * Measured across three batches: angles that force a named person, place or
 * event came back entirely true — Phineas Gage, Vasili Arkhipov, Eilean Mor,
 * the 1933 double eagle, Juliane Koepcke. Angles phrased as an open feeling
 * ("something happening inside your body right now", "the last surviving one of
 * something") produced "the only person who inherited a trillion dollars" and
 * "the last physical key to the lunar vault", neither of which exists.
 *
 * So each angle asks for a case that can be looked up, not a sensation.
 */
const APPETITES = [
  'a named person who lived through something almost nobody survives',
  'a named person whose one decision, made in seconds, changed everything after it',
  'a specific place people are forbidden to enter, and what is documented to be in it',
  'a named disappearance that was never explained',
  'a documented case where something completely ordinary turned out to be lethal',
  'a named cover-up that was later exposed or declassified',
  'an everyday object whose real, documented origin is violent or grotesque',
  'a belief held for centuries that a named discovery overturned',
  'a named experiment that would never be approved today',
  'a documented last: the final named individual, unit or speaker of its kind',
  'a named person who got away with it, and how',
  'a recorded case of a body or a mind pushed past its known limit',
  'a warning that a named person gave and that was ignored, and what it cost',
  'a named object, wreck or specimen that was found where it should not have been',
  'a documented finding about the human body that sounds invented but is not',
  'a named rescue, escape or survival against odds someone actually calculated',
];

/**
 * The areas to look in, grouped so a category can aim the search.
 *
 * Grouped rather than parallel: a category is a slice of the same subject list
 * the untargeted case draws from, so picking one narrows the search without
 * changing what a good topic is. Subjects appear in more than one category on
 * purpose — a failed machine is a disaster and a piece of technology, and which
 * one you meant depends on which you picked.
 */
/**
 * Two shapes of suggestion, not one.
 *
 * Everything above is built for facts about the world: name the real event, do
 * not invent, no listicles. Those rules are right for "Crime & mystery" and
 * actively wrong for "Books" — under them the model will never suggest a novel
 * to explain, because a novel is not a claim about the world.
 *
 * So a category declares its kind, and the kind chooses the prompt. `work`
 * categories suggest a published thing and an angle on it; `versus` sets two
 * named things against each other; `fact` is everything that came before.
 */
export type CategoryKind = 'fact' | 'work' | 'versus';

export const CATEGORIES: Record<
  string,
  { label: string; kind?: CategoryKind; medium?: string; subjects: readonly string[] }
> = {
  any: {
    label: 'Anything',
    subjects: [
      'survival and endurance', 'the deep ocean', 'space and what is out there',
      'the human brain', 'the human body', 'crime and forensics', 'disappearances',
      'money, fraud and fortunes', 'animals doing things that should be impossible',
      'disasters and near misses', 'secrets and classified things', 'ancient people',
      'extreme weather', 'medicine and its mistakes', 'isolation and confinement',
      'death and what follows it', 'obsession and the people consumed by it',
      'machines that failed', 'islands and remote places', 'memory and forgetting',
      'twins, doubles and mistaken identity', 'poisons and antidotes',
      'the edge of what physics allows', 'buried and hidden things',
    ],
  },
  survival: {
    label: 'Survival & disaster',
    subjects: [
      'survival and endurance', 'disasters and near misses', 'extreme weather',
      'isolation and confinement', 'machines that failed',
      'a named rescue that should not have worked',
    ],
  },
  crime: {
    label: 'Crime & mystery',
    subjects: [
      'crime and forensics', 'unsolved disappearances of people',
      'poisonings and how they were detected',
      'wrongful convictions and mistaken identity', 'people who were never caught',
      'a case broken by one piece of evidence', 'heists and what gave them away',
    ],
  },
  space: {
    label: 'Space',
    subjects: [
      'space and what is out there', 'the edge of what physics allows',
      'machines that failed', 'missions that nearly did not come back',
      'things found in space nobody expected',
    ],
  },
  body: {
    label: 'Body & mind',
    subjects: [
      'the human brain', 'the human body', 'medicine and its mistakes',
      'memory and forgetting', 'death and what follows it',
      'what a body does under conditions it was never built for',
    ],
  },
  nature: {
    label: 'Nature & animals',
    subjects: [
      'animals doing things that should be impossible', 'the deep ocean',
      'extreme weather', 'islands and remote places',
      'species that came back from nothing', 'plants and fungi that behave like animals',
    ],
  },
  history: {
    label: 'History',
    subjects: [
      'ancient people', 'buried and hidden things', 'secrets and classified things',
      'obsession and the people consumed by it',
      'a single day that changed what came after it',
      'people history recorded wrongly',
    ],
  },
  money: {
    label: 'Money & fraud',
    subjects: [
      'money, fraud and fortunes', 'a con that worked for years',
      'fortunes lost in a single decision', 'objects worth far more than they look',
      'counterfeits and forgeries', 'people who went broke spectacularly',
      'a theft nobody solved',
    ],
  },
  science: {
    label: 'Science & experiments',
    subjects: [
      'medicine and its mistakes', 'the edge of what physics allows',
      'the human brain', 'experiments that got out of hand',
      'a discovery made by accident', 'measurements that turned out to be wrong',
    ],
  },
  books: {
    label: 'Books explained',
    kind: 'work',
    medium: 'a book',
    subjects: [
      'novels people say they have read and have not',
      'books that are shorter and stranger than their reputation',
      'novels with an ending that is argued about',
      'non-fiction that changed how people think',
      'books that were banned, burned or sued over',
      'novels whose first chapter gives away the whole thing',
      'classics that are actually funny',
      'books written under extraordinary circumstances',
    ],
  },
  anime: {
    label: 'Anime & manga',
    kind: 'work',
    medium: 'an anime series or manga',
    subjects: [
      'series whose premise is stranger than its reputation',
      'a power system and the rule that actually governs it',
      'an ending that split the audience',
      'a character whose motivation is routinely misread',
      'an arc that changed what the series was about',
      'a manga that ends differently from its adaptation',
      'a short series worth the whole afternoon',
      'a single fight that the whole story was built toward',
    ],
  },
  film: {
    label: 'Film & TV',
    kind: 'work',
    medium: 'a film or television series',
    subjects: [
      'films with an ending people still argue about',
      'a plot that only makes sense on a second watch',
      'a film that was nearly a completely different film',
      'an adaptation that changed the point of the book',
      'a production that nearly destroyed everyone involved',
      'a character who is not the villain people remember',
      'a scene that explains the entire film',
      'a series whose first episode lies to you',
    ],
  },
  versus: {
    label: 'Who would win',
    kind: 'versus',
    subjects: [
      'two animals that never meet in the wild',
      'two historical fighting forces from different centuries',
      'two machines built for the same job in different eras',
      'a predator against a defence that evolved against something else',
      'two record holders at opposite extremes',
      'a human specialist against an animal at the same task',
    ],
  },
  technology: {
    label: 'Machines & technology',
    subjects: [
      'machines that failed', 'the edge of what physics allows',
      'a machine that outlived everyone who understood it',
      'engineering decisions with a body count', 'things built and then buried',
    ],
  },
};

export const CATEGORY_IDS = Object.keys(CATEGORIES);

/** Written once rather than escaped inside a nested template literal. */
const NEWLINE = '\n';

function shuffled<T>(items: readonly T[]): T[] {
  const deck = [...items];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j] as T, deck[i] as T];
  }
  return deck;
}

function pick<T>(items: readonly T[], howMany: number): T[] {
  return shuffled(items).slice(0, howMany);
}

/**
 * `howMany` items, cycling the list when it is shorter than asked for.
 *
 * A narrow category has five or six subjects and the page may ask for eight
 * topics; slicing would quietly return six. Cycling a fresh shuffle keeps the
 * count honest and keeps the repeats spread apart rather than adjacent.
 */
function spread<T>(items: readonly T[], howMany: number): T[] {
  const out: T[] = [];
  while (out.length < howMany) out.push(...shuffled(items));
  return out.slice(0, howMany);
}

/**
 * How a topic has to read, whatever kind it is.
 *
 * The topic is the title: publish.ts capitalises it, appends the shorts tag and
 * sends it. So a topic that reads as a catalogue entry ships as one.
 *
 * Every weak suggestion measured had the same shape -- an abstract noun with
 * the subject hanging off the end of it. "The haunting psychological journey
 * within the series Serial Experiments Lain". "The true eerie brevity of The
 * Metamorphosis". "The Nen constraints that actually control Hunter x Hunter".
 * All accurate, all unsayable. It is the museum placard again, wearing a
 * different coat, and the cure is the same: lead with the thing.
 */
const TITLE_RULES = `How it must read — this decides whether anyone watches:
- Three to eight words. Shorter is almost always better. Ten is too long.
- Lead with the concrete thing: the person, the work, the object, the number.
  Never open with an abstract noun. Banned as the opening: the journey, the
  depth, the brevity, the nature, the significance, the importance, the impact,
  the legacy, the exploration, the analysis, the constraints, the dynamics.
- Do not use the frame "The ___ of ___". It is the single most common way a
  topic turns into a catalogue entry. "The ambiguous final scene of The Great
  Gatsby" is the disease; "Gatsby's last line, explained" is the cure.
- Make a claim or ask a question. Do not describe. "Serial Experiments Lain
  predicted the internet" beats any description of what the series is like.
- Say it out loud. If you would not say it to a friend in a sentence, rewrite
  it. Nobody says "the true eerie brevity of The Metamorphosis".
- No full stop at the end. A question mark is allowed when it is genuinely a
  question; nothing else closes a title.
- Plain words. No "delve", "intricate", "profound", "haunting", "fascinating",
  "surprising", "bizarre", "unravel", "dive into". They are filler and they are
  what a title sounds like when it has nothing to say.`;

/**
 * The hint, as a line in the prompt.
 *
 * It narrows rather than replaces. The category still decides the *shape* of a
 * suggestion — a work to explain, a matchup, a fact — and the hint decides what
 * it is about. That split is what makes "Anime & manga" plus "isekai" produce
 * isekai series to explain, rather than a list of isekai facts or a pile of
 * topics that quietly drift back to whatever the category would have picked.
 *
 * Empty when nothing was typed, so the prompt is unchanged from the version
 * every rule above was measured against.
 */
function hintLine(hint: string): string {
  const trimmed = hint.trim().slice(0, 200);
  if (trimmed === '') return '';
  return `
The person asked specifically for: ${trimmed}

That binds harder than the areas listed above. Every topic must be about it. If
it names one work, one person, one series or one period, all of them are about
that; if it names something broader, stay inside it. Where it and an area
disagree, the request wins and the area is ignored. Do not drift back to the
general case after the first two.
`;
}

/**
 * Suggest published works to explain, with an angle on each.
 *
 * Summarising and analysing a published work is ordinary commentary, and it is
 * what the whole explainer format is. The thing to avoid is not the subject but
 * the substance: this asks for the angle, never for the text, and the video is
 * told in original words and original art.
 */
function buildWorkPrompt(
  count: number,
  avoid: readonly string[],
  chosen: { label: string; medium?: string; subjects: readonly string[] },
  hint: string,
): string {
  const subjects = spread(chosen.subjects, count);
  const medium = chosen.medium ?? 'a published work';

  return `Suggest ${count} short videos that explain ${medium}.

Category: ${chosen.label}. Every single one must be ${medium} — nothing from any
other medium. Asked for books, a film is wrong even when the film is famous and
even when it was adapted from one; if the work you have in mind is best known as
a film, it does not belong here.

One for each line below. The line is what to look for:
${subjects.map((subject, index) => `${index + 1}. ${subject}`).join(NEWLINE)}
${hintLine(hint)}
Each topic names a real work and says what about it the video will explain.

${TITLE_RULES}

Rules:
1. Name a real, published, findable example of ${medium}. Never invent a title,
   an author, a studio or a plot point. If you are not certain the work exists
   and you know what happens in it, choose another.
2. Say what the video explains: the ending, the plot, the twist, the power
   system, what a character actually wants, what the adaptation changed. A title
   on its own is not a topic.
3. It must be explainable in under a minute of narration. The whole of a long
   series is not; one arc, one ending, one rule, one character is.
4. Popular enough that someone recognises the name while scrolling. An excellent
   book nobody has heard of makes an excellent video nobody watches.
5. Keep the work's title spelled as it actually is, capitals and all.
6. Do not spoil the ending in the topic itself. "the ending of X explained" is
   the promise; giving the ending away in the topic spends it.
7. No two on the same work, and vary the angle across the batch.
8. No ratings, no rankings, no "top 10", no recommendations lists.
${avoid.length === 0 ? '' : `9. Avoid anything close to these, already suggested:${NEWLINE}${avoid.map((topic) => `   - ${topic}`).join(NEWLINE)}`}

Return a JSON array of ${count} strings.`;
}

/**
 * The matchup format, with the one rule that keeps it from being nonsense: the
 * comparison has to be decidable from real properties. "Who would win" is a
 * genuinely good short when both sides have measurable traits and a stated
 * arena, and it is unwatchable when it is two invented power levels.
 */
function buildVersusPrompt(
  count: number,
  avoid: readonly string[],
  chosen: { label: string; subjects: readonly string[] },
  hint: string,
): string {
  const subjects = spread(chosen.subjects, count);

  return `Suggest ${count} short "who would win" videos.

One for each line below:
${subjects.map((subject, index) => `${index + 1}. ${subject}`).join(NEWLINE)}
${hintLine(hint)}
${TITLE_RULES}

Rules:
1. Both sides are real and named. Real animals, real historical forces, real
   machines, real record holders. No fictional characters: their abilities are
   whatever the last writer said they were, so the answer is an opinion and the
   video has nothing to stand on.
2. The matchup must be decidable from measurable properties -- bite force, mass,
   speed, armour, reach, range, endurance. If the only way to answer is to make
   something up, it is the wrong matchup.
3. Say the arena or the terms when they decide it. A polar bear against a tiger
   is a different video in snow and in jungle.
4. Plain "X vs Y" phrasing is fine and usually best.
5. Genuinely uncertain, and close. If you already know the answer with
   confidence, so does the viewer, and there is nothing to watch: "cheetah vs
   snail in a race" and "blue whale vs peregrine falcon on speed" are both
   measurable and both settled before the video starts. The two sides must be
   near enough that the answer could go either way.
6. A contest both sides would actually enter. Two filter-feeding whales in a
   "hunger standoff" is not a matchup -- neither one competes with the other for
   anything. There has to be a real reason they are opposed: the same prey, the
   same ground, the same job, or a predator that genuinely hunts the other.
7. No two matchups sharing a side, and no humans set against each other.
${avoid.length === 0 ? '' : `8. Avoid anything close to these, already suggested:${NEWLINE}${avoid.map((topic) => `   - ${topic}`).join(NEWLINE)}`}

Return a JSON array of ${count} strings.`;
}

function buildPrompt(
  count: number,
  avoid: readonly string[],
  category: string,
  hint: string,
): string {
  const chosen = CATEGORIES[category] ?? CATEGORIES['any']!;
  if (chosen.kind === 'work') return buildWorkPrompt(count, avoid, chosen, hint);
  if (chosen.kind === 'versus') return buildVersusPrompt(count, avoid, chosen, hint);
  const subjects = spread(chosen.subjects, count);
  /**
   * The angles are a palette, not a per-line pairing.
   *
   * Pairing one angle to each subject produced contradictions the model then
   * had to resolve — "counterfeits and forgeries" against "a documented finding
   * about the human body" — and it resolved them by following the angle and
   * dropping the area. Measured: asking for money returned the Svalbard seed
   * vault and a Victorian hair wreath; asking for the body returned Svalbard
   * again. Offering several angles loosely lets the model take one that
   * actually fits the area, which is the only way both constraints hold at once.
   *
   * Several rather than one, because a single angle made every topic in the
   * batch the same sentence: one round came back as eight consecutive
   * "the last ..." lines, which reads as a template rather than as eight ideas.
   */
  const angles = pick(APPETITES, 4);

  return `Suggest ${count} topics for short vertical videos.

One topic for each area below. The area binds: if someone read the topic and had
to guess which area it came from, they should guess that one.
${subjects.map((subject, index) => `${index + 1}. ${subject}`).join(NEWLINE)}
${hintLine(hint)}

Make them worth watching. Across the batch use a range of these angles —
whichever genuinely fits the area, never forcing one that does not:
${angles.map((angle) => `- ${angle}`).join(NEWLINE)}

${TITLE_RULES}

The test every topic must pass:
Someone is scrolling. They see this topic as the first line on screen. Do they
stop? If the honest answer is "only if they already like this sort of thing",
it has failed. Write a different one.

Rules:
1. TRUE, and specifically true. Every topic must point at a real event, person,
   place or finding that is well documented. Before you write one, name the real
   thing it refers to in your head; if you cannot, you are inventing it, and you
   must choose something else. A made-up topic is the worst thing you can return
   here — worse than a dull one — because a narrator will state it as fact. Do
   not invent a survivor, a last-of-its-kind, a sealed room, or a number.
2. Anchored. Most topics should carry a proper noun — a person, place, ship,
   mission, company, species or year. A topic with nothing nameable in it is
   exactly where invention happens, and it is the pattern behind every false
   suggestion this has ever produced. At most two of the ${count} may be
   unanchored, and those two must still be facts you could cite.
3. Vary the sentence shape across the batch. Not every topic starts "the last"
   or "the man who". If more than two begin the same way, rewrite them.
4. No conspiracy framing. Do not claim any agency, company or government
   faked, staged or falsified something unless it is an admitted, documented
   fact with a name attached. "NASA faked the Apollo sample weights" is the
   exact shape of the failure: it sounds like the true declassified stories
   beside it and is not one. Cover-ups are allowed only where the exposure is
   itself a matter of record.
5. Lowercase except proper nouns, no ending punctuation.
6. It must promise something specific, and something the narration can actually deliver in 40 seconds. A promise the video cannot keep is worse than a dull topic.
7. Prefer a person, a place, a body, a number, or a consequence. "the man who", "the room where", "what happens when", "the last", "nobody has ever".
8. Concrete over abstract. Not "the psychology of risk" but "the diver who went down and never came back up".
9. No standards, no committees, no units of measurement, no how-something-is-defined, no how-something-became-regulated. These read as museum placards. This is the single most common failure.
10. No listicles, no "top 10", no self-help, no productivity advice, no current events that expire.
11. Nothing about the pyramids, the Titanic, Rome falling, Nikola Tesla, the Great Wall, honey never spoiling, bananas being berries, the Mariana Trench, or Schrodinger's cat. Everyone has seen those.
${avoid.length === 0 ? '' : `12. Avoid anything close to these, which have already been suggested:${NEWLINE}${avoid.map((topic) => `   - ${topic}`).join(NEWLINE)}`}

Return a JSON array of ${count} strings.`;
}

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: { type: 'string' },
};

const topicsSchema = z.array(z.string().min(3).max(120)).min(1);

/** Like the script stage's stripFences, but for a response whose root is an array. */
function extractArray(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`model response contains no JSON array: ${raw.slice(0, 200)}`);
  }
  return text.slice(start, end + 1);
}

/**
 * Deliberately not cached and not seeded from the topic: this is a brainstorm
 * button, and getting the same eight ideas twice would make it useless. Cost
 * is one Flash-Lite call, the same order as a script draft.
 */
export async function suggestTopics(
  count: number,
  avoid: readonly string[] = [],
  category = 'any',
  hint = '',
): Promise<TopicSuggestions> {
  const response = await generate({
    model: MODELS.llm.script,
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt: buildPrompt(count, avoid.slice(-24), category, hint),
    temperature: 1.1,
    seed: toInt32Seed(Date.now()),
    maxOutputTokens: 1024,
    responseSchema: RESPONSE_SCHEMA,
  });

  const parsed = topicsSchema.parse(JSON.parse(extractArray(response.text)));
  const topics = [...new Set(parsed.map((topic) => topic.trim()))].slice(0, count);

  const usd = priceOf(response.model, response.inputTokens, response.outputTokens);
  return {
    topics,
    model: response.model,
    usd: Number.isFinite(usd) ? usd : null,
  };
}
