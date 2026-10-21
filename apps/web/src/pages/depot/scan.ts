// Scanner helpers: short beeps (WebAudio), vibration, barcode reading from the camera or a photo.

let ac: AudioContext | null = null;
/** Must be called from a user gesture once (browsers block sound before). */
export function unlockAudio() {
  try {
    if (!ac) ac = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume().catch(() => {});
  } catch {
    ac = null;
  }
  return ac;
}
function tone(f: number, start: number, d: number, type: OscillatorType, v: number) {
  const a = unlockAudio();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  const t0 = a.currentTime + start;
  o.type = type;
  o.frequency.value = f;
  g.gain.setValueAtTime(1e-4, t0);
  g.gain.exponentialRampToValueAtTime(v, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(1e-4, t0 + d);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + d + 0.02);
}
/** Bon = two bright notes; ! À vérifier = high then low; Stop = three low buzzes. */
export function ring(kind: 'ok' | 'bad' | 'warn' | 'ask') {
  try {
    const vib = (p: number | number[]) => navigator.vibrate?.(p);
    if (kind === 'ok') {
      tone(988, 0, 0.14, 'sine', 0.35);
      tone(1319, 0.13, 0.24, 'sine', 0.35);
      vib(60);
    } else if (kind === 'warn') {
      tone(988, 0, 0.14, 'sine', 0.3);
      tone(740, 0.16, 0.3, 'triangle', 0.3);
      vib([60, 80, 60]);
    } else if (kind === 'ask') {
      tone(880, 0, 0.12, 'sine', 0.25);
    } else {
      tone(196, 0, 0.18, 'square', 0.18);
      tone(196, 0.24, 0.18, 'square', 0.18);
      tone(147, 0.48, 0.42, 'square', 0.2);
      vib([200, 100, 200, 100, 300]);
    }
  } catch {
    /* no sound */
  }
}

export const cleanCode = (v: string) => String(v || '').trim().replace(/\s+/g, '').replace(/[,()"*\\]/g, '');

const hasDetector = () => typeof window !== 'undefined' && 'BarcodeDetector' in window;
const FORMATS = ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'itf', 'qr_code', 'codabar', 'upc_a', 'data_matrix'];
function detector(): any {
  const BD = (window as any).BarcodeDetector;
  try {
    return new BD({ formats: FORMATS });
  } catch {
    return new BD();
  }
}

async function zxingReader() {
  const [{ BrowserMultiFormatReader }, lib] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
  const hints = new Map();
  hints.set(lib.DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints);
}

/** Reads a barcode from a photo (phone fallback). Returns null when none is found. */
export async function decodePhoto(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, ko) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = ko;
      i.src = url;
    });
    const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    if (hasDetector()) {
      try {
        const r = await detector().detect(c);
        if (r?.[0]?.rawValue) return r[0].rawValue;
      } catch {
        /* try ZXing */
      }
    }
    const rd = await zxingReader();
    try {
      return rd.decodeFromCanvas(c).getText();
    } catch {
      /* rotated? */
    }
    const r2 = document.createElement('canvas');
    r2.width = c.height;
    r2.height = c.width;
    const x = r2.getContext('2d')!;
    x.translate(r2.width, 0);
    x.rotate(Math.PI / 2);
    x.drawImage(c, 0, 0);
    try {
      return rd.decodeFromCanvas(r2).getText();
    } catch {
      return null;
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Live camera scanning into a <video>. BarcodeDetector when the browser has it, else ZXing.
 * Calls onCode for each code read; returns a stop function.
 */
export async function startCamera(video: HTMLVideoElement, onCode: (code: string) => void): Promise<() => void> {
  const constraints: MediaStreamConstraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
  if (hasDetector()) {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    await video.play().catch(() => {});
    const det = detector();
    let alive = true;
    let timer = 0;
    const tick = async () => {
      if (!alive) return;
      try {
        if (video.readyState >= 2) {
          const r = await det.detect(video);
          if (r?.[0]?.rawValue) onCode(r[0].rawValue);
        }
      } catch {
        /* keep trying */
      }
      timer = window.setTimeout(tick, 180);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }
  const rd = await zxingReader();
  const controls = await rd.decodeFromConstraints(constraints, video, (res) => {
    if (res) onCode(res.getText());
  });
  return () => controls.stop();
}

export const isPhone = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer:coarse)').matches;
