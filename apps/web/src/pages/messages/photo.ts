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
