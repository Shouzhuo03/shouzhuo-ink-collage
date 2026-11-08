import {
  InkStrip, loadFont, PALETTES, ENTRIES, entryDuration, EntrySounds,
  EXPORT, exportImage, exportVideo, exportMp4, CURL_DEFAULTS,
} from '../src/index.js';
import { MiniStrip, loopEntry } from './mini.js';

const $ = (s) => document.querySelector(s);
const stage = $('#stage'), canvas = $('#out'), frameEl = $('#frame'), msg = $('#msg');

/* ---------------- state ---------------- */

const STORE = 'ink-collage-preview-v3';
const DEFAULTS = { text: '[守拙]归园田', size: 72, shape: 30, texture: 30, palette: 'navy', seed: 1, entry: 'unfurl' };
let state = { ...DEFAULTS };
try { state = { ...state, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { /* private mode */ }
if (!PALETTES[state.palette]) state.palette = DEFAULTS.palette;
if (!ENTRIES[state.entry]) state.entry = DEFAULTS.entry;
let saveTimer = 0;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* ignore */ } }, 300);
};

await loadFont().catch((e) => { msg.textContent = `内置字体加载失败：${e.message}`; });

// the stage shows the same 1920 x 1080 composition that is exported, scaled to fit
const strip = new InkStrip({ canvas, width: EXPORT.width, height: EXPORT.height, pixelRatio: 1 });

let dirty = true;
function apply() {
  strip.set({
    text: state.text, fontSize: state.size, shape: state.shape / 100, texture: state.texture / 100,
    palette: state.palette, seed: state.seed,
  });
  dirty = true;
  save();
}

function fit() {
  const W = stage.clientWidth, H = stage.clientHeight;
  const s = Math.min(W / EXPORT.width, H / EXPORT.height);
  const w = EXPORT.width * s, h = EXPORT.height * s, x = (W - w) / 2, y = (H - h) / 2;
  for (const el of [canvas, frameEl]) Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  strip.resize(EXPORT.width, EXPORT.height, (devicePixelRatio || 1) * s);
  dirty = true;
}

/* ---------------- text and sliders ---------------- */

const text = $('#text');
text.value = state.text;
text.addEventListener('input', () => { state.text = text.value; apply(); });

for (const [key, unit] of [['size', ' px'], ['shape', ''], ['texture', '']]) {
  const input = $(`#${key}`), out = $(`#${key}Out`);
  const show = () => {
    input.value = state[key];
    out.textContent = `${state[key]}${unit}`;
    input.style.setProperty('--p', `${(100 * (state[key] - input.min)) / (input.max - input.min)}%`);
  };
  input.addEventListener('input', () => { state[key] = Number(input.value); show(); apply(); });
  show();
}

/* ---------------- styles ---------------- */

const tile = (parent, name) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile';
  b.innerHTML = `<canvas></canvas><span class="name">${name}</span>`;
  parent.append(b);
  return b;
};

const styleTiles = [];
for (const [id, p] of Object.entries(PALETTES)) {
  const b = tile($('#styles'), p.name);
  b.dataset.v = id;
  b.title = `${p.name}：纸 ${p.paper}，字 ${p.ink}`;
  const mini = new MiniStrip(b.querySelector('canvas'), { text: '油墨拼贴', mark: [2, 4], size: 14, seed: 3 + styleTiles.length });
  mini.draw(id);
  // the corner trembles while hovered
  let hover = false;
  b.addEventListener('pointerenter', () => {
    hover = true;
    const tick = () => {
      if (!hover) { mini.draw(id); return; }
      mini.draw(id, null, Math.floor(performance.now() / 1000 * CURL_DEFAULTS.fps) / CURL_DEFAULTS.fps);
      requestAnimationFrame(tick);
    };
    tick();
  });
  b.addEventListener('pointerleave', () => { hover = false; });
  b.addEventListener('click', () => { state.palette = id; showSelected(); apply(); });
  styleTiles.push({ b, mini, id });
}

/* ---------------- entries ---------------- */

const sounds = new EntrySounds();
sounds.load().catch((e) => { msg.textContent = `音效加载失败：${e.message}`; });
let entryEnd = -1;
function play(name, withSound) {
  const t = performance.now() / 1000;
  strip.play(name, t);
  if (withSound) sounds.play(name);
  entryEnd = t + entryDuration(name);
  dirty = true;
}

const entryTiles = [];
for (const [name, e] of Object.entries(ENTRIES)) {
  const b = tile($('#entries'), e.label);
  b.dataset.v = name;
  const mini = new MiniStrip(b.querySelector('canvas'), { text: '油墨拼贴', mark: [2, 4], size: 13, seed: 2 });
  mini.draw(state.palette);
  let hover = false;
  b.addEventListener('pointerenter', () => { hover = true; loopEntry(mini, name, () => state.palette, () => hover); });
  b.addEventListener('pointerleave', () => { hover = false; });
  b.addEventListener('click', () => { state.entry = name; showSelected(); save(); play(name, true); });
  entryTiles.push({ b, mini, name });
}

function showSelected() {
  for (const t of styleTiles) t.b.setAttribute('aria-pressed', t.id === state.palette);
  for (const t of entryTiles) { t.b.setAttribute('aria-pressed', t.name === state.entry); t.mini.draw(state.palette); }
  $('#videoTitle').textContent = `视频 · ${ENTRIES[state.entry].label}（约 ${(entryDuration(state.entry) + EXPORT.hold).toFixed(1)} 秒）`;
}
showSelected();

/* ---------------- cut again ---------------- */

const SCISSORS = (stroke, width) => `<g stroke="${stroke}" stroke-width="${width}"><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></g>`;
const cursorSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="-1 -1 26 26" fill="none" stroke-linecap="round" stroke-linejoin="round">${SCISSORS('#fff', 4.5)}${SCISSORS('#24211d', 2)}</svg>`;
document.documentElement.style.setProperty('--scissors', `url("data:image/svg+xml,${encodeURIComponent(cursorSvg)}") 14 14, pointer`);

const recut = $('#recut');
recut.addEventListener('click', () => {
  state.seed = (state.seed | 0) + 1;
  apply();
  recut.classList.remove('snip');
  void recut.offsetWidth;
  recut.classList.add('snip');
});

/* ---------------- export ---------------- */

const menu = $('#menu'), exportBtn = $('#exportBtn'), exportLabel = $('#exportLabel'), bar = $('#bar');
const openMenu = (open) => {
  menu.hidden = !open;
  exportBtn.setAttribute('aria-expanded', open);
  document.body.classList.toggle('show-frame', open);
};
exportBtn.addEventListener('click', (e) => { e.stopPropagation(); if (!exportBtn.disabled) openMenu(menu.hidden); });
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) openMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openMenu(false); });

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const fileBase = () => {
  const words = state.text.replace(/[[\]【】\s]/g, '').slice(0, 8) || '油墨拼贴';
  return `油墨拼贴-${words}`;
};

menu.addEventListener('click', async (e) => {
  const kind = e.target.closest('button')?.dataset.kind;
  if (!kind) return;
  openMenu(false);
  exportBtn.disabled = true;
  msg.textContent = '';
  const progress = (f) => { bar.style.width = `${Math.round(f * 100)}%`; };
  try {
    if (kind === 'image') {
      exportLabel.textContent = '正在导出图片…';
      progress(0.4);
      download(await exportImage(strip.params), `${fileBase()}-4K.png`);
    } else {
      const name = state.entry;
      const mp4 = kind.startsWith('mp4');
      const backgrounds = { mp4: '#ffffff', 'mp4-green': '#00ff00', 'mp4-blue': '#0000ff' };
      const suffixes = { mp4: '白底', 'mp4-green': '绿幕', 'mp4-blue': '蓝幕' };
      exportLabel.textContent = '正在导出视频…';
      const base = fileBase();
      const blob = await (mp4 ? exportMp4 : exportVideo)(strip.params, name, {
        ...(mp4 ? { background: backgrounds[kind] } : {}),
        onProgress: (done, total) => { progress(done / total); exportLabel.textContent = `正在导出视频 ${Math.round((100 * done) / total)}%`; },
      });
      download(blob, `${base}-${ENTRIES[name].label}-4K${mp4 ? `-${suffixes[kind]}.mp4` : '.mov'}`);
      const size = (blob.size / 1048576).toFixed(1);
      msg.textContent = mp4
        ? `已导出 ${size} MB，H.264 MP4（${suffixes[kind]}）。${kind === 'mp4' ? '白底不透明；需要叠加素材时可选绿幕或蓝幕。' : '在 AM 中添加「色度键 / Chroma Key」，选取背景色并调整阈值、羽化。抠像可能损失淡阴影和细边缘；请选与纸张、文字不同的底色。'}`
        : `已导出 ${size} MB。MOV 用的是 PNG 编码，After Effects、Premiere 可以直接导入；QuickTime 播放器打不开这种编码。`;
    }
  } catch (err) {
    msg.textContent = `导出失败：${err.message}`;
  } finally {
    exportBtn.disabled = false;
    exportLabel.textContent = '导出';
    progress(0);
  }
});

/* ---------------- render loop ---------------- */

// Only the folded corner moves, in stop-motion steps: draw when the step
// changes. While an entry plays, draw every frame (the strip steps itself at 15 fps).
let lastStep = -1;
function frame(ms) {
  const t = ms / 1000, fps = strip.curl ? strip.curl.fps : 0;
  const step = fps ? Math.floor(t * fps) : 0;
  if (dirty || step !== lastStep || t < entryEnd + 0.1) {
    strip.render(t);
    lastStep = step;
    dirty = false;
  }
  requestAnimationFrame(frame);
}

new ResizeObserver(fit).observe(stage);
fit();
apply();
play(state.entry, false);   // a silent entry when the page opens (sound needs a click)
requestAnimationFrame(frame);
