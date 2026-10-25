// A picture picked in the editor becomes three small WebP files (160, 480 and 960 px wide) in the browser itself, so a
// 4 MB phone photo reaches the customer's 3G phone as ~40 KB. Browsers that cannot write WebP (old Safari) give JPEG.

export interface Encoded {
  w: number;
  h: number;
  t160: string;
  w480: string;
  w960: string;
}

const toBase64 = (b: Blob) =>
  new Promise<string>((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]+,/, ''));
    r.onerror = () => ko(r.error);
    r.readAsDataURL(b);
  });

async function load(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file);
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
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function encode(src: CanvasImageSource & { width: number; height: number }, width: number, quality: number): Promise<{ b64: string; w: number; h: number }> {
  const scale = Math.min(1, width / src.width);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/webp', quality));
  const out = blob && blob.type === 'image/webp' ? blob : await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', quality));
  if (!out) throw new Error('Image illisible');
  return { b64: await toBase64(out), w, h };
}

export async function toWebp(file: File): Promise<Encoded> {
  const src = await load(file);
  const [a, b, c] = [await encode(src, 160, 0.7), await encode(src, 480, 0.75), await encode(src, 960, 0.75)];
  return { w: c.w, h: c.h, t160: a.b64, w480: b.b64, w960: c.b64 };
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
