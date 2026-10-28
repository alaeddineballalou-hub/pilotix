// Web Push (phone / computer notifications): VAPID keys and sending, with the standard web-push library.
import * as webpush from 'web-push';
import { config } from './config';

export function pushKeys() {
  return webpush.generateVAPIDKeys();
}

export async function push(keys: { publicKey: string; privateKey: string }, subs: { endpoint: string; p256dh: string; auth: string }[], payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const vapidDetails = { subject: config.publicUrl || 'mailto:contact@pilotix.online', publicKey: keys.publicKey, privateKey: keys.privateKey };
  return Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { vapidDetails, TTL: 120, urgency: 'high' });
        return { endpoint: s.endpoint, ok: true, gone: false };
      } catch (e: any) {
        const code = Number(e?.statusCode) || 0;
        return { endpoint: s.endpoint, ok: false, gone: code === 404 || code === 410 };
      }
    }),
  );
}
