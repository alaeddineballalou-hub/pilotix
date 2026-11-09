// Pilot Content: a picked video, sent at its highest quality — the original file, never re-encoded:
// - its length and picture size (from the browser, or from the file's own index when the browser cannot play it);
// - a still from it for the calendar (360 px JPEG; a plain card when the browser cannot show its pictures);
// - its index moved to the front when the phone wrote it at the end (as Instagram asks, @pilotix/shared mp4.ts: the
//   pictures and sound stay byte for byte the same);
// - sent in pieces of 8 MB (each one tried again a few times on a weak line), with the share already sent.
import { faststartPieces, mp4Info } from '@pilotix/shared';

export interface PlanVideo {
  mime: 'video/mp4' | 'video/quicktime';
  w: number;
  h: number;
  duration: number;
  thumb: string;
  /** the video for the editor's player (this browser only) */
  local: string;
}

const typeOf = (f: File): PlanVideo['mime'] | null => {
  if (f.type === 'video/quicktime' || /\.mov$/i.test(f.name)) return 'video/quicktime';
  if (f.type === 'video/mp4' || /\.(mp4|m4v)$/i.test(f.name)) return 'video/mp4';
  return null;
};

const read = (f: Blob) => (s: number, e: number) => f.slice(s, e).arrayBuffer().then((b) => new Uint8Array(b));
const b64 = (c: HTMLCanvasElement, q: number) => c.toDataURL('image/jpeg', q).replace(/^data:[^,]+,/, '');

function once(el: HTMLVideoElement, ev: string, ms: number): Promise<boolean> {
  return new Promise((ok) => {
    const t = window.setTimeout(() => done(false), ms);
    const done = (v: boolean) => {
      window.clearTimeout(t);
      el.removeEventListener(ev, yes);
      el.removeEventListener('error', no);
      ok(v);
    };
    const yes = () => done(true);
    const no = () => done(false);
    el.addEventListener(ev, yes);
    el.addEventListener('error', no);
  });
}

/** A plain card (the video's shape, a play mark) when the browser cannot show the video's pictures. */
function card(w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = 360;
  c.height = Math.max(120, Math.min(800, Math.round((360 * h) / Math.max(1, w))));
  const g = c.getContext('2d')!;
  g.fillStyle = '#1B2A47';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#F7A823';
  const r = 34;
  g.beginPath();
  g.moveTo(c.width / 2 - r / 2, c.height / 2 - r);
  g.lineTo(c.width / 2 + r, c.height / 2);
  g.lineTo(c.width / 2 - r / 2, c.height / 2 + r);
  g.closePath();
  g.fill();
  return b64(c, 0.8);
}

export class VideoError extends Error {
  constructor(public code: 'type' | 'read') {
    super(code);
  }
}

export async function readVideo(file: File): Promise<PlanVideo> {
  const mime = typeOf(file);
  if (!mime) throw new VideoError('type');
  const local = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.muted = true;
  v.playsInline = true;
  v.src = local;
  let w = 0;
  let h = 0;
  let duration = 0;
  let thumb = '';
  if (await once(v, 'loadedmetadata', 15_000)) {
    w = v.videoWidth;
    h = v.videoHeight;
    duration = Number.isFinite(v.duration) ? v.duration : 0;
    // a still from about a second in (the very first picture is often black)
    v.currentTime = Math.min(1, duration / 3 || 0);
    if (w && h && (await once(v, 'seeked', 8000))) {
      const c = document.createElement('canvas');
      c.width = 360;
      c.height = Math.round((360 * h) / w);
      const g = c.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(v, 0, 0, c.width, c.height);
      thumb = b64(c, 0.8);
    }
  }
  // a codec this browser lacks (HEVC on some computers): the length and size from the file's own index
  if (!w || !h || !duration) {
    const info = await mp4Info(file.size, read(file)).catch(() => null);
    if (!info) {
      URL.revokeObjectURL(local);
      throw new VideoError('read');
    }
    ({ w, h, duration } = info);
  }
  return { mime, w, h, duration, thumb: thumb || card(w, h), local };
}

/** The file to send: the same bytes, with the index first when it was at the end. */
export async function videoBody(file: File, mime: string): Promise<Blob> {
  const pieces = await faststartPieces(file.size, read(file)).catch(() => null);
  if (!pieces) return file;
  return new Blob(
    pieces.map((p) => (p instanceof Uint8Array ? new Uint8Array(p) : file.slice(p.from, p.to))),
    { type: mime },
  );
}

/** Sends the file in pieces (each one tried 4 times); `progress` gets the share sent (0 to 1). */
export async function sendPieces(body: Blob, chunk: number, put: (part: number, piece: Blob) => Promise<unknown>, progress: (share: number) => void): Promise<void> {
  const parts = Math.ceil(body.size / chunk);
  for (let k = 0; k < parts; k++) {
    const piece = body.slice(k * chunk, Math.min(body.size, (k + 1) * chunk));
    for (let attempt = 0; ; attempt++) {
      try {
        await put(k, piece);
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, [1000, 3000, 6000][attempt]));
      }
    }
    progress((k + 1) / parts);
  }
}
