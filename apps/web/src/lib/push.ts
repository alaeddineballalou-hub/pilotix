// Phone / computer notifications (Web Push): this device asks once (« Activer »), then the server can ring it even when
// Pilotix is closed or the phone is locked. Nothing in the browser preview (no server to send them).
import { rpc } from './backend';
import { currentShop } from './features';

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const b64 = (s: string) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const workerUrl = () => new URL(`${import.meta.env.BASE_URL}sw.js`, document.baseURI).href;

const agencyScope = () => {
  const shop = currentShop();
  return shop?.kind === 'agency' ? `/__pilotix_push/${shop.id}/` : undefined;
};

async function registration() {
  const scope = agencyScope();
  if (scope) {
    // A different VAPID key and subscription for each agency, without replacing the site's worker.
    return navigator.serviceWorker.register(workerUrl(), { scope });
  }
  // the site's worker already there (lib/door installs it as « sw.js?door=1 » with the backup door on): the same one
  const had = await navigator.serviceWorker.getRegistration();
  if (had) return had;
  // next to the site's index.html (/sw.js on the site, whatever page's address is open: /<boutique>/commandes/…)
  return navigator.serviceWorker.register(workerUrl());
}

/** Subscribes this device (asks the permission when `ask`, which must come from a tap). Returns the state after. */
export async function enablePush(ask: boolean): Promise<'on' | 'denied' | 'off' | 'unsupported'> {
  if (!pushSupported()) return 'unsupported';
  const shopId = currentShop()?.id;
  let perm = Notification.permission;
  if (perm === 'default' && ask) perm = await Notification.requestPermission();
  if (perm === 'denied') return 'denied';
  if (perm !== 'granted' || currentShop()?.id !== shopId) return 'off';
  const scope = agencyScope();
  if (scope && !ask) {
    const reg = await navigator.serviceWorker.getRegistration(scope);
    const sub = reg?.scope === new URL(scope, location.origin).href ? await reg.pushManager.getSubscription() : null;
    if (!sub) return 'off';
    return (await rpc('push.key', { endpoint: sub.endpoint }, null)).subscribed ? 'on' : 'off';
  }
  const { key } = await rpc('push.key', {}, null);
  if (!key) return 'unsupported';
  const reg = await registration();
  const worker = reg.installing ?? reg.waiting;
  if (!reg.active && worker && worker.state !== 'activated') {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Notification worker did not activate')), 10_000);
      const changed = () => {
        if (worker.state !== 'activated' && worker.state !== 'redundant') return;
        window.clearTimeout(timer);
        worker.removeEventListener('statechange', changed);
        if (worker.state === 'activated') resolve();
        else reject(new Error('Notification worker could not activate'));
      };
      worker.addEventListener('statechange', changed);
      changed();
    });
  }
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
  if (currentShop()?.id !== shopId) return 'off';
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await rpc('push.subscribe', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, ua: navigator.userAgent.slice(0, 300) }, null);
  return 'on';
}

/**
 * A phone or a tablet (Android, iPhone, iPad…): « Bloquer jusqu'à l'appel » rings and blocks there, never on a computer.
 * The same test as the server's push.ts › phoneSql (on the user agent this device saves with its notifications).
 */
export async function disableDevicePush(): Promise<void> {
  const endpoint = await myEndpoint();
  if (endpoint) await rpc('push.unsubscribe', { endpoint }, null);
}

export async function testDevicePush(): Promise<boolean> {
  const endpoint = await myEndpoint();
  return endpoint ? (await rpc('push.test', { endpoint }, null)).sent : false;
}

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
  const scope = agencyScope();
  const reg = await navigator.serviceWorker.getRegistration(scope);
  const sub = reg && (!scope || reg.scope === new URL(scope, location.origin).href) ? await reg.pushManager.getSubscription() : null;
  return sub?.endpoint ?? null;
}
