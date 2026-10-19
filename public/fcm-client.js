/* ============================================================
   Folio — fcm-client.js
   Firebase Cloud Messaging (FCM) subscription manager.

   This is the ONLY client-side push file. It handles:
     • Fetching/initializing the Firebase Web SDK
     • Requesting notification permission
     • Getting an FCM token via getToken()
     • Uploading the token to /api/notify?action=subscribe
     • Listening for foreground messages (onMessage)
     • Cleaning up on unsubscribe

   The dedicated FCM service worker (firebase-messaging-sw.js)
   handles background messages.

   Usage:
     FOLIO.fcm.subscribe()    // user gesture required
     FOLIO.fcm.unsubscribe()
     FOLIO.fcm.isSupported()
     FOLIO.fcm.getPermission()
   ============================================================ */
(function () {
  'use strict';

  const API = 'https://foliostudios.vercel.app/api/notify';
  const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.13.2';

  // ── Firebase Web config ──────────────────────────────────────
  // From Firebase Console → Project settings → Your apps → Web app
  // These values are safe to ship in client-side code (they are
  // public identifiers, not secrets).
  const firebaseConfig = {
    apiKey: "AIzaSyAShz6D0T-XTu77E-rAqSXw-znRO9gMfMk",
    authDomain: "schollet-e41e7.firebaseapp.com",
    databaseURL: "https://schollet-e41e7-default-rtdb.firebaseio.com",
    projectId: "schollet-e41e7",
    storageBucket: "schollet-e41e7.firebasestorage.app",
    messagingSenderId: "987039879980",
    appId: "1:987039879980:web:39a6b26e8474760e10d289",
    measurementId: "G-DCRKHR0ZW0"
  };

  // ── FCM VAPID key ───────────────────────────────────────────
  // From Firebase Console → Cloud Messaging → Web Push certificates
  // This is DIFFERENT from the web-push CLI key used for standard
  // Web Push. This one is tied to your Firebase project.
  const FCM_VAPID_KEY = "BKKQ5QcfJljXJ4kcEjdcK1Rejl-M6Dq_K7SnfdF_GNtgK_DyfBfFfkvrBB69Qc8A2FcsTYUNcIgqknWeVS6GS4E";

  // ── State ───────────────────────────────────────────────────
  let _app = null;
  let _messaging = null;
  let _mod = null;         // { getToken, onMessage, deleteToken }
  let _foregroundUnsubscribe = null;

  // ── Session helper ──────────────────────────────────────────
  function getSession() {
    try { return localStorage.getItem('folio.session') || ''; } catch { return ''; }
  }

  function toast(msg, type) {
    try {
      if (typeof window.toast === 'function') {
        window.toast(msg, type || 'info', 3000);
      } else {
        console.log('[FCM]', msg);
      }
    } catch {}
  }

  // ── Support check ───────────────────────────────────────────
  function isSupported() {
    return (
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  function getPermission() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  }

  // ── Load Firebase SDK (lazy, cached) ────────────────────────
  async function loadFirebase() {
    if (_mod) return _mod;

    const [appMod, msgMod] = await Promise.all([
      import(`${FIREBASE_SDK}/firebase-app.js`),
      import(`${FIREBASE_SDK}/firebase-messaging.js`),
    ]);

    // Initialize app only once
    if (!_app) {
      _app = appMod.initializeApp(firebaseConfig);
    }

    _messaging = msgMod.getMessaging(_app);
    _mod = {
      getToken: msgMod.getToken,
      onMessage: msgMod.onMessage,
      deleteToken: msgMod.deleteToken,
    };

    return _mod;
  }

  // ── Wait for the FCM service worker to be active ────────────
  async function waitForFCMServiceWorker(timeoutMs = 10000) {
    // navigator.serviceWorker.ready resolves when the *current page's*
    // controlling SW is active — but the FCM SW may not be the
    // controller. So we poll getRegistration for the specific path.
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const reg = await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js');
        if (reg && (reg.active || reg.installing || reg.waiting)) {
          if (reg.active) return reg;
          // Wait for it to become active
          await new Promise((resolve) => {
            const sw = reg.installing || reg.waiting;
            if (!sw) return resolve();
            sw.addEventListener('statechange', function onChange() {
              if (sw.state === 'activated' || sw.state === 'redundant') {
                sw.removeEventListener('statechange', onChange);
                resolve();
              }
            });
          });
          const reg2 = await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js');
          if (reg2 && reg2.active) return reg2;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('FCM service worker not ready — make sure /firebase-messaging-sw.js is registered');
  }

  // ── Foreground message handling ─────────────────────────────
  function setupForegroundHandler() {
    if (_foregroundUnsubscribe) return; // already listening

    if (!_mod || !_messaging) return;

    try {
      _foregroundUnsubscribe = _mod.onMessage(_messaging, (payload) => {
        console.log('[FCM] Foreground message:', payload);

        const data = payload.data || {};
        const title = data.title || 'Folio';
        const body = data.body || '';
        const link = data.link || '/';

        // Show a toast in the app
        toast(body || title, 'info');

        // Optionally, also show a system notification if the tab
        // is visible (FCM doesn't auto-show for foreground messages)
        if (document.visibilityState === 'visible') {
          try {
            const opts = {
              body,
              icon: '/icons/icon-192.png',
              badge: '/icons/icon-144.png',
              tag: data.notificationId || 'folio',
              data: {
                url: link,
                notificationId: data.notificationId || '',
                type: data.type || 'system',
              },
            };
            navigator.serviceWorker.ready.then((reg) => {
              reg.showNotification(title, opts);
            }).catch(() => {});
          } catch {}
        }

        // Dispatch a custom event so the app can refresh counts
        try {
          window.dispatchEvent(new CustomEvent('folio:fcm:message', { detail: payload }));
        } catch {}
      });
    } catch (err) {
      console.warn('[FCM] onMessage setup failed:', err);
    }
  }

  // ── Subscribe ───────────────────────────────────────────────
  async function subscribe({ deviceId } = {}) {
    if (!isSupported()) {
      throw new Error('Push notifications are not supported in this browser');
    }

    const session = getSession();
    if (!session) {
      throw new Error('Sign in first to enable notifications');
    }

    // 1. Permission must be granted from a user gesture
    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      throw new Error(`Notification permission ${permission}`);
    }

    // 2. Load Firebase SDK
    const mod = await loadFirebase();

    // 3. Ensure the FCM service worker is registered and active
    await waitForFCMServiceWorker();

    // 4. Get the FCM token
    let token;
    try {
      token = await mod.getToken(_messaging, {
        vapidKey: FCM_VAPID_KEY,
        serviceWorkerRegistration: await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js'),
      });
    } catch (err) {
      const code = err?.code || '';
      if (code === 'messaging/permission-blocked') {
        throw new Error('Notifications are blocked. Enable them in browser settings.');
      }
      if (code === 'messaging/failed-service-worker-registration') {
        throw new Error('Service worker registration failed. Try reloading.');
      }
      throw new Error(err?.message || 'Could not get FCM token');
    }

    if (!token) {
      throw new Error('No FCM token returned — check your VAPID key and Firebase config');
    }

    // 5. Upload token to server
    const res = await fetch(`${API}?action=subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session}`,
      },
      body: JSON.stringify({ token, deviceId: deviceId || null }),
    });

    let json = {};
    try { json = await res.json(); } catch {}

    if (!res.ok || !json.success) {
      throw new Error(json.error || `Subscribe failed (${res.status})`);
    }

    // 6. Set up foreground handler (only once)
    setupForegroundHandler();

    // 7. Remember that we're subscribed
    try { localStorage.setItem('folio.fcm.subscribed', 'true'); } catch {}

    return {
      token,
      deviceKey: json.deviceKey || null,
      kind: json.kind || 'fcm',
    };
  }

  // ── Unsubscribe ─────────────────────────────────────────────
  async function unsubscribe({ deviceId } = {}) {
    const session = getSession();

    // 1. Delete the FCM token locally
    if (_mod && _messaging) {
      try {
        await _mod.deleteToken(_messaging);
      } catch (err) {
        console.warn('[FCM] deleteToken failed:', err);
      }
    }

    // 2. Tell the server to remove this device's tokens
    let serverResult = null;
    if (session) {
      try {
        const res = await fetch(`${API}?action=unsubscribe`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session}`,
          },
          body: JSON.stringify({ deviceId: deviceId || null }),
        });
        try { serverResult = await res.json(); } catch {}
      } catch {}
    }

    // 3. Clean up local state
    try { localStorage.removeItem('folio.fcm.subscribed'); } catch {}
    if (_foregroundUnsubscribe) {
      try { _foregroundUnsubscribe(); } catch {}
      _foregroundUnsubscribe = null;
    }

    return serverResult || { success: true };
  }

  // ── Check if already subscribed ─────────────────────────────
  async function isSubscribed() {
    if (!isSupported()) return false;
    if (Notification.permission !== 'granted') return false;
    try { return localStorage.getItem('folio.fcm.subscribed') === 'true'; } catch { return false; }
  }

  // ── Auto-setup foreground listener on load ──────────────────
  // If the user has already granted permission and we have a
  // remembered subscription, wire up the foreground handler so
  // incoming messages while the tab is focused show a toast.
  (async function autoSetup() {
    if (!isSupported()) return;
    if (Notification.permission !== 'granted') return;
    try {
      const subscribed = localStorage.getItem('folio.fcm.subscribed') === 'true';
      if (!subscribed) return;
      await loadFirebase();
      setupForegroundHandler();
    } catch (err) {
      // Silent — foreground is nice-to-have
    }
  })();

  // ── Expose public API ───────────────────────────────────────
  window.FOLIO = window.FOLIO || {};
  window.FOLIO.fcm = {
    subscribe,
    unsubscribe,
    isSupported,
    isSubscribed,
    getPermission,
  };

  // ── Broadcast channel for cross-tab sync ────────────────────
  // If one tab subscribes, other tabs can re-enable their
  // foreground handler without re-subscribing.
  try {
    const bc = new BroadcastChannel('folio-fcm');
    bc.addEventListener('message', (event) => {
      const d = event.data || {};
      if (d.type === 'subscribed' || d.type === 'unsubscribed') {
        if (d.type === 'subscribed') {
          (async () => {
            try {
              await loadFirebase();
              setupForegroundHandler();
            } catch {}
          })();
        } else if (_foregroundUnsubscribe) {
          try { _foregroundUnsubscribe(); } catch {}
          _foregroundUnsubscribe = null;
        }
      }
    });
  } catch {}

  // Wrap subscribe/unsubscribe to broadcast to other tabs
  const _originalSubscribe = window.FOLIO.fcm.subscribe;
  const _originalUnsubscribe = window.FOLIO.fcm.unsubscribe;

  window.FOLIO.fcm.subscribe = async function (...args) {
    const result = await _originalSubscribe.apply(this, args);
    try { new BroadcastChannel('folio-fcm').postMessage({ type: 'subscribed' }); } catch {}
    return result;
  };

  window.FOLIO.fcm.unsubscribe = async function (...args) {
    const result = await _originalUnsubscribe.apply(this, args);
    try { new BroadcastChannel('folio-fcm').postMessage({ type: 'unsubscribed' }); } catch {}
    return result;
  };
})();