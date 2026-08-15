// EliteSwap service worker. Two unrelated jobs share this one file because
// a scope ('/') can only have a single controlling worker — registering a
// second script at the same scope would fight this one for control instead
// of running alongside it:
//   1. Web Push notifications for admin alerts (registered from
//      src/lib/adminPush.ts, production origins only).
//   2. Cross-origin isolation headers (see fetch handler below), registered
//      from src/lib/crossOriginIsolation.ts on the /studio route only, so
//      MediaPipe's threaded WASM segmenter can use SharedArrayBuffer even
//      though GitHub Pages can't be configured to send these headers itself.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Stamps the top-level document's own response with COOP+COEP so the page
// that registered this worker becomes cross-origin isolated on its next
// load. Credentialless (not require-corp) deliberately: this site loads
// Google Fonts, Supabase Storage images, and the MediaPipe CDN without those
// third parties sending a Cross-Origin-Resource-Policy header, and
// credentialless still allows those no-cors loads through (credentials
// stripped, which they don't need anyway) instead of blocking them outright.
//
// Scoped to navigation requests only (`request.mode === 'navigate'`) — COEP
// is a document-level policy: once the HTML response carries it, the browser
// enforces it against every subresource the page loads (same-origin scripts,
// workers spawned from the page, cross-origin images/fonts under
// credentialless) on its own. An earlier version of this handler rewrote
// every request — JS chunks, Supabase calls, images — which added a real,
// measurable per-request tax to the entire session for zero benefit, since
// none of those responses need COOP/COEP set on themselves.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  // Scoped to /studio itself — the worker registers at scope '/' (it also
  // handles push notifications for the whole site), but COOP/COEP must NOT
  // leak onto every other route. A site-wide isolated document blocks any
  // future popup-based flow (OAuth, a payment provider popup, an embedded
  // widget) via window.opener, breakage that would show up far from here.
  if (new URL(event.request.url).pathname.indexOf('/studio') !== 0) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') {
          return response;
        }
        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch(() => fetch(event.request)),
  );
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
