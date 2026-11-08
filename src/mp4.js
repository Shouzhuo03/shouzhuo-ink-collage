/* MP4 packaging for WebCodecs AVC (without frame reordering) and AAC-LC. */
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const zeros = (n) => new Uint8Array(n);
function number(bytes, value) {
  const out = zeros(bytes), view = new DataView(out.buffer);
  if (bytes === 2) view.setUint16(0, value);
  else view.setUint32(0, value);
  return out;
}
const u16 = (n) => number(2, n), u32 = (n) => number(4, n);
const fixed = (n) => u32(Math.round(n * 65536));
function cat(parts) {
  const flat = parts.flat(Infinity);
  const out = zeros(flat.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of flat) { out.set(p, offset); offset += p.length; }
  return out;
}
const box = (type, ...parts) => {
  const body = cat(parts);
  return cat([u32(body.length + 8), ascii(type), body]);
};
const full = (type, flags, ...parts) => box(type, u32(flags), ...parts);
const MATRIX = [u32(65536), u32(0), u32(0), u32(0), u32(65536), u32(0), u32(0), u32(0), u32(0x40000000)];
const handler = (type) => full('hdlr', 0, u32(0), ascii(type), zeros(12), ascii('Ink Collage\0'));
const dinf = () => box('dinf', full('dref', 0, u32(1), full('url ', 1)));

function descriptor(tag, data) {
  // MPEG-4 descriptors use a variable-length, 7-bit size.
  const size = [data.length & 127];
  for (let n = data.length >>> 7; n; n >>>= 7) size.unshift((n & 127) | 128);
  return cat([new Uint8Array([tag, ...size]), data]);
}

function sampleTable(samples, description, offsets, video) {
  const runs = [];
  for (const sample of samples) {
    const delta = video ? 1 : 1024; // AAC-LC has 1024 PCM samples per packet.
    const last = runs[runs.length - 1];
    if (last && last[1] === delta) last[0]++;
    else runs.push([1, delta]);
  }
  const keys = samples.flatMap((s, i) => s.key ? [u32(i + 1)] : []);
  return box('stbl', full('stsd', 0, u32(1), description),
    full('stts', 0, u32(runs.length), runs.map(([n, d]) => [u32(n), u32(d)])),
    full('stsc', 0, u32(1), u32(1), u32(1), u32(1)),
    full('stsz', 0, u32(0), u32(samples.length), samples.map((s) => u32(s.data.length))),
    full('stco', 0, u32(offsets.length), offsets.map(u32)),
    ...(video ? [full('stss', 0, u32(keys.length), keys)] : []));
}

function track({ id, samples, config, offsets, width = 0, height = 0, fps, duration }) {
  const video = id === 1;
  const timescale = video ? fps : config.sampleRate;
  const mediaDuration = video ? samples.length : samples.length * 1024;
  let description;
  if (video) {
    const name = zeros(32);
    name[0] = 5; name.set(ascii('H.264'), 1);
    description = box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height),
      fixed(72), fixed(72), u32(0), u16(1), name, u16(24), u16(65535), box('avcC', config.description));
  } else {
    const decoder = descriptor(4, cat([new Uint8Array([0x40, 0x15, 0, 0, 0]),
      u32(128000), u32(128000), descriptor(5, config.description)]));
    const esds = full('esds', 0, descriptor(3, cat([u16(2), new Uint8Array([0]), decoder,
      descriptor(6, new Uint8Array([2]))])));
    description = box('mp4a', zeros(6), u16(1), zeros(8), u16(config.numberOfChannels),
      u16(16), zeros(4), fixed(config.sampleRate), esds);
  }
  const tkhd = full('tkhd', 3, u32(0), u32(0), u32(id), u32(0), u32(duration),
    zeros(8), u16(0), u16(0), u16(video ? 0 : 256), u16(0), MATRIX, fixed(width), fixed(height));
  // Trim AAC encoder priming and padding while keeping the sound aligned to frame zero.
  const skip = video ? 0 : Math.max(0, Math.round(-samples[0].timestamp * timescale / 1e6));
  const edit = box('edts', full('elst', 0, u32(1), u32(duration), u32(skip), u16(1), u16(0)));
  const mdia = box('mdia', full('mdhd', 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0)),
    handler(video ? 'vide' : 'soun'), box('minf',
      video ? full('vmhd', 1, zeros(8)) : full('smhd', 0, zeros(4)),
      dinf(), sampleTable(samples, description, offsets, video)));
  return box('trak', tkhd, edit, mdia);
}

/** Encoded samples carry { data: Uint8Array, timestamp (µs), key }. */
export function writeMp4({ width, height, fps, video, videoConfig, audio = [], audioConfig }) {
  if (!video.length || !videoConfig?.description?.length) throw new Error('MP4: missing AVC configuration or frames');
  if (!video[0].key) throw new Error('MP4: first frame must be a keyframe');
  for (let i = 1; i < video.length; i++) {
    if (video[i].timestamp <= video[i - 1].timestamp) throw new Error('MP4: reordered AVC frames are not supported');
  }
  if (audio.length && !audioConfig?.description?.length) throw new Error('MP4: missing AAC configuration');
  const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isomiso2avc1mp41'));
  const movieScale = 600, duration = Math.round(video.length / fps * movieScale);
  const mvhd = full('mvhd', 0, u32(0), u32(0), u32(movieScale), u32(duration),
    fixed(1), u16(256), zeros(10), MATRIX, zeros(24), u32(audio.length ? 3 : 2));
  const movie = (videoOffsets, audioOffsets) => box('moov', mvhd,
    track({ id: 1, samples: video, config: videoConfig, offsets: videoOffsets, width, height, fps, duration }),
    ...(audio.length ? [track({ id: 2, samples: audio, config: audioConfig, offsets: audioOffsets, duration })] : []));
  const dummy = movie(video.map(() => 0), audio.map(() => 0));
  let offset = ftyp.length + dummy.length + 8;
  const offsets = (samples) => samples.map((s) => { const at = offset; offset += s.data.length; return at; });
  const videoOffsets = offsets(video), audioOffsets = offsets(audio);
  if (offset > 0xffffffff) throw new Error('MP4: file exceeds 4 GB');
  const moov = movie(videoOffsets, audioOffsets);
  const payload = offset - ftyp.length - moov.length;
  return [ftyp, moov, u32(payload), ascii('mdat'), ...video.map((s) => s.data), ...audio.map((s) => s.data)];
}
