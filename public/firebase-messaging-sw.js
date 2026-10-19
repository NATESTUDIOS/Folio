// firebase-messaging-sw.js
/* ============================================================
   Folio — Firebase Messaging Service Worker

   Handles FCM background messages (when the tab is closed or
   in the background). This SW coexists with /sw.js — FCM
   routes pushes here, Web Push routes to /sw.js.
   ============================================================ */

importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

// ── Firebase Web config ─────────────────────────────────────
// Safe to ship — these are public identifiers, not secrets.
firebase.initializeApp({
  apiKey: "AIzaSyAShz6D0T-XTu77E-rAqSXw-znRO9gMfMk",
  authDomain: "schollet-e41e7.firebaseapp.com",
  databaseURL: "https://schollet-e41e7-default-rtdb.firebaseio.com",
  projectId: "schollet-e41e7",
  storageBucket: "schollet-e41e7.firebasestorage.app",
  messagingSenderId: "987039879980",
  appId: "1:987039879980:web:39a6b26e8474760e10d289",
  measurementId: "G-DCRKHR0ZW0"
});

const messaging = firebase.messaging();

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
    link:           d.link || '/notifications',   // default → notifications page
    notificationId: d.notificationId || '',
    type:           d.type || 'system',
    userId:         d.user_id || '',
    extra:          d.extra || '',
  };
}

// ═══════════════════════════════════════════════════════════
// Background message handler
// ═══════════════════════════════════════════════════════════
messaging.onBackgroundMessage((payload) => {
  console.log('[FCM SW] Background message:', payload);

  const n = normalizeFcmPayload(payload);

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
      user_id: n.userId,
      extra: n.extra,
    },
  };

  return self.registration.showNotification(n.title, options);
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

    const targetPath = new URL(absoluteUrl).pathname + new URL(absoluteUrl).search;
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    // If a tab is already on the target path, focus it
    for (const client of windowClients) {
      try {
        const cUrl = new URL(client.url);
        if (cUrl.pathname + cUrl.search === targetPath) {
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

    // Otherwise, if any tab is open, navigate it to the target
    if (windowClients.length > 0) {
      const client = windowClients[0];
      try {
        await client.focus();
        if ('navigate' in client) {
          await client.navigate(absoluteUrl);
        } else {
          await self.clients.openWindow(absoluteUrl);
        }
        return;
      } catch {}
    }

    // Fallback: open a new window
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
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
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
// Message bus — for manual testing / debugging
// ═══════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;
  const type = typeof data === 'string' ? data : (data.type || data.action);

  // Dev helper: trigger a local test notification
  if (type === 'TEST_FCM_NOTIFICATION') {
    event.waitUntil((async () => {
      try {
        await self.registration.showNotification('Folio FCM test', {
          body: 'This is a test from the FCM service worker.',
          icon: '/icons/notif.png',
          badge: '/icons/icon-144.png',
          tag: 'fcm-test-' + Date.now(),
          data: { url: '/notifications', notificationId: 'test', type: 'system' },
        });
        event.ports?.[0]?.postMessage({ ok: true });
      } catch (err) {
        event.ports?.[0]?.postMessage({ ok: false, error: err.message });
      }
    })());
  }
});

console.log('[FCM SW] loaded');