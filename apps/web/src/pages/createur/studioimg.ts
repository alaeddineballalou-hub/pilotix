// Studio photo, in the browser: the pictures are prepared here (never on the server). A background is cropped to 4:5,
// blurred once (the table in front stays sharp) and saved; the product's photos are shrunk before they go to the AI;
// the poster is drawn here with Pilotix's own words, prices and phone (the AI never writes a number); the ad sizes
// (1:1 and 9:16) are cut from the 4:5 photo.
export const OUT_W = 1080;
export const OUT_H = 1350;
export type Logo = { x: number; y: number; w: number; h: number };
export type AiPhoto = { mime: 'image/jpeg'; data: string };

const b64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, no) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => no(new Error('not_image'));
    i.src = src;
  });
}

export async function fileImage(file: File): Promise<HTMLImageElement> {
  if (!/^image\//.test(file.type)) throw new Error('not_image');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    await img.decode?.().catch(() => undefined);
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  return [c, g];
}

/** The picture drawn to fill w×h (cropped in the middle, like CSS object-fit: cover). */
function cover(g: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, w: number, h: number, dx = 0, dy = 0) {
  const k = Math.max(w / img.width, h / img.height);
  const sw = w / k;
  const sh = h / k;
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, dx, dy, w, h);
}

/** A soft blur that works everywhere: the canvas filter when the browser has it, else shrink and grow back. */
function blurred(src: HTMLCanvasElement, px: number): HTMLCanvasElement {
  const [c, g] = canvas(src.width, src.height);
  if (px <= 0) {
    g.drawImage(src, 0, 0);
    return c;
  }
  if ('filter' in g) {
    g.filter = `blur(${px}px)`;
    // drawn a little bigger so the edges do not go see-through
    g.drawImage(src, -px * 2, -px * 2, src.width + px * 4, src.height + px * 4);
    g.filter = 'none';
    if (g.getImageData(src.width >> 1, src.height >> 1, 1, 1).data[3] > 0) return c;
  }
  const k = Math.max(0.02, 1 / (px / 1.6));
  const [s, sg] = canvas(Math.max(8, Math.round(src.width * k)), Math.max(8, Math.round(src.height * k)));
  sg.drawImage(src, 0, 0, s.width, s.height);
  g.clearRect(0, 0, c.width, c.height);
  g.drawImage(s, 0, 0, c.width, c.height);
  return c;
}

/**
 * The background as it is kept: 4:5, 1280×1600, blurred, with the front (the table or the floor where the product
 * stands) kept sharp from `focus` (0 top … 1 bottom) down. 0 blur: the photo as it is.
 */
export function makeBackground(img: HTMLImageElement, blur: number, focus: number): { canvas: HTMLCanvasElement; data: string; thumb: string; w: number; h: number } {
  const W = 1280;
  const H = 1600;
  const [sharp, sg] = canvas(W, H);
  cover(sg, img, W, H);
  const soft = blurred(sharp, blur);
  const [out, og] = canvas(W, H);
  og.drawImage(soft, 0, 0);
  if (blur > 0 && focus < 1) {
    const [m, mg] = canvas(W, H);
    mg.drawImage(sharp, 0, 0);
    mg.globalCompositeOperation = 'destination-in';
    const top = Math.max(0, Math.min(1, focus)) * H;
    const grad = mg.createLinearGradient(0, top - H * 0.08, 0, top + H * 0.06);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    mg.fillStyle = grad;
    mg.fillRect(0, 0, W, H);
    og.drawImage(m, 0, 0);
  }
  let data = out.toDataURL('image/jpeg', 0.86);
  for (const q of [0.8, 0.72, 0.62]) {
    if (data.length * 0.75 <= 1_400_000) break;
    data = out.toDataURL('image/jpeg', q);
  }
  return { canvas: out, data: b64(data), thumb: small(out, 320, 'image/jpeg'), w: W, h: H };
}

/** A small copy (a data URL): `max` px on the long side. */
export function small(src: HTMLCanvasElement | HTMLImageElement, max: number, type: 'image/jpeg' | 'image/webp' = 'image/jpeg', q = 0.78): string {
  const k = Math.min(1, max / Math.max(src.width, src.height));
  const [c, g] = canvas(Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k)));
  g.drawImage(src, 0, 0, c.width, c.height);
  const u = c.toDataURL(type, q);
  return type === 'image/webp' && !u.startsWith('data:image/webp') ? c.toDataURL('image/jpeg', q) : u;
}

/** A product photo as the AI gets it: 1024 px JPEG, light enough for five in one call. */
export async function aiPhoto(file: File): Promise<{ photo: AiPhoto; preview: string }> {
  const img = await fileImage(file);
  const k = Math.min(1, 1024 / Math.max(img.width, img.height));
  const [c, g] = canvas(Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  let u = c.toDataURL('image/jpeg', 0.85);
  if (u.length * 0.75 > 600_000) u = c.toDataURL('image/jpeg', 0.7);
  return { photo: { mime: 'image/jpeg', data: b64(u) }, preview: small(c, 240) };
}

/** What is saved for a picked photo: the HD JPEG (2048 px at most), its 320 px and 160 px copies, and the small picture. */
export async function savable(src: string): Promise<{ data: string; w: number; h: number; thumb: string; mini: string; small: string }> {
  const img = await loadImage(src);
  const k = Math.min(1, 2048 / Math.max(img.width, img.height));
  const [c, g] = canvas(Math.round(img.width * k), Math.round(img.height * k));
  g.drawImage(img, 0, 0, c.width, c.height);
  let u = c.toDataURL('image/jpeg', 0.88);
  for (const q of [0.8, 0.72]) if (u.length * 0.75 > 2_500_000) u = c.toDataURL('image/jpeg', q);
  return { data: b64(u), w: c.width, h: c.height, thumb: small(c, 320, 'image/jpeg'), mini: small(c, 160, 'image/jpeg', 0.72), small: small(c, 320, 'image/webp', 0.75) };
}

/** The ad sizes from the 4:5 photo: 1:1 (cut in the middle) and 9:16 (the photo on a blurred copy of itself). */
export async function adSize(src: string, kind: 'square' | 'story'): Promise<string> {
  const img = await loadImage(src);
  if (kind === 'square') {
    const [c, g] = canvas(1080, 1080);
    cover(g, img, 1080, 1080);
    return c.toDataURL('image/jpeg', 0.9);
  }
  const [c, g] = canvas(1080, 1920);
  const [full, fg] = canvas(1080, 1920);
  cover(fg, img, 1080, 1920);
  g.drawImage(blurred(full, 28), 0, 0);
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(0, 0, 1080, 1920);
  const h = Math.round((1080 * img.height) / img.width);
  g.drawImage(img, 0, Math.round((1920 - h) / 2), 1080, h);
  return c.toDataURL('image/jpeg', 0.9);
}

/**
 * The browser preview (no AI there): an EXAMPLE drawn from the background and the first product photo, so the steps
 * can be tried. Clearly marked: it is not what the AI makes.
 */
export async function exampleShot(bgB64: string, photo: AiPhoto, logo: Logo | null, variant: number, label: string): Promise<string> {
  const bg = await loadImage(`data:image/jpeg;base64,${bgB64}`);
  const p = await loadImage(`data:image/jpeg;base64,${photo.data}`);
  const [c, g] = canvas(OUT_W, OUT_H);
  cover(g, bg, OUT_W, OUT_H);
  const top = logo ? (logo.y + logo.h) * OUT_H + 40 : OUT_H * 0.38;
  const maxH = Math.max(200, OUT_H * 0.86 - top);
  const scale = [0.5, 0.46, 0.54][variant % 3];
  let w = OUT_W * scale;
  let h = (w * p.height) / p.width;
  if (h > maxH) {
    h = maxH;
    w = (h * p.width) / p.height;
  }
  const x = (OUT_W - w) / 2;
  const y = OUT_H * 0.86 - h;
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.beginPath();
  g.ellipse(OUT_W / 2, OUT_H * 0.86, w * 0.46, 18, 0, 0, Math.PI * 2);
  g.fill();
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.25)';
  g.shadowBlur = 24;
  g.drawImage(p, x, y, w, h);
  g.restore();
  g.fillStyle = 'rgba(17,24,39,0.78)';
  g.fillRect(0, 0, OUT_W, 64);
  g.fillStyle = '#fff';
  g.font = '700 30px "Readex Pro", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, OUT_W / 2, 33);
  return c.toDataURL('image/jpeg', 0.9);
}

// ---------------------------------------------------------------- the poster
export interface Poster {
  shop: string;
  title: string;
  subtitle: string;
  features: string[];
  price: number | null;
  oldPrice: number | null;
  currency: string;
  cta: string;
  phone: string;
  delivery: string;
  cod: string;
  colorsLabel: string;
  colors: { name: string; src: string }[];
  rtl: boolean;
  /** the poster's main colour (the shop's) */
  accent: string;
}

const FONT = '"Readex Pro", system-ui, sans-serif';
const money = (n: number) => String(Math.round(n));

function pill(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

/** Text that fits: the size goes down until the line fits `max` px. */
function fit(g: CanvasRenderingContext2D, text: string, weight: number, size: number, max: number, min = 18): number {
  let s = size;
  for (; s > min; s -= 2) {
    g.font = `${weight} ${s}px ${FONT}`;
    if (g.measureText(text).width <= max) break;
  }
  g.font = `${weight} ${s}px ${FONT}`;
  return s;
}

/** The poster, 1080×1350, drawn on the hero photo; every price and number is Pilotix's, written here. */
export async function drawPoster(heroSrc: string, p: Poster): Promise<string> {
  await document.fonts?.load(`800 60px ${FONT}`).catch(() => undefined);
  await document.fonts?.load(`600 30px ${FONT}`).catch(() => undefined);
  const hero = await loadImage(heroSrc);
  const colors = await Promise.all(p.colors.slice(0, 3).map(async (c) => ({ ...c, img: await loadImage(c.src).catch(() => null) })));
  const W = OUT_W;
  const H = OUT_H;
  const [c, g] = canvas(W, H);
  g.direction = p.rtl ? 'rtl' : 'ltr';
  cover(g, hero, W, H);
  // a soft light at the top and the bottom so the words read on any photo
  let grad = g.createLinearGradient(0, 0, 0, H * 0.3);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H * 0.3);
  grad = g.createLinearGradient(0, H * 0.62, 0, H);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(255,255,255,0.9)');
  g.fillStyle = grad;
  g.fillRect(0, H * 0.62, W, H * 0.38);
  g.textBaseline = 'middle';
  g.textAlign = 'center';

  // the shop's name, the title, the line under it
  let y = 58;
  if (p.shop) {
    fit(g, p.shop, 700, 34, 420);
    const w = g.measureText(p.shop).width + 56;
    g.fillStyle = '#fff';
    pill(g, (W - w) / 2, y - 30, w, 60, 30);
    g.fill();
    g.fillStyle = '#1f2a44';
    g.fillText(p.shop, W / 2, y + 1);
    y += 74;
  }
  if (p.title) {
    fit(g, p.title, 800, 76, W - 120, 36);
    g.lineWidth = 12;
    g.strokeStyle = '#fff';
    g.lineJoin = 'round';
    g.strokeText(p.title, W / 2, y + 20);
    g.fillStyle = p.accent;
    g.fillText(p.title, W / 2, y + 20);
    y += 96;
  }
  if (p.subtitle) {
    fit(g, p.subtitle, 700, 36, 560);
    const w = g.measureText(p.subtitle).width + 60;
    g.fillStyle = p.accent;
    pill(g, (W - w) / 2, y - 30, w, 60, 30);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(p.subtitle, W / 2, y + 1);
  }

  // the benefits: a column on the side (the right in Arabic, the left in French)
  const feats = p.features.filter(Boolean).slice(0, 4);
  const fw = 250;
  const fx = p.rtl ? W - fw - 28 : 28;
  feats.forEach((f, k) => {
    const fy = 400 + k * 104;
    g.fillStyle = 'rgba(255,255,255,0.94)';
    pill(g, fx, fy, fw, 86, 22);
    g.fill();
    g.strokeStyle = p.accent;
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = p.accent;
    const cx = p.rtl ? fx + fw - 44 : fx + 44;
    g.beginPath();
    g.arc(cx, fy + 43, 26, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = `800 30px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('✓', cx, fy + 44);
    g.fillStyle = '#1f2a44';
    fit(g, f, 700, 28, fw - 100, 16);
    g.textAlign = p.rtl ? 'right' : 'left';
    g.fillText(f, p.rtl ? fx + fw - 82 : fx + 82, fy + 44);
    g.textAlign = 'center';
  });

  // the colours (round pictures with their names) on one side of the bottom, the price on the other
  const by = H - 330;
  if (colors.length > 1) {
    const cw = 150;
    const area = colors.length * cw + (colors.length - 1) * 18;
    const ax = p.rtl ? 40 : W - 40 - area;
    g.fillStyle = p.accent;
    fit(g, p.colorsLabel, 700, 28, area);
    const lw = g.measureText(p.colorsLabel).width + 44;
    pill(g, ax + (area - lw) / 2, by - 26, lw, 50, 25);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(p.colorsLabel, ax + area / 2, by);
    colors.forEach((col, k) => {
      const cx = ax + k * (cw + 18) + cw / 2;
      const cy = by + 110;
      g.save();
      g.beginPath();
      g.arc(cx, cy, 68, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.clip();
      if (col.img) {
        const k2 = Math.max(136 / col.img.width, 136 / col.img.height);
        g.drawImage(col.img, cx - (col.img.width * k2) / 2, cy - (col.img.height * k2) / 2, col.img.width * k2, col.img.height * k2);
      }
      g.restore();
      g.lineWidth = 5;
      g.strokeStyle = '#fff';
      g.beginPath();
      g.arc(cx, cy, 68, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = p.accent;
      fit(g, col.name, 700, 24, cw);
      const nw = Math.min(cw + 10, g.measureText(col.name).width + 30);
      pill(g, cx - nw / 2, cy + 74, nw, 40, 20);
      g.fill();
      g.fillStyle = '#fff';
      g.fillText(col.name, cx, cy + 95);
    });
  }
  if (p.price != null) {
    const px = p.rtl ? W - 40 - 380 : 40;
    const pw = 380;
    let py = by - 20;
    if (p.oldPrice && p.oldPrice > p.price) {
      const old = `${money(p.oldPrice)} ${p.currency}`;
      fit(g, old, 700, 38, pw - 80);
      const ow = g.measureText(old).width + 50;
      g.fillStyle = '#fff';
      pill(g, px + (pw - ow) / 2, py - 28, ow, 56, 28);
      g.fill();
      g.fillStyle = '#6b7280';
      g.fillText(old, px + pw / 2, py);
      g.strokeStyle = '#e11d48';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(px + (pw - ow) / 2 + 16, py + 4);
      g.lineTo(px + (pw + ow) / 2 - 16, py - 6);
      g.stroke();
      py += 52;
    }
    g.fillStyle = p.accent;
    pill(g, px, py, pw, 118, 30);
    g.fill();
    const now = `${money(p.price)} ${p.currency}`;
    fit(g, now, 800, 68, pw - 40, 30);
    g.fillStyle = '#ffe14d';
    g.fillText(now, px + pw / 2, py + 62);
    py += 132;
    g.fillStyle = '#fff';
    pill(g, px + 20, py, pw - 40, 76, 38);
    g.fill();
    g.strokeStyle = p.accent;
    g.lineWidth = 4;
    g.stroke();
    fit(g, `🛒 ${p.cta}`, 800, 38, pw - 80);
    g.fillStyle = p.accent;
    g.fillText(`🛒 ${p.cta}`, px + pw / 2, py + 40);
  }

  // the band at the bottom: the phone, the delivery, the payment
  g.fillStyle = '#1f2a44';
  g.fillRect(0, H - 104, W, 104);
  const cells = [p.phone ? `📞 ${p.phone}` : '', p.delivery ? `🚚 ${p.delivery}` : '', p.cod ? `💵 ${p.cod}` : ''].filter(Boolean);
  const cw = W / Math.max(1, cells.length);
  cells.forEach((txt, k) => {
    const cx = p.rtl ? W - cw * k - cw / 2 : cw * k + cw / 2;
    g.fillStyle = '#fff';
    fit(g, txt, k === 0 && p.phone ? 800 : 600, k === 0 && p.phone ? 38 : 28, cw - 30, 16);
    g.fillText(txt, cx, H - 52);
    if (k > 0) {
      g.fillStyle = 'rgba(255,255,255,0.25)';
      const lx = p.rtl ? W - cw * k : cw * k;
      g.fillRect(lx - 1, H - 84, 2, 64);
    }
  });
  return c.toDataURL('image/jpeg', 0.92);
}

export function download(dataUrl: string, name: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
