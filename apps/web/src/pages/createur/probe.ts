// Espace créateur: a small picture, the length and the picture size of each video, read in this browser with a hidden
// <video> (never sent anywhere). Two at a time, so a folder of many 4K clips does not freeze the page; kept in memory
// by name + size + last change (the same file is read once per visit).
import { mp4Info } from '@pilotix/shared';

export interface ClipInfo {
  duration: number;
  w: number;
  h: number;
  /** a small JPEG (data URL); '' when the browser cannot show this video's pictures (its codec) */
  thumb: string;
}

const cache = new Map<string, Promise<ClipInfo | null>>();
const AT_ONCE = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await run();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

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

async function read(file: File): Promise<ClipInfo | null> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.muted = true;
  v.playsInline = true;
  let info: ClipInfo = { duration: 0, w: 0, h: 0, thumb: '' };
  try {
    v.src = url;
    if (await once(v, 'loadedmetadata', 15_000)) {
      info = { duration: Number.isFinite(v.duration) ? v.duration : 0, w: v.videoWidth, h: v.videoHeight, thumb: '' };
      if (info.w && info.h) {
        // ~0.3 s in: the very first picture is often black
        v.currentTime = Math.min(0.3, info.duration / 2 || 0);
        if (await once(v, 'seeked', 8000)) {
          // the picture at that time may not be decoded yet right after the seek
          if (v.readyState < 2) await once(v, 'canplay', 3000);
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          const c = document.createElement('canvas');
          c.width = 180;
          c.height = Math.round((180 * info.h) / info.w);
          const g = c.getContext('2d');
          if (g) {
            g.drawImage(v, 0, 0, c.width, c.height);
            info.thumb = c.toDataURL('image/jpeg', 0.72);
          }
        }
      }
    }
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
  // a codec this browser lacks (HEVC on some computers): the length and size from the file's own index
  if (!info.duration || !info.w) {
    const idx = await mp4Info(file.size, (s, e) => file.slice(s, e).arrayBuffer().then((b) => new Uint8Array(b))).catch(() => null);
    if (!idx) return info.duration ? info : null;
    info = { ...info, duration: info.duration || idx.duration, w: info.w || idx.w, h: info.h || idx.h };
  }
  return info;
}

const done = new Map<string, ClipInfo | null>();

/** The video's length, size and small picture (null: not readable here). */
export function clipInfo(key: string, file: File): Promise<ClipInfo | null> {
  let p = cache.get(key);
  if (!p) {
    p = slot(() => read(file)).catch(() => null);
    p.then((i) => done.set(key, i));
    cache.set(key, p);
  }
  return p;
}

/** Already read: its result without waiting (undefined: not read yet). */
export const clipInfoNow = (key: string): ClipInfo | null | undefined => done.get(key);

/** « 4K », « 1080p », « 720p »… from the short side of the picture. */
export function resolutionTag(w: number, h: number): string {
  const s = Math.min(w, h);
  if (!s) return '';
  if (s >= 2160) return '4K';
  if (s >= 1440) return '1440p';
  if (s >= 1080) return '1080p';
  if (s >= 720) return '720p';
  return `${s}p`;
}
