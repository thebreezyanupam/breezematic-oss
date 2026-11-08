/**
 * The stick figure world's vocabulary, apart from the drawings, so the server
 * can hand the lists to the model that directs each beat without importing
 * React to do it. The renderers check every word against these and fall back
 * when one is unknown.
 */

export const SCENES = [
  'city',
  'night_city',
  'forest',
  'room',
  'office',
  'library',
  'desert',
  'beach',
  'mountains',
  'space',
  'castle',
  'lab',
  'stage',
] as const;

export const WEATHERS = ['clear', 'rain', 'snow', 'storm', 'fog', 'embers', 'leaves'] as const;

export const EXPRESSIONS = [
  'neutral',
  'happy',
  'laughing',
  'sad',
  'crying',
  'angry',
  'surprised',
  'shocked',
  'scared',
  'thinking',
  'smug',
  'tired',
  'determined',
  'confused',
  'love',
] as const;

export const PROPS = [
  'none',
  'book',
  'sword',
  'torch',
  'lantern',
  'phone',
  'cup',
  'magnifier',
  'briefcase',
  'flag',
  'scroll',
  'moneybag',
  'umbrella',
  'box',
  // Military history. Drawn from the icon set, held upright at the grip.
  'rifle',
  'musket',
  'pistol',
  'grenade',
  'binoculars',
  'shovel',
  'radio',
  'shield',
  'spear',
  'axe',
  'white-flag',
  'map',
  'medal',
] as const;

/**
 * Which icon each military prop is drawn with. One list, read by the figure
 * that draws it and by the credits that name its artist; rifles, muskets and
 * the white flag are drawn by hand and are not in it.
 */
export const PROP_ICON: Readonly<Record<string, string>> = {
  pistol: 'pistol',
  grenade: 'grenade',
  binoculars: 'binoculars',
  shovel: 'shovel',
  radio: 'radio',
  shield: 'shield',
  spear: 'spears',
  axe: 'axe',
  map: 'map',
  medal: 'medal',
};

/** Headgear that comes from the icon set, by the same name. */
export const OUTFIT_ICONS: readonly string[] = ['crown', 'spartan', 'roman', 'viking', 'samurai', 'knight'];

/**
 * Army and friends. "army" is the hero's side drawn in ranks behind it;
 * "enemy-army" is the other side across the field; "armies" is both, facing
 * each other -- a battle.
 */
export const COMPANIONS = ['none', 'friend', 'rival', 'crowd', 'army', 'enemy-army', 'armies'] as const;

/**
 * What the hero (and, separately, the rival and the enemy ranks) wears on
 * its head: the cheapest way to say which war and which side without a word
 * of text. The first group is drawn; the second comes from the icon set.
 */
export const OUTFITS = [
  'none',
  'helmet',
  'pickelhaube',
  'kepi',
  'bicorne',
  'tricorne',
  'officer-cap',
  'beret',
  'crown',
  'spartan',
  'roman',
  'viking',
  'samurai',
  'knight',
] as const;

/**
 * Editing jokes, timed to a word. Used sparingly -- the first freeze-frame is
 * funny and the fifth is a tic.
 *
 *   zoom    a snap zoom onto the face: the punchline, the realisation
 *   freeze  the frame stops and goes grey: "yep, that's me"
 *   shake   the camera shakes: an explosion, a shock
 */
export const GAGS = ['none', 'zoom', 'freeze', 'shake'] as const;

/**
 * Animals, drawn in the figure's own style (creature.tsx). The ones history
 * keeps putting in the story: the emus that beat an army, Hannibal's
 * elephants, the carrier pigeon, Wojtek the bear, the Pig War's pig, the
 * trench rat, the cavalry horse and the camel corps.
 */
export const CREATURES = [
  'none',
  'emu', 'chicken', 'pigeon', 'goose',
  'horse', 'camel', 'elephant', 'dog', 'cat', 'bear', 'goat', 'cow', 'pig', 'rat',
] as const;

/** How many: one animal, a few, or a herd that runs off the edge of the frame. */
export const CREATURE_COUNTS = ['one', 'few', 'herd'] as const;

/**
 * What the animals are doing in the story.
 *
 *   enemy    they charge in from the far side and square up to the hero
 *   ally     they stand or march at the hero's side
 *   wild     they wander and graze in the background, minding their business
 *   fleeing  they run away, off the edge of the frame
 */
export const CREATURE_ROLES = ['enemy', 'ally', 'wild', 'fleeing'] as const;

/** How a painted background names them, in the distance. */
export const CREATURE_PLURAL: Record<string, string> = {
  emu: 'emus', chicken: 'chickens', pigeon: 'pigeons', goose: 'geese', horse: 'horses', camel: 'camels',
  elephant: 'elephants', dog: 'dogs', cat: 'cats', bear: 'bears', goat: 'goats', cow: 'cows', pig: 'pigs', rat: 'rats',
};

/** The two sides of a map or a battle. */
export const SIDES = ['red', 'blue', 'neutral'] as const;
