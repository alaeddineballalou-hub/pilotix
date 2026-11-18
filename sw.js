// Pilotix service worker: shows the notifications the server pushes (dépôt alerts ring until the app is opened).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch (_) {
    d = { title: 'Pilotix', body: e.data ? e.data.text() : '' };
  }
  const alarm = !!d.alarm;
  e.waitUntil(
    self.registration.showNotification(d.title || 'Pilotix', {
      body: d.body || '',
      tag: d.tag || 'pilotix',
      // same tag again: it rings and vibrates again instead of staying silent
      renotify: true,
      requireInteraction: alarm,
      silent: false,
      vibrate: alarm ? [800, 200, 800, 200, 800, 200, 1200] : [200],
      icon: 'icon.svg',
      badge: 'icon.svg',
      data: { url: d.url || '' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url ? e.notification.data.url : '', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(url);
    }),
  );
});
