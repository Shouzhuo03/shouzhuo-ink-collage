import { VERT, BLUR_FS, FRONT_FS, BACK_FS, COMPOSITE_FS } from './shaders.js';
import { layoutText, drawText, fontString, parseMarks, BUILTIN_FAMILY } from './text.js';
import { lookFor, resolvePalette, toRGB, isDark } from './look.js';
import { cutStrip, cutPatch } from './cut.js';
import { foldsAt } from './folds.js';
import { ENTRIES, ENTRY_FPS, entryAt } from './entries.js';

/** The curled corner. Lengths are shares of the strip's shorter side. */
export const CURL_DEFAULTS = {
  corner: 'br',     // 'tl' | 'tr' | 'br' | 'bl'
  size: 0.3,        // how much of the corner is folded over
  radius: 0.04,     // radius of the fold, share of size; small = pressed flat like a dog-ear
  jitter: 1,        // how much it trembles (0 = still)
  fps: 8,           // stop-motion steps per second (AE: posterizeTime)
  freq: 1.5,        // wiggles per second (AE: wiggle(freq, ...))
  shadow: 0.32,     // darkness of the flap's shadow
  lift: 1,          // how far the flap's shadow falls from it
};

export const STRIP_DEFAULTS = {
  text: '',             // [方括号] or 【】 marks a highlight
  fontSize: 64,         // px
  family: `"${BUILTIN_FAMILY}", serif`,
  weight: 'normal',
  lineHeight: 1.4,      // multiple of fontSize
  letterSpacing: 0.02,  // multiple of fontSize
  maxWidth: null,       // wrap width, px (null: 72% of the canvas)
  shape: 0.3,           // 字形 0..1
  texture: 0.3,         // 纹理 0..1
  look: null,           // detailed overrides of lookFor(shape, texture), em
  palette: 'navy',      // a name from PALETTES, or { paper, back, ink, highlight, highlightInk }
  seed: 1,              // the cut, the paper, the ink
  x: null, y: null,     // where the centre of the strip goes, CSS px (null: centre of the canvas)
  rotate: 0,            // degrees
  scale: 1,
  opacity: 1,
  background: '#ffffff', // page colour, or null for transparent
  shadow: 0.1,          // contact shadow under the strip
  paperScale: 1,        // size of the paper's grain
  streak: 1,            // how streaky the paper is
  curl: CURL_DEFAULTS,  // or false
  entry: null,          // entry animation playing: 'unfurl' | 'snap' | 'slap' | 'slide' (see play())
  entryStart: 0,        // when it started, seconds on render()'s clock
};

const LAYOUT_KEYS = new Set(['text', 'fontSize', 'family', 'weight', 'lineHeight', 'letterSpacing', 'maxWidth', 'seed']);
const BAKE_KEYS = new Set(['shape', 'texture', 'look', 'palette', 'paperScale', 'streak', 'seed']);

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}
const seedOf = (s, salt = 0) => (Math.imul((Math.floor(s) | 0) + salt, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;

/**
 * Ink-textured paper strip with highlighted words and animated folds.
 * render(time) is deterministic for fixed parameters and dimensions.
 */
export class InkStrip {
  constructor({ canvas, width = 800, height = 600, pixelRatio, ...params } = {}) {
    this.params = { ...STRIP_DEFAULTS, curl: { ...CURL_DEFAULTS } };
    this.canvas = canvas || makeCanvas(1, 1);
    this._ownCanvas = !canvas;

    const gl = this.canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true,
      antialias: false, depth: false, stencil: false,
    });
    if (!gl) throw new Error('InkStrip: WebGL2 is not available');
    this.gl = gl;
    this._half = !!gl.getExtension('EXT_color_buffer_float');
    this._vao = gl.createVertexArray();
    this._prog = {
      blur: this._compile(BLUR_FS, 'blur'),
      front: this._compile(FRONT_FS, 'front'),
      back: this._compile(BACK_FS, 'back'),
      composite: this._compile(COMPOSITE_FS, 'composite'),
    };
    this._tex = {};
    this._mask = {};
    for (const k of ['text', 'strip', 'hl']) {
      this._tex[k] = this._texture();
      this._mask[k] = makeCanvas(1, 1);
    }
    this._measure = makeCanvas(1, 1).getContext('2d');
    this._t = null;
    this._sprite = null;
    /** Where things ended up after the last render: glyphs, outlines (sprite CSS px). */
    this.layout = null;
    this._dirtyLayout = this._dirtyBake = true;
    this.set(params);
    this.resize(width, height, pixelRatio ?? (globalThis.devicePixelRatio || 1));
  }

  /** Merge parameters. Returns this. */
  set(params = {}) {
    for (const [k, v] of Object.entries(params)) {
      if (!(k in STRIP_DEFAULTS)) continue;
      const old = this.params[k];
      if (k === 'curl') {
        this.params.curl = v ? { ...CURL_DEFAULTS, ...(old || {}), ...v } : false;
        continue;
      }
      if (typeof v !== 'object' || v === null) { if (old === v) continue; }
      else if (JSON.stringify(old) === JSON.stringify(v)) continue;
      this.params[k] = v && typeof v === 'object' ? { ...v } : v;
      if (LAYOUT_KEYS.has(k)) this._dirtyLayout = true;
      if (BAKE_KEYS.has(k)) this._dirtyBake = true;
    }
    return this;
  }

  /** The curl settings in effect (or false). */
  get curl() { return this.params.curl; }

  /** Canvas size in CSS px; the canvas gets width * pixelRatio device px. */
  resize(width, height, pixelRatio = this.pixelRatio) {
    const W = Math.max(1, Math.round(width * pixelRatio)), H = Math.max(1, Math.round(height * pixelRatio));
    if (width !== this.width || pixelRatio !== this.pixelRatio) this._dirtyLayout = true;
    this.width = width; this.height = height; this.pixelRatio = pixelRatio;
    if (W !== this._W || H !== this._H) {
      this._W = W; this._H = H;
      this.canvas.width = W; this.canvas.height = H;
    }
    if (this._ownCanvas && this.canvas.style) {
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }
    return this;
  }

  /** Render the frame at `time` (seconds). Returns the canvas. */
  render(time = 0) {
    if (this._dirtyLayout) { this._layout(); this._dirtyLayout = false; this._dirtyBake = true; }
    if (this._dirtyBake && this._sprite) this._bake();
    this._dirtyBake = false;
    this._composite(time);
    return this.canvas;
  }

  /** Free GPU resources. */
  dispose() {
    const gl = this.gl;
    for (const t of Object.values(this._t || {})) if (t && t.t) this._free(t);
    for (const p of Object.values(this._prog)) gl.deleteProgram(p.p);
    for (const t of Object.values(this._tex)) gl.deleteTexture(t);
    gl.deleteVertexArray(this._vao);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /* ---------------------------------------------------------------- */

  // text -> glyph positions, the cut outlines, the sprite, the three masks
  _layout() {
    const P = this.params, pr = this.pixelRatio, em = P.fontSize;
    const { text, marks } = parseMarks(P.text);
    if (!text.trim()) { this._sprite = null; this.layout = null; return; }
    const opts = {
      x: 0, y: 0, size: em, family: P.family, weight: P.weight,
      lineHeight: P.lineHeight, letterSpacing: P.letterSpacing,
      maxWidth: P.maxWidth ?? Math.max(em * 3, this.width * 0.72),
    };
    const ctx = this._measure;
    const L = layoutText(ctx, text, opts);

    // ink extents of each character (cached), and of a full-height CJK glyph
    ctx.save();
    ctx.font = fontString(L.options);
    const cache = new Map();
    const ink = (ch) => {
      let m = cache.get(ch);
      if (!m) {
        const t = ctx.measureText(ch);
        m = { l: t.actualBoundingBoxLeft, r: t.actualBoundingBoxRight, a: t.actualBoundingBoxAscent, d: t.actualBoundingBoxDescent };
        cache.set(ch, m);
      }
      return m;
    };
    const cjk = ink('国');
    for (const g of L.glyphs) ink(g.ch);
    ctx.restore();

    // tight box around the ink of the whole text
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const g of L.glyphs) {
      const m = ink(g.ch);
      box.x0 = Math.min(box.x0, g.x - m.l);
      box.x1 = Math.max(box.x1, g.x + m.r);
      box.y0 = Math.min(box.y0, g.y - Math.max(m.a, cjk.a * 0.8));
      box.y1 = Math.max(box.y1, g.y + Math.max(m.d, cjk.d));
    }

    // highlight runs: consecutive marked glyphs on one line
    const runs = [];
    let cur = null;
    L.glyphs.forEach((g, i) => {
      if (!marks[i]) { cur = null; return; }
      if (!cur || cur.line !== g.line) { cur = { line: g.line, glyphs: [] }; runs.push(cur); }
      cur.glyphs.push(g);
    });
    const patches = runs.map((run, k) => {
      const first = run.glyphs[0], last = run.glyphs[run.glyphs.length - 1];
      const b = { x0: first.x - ink(first.ch).l, x1: last.x + ink(last.ch).r, y0: Infinity, y1: -Infinity };
      for (const g of run.glyphs) {
        const m = ink(g.ch);
        b.y0 = Math.min(b.y0, g.y - Math.max(m.a, cjk.a));
        b.y1 = Math.max(b.y1, g.y + Math.max(m.d, cjk.d));
      }
      return cutPatch(b, em, P.seed * 977 + k * 131 + 7);
    });
    const cut = cutStrip(box, em, P.seed);

    // sprite: the strip's bounding box plus room for its shadow
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const [x, y] of cut.points) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
    const m = Math.ceil(34 + 0.12 * em);   // room for shadows, also the wide one of a strip held above the page
    const ox = m - bx0, oy = m - by0;
    const w = bx1 - bx0 + 2 * m, h = by1 - by0 + 2 * m;
    const W = Math.max(1, Math.ceil(w * pr)), H = Math.max(1, Math.ceil(h * pr));
    const move = (p) => [p[0] + ox, p[1] + oy];
    this._poly = cut.points.map(move);
    this._corners = cut.corners;
    this._patches = patches.map((pp) => pp.map(move));
    this._sprite = { w, h, W, H, anchor: [(bx0 + bx1) / 2 + ox, (by0 + by1) / 2 + oy], stripW: bx1 - bx0, stripH: by1 - by0 };

    // masks, at device resolution
    const tc = this._mask.text;
    tc.width = W; tc.height = H;
    const tx = tc.getContext('2d');
    tx.setTransform(pr, 0, 0, pr, ox * pr, oy * pr);
    drawText(tx, text, { ...opts, color: '#fff' });
    this._fill(this._mask.strip, [this._poly], W, H);
    this._fill(this._mask.hl, this._patches, W, H);
    for (const k of ['text', 'strip', 'hl']) this._upload(this._tex[k], this._mask[k]);

    if (!this._t || this._t.W !== W || this._t.H !== H) {
      for (const t of Object.values(this._t || {})) if (t && t.t) this._free(t);
      this._t = {
        W, H,
        a: this._target(W, H, this._half),
        blur: this._target(W, H, this._half),
        stripBlur: this._target(W, H, this._half),
        stripWide: this._target(W, H, this._half),
        front: this._target(W, H, false),
        back: this._target(W, H, false),
      };
    }
    this.layout = {
      size: [w, h], anchor: this._sprite.anchor.slice(),
      glyphs: L.glyphs.map((g, i) => ({ ...g, x: g.x + ox, y: g.y + oy, highlight: !!marks[i] })),
      strip: this._poly, highlights: this._patches,
    };
  }

  _fill(canvas, polys, W, H) {
    canvas.width = W; canvas.height = H;
    const c = canvas.getContext('2d');
    c.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    c.fillStyle = '#fff';
    c.beginPath();
    for (const poly of polys) {
      poly.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.closePath();
    }
    c.fill();
  }

  // the parts that only change with the text or the look
  _bake() {
    const P = this.params, T = this._t, S = this._sprite;
    const look = { ...lookFor(P.shape, P.texture), ...(P.look || {}) };
    const pal = resolvePalette(P.palette);
    const pr = this.pixelRatio, pxEm = P.fontSize * pr, size = [S.W, S.H];
    const seed = seedOf(P.seed);

    const sigma = Math.min(Math.max(look.round * pxEm, 0.5), 42);
    this._run(this._prog.blur, T.a, size, { uRes: size, uSrc: this._tex.text, uDir: [1, 0], uSigma: sigma, uChannel: 0 });
    this._run(this._prog.blur, T.blur, size, { uRes: size, uSrc: T.a.t, uDir: [0, 1], uSigma: sigma, uChannel: 1 });
    const ss = 2 * pr;
    this._run(this._prog.blur, T.a, size, { uRes: size, uSrc: this._tex.strip, uDir: [1, 0], uSigma: ss, uChannel: 0 });
    this._run(this._prog.blur, T.stripBlur, size, { uRes: size, uSrc: T.a.t, uDir: [0, 1], uSigma: ss, uChannel: 1 });
    const sw = Math.min(8 * pr, 42);
    this._run(this._prog.blur, T.a, size, { uRes: size, uSrc: this._tex.strip, uDir: [1, 0], uSigma: sw, uChannel: 0 });
    this._run(this._prog.blur, T.stripWide, size, { uRes: size, uSrc: T.a.t, uDir: [0, 1], uSigma: sw, uChannel: 1 });

    this._run(this._prog.front, T.front, size, {
      uRes: size, uBlur: T.blur.t, uStrip: this._tex.strip, uHl: this._tex.hl,
      uPr: pr, uPxEm: pxEm, uPaperScale: P.paperScale, uStreak: P.streak, uSeed: seed,
      uPaper: toRGB(pal.paper), uHlPaper: toRGB(pal.highlight), uInk: toRGB(pal.ink), uHlInk: toRGB(pal.highlightInk),
      uFringeColor: toRGB(pal.fringe),
      uLevel: look.level, uRough: look.rough, uRoughSize: Math.max(look.roughSize, 1e-3), uBurr: look.burr,
      uChoke: look.choke, uSoft: look.soft, uBleed: look.bleed, uBleedWidth: Math.max(look.bleedWidth, 1e-3),
      uFringe: [isDark(pal.ink) ? look.fringe : 0, isDark(pal.highlightInk) ? look.fringe : 0], uFringeWidth: look.fringeWidth,
      uGrain: look.grain, uGrainSize: look.grainSize, uHoles: look.holes, uMottle: look.mottle, uSkip: look.skip,
      uRim: look.rim, uRimWidth: look.rimWidth, uDensity: look.density, uPaperShow: look.paperShow,
    });
    this._run(this._prog.back, T.back, size, {
      uRes: size, uStrip: this._tex.strip, uPr: pr, uPaperScale: P.paperScale, uStreak: P.streak, uSeed: seed,
      uBack: toRGB(pal.back),
    });
  }

  // every frame: place the strip, fold the corners, play the entry
  _composite(time) {
    const gl = this.gl, P = this.params, S = this._sprite, T = this._t, pr = this.pixelRatio;
    const bg = P.background == null ? [0, 0, 0, 0] : [...toRGB(P.background), 1];
    const entry = P.entry ? entryAt(P.entry, time - P.entryStart) : { done: true };
    if (!S || entry.before) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this._W, this._H);
      gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const pose = entry.pose || null;
    // while an entry runs, everything steps on its 15 fps frames
    const tEntry = pose ? P.entryStart + entry.frame / ENTRY_FPS : null;

    // screen -> sprite
    const sc = (P.scale || 1) * (pose ? pose.scale : 1);
    const th = ((P.rotate || 0) + (pose ? pose.rotate : 0)) * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);
    let cx = (P.x ?? this.width / 2) * pr, cy = (P.y ?? this.height / 2) * pr;
    if (pose) { cx += pose.dx * S.stripW * sc * pr; cy += pose.dy * P.fontSize * sc * pr; }
    const ax = S.anchor[0] * pr, ay = S.anchor[1] * pr;
    const invX = [cos / sc, sin / sc, ax - (cos * cx + sin * cy) / sc];
    const invY = [-sin / sc, cos / sc, ay - (-sin * cx + cos * cy) / sc];
    const toSprite = ([x, y]) => [(cos * x + sin * y) / sc, (-sin * x + cos * y) / sc];   // light comes from the screen's top left

    const C = P.curl;
    const tq = tEntry ?? (C && C.fps > 0 ? Math.floor(time * C.fps) / C.fps : time);
    const { folds, shake } = foldsAt(
      { poly: this._poly, corners: this._corners, anchor: S.anchor, w: S.stripW, h: S.stripH }, C, pose, P.seed, tq);
    const lift = pose ? pose.lift : 0;
    const U = (f, i) => f
      ? { [`uOn${i}`]: 1, [`uF${i}`]: [f.F[0] * pr, f.F[1] * pr], [`uN${i}`]: f.n, [`uR${i}`]: f.R * pr }
      : { [`uOn${i}`]: 0 };
    this._run(this._prog.composite, null, [this._W, this._H], {
      uRes: [this._W, this._H], uFront: T.front.t, uBack: T.back.t, uStripBlur: T.stripBlur.t, uStripWide: T.stripWide.t,
      uSprite: [S.W, S.H], uInvX: invX, uInvY: invY,
      ...U(folds[0], 0), ...U(folds[1], 1), uAA: 0.75 / sc,
      uDropOff: toSprite([0.4 * pr, 0.9 * pr]), uDrop: P.shadow,
      uLift: lift, uLiftOff: toSprite([7 * pr * lift, 13 * pr * lift]),
      uFlapOff: toSprite([1.1 * pr * shake, 1.9 * pr * shake]), uFlapShadow: C ? C.shadow : 0, uFlapSoft: 2.5 * pr,
      uBg: bg, uOpacity: P.opacity,
    });
  }

  /**
   * What render(time) would draw, as an id: two times with the same id give
   * the same frame (the motion steps), so an exporter can encode it once.
   */
  frameId(time) {
    const P = this.params;
    const e = P.entry ? entryAt(P.entry, time - P.entryStart) : { done: true };
    if (e.before) return 'before';
    if (e.pose) return `e${e.frame}`;
    const C = P.curl;
    if (!C) return 'still';
    return C.fps > 0 ? `r${Math.floor(time * C.fps)}` : `t${time}`;
  }

  /** Start an entry animation ('unfurl' | 'snap' | 'slap' | 'slide') at `time` seconds (the clock render() is given). */
  play(name, time = 0) {
    this.params.entry = name in ENTRIES ? name : null;
    this.params.entryStart = time;
    return this;
  }

  /* ---------------------------------------------------------------- */

  _compile(fs, name) {
    const gl = this.gl;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)} ${l}`).join('\n');
        throw new Error(`InkStrip: ${name} shader: ${gl.getShaderInfoLog(s)}\n${lines}`);
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`InkStrip: ${name} link: ${gl.getProgramInfoLog(p)}`);
    const u = {};
    let unit = 0;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = { loc: gl.getUniformLocation(p, info.name), type: info.type, unit: info.type === gl.SAMPLER_2D ? unit++ : -1 };
    }
    return { p, u };
  }

  _run(prog, target, [w, h], vals) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.f : null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    for (const [name, v] of Object.entries(vals)) {
      const e = prog.u[name];
      if (!e) continue;
      switch (e.type) {
        case gl.FLOAT: gl.uniform1f(e.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(e.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(e.loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(e.loc, v); break;
        case gl.INT: gl.uniform1i(e.loc, v); break;
        case gl.UNSIGNED_INT: gl.uniform1ui(e.loc, v >>> 0); break;
        case gl.SAMPLER_2D:
          gl.activeTexture(gl.TEXTURE0 + e.unit);
          gl.bindTexture(gl.TEXTURE_2D, v);
          gl.uniform1i(e.loc, e.unit);
          break;
        default: break;
      }
    }
    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _texture() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _upload(tex, source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  _target(w, h, half) {
    const gl = this.gl;
    const t = this._texture();
    if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteFramebuffer(f); gl.deleteTexture(t);
      if (half) { this._half = false; return this._target(w, h, false); }
      throw new Error('InkStrip: cannot create render target');
    }
    return { t, f };
  }

  _free(x) {
    this.gl.deleteTexture(x.t);
    this.gl.deleteFramebuffer(x.f);
  }
}
