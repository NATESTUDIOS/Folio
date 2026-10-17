import admin from "firebase-admin";

const svc = JSON.parse(process.env.FIREBASE_SERVICE_KEY || "{}");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(svc),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
}

export const db = admin.database();
export const messaging = admin.messaging();
export const auth = admin.auth();
export const serverTimestamp = admin.database.ServerValue.TIMESTAMP;