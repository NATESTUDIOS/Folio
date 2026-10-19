/* ============================================================
   Folio — fcm-client.js
   Firebase Cloud Messaging (FCM) subscription manager.

   Public API (window.FOLIO.fcm):
     await subscribe({ deviceId? })  → { token, deviceKey, kind }
     await unsubscribe({ deviceId? })
     isSupported()                   → boolean (synchronous capability check)
     isSubscribed()                  → Promise<boolean>
     getPermission()                 → 'default' | 'granted' | 'denied' | 'unsupported'
     waitReady(timeoutMs?)           → Promise<boolean>  ← waits for SDK + SW
     ensureForegroundHandler()       → Promise<void>     ← wires onMessage

   Design:
     • Firebase SDK loads lazily on first subscribe()/waitReady()
     • All state is module-scoped — no external mutation after init
     • Cross-tab sync via a single BroadcastChannel
     • Foreground handler is idempotent (no double-wiring)
   ============================================================ */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════════════════════════

  const API = 'https://foliostudios.vercel.app/api/notify';
  const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.13.2';
  const FCM_SW_PATH = '/firebase-messaging-sw.js';

  // Firebase Web config (public identifiers, safe to ship)
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

  // Firebase FCM VAPID key (from Cloud Messaging → Web Push certificates)
  const FCM_VAPID_KEY = "BKKQ5QcfJljXJ4kcEjdcK1Rejl-M6Dq_K7SnfdF_GNtgK_DyfBfFfkvrBB69Qc8A2FcsTYUNcIgqknWeVS6GS4E";

  // ═══════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════

  let _app = null;
  let _messaging = null;
  let _mod = null;                 // { getToken, onMessage, deleteToken }
  let _loadPromise = null;         // in-flight SDK load
  let _foregroundUnsubscribe = null;
  let _broadcast = null;

  // ═══════════════════════════════════════════════════════════
  // SMALL UTILS
  // ═══════════════════════════════════════════════════════════

  function getSession() {
    try { return localStorage.getItem('folio.session') || ''; } catch { return ''; }
  }

  function toast(msg, type) {
    try {
      if (typeof window.toast === 'function') window.toast(msg, type || 'info', 3000);
      else console.log('[FCM]', msg);
    } catch {}
  }

  function getBC() {
    if (_broadcast) return _broadcast;
    try {
      if (typeof BroadcastChannel === 'function') {
        _broadcast = new BroadcastChannel('folio-fcm');
        _broadcast.addEventListener('message', onBroadcast);
      }
    } catch {}
    return _broadcast;
  }

  function onBroadcast(event) {
    const d = event.data || {};
    if (d.type === 'subscribed') {
      ensureForegroundHandler().catch(() => {});
    } else if (d.type === 'unsubscribed') {
      if (_foregroundUnsubscribe) {
        try { _foregroundUnsubscribe(); } catch {}
        _foregroundUnsubscribe = null;
      }
    }
  }

  function broadcast(payload) {
    try { getBC()?.postMessage(payload); } catch {}
  }

  // ═══════════════════════════════════════════════════════════
  // CAPABILITY / STATE
  // ═══════════════════════════════════════════════════════════

  function isSupported() {
    return (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  function getPermission() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  }

  async function isSubscribed() {
    if (!isSupported()) return false;
    if (Notification.permission !== 'granted') return false;
    try { return localStorage.getItem('folio.fcm.subscribed') === 'true'; } catch { return false; }
  }

  // ═══════════════════════════════════════════════════════════
  // LOAD FIREBASE SDK (lazy, idempotent)
  // ═══════════════════════════════════════════════════════════

  async function loadFirebase() {
    if (_mod) return _mod;
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async () => {
      const [appMod, msgMod] = await Promise.all([
        import(`${FIREBASE_SDK}/firebase-app.js`),
        import(`${FIREBASE_SDK}/firebase-messaging.js`),
      ]);

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
    })();

    try {
      return await _loadPromise;
    } catch (err) {
      _loadPromise = null;
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // WAIT READY — API for pages that need FCM before acting
  // ═══════════════════════════════════════════════════════════

  /**
   * Resolves true once:
   *   • the FCM SDK is loaded
   *   • /firebase-messaging-sw.js is registered (or can be registered)
   *
   * If the SW isn't registered yet, waits up to timeoutMs for it.
   * Idempotent: safe to call many times; the SDK load is cached.
   */
  async function waitReady(timeoutMs = 8000) {
    if (!isSupported()) return false;

    const start = Date.now();
    const remaining = () => Math.max(0, timeoutMs - (Date.now() - start));

    try {
      // Kick off the SDK load and the SW wait in parallel.
      // We don't fail the whole thing if SW registration is missing —
      // subscribe() will register on demand — but we do try to load the SDK.
      const loadP = loadFirebase().then(() => true).catch(() => false);
      const swP = ensureFCMServiceWorker(remaining()).catch(() => false);

      const [sdkReady] = await Promise.all([loadP, swP]);
      return sdkReady;
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // FCM SERVICE WORKER
  // ═══════════════════════════════════════════════════════════

  async function ensureFCMServiceWorker(timeoutMs = 10000) {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service workers not supported');
    }

    const start = Date.now();

    // 1. Already registered + active?
    let reg = await navigator.serviceWorker.getRegistration(FCM_SW_PATH);
    if (reg && reg.active) return reg;

    // 2. Not registered → register now (was missing before!)
    if (!reg) {
      try {
        reg = await navigator.serviceWorker.register(FCM_SW_PATH, { scope: '/' });
      } catch (err) {
        throw new Error(`Could not register ${FCM_SW_PATH}: ${err.message || err}`);
      }
    }

    // 3. Wait for it to become active
    while (Date.now() - start < timeoutMs) {
      const r = await navigator.serviceWorker.getRegistration(FCM_SW_PATH);
      if (r && r.active) return r;
      if (r && (r.installing || r.waiting)) {
        const sw = r.installing || r.waiting;
        await new Promise((resolve) => {
          const done = () => {
            sw.removeEventListener('statechange', onChange);
            resolve();
          };
          const onChange = () => {
            if (sw.state === 'activated' || sw.state === 'redundant') done();
          };
          sw.addEventListener('statechange', onChange);
          // Also resolve if state is already final
          if (sw.state === 'activated' || sw.state === 'redundant') done();
        });
        const r2 = await navigator.serviceWorker.getRegistration(FCM_SW_PATH);
        if (r2 && r2.active) return r2;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    throw new Error('FCM service worker did not activate in time');
  }

  // ═══════════════════════════════════════════════════════════
  // FOREGROUND HANDLER
  // ═══════════════════════════════════════════════════════════

  async function ensureForegroundHandler() {
    if (_foregroundUnsubscribe) return;
    if (!isSupported()) return;

    const mod = await loadFirebase();
    if (_foregroundUnsubscribe) return; // double-check after await

    try {
      _foregroundUnsubscribe = mod.onMessage(_messaging, (payload) => {
        console.log('[FCM] Foreground message:', payload);

        const data = payload.data || {};
        const title = data.title || 'Folio';
        const body = data.body || '';
        const link = data.link || '/notifications';

        toast(body || title, 'info');

        // Show a system notification when the tab is visible
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
            navigator.serviceWorker.ready
              .then((reg) => reg.showNotification(title, opts))
              .catch(() => {});
          } catch {}
        }

        try {
          window.dispatchEvent(new CustomEvent('folio:fcm:message', { detail: payload }));
        } catch {}
      });
    } catch (err) {
      console.warn('[FCM] onMessage setup failed:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SUBSCRIBE
  // ═══════════════════════════════════════════════════════════

  async function subscribe({ deviceId } = {}) {
    if (!isSupported()) {
      throw new Error('Push notifications are not supported in this browser');
    }

    const session = getSession();
    if (!session) {
      throw new Error('Sign in first to enable notifications');
    }

    // 1. Permission (must come from a user gesture)
    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      throw new Error(`Notification permission ${permission}`);
    }

    // 2. Load SDK
    const mod = await loadFirebase();

    // 3. Ensure FCM SW is registered and active
    const swReg = await ensureFCMServiceWorker();

    // 4. Get the token
    let token;
    try {
      token = await mod.getToken(_messaging, {
        vapidKey: FCM_VAPID_KEY,
        serviceWorkerRegistration: swReg,
      });
    } catch (err) {
      const code = err?.code || '';
      if (code === 'messaging/permission-blocked') {
        throw new Error('Notifications are blocked. Enable them in browser settings.');
      }
      if (code === 'messaging/failed-service-worker-registration') {
        throw new Error('Service worker registration failed. Try reloading.');
      }
      if (code === 'messaging/token-subscribe-failed') {
        throw new Error('FCM rejected the subscription. Check the VAPID key.');
      }
      throw new Error(err?.message || 'Could not get FCM token');
    }

    if (!token) {
      throw new Error('No FCM token returned — check your VAPID key and Firebase config');
    }

    // 5. Upload to server
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

    // 6. Foreground handler
    await ensureForegroundHandler();

    // 7. Remember locally + broadcast to other tabs
    try { localStorage.setItem('folio.fcm.subscribed', 'true'); } catch {}
    broadcast({ type: 'subscribed' });

    return {
      token,
      deviceKey: json.deviceKey || null,
      kind: json.kind || 'fcm',
    };
  }

  // ═══════════════════════════════════════════════════════════
  // UNSUBSCRIBE
  // ═══════════════════════════════════════════════════════════

  async function unsubscribe({ deviceId } = {}) {
    const session = getSession();

    // 1. Delete the local FCM token
    if (_mod && _messaging) {
      try { await _mod.deleteToken(_messaging); }
      catch (err) { console.warn('[FCM] deleteToken failed:', err); }
    }

    // 2. Tell the server
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

    // 3. Local cleanup
    try { localStorage.removeItem('folio.fcm.subscribed'); } catch {}
    if (_foregroundUnsubscribe) {
      try { _foregroundUnsubscribe(); } catch {}
      _foregroundUnsubscribe = null;
    }
    broadcast({ type: 'unsubscribed' });

    return serverResult || { success: true };
  }

  // ═══════════════════════════════════════════════════════════
  // AUTO-SETUP ON LOAD
  // ═══════════════════════════════════════════════════════════

  // If the user previously subscribed and permission is still granted,
  // wire the foreground handler so messages show up while the tab is open.
  (async function autoSetup() {
    if (!isSupported()) return;
    if (Notification.permission !== 'granted') return;
    try {
      const subscribed = localStorage.getItem('folio.fcm.subscribed') === 'true';
      if (!subscribed) return;
      await ensureForegroundHandler();
      getBC(); // listen for cross-tab events
    } catch {
      // Silent — foreground is nice-to-have
    }
  })();

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  window.FOLIO = window.FOLIO || {};
  window.FOLIO.fcm = {
    subscribe,
    unsubscribe,
    isSupported,
    isSubscribed,
    getPermission,
    waitReady,
    ensureForegroundHandler,
    // Debug helpers
    _state: () => ({ app: !!_app, messaging: !!_messaging, mod: !!_mod }),
  };
})();