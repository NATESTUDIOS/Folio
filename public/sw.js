// ============================================================
// Folio — Service Worker
// ============================================================

// ── Date-based versioning ───────────────────────────────────
// Format: YYYY-MM-DD-<n>
//   Increment <n> for same-day deploys; bump date on a new day.
//   Sort naturally, easy to spot in DevTools → Application → SW.
//   Example: '2026-10-19-1', '2026-10-19-2', '2026-10-20-1'
const CACHE_VERSION = '2026-10-19-1';
const CACHE_NAME = `folio-shell-${CACHE_VERSION}`;
const CACHE_BUILT_AT = Date.now();

// Cross-origin hosts we allow through the fetch handler so we can
// cache them for offline use.
const CDN_HOSTS = new Set([
  'deno.land',
  'esm.sh',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

// ── Pre-cache list ──────────────────────────────────────────
// Same-origin assets + CodeMirror ESM bundle from deno.land.
const CACHED_FILES = [
  // ── HTML pages ──────────────────────────────────────────
  '/',
  '/index.html',
  '/invite.html',
  '/app.css',
  '/project.css',
  '/register.html',
  '/profile.html',
  '/project.html',
  '/projects.html',
  '/tools.html',
  '/settings.html',
  '/analytics.html',
  '/offline.html',

  // ── PWA metadata ────────────────────────────────────────
  '/manifest.json',

  // ── Icons ───────────────────────────────────────────────
  '/icons/icon-144.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',

  // ── Screenshots ─────────────────────────────────────────
  '/screenshots/screenshot1.png',
  '/screenshots/screenshot2.png',
  '/screenshots/screenshot3.png',
  '/screenshots/screenshot4.png',
  '/screenshots/screenshot5.png',
  '/screenshots/screenshot6.png',

  // ── Scripts ─────────────────────────────────────────────
  '/install.js',
  '/update.js',

  // ── CodeMirror via deno.land ────────────────────────────
  // Core modules
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/codemirror/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/view/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/state/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/commands/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/search/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/lint/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/merge/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/language/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/theme-one-dark/dist/index.js',

  // Language packs
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-html/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-css/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-javascript/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-json/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-markdown/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-python/dist/index.js',
];

// Routes served as the "app shell" → cache-first.
const SHELL_ROUTES = new Set([
  '/',
  '/index.html',
]);

// ── Bypass rules ────────────────────────────────────────────
// Anything we should NEVER intercept.
function shouldBypass(url, request) {
  if (request.method !== 'GET') return true;

  // Range requests (media, resumable downloads) — must go straight
  // to network, caching byte-range slices breaks the semantics.
  if (request.headers.get('range')) return true;

  // Cross-origin: only allow through the CDN hosts we explicitly
  // want to cache. All other cross-origin requests pass through.
  if (url.origin !== self.location.origin) {
    if (!CDN_HOSTS.has(url.hostname)) return true;
  }

  // Serverless APIs
  if (url.pathname.startsWith('/api/')) return true;

  // Firebase messaging internals
  if (url.pathname.startsWith('/firebase-cloud-messaging-push-scope/')) return true;
  if (url.pathname.includes('firebase-messaging-sw.js')) return true;
  if (url.pathname.includes('/__/firebase/')) return true;

  // Chrome extension internals (shouldn't happen, but be safe)
  if (url.protocol === 'chrome-extension:') return true;

  return false;
}

// ═══════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════
self.addEventListener('install', (event) => {
  console.log(`[Folio SW] installing ${CACHE_VERSION}`);
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Try bulk add first — fast path
    let bulkOk = false;
    try {
      // Skip cross-origin in bulk (some browsers complain on opaque responses)
      const sameOrigin = CACHED_FILES.filter(f => f.startsWith('/'));
      await cache.addAll(sameOrigin);
      bulkOk = true;
    } catch (err) {
      console.warn('[Folio SW] bulk addAll failed, falling back to per-file', err);
    }

    // Per-file fetch for whatever remains (and all cross-origin)
    let fetched = 0, missed = 0;
    await Promise.allSettled(
      CACHED_FILES.map(async (url) => {
        try {
          if (await cache.match(url)) { fetched++; return; }
          const res = await fetch(url, { cache: 'no-store' });
          if (res.ok) {
            await cache.put(url, res);
            fetched++;
          } else {
            console.warn(`[Folio SW] skip ${url} (${res.status})`);
            missed++;
          }
        } catch (err) {
          console.warn(`[Folio SW] miss ${url}`, err);
          missed++;
        }
      })
    );

    console.log(`[Folio SW] install complete — bulk=${bulkOk} fetched=${fetched} missed=${missed}`);

    // ── Notify existing clients that a new version is waiting ──
    // Fires `SW_UPDATE_AVAILABLE` so update.js can show the
    // "Update available" dialog immediately, without waiting for
    // its 5-minute poll. Skip the very first install (no clients
    // controlled yet) — that's not an "update", it's a fresh install.
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const hasController = clients.some(c => c.frameType === 'top-level' && c.type === 'window');
      // Only broadcast if at least one client is already controlled by
      // a previous SW generation (i.e. this is a genuine update, not
      // the very first install).
      const anyControlled = await self.clients.matchAll({ type: 'window' }).then(list =>
        list.length > 0
      );
      if (anyControlled || hasController) {
        clients.forEach(c => {
          try {
            c.postMessage({
              type: 'SW_UPDATE_AVAILABLE',
              version: CACHE_VERSION,
              builtAt: CACHE_BUILT_AT,
            });
          } catch {}
        });
      }
    } catch (err) {
      console.warn('[Folio SW] update broadcast failed:', err);
    }

    await self.skipWaiting();
  })());
});

// ═══════════════════════════════════════════════════════════
// Activate
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
      builtAt: CACHE_BUILT_AT,
      timestamp: Date.now(),
    }));

    console.log(`[Folio SW] activated`);
  })());
});

// ═══════════════════════════════════════════════════════════
// Fetch
//  - Shell routes         → cache-first
//  - Other navigations    → network-first → cache → offline.html
//  - Static assets        → stale-while-revalidate
//  - CDN assets           → stale-while-revalidate
// ═══════════════════════════════════════════════════════════
self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch { return; }

  if (shouldBypass(url, req)) return;

  const isNav = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isNav) {
    const isShell = SHELL_ROUTES.has(url.pathname);
    if (isShell) {
      event.respondWith(cacheFirstShell(req));
    } else {
      event.respondWith(networkFirstNav(req));
    }
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});

async function cacheFirstShell(req) {
  // Try exact, then origin root, then index.html
  let cached =
    await caches.match(req, { ignoreSearch: true }) ||
    await caches.match('/') ||
    await caches.match('/index.html');

  // Fire-and-forget refresh
  fetch(req).then(res => {
    if (res && res.ok) {
      caches.open(CACHE_NAME).then(c => c.put(req, res.clone())).catch(() => {});
    }
  }).catch(() => {});

  if (cached) return cached;

  try {
    return await fetch(req);
  } catch {
    return offlinePage(req);
  }
}

async function networkFirstNav(req) {
  try {
    const res = await fetch(req);
    // Only cache successful HTML responses
    if (res && res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      const copy = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return offlinePage(req);
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: true });

  const network = fetch(req).then(res => {
    if (res && res.ok) {
      try {
        const url = new URL(req.url);
        const allowed =
          url.origin === self.location.origin ||
          CDN_HOSTS.has(url.hostname);
        if (allowed) cache.put(req, res.clone()).catch(() => {});
      } catch {}
    }
    return res;
  }).catch(() => null);

  if (cached) return cached;

  const net = await network;
  if (net) return net;

  // No cache, no network
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return offlinePage(req);
  return new Response('', { status: 404, statusText: 'Offline' });
}

// Build the offline URL with ?from= so Retry returns the right page.
function offlineUrlFor(req) {
  try {
    const u = new URL(req.url);
    const from = u.pathname + u.search;
    return '/offline.html?from=' + encodeURIComponent(from);
  } catch {
    return '/offline.html';
  }
}

async function offlinePage(req) {
  // Try to serve the shell offline.html first (with ?from=)
  const withFrom = req ? offlineUrlFor(req) : '/offline.html';
  const cachedWithFrom = await caches.match(withFrom, { ignoreSearch: true });
  if (cachedWithFrom) return cachedWithFrom;

  const cachedPlain = await caches.match('/offline.html');
  if (cachedPlain) return cachedPlain;

  // Last-resort inline fallback (offline.html not yet cached)
  return new Response(
    '<!doctype html><meta charset=utf-8><title>Offline — Folio</title>' +
    '<meta name="theme-color" content="#0a0c10">' +
    '<style>' +
    ':root{color-scheme:dark}' +
    'body{background:#0a0c10;color:#e8ecf1;font-family:system-ui,-apple-system,sans-serif;' +
    'display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px;' +
    'line-height:1.5}' +
    'h1{font-size:20px;margin:0 0 8px;font-weight:800;letter-spacing:-0.3px}' +
    'p{color:#a8b0bc;font-size:14px;margin:0 0 16px;max-width:320px}' +
    'a{color:#F59E0B;font-weight:700;text-decoration:none}' +
    'button{background:#F59E0B;color:#0a0c10;border:none;padding:10px 18px;border-radius:9px;' +
    'font-weight:700;font-size:13px;cursor:pointer;margin-top:8px}' +
    '</style>' +
    '<div>' +
    '<h1>You\'re offline</h1>' +
    '<p>Folio can\'t reach the network right now. Local projects still work.</p>' +
    '<button onclick="location.reload()">Retry</button>' +
    '<p style="margin-top:16px;font-size:11px;color:#666"><a href="/">Try the editor</a></p>' +
    '</div>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
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
      event.ports?.[0]?.postMessage({
        version: CACHE_VERSION,
        cache: CACHE_NAME,
        builtAt: CACHE_BUILT_AT,
      });
      break;

    case 'CLEAR_CACHE':
      event.waitUntil(
        caches.keys()
          .then(keys => Promise.all(keys.map(k => caches.delete(k))))
          .then(() => event.ports?.[0]?.postMessage({ ok: true }))
          .catch(() => event.ports?.[0]?.postMessage({ ok: false }))
      );
      break;

    case 'CHECK_QUEUE':
      event.waitUntil((async () => {
        let count = 0;
        try {
          const req = indexedDB.open('folio', 2);
          const conn = await new Promise((res, rej) => {
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });
          if (conn.objectStoreNames.contains('syncQueue')) {
            const all = await new Promise((res) => {
              const t = conn.transaction('syncQueue', 'readonly').objectStore('syncQueue');
              const r = t.getAll();
              r.onsuccess = () => res(r.result || []);
              r.onerror = () => res([]);
            });
            count = all.length;
          }
          conn.close();
        } catch {}
        event.ports?.[0]?.postMessage({ count });
      })());
      break;
  }
});

// ═══════════════════════════════════════════════════════════
// Push + notification click
// ═══════════════════════════════════════════════════════════
self.addEventListener('push', (event) => {
  let payload = null;
  try { payload = event.data?.json?.(); } catch {}
  if (!payload) {
    console.debug('[Folio SW] push received (no payload)');
    return;
  }
  const title = payload.title || 'Folio';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/icon-144.png',
    data: { url: payload.url || '/' },
    tag: payload.tag || 'folio',
    renotify: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      try {
        if (new URL(c.url).pathname === new URL(target, self.location.origin).pathname) {
          c.focus();
          return;
        }
      } catch {}
    }
    self.clients.openWindow(target);
  })());
});

self.addEventListener('messageerror', () => {});

console.log(`[Folio SW] loaded ${CACHE_VERSION}`);