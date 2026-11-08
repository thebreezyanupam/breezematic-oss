/**
 * A stick figure with joints, and the poses it can hold.
 *
 * The figure is a skeleton, not a drawing: every limb is two segments hinged at
 * a joint, and a pose is nothing but the angles. That is what separates this
 * from the whiteboard mode — there is no picture being revealed, the body is
 * computed each frame, so it can genuinely walk, point, fall and get up.
 *
 * Angles are degrees, clockwise, measured from straight down, so 0 is a limb
 * hanging and 180 is a limb raised. Every angle is absolute rather than
 * relative to its parent: relative angles are tidier to compose but they make a
 * pose impossible to read as numbers, and every pose below was arrived at by
 * reading the numbers rather than by dragging anything.
 */

export type Pose = {
  /** Vertical bob of the hips, in rig units. Negative is up. */
  hipY: number;
  /** Torso lean, degrees. Positive leans forward. */
  lean: number;
  /** [upper, fore] for each arm. */
  armL: readonly [number, number];
  armR: readonly [number, number];
  /** [thigh, shin] for each leg. */
  legL: readonly [number, number];
  legR: readonly [number, number];
  /** Head tilt, degrees. */
  head: number;
  /**
   * Half the width across the shoulders and across the hips, rig units, signed
   * so the L limbs sit on the positive side. The authored actions are side
   * views and leave these out (both arms from one point); a pose taken from a
   * person facing the camera needs them, or an arm raised straight up goes
   * through the middle of the head.
   */
  shoulders?: number;
  hips?: number;
};

/** Limb lengths, in rig units. The figure stands about 100 units tall. */
export const RIG = {
  /**
   * A big head, on purpose: it carries a face now -- eyes, brows, a mouth, the
   * whole expression -- and a face on a nine-unit head is a smudge at phone
   * size. Chibi proportions are also what makes the figure read as a
   * character rather than a diagram.
   */
  headR: 14,
  neck: 4,
  torso: 30,
  upperArm: 17,
  foreArm: 16,
  thigh: 19,
  shin: 18,
  stroke: 4.2,
} as const;

const STAND: Pose = {
  hipY: 0,
  lean: 0,
  armL: [8, 6],
  armR: [-8, -6],
  legL: [6, 4],
  legR: [-6, -4],
  head: 0,
};

const pose = (patch: Partial<Pose>): Pose => ({ ...STAND, ...patch });

/**
 * An action is keyframes plus whether it repeats.
 *
 * Looping actions (walking, thinking) are cycles and read wrong if they play
 * once and stop; one-shot actions (falling, pointing) read wrong if they
 * repeat. Getting that backwards is the difference between a figure that walks
 * and a figure that twitches.
 */
export type Action = {
  keys: readonly Pose[];
  loop: boolean;
  /** Cycles per second when looping. */
  rate?: number;
};

export const ACTIONS: Record<string, Action> = {
  stand: { keys: [STAND, pose({ hipY: -1.2, head: 1 }), STAND], loop: true, rate: 0.4 },

  walk: {
    loop: true,
    rate: 1.6,
    keys: [
      pose({ legL: [28, 18], legR: [-26, -8], armL: [-22, -14], armR: [24, 14], lean: 6 }),
      pose({ legL: [0, 6], legR: [0, 4], armL: [0, 2], armR: [0, -2], lean: 6, hipY: -2 }),
      pose({ legL: [-26, -8], legR: [28, 18], armL: [24, 14], armR: [-22, -14], lean: 6 }),
      pose({ legL: [0, 4], legR: [0, 6], armL: [0, -2], armR: [0, 2], lean: 6, hipY: -2 }),
    ],
  },

  run: {
    loop: true,
    rate: 2.8,
    keys: [
      pose({ legL: [46, 30], legR: [-40, -46], armL: [-52, -70], armR: [56, 74], lean: 18, hipY: -3 }),
      pose({ legL: [6, 40], legR: [6, 20], armL: [6, -30], armR: [-6, 30], lean: 18, hipY: -7 }),
      pose({ legL: [-40, -46], legR: [46, 30], armL: [56, 74], armR: [-52, -70], lean: 18, hipY: -3 }),
      pose({ legL: [6, 20], legR: [6, 40], armL: [-6, 30], armR: [6, -30], lean: 18, hipY: -7 }),
    ],
  },

  point: {
    loop: false,
    keys: [
      STAND,
      pose({ armR: [-78, -88], head: -6, lean: 3 }),
      pose({ armR: [-84, -92], head: -7, lean: 4 }),
    ],
  },

  think: {
    loop: true,
    rate: 0.5,
    keys: [
      pose({ armR: [-52, -128], head: -10, lean: -3 }),
      pose({ armR: [-50, -132], head: -13, lean: -3, hipY: -1 }),
    ],
  },

  fall: {
    loop: false,
    keys: [
      STAND,
      pose({ lean: -22, armL: [64, 40], armR: [-66, -42], legL: [-16, 10], hipY: -3 }),
      pose({ lean: -62, armL: [96, 62], armR: [-98, -60], legL: [-34, 22], legR: [26, 16], hipY: 12 }),
      pose({ lean: -86, armL: [108, 40], armR: [-110, -38], legL: [-48, 8], legR: [44, 10], hipY: 26 }),
    ],
  },

  jump: {
    loop: false,
    keys: [
      pose({ legL: [22, 44], legR: [-22, -44], hipY: 10, lean: 10, armL: [34, 18], armR: [-34, -18] }),
      pose({ legL: [4, 6], legR: [-4, -6], hipY: -16, armL: [-64, -30], armR: [64, 30], lean: -4 }),
      pose({ legL: [16, 28], legR: [-16, -28], hipY: -6, armL: [-30, -12], armR: [30, 12] }),
    ],
  },

  reach: {
    loop: false,
    keys: [
      STAND,
      pose({ armL: [-24, -40], armR: [-58, -76], lean: 8, head: -4 }),
      pose({ armL: [-30, -48], armR: [-70, -88], lean: 12, head: -6, hipY: -2 }),
    ],
  },

  push: {
    loop: true,
    rate: 0.8,
    keys: [
      pose({ armL: [-66, -84], armR: [-70, -86], lean: 22, legL: [22, 12], legR: [-16, -18] }),
      pose({ armL: [-72, -90], armR: [-76, -92], lean: 28, legL: [28, 16], legR: [-20, -22], hipY: 2 }),
    ],
  },

  celebrate: {
    loop: true,
    rate: 1.2,
    keys: [
      pose({ armL: [-140, -160], armR: [140, 160], hipY: -6, head: 4 }),
      pose({ armL: [-120, -150], armR: [120, 150], hipY: 2, head: -2 }),
    ],
  },

  search: {
    loop: true,
    rate: 0.55,
    keys: [
      pose({ armR: [-40, -104], head: -16, lean: 6 }),
      pose({ armR: [-40, -104], head: 16, lean: 6 }),
    ],
  },

  sit: {
    loop: true,
    rate: 0.35,
    keys: [
      // hipY 14, not 20: at 20 the shins reached seven units below the floor
      // and the figure sank into the ground it was sitting over.
      pose({ hipY: 14, legL: [-76, -4], legR: [-70, 6], armL: [-20, -60], armR: [-26, -66], lean: -6 }),
      pose({ hipY: 15, legL: [-76, -4], legR: [-70, 6], armL: [-18, -62], armR: [-24, -68], lean: -5, head: 3 }),
    ],
  },

  carry: {
    loop: true,
    rate: 0.9,
    keys: [
      pose({ armL: [-58, -96], armR: [-62, -98], lean: -8, legL: [10, 8], legR: [-10, -8] }),
      pose({ armL: [-56, -94], armR: [-60, -96], lean: -9, hipY: -2, legL: [-8, 6], legR: [8, 6] }),
    ],
  },

  shrug: {
    loop: false,
    keys: [
      STAND,
      pose({ armL: [-42, -96], armR: [42, 96], head: -4 }),
      pose({ armL: [-46, -104], armR: [46, 104], head: 3, hipY: -2 }),
    ],
  },

  /** A hand up and swinging: hello, or look over here. */
  wave: {
    loop: true,
    rate: 1.6,
    keys: [
      pose({ armR: [-150, -160], head: -4 }),
      pose({ armR: [-150, -205], head: -2, hipY: -1 }),
    ],
  },

  /** Explaining something: both hands moving, a nod in it. */
  talk: {
    loop: true,
    rate: 0.9,
    keys: [
      pose({ armL: [22, -40], armR: [-38, -86], head: -3 }),
      pose({ armL: [18, -70], armR: [-30, -112], head: 3, hipY: -1 }),
      pose({ armL: [26, -30], armR: [-44, -76], head: -1 }),
    ],
  },

  /** Shrinking from something: knees bent, arms up over the face. */
  cower: {
    loop: false,
    keys: [
      STAND,
      pose({ hipY: 6, lean: 4, armL: [-96, 150], armR: [-88, 160], legL: [-18, 16], legR: [16, 34], head: 10 }),
      pose({ hipY: 9, lean: 6, armL: [-100, 146], armR: [-92, 156], legL: [-22, 18], legR: [20, 40], head: 12 }),
    ],
  },

  /** Holding a book open in front, head down into it. */
  read: {
    loop: true,
    rate: 0.3,
    keys: [
      pose({ armL: [-34, -118], armR: [-44, -128], head: 14, lean: 2 }),
      pose({ armL: [-34, -120], armR: [-44, -130], head: 16, lean: 2, hipY: -0.6 }),
    ],
  },

  /** The hand that comes up to meet the face. */
  facepalm: {
    loop: false,
    keys: [
      STAND,
      pose({ armR: [-30, -150], head: 8, lean: 3 }),
      pose({ armR: [-22, -168], head: 14, lean: 5, hipY: 1 }),
    ],
  },

  /** Down on one knee: grief, a vow, exhaustion. */
  kneel: {
    loop: false,
    keys: [
      STAND,
      pose({ hipY: 9, legL: [-50, -10], legR: [6, 50], lean: 4, head: 6 }),
      pose({ hipY: 16, legL: [-82, -2], legR: [8, 92], lean: 6, head: 10, armL: [-10, -40], armR: [-14, -8] }),
    ],
  },

  /** Hands on hips, chest out: pleased with itself. */
  proud: {
    loop: true,
    rate: 0.35,
    keys: [
      pose({ armL: [42, -42], armR: [-42, 42], head: -6, lean: -3 }),
      pose({ armL: [44, -40], armR: [-44, 40], head: -8, lean: -4, hipY: -1 }),
    ],
  },
};

export const ACTION_NAMES = Object.keys(ACTIONS);

/** Degrees to an offset, measured clockwise from straight down. */
function limb(angleDeg: number, length: number): { x: number; y: number } {
  const r = (angleDeg * Math.PI) / 180;
  return { x: Math.sin(r) * length, y: Math.cos(r) * length };
}

type Point = { x: number; y: number };

export type Skeleton = {
  head: { x: number; y: number; r: number };
  bones: readonly (readonly [number, number, number, number])[];
  /** Where things are held and worn: props go in a hand, a scarf at the neck. */
  joints: {
    hip: Point;
    shoulder: Point;
    neck: Point;
    handL: Point;
    handR: Point;
    footL: Point;
    footR: Point;
  };
};

/**
 * Forward kinematics: a pose becomes points. The hip is the origin and +y is
 * down, so the whole figure is placed by translating a single point.
 */
export function skeletonOf(p: Pose): Skeleton {
  const hip = { x: 0, y: p.hipY };
  /**
   * The figure faces -x: every "forward" arm angle in the poses is negative.
   * The lean was written as 180 - lean, which tipped a positive (forward) lean
   * toward +x -- the back -- so `push` leaned away from what it pushed. Now a
   * forward lean goes the way the arms do.
   */
  const up = limb(180 + p.lean, RIG.torso);
  const shoulder = { x: hip.x + up.x, y: hip.y + up.y };
  const neckV = limb(180 + p.lean, RIG.neck);
  const neck = { x: shoulder.x + neckV.x, y: shoulder.y + neckV.y };
  const headV = limb(180 + p.lean + p.head, RIG.headR);
  const head = { x: neck.x + headV.x, y: neck.y + headV.y, r: RIG.headR };

  // Across the body: perpendicular to the torso, so the shoulders tilt with a lean.
  const leanRad = (p.lean * Math.PI) / 180;
  const across = { x: Math.cos(leanRad), y: -Math.sin(leanRad) };
  const side = (from: Point, half: number | undefined, sign: number): Point =>
    half === undefined ? from : { x: from.x + across.x * half * sign, y: from.y + across.y * half * sign };
  const shoulderL = side(shoulder, p.shoulders, 1);
  const shoulderR = side(shoulder, p.shoulders, -1);
  const hipL = side(hip, p.hips, 1);
  const hipR = side(hip, p.hips, -1);

  const arm = (a: readonly [number, number], from: Point) => {
    const u = limb(a[0], RIG.upperArm);
    const elbow = { x: from.x + u.x, y: from.y + u.y };
    const f = limb(a[1], RIG.foreArm);
    return { elbow, hand: { x: elbow.x + f.x, y: elbow.y + f.y } };
  };
  const leg = (a: readonly [number, number], from: Point) => {
    const t = limb(a[0], RIG.thigh);
    const knee = { x: from.x + t.x, y: from.y + t.y };
    const s = limb(a[1], RIG.shin);
    return { knee, foot: { x: knee.x + s.x, y: knee.y + s.y } };
  };

  const aL = arm(p.armL, shoulderL);
  const aR = arm(p.armR, shoulderR);
  const lL = leg(p.legL, hipL);
  const lR = leg(p.legR, hipR);
  const girdles: (readonly [number, number, number, number])[] = [];
  if (p.shoulders !== undefined) girdles.push([shoulderL.x, shoulderL.y, shoulderR.x, shoulderR.y]);
  if (p.hips !== undefined) girdles.push([hipL.x, hipL.y, hipR.x, hipR.y]);

  return {
    head,
    joints: { hip, shoulder, neck, handL: aL.hand, handR: aR.hand, footL: lL.foot, footR: lR.foot },
    bones: [
      [hip.x, hip.y, shoulder.x, shoulder.y],
      [shoulder.x, shoulder.y, neck.x, neck.y],
      ...girdles,
      [shoulderL.x, shoulderL.y, aL.elbow.x, aL.elbow.y],
      [aL.elbow.x, aL.elbow.y, aL.hand.x, aL.hand.y],
      [shoulderR.x, shoulderR.y, aR.elbow.x, aR.elbow.y],
      [aR.elbow.x, aR.elbow.y, aR.hand.x, aR.hand.y],
      [hipL.x, hipL.y, lL.knee.x, lL.knee.y],
      [lL.knee.x, lL.knee.y, lL.foot.x, lL.foot.y],
      [hipR.x, hipR.y, lR.knee.x, lR.knee.y],
      [lR.knee.x, lR.knee.y, lR.foot.x, lR.foot.y],
    ],
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpPair = (
  a: readonly [number, number],
  b: readonly [number, number],
  t: number,
): [number, number] => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

function blend(a: Pose, b: Pose, t: number): Pose {
  return {
    hipY: lerp(a.hipY, b.hipY, t),
    lean: lerp(a.lean, b.lean, t),
    armL: lerpPair(a.armL, b.armL, t),
    armR: lerpPair(a.armR, b.armR, t),
    legL: lerpPair(a.legL, b.legL, t),
    legR: lerpPair(a.legR, b.legR, t),
    head: lerp(a.head, b.head, t),
  };
}

/** Eases so a one-shot action arrives rather than sliding to a halt. */
const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * The pose of a named action at a moment. `progress` runs 0..1 across the beat
 * and drives one-shot actions; looping actions count cycles from `seconds`.
 */
export function poseAt(name: string, progress: number, seconds: number): Pose {
  const action = ACTIONS[name] ?? ACTIONS['stand']!;
  const keys = action.keys;
  if (keys.length === 1) return keys[0]!;

  if (action.loop) {
    const cycles = seconds * (action.rate ?? 1);
    const spot = ((cycles % 1) + 1) % 1;
    const scaled = spot * keys.length;
    const index = Math.floor(scaled) % keys.length;
    const next = (index + 1) % keys.length;
    return blend(keys[index]!, keys[next]!, scaled - Math.floor(scaled));
  }

  const clamped = Math.min(1, Math.max(0, progress));
  const scaled = easeInOut(clamped) * (keys.length - 1);
  const index = Math.min(keys.length - 2, Math.floor(scaled));
  return blend(keys[index]!, keys[index + 1]!, scaled - index);
}
