// firebase-messaging-sw.js
/* ============================================================
   Folio — Firebase Messaging Service Worker

   Handles FCM background messages (when the tab is closed or
   in the background). This SW coexists with /sw.js — FCM
   routes pushes here, Web Push routes to /sw.js.

   Firebase SDK is SELF-HOSTED at /vendor/firebase/.
   No cross-origin fetches on SW boot. If the local files are
   missing, this worker still registers and continues to handle
   notificationclick / notificationclose / message events.

   Required files (served by your own origin):
     /vendor/firebase/firebase-app-compat.js
     /vendor/firebase/firebase-messaging-compat.js
   ============================================================ */

// ── Firebase SDK loading (self-hosted) ──────────────────────
//
// These are classic scripts, not ES modules. importScripts is
// synchronous and — importantly — a network failure here aborts
// SW script evaluation entirely. That is why the files MUST be
// on our own origin. Since they are, we can wrap the call in
// try/catch and still keep the worker alive on the (rare) case
// the files are missing from a deploy.

let firebaseLoaded = false;

try {
  importScripts(
    '/vendor/firebase/firebase-app-compat.js',
    '/vendor/firebase/firebase-messaging-compat.js'
  );
  firebaseLoaded = true;
  console.log('[FCM SW] Firebase SDK loaded from /vendor/firebase/');
} catch (err) {
  console.error(
    '[FCM SW] Failed to load self-hosted Firebase SDK:',
    err.message
  );
}

// ── Firebase initialization (guarded) ───────────────────────
let messaging = null;

if (firebaseLoaded && typeof firebase !== 'undefined') {
  try {
    firebase.initializeApp({
      apiKey: "AIzaSyAShz6D0T-XTu77E-rAqSXw-znRO9gMfMk",
      authDomain: "schollet-e41e7.firebaseapp.com",
      databaseURL: "https://schollet-e41e7-default-rtdb.firebaseio.com",
      projectId: "schollet-e41e7",
      storageBucket: "schollet-e41e7.firebasestorage.app",
      messagingSenderId: "987039879980",
      appId: "1:987039879980:web:39a6b26e8474760e10d289",
      measurementId: "G-DCRKHR0ZW0",
    });
    messaging = firebase.messaging();
    console.log('[FCM SW] Firebase initialized');
  } catch (err) {
    console.error('[FCM SW] Firebase initializeApp/messaging failed:', err);
    messaging = null;
  }
}

// Expose state for debugging (console: self.__FCM_STATE__)
self.__FCM_STATE__ = {
  firebaseLoaded,
  messagingReady: !!messaging,
  source: 'self-hosted',
  at: new Date().toISOString(),
};

// ═══════════════════════════════════════════════════════════
// Normalize payload — FCM stringifies data values
// ═══════════════════════════════════════════════════════════
function normalizeFcmPayload(payload) {
  const d = (payload && payload.data) || {};
  return {
    title:          d.title || 'Folio',
    body:           d.body || '',
    icon:           d.icon || '/icons/notif.png',
    badge:          d.badge || '/icons/icon-144.png',
    image:          d.image || undefined,
    tag:            d.tag || d.notificationId || 'folio',
    link:           d.link || '/notifications',
    notificationId: d.notificationId || '',
    type:           d.type || 'system',
    userId:         d.user_id || '',
    extra:          d.extra || '',
  };
}

// ═══════════════════════════════════════════════════════════
// Build notification options (shared between real and test)
// ═══════════════════════════════════════════════════════════
function buildNotificationOptions(n) {
  return {
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
      user_id: n.userId,
      extra: n.extra,
    },
  };
}

// ═══════════════════════════════════════════════════════════
// Native push handler — ALWAYS registered.
//
// FCM delivers its messages through the standard push protocol.
// The SDK's onBackgroundMessage is a convenience wrapper that
// duplicates this. Registering the native handler unconditionally
// guarantees notifications work regardless of Firebase state.
// We do NOT call onBackgroundMessage — this is the single code
// path for showing a notification, and it always runs.
// ═══════════════════════════════════════════════════════════
self.addEventListener('push', (event) => {
  let payload = null;

  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    try {
      payload = { body: event.data ? event.data.text() : '' };
    } catch {}
  }

  if (!payload) {
    payload = { title: 'Folio', body: 'You have a new notification.' };
  }

  const n = normalizeFcmPayload(payload);

  event.waitUntil(
    self.registration
      .showNotification(n.title, buildNotificationOptions(n))
      .catch((err) => {
        console.error('[FCM SW] showNotification failed:', err);
      })
  );
});

// ═══════════════════════════════════════════════════════════
// Notification click — focus existing tab or open a new one
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

    // Never navigate to a foreign origin.
    try {
      if (new URL(absoluteUrl).origin !== self.location.origin) {
        absoluteUrl = self.location.origin + '/notifications';
      }
    } catch {
      absoluteUrl = self.location.origin + '/notifications';
    }

    const parsed = new URL(absoluteUrl);
    const targetPath = parsed.pathname + parsed.search;

    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    // 1. Exact-path match — focus and message.
    for (const client of windowClients) {
      try {
        const cUrl = new URL(client.url);
        if (
          cUrl.origin === self.location.origin &&
          cUrl.pathname + cUrl.search === targetPath
        ) {
          await client.focus();
          client.postMessage({
            type: 'NOTIFICATION_CLICKED',
            notificationId: data.notificationId || '',
            url: absoluteUrl,
          });
          return;
        }
      } catch {}
    }

    // 2. Reuse an existing Folio window.
    for (const client of windowClients) {
      try {
        const cUrl = new URL(client.url);
        if (cUrl.origin === self.location.origin) {
          await client.focus();
          client.postMessage({
            type: 'NOTIFICATION_CLICKED',
            notificationId: data.notificationId || '',
            url: absoluteUrl,
          });
          if ('navigate' in client) {
            await client.navigate(absoluteUrl);
            return;
          }
          break;
        }
      } catch {}
    }

    // 3. Fallback: open a new window.
    if (self.clients.openWindow) {
      await self.clients.openWindow(absoluteUrl);
    }
  })());
});

// ═══════════════════════════════════════════════════════════
// Notification close — analytics hook
// ═══════════════════════════════════════════════════════════
self.addEventListener('notificationclose', (event) => {
  try {
    const data = event.notification.data || {};
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        clients.forEach((c) => {
          c.postMessage({
            type: 'NOTIFICATION_CLOSED',
            notificationId: data.notificationId || '',
          });
        });
      });
  } catch {}
});

// ═══════════════════════════════════════════════════════════
// Lifecycle — skip waiting + claim immediately
// ═══════════════════════════════════════════════════════════
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ═══════════════════════════════════════════════════════════
// Message bus — for manual testing / debugging
// ═══════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
  // Reject messages from foreign origins (postMessage from iframes).
  try {
    if (event.source && new URL(event.source.url).origin !== self.location.origin) {
      return;
    }
  } catch {}

  const data = event.data;
  if (!data) return;
  const type = typeof data === 'string' ? data : (data.type || data.action);

  if (type === 'TEST_FCM_NOTIFICATION') {
    event.waitUntil((async () => {
      try {
        const n = normalizeFcmPayload({ data: {} });
        await self.registration.showNotification('Folio FCM test', {
          body: 'This is a test from the FCM service worker.',
          icon: n.icon,
          badge: n.badge,
          tag: 'fcm-test-' + Date.now(),
          data: {
            url: '/notifications',
            link: '/notifications',
            notificationId: 'test',
            type: 'system',
          },
        });
        event.ports?.[0]?.postMessage({ ok: true });
      } catch (err) {
        event.ports?.[0]?.postMessage({ ok: false, error: err.message });
      }
    })());
  }

  if (type === 'GET_FCM_STATE') {
    event.ports?.[0]?.postMessage(self.__FCM_STATE__);
  }
});

console.log(
  `[FCM SW] loaded (firebaseLoaded=${firebaseLoaded}, messagingReady=${!!messaging})`
);