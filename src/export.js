import { InkStrip } from './strip.js';
import { ENTRIES, entryDuration } from './entries.js';
import { writeMov, readWav } from './mov.js';
import { SOUNDS_URL } from './sound.js';
import { writeMp4 } from './mp4.js';

/*
 * Export a 1920×1080 composition at 2×: transparent 4K PNG or lossless
 * PNG-in-MOV at 30 fps with PCM audio, or opaque H.264 MP4 with AAC.
 * MOV output targets AE/Premiere;
 * QuickTime Player and Final Cut do not support this PNG codec.
 */

export const EXPORT = { width: 1920, height: 1080, pixelRatio: 2, fps: 30, hold: 2 };

function pngOf(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

// a separate strip, sized for the export, with the same look
function exportStrip(params, background = null) {
  const { entry, entryStart, background: unused, ...p } = params;
  return new InkStrip({ ...p, width: EXPORT.width, height: EXPORT.height, pixelRatio: EXPORT.pixelRatio, background });
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function avcConfig(fps, bitrate) {
  if (!globalThis.VideoEncoder || !globalThis.VideoFrame) {
    throw new Error('当前浏览器不支持 MP4 编码，请通过 localhost 或 HTTPS 使用新版 Chrome、Edge 或 Safari');
  }
  for (const codec of ['avc1.640033', 'avc1.4d0033', 'avc1.420033']) {
    const config = { codec, width: EXPORT.width * EXPORT.pixelRatio, height: EXPORT.height * EXPORT.pixelRatio,
      framerate: fps, bitrate, latencyMode: 'realtime', avc: { format: 'avc' } };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch { /* Try the next AVC profile. */ }
  }
  throw new Error('当前浏览器或设备不支持 4K H.264 编码，请换用新版桌面 Chrome、Edge 或 Safari');
}

/** 4K H.264 MP4 with AAC sound. H.264 is opaque; background defaults to white. */
export async function exportMp4(params, entry, {
  hold = EXPORT.hold, fps = EXPORT.fps, sound = true, background = '#ffffff', bitrate = 40000000, onProgress,
} = {}) {
  if (!ENTRIES[entry]) throw new Error(`exportMp4: unknown entry "${entry}"`);
  if (!Number.isInteger(fps) || fps < 1 || fps > 30 || !Number.isFinite(hold) || hold < 0 || !Number.isFinite(bitrate) || bitrate <= 0) {
    throw new Error('MP4: fps must be an integer from 1 to 30; hold must be nonnegative; bitrate must be positive');
  }
  if (typeof background !== 'string' || !/^#[0-9a-f]{6}$/i.test(background)) {
    throw new Error('MP4 background must be an opaque #RRGGBB color');
  }
  const config = await avcConfig(fps, bitrate);
  const total = Math.round((entryDuration(entry) + hold) * fps);
  let wav = null, audioSettings = null;
  if (sound) {
    if (!globalThis.AudioEncoder || !globalThis.AudioData) throw new Error('当前浏览器不支持 AAC 音效编码，请换用新版 Chrome、Edge 或 Safari');
    const res = await fetch(new URL(ENTRIES[entry].sound, SOUNDS_URL));
    if (!res.ok) throw new Error(`音效加载失败（HTTP ${res.status}）`);
    wav = readWav(await res.arrayBuffer());
    audioSettings = { codec: 'mp4a.40.2', sampleRate: wav.sampleRate, numberOfChannels: wav.channels, bitrate: 128000 };
    if (!(await AudioEncoder.isConfigSupported(audioSettings)).supported) {
      throw new Error('当前浏览器不支持 AAC 音效编码，请换用新版 Chrome、Edge 或 Safari');
    }
  }

  let strip = null, encoder = null, audioEncoder = null, failure = null;
  let videoConfig = null, audioConfig = null;
  const video = [], audio = [];
  const output = (samples, setConfig) => (chunk, metadata) => {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    samples.push({ data, timestamp: chunk.timestamp, key: chunk.type === 'key' });
    if (metadata?.decoderConfig) {
      const c = metadata.decoderConfig;
      setConfig({ ...c, description: c.description ? new Uint8Array(c.description).slice() : undefined });
    }
  };
  const check = () => { if (failure) throw failure; };
  const queue = async (enc) => {
    while (enc.encodeQueueSize >= 4) { check(); await tick(); }
    check();
  };
  try {
    encoder = new VideoEncoder({ output: output(video, (c) => { videoConfig = c; }), error: (e) => { failure = e; } });
    encoder.configure(config);
    strip = exportStrip(params, background);
    strip.play(entry, 0);
    let id = null;
    for (let i = 0; i < total; i++) {
      await queue(encoder);
      const time = i / fps, next = strip.frameId(time);
      if (next !== id) { strip.render(time); id = next; }
      const timestamp = Math.round(i * 1e6 / fps);
      const frame = new VideoFrame(strip.canvas, { timestamp, duration: Math.round((i + 1) * 1e6 / fps) - timestamp });
      try { encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 }); }
      finally { frame.close(); }
      onProgress?.(i + 1, total + 1);
      await tick();
    }
    await encoder.flush();
    check();
    if (video.length !== total) throw new Error('MP4: encoder did not return all frames');

    if (wav) {
      audioEncoder = new AudioEncoder({ output: output(audio, (c) => { audioConfig = c; }), error: (e) => { failure = e; } });
      audioEncoder.configure(audioSettings);
      const length = Math.round(total / fps * wav.sampleRate);
      for (let offset = 0; offset < length; offset += 1024) {
        await queue(audioEncoder);
        const count = Math.min(1024, length - offset);
        const data = new Float32Array(count * wav.channels);
        for (let j = 0; j < data.length; j++) data[j] = (wav.pcm[offset * wav.channels + j] || 0) / 32768;
        const frame = new AudioData({ format: 'f32', sampleRate: wav.sampleRate, numberOfChannels: wav.channels,
          numberOfFrames: count, timestamp: Math.round(offset * 1e6 / wav.sampleRate), data });
        try { audioEncoder.encode(frame); }
        finally { frame.close(); }
      }
      await audioEncoder.flush();
      check();
      if (!audio.length) throw new Error('MP4: encoder did not return audio');
    }
    const blob = new Blob(writeMp4({ width: strip.canvas.width, height: strip.canvas.height, fps,
      video, videoConfig, audio, audioConfig }), { type: 'video/mp4' });
    onProgress?.(total + 1, total + 1);
    return blob;
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close();
    if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
    strip?.dispose();
  }
}
