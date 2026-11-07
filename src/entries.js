/*
 * Four stop-motion entrances, sampled at ENTRY_FPS. Each starts with the
 * strip already in frame; its matching sound has the same duration.
 */

export const ENTRY_FPS = 15;

export const ENTRIES = {
  unfurl: { label: '揭角', frames: 10, sound: 'unfurl.wav' },
  snap: { label: '回正', frames: 6, sound: 'snap.wav' },
  slap: { label: '拍下', frames: 9, sound: 'slap.wav' },
  slide: { label: '滑入', frames: 10, sound: 'slide.wav' },
};

/** Duration of an entry in seconds. */
export const entryDuration = (name) => (ENTRIES[name] ? ENTRIES[name].frames / ENTRY_FPS : 0);

const ease = (x) => x * x * (3 - 2 * x);

// value at frame f of keys [[frame, value], ...]
function key(keys, f) {
  if (f <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [f1, v1] = keys[i];
    if (f <= f1) {
      const [f0, v0] = keys[i - 1];
      return v0 + (v1 - v0) * ease((f - f0) / (f1 - f0));
    }
  }
  return keys[keys.length - 1][1];
}

/*
 * The pose at whole frame f (0 .. frames-1). Lengths: dx in strip widths,
 * dy in em, rotate in degrees.
 *   br: how far the bottom-right fold is from its resting dog-ear
 *       { grow } legs times `grow`, or { path } 0..1 along the unfurl path
 *   tl: the opposite (top-left) fold, legs along the top and down the side, in
 *       strip heights. A side leg over 1 runs on along the bottom edge: the
 *       whole end of the strip is folded back over it like a page.
 *   lift: 0 lying on the page .. 1 held above it
 */
const POSES = {
  unfurl: (f) => ({
    br: { path: key([[0, 0], [2, 0.06], [4, 0.45], [6, 0.78], [8, 0.95], [10, 1]], f) },
  }),
  snap: (f) => ({
    rotate: key([[0, -11], [1, -7.5], [2, -3.5], [3, -1], [4, 0.4], [5, 0]], f),
    dy: key([[0, 0.8], [1, 0.52], [2, 0.2], [3, 0.05], [5, 0]], f),
    tl: { top: key([[0, 1.75], [1, 1.35], [2, 0.85], [3, 0.32], [4, 0]], f), side: key([[0, 2.5], [1, 2.15], [2, 1.55], [3, 0.38], [4, 0]], f) },
  }),
  slap: (f) => ({
    scale: key([[0, 1.14], [3, 1.06], [5, 0.985], [6, 1.006], [7, 1]], f),
    lift: key([[0, 1], [3, 0.6], [5, 0]], f),
    rotate: key([[0, 3.5], [3, 2], [5, -0.6], [6, 0.25], [7, 0]], f),
    dy: key([[0, -0.25], [5, 0]], f),
    br: { grow: key([[0, 2.0], [5, 1.15], [7, 1]], f) },
    tl: { top: key([[0, 0.4], [5, 0]], f), side: key([[0, 0.45], [5, 0]], f) },
  }),
  slide: (f) => ({
    dx: key([[0, -0.42], [2, -0.2], [4, -0.07], [6, -0.015], [8, 0]], f),
    rotate: key([[0, -3], [3, -1], [5, 0.8], [7, -0.2], [9, 0]], f),
    dy: key([[0, 0.2], [5, 0]], f),
    br: { grow: key([[0, 2.6], [4, 1.8], [7, 1.15], [9, 1]], f) },
  }),
};

/**
 * Where the entry is at `t` seconds after it started: { frame, pose } while it
 * runs, { done: true } after, { before: true } before it starts.
 */
export function entryAt(name, t) {
  const e = ENTRIES[name];
  if (!e) return { done: true };
  if (t < 0) return { before: true };
  const frame = Math.floor(t * ENTRY_FPS + 1e-6);
  if (frame >= e.frames) return { done: true };
  return { frame, pose: { dx: 0, dy: 0, rotate: 0, scale: 1, lift: 0, br: null, tl: null, ...POSES[name](frame) } };
}
