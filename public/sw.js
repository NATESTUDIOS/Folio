// ============================================================
// Folio — Service Worker
// ============================================================

const CACHE_VERSION = 'v2';
const CACHE_NAME = `folio-shell-${CACHE_VERSION}`;

// Pre-cache list. Add a trailing slash to folio? (no).
// Update this list when you add a page or a shared asset.
const CACHED_FILES = [
  // HTML pages
  '/',
  '/index.html',
  '/register.html',
  '/profile.html',
  '/project.html',
  '/tools.html',
  '/settings.html',
  '/analytics.html',
  '/offline.html',

  // Shared styles (3 CSS — adjust names if different)
  '/app.css',
  '/theme.css',
  '/css.css',           // <-- third CSS. Rename to your actual filename.

  // Editor support data
  '/syntax.json',
  '/manifest.json',

  // Icons
  '/icon.jpg',
  '/icons/icon-144.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',

  // Scripts
  '/install.js',
  '/update.js',
];

// Routes served as the "app shell" → cache-first.
// Everything else → network-first.
const SHELL_ROUTES = new Set([
  '/',
  '/index.html',
  '/app',
]);

// Requests we must never intercept.
function shouldBypass(url, request) {
  if (request.method !== 'GET') return true;
  if (url.origin !== self.location.origin) return true;

  // Serverless APIs
  if (url.pathname.startsWith('/api/')) return true;

  // Firebase messaging internals
  if (url.pathname.startsWith('/firebase-cloud-messaging-push-scope/')) return true;
  if (url.pathname.includes('firebase-messaging-sw.js')) return true;
  if (url.pathname.includes('/__/firebase/')) return true;

  // CodeMirror CDN is cross-origin — already excluded above.
  return false;
}

// ═══════════════════════════════════════════════════════════
// Install: pre-cache, tolerate failures, take over
// ═══════════════════════════════════════════════════════════
self.addEventListener('install', (event) => {
  console.log(`[Folio SW] installing ${CACHE_VERSION}`);
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(
      CACHED_FILES.map(async (url) => {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (res.ok) {
            await cache.put(url, res);
          } else {
            console.warn(`[Folio SW] skip ${url} (${res.status})`);
          }
        } catch (err) {
          console.warn(`[Folio SW] miss ${url}`, err);
        }
      })
    );
    await self.skipWaiting();
    console.log(`[Folio SW] install complete`);
  })());
});

// ═══════════════════════════════════════════════════════════
// Activate: drop old caches, claim clients, announce
// ═══════════════════════════════════════════════════════════
self.addEventListener('activate', (event) => {
  console.log(`[Folio SW] activating ${CACHE_VERSION}`);
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    );

    await self.clients.claim();

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage({
      type: 'SW_ACTIVATED',
      version: CACHE_VERSION,
      timestamp: Date.now(),
    }));

    console.log(`[Folio SW] activated`);
  })());
});

// ═══════════════════════════════════════════════════════════
// Fetch: split strategy
//  - Shell routes         → cache-first
//  - Other navigations    → network-first → cache → offline.html
//  - Static assets        → stale-while-revalidate
// ═══════════════════════════════════════════════════════════
self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch { return; }

  if (shouldBypass(url, req)) return;

  // ── Shell routes: cache-first, fall back to network ──
  const isShell = SHELL_ROUTES.has(url.pathname);

  // ── Navigation requests ──
  const isNav = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isNav) {
    if (isShell) {
      event.respondWith(cacheFirstShell(req));
    } else {
      event.respondWith(networkFirstNav(req));
    }
    return;
  }

  // ── Static assets: stale-while-revalidate ──
  event.respondWith(staleWhileRevalidate(req));
});

async function cacheFirstShell(req) {
  const cached = await caches.match(req, { ignoreSearch: true })
              || await caches.match('/')
              || await caches.match('/index.html');

  // Fire-and-forget refresh
  fetch(req).then(res => {
    if (res && res.ok) {
      caches.open(CACHE_NAME).then(c => c.put(req, res.clone())).catch(() => {});
    }
  }).catch(() => {});

  return cached || fetch(req).catch(() => offlinePage());
}

async function networkFirstNav(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch {
    const cached = await caches.match(req, { ignoreSearch: true });
    return cached || await caches.match('/offline.html') || offlinePage();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: true });

  const network = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);

  return cached || await network || new Response('', { status: 404 });
}

function offlinePage() {
  return caches.match('/offline.html').then(r => r || new Response(
    '<!doctype html><meta charset=utf-8><title>Offline</title>' +
    '<style>body{background:#0a0c10;color:#e8ecf1;font-family:system-ui,sans-serif;' +
    'display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px}' +
    'h1{font-size:20px;margin:0 0 6px}p{color:#a8b0bc;font-size:14px;margin:0}</style>' +
    '<div><h1>Offline</h1><p>Reconnect to continue.</p></div>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  ));
}

// ═══════════════════════════════════════════════════════════
// Message bus
// ═══════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;
  const type = typeof data === 'string' ? data : (data.type || data.action);

  switch (type) {
    case 'SKIP_WAITING':
    case 'skipWaiting':
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      event.ports?.[0]?.postMessage({ version: CACHE_VERSION, cache: CACHE_NAME });
      break;

    case 'CLEAR_CACHE':
      event.waitUntil(
        caches.keys()
          .then(keys => Promise.all(keys.map(k => caches.delete(k))))
          .then(() => event.ports?.[0]?.postMessage({ ok: true }))
      );
      break;
  }
});

// ═══════════════════════════════════════════════════════════
// Push + notification click — Phase 4 stubs
// Kept so FCM wiring drops in without touching routing.
// ═══════════════════════════════════════════════════════════
self.addEventListener('push', (event) => {
  // TODO (Phase 4): parse payload, show notification
  console.debug('[Folio SW] push received (not yet handled)');
});

self.addEventListener('notificationclick', (event) => {
  // TODO (Phase 4): route by notification type
  event.notification.close();
});

// ═══════════════════════════════════════════════════════════
// Notify clients of new SW versions (used by update.js)
// (Fired automatically by the browser on update; we forward it.)
// ═══════════════════════════════════════════════════════════
self.addEventListener('messageerror', () => {});

console.log(`[Folio SW] loaded ${CACHE_VERSION}`);