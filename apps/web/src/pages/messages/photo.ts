// A photo picked in a test chat, made ready for Dellal like a customer's: a JPEG of at most 1280 px (what Pilot AI reads)
// and a small copy of 320 px (what the chat shows). Done in the browser: the server never gets the original file.
export interface ChatPhoto {
  /** base64 of the JPEG, no data: prefix */
  data: string;
  mime: 'image/jpeg';
  /** data URL of the small copy */
  thumb: string;
}

const draw = (img: ImageBitmap, max: number, q: number): string => {
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  const g = c.getContext('2d')!;
  // a transparent PNG on white, as WhatsApp shows it
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
};

export async function chatPhoto(file: File): Promise<ChatPhoto> {
  if (!/^image\//.test(file.type)) throw new Error('not_image');
  const img = await createImageBitmap(file);
  try {
    const big = draw(img, 1280, 0.85);
    return { data: big.slice(big.indexOf(',') + 1), mime: 'image/jpeg', thumb: draw(img, 320, 0.72) };
  } finally {
    img.close?.();
  }
}

/** the small pictures the server takes with a product photo (hdphotos.ts: HD.smallMax) */
const SMALL_MAX = 60_000;

/**
 * The light 320 px copy kept with the product for the lists, the orders and the depot: a WebP, or a JPEG on white where
 * the browser makes no WebP (a transparent picture would turn black).
 */
const small = (img: ImageBitmap): string => {
  const k = Math.min(1, 320 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  const webp = c.toDataURL('image/webp', 0.75);
  return webp.startsWith('data:image/webp') ? webp : draw(img, 320, 0.75);
};

/** Only that small copy: a server without photo storage keeps nothing else of a product photo. */
export async function smallPhoto(file: File): Promise<string> {
  if (!/^image\//.test(file.type)) throw new Error('not_image');
  const img = await createImageBitmap(file);
  try {
    return small(img);
  } finally {
    img.close?.();
  }
}

/**
 * A product photo (Produits › Photos): 2048 px on its long side, a JPEG of at most 2.5 MB (its quality steps down when
 * needed; WhatsApp takes 5 MB) for Dellal to send, its 320 px copy for the screens and the AI, a 160 px one for the
 * chats that send it, and the light copy that becomes the line's or the product's picture. Done here: the phone's
 * original file (often 5 to 12 MB) never leaves it.
 */
export async function hdPhoto(file: File): Promise<{ data: string; w: number; h: number; thumb: string; mini: string; small?: string }> {
  if (!/^image\//.test(file.type)) throw new Error('not_image');
  const img = await createImageBitmap(file);
  try {
    const k = Math.min(1, 2048 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * k));
    const h = Math.max(1, Math.round(img.height * k));
    let big = draw(img, 2048, 0.86);
    for (const q of [0.8, 0.72, 0.64]) {
      if (big.length * 0.75 <= 2_500_000) break;
      big = draw(img, 2048, q);
    }
    if (big.length * 0.75 > 3_300_000) throw new Error('too_big');
    const light = small(img);
    return { data: big.slice(big.indexOf(',') + 1), w, h, thumb: draw(img, 320, 0.78), mini: draw(img, 160, 0.72), ...(light.length <= SMALL_MAX ? { small: light } : {}) };
  } finally {
    img.close?.();
  }
}
