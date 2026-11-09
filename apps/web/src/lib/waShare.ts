// « Envoyer des photos » on a phone. A WhatsApp link (wa.me) carries text only, so the photos go to WhatsApp from the
// phone itself: in the Pilotix app (mobile/…/WaSharePlugin.java) straight into the customer's chat, in the WhatsApp the
// agent uses; in a phone's browser through its share menu (the agent picks WhatsApp, then the customer). On a computer
// there is no way: the message carries the photos' link. An app made before this has no WaShare: the link too, until
// it is updated.
type Cap = { PluginHeaders?: { name: string }[]; nativePromise?: (plugin: string, method: string, options?: object) => Promise<unknown> };
const cap = () => (window as unknown as { Capacitor?: Cap }).Capacitor;
const hasPlugin = () => !!cap()?.PluginHeaders?.some((h) => h.name === 'WaShare') && !!cap()?.nativePromise;
const native = <T>(method: string, options: object = {}) => cap()!.nativePromise!('WaShare', method, options) as Promise<T>;

/** app: the Pilotix app puts the photos in the chat · share: the phone's share menu · link: the message carries a link */
export type SendMode = 'app' | 'share' | 'link';

/** the WhatsApp apps the Pilotix app knows (normal, Business) and their names */
export const WA_APPS: Record<string, string> = { 'com.whatsapp': 'WhatsApp', 'com.whatsapp.w4b': 'WhatsApp Business' };

/** an iPhone or an iPad (an iPad's Safari says « Macintosh », with a touch screen) */
export const isIos = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isPhone = () => isIos() || /Android/i.test(navigator.userAgent);

/** How this device sends the photos. */
export function sendMode(): SendMode {
  if (hasPlugin()) return 'app';
  try {
    const probe = new File([new Uint8Array([255, 216, 255])], 'photo.jpg', { type: 'image/jpeg' });
    if (isPhone() && typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] })) return 'share';
  } catch {
    /* no share menu with files */
  }
  return 'link';
}

/** The WhatsApp apps on this phone (in the Pilotix app). */
export const waApps = () =>
  native<{ apps?: string[] }>('apps')
    .then((r) => (r.apps ?? []).filter((a) => a in WA_APPS))
    .catch(() => [] as string[]);
/** The customer's chat with the message written, in that WhatsApp. */
export const waChat = (phone: string, text: string, app: string | null) => native<void>('chat', { phone, text, app });
/** The photos into the customer's chat (the app downloads them from Pilotix first). */
export const waPhotos = (phone: string, photos: string[], app: string | null) => native<{ sent?: number }>('photos', { phone, photos, app });

/** The photos as files, for the share menu (fetched while the agent sends the message). */
export async function photoFiles(urls: string[]): Promise<File[]> {
  const out: File[] = [];
  for (const [k, u] of urls.entries()) {
    const r = await fetch(u, { credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = await r.blob();
    const type = b.type.startsWith('image/') ? b.type : 'image/jpeg';
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : type === 'image/svg+xml' ? 'svg' : 'jpg';
    out.push(new File([b], `photo-${k + 1}.${ext}`, { type }));
  }
  return out;
}

/** The share menu with the photos only (the message went first; on iPhone, WhatsApp drops photos given with text). */
export async function sharePhotoFiles(files: File[]): Promise<'shared' | 'cancelled'> {
  try {
    await navigator.share({ files });
    return 'shared';
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
    throw e;
  }
}
