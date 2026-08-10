// EliteSwap admin push service worker.
// Only handles Web Push notifications. No caching, no offline behavior.
// Registered from src/lib/adminPush.ts and only on production origins.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'EliteSwap alert', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'EliteSwap alert';
  const options = {
    body: data.body || '',
    tag: data.tag || data.event || 'eliteswap-admin',
    renotify: true,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: { url: data.url || '/admin', event: data.event || null },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/admin';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      try {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) await client.navigate(target);
          return;
        }
      } catch (_) {}
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
