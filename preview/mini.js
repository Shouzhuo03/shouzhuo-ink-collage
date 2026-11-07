import { cutStrip, cutPatch, foldsAt, CURL_DEFAULTS, ENTRIES, entryAt, ENTRY_FPS, resolvePalette, BUILTIN_FAMILY } from '../src/index.js';

/*
 * A flat-colour sketch of the strip for the buttons: the same scissor cut,
 * the same folded corners and the same entry motion as the real one, drawn
 * with Canvas 2D and without the ink and paper texture.
 */

// keep the part of a polygon on one side of a fold line (Sutherland-Hodgman)
function clipHalf(pts, f, keepFar) {
  if (!f) return pts;
  const d = (p) => ((p[0] - f.F[0]) * f.n[0] + (p[1] - f.F[1]) * f.n[1]) * (keepFar ? 1 : -1);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], da = d(a), db = d(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
const reflect = (p, f) => {
  const d = (p[0] - f.F[0]) * f.n[0] + (p[1] - f.F[1]) * f.n[1];
  return [p[0] - 2 * d * f.n[0], p[1] - 2 * d * f.n[1]];
};
function path(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

export class MiniStrip {
  constructor(canvas, { text = '油墨拼贴', mark = [2, 4], size = 13, seed = 5 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    Object.assign(this, { text, mark, size, seed });
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    this.w = r.width || 120; this.h = r.height || 60; this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this._layout();
  }

  _layout() {
    const ctx = this.ctx, em = this.size;
    ctx.font = `${em}px "${BUILTIN_FAMILY}", serif`;
    const chars = Array.from(this.text);
    const widths = chars.map((c) => ctx.measureText(c).width);
    let x = -widths.reduce((a, b) => a + b, 0) / 2;
    this.glyphs = chars.map((c, i) => { const g = { c, x, w: widths[i], hl: i >= this.mark[0] && i < this.mark[1] }; x += widths[i]; return g; });
    const asc = em * 0.82, desc = em * 0.08;
    this.baseline = (asc - desc) / 2;
    const box = { x0: this.glyphs[0].x, x1: x, y0: this.baseline - asc, y1: this.baseline + desc };
    const cut = cutStrip(box, em, this.seed);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const [px, py] of cut.points) { bx0 = Math.min(bx0, px); by0 = Math.min(by0, py); bx1 = Math.max(bx1, px); by1 = Math.max(by1, py); }
    this.shape = { poly: cut.points, corners: cut.corners, anchor: [(bx0 + bx1) / 2, (by0 + by1) / 2], w: bx1 - bx0, h: by1 - by0 };
    const hl = this.glyphs.filter((g) => g.hl);
    this.patch = hl.length
      ? cutPatch({ x0: hl[0].x, x1: hl[hl.length - 1].x + hl[hl.length - 1].w, y0: box.y0, y1: box.y1 }, em, this.seed * 31 + 7)
      : null;
  }

  /** pose: an entry pose or null; tq: stepped time in seconds (for the trembling corner). */
  draw(palette, pose = null, tq = 0) {
    const ctx = this.ctx, P = resolvePalette(palette), S = this.shape, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const { folds } = foldsAt(S, CURL_DEFAULTS, pose, this.seed, tq);
    const lift = pose ? pose.lift : 0, sc = pose ? pose.scale : 1;
    ctx.translate(this.w / 2 + (pose ? pose.dx * S.w : 0), this.h / 2 + (pose ? pose.dy * this.size : 0));
    ctx.rotate((pose ? pose.rotate : 0) * Math.PI / 180);
    ctx.scale(sc, sc);
    ctx.translate(-S.anchor[0], -S.anchor[1]);

    // the part that lies flat, with its shadow on the page
    const front = clipHalf(clipHalf(S.poly, folds[0], false), folds[1], false);
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${0.16 + 0.12 * lift})`;
    ctx.shadowBlur = (1.5 + 9 * lift) * dpr;
    ctx.shadowOffsetX = (0.4 + 4 * lift) * dpr;
    ctx.shadowOffsetY = (0.8 + 7 * lift) * dpr;
    ctx.fillStyle = P.paper;
    path(ctx, front);
    ctx.fill();
    ctx.restore();

    // highlight patch and text, cut to the flat part
    ctx.save();
    path(ctx, front);
    ctx.clip();
    if (this.patch) { ctx.fillStyle = P.highlight; path(ctx, this.patch); ctx.fill(); }
    ctx.font = `${this.size}px "${BUILTIN_FAMILY}", serif`;
    ctx.textBaseline = 'alphabetic';
    for (const g of this.glyphs) {
      ctx.fillStyle = g.hl ? P.highlightInk : P.ink;
      ctx.fillText(g.c, g.x, this.baseline);
    }
    ctx.restore();

    // folded-over flaps: the back of the paper, a little lifted
    folds.forEach((f, i) => {
      if (!f) return;
      const flap = clipHalf(clipHalf(S.poly, f, true), folds[1 - i], false).map((p) => reflect(p, f));
      if (flap.length < 3) return;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
      ctx.shadowBlur = 2.5 * dpr;
      ctx.shadowOffsetX = 0.7 * dpr;
      ctx.shadowOffsetY = 1.2 * dpr;
      ctx.fillStyle = P.back;
      path(ctx, flap);
      ctx.fill();
      ctx.restore();
    });
  }
}

/**
 * Plays an entry on a MiniStrip, over and over while `running()` is true:
 * the entry, a short rest with the corner trembling, again.
 */
export function loopEntry(mini, name, palette, running) {
  const t0 = performance.now() / 1000;
  const cycle = ENTRIES[name].frames / ENTRY_FPS + 0.9;
  let raf = 0;
  const tick = () => {
    if (!running()) { mini.draw(palette()); return; }
    const t = (performance.now() / 1000 - t0) % cycle;
    const e = entryAt(name, t);
    const tq = e.pose ? Math.floor(t * ENTRY_FPS) / ENTRY_FPS : Math.floor(t * CURL_DEFAULTS.fps) / CURL_DEFAULTS.fps;
    mini.draw(palette(), e.pose || null, tq);
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => cancelAnimationFrame(raf);
}
