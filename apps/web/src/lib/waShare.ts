// « Envoyer des photos »: one button on every screen, the real photos and the message straight into the customer's
// WhatsApp chat. A WhatsApp link carries text only, so the photos go to WhatsApp another way on each device:
// - the Pilotix app (mobile/…/WaSharePlugin.java): the message opens the chat (it makes it), then the photos go
//   straight into that chat when the agent comes back to Pilotix;
// - a phone's browser: the message opens the chat, then its share menu takes the photos (WhatsApp, then the customer);
// - a computer: the Pilotix WhatsApp extension (apps/wa-extension) opens WhatsApp Web on the chat and pastes the photos
//   with the message under them (a website alone cannot put files into WhatsApp Web);
// - an app made before WaShare: the message carries the photos' link, until it is updated.
type Cap = { PluginHeaders?: { name: string }[]; nativePromise?: (plugin: string, method: string, options?: object) => Promise<unknown> };
const cap = () => (window as unknown as { Capacitor?: Cap }).Capacitor;
const hasPlugin = () => !!cap()?.PluginHeaders?.some((h) => h.name === 'WaShare') && !!cap()?.nativePromise;
const native = <T>(method: string, options: object = {}) => cap()!.nativePromise!('WaShare', method, options) as Promise<T>;

/** app: the Pilotix app · share: a phone's share menu · pc: a computer (the extension) · link: the message carries a link */
export type SendMode = 'app' | 'share' | 'pc' | 'link';

/** the WhatsApp apps the Pilotix app knows (normal, Business) and their names */
export const WA_APPS: Record<string, string> = { 'com.whatsapp': 'WhatsApp', 'com.whatsapp.w4b': 'WhatsApp Business' };

/** an iPhone or an iPad (an iPad's Safari says « Macintosh », with a touch screen) */
export const isIos = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isPhone = () => isIos() || /Android/i.test(navigator.userAgent);
/** inside the Pilotix app (mobile/capacitor.config.json adds « PilotixApp » to its user agent) */
const inApp = () => /\bPilotixApp\b/.test(navigator.userAgent);

/** This browser can hand files to the phone's share menu. */
export function canShareFiles() {
  try {
    const probe = new File([new Uint8Array([255, 216, 255])], 'photo.jpg', { type: 'image/jpeg' });
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** How this device sends the photos. */
export function sendMode(): SendMode {
  if (hasPlugin()) return 'app';
  if (inApp()) return 'link';
  if (isPhone()) return canShareFiles() ? 'share' : 'link';
  return 'pc';
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
export async function photoFiles(urls: string[], name = 'photo'): Promise<File[]> {
  const out: File[] = [];
  for (const [k, u] of urls.entries()) {
    const r = await fetch(u, { credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = await r.blob();
    const type = b.type.startsWith('image/') ? b.type : 'image/jpeg';
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : type === 'image/svg+xml' ? 'svg' : 'jpg';
    out.push(new File([b], `${name}-${k + 1}.${ext}`, { type }));
  }
  return out;
}

/** The share menu with the photos only (the message went first; on iPhone WhatsApp drops photos given with text). */
export async function sharePhotoFiles(files: File[]): Promise<'shared' | 'cancelled'> {
  try {
    await navigator.share({ files });
    return 'shared';
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
    throw e;
  }
}

/** The extension's download (apps/wa-extension, zipped by the website's build). */
export const EXT_ZIP = '/pilotix-whatsapp.zip';
/** The Pilotix WhatsApp extension on this computer: its version (it marks the page), or null. */
export const extVersion = () => document.documentElement.getAttribute('data-pilotix-wa');
/** Chrome, Edge and the browsers made like them take the extension; Firefox and Safari do not. */
export const extBrowser = () => /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);

export type ExtResult = { ok: boolean; error?: string; detail?: string; photos?: number };
/**
 * The extension opens WhatsApp Web on the customer's chat and pastes the photos with the message under them; the
 * agent presses Enter. Answers once it is done there (or why not).
 */
export function extSend(phone: string, text: string, photos: string[]): Promise<ExtResult> {
  return new Promise((ok) => {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const done = (e: MessageEvent) => {
      if (e.source !== window || e.data?.type !== 'pilotix-wa:result' || e.data.id !== id) return;
      window.removeEventListener('message', done);
      clearTimeout(timer);
      const { type: _t, id: _i, ...r } = e.data as ExtResult & { type: string; id: string };
      ok(r);
    };
    const timer = setTimeout(() => {
      window.removeEventListener('message', done);
      ok({ ok: false, error: 'timeout' });
    }, 150_000);
    window.addEventListener('message', done);
    window.postMessage({ type: 'pilotix-wa:send', id, phone, text, photos }, location.origin);
  });
}
