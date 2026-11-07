import { walk, wiggle } from './cut.js';

/* Shared fold geometry for the WebGL renderer and Canvas 2D previews. */

export const CORNER = { tl: 0, tr: 1, br: 2, bl: 3 };
export const OPPOSITE = { tl: 'br', tr: 'bl', br: 'tl', bl: 'tr' };

// fold line through two points of the outline, normal towards point k
function line(p1, p2, k) {
  let nx = -(p2[1] - p1[1]), ny = p2[0] - p1[0];
  const len = Math.hypot(nx, ny) || 1;
  nx /= len; ny /= len;
  if ((k[0] - p1[0]) * nx + (k[1] - p1[1]) * ny < 0) { nx = -nx; ny = -ny; }
  return { F: p1, n: [nx, ny] };
}

// fold of corner ci whose legs run L1 back along the outline and L2 forward
function legs(poly, ci, L1, L2) {
  return line(walk(poly, ci, -1, L1), walk(poly, ci, 1, L2), poly[ci]);
}

// The unfurl entry: the corner starts folded far over (the fold line a third
// of the way along the strip, the flap pointing up and back), runs out to two
// thirds, then to a big dog-ear, then to the resting one. Lines are blended as
// (offset from the strip centre, angle of the normal).
function unfurl(shape, corner, s, rest, shakeC) {
  const { anchor: O, w } = shape;
  const sx = corner === 'br' || corner === 'tr' ? 1 : -1, sy = corner === 'br' || corner === 'bl' ? 1 : -1;
  const at = (x, deg) => {
    const a = deg * Math.PI / 180;
    return { F: [O[0] + sx * x * w, O[1]], n: [sx * Math.cos(a), sy * Math.sin(a)] };
  };
  const keys = [at(-0.16, 21), at(0.18, 24), rest(2.2), rest(1)];
  const stops = [0, 0.4, 0.75, 1];
  let i = 0;
  while (i < 2 && s > stops[i + 1]) i++;
  const u = Math.min(1, Math.max(0, (s - stops[i]) / (stops[i + 1] - stops[i])));
  const canon = (f) => ({ c: (f.F[0] - O[0]) * f.n[0] + (f.F[1] - O[1]) * f.n[1], a: Math.atan2(f.n[1], f.n[0]) });
  const a = canon(keys[i]), b = canon(keys[i + 1]);
  let da = b.a - a.a;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const ang = a.a + da * u, c = a.c + (b.c - a.c) * u + (s < 0.75 ? shakeC * w : 0);
  const n = [Math.cos(ang), Math.sin(ang)];
  return { F: [O[0] + n[0] * c, O[1] + n[1] * c], n };
}

/**
 * shape: { poly: [[x, y]...] clockwise, corners: [i of tl, tr, br, bl], anchor: [x, y] centre, w, h }
 * curl:  the strip's curl settings (or false), pose: an entry pose (or null),
 * seed:  the strip's seed, tq: time in seconds, already stepped.
 * Returns { folds: [resting fold, second fold], shake } where a fold is
 * { F: point on the line, n: unit normal towards the corner, R: radius } or
 * null, and shake scales how far the flap's shadow falls.
 */
export function foldsAt(shape, curl, pose, seed, tq) {
  const folds = [null, null];
  if (!curl) return { folds, shake: 1 };
  const C = curl, ws = (seed | 0) * 17;
  const corner = C.corner in CORNER ? C.corner : 'br';
  const ci = shape.corners[CORNER[corner]];
  const base = C.size * Math.min(shape.w, shape.h), j = 0.07 * C.jitter;
  const w1 = wiggle(ws + 1, tq, C.freq), w2 = wiggle(ws + 2, tq, C.freq);
  const rest = (grow) => legs(shape.poly, ci, base * 1.1 * grow * (1 + j * w1), base * 0.85 * grow * (1 + j * w2));
  const br = pose && pose.br;
  let f, size = base;
  if (br && br.path != null) {
    f = unfurl(shape, corner, br.path, rest, 0.008 * wiggle(ws + 5, tq, 2.5));
    size = base * 2;
  } else {
    const grow = br && br.grow ? br.grow : 1;
    f = rest(grow);
    size = base * grow;
  }
  folds[0] = { ...f, R: Math.max(C.radius * size, 0.6) };

  // the entry's second fold sits on the opposite corner. Its legs are in
  // strip heights; walking back from the top-left corner goes down the left
  // side, forward goes along the top
  const tl = pose && pose.tl;
  if (tl && tl.top > 1e-3 && tl.side > 1e-3) {
    const oi = shape.corners[CORNER[OPPOSITE[corner]]];
    // on a short strip, keep the fold to under half of it
    const k = Math.min(1, (0.45 * shape.w) / (tl.top * shape.h));
    const side = tl.side * shape.h * k, top = tl.top * shape.h * k;
    const g = corner === 'br' || corner === 'tl' ? legs(shape.poly, oi, side, top) : legs(shape.poly, oi, top, side);
    folds[1] = { ...g, R: Math.max(0.035 * Math.min(side, top), 0.6) };
  }
  return { folds, shake: C.lift * (1 + 0.45 * C.jitter * wiggle(ws + 3, tq, C.freq)) };
}
