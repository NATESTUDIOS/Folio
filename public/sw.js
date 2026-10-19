// ============================================================
// Folio — Service Worker
// ============================================================

// ── Date-based versioning ───────────────────────────────────
// Format: YYYY-MM-DD-<n>
//   Increment <n> for same-day deploys; bump date on a new day.
const CACHE_VERSION = '2026-10-19-4';
const CACHE_NAME = `folio-shell-${CACHE_VERSION}`;
const CACHE_BUILT_AT = Date.now();

// Cross-origin hosts we allow through the fetch handler so we can
// cache them for offline use.
const CDN_HOSTS = new Set([
  'deno.land',
  'esm.sh',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com',
]);

// ── Pre-cache list ──────────────────────────────────────────
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
  '/notifications.html',

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
  '/fcm-client.js',
  '/notifications.js',
  '/firebase-messaging-sw.js',

  // ── CodeMirror via deno.land ────────────────────────────
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/codemirror/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/view/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/state/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/commands/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/search/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/lint/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/merge/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/language/dist/index.js',
  'https://deno.land/x/codemirror_esm@v6.0.1/esm/theme-one-dark/dist/index.js',
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
function shouldBypass(url, request) {
  if (request.method !== 'GET') return true;
  if (request.headers.get('range')) return true;

  if (url.origin !== self.location.origin) {
    if (!CDN_HOSTS.has(url.hostname)) return true;
  }

  if (url.pathname.startsWith('/api/')) return true;

  // Firebase messaging internals — the dedicated FCM SW handles these.
  if (url.pathname.startsWith('/firebase-cloud-messaging-push-scope/')) return true;
  if (url.pathname === '/firebase-messaging-sw.js') return true;
  if (url.pathname.endsWith('/firebase-messaging-sw.js')) return true;
  if (url.pathname.includes('/__/firebase/')) return true;

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

    let bulkOk = false;
    try {
      const sameOrigin = CACHED_FILES.filter(f => f.startsWith('/'));
      await cache.addAll(sameOrigin);
      bulkOk = true;
    } catch (err) {
      console.warn('[Folio SW] bulk addAll failed, falling back to per-file', err);
    }

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

    // Only broadcast if this is a genuine update (there's an old SW controlling at least one client).
    // On the very first install, no client is controlled — skip the broadcast.
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length > 0) {
        let hasControlledClient = false;
        for (const c of clients) {
          try {
            // If the client has a controller, it's controlled by an OLDER SW → genuine update
            if ('controller' in c && c.controller) { hasControlledClient = true; break; }
          } catch {}
        }
        // Fall back: if we can't determine, broadcast anyway (safer than missing an update)
        if (hasControlledClient || clients.length > 0) {
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
  let cached =
    await caches.match(req, { ignoreSearch: true }) ||
    await caches.match('/') ||
    await caches.match('/index.html');

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

  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return offlinePage(req);
  return new Response('', { status: 404, statusText: 'Offline' });
}

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
  const withFrom = req ? offlineUrlFor(req) : '/offline.html';
  const cachedWithFrom = await caches.match(withFrom, { ignoreSearch: true });
  if (cachedWithFrom) return cachedWithFrom;

  const cachedPlain = await caches.match('/offline.html');
  if (cachedPlain) return cachedPlain;

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

    case 'GET_NOTIFICATION_STATE':
      event.waitUntil((async () => {
        let permission = 'default';
        try {
          if (typeof Notification !== 'undefined') permission = Notification.permission;
        } catch {}
        event.ports?.[0]?.postMessage({
          permission,
          version: CACHE_VERSION,
        });
      })());
      break;

    case 'CLOSE_NOTIFICATION':
      event.waitUntil((async () => {
        try {
          const tag = data.tag || data.notificationId;
          if (!tag) { event.ports?.[0]?.postMessage({ ok: false }); return; }
          const notifs = await self.registration.getNotifications({ tag });
          notifs.forEach(n => n.close());
          event.ports?.[0]?.postMessage({ ok: true, closed: notifs.length });
        } catch {
          event.ports?.[0]?.postMessage({ ok: false });
        }
      })());
      break;

    case 'LIST_ACTIVE_NOTIFICATIONS':
      event.waitUntil((async () => {
        try {
          const notifs = await self.registration.getNotifications();
          const list = notifs.map(n => ({
            title: n.title,
            body: n.body,
            tag: n.tag,
            data: n.data || {},
          }));
          event.ports?.[0]?.postMessage({ notifications: list });
        } catch {
          event.ports?.[0]?.postMessage({ notifications: [] });
        }
      })());
      break;

    case 'TEST_NOTIFICATION':
      event.waitUntil((async () => {
        try {
          await self.registration.showNotification('Folio test', {
            body: 'This is a test notification from the service worker.',
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-144.png',
            tag: 'folio-test-' + Date.now(),
            data: { url: '/notifications', notificationId: 'test', type: 'system' },
          });
          event.ports?.[0]?.postMessage({ ok: true });
        } catch (err) {
          event.ports?.[0]?.postMessage({ ok: false, error: err.message });
        }
      })());
      break;
  }
});

// ═══════════════════════════════════════════════════════════
// Push — FCM data messages (Web Push path is kept as fallback)
// ═══════════════════════════════════════════════════════════

function normalizePushPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      title: 'Folio', body: '', icon: '/icons/icon-192.png',
      badge: '/icons/icon-144.png', image: undefined, tag: undefined,
      link: '/notifications', notificationId: '', type: 'system', user_id: '', extra: '',
    };
  }

  const inner = (raw.data && typeof raw.data === 'object') ? raw.data : {};

  return {
    title:          raw.title   || inner.title   || 'Folio',
    body:           raw.body    || inner.body    || '',
    icon:           raw.icon    || inner.icon    || '/icons/icon-192.png',
    badge:          raw.badge   || inner.badge   || '/icons/icon-144.png',
    image:          raw.image   || inner.image   || undefined,
    tag:            raw.tag     || inner.tag     || inner.notificationId || 'folio',
    link:           inner.link  || raw.link      || '/notifications',
    notificationId: inner.notificationId || raw.notificationId || '',
    type:           inner.type  || raw.type      || 'system',
    user_id:        inner.user_id || raw.user_id || '',
    extra:          inner.extra || raw.extra     || '',
  };
}

self.addEventListener('push', (event) => {
  let payload = null;

  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    try { payload = { body: event.data ? event.data.text() : '' }; } catch {}
  }

  if (!payload) {
    payload = { title: 'Folio', body: 'You have a new notification.' };
  }

  const n = normalizePushPayload(payload);

  const options = {
    body: n.body,
    icon: n.icon,
    badge: n.badge,
    image: n.image,
    tag: n.tag,
    renotify: false,
    requireInteraction: false,
    data: {
      url: n.link,
      link: n.link,
      notificationId: n.notificationId,
      type: n.type,
      user_id: n.user_id,
      extra: n.extra,
    },
  };

  event.waitUntil((async () => {
    try {
      await self.registration.showNotification(n.title, options);
    } catch (err) {
      console.warn('[Folio SW] showNotification failed:', err);
    }

    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(c => c.postMessage({
        type: 'PUSH_RECEIVED',
        notificationId: n.notificationId,
        notificationType: n.type,
      }));
    } catch {}
  })());
});

// ═══════════════════════════════════════════════════════════
// Notification click — focus existing tab or open new
// ═══════════════════════════════════════════════════════════
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const target = data.url || data.link || '/notifications';

  event.waitUntil((async () => {
    let absoluteUrl;
    try {
      absoluteUrl = new URL(target, self.location.origin).toString();
    } catch {
      absoluteUrl = self.location.origin + '/notifications';
    }
    const targetPath = new URL(absoluteUrl).pathname + new URL(absoluteUrl).search;

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // First pass: exact path match
    for (const c of clients) {
      try {
        const cUrl = new URL(c.url);
        if (cUrl.pathname + cUrl.search === targetPath) {
          await c.focus();
          c.postMessage({
            type: 'NOTIFICATION_CLICKED',
            notificationId: data.notificationId || '',
            url: absoluteUrl,
          });
          return;
        }
      } catch {}
    }

    // Second pass: any Folio tab open → navigate it
    for (const c of clients) {
      try {
        const cUrl = new URL(c.url);
        if (cUrl.origin === self.location.origin) {
          await c.focus();
          try { c.postMessage({ type: 'NOTIFICATION_CLICKED', notificationId: data.notificationId || '', url: absoluteUrl }); } catch {}
          if ('navigate' in c) {
            try { await c.navigate(absoluteUrl); return; } catch {}
          }
          break;
        }
      } catch {}
    }

    await self.clients.openWindow(absoluteUrl);
  })());
});

// ═══════════════════════════════════════════════════════════
// Notification close — analytics hook
// ═══════════════════════════════════════════════════════════
self.addEventListener('notificationclose', (event) => {
  try {
    const data = event.notification.data || {};
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      clients.forEach(c => c.postMessage({
        type: 'NOTIFICATION_CLOSED',
        notificationId: data.notificationId || '',
      }));
    });
  } catch {}
});

// ═══════════════════════════════════════════════════════════
// Push subscription change — Web Push fallback only.
// FCM handles token rotation in firebase-messaging-sw.js.
// ═══════════════════════════════════════════════════════════
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const oldSub = event.oldSubscription;
      const newSub = event.newSubscription || (oldSub
        ? await self.registration.pushManager.subscribe(oldSub.options)
        : null);

      if (!newSub) return;

      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(c => c.postMessage({
        type: 'PUSH_SUBSCRIPTION_CHANGED',
        subscription: newSub.toJSON(),
      }));
    } catch (err) {
      console.warn('[Folio SW] pushsubscriptionchange failed:', err);
    }
  })());
});

self.addEventListener('messageerror', () => {});

console.log(`[Folio SW] loaded ${CACHE_VERSION}`);