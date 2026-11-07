import { InkStrip } from './strip.js';
import { ENTRIES, entryDuration } from './entries.js';
import { writeMov, readWav } from './mov.js';
import { SOUNDS_URL } from './sound.js';

/*
 * Export a 1920×1080 composition at 2×: transparent 4K PNG or lossless
 * PNG-in-MOV at 30 fps with PCM audio. MOV output targets AE/Premiere;
 * QuickTime Player and Final Cut do not support this PNG codec.
 */

export const EXPORT = { width: 1920, height: 1080, pixelRatio: 2, fps: 30, hold: 2 };

function pngOf(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

// a separate strip, sized for the export, with the same look
function exportStrip(params) {
  const { entry, entryStart, background, ...p } = params;
  return new InkStrip({ width: EXPORT.width, height: EXPORT.height, pixelRatio: EXPORT.pixelRatio, ...p, background: null });
}

/** A transparent 4K PNG of the strip at rest. `params`: a strip's params (e.g. strip.params). */
export async function exportImage(params, { time = 0 } = {}) {
  const s = exportStrip(params);
  try {
    s.render(time);
    return await pngOf(s.canvas);
  } finally { s.dispose(); }
}

/**
 * A transparent, lossless 4K .mov of `entry` followed by `hold` seconds at rest.
 * onProgress(done, total) is called after every frame.
 */
export async function exportVideo(params, entry, { hold = EXPORT.hold, fps = EXPORT.fps, sound = true, onProgress } = {}) {
  if (!ENTRIES[entry]) throw new Error(`exportVideo: unknown entry "${entry}"`);
  let audio = null;
  if (sound) {
    const res = await fetch(new URL(ENTRIES[entry].sound, SOUNDS_URL));
    if (res.ok) audio = readWav(await res.arrayBuffer());
  }
  const s = exportStrip(params);
  try {
    s.play(entry, 0);
    const total = Math.round((entryDuration(entry) + hold) * fps);
    const frames = [];
    let id = null, png = null;
    for (let i = 0; i < total; i++) {
      const t = i / fps;
      const next = s.frameId(t);
      if (next !== id) {            // the motion steps: encode each distinct frame once
        s.render(t);
        png = await pngOf(s.canvas);
        id = next;
      }
      frames.push(png);
      onProgress?.(i + 1, total);
    }
    return new Blob(writeMov({ width: s.canvas.width, height: s.canvas.height, fps, frames, audio }), { type: 'video/quicktime' });
  } finally { s.dispose(); }
}
