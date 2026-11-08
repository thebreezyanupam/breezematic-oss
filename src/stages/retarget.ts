import { RIG, skeletonOf, type Pose } from '../remotion/stickman/rig.js';
import type { MotionTrack } from './motion.js';

/**
 * A tracked person, turned into the stick figure's poses.
 *
 * The figure's rig is absolute limb angles (rig.ts), and a 2D skeleton is
 * absolute limb directions, so most of this is atan2: the angle of the upper
 * arm is the angle from shoulder to elbow, the shin from knee to ankle. What
 * the angles cannot carry is where the person is and how big the camera has
 * them, and that comes separately:
 *
 *   x        where the hips are across the frame
 *   scale    how big the body is, from the torso -- the one segment that is
 *            rarely pointed at the camera
 *   ground   the floor line under the standing foot
 *   hipY     how high the hips are above it, which is what makes a crouch a
 *            crouch and a jump leave the ground
 *
 * The rig's proportions are not a person's (the head is enormous, the legs
 * short), so position is not copied joint by joint: the standing foot is put
 * on the floor and the rest of the body is built up from it. A kicked foot
 * that comes toward the camera drops lower in the frame than the standing one;
 * on a drawn floor that simply reads as nearer, which is what it is.
 *
 * Tracking jitters by a pixel or two every frame. That is invisible on a
 * person and violent on a line drawing, so every point goes through a One Euro
 * filter first: heavy smoothing when a joint is still, almost none when it
 * moves fast, so holds are steady and hits stay sharp.
 */

export type MimicFrame = {
  /** Hip position across the output frame, px. */
  x: number;
  /** The floor line, px. */
  ground: number;
  /** Output px per rig unit. */
  scale: number;
  pose: Pose;
  /** How fast the hands and feet are moving, 0..1: drives trails and accents. */
  energy: number;
};

// COCO keypoint order (motion.ts).
const EAR_L = 3, EAR_R = 4, SH_L = 5, SH_R = 6, EL_L = 7, EL_R = 8, WR_L = 9, WR_R = 10;
const HIP_L = 11, HIP_R = 12, KN_L = 13, KN_R = 14, AN_L = 15, AN_R = 16;

const MIN_CONFIDENCE = 0.3;

type P = { x: number; y: number };

/** One Euro filter (Casiez et al. 2012), per coordinate. */
class OneEuro {
  private x: number | null = null;
  private dx = 0;
  constructor(
    private readonly rate: number,
    private readonly minCutoff: number,
    private readonly beta: number,
  ) {}
  private alpha(cutoff: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau * this.rate);
  }
  next(value: number): number {
    if (this.x === null) {
      this.x = value;
      return value;
    }
    const raw = (value - this.x) * this.rate;
    this.dx += this.alpha(1) * (raw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cutoff) * (value - this.x);
    return this.x;
  }
}

/**
 * Fills the frames where a joint was not seen (or nobody was) by joining the
 * frames either side, so a hand that goes behind the back does not snap to
 * the origin and back.
 */
function fill(track: MotionTrack): P[][] {
  const count = track.frames.length;
  const aspect = track.width / track.height;
  const joints: P[][] = Array.from({ length: count }, () => []);
  for (let k = 0; k < 17; k++) {
    const seen: (P | null)[] = track.frames.map((frame) =>
      frame !== null && frame[k * 3 + 2]! >= MIN_CONFIDENCE ? { x: frame[k * 3]! * aspect, y: frame[k * 3 + 1]! } : null,
    );
    const firstSeen = seen.findIndex((p) => p !== null);
    for (let i = 0; i < count; i++) {
      let point = seen[i];
      if (point == null) {
        let before = i - 1;
        while (before >= 0 && seen[before] == null) before--;
        let after = i + 1;
        while (after < count && seen[after] == null) after++;
        const a = before >= 0 ? seen[before]! : null;
        const b = after < count ? seen[after]! : null;
        if (a !== null && b !== null) {
          const t = (i - before) / (after - before);
          point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        } else {
          point = a ?? b ?? (firstSeen >= 0 ? seen[firstSeen]! : { x: aspect / 2, y: 0.5 });
        }
      }
      joints[i]![k] = point;
    }
  }
  return joints;
}

function smooth(joints: P[][], fps: number): P[][] {
  // Units are frame heights: a cutoff of 1.4 Hz holds a still joint steady,
  // and beta lets a joint moving a frame-height a second through almost raw.
  const filters = Array.from({ length: 17 }, () => [new OneEuro(fps, 1.4, 1.2), new OneEuro(fps, 1.4, 1.2)] as const);
  return joints.map((frame) => frame.map((p, k) => ({ x: filters[k]![0].next(p.x), y: filters[k]![1].next(p.y) })));
}

const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/** The rig's angle convention: clockwise from straight down, degrees. */
const angleOf = (from: P, to: P): number => (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
const wrap = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180;

/** Keeps a run of angles continuous, so blending two frames never spins the long way round. */
function unwrapNear(angle: number, previous: number | undefined): number {
  if (previous === undefined) return angle;
  return previous + wrap(angle - previous);
}

function window<T>(values: readonly T[], i: number, radius: number): T[] {
  return values.slice(Math.max(0, i - radius), Math.min(values.length, i + radius + 1));
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]!;
}

export function retarget(
  track: MotionTrack,
  output: { width: number; height: number; fps: number },
): MimicFrame[] {
  if (track.frames.length === 0) return [];
  const joints = smooth(fill(track), track.fps);

  // Cover-fit the source onto the output frame: source units are frame
  // heights, so one source unit is `fit` output px.
  const aspect = track.width / track.height;
  const fit = Math.max(output.width / aspect, output.height);
  const offsetX = (output.width - aspect * fit) / 2;
  const offsetY = (output.height - fit) / 2;
  const toOut = (p: P): P => ({ x: offsetX + p.x * fit, y: offsetY + p.y * fit });

  const count = joints.length;
  const radius = Math.round(track.fps * 0.6);

  // Body size from the torso, robust to the moments it leans at the camera.
  const torso = joints.map((j) => {
    const s = mid(j[SH_L]!, j[SH_R]!);
    const h = mid(j[HIP_L]!, j[HIP_R]!);
    return Math.hypot(s.x - h.x, s.y - h.y);
  });
  const torsoSteady = torso.map((_, i) => percentile(window(torso, i, Math.round(track.fps)), 0.75));

  // The standing foot is the slower one; the floor is where it rests.
  const speed = (k: number, i: number): number =>
    i === 0 ? 0 : Math.hypot(joints[i]![k]!.x - joints[i - 1]![k]!.x, joints[i]![k]!.y - joints[i - 1]![k]!.y);
  const stance = joints.map((_, i) => {
    const near = window(Array.from({ length: count }, (__, n) => n), i, 2);
    const left = near.reduce((sum, n) => sum + speed(AN_L, n), 0);
    const right = near.reduce((sum, n) => sum + speed(AN_R, n), 0);
    return left <= right ? AN_L : AN_R;
  });
  const stanceY = joints.map((j, i) => j[stance[i]!]!.y);
  // A jump lifts the standing foot too, so the floor is the low end of where
  // that foot has been recently, not where it is now.
  const floor = stanceY.map((_, i) => percentile(window(stanceY, i, radius), 0.8));

  const energyRaw = joints.map((_, i) =>
    Math.max(...[WR_L, WR_R, AN_L, AN_R].map((k) => speed(k, i))) * track.fps / Math.max(0.05, torsoSteady[i]!),
  );

  const perSource: MimicFrame[] = [];
  let last: Pose | undefined;
  for (let i = 0; i < count; i++) {
    const j = joints[i]!;
    const shoulder = mid(j[SH_L]!, j[SH_R]!);
    const hip = mid(j[HIP_L]!, j[HIP_R]!);
    // The ears are the middle of the head; the nose is its front.
    const headAt = mid(j[EAR_L]!, j[EAR_R]!);

    const lean = unwrapNear(wrap(angleOf(hip, shoulder) - 180), last?.lean);
    const head = Math.max(-35, Math.min(35, wrap(angleOf(shoulder, headAt) - 180 - lean)));
    const pair = (a: number, b: number, c: number, prev: readonly [number, number] | undefined): [number, number] => [
      unwrapNear(angleOf(j[a]!, j[b]!), prev?.[0]),
      unwrapNear(angleOf(j[b]!, j[c]!), prev?.[1]),
    ];
    // The person's left is on screen right when they face the camera; the rig
    // draws whichever side it is told, so screen sides are kept as they are.
    const armL = pair(SH_L, EL_L, WR_L, last?.armL);
    const armR = pair(SH_R, EL_R, WR_R, last?.armR);
    const legL = pair(HIP_L, KN_L, AN_L, last?.legL);
    const legR = pair(HIP_R, KN_R, AN_R, last?.legR);

    const scale = (torsoSteady[i]! * fit) / RIG.torso;
    // Shoulder and hip width as the camera sees them: full facing it, nothing
    // side-on, negative turned away. Measured across the torso, in rig units.
    const leanRad = (lean * Math.PI) / 180;
    const across = (a: P, b: P, limit: number): number => {
      const half = (((a.x - b.x) / 2) * Math.cos(leanRad) - ((a.y - b.y) / 2) * Math.sin(leanRad)) * fit / scale;
      return Math.max(-limit, Math.min(limit, half));
    };
    const shoulders = across(j[SH_L]!, j[SH_R]!, 13);
    const hips = across(j[HIP_L]!, j[HIP_R]!, 8);
    // Stand the standing foot on the floor, then lift the body by however far
    // that foot is off it.
    const rest = skeletonOf({ hipY: 0, lean, head, armL, armR, legL, legR, shoulders, hips });
    const standing = stance[i] === AN_L ? rest.joints.footL : rest.joints.footR;
    const feet = RIG.thigh + RIG.shin;
    const lift = Math.max(0, ((floor[i]! - stanceY[i]!) * fit) / scale - 1.2);
    const pose: Pose = { hipY: feet - standing.y - lift, lean, head, armL, armR, legL, legR, shoulders, hips };
    last = pose;

    const hipOut = toOut(hip);
    perSource.push({
      x: hipOut.x,
      ground: toOut({ x: 0, y: floor[i]! }).y,
      scale,
      pose,
      energy: Math.min(1, Math.max(0, (energyRaw[i]! - 1) / 3.5)),
    });
  }

  // The output's frame rate is not the clip's: sample between source frames.
  const duration = count / track.fps;
  const frames = Math.max(1, Math.round(duration * output.fps));
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const lerp2 = (a: readonly [number, number], b: readonly [number, number], t: number): [number, number] => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
  return Array.from({ length: frames }, (_, n) => {
    const at = Math.min(count - 1, (n / output.fps) * track.fps);
    const i = Math.floor(at);
    const a = perSource[i]!;
    const b = perSource[Math.min(count - 1, i + 1)]!;
    const t = at - i;
    return {
      x: lerp(a.x, b.x, t),
      ground: lerp(a.ground, b.ground, t),
      scale: lerp(a.scale, b.scale, t),
      energy: lerp(a.energy, b.energy, t),
      pose: {
        hipY: lerp(a.pose.hipY, b.pose.hipY, t),
        lean: lerp(a.pose.lean, b.pose.lean, t),
        head: lerp(a.pose.head, b.pose.head, t),
        armL: lerp2(a.pose.armL, b.pose.armL, t),
        armR: lerp2(a.pose.armR, b.pose.armR, t),
        legL: lerp2(a.pose.legL, b.pose.legL, t),
        legR: lerp2(a.pose.legR, b.pose.legR, t),
        shoulders: lerp(a.pose.shoulders ?? 0, b.pose.shoulders ?? 0, t),
        hips: lerp(a.pose.hips ?? 0, b.pose.hips ?? 0, t),
      },
    };
  });
}
