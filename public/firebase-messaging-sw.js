// firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

// REPLACE with your actual Firebase config
firebase.initializeApp({
  apiKey: "YOUR_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
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