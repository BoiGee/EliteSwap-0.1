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
// An isolated (COEP) page may only start a worker whose own script response carries COEP;
// without it Chrome blocks the script (ERR_BLOCKED_BY_RESPONSE, verified live) and the
// background segmenter never starts. Same-origin worker scripts only.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if ((req.destination === 'worker' || req.destination === 'sharedworker') && new URL(req.url).origin === self.location.origin) {
    event.respondWith(
      fetch(req).then((response) => {
        if (response.type === 'opaque' || response.status === 0) return response;
        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
        headers.set('Cross-Origin-Resource-Policy', 'same-origin');
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }),
    );
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  // Scoped to /studio itself — the worker registers at scope '/' (it also
  // handles push notifications for the whole site), but COOP/COEP must NOT
  // leak onto every other route. A site-wide isolated document blocks any
  // future popup-based flow (OAuth, a payment provider popup, an embedded
  // widget) via window.opener, breakage that would show up far from here.
  //
  // GitHub Pages has no /studio file: it answers with 404.html, which redirects to
  // "/?/studio" (index.html restores the path). The document that finally loads is "/",
  // so stamping only "/studio" responses never isolated anything and the AI background
  // segmenter never started. For /studio, serve index.html directly (no 404 detour), and
  // also stamp the "/?/studio" redirect landing for visits made before this worker took over.
  const url = new URL(event.request.url);
  const isStudio = url.pathname.indexOf('/studio') === 0;
  const isStudioRedirect = url.pathname === '/' && url.search.indexOf('?/studio') === 0;
  if (!isStudio && !isStudioRedirect) return;
  const upstream = isStudio ? new Request('/index.html', { credentials: 'same-origin' }) : event.request;
  event.respondWith(
    fetch(upstream)
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
