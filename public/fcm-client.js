// fcm-client.js
(function() {
  'use strict';

  const API = 'https://foliostudios.vercel.app/api/notify';
  let messaging = null;

  // ── Firebase Web config (from Firebase Console → your Web app) ──
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

  // ── Firebase FCM VAPID key (from Cloud Messaging → Web Push certificates) ──
  const FCM_VAPID_KEY = "BKKQ5QcfJljXJ4kcEjdcK1Rejl-M6Dq_K7SnfdF_GNtgK_DyfBfFfkvrBB69Qc8A2FcsTYUNcIgqknWeVS6GS4E";

  async function init() {
    if (!('serviceWorker' in navigator) || !('Notification' in window)) {
      throw new Error('FCM not supported in this browser');
    }

    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js');
    const { getMessaging, getToken, onMessage } = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging.js');

    const app = initializeApp(firebaseConfig);
    messaging = getMessaging(app);

    onMessage(messaging, (payload) => {
      console.log('[FCM] Foreground message:', payload);
      if (window.toast) {
        window.toast(payload.data?.body || 'New notification', 'info');
      }
    });

    return { getToken, onMessage };
  }

  async function subscribe() {
    if (!messaging) await init();

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(`Permission ${permission}`);

    const { getToken } = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging.js');
    const token = await getToken(messaging, { vapidKey: FCM_VAPID_KEY });
    if (!token) throw new Error('No FCM token available');

    const res = await fetch(`${API}?action=subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('folio.session') || ''}`
      },
      body: JSON.stringify({ token, deviceId: null })
    });

    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'subscribe failed');
    return { token, deviceKey: json.deviceKey };
  }

  async function unsubscribe() {
    const res = await fetch(`${API}?action=unsubscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('folio.session') || ''}`
      },
      body: JSON.stringify({ deviceId: null })
    });
    return res.json();
  }

  window.FOLIO = window.FOLIO || {};
  window.FOLIO.fcm = { init, subscribe, unsubscribe };
})();