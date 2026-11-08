'use strict';

// ============================================================
// FOLIO — PRODUCTION SERVICE WORKER
// Offline-first application shell, navigation, assets and FCM
// ============================================================

const CACHE_VERSION = '2026-11-08-1';
const CACHE_NAME = `folio-shell-${CACHE_VERSION}`;

const CACHE_BUILT_AT = Date.now();

const NAVIGATION_TIMEOUT = 5000;

// ============================================================
// LIVE-SITE DETECTION
// ============================================================
//
// Live sites are user-published sites served from Folio but rendered
// as standalone pages in a normal browser tab. They must NEVER be
// intercepted by the PWA service worker, otherwise the SW's app-shell
// scope swallows them and they render inside the installed app window.
//
// URL shape: /:username/project/:projectname[/...]
//
// This matches:
//   /alice/project/my-site
//   /alice/project/my-site/
//   /alice/project/my-site/about.html
//   /alice/project/my-site/css/style.css?from=db_xyz
//   /alice/project/my-site?v=abc
//
// It intentionally does NOT match:
//   /alice                       (profile — stays in PWA)
//   /alice/my-site               (details page — stays in PWA)
//   /alice/project               (would be a 2-segment URL, no slug)
//
// It also catches the ?from= historic-preview query on ANY path so
// deployment snapshots are always fetched fresh from the server.

const LIVE_SITE_PATH_RE = /^\/[^/]+\/project\/[^/]+(\/|$)/;

function isLiveSiteRequest(url) {
  try {
    if (url.origin !== self.location.origin) return false;
    if (LIVE_SITE_PATH_RE.test(url.pathname)) return true;
    if (url.searchParams.has('from')) return true;
    return false;
  } catch {
    return false;
  }
}

// ============================================================
// ALLOWED EXTERNAL HOSTS
// ============================================================

const CDN_HOSTS = new Set([
  'deno.land',
  'esm.sh',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com'
]);

// ============================================================
// PRE-CACHE FILES
// ============================================================

const CACHED_FILES = [

  // ---------------- HTML PAGES ----------------

  '/',
  '/index.html',

  '/settings',
  '/settings.html',

  '/projects',
  '/projects.html',

  '/tools',
  '/tools.html',

  '/profile',
  '/profile.html',

  '/register',
  '/register.html',

  '/project',
  '/project.html',

  '/analytics',
  '/analytics.html',

  '/offline',
  '/offline.html',

  '/invite',
  '/invite.html',

  '/notifications',
  '/notifications.html',

  '/ai',
  '/ai.html',

  // ---------------- CSS ----------------

  '/css/app.css',
  '/css/project.css',
  '/css/ai.css',

  // ---------------- PWA ----------------

  '/manifest.json',

  // ---------------- ICONS ----------------

  '/icons/icon-144.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/notif.png',

  // ---------------- SCREENSHOTS ----------------

  '/screenshots/screenshot1.png',
  '/screenshots/screenshot2.png',
  '/screenshots/screenshot3.png',
  '/screenshots/screenshot4.png',
  '/screenshots/screenshot5.png',
  '/screenshots/screenshot6.png',

  // ---------------- SCRIPTS ----------------

  '/install.js',
  '/update.js',
  '/fcm-client.js',
  '/notifications.js',
  '/js/ai.js',
  '/js/create-project.js',

  // ---------------- CODEMIRROR ----------------

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

  'https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-python/dist/index.js'

];

// ============================================================
// BYPASS RULES
// ============================================================

function shouldBypass(url, request) {

  if (request.method !== 'GET') return true;

  if (request.headers.get('range')) return true;

  if (url.protocol === 'chrome-extension:') return true;

  // Live sites and historic previews: never intercept. The browser
  // handles them as a normal top-level navigation and, if opened from
  // a link inside the installed PWA on mobile, gets handed off to the
  // browser's default handler by the platform.
  if (isLiveSiteRequest(url)) return true;

  // External hosts must be explicitly allowed.
  if (url.origin !== self.location.origin) {
    if (!CDN_HOSTS.has(url.hostname)) return true;
  }

  // API requests are not cached.
  if (url.pathname.startsWith('/api/')) return true;

  // Firebase messaging internals.
  if (
    url.pathname.startsWith('/firebase-cloud-messaging-push-scope/') ||
    url.pathname === '/firebase-messaging-sw.js' ||
    url.pathname.endsWith('/firebase-messaging-sw.js') ||
    url.pathname.includes('/__/firebase/')
  ) {
    return true;
  }

  return false;
}

// ============================================================
// CONTENT TYPE VALIDATION
// ============================================================

function expectedContentTypesFor(url) {

  let path;

  try {
    path = new URL(url, self.location.origin).pathname;
  } catch {
    return null;
  }

  const match = path.match(/\.([a-z0-9]+)$/i);

  const ext = match ? match[1].toLowerCase() : '';

  if (ext === 'js') {
    return ['javascript', 'ecmascript'];
  }

  if (ext === 'css') {
    return ['text/css'];
  }

  if (ext === 'json' || ext === 'webmanifest') {
    return ['json', 'manifest'];
  }

  if (ext === 'png') {
    return ['image/png'];
  }

  if (ext === 'jpg' || ext === 'jpeg') {
    return ['image/jpeg'];
  }

  if (ext === 'webp') {
    return ['image/webp'];
  }

  if (ext === 'svg') {
    return ['image/svg+xml'];
  }

  if (ext === 'ico') {
    return ['image/x-icon', 'image/vnd.microsoft.icon'];
  }

  if (ext === 'html') {
    return ['text/html'];
  }

  if (ext === 'txt') {
    return ['text/plain'];
  }

  if (ext === 'xml') {
    return ['xml'];
  }

  // Clean URLs are expected to return HTML.
  if (!ext) {
    return ['text/html'];
  }

  return null;
}

function contentTypeOk(url, response) {

  const expected = expectedContentTypesFor(url);

  if (!expected) return true;

  const actual = (
    response.headers.get('content-type') || ''
  ).toLowerCase();

  return expected.some(type => actual.includes(type));
}

// ============================================================
// CACHE HELPERS
// ============================================================

async function getAppCache() {
  return caches.open(CACHE_NAME);
}

async function putInCache(cache, request, response) {

  if (!response || !response.ok) return false;

  if (response.type === 'opaque') return false;

  if (!contentTypeOk(request.url || request, response)) {
    console.warn(
      '[Folio SW] Invalid content type:',
      request.url || request
    );

    return false;
  }

  try {
    await cache.put(request, response.clone());
    return true;
  } catch (err) {
    console.warn(
      '[Folio SW] Cache write failed:',
      request.url || request,
      err
    );

    return false;
  }
}

// ============================================================
// INSTALL
// ============================================================

self.addEventListener('install', event => {

  console.log(
    `[Folio SW] Installing version ${CACHE_VERSION}`
  );

  event.waitUntil((async () => {

    const cache = await getAppCache();

    let successful = 0;
    let failed = 0;

    await Promise.allSettled(

      CACHED_FILES.map(async path => {

        try {

          // Do not download something already cached.
          const existing = await cache.match(path);

          if (existing) {
            successful++;
            return;
          }

          const response = await fetch(path, {
            cache: 'no-store',
            credentials: 'same-origin'
          });

          if (!response.ok) {
            failed++;

            console.warn(
              '[Folio SW] Pre-cache HTTP failure:',
              path,
              response.status
            );

            return;
          }

          if (response.type === 'opaque') {
            failed++;
            return;
          }

          if (!contentTypeOk(path, response)) {

            failed++;

            console.warn(
              '[Folio SW] Pre-cache content type mismatch:',
              path,
              response.headers.get('content-type')
            );

            return;
          }

          await cache.put(path, response);

          successful++;

        } catch (err) {

          failed++;

          console.warn(
            '[Folio SW] Pre-cache failed:',
            path,
            err.message
          );

        }

      })

    );

    console.log('[Folio SW] Installation completed', {
      version: CACHE_VERSION,
      successful,
      failed,
      total: CACHED_FILES.length
    });

    // Intentionally retain the waiting update lifecycle.
    // update.js can send SKIP_WAITING when the user approves.

  })());

});

// ============================================================
// ACTIVATE
// ============================================================

self.addEventListener('activate', event => {

  console.log(
    `[Folio SW] Activating ${CACHE_VERSION}`
  );

  event.waitUntil((async () => {

    const keys = await caches.keys();

    // Only remove old Folio caches.
    // Never delete unrelated caches on the same origin.

    await Promise.all(

      keys
        .filter(key =>
          key.startsWith('folio-shell-') &&
          key !== CACHE_NAME
        )
        .map(key => caches.delete(key))

    );

    // Claim existing pages.
    await self.clients.claim();

    // Notify open application windows.
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    clients.forEach(client => {

      try {

        client.postMessage({
          type: 'SW_ACTIVATED',
          version: CACHE_VERSION,
          builtAt: CACHE_BUILT_AT,
          timestamp: Date.now()
        });

      } catch {}

    });

    console.log('[Folio SW] Activated successfully');

  })());

});

// ============================================================
// FETCH HANDLER
// ============================================================

self.addEventListener('fetch', event => {

  const request = event.request;

  let url;

  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (shouldBypass(url, request)) return;

  const isNavigation =
    request.mode === 'navigate' ||
    (
      request.headers.get('accept') || ''
    ).includes('text/html');

  // ---------------- NAVIGATION ----------------

  if (isNavigation) {

    event.respondWith(
      networkFirstNavigation(request)
    );

    return;
  }

  // ---------------- STATIC ASSETS ----------------

  const updatePromise = updateAssetCache(request);

  // Register background update immediately.
  event.waitUntil(
    updatePromise.catch(() => {})
  );

  event.respondWith(
    serveAsset(request, updatePromise)
  );

});

// ============================================================
// NAVIGATION URL NORMALIZATION
// ============================================================

function getNavigationCandidates(request) {

  const url = new URL(request.url);

  let path = url.pathname;

  if (path.length > 1) {
    path = path.replace(/\/+$/, '');
  }

  const candidates = [path];

  if (path !== '/') {

    candidates.push(path + '/');

    // Clean URL -> HTML file.
    if (!/\.[a-z0-9]+$/i.test(path)) {

      candidates.push(
        path + '.html'
      );

    }

    // HTML file -> clean URL.
    if (path.endsWith('.html')) {

      candidates.push(
        path.replace(/\.html$/i, '')
      );

    }

  } else {

    candidates.push('/index.html');

  }

  return [...new Set(candidates)];
}

// ============================================================
// FIND CACHED NAVIGATION
// ============================================================

async function findCachedNavigation(request) {

  const candidates = getNavigationCandidates(request);

  const cache = await getAppCache();

  for (const candidate of candidates) {

    const cached = await cache.match(candidate, {
      ignoreSearch: true
    });

    if (cached) {
      console.log(
        '[Folio SW] Navigation cache hit:',
        candidate
      );

      return cached;
    }

  }

  // Last resort: search other existing caches.
  // This can help during cache migrations.

  for (const candidate of candidates) {

    const cached = await caches.match(candidate, {
      ignoreSearch: true
    });

    if (cached) {
      return cached;
    }

  }

  return null;
}

// ============================================================
// NETWORK REQUEST WITH TIMEOUT
// ============================================================

async function fetchNavigation(request) {

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, NAVIGATION_TIMEOUT);

  try {

    return await fetch(request, {
      signal: controller.signal
    });

  } finally {

    clearTimeout(timer);

  }

}

// ============================================================
// NETWORK-FIRST NAVIGATION
// ============================================================

async function networkFirstNavigation(request) {

  try {

    const response = await fetchNavigation(request);

    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();

    // Handle server errors without unnecessarily replacing
    // a previously cached working page.

    if (response.status >= 500) {

      const cached = await findCachedNavigation(request);

      if (cached) return cached;

      return response;
    }

    // Only successful HTML responses should be cached.
    if (
      response.ok &&
      contentType.includes('text/html') &&
      response.type !== 'opaque'
    ) {

      const cache = await getAppCache();

      const url = new URL(request.url);

      // Store the actual navigation URL, including its
      // pathname and search parameters.

      const cacheKey = url.origin === self.location.origin
        ? request
        : request.url;

      await putInCache(
        cache,
        cacheKey,
        response
      );

    }

    return response;

  } catch (err) {

    console.warn(
      '[Folio SW] Navigation network unavailable:',
      request.url,
      err.message
    );

    // First try the requested page.
    const cached = await findCachedNavigation(request);

    if (cached) {
      return cached;
    }

    // Then show the custom offline page.
    return offlinePage(request);

  }

}

// ============================================================
// STATIC ASSET CACHE UPDATE
// STALE-WHILE-REVALIDATE
// ============================================================

function updateAssetCache(request) {

  return (async () => {

    try {

      const response = await fetch(request);

      if (!response || !response.ok) {
        return null;
      }

      const url = new URL(request.url);

      const allowed =
        url.origin === self.location.origin ||
        CDN_HOSTS.has(url.hostname);

      if (!allowed) return response;

      if (response.type === 'opaque') return response;

      if (!contentTypeOk(request.url, response)) {
        console.warn(
          '[Folio SW] Asset content type mismatch:',
          request.url
        );

        return response;
      }

      const cache = await getAppCache();

      await putInCache(
        cache,
        request,
        response
      );

      return response;

    } catch (err) {

      return null;

    }

  })();

}

// ============================================================
// SERVE STATIC ASSETS
// ============================================================

async function serveAsset(request, networkPromise) {

  const cache = await getAppCache();

  const cached = await cache.match(request, {
    ignoreSearch: true
  });

  // Cached asset is immediately available.
  if (cached) {
    return cached;
  }

  // First-time asset request.
  const networkResponse = await networkPromise;

  if (networkResponse) {
    return networkResponse;
  }

  // Offline fallback for missing JavaScript.
  const url = new URL(request.url);

  if (/\.m?js$/i.test(url.pathname)) {

    return new Response(
      '/* Folio offline: JavaScript asset unavailable */',
      {
        status: 504,
        statusText: 'Offline',
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      }
    );

  }

  // Offline fallback for missing CSS.
  if (/\.css$/i.test(url.pathname)) {

    return new Response(
      '/* Folio offline: stylesheet unavailable */',
      {
        status: 504,
        statusText: 'Offline',
        headers: {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      }
    );

  }

  // Offline fallback for other assets.
  return new Response('', {
    status: 504,
    statusText: 'Offline',
    headers: {
      'Cache-Control': 'no-store'
    }
  });

}

// ============================================================
// OFFLINE PAGE URL
// ============================================================

function offlineUrlFor(request) {

  try {

    const url = new URL(request.url);

    const from = url.pathname + url.search;

    return '/offline.html?from=' +
      encodeURIComponent(from);

  } catch {

    return '/offline.html';

  }

}

// ============================================================
// CUSTOM OFFLINE PAGE
// ============================================================

async function offlinePage(request) {

  // Prefer the actual cached offline page.
  const cache = await getAppCache();

  const cached = await cache.match('/offline.html');

  if (cached) {
    return cached;
  }

  // If offline.html itself wasn't cached, return an
  // embedded fallback so Chrome's offline screen is avoided.

  return new Response(

    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0c10">
<title>Offline — Folio</title>
<style>
:root {
  color-scheme: dark;
  font-family: Inter,system-ui,-apple-system,sans-serif;
}
* {
  box-sizing: border-box;
}
body {
  background: #0a0c10;
  color: #e8ecf1;
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
}
main {
  width: 100%;
  max-width: 360px;
}
.mark {
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  margin: 0 auto 24px;
  border-radius: 18px;
  background: rgba(245,158,11,.12);
  color: #F59E0B;
  font-size: 27px;
  font-weight: 800;
}
h1 {
  font-size: 23px;
  letter-spacing: -.7px;
  margin: 0 0 12px;
}
p {
  color: #a8b0bc;
  font-size: 14px;
  line-height: 1.7;
  margin: 0 auto 22px;
}
button {
  background: #F59E0B;
  color: #0a0c10;
  border: 0;
  padding: 12px 22px;
  border-radius: 10px;
  font-weight: 750;
  font-size: 14px;
  cursor: pointer;
}
a {
  display: inline-block;
  margin-top: 22px;
  color: #F59E0B;
  font-size: 13px;
  text-decoration: none;
  font-weight: 650;
}
.small {
  font-size: 11px;
  color: #626b78;
  margin-top: 26px;
}
</style>
</head>
<body>
<main>
  <div class="mark">F</div>
  <h1>You're offline</h1>
  <p>
    Folio can't reach the internet right now.
    Your locally saved projects are still available
    whenever their application pages have been cached.
  </p>
  <button onclick="location.reload()">Try again</button>
  <br>
  <a href="/">Return to Folio</a>
  <p class="small">Folio · Code in your pocket</p>
</main>
</body>
</html>`,

    {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    }

  );

}

// ============================================================
// MESSAGE BUS
// ============================================================

self.addEventListener('message', event => {

  const data = event.data;

  if (!data) return;

  const type = typeof data === 'string'
    ? data
    : (data.type || data.action);

  switch (type) {

    // ---------------- UPDATE CONTROL ----------------

    case 'SKIP_WAITING':
    case 'skipWaiting':

      self.skipWaiting();

      break;

    // ---------------- VERSION ----------------

    case 'GET_VERSION':

      event.ports?.[0]?.postMessage({
        version: CACHE_VERSION,
        cache: CACHE_NAME,
        builtAt: CACHE_BUILT_AT
      });

      break;

    // ---------------- CLEAR CACHE ----------------

    case 'CLEAR_CACHE':

      event.waitUntil(

        caches.keys()

          .then(keys => Promise.all(

            keys
              .filter(key => key.startsWith('folio-shell-'))
              .map(key => caches.delete(key))

          ))

          .then(() => {
            event.ports?.[0]?.postMessage({
              ok: true
            });
          })

          .catch(() => {
            event.ports?.[0]?.postMessage({
              ok: false
            });
          })

      );

      break;

    // ---------------- CHECK SYNC QUEUE ----------------

    case 'CHECK_QUEUE':

      event.waitUntil((async () => {

        let count = 0;

        try {

          const request = indexedDB.open('folio', 3);

          const connection = await new Promise(
            (resolve, reject) => {

              request.onsuccess = () =>
                resolve(request.result);

              request.onerror = () =>
                reject(request.error);

              request.onblocked = () =>
                reject(new Error('IDB blocked'));

            }
          );

          try {

            if (
              connection.objectStoreNames.contains('syncQueue')
            ) {

              const all = await new Promise(resolve => {

                try {

                  const transaction =
                    connection.transaction(
                      'syncQueue',
                      'readonly'
                    );

                  const result = transaction
                    .objectStore('syncQueue')
                    .getAll();

                  result.onsuccess = () =>
                    resolve(result.result || []);

                  result.onerror = () =>
                    resolve([]);

                } catch {

                  resolve([]);

                }

              });

              count = all.length;

            }

          } finally {

            try {
              connection.close();
            } catch {}

          }

        } catch (err) {

          console.warn(
            '[Folio SW] CHECK_QUEUE failed:',
            err.message
          );

        }

        event.ports?.[0]?.postMessage({
          count
        });

      })());

      break;

    // ---------------- NOTIFICATION STATE ----------------

    case 'GET_NOTIFICATION_STATE':

      event.waitUntil((async () => {

        let permission = 'default';

        try {

          if (typeof Notification !== 'undefined') {
            permission = Notification.permission;
          }

        } catch {}

        event.ports?.[0]?.postMessage({
          permission,
          version: CACHE_VERSION
        });

      })());

      break;

    // ---------------- CLOSE NOTIFICATION ----------------

    case 'CLOSE_NOTIFICATION':

      event.waitUntil((async () => {

        try {

          const tag =
            data.tag || data.notificationId;

          if (!tag) {

            event.ports?.[0]?.postMessage({
              ok: false
            });

            return;
          }

          const notifications =
            await self.registration.getNotifications({
              tag
            });

          notifications.forEach(notification => {
            notification.close();
          });

          event.ports?.[0]?.postMessage({
            ok: true,
            closed: notifications.length
          });

        } catch {

          event.ports?.[0]?.postMessage({
            ok: false
          });

        }

      })());

      break;

    // ---------------- LIST NOTIFICATIONS ----------------

    case 'LIST_ACTIVE_NOTIFICATIONS':

      event.waitUntil((async () => {

        try {

          const notifications =
            await self.registration.getNotifications();

          const list = notifications.map(notification => ({
            title: notification.title,
            body: notification.body,
            tag: notification.tag,
            data: notification.data || {}
          }));

          event.ports?.[0]?.postMessage({
            notifications: list
          });

        } catch {

          event.ports?.[0]?.postMessage({
            notifications: []
          });

        }

      })());

      break;

    // ---------------- TEST NOTIFICATION ----------------

    case 'TEST_NOTIFICATION':

      event.waitUntil((async () => {

        try {

          await self.registration.showNotification(
            'Folio test',
            {
              body: 'This is a test notification from the service worker.',
              icon: '/icons/notif.png',
              badge: '/icons/icon-144.png',
              tag: 'folio-test-' + Date.now(),
              data: {
                url: '/notifications',
                notificationId: 'test',
                type: 'system'
              }
            }
          );

          event.ports?.[0]?.postMessage({
            ok: true
          });

        } catch (err) {

          event.ports?.[0]?.postMessage({
            ok: false,
            error: err.message
          });

        }

      })());

      break;

  }

});

// ============================================================
// PUSH PAYLOAD NORMALIZATION
// ============================================================

function normalizePushPayload(raw) {

  if (!raw || typeof raw !== 'object') {

    return {
      title: 'Folio',
      body: '',
      icon: '/icons/notif.png',
      badge: '/icons/icon-144.png',
      image: undefined,
      tag: undefined,
      link: '/notifications',
      notificationId: '',
      type: 'system',
      user_id: '',
      extra: ''
    };

  }

  const inner =
    raw.data && typeof raw.data === 'object'
      ? raw.data
      : {};

  return {

    title:
      raw.title ||
      inner.title ||
      'Folio',

    body:
      raw.body ||
      inner.body ||
      '',

    icon:
      raw.icon ||
      inner.icon ||
      '/icons/notif.png',

    badge:
      raw.badge ||
      inner.badge ||
      '/icons/icon-144.png',

    image:
      raw.image ||
      inner.image ||
      undefined,

    tag:
      raw.tag ||
      inner.tag ||
      inner.notificationId ||
      'folio',

    link:
      inner.link ||
      raw.link ||
      '/notifications',

    notificationId:
      inner.notificationId ||
      raw.notificationId ||
      '',

    type:
      inner.type ||
      raw.type ||
      'system',

    user_id:
      inner.user_id ||
      raw.user_id ||
      '',

    extra:
      inner.extra ||
      raw.extra ||
      ''

  };

}

// ============================================================
// PUSH EVENT — FCM DATA MESSAGES
// ============================================================

self.addEventListener('push', event => {

  let payload = null;

  try {

    payload = event.data
      ? event.data.json()
      : null;

  } catch {

    try {

      payload = {
        body: event.data
          ? event.data.text()
          : ''
      };

    } catch {}

  }

  if (!payload) {

    payload = {
      title: 'Folio',
      body: 'You have a new notification.'
    };

  }

  const notification = normalizePushPayload(payload);

  const options = {

    body: notification.body,

    icon: notification.icon,

    badge: notification.badge,

    image: notification.image,

    tag: notification.tag,

    renotify: false,

    requireInteraction: false,

    data: {

      url: notification.link,

      link: notification.link,

      notificationId: notification.notificationId,

      type: notification.type,

      user_id: notification.user_id,

      extra: notification.extra

    }

  };

  event.waitUntil((async () => {

    try {

      await self.registration.showNotification(
        notification.title,
        options
      );

    } catch (err) {

      console.warn(
        '[Folio SW] showNotification failed:',
        err
      );

    }

    try {

      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      });

      clients.forEach(client => {

        client.postMessage({

          type: 'PUSH_RECEIVED',

          notificationId: notification.notificationId,

          notificationType: notification.type

        });

      });

    } catch {}

  })());

});

// ============================================================
// NOTIFICATION CLICK
// ============================================================

self.addEventListener('notificationclick', event => {

  event.notification.close();

  const data = event.notification.data || {};

  const target =
    data.url ||
    data.link ||
    '/notifications';

  event.waitUntil((async () => {

    let absoluteUrl;

    try {

      absoluteUrl = new URL(
        target,
        self.location.origin
      ).toString();

    } catch {

      absoluteUrl =
        self.location.origin + '/notifications';

    }

    const parsedTarget = new URL(absoluteUrl);

    // Never navigate to an external origin from an
    // untrusted notification payload.
    if (parsedTarget.origin !== self.location.origin) {
      absoluteUrl = self.location.origin + '/notifications';
    }

    const finalTarget = new URL(absoluteUrl);

    // If the notification points at a live site, hand it off to the
    // browser instead of navigating an existing PWA window. Live sites
    // are independent pages, not part of the app shell.
    if (isLiveSiteRequest(finalTarget)) {
      await self.clients.openWindow(absoluteUrl);
      return;
    }

    const targetPath =
      finalTarget.pathname + finalTarget.search;

    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    // Focus an exact matching page.
    for (const client of clients) {

      try {

        const clientUrl = new URL(client.url);

        if (
          clientUrl.origin === self.location.origin &&
          clientUrl.pathname + clientUrl.search === targetPath
        ) {

          await client.focus();

          client.postMessage({

            type: 'NOTIFICATION_CLICKED',

            notificationId: data.notificationId || '',

            url: absoluteUrl

          });

          return;

        }

      } catch {}

    }

    // Otherwise reuse an existing Folio window.
    for (const client of clients) {

      try {

        const clientUrl = new URL(client.url);

        if (clientUrl.origin === self.location.origin) {

          await client.focus();

          try {

            client.postMessage({

              type: 'NOTIFICATION_CLICKED',

              notificationId: data.notificationId || '',

              url: absoluteUrl

            });

          } catch {}

          if ('navigate' in client) {

            try {

              await client.navigate(absoluteUrl);

              return;

            } catch {}

          }

          break;

        }

      } catch {}

    }

    // No existing Folio window.
    await self.clients.openWindow(absoluteUrl);

  })());

});

// ============================================================
// NOTIFICATION CLOSE
// ============================================================

self.addEventListener('notificationclose', event => {

  try {

    const data = event.notification.data || {};

    self.clients.matchAll({

      type: 'window',

      includeUncontrolled: true

    }).then(clients => {

      clients.forEach(client => {

        client.postMessage({

          type: 'NOTIFICATION_CLOSED',

          notificationId: data.notificationId || ''

        });

      });

    });

  } catch {}

});

// ============================================================
// PUSH SUBSCRIPTION CHANGE
// ============================================================

self.addEventListener('pushsubscriptionchange', event => {

  event.waitUntil((async () => {

    try {

      const oldSubscription = event.oldSubscription;

      const newSubscription =
        event.newSubscription ||
        (
          oldSubscription
            ? await self.registration.pushManager.subscribe(
                oldSubscription.options
              )
            : null
        );

      if (!newSubscription) return;

      const clients = await self.clients.matchAll({

        type: 'window',

        includeUncontrolled: true

      });

      await Promise.allSettled(

        clients.map(client => {

          try {

            client.postMessage({

              type: 'PUSH_SUBSCRIPTION_CHANGED',

              subscription: newSubscription.toJSON()

            });

          } catch {}

        })

      );

    } catch (err) {

      console.warn(
        '[Folio SW] pushsubscriptionchange failed:',
        err
      );

    }

  })());

});

// ============================================================
// MESSAGE ERROR
// ============================================================

self.addEventListener('messageerror', () => {

  console.warn('[Folio SW] Message serialization error');

});

// ============================================================
// STARTUP
// ============================================================

console.log(
  `[Folio SW] Loaded ${CACHE_VERSION}`
);
