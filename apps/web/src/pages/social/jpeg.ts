// Pilot Content: a picked photo becomes what Meta takes, in the browser itself, always at the highest quality:
// - JPEG (Instagram takes no other format), as big as Instagram keeps (1440 px wide, so up to 1800 px tall); a smaller
//   photo is never blown up (it would only get blurry);
// - between 4:5 (tall) and 1.91:1 (wide), cut in the middle when it is outside;
// - the highest JPEG quality that fits in one upload (100 %, else 97 %, 95 %…); a big photo is made smaller in steps
//   of half (sharper than in one jump), on a white background (JPEG has no transparency), in sRGB;
// - plus a 360 px copy for the calendar.
// Pilotix keeps that file as it is and sends exactly it to Facebook and Instagram when the post goes out.

export interface PlanPhoto {
  jpeg: string;
  thumb: string;
  w: number;
  h: number;
  /** cut to fit Instagram's shapes */
  cropped: boolean;
  /** the JPEG quality used (1 = 100 %) */
  quality: number;
}

const TALL = 0.8; // 4:5
const WIDE = 1.91; // 1.91:1
const MAX_W = 1440;
const MIN_W = 320;
/** Instagram shows a photo sharp from this width */
export const SHARP_W = 1080;
/** what one upload carries (base64, under the server's 5 MB per request) */
const MAX_B64 = 4_800_000;
const QUALITIES = [1, 0.97, 0.95, 0.92, 0.9, 0.85, 0.8];

type Bitmap = CanvasImageSource & { width: number; height: number };

async function load(file: Blob): Promise<Bitmap> {
  if ('createImageBitmap' in window) {
    try {
      // upright, as the phone took it (EXIF orientation)
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
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  return [c, g];
}

/** The part (sx, sy, sw, sh) of the photo at w × h: halved step by step while it is more than twice too big. */
function draw(src: Bitmap, sx: number, sy: number, sw: number, sh: number, w: number, h: number): HTMLCanvasElement {
  let cur: CanvasImageSource = src;
  let [cx, cy, cw, ch] = [sx, sy, sw, sh];
  while (cw > w * 2) {
    const [c, g] = canvas(Math.round(cw / 2), Math.round(ch / 2));
    g.drawImage(cur, cx, cy, cw, ch, 0, 0, c.width, c.height);
    [cur, cx, cy, cw, ch] = [c, 0, 0, c.width, c.height];
  }
  const [c, g] = canvas(w, h);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.drawImage(cur, cx, cy, cw, ch, 0, 0, w, h);
  return c;
}

const b64 = (c: HTMLCanvasElement, q: number) => c.toDataURL('image/jpeg', q).replace(/^data:[^,]+,/, '');

/** `story`: a story's photo, up to 9:16 (1080 × 1920) instead of a feed post's 4:5. */
export async function toPlanPhoto(file: Blob, opts: { story?: boolean } = {}): Promise<PlanPhoto> {
  const bmp = await load(file);
  const tallest = opts.story ? 9 / 16 : TALL;
  const widest = opts.story ? 1080 : MAX_W;
  let sx = 0;
  let sy = 0;
  let sw = bmp.width;
  let sh = bmp.height;
  if (!sw || !sh) throw new Error('empty');
  const ratio = sw / sh;
  let cropped = false;
  if (ratio < tallest) {
    const nh = Math.round(sw / tallest);
    sy = Math.round((sh - nh) / 2);
    sh = nh;
    cropped = true;
  } else if (ratio > WIDE) {
    const nw = Math.round(sh * WIDE);
    sx = Math.round((sw - nw) / 2);
    sw = nw;
    cropped = true;
  }
  const w = Math.max(MIN_W, Math.min(widest, sw));
  const h = Math.round((w * sh) / sw);
  const big = draw(bmp, sx, sy, sw, sh, w, h);
  // the highest quality that fits in one upload
  let jpeg = '';
  let quality = 0;
  for (const q of QUALITIES) {
    jpeg = b64(big, q);
    quality = q;
    if (jpeg.length <= MAX_B64) break;
  }
  if (jpeg.length > MAX_B64) throw new Error('too big');
  const tw = 360;
  const thumb = b64(draw(bmp, sx, sy, sw, sh, tw, Math.round((tw * sh) / sw)), 0.8);
  if ('close' in bmp && typeof (bmp as ImageBitmap).close === 'function') (bmp as ImageBitmap).close();
  return { jpeg, thumb, w, h, cropped, quality };
}
