/* Scissor-cut outlines with sharp corners and padding around the text. */

/** Seeded random numbers in [0, 1) (mulberry32). */
export function rng(seed) {
  let a = (Math.imul(Math.floor(seed) | 0, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// one side, from a to b: a clean cut, a slightly curved one, or one with a kink.
// The outline runs clockwise on screen (y down), so (dy, -dx) points outwards.
function cutEdge(a, b, r, em, room) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (len < em * 0.8) return [];
  const nx = dy / len, ny = -dx / len;
  const at = (t, off) => [a[0] + dx * t + nx * off, a[1] + dy * t + ny * off];
  const k = r();
  if (k < 0.4) return [];
  if (k < 0.72) {
    const out = r() < 0.6;
    const sag = Math.min(em * (0.04 + 0.1 * r()), len * 0.03, out ? Infinity : room) * (out ? 1 : -1);
    const pts = [];
    for (let i = 1; i < 10; i++) { const t = i / 10; pts.push(at(t, sag * 4 * t * (1 - t))); }
    return pts;
  }
  const out = r() < 0.6;
  const off = Math.min(em * (0.03 + 0.08 * r()), out ? Infinity : room) * (out ? 1 : -1);
  return [at(0.25 + 0.5 * r(), off)];
}

/**
 * The strip around a text box { x0, y0, x1, y1 } (px). Returns
 * { points: [[x, y], ...] clockwise, corners: [i of top-left, top-right, bottom-right, bottom-left] }.
 */
export function cutStrip(box, em, seed) {
  const r = rng(seed * 7 + 3);
  const u = (a, b) => a + (b - a) * r();
  const x0 = box.x0 - em * u(0.5, 0.85), x1 = box.x1 + em * u(0.5, 0.85);
  const y0 = box.y0 - em * u(0.32, 0.5), y1 = box.y1 + em * u(0.36, 0.62);
  const tl = [x0, y0], tr = [x1, y0], br = [x1, y1], bl = [x0, y1];
  // each side leans: one of its two corners sticks out further than the other
  const lean = (big) => em * (r() < 0.45 ? u(0, 0.12) : u(0.15, big));
  (r() < 0.5 ? tl : bl)[0] -= lean(0.95);
  (r() < 0.5 ? tr : br)[0] += lean(0.6);
  (r() < 0.5 ? tl : tr)[1] -= lean(0.28);
  (r() < 0.5 ? bl : br)[1] += lean(0.28);
  // and every corner a small nudge outwards
  tl[0] -= em * u(0, 0.06); tl[1] -= em * u(0, 0.06);
  tr[0] += em * u(0, 0.06); tr[1] -= em * u(0, 0.06);
  br[0] += em * u(0, 0.06); br[1] += em * u(0, 0.06);
  bl[0] -= em * u(0, 0.06); bl[1] += em * u(0, 0.06);

  const cs = [tl, tr, br, bl], points = [], corners = [];
  for (let i = 0; i < 4; i++) {
    corners.push(points.length);
    points.push(cs[i]);
    points.push(...cutEdge(cs[i], cs[(i + 1) % 4], r, em, 0.2 * em));
  }
  return { points, corners };
}

/** A highlight patch: a small cut piece that just wraps the box (px). Returns points, clockwise. */
export function cutPatch(box, em, seed) {
  const r = rng(seed);
  const u = (a, b) => a + (b - a) * r();
  const x0 = box.x0 - em * u(0.04, 0.12), x1 = box.x1 + em * u(0.04, 0.12);
  const y0 = box.y0 - em * u(0.03, 0.1), y1 = box.y1 + em * u(0.05, 0.12);
  const tl = [x0, y0], tr = [x1, y0], br = [x1, y1], bl = [x0, y1];
  (r() < 0.5 ? tl : bl)[0] -= em * u(0, 0.12);
  (r() < 0.5 ? tr : br)[0] += em * u(0, 0.12);
  (r() < 0.5 ? tl : tr)[1] -= em * u(0, 0.07);
  (r() < 0.5 ? bl : br)[1] += em * u(0, 0.07);
  const cs = [tl, tr, br, bl], points = [];
  for (let i = 0; i < 4; i++) {
    points.push(cs[i]);
    const a = cs[i], b = cs[(i + 1) % 4];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    if (len > em * 1.5 && r() < 0.3) {
      const t = 0.3 + 0.4 * r(), off = em * u(0.01, 0.035);
      points.push([a[0] + dx * t + (dy / len) * off, a[1] + dy * t - (dx / len) * off]);
    }
  }
  return points;
}

/** Walk `dist` px along a closed outline from vertex `start`, forwards (dir 1) or backwards (-1). */
export function walk(points, start, dir, dist) {
  const n = points.length;
  let i = start, left = dist;
  for (let s = 0; s < n; s++) {
    const a = points[i], j = (i + dir + n) % n, b = points[j];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len >= left) { const t = left / len; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
    left -= len;
    i = j;
  }
  return points[i].slice();
}

// 1D gradient noise, about -1..1
function hash1(seed, i) {
  let h = Math.imul((seed | 0) ^ Math.imul(i | 0, 0x27d4eb2d), 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
function noise1(seed, x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return (hash1(seed, i) * f * (1 - u) + hash1(seed, i + 1) * (f - 1) * u) * 2;
}

/** Like AE's wiggle(freq, 1): smooth noise in about -1..1, `freq` wiggles per second. */
export function wiggle(seed, t, freq = 1, octaves = 2) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise1(seed + o * 101, t * f);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}
