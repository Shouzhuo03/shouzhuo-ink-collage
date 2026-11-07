import { ENTRIES } from './entries.js';

/** Folder of the bundled entry sounds (Kenney "Casino Audio", CC0), each cut to its entry's length. */
export const SOUNDS_URL = new URL('../sounds/', import.meta.url).href;

/** Plays matching entrance audio. Call play() from a click or key event. */
export class EntrySounds {
  constructor({ baseUrl = SOUNDS_URL, volume = 0.8 } = {}) {
    this.baseUrl = baseUrl;
    this.volume = volume;
    this.buffers = {};
    this.ctx = null;
  }

  async load(names = Object.keys(ENTRIES)) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return this;
    this.ctx = this.ctx || new AC();
    await Promise.all(names.map(async (name) => {
      const res = await fetch(new URL(ENTRIES[name].sound, this.baseUrl));
      if (!res.ok) throw new Error(`EntrySounds: ${ENTRIES[name].sound}: ${res.status}`);
      this.buffers[name] = await this.ctx.decodeAudioData(await res.arrayBuffer());
    }));
    return this;
  }

  play(name) {
    const ctx = this.ctx, buf = this.buffers[name];
    if (!ctx || !buf) return;
    if (ctx.state === 'suspended') ctx.resume();
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buf;
    gain.gain.value = this.volume;
    src.connect(gain).connect(ctx.destination);
    src.start();
  }
}
