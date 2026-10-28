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
  return navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href);
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
