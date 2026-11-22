// Phone / computer notifications (Web Push): this device asks once (« Activer »), then the server can ring it even when
// Pilotix is closed or the phone is locked. Nothing in the browser preview (no server to send them).
import { rpc } from './backend';

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const b64 = (s: string) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function registration() {
  // the site's worker already there (lib/door installs it as « sw.js?door=1 » with the backup door on): the same one
  const had = await navigator.serviceWorker.getRegistration();
  if (had) return had;
  // next to the site's index.html (/sw.js on the site, whatever page's address is open: /<boutique>/commandes/…)
  return navigator.serviceWorker.register(new URL(`${import.meta.env.BASE_URL}sw.js`, document.baseURI).href);
}

/** Subscribes this device (asks the permission when `ask`, which must come from a tap). Returns the state after. */
export async function enablePush(ask: boolean): Promise<'on' | 'denied' | 'off' | 'unsupported'> {
  if (!pushSupported()) return 'unsupported';
  const { key } = await rpc('push.key', {});
  if (!key) return 'unsupported';
  let perm = Notification.permission;
  if (perm === 'default' && ask) perm = await Notification.requestPermission();
  if (perm === 'denied') return 'denied';
  if (perm !== 'granted') return 'off';
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await rpc('push.subscribe', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, ua: navigator.userAgent.slice(0, 300) });
  return 'on';
}

/**
 * A phone or a tablet (Android, iPhone, iPad…): « Bloquer jusqu'à l'appel » rings and blocks there, never on a computer.
 * The same test as the server's push.ts › phoneSql (on the user agent this device saves with its notifications).
 */
export const phoneDevice = () => typeof navigator !== 'undefined' && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);

// The Claude demo (no server to send notifications): this phone « rings » unless the demo was told otherwise
// (localStorage px-demo-push = off | denied | unsupported), so the page that asks for them can be seen too.
const DEMO = import.meta.env.VITE_DEMO_ONLY === '1';
type Here = Awaited<ReturnType<typeof enablePush>>;
function demoHere(): Here {
  try {
    const v = localStorage.getItem('px-demo-push');
    return v === 'off' || v === 'denied' || v === 'unsupported' ? v : 'on';
  } catch {
    return 'on';
  }
}

/** Can this device ring (without asking)? 'on' also tells the server again that it can (its user agent with it). */
export async function pushHere(): Promise<Here> {
  return DEMO ? demoHere() : enablePush(false);
}

/** « Activer les notifications » (from a tap): asks the permission, then the same as pushHere. */
export async function pushTurnOn(): Promise<Here> {
  if (DEMO) {
    try {
      if (localStorage.getItem('px-demo-push') === 'off') localStorage.removeItem('px-demo-push');
    } catch {
      /* private mode */
    }
    return demoHere();
  }
  return enablePush(true);
}

/** This device's notification address (how the server knows this phone); null: none. The demo: a made-up one, kept here. */
export async function myEndpoint(): Promise<string | null> {
  if (DEMO) {
    try {
      let v = localStorage.getItem('px-demo-endpoint');
      if (!v) {
        v = `https://fcm.googleapis.com/fcm/send/demo-${Math.random().toString(36).slice(2, 12)}`;
        localStorage.setItem('px-demo-endpoint', v);
      }
      return v;
    } catch {
      return 'https://fcm.googleapis.com/fcm/send/demo-here';
    }
  }
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub?.endpoint ?? null;
}
