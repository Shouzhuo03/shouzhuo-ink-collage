/*
 * Text -> mask. Works with any font the page can use; the bundled one is
 * Source Han Serif Medium (GB2312 subset, renamed InkSerif SC per the OFL).
 */

export const BUILTIN_FAMILY = 'InkSerif';
export const BUILTIN_FONT_URL = new URL('../fonts/InkSerif.woff2', import.meta.url).href;

/** Load a font file and register it for canvas use. Defaults to the bundled serif. */
export async function loadFont(family = BUILTIN_FAMILY, url = BUILTIN_FONT_URL, descriptors = {}) {
  const face = new FontFace(family, `url("${url}")`, descriptors);
  await face.load();
  (globalThis.document?.fonts ?? globalThis.fonts)?.add(face);
  return face;
}

const TEXT_DEFAULTS = {
  x: 0, y: 0,              // top-left of the text block (CSS px of the target context)
  size: 48,                // font size, px
  family: `"${BUILTIN_FAMILY}", serif`,
  weight: 'normal',
  style: 'normal',
  lineHeight: 1.5,         // multiple of size
  letterSpacing: 0,        // multiple of size
  align: 'left',           // 'left' | 'center' | 'right' (relative to x)
  maxWidth: Infinity,      // wrap width, px
  color: '#000',
  each: null,              // (glyph, index) => opacity 0..1, or false to skip
};

const CJK = '⺀-鿿豈-﫿︰-﹏＀-￯　-〿';
const TOKEN = new RegExp(`[${CJK}]|\\s+|[^\\s${CJK}]+`, 'gu');
const NO_LINE_START = new Set(Array.from('，。、；：？！）》」』”’…—,.;:!?)]}%'));

/**
 * Highlight markup: [text] or 【text】 (what the [ key types with a Chinese
 * input method) puts that run on a highlight patch. Returns the text without
 * the brackets, and one flag per non-space character, in the same order as
 * layoutText's glyphs.
 */
export function parseMarks(src) {
  let text = '', on = false;
  const marks = [];
  for (const ch of String(src ?? '')) {
    if (!on && (ch === '[' || ch === '【')) { on = true; continue; }
    if (on && (ch === ']' || ch === '】')) { on = false; continue; }
    text += ch;
    if (!/\s/u.test(ch)) marks.push(on);
  }
  return { text, marks };
}

export function fontString(o) {
  return `${o.style} ${o.weight} ${o.size}px ${o.family}`;
}

/**
 * Measure and place every character. Returns
 *   { glyphs: [{ ch, x, y, width, line, index }], lines, box: { x, y, width, height } }
 * where (x, y) of a glyph is its pen position on the baseline. Useful for
 * animating text character by character.
 */
export function layoutText(ctx, text, options = {}) {
  const o = { ...TEXT_DEFAULTS, ...options };
  ctx.save();
  ctx.font = fontString(o);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  const sp = o.letterSpacing * o.size;
  const m = ctx.measureText('国Hg');
  const ascent = m.fontBoundingBoxAscent ?? o.size * 0.88;
  const descent = m.fontBoundingBoxDescent ?? o.size * 0.12;
  const lineBox = o.size * o.lineHeight;
  const halfLead = (lineBox - ascent - descent) / 2;

  // break into tokens: one per CJK character, whole Latin words, runs of spaces
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = { tokens: [], width: 0 };
    lines.push(line);
    for (const tok of para.match(TOKEN) || []) {
      const space = /^\s+$/.test(tok);
      const chars = Array.from(tok);
      // per-character advances, so kerning inside words survives when letterSpacing is 0
      const adv = [];
      let w = 0;
      if (sp === 0 && !space) {
        let prev = 0;
        for (let i = 1; i <= chars.length; i++) {
          const cw = ctx.measureText(chars.slice(0, i).join('')).width;
          adv.push(cw - prev); prev = cw;
        }
        w = prev;
      } else {
        for (const c of chars) { const cw = ctx.measureText(c).width + sp; adv.push(cw); w += cw; }
      }
      const wraps = line.tokens.length && line.width + w > o.maxWidth && !space && !NO_LINE_START.has(chars[0]);
      if (wraps) {
        while (line.tokens.length && line.tokens[line.tokens.length - 1].space) line.width -= line.tokens.pop().width;
        line = { tokens: [], width: 0, wrapped: true };
        lines.push(line);
      }
      if (space && line.wrapped && !line.tokens.length) continue;   // no leading space on a wrapped line
      line.tokens.push({ text: tok, chars, adv, width: w, space, x: line.width });
      line.width += w;
    }
    // letter spacing is added after each character; do not count it after the last one
    if (sp && line.tokens.length) line.width -= sp;
  }

  const glyphs = [];
  let minX = Infinity, maxX = -Infinity;
  lines.forEach((line, li) => {
    const dx = o.align === 'center' ? -line.width / 2 : o.align === 'right' ? -line.width : 0;
    line.x = o.x + dx;
    line.y = o.y + li * lineBox + halfLead + ascent;
    minX = Math.min(minX, line.x); maxX = Math.max(maxX, line.x + line.width);
    for (const t of line.tokens) {
      t.x += line.x;
      let x = t.x;
      t.chars.forEach((ch, ci) => {
        if (!t.space) glyphs.push({ ch, x, y: line.y, width: t.adv[ci], line: li, index: glyphs.length });
        x += t.adv[ci];
      });
    }
  });
  ctx.restore();
  return {
    glyphs, lines, options: o,
    box: { x: minX, y: o.y, width: maxX - minX, height: lines.length * lineBox },
  };
}

/** Draw text into a 2D context (e.g. a mask). Returns the layout. */
export function drawText(ctx, text, options = {}) {
  const layout = layoutText(ctx, text, options);
  const o = layout.options;
  ctx.save();
  ctx.font = fontString(o);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = o.color;
  if (o.each || o.letterSpacing) {
    for (const g of layout.glyphs) {
      const a = o.each ? o.each(g, g.index) : 1;
      if (a === false || a <= 0) continue;
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillText(g.ch, g.x, g.y);
    }
  } else {
    for (const line of layout.lines) for (const t of line.tokens) if (!t.space) ctx.fillText(t.text, t.x, line.y);
  }
  ctx.restore();
  return layout;
}
