// firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

// REPLACE with your actual Firebase config
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

// Handle background messages
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Background message:', payload);

  // Your server sends data-only messages, so build the notification here
  const title = payload.data?.title || 'Folio';
  const options = {
    body: payload.data?.body || '',
    icon: payload.data?.icon || '/icons/icon-192.png',
    badge: '/icons/icon-144.png',
    tag: payload.data?.notificationId || 'folio-fcm',
    data: {
      url: payload.data?.link || '/',
      notificationId: payload.data?.notificationId || '',
      type: payload.data?.type || 'system'
    }
  };

  self.registration.showNotification(title, options);
});

// Handle notification clicks (same logic as your main sw.js)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(target) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});