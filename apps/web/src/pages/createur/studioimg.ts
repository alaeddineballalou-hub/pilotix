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
export function makeBackground(img: CanvasImageSource & { width: number; height: number }, blur: number, focus: number): { canvas: HTMLCanvasElement; data: string; thumb: string; w: number; h: number } {
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

  // the colours (round pictures with their names) on one side of the bottom, the price on the other; everything ends
  // above the band (H - 104)
  const floor = H - 104 - 18;
  if (colors.length > 1) {
    const cw = colors.length > 2 ? 128 : 140;
    const r = cw / 2 - 6;
    const area = colors.length * cw + (colors.length - 1) * 14;
    const ax = p.rtl ? 36 : W - 36 - area;
    const nameY = floor - 20;
    const cy = nameY - 30 - r;
    const ly = cy - r - 34;
    g.fillStyle = p.accent;
    fit(g, p.colorsLabel, 700, 26, area - 40);
    const lw = Math.min(area, g.measureText(p.colorsLabel).width + 40);
    pill(g, ax + (area - lw) / 2, ly - 23, lw, 46, 23);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(p.colorsLabel, ax + area / 2, ly);
    colors.forEach((col, k) => {
      const cx = ax + k * (cw + 14) + cw / 2;
      g.save();
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.clip();
      if (col.img) {
        // the product, not the room: a square around the middle of the photo, where the AI put it
        const side = Math.min(col.img.width, col.img.height) * 0.62;
        const sx = (col.img.width - side) / 2;
        const sy = Math.min(col.img.height - side, col.img.height * 0.6 - side / 2);
        g.drawImage(col.img, sx, Math.max(0, sy), side, side, cx - r, cy - r, r * 2, r * 2);
      }
      g.restore();
      g.lineWidth = 5;
      g.strokeStyle = '#fff';
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = p.accent;
      fit(g, col.name, 700, 22, cw - 16);
      const nw = Math.min(cw, g.measureText(col.name).width + 28);
      pill(g, cx - nw / 2, nameY - 19, nw, 38, 19);
      g.fill();
      g.fillStyle = '#fff';
      g.fillText(col.name, cx, nameY);
    });
  }
  if (p.price != null) {
    const pw = 360;
    const px = p.rtl ? W - 36 - pw : 36;
    const ctaH = 68;
    const priceH = 108;
    const hasOld = !!(p.oldPrice && p.oldPrice > p.price);
    let py = floor - ctaH - 12 - priceH - (hasOld ? 60 : 0);
    if (hasOld) {
      const old = p.rtl ? `${p.currency} ${money(p.oldPrice!)}` : `${money(p.oldPrice!)} ${p.currency}`;
      fit(g, old, 700, 34, pw - 80);
      const ow = g.measureText(old).width + 50;
      g.fillStyle = '#fff';
      pill(g, px + (pw - ow) / 2, py, ow, 50, 25);
      g.fill();
      g.fillStyle = '#6b7280';
      g.fillText(old, px + pw / 2, py + 26);
      g.strokeStyle = '#e11d48';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(px + (pw - ow) / 2 + 16, py + 32);
      g.lineTo(px + (pw + ow) / 2 - 16, py + 20);
      g.stroke();
      py += 60;
    }
    g.fillStyle = p.accent;
    pill(g, px, py, pw, priceH, 28);
    g.fill();
    const now = p.rtl ? `${p.currency} ${money(p.price)}` : `${money(p.price)} ${p.currency}`;
    fit(g, now, 800, 66, pw - 40, 30);
    g.fillStyle = '#ffe14d';
    g.fillText(now, px + pw / 2, py + priceH / 2 + 2);
    py += priceH + 12;
    g.fillStyle = '#fff';
    pill(g, px + 24, py, pw - 48, ctaH, ctaH / 2);
    g.fill();
    g.strokeStyle = p.accent;
    g.lineWidth = 4;
    g.stroke();
    fit(g, `🛒 ${p.cta}`, 800, 34, pw - 96);
    g.fillStyle = p.accent;
    g.fillText(`🛒 ${p.cta}`, px + pw / 2, py + ctaH / 2 + 1);
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
    // the phone number always reads left to right, even on an Arabic poster (else « 0550 11 22 33 » comes out reversed)
    g.direction = k === 0 && p.phone ? 'ltr' : p.rtl ? 'rtl' : 'ltr';
    g.fillText(txt, cx, H - 52);
    g.direction = p.rtl ? 'rtl' : 'ltr';
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

// ---------------------------------------------------------------- the long landing-page image
export interface Landing {
  hero: string | null;
  title: string;
  subtitle: string;
  benefits: { title: string; text: string }[];
  details: string[];
  colors: { name: string; src: string }[];
  colorsLabel: string;
  size: string;
  sizeLabel: string;
  trust: string[];
  rtl: boolean;
  accent: string;
}

/** Splits a sentence into lines that fit `max` px with the current font. */
function lines(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width <= max || !cur) cur = next;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * One very long image (1080 px wide) for under the landing page's order form, block after block: the photo and the
 * title, the benefits, the close-ups, the colours, the size, the trust. No price in it (the form above has it, and a
 * price in a picture goes out of date).
 */
export async function drawLanding(p: Landing): Promise<string> {
  await document.fonts?.load(`800 60px ${FONT}`).catch(() => undefined);
  await document.fonts?.load(`500 30px ${FONT}`).catch(() => undefined);
  const W = OUT_W;
  const pad = 70;
  const hero = p.hero ? await loadImage(p.hero).catch(() => null) : null;
  const details = (await Promise.all(p.details.slice(0, 4).map((s) => loadImage(s).catch(() => null)))).filter(Boolean) as HTMLImageElement[];
  const colors = (await Promise.all(p.colors.slice(0, 6).map(async (c) => ({ ...c, img: await loadImage(c.src).catch(() => null) })))).filter((c) => c.img);
  const [m, mg] = canvas(10, 10);
  const benefitRows = p.benefits.filter((b) => b.title).map((b) => {
    mg.font = `500 32px ${FONT}`;
    return { ...b, lines: lines(mg, b.text, W - pad * 2 - 150) };
  });
  void m;
  const heroH = hero ? Math.round((W * hero.height) / hero.width) : 0;
  const titleH = p.title ? 330 : 0;
  const benH = benefitRows.length ? 120 + benefitRows.reduce((s, b) => s + 110 + b.lines.length * 46, 0) : 0;
  const detCell = details.length === 1 ? W - pad * 2 : (W - pad * 2 - 24) / 2;
  const detH = details.length ? 130 + (details.length === 1 ? detCell + 24 : Math.ceil(details.length / 2) * (detCell + 24)) : 0;
  const colH = colors.length ? 120 + Math.ceil(colors.length / 3) * 330 : 0;
  const sizeH = p.size.trim() ? 260 : 0;
  const trustH = p.trust.length ? 300 : 0;
  const H = Math.max(400, heroH + titleH + benH + detH + colH + sizeH + trustH + 40);
  const [c, g] = canvas(W, H);
  g.direction = p.rtl ? 'rtl' : 'ltr';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.textBaseline = 'middle';
  const side = (x: number) => (p.rtl ? W - x : x);
  let y = 0;
  const heading = (text: string) => {
    g.textAlign = 'center';
    fit(g, text, 800, 50, W - pad * 2, 28);
    g.fillStyle = p.accent;
    g.fillText(text, W / 2, y + 62);
    g.fillRect(W / 2 - 50, y + 100, 100, 6);
    y += 130;
  };

  if (hero) {
    g.drawImage(hero, 0, 0, W, heroH);
    y = heroH;
  }
  if (p.title) {
    g.fillStyle = p.accent;
    g.fillRect(0, y, W, titleH);
    g.textAlign = 'center';
    g.fillStyle = '#fff';
    fit(g, p.title, 800, 72, W - pad * 2, 34);
    g.fillText(p.title, W / 2, y + 130);
    if (p.subtitle) {
      fit(g, p.subtitle, 500, 38, W - pad * 2, 22);
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.fillText(p.subtitle, W / 2, y + 220);
    }
    y += titleH;
  }
  if (benefitRows.length) {
    y += 10;
    benefitRows.forEach((b, k) => {
      const top = y + (k === 0 ? 30 : 0);
      const h = 80 + b.lines.length * 46;
      g.fillStyle = k % 2 ? '#fff' : '#fdf2f7';
      pill(g, pad - 20, top, W - (pad - 20) * 2, h, 28);
      g.fill();
      const cx = side(pad + 50);
      g.fillStyle = p.accent;
      g.beginPath();
      g.arc(cx, top + h / 2, 44, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.font = `800 40px ${FONT}`;
      g.fillText('✓', cx, top + h / 2 + 2);
      g.textAlign = p.rtl ? 'right' : 'left';
      g.fillStyle = '#1f2a44';
      fit(g, b.title, 800, 40, W - pad * 2 - 150, 24);
      g.fillText(b.title, side(pad + 130), top + 46);
      g.fillStyle = '#4b5563';
      g.font = `500 32px ${FONT}`;
      b.lines.forEach((l, i) => g.fillText(l, side(pad + 130), top + 96 + i * 46));
      y = top + h + 30;
    });
    y += 20;
  }
  if (details.length) {
    heading(p.rtl ? 'التفاصيل' : 'Les détails');
    const one = details.length === 1;
    const cell = one ? W - pad * 2 : (W - pad * 2 - 24) / 2;
    details.forEach((img, k) => {
      const x = one ? pad : pad + (k % 2) * (cell + 24);
      const yy = y + (one ? 0 : Math.floor(k / 2) * (cell + 24));
      g.save();
      pill(g, x, yy, cell, cell, 26);
      g.clip();
      cover(g, img, cell, cell, x, yy);
      g.restore();
    });
    y += one ? cell + 24 : Math.ceil(details.length / 2) * (cell + 24);
    y = Math.max(y, 0);
  }
  if (colors.length) {
    heading(p.colorsLabel);
    const cw = (W - pad * 2) / 3;
    colors.forEach((col, k) => {
      const row = Math.floor(k / 3);
      const inRow = Math.min(3, colors.length - row * 3);
      const x0 = (W - inRow * cw) / 2;
      const cx = x0 + (p.rtl ? inRow - 1 - (k % 3) : k % 3) * cw + cw / 2;
      const cy = y + row * 330 + 120;
      g.save();
      g.beginPath();
      g.arc(cx, cy, 110, 0, Math.PI * 2);
      g.clip();
      const img = col.img!;
      const s = Math.min(img.width, img.height) * 0.7;
      g.drawImage(img, (img.width - s) / 2, Math.max(0, img.height * 0.58 - s / 2), s, Math.min(s, img.height), cx - 110, cy - 110, 220, 220);
      g.restore();
      g.strokeStyle = p.accent;
      g.lineWidth = 6;
      g.beginPath();
      g.arc(cx, cy, 110, 0, Math.PI * 2);
      g.stroke();
      g.textAlign = 'center';
      g.fillStyle = '#1f2a44';
      fit(g, col.name, 700, 34, cw - 20, 20);
      g.fillText(col.name, cx, cy + 150);
    });
    y += Math.ceil(colors.length / 3) * 330 + 10;
  }
  if (p.size.trim()) {
    g.fillStyle = '#f1f5ff';
    pill(g, pad - 20, y + 20, W - (pad - 20) * 2, 210, 30);
    g.fill();
    g.textAlign = 'center';
    g.fillStyle = p.accent;
    fit(g, `📏 ${p.sizeLabel}`, 800, 40, W - pad * 2);
    g.fillText(`📏 ${p.sizeLabel}`, W / 2, y + 80);
    g.fillStyle = '#1f2a44';
    fit(g, p.size.trim(), 700, 44, W - pad * 2 - 40, 22);
    g.fillText(p.size.trim(), W / 2, y + 160);
    y += sizeH;
  }
  const end = p.trust.length ? y + trustH : y + 40;
  if (p.trust.length) {
    g.fillStyle = '#1f2a44';
    g.fillRect(0, y + 20, W, trustH - 20);
    const tw = W / p.trust.length;
    p.trust.forEach((t, k) => {
      const cx = p.rtl ? W - tw * k - tw / 2 : tw * k + tw / 2;
      g.textAlign = 'center';
      g.fillStyle = '#fff';
      const [icon, ...rest] = t.split(' ');
      g.font = `400 64px ${FONT}`;
      g.fillText(icon, cx, y + 110);
      const words = rest.join(' ');
      g.font = `700 30px ${FONT}`;
      lines(g, words, tw - 40)
        .slice(0, 2)
        .forEach((l, i) => g.fillText(l, cx, y + 190 + i * 40));
    });
  }
  // the height was counted generously: the image ends where the last block ends
  if (end < H - 4) {
    const [t, tg] = canvas(W, Math.max(200, Math.round(end)));
    tg.drawImage(c, 0, 0);
    return t.toDataURL('image/jpeg', 0.88);
  }
  return c.toDataURL('image/jpeg', 0.88);
}

/** The long image cut into pieces of at most 1350 px high (they load one after another on a slow phone). */
export async function slices(src: string, max = OUT_H): Promise<string[]> {
  const img = await loadImage(src);
  const out: string[] = [];
  for (let y = 0; y < img.height; y += max) {
    const h = Math.min(max, img.height - y);
    const [c, g] = canvas(img.width, h);
    g.drawImage(img, 0, y, img.width, h, 0, 0, img.width, h);
    out.push(c.toDataURL('image/jpeg', 0.88));
  }
  return out;
}

/** The browser preview's EXAMPLE background (no AI there): a plain room with a wooden table in front. */
export function exampleBackground(label: string): HTMLCanvasElement {
  const [c, g] = canvas(1280, 1600);
  g.fillStyle = '#f6efe6';
  g.fillRect(0, 0, 1280, 1600);
  g.fillStyle = '#efe2d2';
  for (let k = 0; k < 6; k++) g.fillRect(80 + k * 200, 260, 140, 520);
  g.fillStyle = '#e9d9c4';
  g.fillRect(0, 900, 1280, 160);
  g.fillStyle = '#c99a6b';
  g.fillRect(0, 1060, 1280, 540);
  g.fillStyle = '#b6855a';
  g.fillRect(0, 1060, 1280, 26);
  g.fillStyle = 'rgba(17,24,39,0.78)';
  g.fillRect(0, 0, 1280, 80);
  g.fillStyle = '#fff';
  g.font = `700 38px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 640, 42);
  return c;
}

/** A canvas from a data URL (to send an AI background to the background editor). */
export async function imageFrom(src: string): Promise<HTMLImageElement> {
  const img = await loadImage(src);
  await img.decode?.().catch(() => undefined);
  return img;
}
