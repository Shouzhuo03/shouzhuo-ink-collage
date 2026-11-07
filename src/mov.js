/*
 * QuickTime MOV writer: lossless PNG frames with alpha, optional 16-bit PCM.
 * frames: PNG Blobs or Uint8Arrays, one per video frame (duplicates allowed).
 * audio: { sampleRate, channels, pcm: Int16Array (interleaved) } or null.
 * Returns Uint8Array/Blob parts suitable for new Blob(parts).
 * PNG-in-MOV targets AE/Premiere; QuickTime Player and Final Cut do not
 * support this codec.
 */

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const zeros = (n) => new Uint8Array(n);
function num(bytes, v) {
  const b = new Uint8Array(bytes), d = new DataView(b.buffer);
  if (bytes === 1) d.setUint8(0, v);
  else if (bytes === 2) d.setUint16(0, v & 0xffff);
  else if (bytes === 3) { d.setUint8(0, (v >>> 16) & 255); d.setUint16(1, v & 0xffff); }
  else if (bytes === 4) d.setUint32(0, v >>> 0);
  else d.setBigUint64(0, BigInt(v));
  return b;
}
const u8 = (v) => num(1, v), u16 = (v) => num(2, v), u24 = (v) => num(3, v), u32 = (v) => num(4, v), u64 = (v) => num(8, v);
const fixed = (v) => u32(Math.round(v * 65536));           // 16.16
function pascal(s, size) {                                  // counted string, optionally padded
  const b = ascii(s), out = new Uint8Array(size || b.length + 1);
  out[0] = b.length; out.set(b, 1);
  return out;
}
function cat(parts) {
  const flat = parts.flat(Infinity);
  let n = 0;
  for (const p of flat) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of flat) { out.set(p, o); o += p.length; }
  return out;
}
const atom = (type, ...body) => { const b = cat(body); return cat([u32(8 + b.length), ascii(type), b]); };
const full = (type, version, flags, ...body) => atom(type, u8(version), u24(flags), ...body);
const MATRIX = [u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)];

const sizeOf = (x) => (x instanceof Uint8Array ? x.length : x.size);

function handler(kind, sub, name) {
  return full('hdlr', 0, 0, ascii(kind), ascii(sub), u32(0), u32(0), u32(0), pascal(name));
}
const dinf = () => atom('dinf', full('dref', 0, 0, u32(1), full('alis', 0, 1)));
function chunkOffsets(offsets) {
  const big = offsets.some((o) => o > 0xffffffff);
  return big
    ? full('co64', 0, 0, u32(offsets.length), offsets.map(u64))
    : full('stco', 0, 0, u32(offsets.length), offsets.map(u32));
}

function videoTrack({ width, height, fps, sizes, offsets, movieScale }) {
  const n = sizes.length;
  const stsd = full('stsd', 0, 0, u32(1), atom('png ',
    zeros(6), u16(1),                       // reserved, data reference index
    u16(0), u16(0), u32(0),                 // version, revision, vendor
    u32(0), u32(0x400),                     // temporal quality, spatial quality (lossless)
    u16(width), u16(height),
    fixed(72), fixed(72), u32(0), u16(1),   // resolution, data size, frames per sample
    pascal('PNG', 32), u16(32), u16(0xffff) // compressor name, depth (with alpha), no colour table
  ));
  const stbl = atom('stbl', stsd,
    full('stts', 0, 0, u32(1), u32(n), u32(1)),
    full('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
    full('stsz', 0, 0, u32(0), u32(n), sizes.map(u32)),
    chunkOffsets(offsets));
  const minf = atom('minf', full('vmhd', 0, 1, u16(0x40), u16(0x8000), u16(0x8000), u16(0x8000)),
    handler('dhlr', 'alis', 'DataHandler'), dinf(), stbl);
  const mdia = atom('mdia',
    full('mdhd', 0, 0, u32(0), u32(0), u32(fps), u32(n), u16(0), u16(0)),
    handler('mhlr', 'vide', 'VideoHandler'), minf);
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(Math.round(n / fps * movieScale)),
    zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, fixed(width), fixed(height));
  return atom('trak', tkhd, mdia);
}

function audioTrack({ sampleRate, channels, frames, offset, movieScale }) {
  const stsd = full('stsd', 0, 0, u32(1), atom('sowt',
    zeros(6), u16(1),
    u16(0), u16(0), u32(0),                 // version 0 sound description
    u16(channels), u16(16), u16(0), u16(0), // channels, bits, compression id, packet size
    u32(sampleRate * 65536)                 // 16.16
  ));
  const stbl = atom('stbl', stsd,
    full('stts', 0, 0, u32(1), u32(frames), u32(1)),
    full('stsc', 0, 0, u32(1), u32(1), u32(frames), u32(1)),
    full('stsz', 0, 0, u32(2 * channels), u32(frames)),
    chunkOffsets([offset]));
  const minf = atom('minf', full('smhd', 0, 0, u16(0), u16(0)), handler('dhlr', 'alis', 'DataHandler'), dinf(), stbl);
  const mdia = atom('mdia',
    full('mdhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(frames), u16(0), u16(0)),
    handler('mhlr', 'soun', 'SoundHandler'), minf);
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(2), u32(0), u32(Math.round(frames / sampleRate * movieScale)),
    zeros(8), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, fixed(0), fixed(0));
  return atom('trak', tkhd, mdia);
}

export function writeMov({ width, height, fps, frames, audio = null }) {
  const movieScale = 600;
  const ftyp = atom('ftyp', ascii('qt  '), u32(0x20050300), ascii('qt  '));
  let pcm = null;
  if (audio && audio.pcm && audio.pcm.length) {
    // QuickTime 'sowt' is little-endian 16-bit, which is what Int16Array is on every browser
    pcm = new Uint8Array(audio.pcm.buffer, audio.pcm.byteOffset, audio.pcm.byteLength);
  }
  const sizes = frames.map(sizeOf);
  const payload = sizes.reduce((a, b) => a + b, 0) + (pcm ? pcm.length : 0);
  const large = payload + 8 > 0xffffffff;
  const mdatHead = large ? cat([u32(1), ascii('mdat'), u64(payload + 16)]) : cat([u32(payload + 8), ascii('mdat')]);

  let at = ftyp.length + mdatHead.length;
  const offsets = sizes.map((s) => { const o = at; at += s; return o; });
  const audioOffset = at;

  const tracks = [videoTrack({ width, height, fps, sizes, offsets, movieScale })];
  if (pcm) tracks.push(audioTrack({ sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.pcm.length / audio.channels, offset: audioOffset, movieScale }));
  const seconds = Math.max(frames.length / fps, pcm ? audio.pcm.length / audio.channels / audio.sampleRate : 0);
  const duration = Math.round(seconds * movieScale);
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(movieScale), u32(duration),
    u32(0x10000), u16(0x0100), zeros(10), MATRIX, u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(tracks.length + 1));
  const moov = atom('moov', mvhd, ...tracks);
  return [ftyp, mdatHead, ...frames, ...(pcm ? [pcm] : []), moov];
}

/** Read a 16-bit PCM WAV file (ArrayBuffer) into { sampleRate, channels, pcm }. */
export function readWav(buf) {
  const d = new DataView(buf);
  const tag = (o) => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('readWav: not a WAV file');
  let o = 12, fmt = null;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o), len = d.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') fmt = { channels: d.getUint16(body + 2, true), sampleRate: d.getUint32(body + 4, true), bits: d.getUint16(body + 14, true) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error('readWav: only 16-bit PCM');
      const pcm = new Int16Array(buf.slice(body, body + len - (len % 2)));
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, pcm };
    }
    o = body + len + (len % 2);
  }
  throw new Error('readWav: no data chunk');
}
