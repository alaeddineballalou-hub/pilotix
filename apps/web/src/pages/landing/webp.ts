// The photo compressor of the landing page editor, in the browser itself (nothing to install, nothing sent before it is
// small). A picture (a 4 MB phone photo, a supplier's picture, a product photo address) becomes the files the page uses:
// 160 px (thumbnails), 480, 720 (most phones) and 960 px wide, plus a tiny blurred copy shown at once while the photo
// loads. For each width it looks for the LOWEST quality whose result still looks the same as the resized original —
// measured with MS-SSIM (multi-scale structural similarity of brightness, 1 = identical; it follows what the eye sees
// better than plain SSIM, which over-rates fine textures like fur or grass) — so every file is as light as it can be
// without visible loss. A flat graphic (logo, text on plain colour) stays lossless when that is lighter. A cap per width
// keeps even a difficult photo quick on 3G. The colour profile browsers add to each WebP (456 bytes, plain sRGB, what
// every screen assumes anyway) is taken out. Browsers that cannot write WebP (old Safari) give JPEG.

export type Preset = 'max' | 'balanced' | 'light';

/**
 * MS-SSIM to reach per preset (thumbnails are tiny: a little less is invisible there). Calibrated on real photos
 * (fur, faces, a bus, a building), compared by eye at 2× zoom: 0.996 ≈ no difference even zoomed 3×; 0.994 ≈ none at
 * 2× (WebP quality ~0.6–0.8 depending on the photo); 0.990 ≈ none at normal size on a phone.
 */
export const PRESETS: Record<Preset, { ssim: number; thumb: number }> = {
  max: { ssim: 0.996, thumb: 0.992 },
  balanced: { ssim: 0.994, thumb: 0.99 },
  light: { ssim: 0.99, thumb: 0.985 },
};

/** never heavier than this (bytes), whatever the photo: the first photo must stay quick on 3G */
const CAP = { t160: 10_000, w480: 50_000, w720: 100_000, w960: 150_000 };
const WIDTHS = { t160: 160, w480: 480, w720: 720, w960: 960 } as const;
type Size = keyof typeof WIDTHS;

export interface ImageInfo {
  orig: number;
  ow: number;
  oh: number;
  bytes: { t160: number; w480: number; w720?: number; w960: number };
  ssim: { t160: number; w480: number; w720?: number; w960: number };
  preset: Preset;
}

export interface Encoded {
  w: number;
  h: number;
  t160: string;
  w480: string;
  w720?: string;
  w960: string;
  lqip?: string;
  info: ImageInfo;
  /** for the before / after view in this session (object URLs: the original, and the width most phones get) */
  compare: { orig: string; opt: string };
}

type Bitmap = CanvasImageSource & { width: number; height: number };

const toBase64 = (b: Blob) =>
  new Promise<string>((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]+,/, ''));
    r.onerror = () => ko(r.error);
    r.readAsDataURL(b);
  });

const sleep0 = () => new Promise((r) => setTimeout(r, 0));

async function load(file: Blob): Promise<Bitmap> {
  if ('createImageBitmap' in window) {
    try {
      // the photo upright, as the phone took it (EXIF orientation)
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall back to an <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight });
  } catch {
    throw new Error(/heic|heif/i.test(file.type) ? 'Photo HEIC (iPhone) : envoyez-la en JPEG' : 'Image illisible');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const ctx2d = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;

/** a sharp downscale: halves first (no shimmering on big phone photos), then the exact size */
function resize(src: Bitmap, w: number, h: number): HTMLCanvasElement {
  let cur: Bitmap = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const c = canvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
    const g = ctx2d(c);
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
  }
  const out = canvas(w, h);
  const g = ctx2d(out);
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, w, h);
  return out;
}

/** brightness of each pixel, over white where the picture is transparent */
function luma(d: ImageData): Float32Array {
  const n = d.width * d.height;
  const y = new Float32Array(n);
  const p = d.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = p[j + 3] / 255;
    y[i] = (0.299 * p[j] + 0.587 * p[j + 1] + 0.114 * p[j + 2]) * a + 255 * (1 - a);
  }
  return y;
}

/** mean luminance (l) and contrast-structure (cs) terms of SSIM, over 8×8 windows every 4 pixels */
function terms(a: Float32Array, b: Float32Array, w: number, h: number): [number, number] {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const B = Math.min(8, w, h);
  const S = Math.max(1, B >> 1);
  const N = B * B;
  let L = 0;
  let CS = 0;
  let n = 0;
  for (let y = 0; y + B <= h; y += S) {
    for (let x = 0; x + B <= w; x += S) {
      let ma = 0;
      let mb = 0;
      for (let j = 0; j < B; j++) {
        const o = (y + j) * w + x;
        for (let i = 0; i < B; i++) {
          ma += a[o + i];
          mb += b[o + i];
        }
      }
      ma /= N;
      mb /= N;
      let va = 0;
      let vb = 0;
      let cv = 0;
      for (let j = 0; j < B; j++) {
        const o = (y + j) * w + x;
        for (let i = 0; i < B; i++) {
          const da = a[o + i] - ma;
          const db = b[o + i] - mb;
          va += da * da;
          vb += db * db;
          cv += da * db;
        }
      }
      const d = Math.max(1, N - 1);
      L += (2 * ma * mb + C1) / (ma * ma + mb * mb + C1);
      CS += (2 * (cv / d) + C2) / (va / d + vb / d + C2);
      n++;
    }
  }
  return n ? [L / n, CS / n] : [1, 1];
}

/** half size (2×2 average) */
function half(a: Float32Array, w: number, h: number): [Float32Array, number, number] {
  const W = w >> 1;
  const H = h >> 1;
  const o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = 2 * y * w + 2 * x;
    o[y * W + x] = (a[k] + a[k + 1] + a[k + w] + a[k + w + 1]) / 4;
  }
  return [o, W, H];
}

const MS_W = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333];

/**
 * MS-SSIM (Wang, Simoncelli & Bovik 2003): structure compared at 5 scales, each halving the picture (1 = identical;
 * small pictures use the scales they have, weights renormalised).
 */
export function msssim(a: Float32Array, b: Float32Array, w: number, h: number): number {
  let v = 1;
  let wsum = 0;
  const used: number[] = [];
  for (let k = 0, sw = w, sh = h; k < 5; k++, sw >>= 1, sh >>= 1) {
    if (k && (sw < 8 || sh < 8)) break;
    used.push(k);
    wsum += MS_W[k];
  }
  const last = used[used.length - 1];
  for (const k of used) {
    const [l, cs] = terms(a, b, w, h);
    v *= Math.pow(Math.max(1e-6, k === last ? l * cs : cs), MS_W[k] / wsum);
    if (k !== last) {
      const [a2, W, H] = half(a, w, h);
      [b] = half(b, w, h);
      [a, w, h] = [a2, W, H];
    }
  }
  return v;
}

let webpOk: boolean | null = null;
/** can this browser write WebP? (old Safari writes PNG instead: then JPEG) */
async function canWebp(): Promise<boolean> {
  if (webpOk === null) {
    const b = await new Promise<Blob | null>((ok) => canvas(2, 2).toBlob(ok, 'image/webp', 0.8));
    webpOk = !!b && b.type === 'image/webp';
  }
  return webpOk;
}

const encode = (c: HTMLCanvasElement, type: string, q: number) =>
  new Promise<Blob>((ok, ko) => c.toBlob((b) => (b ? ok(b) : ko(new Error('Image illisible'))), type, q)).then(lean);

/**
 * A WebP without the colour profile browsers put in it (ICCP chunk, 456 bytes of plain sRGB): the picture data is
 * kept as is (with its transparency when it has some), so it looks exactly the same — and a thumbnail is ~15% lighter.
 */
async function lean(b: Blob): Promise<Blob> {
  if (b.type !== 'image/webp') return b;
  const u = new Uint8Array(await b.arrayBuffer());
  const tag = (o: number) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  if (u.length < 20 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return b;
  const chunks: { id: string; at: number; n: number }[] = [];
  for (let o = 12; o + 8 <= u.length; ) {
    const n = u[o + 4] | (u[o + 5] << 8) | (u[o + 6] << 16) | (u[o + 7] << 24);
    chunks.push({ id: tag(o), at: o, n });
    o += 8 + n + (n & 1);
  }
  const img = chunks.find((c) => c.id === 'VP8 ' || c.id === 'VP8L');
  const alph = chunks.find((c) => c.id === 'ALPH');
  const vp8x = chunks.find((c) => c.id === 'VP8X');
  if (!img || chunks.some((c) => c.id === 'ANIM') || (alph && !vp8x)) return b;
  const piece = (c: { at: number; n: number }) => u.subarray(c.at, c.at + 8 + c.n + (c.n & 1));
  const parts: Uint8Array[] = [];
  if (alph && vp8x) {
    const x = piece(vp8x).slice();
    x[8] &= ~(0x20 | 0x08 | 0x04); // no ICC profile, EXIF or XMP; alpha kept
    parts.push(x, piece(alph));
  }
  parts.push(piece(img));
  const size = 4 + parts.reduce((t, p) => t + p.length, 0);
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46, size & 255, (size >> 8) & 255, (size >> 16) & 255, (size >>> 24) & 255, 0x57, 0x45, 0x42, 0x50]);
  return new Blob([head, ...parts], { type: 'image/webp' });
}

async function pixels(blob: Blob, w: number, h: number): Promise<Float32Array> {
  const bmp = await createImageBitmap(blob);
  const c = canvas(w, h);
  const g = ctx2d(c);
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return luma(g.getImageData(0, 0, w, h));
}

interface Pick {
  blob: Blob;
  q: number;
  ssim: number;
}

/**
 * The lightest file that still looks like the original: the lowest quality reaching `target` (binary search, quality
 * 0.30–0.96 by steps of 0.02), lossless when lighter (graphics), then at most `cap` bytes.
 */
async function lightest(c: HTMLCanvasElement, ref: Float32Array, type: string, target: number, cap: number, tryLossless: boolean, hint?: number): Promise<Pick> {
  const seen = new Map<number, Pick>();
  const at = async (k: number): Promise<Pick> => {
    const hit = seen.get(k);
    if (hit) return hit;
    await sleep0(); // the page stays responsive between two tries
    const q = k / 100;
    const blob = await encode(c, type, q);
    const p = { blob, q, ssim: msssim(ref, await pixels(blob, c.width, c.height), c.width, c.height) };
    seen.set(k, p);
    return p;
  };
  // qualities 30, 32, … 96: binary search over the steps (around the quality another width of the photo needed)
  const hk = hint !== undefined && hint < 1 ? Math.round((hint * 100 - 30) / 2) : null;
  let lo = hk === null ? 0 : Math.max(0, hk - 8);
  let hi = hk === null ? 33 : Math.min(33, hk + 8);
  let good: Pick | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = await at(30 + mid * 2);
    if (p.ssim >= target) {
      good = p;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  // nothing in the window reached the target: search the whole range
  if (!good && hk !== null && hk + 8 < 33) return lightest(c, ref, type, target, cap, tryLossless);
  let best = good ?? (await at(96));
  if (tryLossless) {
    const blob = await encode(c, type, 1); // WebP at quality 1 = lossless
    if (blob.size <= best.blob.size) best = { blob, q: 1, ssim: 1 };
  }
  if (best.q === 1 && best.blob.size > cap) best = good ?? (await at(96));
  if (best.blob.size > cap) {
    // too heavy even so (a very detailed photo): the best quality that fits the cap
    let l = 0;
    let h = (best.q * 100 - 30) / 2;
    let fit: Pick | null = null;
    while (l <= h) {
      const mid = (l + h) >> 1;
      const p = await at(30 + mid * 2);
      if (p.blob.size <= cap) {
        fit = p;
        l = mid + 1;
      } else h = mid - 1;
    }
    best = fit ?? (await at(30));
  }
  return best;
}

function opaque(c: HTMLCanvasElement): boolean {
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return false;
  return true;
}

function flatten(c: HTMLCanvasElement): HTMLCanvasElement {
  const out = canvas(c.width, c.height);
  const g = ctx2d(out);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(c, 0, 0);
  return out;
}

/**
 * Compresses one picture for a landing page. `step` tells what is being done (for the editor's progress line).
 */
export async function optimize(file: Blob, preset: Preset, step?: (size: Size | 'lqip') => void): Promise<Encoded> {
  const src = await load(file);
  const webp = await canWebp();
  const type = webp ? 'image/webp' : 'image/jpeg';
  const p = PRESETS[preset];
  const dims = (W: number) => {
    const s = Math.min(1, W / src.width);
    return { w: Math.max(1, Math.round(src.width * s)), h: Math.max(1, Math.round(src.height * s)) };
  };
  const big = resize(src, dims(960).w, dims(960).h);
  const alpha = !opaque(big);
  const out: Partial<Record<Size, Pick & { w: number; h: number }>> = {};
  let lossless: boolean | null = null; // decided on the 480 width, kept for the others
  for (const k of ['w480', 't160', 'w960', 'w720'] as Size[]) {
    const { w, h } = dims(WIDTHS[k]);
    // same pixels as a width already made (a small original): the same file
    const same = (Object.values(out) as (Pick & { w: number; h: number })[]).find((x) => x.w === w && x.h === h);
    if (same) {
      if (k !== 'w720') out[k] = same;
      continue;
    }
    step?.(k);
    let c = k === 'w960' ? big : resize(big, w, h);
    if (!webp && alpha) c = flatten(c);
    const ref = luma(ctx2d(c).getImageData(0, 0, w, h));
    const pick = await lightest(c, ref, type, k === 't160' ? p.thumb : p.ssim, CAP[k], webp && lossless !== false, k === 'w960' || k === 'w720' ? out.w480?.q : undefined);
    if (k === 'w480' && webp) lossless = pick.q === 1;
    out[k] = { ...pick, w, h };
  }
  // the tiny blurred copy (opaque pictures only: behind a transparent one it would show through)
  let lqip: string | undefined;
  if (!alpha) {
    step?.('lqip');
    const b = await encode(resize(big, 16, Math.max(4, Math.round((big.height * 16) / big.width))), type, 0.3);
    if (b.size <= 2_500) lqip = await toBase64(b);
  }
  const r = out as Record<Size, Pick & { w: number; h: number }>;
  const has720 = !!out.w720 && out.w720 !== out.w480 && out.w720 !== out.w960;
  const phone = has720 ? r.w720 : r.w960;
  return {
    w: r.w960.w,
    h: r.w960.h,
    t160: await toBase64(r.t160.blob),
    w480: await toBase64(r.w480.blob),
    w720: has720 ? await toBase64(r.w720.blob) : undefined,
    w960: await toBase64(r.w960.blob),
    lqip,
    info: {
      orig: file.size,
      ow: src.width,
      oh: src.height,
      bytes: { t160: r.t160.blob.size, w480: r.w480.blob.size, w720: has720 ? r.w720.blob.size : undefined, w960: r.w960.blob.size },
      ssim: { t160: round(r.t160.ssim), w480: round(r.w480.ssim), w720: has720 ? round(r.w720.ssim) : undefined, w960: round(r.w960.ssim) },
      preset,
    },
    compare: { orig: URL.createObjectURL(file), opt: URL.createObjectURL(phone.blob) },
  };
}

const round = (x: number) => Math.round(x * 10000) / 10000;

/** a picture at an address (a product photo, a supplier's page) fetched to be compressed; fails when the site refuses */
export async function fetchImage(url: string): Promise<Blob> {
  const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!r.ok) throw new Error(String(r.status));
  const b = await r.blob();
  if (!/^image\//.test(b.type) && !/^data:image\//.test(url)) throw new Error('not an image');
  return b;
}

/** the size of a picture at an address (pictures hosted elsewhere) */
export function measure(url: string): Promise<{ w: number; h: number }> {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.onload = () => ok({ w: img.naturalWidth || 960, h: img.naturalHeight || 960 });
    img.onerror = () => ko(new Error('Image introuvable'));
    img.src = url;
  });
}
