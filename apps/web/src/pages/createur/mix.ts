// Espace créateur › Mélanger: one ad = a hook then a body, cut, drawn and encoded in THIS browser (WebCodecs, through
// mediabunny), written straight into the product's pubs/ folder. Nothing goes to the server. Always 30 pictures a
// second, 1080p (or 4K when asked and the pieces are 4K), at a high bitrate (no strong compression: Meta compresses
// again anyway). The editing style draws on top: the hook's text, the subtitles word by word, small zooms, the price,
// « paiement à la livraison » and the shop's logo at the end.
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  canEncodeAudio,
  canEncodeVideo,
  Input,
  OggOutputFormat,
  Output,
  Mp4OutputFormat,
  StreamTarget,
} from 'mediabunny';
import type { InputAudioTrack, InputVideoTrack } from 'mediabunny';
import type { Segment } from './folder';

export const FPS = 30;
export const FORMATS = { '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080] } as const;
export type Format = keyof typeof FORMATS;
export type Style = 'ugly' | 'clean';

export interface Look {
  style: Style;
  format: Format;
  /** 4K (2160 on the short side) instead of 1080p */
  big: boolean;
  zoom: boolean;
  /** the hook's text at the top during the hook */
  hookText: boolean;
  subtitles: boolean;
  circle: boolean;
  end: { price: string; cod: boolean; delivery: boolean; logo: string | null; cta?: string };
}

export interface Piece {
  file: File;
  text?: string;
  words?: Segment[];
}

/** WebCodecs is there (Chrome / Edge on a computer). */
export const encodeOn = () => typeof window !== 'undefined' && typeof (window as any).VideoEncoder === 'function' && typeof (window as any).AudioEncoder === 'function';

export function size(look: Pick<Look, 'format' | 'big'>): [number, number] {
  const [w, h] = FORMATS[look.format];
  return look.big ? [w * 2, h * 2] : [w, h];
}

/** High quality: about 16 Mbit/s for 1080 × 1920 (Instagram's own best upload is lower), scaled with the picture. */
export const bitrateOf = (w: number, h: number) => Math.round(16_000_000 * ((w * h) / (1080 * 1920)) ** 0.85);

/** The video codec and bitrate this computer can make for that size (null: none). */
export async function encoderFor(w: number, h: number): Promise<{ codec: 'avc' | 'hevc'; bitrate: number } | null> {
  const want = bitrateOf(w, h);
  for (const codec of ['avc', 'hevc'] as const)
    for (const bitrate of [want, Math.round(want * 0.7)]) {
      try {
        if (await canEncodeVideo(codec, { width: w, height: h, bitrate, frameRate: FPS })) return { codec, bitrate };
      } catch {
        /* next */
      }
    }
  return null;
}

async function audioCodec(): Promise<'aac' | 'opus'> {
  try {
    if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192_000 })) return 'aac';
  } catch {
    /* Linux: no AAC encoder */
  }
  return 'opus';
}

// ---------------------------------------------------------------- drawing on top
const FONT = '"Cairo", "Noto Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif';
const rtl = (s: string) => /[֐-ࣿ]/.test(s);

function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (g.measureText(next).width > max && line) {
        out.push(line);
        line = w;
      } else line = next;
    }
    if (line) out.push(line);
  }
  return out.slice(0, 5);
}

function box(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  g.fillStyle = fill;
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
}

/** The hook's text: a white box with black letters (Ugly ads), or white letters with a shadow (Propre). */
function drawHook(g: CanvasRenderingContext2D, W: number, H: number, text: string, style: Style) {
  const k = W / 1080;
  const fs = Math.round(64 * k);
  g.font = `800 ${fs}px ${FONT}`;
  g.direction = rtl(text) ? 'rtl' : 'ltr';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lines = wrap(g, text, W * 0.82);
  const lh = fs * 1.25;
  const top = H * 0.1;
  if (style === 'ugly') {
    const bw = Math.min(W * 0.92, Math.max(...lines.map((l) => g.measureText(l).width)) + 56 * k);
    box(g, (W - bw) / 2, top - 24 * k, bw, lines.length * lh + 48 * k, 22 * k, '#FFFFFF');
    g.fillStyle = '#111111';
  } else {
    g.shadowColor = 'rgba(0,0,0,0.65)';
    g.shadowBlur = 18 * k;
    g.fillStyle = '#FFFFFF';
  }
  lines.forEach((l, i) => g.fillText(l, W / 2, top + lh * (i + 0.5)));
  g.shadowBlur = 0;
}

/** The line said now, the word said now in yellow. */
function drawWords(g: CanvasRenderingContext2D, W: number, H: number, words: Segment[] | undefined, t: number, style: Style) {
  const seg = words?.find((s) => t >= s.start && t < s.end);
  if (!seg) return;
  const k = W / 1080;
  const fs = Math.round((style === 'ugly' ? 62 : 56) * k);
  g.font = `900 ${fs}px ${FONT}`;
  const parts = seg.text.split(/\s+/).filter(Boolean);
  const now = Math.min(parts.length - 1, Math.floor(((t - seg.start) / Math.max(0.01, seg.end - seg.start)) * parts.length));
  const right = rtl(seg.text);
  g.direction = 'ltr';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  const space = g.measureText(' ').width;
  const widths = parts.map((p) => g.measureText(p).width);
  // lines that fit (the words keep their order; Arabic is laid from the right)
  const rows: number[][] = [[]];
  let wsum = 0;
  parts.forEach((_, i) => {
    if (wsum + widths[i] > W * 0.84 && rows[rows.length - 1].length) {
      rows.push([]);
      wsum = 0;
    }
    rows[rows.length - 1].push(i);
    wsum += widths[i] + space;
  });
  const lh = fs * 1.3;
  const y0 = H * 0.7 - ((rows.length - 1) * lh) / 2;
  rows.forEach((row, r) => {
    const total = row.reduce((s, i) => s + widths[i], 0) + space * (row.length - 1);
    let x = (W - total) / 2;
    const order = right ? [...row].reverse() : row;
    for (const i of order) {
      const y = y0 + r * lh;
      if (style === 'ugly' && i === now) box(g, x - 10 * k, y - fs * 0.62, widths[i] + 20 * k, fs * 1.24, 12 * k, '#FFE14D');
      g.lineJoin = 'round';
      g.lineWidth = 10 * k;
      g.strokeStyle = i === now && style === 'ugly' ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0.85)';
      if (!(i === now && style === 'ugly')) g.strokeText(parts[i], x, y);
      g.fillStyle = i === now ? (style === 'ugly' ? '#111111' : '#FFE14D') : '#FFFFFF';
      g.fillText(parts[i], x, y);
      x += widths[i] + space;
    }
  });
}

/** A red circle drawn by hand around the middle (the product, most of the time). */
function drawCircle(g: CanvasRenderingContext2D, W: number, H: number, share: number) {
  const k = W / 1080;
  g.strokeStyle = '#FF2D2D';
  g.lineWidth = 12 * k;
  g.lineCap = 'round';
  g.beginPath();
  const a0 = -Math.PI * 0.6;
  const steps = 48;
  for (let i = 0; i <= Math.round(steps * Math.min(1, share * 1.6)); i++) {
    const a = a0 + (i / steps) * Math.PI * 2.15;
    const r = W * 0.3 * (1 + 0.06 * Math.sin(i * 0.9));
    const x = W / 2 + Math.cos(a) * r;
    const y = H * 0.48 + Math.sin(a) * r * 0.82;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.stroke();
}

function drawEnd(g: CanvasRenderingContext2D, W: number, H: number, end: Look['end'], logo: HTMLImageElement | null, showLogo: boolean) {
  const k = W / 1080;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.direction = 'rtl';
  let y = H * 0.84;
  // the awareness ending (« Abonnez-vous et commentez CODE »): above the price
  if (end.cta?.trim()) {
    const fs = Math.round(50 * k);
    g.font = `900 ${fs}px ${FONT}`;
    const t = end.cta.trim();
    const w = Math.min(W - 40 * k, g.measureText(t).width + 50 * k);
    const cy = H * 0.68;
    box(g, (W - w) / 2, cy - fs * 0.75, w, fs * 1.5, 18 * k, '#F39A1E');
    g.fillStyle = '#FFFFFF';
    g.fillText(t, W / 2, cy, W - 70 * k);
  }
  if (end.price.trim()) {
    const fs = Math.round(76 * k);
    g.font = `900 ${fs}px ${FONT}`;
    const t = `${end.price.trim()} دج`;
    const w = g.measureText(t).width + 60 * k;
    box(g, (W - w) / 2, y - fs * 0.7, w, fs * 1.4, 20 * k, '#FFE14D');
    g.fillStyle = '#111111';
    g.fillText(t, W / 2, y);
    y += fs * 1.25;
  }
  const line = [end.cod ? 'الدفع عند الاستلام' : '', end.delivery ? 'التوصيل لـ 58 ولاية' : ''].filter(Boolean).join(' · ');
  if (line) {
    const fs = Math.round(44 * k);
    g.font = `800 ${fs}px ${FONT}`;
    const w = g.measureText(line).width + 40 * k;
    box(g, (W - w) / 2, y - fs * 0.7, w, fs * 1.4, 14 * k, 'rgba(0,0,0,0.75)');
    g.fillStyle = '#FFFFFF';
    g.fillText(line, W / 2, y);
  }
  if (showLogo && logo) {
    const s = W * 0.26;
    box(g, (W - s) / 2 - 16 * k, H * 0.3 - 16 * k, s + 32 * k, s + 32 * k, 28 * k, '#FFFFFF');
    const r = Math.min(s / logo.naturalWidth, s / logo.naturalHeight);
    const lw = logo.naturalWidth * r;
    const lh = logo.naturalHeight * r;
    g.drawImage(logo, (W - lw) / 2, H * 0.3 + (s - lh) / 2, lw, lh);
  }
}

function loadImage(src: string | null): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((ok) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => ok(null);
    i.src = src;
  });
}

// ---------------------------------------------------------------- one ad
export class Stopped extends Error {}
export type Progress = (share: number) => void;

/**
 * A piece's sound from `first` for `len` seconds, at `rate` Hz with `channels` channels (resampled by the browser), the
 * gaps and the missing sound as silence: every piece then has the same sound settings (the encoder needs that).
 */
async function soundOf(at: InputAudioTrack | null, first: number, len: number, rate: number, channels: number, stop: () => boolean = () => false): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.round(len * rate));
  const ctx = new OfflineAudioContext(channels, frames, rate);
  if (at && (await at.canDecode())) {
    let src: AudioBuffer | null = null;
    const sink = new AudioSampleSink(at);
    for await (const s of sink.samples(first, first + len)) {
      try {
        if (stop()) throw new Stopped();
        if (!src) src = new AudioBuffer({ length: Math.max(1, Math.ceil(len * s.sampleRate)), numberOfChannels: s.numberOfChannels, sampleRate: s.sampleRate });
        const at0 = Math.round((s.timestamp - first) * src.sampleRate);
        const plane = new Float32Array(s.numberOfFrames);
        for (let c = 0; c < Math.min(src.numberOfChannels, s.numberOfChannels); c++) {
          s.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          const from = Math.max(0, -at0);
          const to = Math.min(plane.length, src.length - at0);
          if (to > from) src.getChannelData(c).set(plane.subarray(from, to), Math.max(0, at0));
        }
      } finally {
        s.close();
      }
    }
    if (src) {
      const node = ctx.createBufferSource();
      node.buffer = src;
      node.connect(ctx.destination);
      node.start(0);
    }
  }
  return ctx.startRendering();
}

/** How long a piece lasts (its video track), in seconds. */
export async function pieceLength(file: File): Promise<number> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) return 0;
    return Math.max(0, (await vt.computeDuration()) - (await vt.getFirstTimestamp()));
  } finally {
    input.dispose?.();
  }
}

/**
 * Makes the ad (hook, then body) into `target` (a file of pubs/). `stop()` true cuts it (the half-written file is the
 * caller's to delete). Throws a readable message when this computer cannot read a piece or make the video.
 */
export async function makeAd(o: {
  hook: Piece;
  body: Piece;
  look: Look;
  target: FileSystemFileHandle;
  progress: Progress;
  stop: () => boolean;
}): Promise<{ seconds: number; w: number; h: number; codec: string }> {
  const [W, H] = size(o.look);
  const enc = await encoderFor(W, H);
  if (!enc) throw new Error(o.look.big ? 'Cet ordinateur ne sait pas faire de vidéo 4K : choisissez 1080p.' : 'Cet ordinateur ne sait pas faire de vidéo HD dans ce navigateur.');
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d', { alpha: false })!;
  const logo = await loadImage(o.look.end.logo);
  const writable = await o.target.createWritable();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new StreamTarget(writable as unknown as WritableStream) });
  const video = new CanvasSource(canvas, { codec: enc.codec, bitrate: enc.bitrate, keyFrameInterval: 1 });
  const aCodec = await audioCodec();
  const audio = new AudioSampleSource({ codec: aCodec, bitrate: 192_000 });
  output.addVideoTrack(video, { frameRate: FPS });
  output.addAudioTrack(audio);
  await output.start();

  const pieces = [o.hook, o.body];
  const inputs = pieces.map((p) => new Input({ source: new BlobSource(p.file), formats: ALL_FORMATS }));
  let T = 0;
  try {
    const lens: number[] = [];
    const tracks: { vt: InputVideoTrack; first: number; at: InputAudioTrack | null }[] = [];
    for (const input of inputs) {
      const vt = await input.getPrimaryVideoTrack();
      if (!vt || !(await vt.canDecode())) throw new Error('Ce navigateur ne sait pas lire une de ces vidéos (souvent une vidéo d’iPhone en HEVC) : exportez-la en H.264.');
      const first = await vt.getFirstTimestamp();
      lens.push(Math.max(1 / FPS, (await vt.computeDuration()) - first));
      tracks.push({ vt, first, at: await input.getPrimaryAudioTrack() });
    }
    const total = lens.reduce((a, b) => a + b, 0);
    const frames = lens.map((l) => Math.max(1, Math.round(l * FPS)));
    const all = frames.reduce((a, b) => a + b, 0);
    let made = 0;
    for (let p = 0; p < pieces.length; p++) {
      const { vt, first, at } = tracks[p];
      const n = frames[p];
      const len = n / FPS;
      const isHook = p === 0;
      // the sound first (it is light): the piece's own, cut to its pictures, always 48 kHz stereo; silence when it has none
      const snd = await soundOf(at, first, len, 48000, 2, o.stop);
      for (const z of AudioSample.fromAudioBuffer(snd, T)) {
        await audio.add(z);
        z.close();
      }

      // the pictures, 30 a second, covering the whole frame (cut to the format)
      const sink = new CanvasSink(vt, { width: W, height: H, fit: 'cover', poolSize: 3 });
      const times = function* () {
        for (let i = 0; i < n; i++) yield first + i / FPS;
      };
      let i = 0;
      let last: HTMLCanvasElement | OffscreenCanvas | null = null;
      for await (const wc of sink.canvasesAtTimestamps(times())) {
        if (o.stop()) throw new Stopped();
        const local = i / FPS;
        const src: HTMLCanvasElement | OffscreenCanvas | null = wc?.canvas ?? last;
        g.fillStyle = '#000';
        g.fillRect(0, 0, W, H);
        if (src) {
          last = src;
          // small zooms: the body comes slowly closer (the hook stays still)
          const z = o.look.zoom && !isHook ? 1 + 0.07 * (local / len) : 1;
          const zw = W * z;
          const zh = H * z;
          g.drawImage(src as CanvasImageSource, (W - zw) / 2, (H - zh) / 2, zw, zh);
        }
        const piece = pieces[p];
        if (isHook && o.look.hookText && piece.text?.trim()) drawHook(g, W, H, piece.text.trim(), o.look.style);
        if (o.look.subtitles) drawWords(g, W, H, piece.words, local, o.look.style);
        if (!isHook && o.look.circle && local < 1.4) drawCircle(g, W, H, local / 1.4);
        // the end: the price, the paiement à la livraison, the logo
        if (!isHook && len - local <= 2.5) drawEnd(g, W, H, o.look.end, logo, len - local <= 1.5);
        await video.add(T + local, 1 / FPS);
        i++;
        made++;
        if (made % 5 === 0) o.progress(Math.min(0.99, made / all));
      }
      T += len;
    }
    await output.finalize();
    o.progress(1);
    return { seconds: total, w: W, h: H, codec: enc.codec };
  } catch (e) {
    await output.cancel().catch(() => undefined);
    await (writable as FileSystemWritableFileStream).abort?.().catch(() => undefined);
    throw e;
  } finally {
    for (const x of inputs) x.dispose?.();
  }
}

// ---------------------------------------------------------------- the sound of a piece, for its subtitles
/** A WAV file (16-bit PCM) of a mono sound. */
function wav(b: AudioBuffer): Uint8Array {
  const d = b.getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + d.length * 2));
  const str = (o: number, x: string) => [...x].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  out.setUint32(4, 36 + d.length * 2, true);
  str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, b.sampleRate, true);
  out.setUint32(28, b.sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, d.length * 2, true);
  for (let i = 0; i < d.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i])) * 0x7fff, true);
  return new Uint8Array(out.buffer);
}

/** The piece's sound, small (Opus in Ogg, or WAV 16 kHz when this browser has no Opus encoder), as base64. */
export async function pieceSound(file: File): Promise<{ audio: string; mime: 'audio/ogg' | 'audio/wav'; seconds: number } | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const at = await input.getPrimaryAudioTrack();
    if (!at || !(await at.canDecode())) return null;
    const first = await at.getFirstTimestamp();
    let opus = false;
    try {
      opus = await canEncodeAudio('opus', { numberOfChannels: 1, sampleRate: 48000, bitrate: 32_000 });
    } catch {
      opus = false;
    }
    // WAV is big: 90 seconds at most (Opus: 3 minutes)
    const seconds = Math.min(opus ? 180 : 90, Math.max(0.2, (await at.computeDuration()) - first));
    let bytes: Uint8Array;
    if (opus) {
      const snd = await soundOf(at, first, seconds, 48000, 1);
      const target = new BufferTarget();
      const out = new Output({ format: new OggOutputFormat(), target });
      const src = new AudioSampleSource({ codec: 'opus', bitrate: 32_000 });
      out.addAudioTrack(src);
      await out.start();
      for (const z of AudioSample.fromAudioBuffer(snd, 0)) {
        await src.add(z);
        z.close();
      }
      await out.finalize();
      bytes = new Uint8Array(target.buffer!);
    } else bytes = wav(await soundOf(at, first, seconds, 16000, 1));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { audio: btoa(bin), mime: opus ? 'audio/ogg' : 'audio/wav', seconds };
  } finally {
    input.dispose?.();
  }
}

/** Up to `max` pairs where every hook and every body come back as evenly as possible. */
export function goodMix(hooks: number, bodies: number, max: number): [number, number][] {
  const out: [number, number][] = [];
  const all = hooks * bodies;
  const n = Math.min(max, all);
  const seen = new Set<string>();
  for (let k = 0; out.length < n && k < all * 2; k++) {
    const h = k % hooks;
    const b = (Math.floor(k / hooks) + k) % bodies;
    const key = `${h}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([h, b]);
  }
  for (let h = 0; out.length < n && h < hooks; h++) for (let b = 0; out.length < n && b < bodies; b++) if (!seen.has(`${h}:${b}`)) (seen.add(`${h}:${b}`), out.push([h, b]));
  return out;
}
