/*
 * Shape controls rounded, ragged, bleeding edges; texture controls the ink
 * film's grain and coverage. Lengths are in em so the look scales with type.
 */

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

export function lookFor(shape = 0.3, texture = 0.3) {
  const s = clamp01(shape), t = clamp01(texture);
  return {
    // shape
    round: 0.055 * s ** 1.4,        // corner rounding: blur radius, em
    level: 0.5 - 0.14 * s ** 1.5,   // threshold of the rounded field; lower = ink spreads, strokes fatten
    choke: 0,                       // shrink (+) / spread (-) the edge, em
    rough: 0.02 * s ** 1.5,         // how far the edge wanders in and out, em
    roughSize: 0.012 + 0.03 * s,    // size of one bump along the edge, em
    burr: 0.012 * s ** 1.5,         // sideways push of the edge, em
    soft: 0.004 * s,                // edge softness, em
    bleed: 0.55 * s ** 1.5,         // ink wicking into the paper outside the stroke
    bleedWidth: 0.008 + 0.035 * s,  // em
    fringe: 0.5 * s,                // warm undertone of thin dark ink at the edge
    fringeWidth: 0.006 + 0.02 * s,  // em
    // texture
    grain: 0.9 * t ** 1.7,          // film thickness varies; 0 = even
    grainSize: 0.011 + 0.009 * t,   // em (never finer than 1.25 device px)
    holes: 0.5 * t ** 2.5,          // pinholes in the film
    mottle: 0.5 * t,                // slow unevenness
    skip: 0.6 * t ** 2.5,           // valleys of the paper the type did not reach
    rim: 0.5 * t,                   // ink piled up along the edge stays solid
    rimWidth: 0.012,                // em
    density: 1 - 0.12 * t,          // opacity of a full film
    paperShow: t,                   // how much of the paper's tooth shows in the ink
  };
}

/*
 * Colour schemes. `back` is the other side of the sheet, seen on the curled
 * corner: coloured paper usually has a pale back; a pale sheet gets a
 * different pale.
 */
export const PALETTES = {
  navy: { name: '藏青', paper: '#2e4a7a', back: '#dcd9ce', ink: '#efe8d6', highlight: '#68975b', highlightInk: '#efe8d6' },
  cream: { name: '米白', paper: '#ebe3cf', back: '#fbfaf6', ink: '#1b1814', highlight: '#e2b53e', highlightInk: '#1b1814' },
  kraft: { name: '牛皮', paper: '#b28a5f', back: '#e3d3b8', ink: '#1e1914', highlight: '#c2452e', highlightInk: '#f3eada' },
  vermilion: { name: '朱红', paper: '#b23b29', back: '#efdcd2', ink: '#f3ebd9', highlight: '#22324f', highlightInk: '#f3ebd9' },
};
const FRINGE = '#8c4220';

export function resolvePalette(p) {
  const base = PALETTES.navy;
  if (!p) return { fringe: FRINGE, ...base };
  if (typeof p === 'string') return { fringe: FRINGE, ...(PALETTES[p] || base) };
  return { fringe: FRINGE, ...base, ...p };
}

export function toRGB(c) {
  if (Array.isArray(c)) return c;
  let h = String(c).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function luminance(c) {
  const [r, g, b] = toRGB(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark inks show a warm fringe where the film is thin; light inks do not. */
export const isDark = (c) => luminance(c) < 0.35;
