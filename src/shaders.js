/*
 * GLSL for the ink collage strip (WebGL2 / GLSL ES 3.00).
 *
 * Units
 *   ink:   em, i.e. multiples of the font size (uPxEm = device px per em), so
 *          a look holds at any font size: rounding at 24 px is the same share
 *          of the glyph as at 200 px.
 *   paper: CSS px of the strip (times paperScale), so the sheet keeps its
 *          grain when the type size changes.
 * Positions are device px with y pointing down. Everything is laid out in
 * "sprite" space: a texture just big enough for the strip, which the
 * composite pass maps onto the screen (move, rotate, scale).
 *
 * Passes (see strip.js)
 *   BLUR x2     text mask -> rounded field          (when text / look changes)
 *   BLUR x2     strip mask -> soft mask for shadows
 *   FRONT       paper + highlight patches + ink     -> premultiplied RGBA
 *   BACK        back of the paper                   -> premultiplied RGBA
 *   COMPOSITE   page, contact shadow, front, curled corner, its shadow (every frame)
 */

export const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
out vec4 o;
uniform vec2 uRes;   // target size, device px

// this fragment, device px, y down
vec2 fragPx() { return vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y); }
// sample a texture of the given size at a y-down device px position
vec4 at(sampler2D t, vec2 q, vec2 size) { return texture(t, vec2(q.x, size.y - q.y) / size); }
`;

const NOISE = `
const float INV_U32 = 1.0 / 4294967295.0;

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
uvec3 cellHash(vec2 c, uint s) { return pcg3d(uvec3(uvec2(ivec2(c) + 1048576), s)); }
vec3 rand3(vec2 c, uint s) { return vec3(cellHash(c, s)) * INV_U32; }

// gradient noise, mean 0 / std 1
vec2 grad2(vec2 c, uint s) {
  float a = float(cellHash(c, s).x) * (6.28318531 * INV_U32);
  return vec2(cos(a), sin(a));
}
float gnoise(vec2 p, uint s) {
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad2(i, s), f);
  float b = dot(grad2(i + vec2(1.0, 0.0), s), f - vec2(1.0, 0.0));
  float c = dot(grad2(i + vec2(0.0, 1.0), s), f - vec2(0.0, 1.0));
  float d = dot(grad2(i + vec2(1.0, 1.0), s), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 4.642;
}

// Band-limited fBm. p in any unit, freq in cycles per unit, px = one device
// pixel in that unit. Octaves that get close to the pixel grid fade out; the
// variance they would have added comes back as .y so callers can average
// over it (ramp) instead of aliasing.
vec2 fbmB(vec2 p, float freq, int oct, float gain, uint s, float px, float f0, float f1) {
  float sum = 0.0, amp = 1.0, vAll = 0.0, vLost = 0.0;
  const mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float k = 1.0 - smoothstep(f0, f1, freq * px);
    if (k > 0.0) sum += amp * k * gnoise(p * freq, s + uint(i) * 977u);
    vAll += amp * amp;
    vLost += amp * amp * (1.0 - k * k);
    p = R * p + vec2(13.7, 7.1);
    freq *= 2.0;
    amp *= gain;
  }
  float sd = sqrt(vAll);
  return vec2(sum / sd, sqrt(vLost) / sd);
}
vec2 fbm(vec2 p, float freq, int oct, float gain, uint s, float px) { return fbmB(p, freq, oct, gain, s, px, 0.25, 0.5); }

// E[clamp((X - a) / (b - a), 0, 1)] for X ~ N(m, s^2): a ramp averaged over
// detail too fine for the pixel grid
float erf_(float x) {
  float s = sign(x); x = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * x);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return s * y;
}
float relu(float m, float s) {
  s = max(s, 1e-4);
  float z = m / s;
  return m * 0.5 * (1.0 + erf_(z * 0.70710678)) + s * 0.39894228 * exp(-0.5 * z * z);
}
float ramp(float m, float s, float a, float b) {
  return clamp((relu(m - a, s) - relu(m - b, s)) / (b - a), 0.0, 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* Paper: machine-made sheet, fibres lying mostly one way              */
/* ------------------------------------------------------------------ */
const PAPER = `
// Streaky noise: long along the fibre direction, narrow across it
float streaks(vec2 p, vec2 f, uint s, float px) {
  float k = 1.0 - smoothstep(0.25, 0.5, f.x * px);
  return k > 0.0 ? k * gnoise(p * f, s) : 0.0;
}

// Bits in the pulp. x: light flecks, y: dark specks (coverage 0..1)
vec2 flecks(vec2 p, uint s, float px) {
  const float cell = 22.0;
  vec2 id = floor(p / cell);
  vec2 res = vec2(0.0);
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 c = id + vec2(float(i), float(j));
    vec3 r = rand3(c, s);
    if (r.z > 0.3) continue;
    vec3 r2 = rand3(c, s + 9u);
    vec2 d = p - (c + r.xy) * cell;
    float a = r2.x * 3.14159;
    d = mat2(cos(a), sin(a), -sin(a), cos(a)) * d;
    d.x *= 0.45 + 0.55 * r2.y;
    float rad = 0.3 + 1.0 * r2.z * r2.z;
    float rEff = max(rad, px * 0.5);
    float cov = (1.0 - smoothstep(rEff - px * 0.5, rEff + px * 0.5, length(d))) * min(1.0, rad * rad / (rEff * rEff));
    if (r.z < 0.05) res.y = max(res.y, cov * 0.7);
    else res.x = max(res.x, cov * (0.35 + 0.65 * r2.y));
  }
  return res;
}

// Loose fibres on the surface: thin, slightly bowed, mostly along the grain
float hairs(vec2 p, uint s, float px) {
  const float cell = 34.0;
  vec2 id = floor(p / cell);
  float best = 0.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 c = id + vec2(float(i), float(j));
    vec3 r = rand3(c, s);
    if (r.z > 0.15) continue;
    vec3 r2 = rand3(c, s + 5u);
    vec2 ctr = (c + r.xy) * cell;
    float a = 1.5708 + (r2.x - 0.5) * 0.9;
    vec2 dir = vec2(cos(a), sin(a)), nrm = vec2(-dir.y, dir.x);
    float L = 8.0 + 22.0 * r2.y;
    vec2 d = p - ctr;
    float t = dot(d, dir) / (0.5 * L);
    if (abs(t) > 1.0) continue;
    float sd = dot(d, nrm) - (r2.z - 0.5) * L * 0.25 * (1.0 - t * t);
    float w = 0.35 + 0.3 * r.x, wEff = max(w, px);
    float across = 1.0 - smoothstep(wEff * 0.5 - px * 0.5, wEff * 0.5 + px * 0.5, abs(sd));
    float along = 1.0 - smoothstep(0.6, 1.0, abs(t));
    best = max(best, across * along * (w / wEff) * (0.45 + 0.55 * r2.y));
  }
  return best;
}

// p: paper units (CSS px at paperScale 1), px: one device px in those units.
// x: brightness (around 1), y: height 0..1, z: light fleck / fibre, w: dark speck
vec4 paperSurface(vec2 p, uint s, float px, float streak) {
  vec2 pr = mat2(0.9986, 0.0523, -0.0523, 0.9986) * p;     // grain a hair off vertical
  float form = fbm(p, 1.0 / 90.0, 3, 0.55, s, px).x;        // cloudy pulp
  float s1 = streaks(pr, vec2(1.0 / 4.0, 1.0 / 45.0), s + 11u, px);
  float s2 = streaks(pr + 40.0, vec2(1.0 / 1.6, 1.0 / 18.0), s + 13u, px);
  // the streaks come and go: stronger in some patches of the sheet than others
  float patchy = clamp(0.6 + 0.55 * fbm(p + 77.0, 1.0 / 55.0, 2, 0.5, s + 19u, px).x, 0.15, 1.3);
  vec2 g = fbm(p, 1.0 / 1.7, 2, 0.5, s + 17u, px);          // fine tooth
  vec2 fl = flecks(p, s + 23u, px);
  float hr = hairs(p, s + 29u, px);
  float lum = 1.0 + 0.025 * form + streak * patchy * (0.02 * s1 + 0.014 * s2) + 0.016 * g.x;
  float h = clamp(0.5 + 0.17 * g.x + 0.12 * s2 + 0.07 * s1 + 0.04 * form, 0.0, 1.0);
  return vec4(lum, h, max(fl.x, 0.5 * hr), fl.y);
}

// colour of a sheet with the given base colour. Dark sheets show their
// texture a little more (the same pulp variation is a bigger share of a dark colour).
vec3 paperColor(vec3 base, vec4 surf) {
  float L = dot(base, vec3(0.2126, 0.7152, 0.0722));
  float k = 1.0 + 0.8 * (1.0 - L);
  vec3 c = base * (1.0 + (surf.x - 1.0) * k);
  vec3 light = mix(base, vec3(0.93, 0.92, 0.88), 0.42) * surf.x;
  c = mix(c, light, surf.z);
  return c * (1.0 - 0.45 * surf.w);
}
`;

/* ------------------------------------------------------------------ */
/* Separable gaussian. Pass 1 reads a mask's alpha, pass 2 reads red.  */
/* ------------------------------------------------------------------ */
export const BLUR_FS = HEAD + `
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform float uSigma;
uniform int uChannel;   // 0 alpha, 1 red

float fetch(vec2 fc) { vec4 c = texture(uSrc, fc / uRes); return uChannel == 0 ? c.a : c.r; }

void main() {
  vec2 fc = gl_FragCoord.xy;
  float s = max(uSigma, 0.5);
  int R = int(min(ceil(s * 3.0), 127.0));
  float k = -0.5 / (s * s);
  float acc = fetch(fc), ws = 1.0;
  // pairs of taps merged into one bilinear fetch
  for (int i = 1; i <= 127; i += 2) {
    if (i > R) break;
    float f1 = float(i), f2 = float(i + 1);
    float w1 = exp(k * f1 * f1), w2 = exp(k * f2 * f2);
    float w = w1 + w2;
    float off = (f1 * w1 + f2 * w2) / w;
    acc += w * (fetch(fc + uDir * off) + fetch(fc - uDir * off));
    ws += 2.0 * w;
  }
  float v = acc / ws;
  o = vec4(v, v, v, 1.0);
}`;

/* ------------------------------------------------------------------ */
/* Front of the strip: paper, highlight patches, ink                   */
/* ------------------------------------------------------------------ */
export const FRONT_FS = HEAD + NOISE + PAPER + `
uniform sampler2D uBlur, uStrip, uHl;
uniform float uPr, uPxEm, uPaperScale, uStreak;
uniform uint uSeed;
uniform vec3 uPaper, uHlPaper, uInk, uHlInk, uFringeColor;
// shape (em)
uniform float uLevel, uRough, uRoughSize, uBurr, uChoke, uSoft, uBleed, uBleedWidth, uFringeWidth;
uniform vec2 uFringe;   // for normal / highlighted text
// texture
uniform float uGrain, uGrainSize, uHoles, uMottle, uSkip, uRim, uRimWidth, uDensity, uPaperShow;

float B(vec2 q) { return at(uBlur, q, uRes).r; }

// signed distance to the rounded edge, device px (+ inside), at q
float edgeDist(vec2 q) {
  float b = B(q);
  vec2 g = vec2(B(q + vec2(1.0, 0.0)) - B(q - vec2(1.0, 0.0)),
                B(q + vec2(0.0, 1.0)) - B(q - vec2(0.0, 1.0))) * 0.5;
  float gm = length(g);
  float d = gm > 1e-5 ? (b - uLevel) / gm : (b > uLevel ? 1e3 : -1e3);
  return clamp(d, -1e3, 1e3);
}

void main() {
  vec2 q = fragPx();
  float stripA = at(uStrip, q, uRes).a;
  if (stripA <= 0.0) { o = vec4(0.0); return; }
  float hl = at(uHl, q, uRes).a;

  // --- paper: the strip, and the highlight patches pasted on it -------
  float pxP = 1.0 / (uPr * uPaperScale);
  vec2 pp = q * pxP;
  vec4 surf = paperSurface(pp, uSeed, pxP, uStreak);
  if (hl > 0.0) surf = mix(surf, paperSurface(pp + vec2(517.0, 263.0), uSeed + 101u, pxP, uStreak), hl);
  vec3 paper = paperColor(mix(uPaper, uHlPaper, hl), surf);

  // --- ink edge (AE: Simple Choker + Roughen Edges) -----------------
  vec2 e = q / uPxEm;
  float pxE = 1.0 / uPxEm;
  float f = 0.5 / uRoughSize;
  vec2 w = vec2(fbm(e, f * 0.5, 2, 0.5, uSeed + 3u, pxE).x,
                fbm(e + 31.4, f * 0.5, 2, 0.5, uSeed + 7u, pxE).x);
  vec2 qq = q + w * (uBurr * uPxEm);                       // burrs: push sideways
  vec2 r = fbm(e, f, 3, 0.45, uSeed + 11u, pxE);           // erosion: in and out
  float shift = (r.x * uRough - uChoke) * uPxEm;
  float soft = r.y * uRough * uPxEm + uSoft * uPxEm;
  float d = edgeDist(qq) + shift;
  float edge = ramp(d, soft, -0.5, 0.5);

  // --- ink film (AE: luma matte + Levels) ----------------------------
  float gs = max(uGrainSize, 1.25 * pxE);    // never finer than the pixels
  float film = 1.0;
  if (uGrain > 0.0) {
    vec2 n = fbmB(e, 0.5 / gs, 3, 0.5, uSeed + 1u, pxE, 0.4, 0.7);
    film = 1.0 - uGrain * (1.0 - ramp(n.x, n.y, -1.6, 1.2));
  }
  if (uHoles > 0.0) {
    float cell = gs * 3.0;
    vec2 id = floor(e / cell);
    float hole = 0.0;
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 c = id + vec2(float(i), float(j));
      vec3 rr = rand3(c, uSeed + 31u);
      if (rr.z > uHoles) continue;
      vec3 r2 = rand3(c, uSeed + 57u);
      vec2 dd = e - (c + rr.xy) * cell;
      dd.x *= 0.7 + 0.6 * r2.z;
      float rad = gs * (0.3 + 0.9 * r2.x * r2.x);
      float rEff = max(rad, pxE * 0.5);
      float cv = (1.0 - smoothstep(rEff - pxE * 0.5, rEff + pxE * 0.5, length(dd))) * min(1.0, rad * rad / (rEff * rEff));
      hole = max(hole, cv * (0.35 + 0.55 * r2.y));
    }
    film *= 1.0 - hole;
  }
  if (uMottle > 0.0) {
    float m = fbm(e, 1.0 / 0.6, 3, 0.5, uSeed + 5u, pxE).x;
    film *= 1.0 - uMottle * 0.3 * clamp(m * 0.5 + 0.5, 0.0, 1.0);
  }
  film *= mix(1.0, smoothstep(0.3, 0.52, surf.y), uSkip);   // paper valleys the type missed

  float rimPx = max(uRimWidth * uPxEm, 0.75);
  float rim = clamp(uRim * (1.0 - smoothstep(0.0, rimPx, d)), 0.0, 1.0);
  float cov = edge * uDensity * mix(film, 1.0, rim);

  // --- bleed: ink wicking into the fibres just outside the stroke ----
  float halo = 0.0;
  if (uBleed > 0.0) {
    float bw = max(uBleedWidth * uPxEm, 0.6);
    float patchy = clamp(0.45 + 0.6 * fbm(vec2(e.x, e.y * 0.4), 0.5 / uBleedWidth, 2, 0.5, uSeed + 43u, pxE).x, 0.0, 1.0);
    halo = uBleed * exp(-max(-d, 0.0) / bw) * (1.0 - edge) * patchy * mix(1.0, film, 0.5);
  }

  // --- thin dark ink at the edge shows a warm undertone --------------
  float fr = mix(uFringe.x, uFringe.y, hl);
  float tint = 0.0;
  if (fr > 0.0) {
    float fw = max(uFringeWidth * uPxEm, 0.75);
    float thin = 1.0 - smoothstep(-0.5, fw, d);
    float broken = clamp(0.55 + 0.6 * fbm(e, 0.25 / uRoughSize, 2, 0.5, uSeed + 41u, pxE).x, 0.0, 1.0);
    tint = clamp(fr * thin * broken, 0.0, 1.0);
  }
  vec3 inkC = mix(mix(uInk, uHlInk, hl), uFringeColor, tint);
  inkC *= 1.0 + (surf.x - 1.0) * 1.5 * uPaperShow;          // the film takes the paper's tooth
  cov *= 1.0 - 0.3 * tint;

  float covAll = clamp(cov + (1.0 - cov) * halo, 0.0, 1.0);
  vec3 col = mix(paper, inkC, covAll);
  o = vec4(col * stripA, stripA);
}`;

/* ------------------------------------------------------------------ */
/* Back of the strip: plain paper in the back colour                   */
/* ------------------------------------------------------------------ */
export const BACK_FS = HEAD + NOISE + PAPER + `
uniform sampler2D uStrip;
uniform float uPr, uPaperScale, uStreak;
uniform uint uSeed;
uniform vec3 uBack;

void main() {
  vec2 q = fragPx();
  float a = at(uStrip, q, uRes).a;
  if (a <= 0.0) { o = vec4(0.0); return; }
  float px = 1.0 / (uPr * uPaperScale);
  vec4 surf = paperSurface(q * px + vec2(211.0, 97.0), uSeed + 57u, px, uStreak * 0.7);
  surf.zw *= 0.5;
  o = vec4(paperColor(uBack, surf) * a, a);
}`;


/* ------------------------------------------------------------------ */
/* Composite: page, shadows, strip, folded corners. Each corner is     */
/* folded over a cylinder of radius R (like AE's CC Page Turn); with a */
/* small radius it lies almost flat, like a dog-ear pressed down.      */
/* Fold 0 is the resting corner, fold 1 a second one used by entries.  */
/* ------------------------------------------------------------------ */
export const COMPOSITE_FS = HEAD + `
uniform sampler2D uFront, uBack, uStripBlur, uStripWide;
uniform vec2 uSprite;        // sprite size, device px
uniform vec3 uInvX, uInvY;   // screen device px -> sprite device px
uniform int uOn0, uOn1;
uniform vec2 uF0, uN0, uF1, uN1;   // a point on each fold line, its unit normal towards the corner (sprite px)
uniform float uR0, uR1, uAA;       // fold radii, antialiasing width (sprite px)
uniform vec2 uDropOff, uFlapOff, uLiftOff;
uniform float uDrop, uFlapShadow, uFlapSoft, uLift;
uniform vec4 uBg;            // premultiplied
uniform float uOpacity;

const float PI = 3.14159265;

vec4 S(sampler2D t, vec2 q) {
  if (q.x < 0.0 || q.y < 0.0 || q.x > uSprite.x || q.y > uSprite.y) return vec4(0.0);
  return at(t, q, uSprite);
}
vec4 over(vec4 src, vec4 dst) { return src + dst * (1.0 - src.a); }

float dist0(vec2 q) { return uOn0 == 1 ? dot(q - uF0, uN0) : -1e6; }
float dist1(vec2 q) { return uOn1 == 1 ? dot(q - uF1, uN1) : -1e6; }
// 1 where the sheet still lies flat (not lifted by either fold)
float flat2(vec2 q) {
  return (1.0 - smoothstep(-uAA, uAA, dist0(q))) * (1.0 - smoothstep(-uAA, uAA, dist1(q)));
}

// What of the sheet is seen at p near one fold. On the flat part it is p
// itself; over the curl the front (rising) and the back (coming over) both
// project here, and the back is on top.
void fold(vec2 p, float d, vec2 N, float R, inout vec2 pf, inout float aF, inout float shF,
          out vec2 pb, out float aB, out float shB) {
  pb = vec2(-1e5); aB = 0.0; shB = 1.0;
  if (d < 0.0) {
    pb = p + (PI * R - 2.0 * d) * N; aB = 1.0;
  } else if (d < R + uAA) {
    float sil = 1.0 - smoothstep(R - uAA, R + uAA, d);
    float th = asin(clamp(d / R, 0.0, 1.0));
    pf = p + (R * th - d) * N;        shF *= 0.7 + 0.3 * cos(th);  aF *= sil;
    pb = p + (R * (PI - th) - d) * N; shB = 0.78 + 0.22 * cos(th); aB = sil;
  } else aF = 0.0;
}

// shadow cast by one folded flap, a little lifted off the strip
float flapShadow(vec2 p, vec2 F, vec2 N, float R) {
  vec2 q = p - uFlapOff;
  float dq = dot(q - F, N);
  return S(uStripBlur, q + (PI * R - 2.0 * dq) * N).r * (1.0 - smoothstep(R - uFlapSoft, R + uFlapSoft, dq));
}

void main() {
  vec2 sp = fragPx();
  vec3 h = vec3(sp, 1.0);
  vec2 p = vec2(dot(uInvX, h), dot(uInvY, h));
  vec4 c = uBg;
  float R0 = max(uR0, 0.5), R1 = max(uR1, 0.5);
  float d0 = dist0(p), d1 = dist1(p);

  // shadow on the page: tight while the strip lies on it, wide and soft while it is held above
  {
    vec2 q = p - uDropOff;
    float tight = S(uStripBlur, q).r * flat2(q);
    vec2 qw = p - uDropOff - uLiftOff;
    float wide = uLift > 0.0 ? S(uStripWide, qw).r * flat2(qw) : 0.0;
    float a = uDrop * tight * (1.0 - uLift) + 0.26 * wide * uLift;
    c = over(vec4(0.0, 0.0, 0.0, a), c);
  }

  vec2 pf = p, pb0, pb1;
  float aF = 1.0, shF = 1.0, aB0, aB1, shB0, shB1;
  if (uOn0 == 1) fold(p, d0, uN0, R0, pf, aF, shF, pb0, aB0, shB0); else { aB0 = 0.0; pb0 = vec2(-1e5); shB0 = 1.0; }
  if (uOn1 == 1) fold(p, d1, uN1, R1, pf, aF, shF, pb1, aB1, shB1); else { aB1 = 0.0; pb1 = vec2(-1e5); shB1 = 1.0; }
  // a flap whose sheet the other fold has lifted away is not there
  if (uOn0 == 1 && uOn1 == 1) {
    aB0 *= 1.0 - smoothstep(-uAA, uAA, dist1(pb0));
    aB1 *= 1.0 - smoothstep(-uAA, uAA, dist0(pb1));
  }

  vec4 F = S(uFront, pf) * aF;
  F.rgb *= shF;
  c = over(F, c);

  if (uOn0 == 1) {
    c = over(vec4(0.0, 0.0, 0.0, uFlapShadow * flapShadow(p, uF0, uN0, R0)), c);
    vec4 B = S(uBack, pb0) * aB0;
    B.rgb *= shB0;
    c = over(B, c);
  }
  if (uOn1 == 1) {
    c = over(vec4(0.0, 0.0, 0.0, uFlapShadow * flapShadow(p, uF1, uN1, R1)), c);
    vec4 B = S(uBack, pb1) * aB1;
    B.rgb *= shB1;
    c = over(B, c);
  }
  o = c * uOpacity;
}`;
