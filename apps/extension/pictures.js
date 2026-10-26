// Pilotix Spy: small JPEG pictures of the ads, made in the service worker.
// Facebook's picture links expire after a few days, so Pilotix keeps a small copy with each ad (RawAd.media).

export const PICTURES = {
  max: 30, // pictures per search
  parallel: 4, // downloads at the same time
  width: 400, // px, the picture is never enlarged
  height: 600, // px, at most
  quality: 0.72,
  limit: 550_000, // characters of the data URL (RawAdSchema allows 600 000)
  timeout: 10_000, // ms per picture
};

/** The drawn size: at most `width` wide and `height` high, same ratio, never enlarged. */
export function fitSize(w, h, maxW = PICTURES.width, maxH = PICTURES.height) {
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Bytes → base64, in chunks (no FileReader in a service worker, and String.fromCharCode cannot take a whole picture). */
export function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Only Facebook's own picture servers (the extension may read them; nothing else is downloaded). */
const isFacebookPicture = (u) => u.protocol === 'https:' && /(^|\.)fbcdn\.net$/.test(u.hostname);

/** One picture → "data:image/jpeg;base64,…" (or null). Uses fetch, createImageBitmap and an OffscreenCanvas. */
export async function pictureOf(src, timeoutMs = PICTURES.timeout) {
  let u;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  if (!isFacebookPicture(u)) return null;
  const res = await fetch(u.href, { signal: AbortSignal.timeout(timeoutMs), credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'force-cache' });
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const { width, height } = fitSize(bitmap.width, bitmap.height);
    if (!width || !height) return null;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // JPEG has no transparency
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: PICTURES.quality });
    return `data:image/jpeg;base64,${toBase64(new Uint8Array(await jpeg.arrayBuffer()))}`;
  } finally {
    bitmap.close();
  }
}

/**
 * Sets ad.media on the ads that have a mediaUrl (at most PICTURES.max, PICTURES.parallel at a time). Starts no new
 * download after `until` (a Date.now() time) or once `stopped()` is true; a picture that fails or is too big is simply
 * left out. Returns the number of pictures made.
 */
export async function addPictures(ads, until, stopped = () => false) {
  const todo = ads.filter((a) => a.mediaUrl).slice(0, PICTURES.max);
  let next = 0;
  let made = 0;
  const worker = async () => {
    while (next < todo.length) {
      const ad = todo[next++];
      const left = until - Date.now();
      if (left < 1_500 || stopped()) return;
      try {
        const url = await pictureOf(ad.mediaUrl, Math.min(PICTURES.timeout, left));
        if (url && url.length <= PICTURES.limit) {
          ad.media = url;
          made++;
        }
      } catch {
        // expired link, network error, unreadable picture: the ad goes without it
      }
    }
  };
  await Promise.all(Array.from({ length: PICTURES.parallel }, worker));
  return made;
}
