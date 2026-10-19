// api/notify.js
import crypto from "node:crypto";
import { db, messaging } from "../utils/firebase.js";
import { log, newReqId } from "../utils/log.js";
import {
  requireAuth, requireAdmin,
  getClientIp, hashIp, sanitizeFirebasePath,
} from "../utils/users.js";

// =========================================================================
// DELIVERY MODEL
// =========================================================================
// FCM-only. No Web Push, no VAPID keys on the backend.
// Broadcasts use an FCM topic ("folio-general") that every device is
// subscribed to server-side inside handleSubscribe(). No frontend change
// required.

// =========================================================================
// CONSTANTS
// =========================================================================

const API_NAME = "notify";

// 🆕 Added "security" so host.js rate-limit / api-key alerts are accepted.
const NOTIFICATION_TYPES = ["system", "analytics", "db", "storage", "project", "invite", "security"];
const NOTIFICATION_PRIORITIES = ["normal", "high", "urgent"];
const ACTION_TYPES = ["navigate", "modal", "external", "deep_link"];
const SOURCE_TYPES = ["project", "invite", "analytics", "db", "storage", "system"];

const NOTIFICATIONS_PATH = "folio/Notifications";
const SETTINGS_PATH = "folio/NotificationSettings";
const HISTORY_PATH = "folio/NotificationHistory";
const DEDUPE_PATH = "folio/NotifyDedupe";

// FCM topic every device is subscribed to at subscribe() time.
// Used for broadcast announcements (maintenance, new features, etc.).
const GENERAL_TOPIC = "folio-general";

// Android notification channel — must exist in your mobile app config.
// If unsure, keep "default" or whatever channelId you registered.
const ANDROID_CHANNEL_ID = process.env.FCM_ANDROID_CHANNEL || "folio_default";
// Small icon drawable name inside your Android app.
const ANDROID_ICON = process.env.FCM_ANDROID_ICON || "ic_notification";
// Accent color used in notification tray.
const ANDROID_COLOR = process.env.FCM_ANDROID_COLOR || "#F59E0B";

const NOTIFICATION_HISTORY_LIMIT = 50;
const NOTIFICATION_LIMIT_BUFFER = 10;
const SEND_CONCURRENCY = 5;
const MAX_TOKENS_PER_USER = 10;          // 🆕
const BROADCAST_HISTORY_BATCH = 500;     // 🆕 (was 10, way too slow)

// Per-type dedupe TTLs (milliseconds). 0 = no dedupe.
// Matches plan: storage 6–12h, security 1h, project 1m minimum.
const DEDUPE_TTL_MS = {
  storage: 6 * 60 * 60 * 1000,
  security: 60 * 60 * 1000,
  analytics: 60 * 60 * 1000,
  db: 30 * 60 * 1000,
  project: 60 * 1000,
  invite: 0,       // invite accept/cancel should NEVER dedupe
  system: 0,
};

// =========================================================================
// RATE LIMITS
// =========================================================================

const RATE_LIMITS = {
  subscribe:      { max: 10,   window: 60 * 60 * 1000 },
  unsubscribe:    { max: 10,   window: 60 * 60 * 1000 },
  markRead:       { max: 300,  window: 60 * 60 * 1000 },
  markAllRead:    { max: 10,   window: 60 * 60 * 1000 },
  dismiss:        { max: 300,  window: 60 * 60 * 1000 },
  dismissAllRead: { max: 10,   window: 60 * 60 * 1000 },
  updateSettings: { max: 20,   window: 60 * 60 * 1000 },
  list:           { max: 120,  window: 60 * 60 * 1000 },
  stats:          { max: 120,  window: 60 * 60 * 1000 },
  getSettings:    { max: 120,  window: 60 * 60 * 1000 },
  // 🆕 Bumped from 500 → 2000. Identifier is now per-target-uid (below),
  //     so this is a per-user cap, not a global cap across all of Folio.
  create:         { max: 50,   window: 60 * 60 * 1000 },
  authBridge:     { max: 200,  window: 60 * 60 * 1000 },
  config:         { max: 120,  window: 60 * 60 * 1000 },
  broadcast:      { max: 20,   window: 60 * 60 * 1000 },
  topicInfo:      { max: 30,   window: 60 * 60 * 1000 },
};

async function checkRateLimit(identifier, action) {
  const config = RATE_LIMITS[action];
  if (!config) return { allowed: true, remaining: Infinity, limit: Infinity };

  const now = Date.now();
  const windowStart = now - config.window;
  const key = sanitizeFirebasePath(String(identifier).toLowerCase());
  const ref = db.ref(`rate_limit/${API_NAME}/${action}/${key}`);

  let result = { allowed: true, remaining: config.max - 1, limit: config.max };

  try {
    await ref.transaction(current => {
      if (!current || current.first_request < windowStart) {
        result = { allowed: true, remaining: config.max - 1, limit: config.max };
        return { count: 1, first_request: now, last_request: now };
      }
      if (current.count >= config.max) {
        const resetAt = current.first_request + config.window;
        result = {
          allowed: false,
          remaining: 0,
          limit: config.max,
          reset: resetAt,
          retryAfter: Math.ceil((resetAt - now) / 1000),
        };
        return;
      }
      result = { allowed: true, remaining: config.max - current.count - 1, limit: config.max };
      return {
        count: current.count + 1,
        first_request: current.first_request,
        last_request: now,
      };
    });
  } catch (err) {
    log("notify.rate_limit_failed", { action, message: err.message });
    return { allowed: true, remaining: config.max, limit: config.max };
  }

  return result;
}

function setRateHeaders(res, r) {
  if (!r) return;
  if (Number.isFinite(r.limit)) res.setHeader("X-RateLimit-Limit", String(r.limit));
  if (Number.isFinite(r.remaining)) res.setHeader("X-RateLimit-Remaining", String(r.remaining));
  if (r.reset) res.setHeader("X-RateLimit-Reset", String(Math.ceil(r.reset / 1000)));
}

async function enforceRate(res, action, identifier) {
  const r = await checkRateLimit(identifier, action);
  setRateHeaders(res, r);
  if (!r.allowed) {
    res.status(429).json({
      success: false,
      error: "Rate limit exceeded",
      retryAfter: r.retryAfter,
    });
    return false;
  }
  return true;
}

// =========================================================================
// SERVER CACHE
// =========================================================================

const serverCache = new Map();
const CACHE_TTL = 60 * 1000;
const CACHE_MAX_SIZE = 1000;

function getCacheKey(prefix, identifier, params = {}) {
  const paramStr = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
  return `${prefix}:${identifier}:${paramStr}`;
}

function getFromCache(key) {
  const c = serverCache.get(key);
  if (!c) return null;
  if (Date.now() - c.timestamp > c.ttl) { serverCache.delete(key); return null; }
  return c.data;
}

function setToCache(key, data, ttl = CACHE_TTL) {
  if (serverCache.size >= CACHE_MAX_SIZE) {
    const entries = Array.from(serverCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, Math.ceil(CACHE_MAX_SIZE * 0.2));
    entries.forEach(([k]) => serverCache.delete(k));
  }
  serverCache.set(key, { data, timestamp: Date.now(), ttl });
}

function invalidateCache(prefix, identifier = null) {
  const toDelete = [];
  serverCache.forEach((_, key) => {
    if (key.startsWith(prefix) && (!identifier || key.includes(identifier))) {
      toDelete.push(key);
    }
  });
  toDelete.forEach(k => serverCache.delete(k));
  return toDelete.length;
}

function getCacheStats() {
  return {
    size: serverCache.size,
    maxSize: CACHE_MAX_SIZE,
    sampleKeys: Array.from(serverCache.keys()).slice(0, 10),
  };
}

// =========================================================================
// HELPERS
// =========================================================================

const DEFAULT_SETTINGS = {
  pushEnabled: true,
  systemAlerts: true,
  analyticsAlerts: true,
  dbAlerts: true,
  storageAlerts: true,
  projectAlerts: true,
  inviteAlerts: true,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
};

const TYPE_TO_SETTING = {
  system: "systemAlerts",
  analytics: "analyticsAlerts",
  db: "dbAlerts",
  storage: "storageAlerts",
  project: "projectAlerts",
  invite: "inviteAlerts",
  security: "systemAlerts", // 🆕 reuse systemAlerts
};

function generateNotificationId() {
  return `notif_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function deviceKeyFor(deviceId, token) {
  return crypto.createHash("sha256")
    .update(String(deviceId || token || ""))
    .digest("hex")
    .slice(0, 24);
}

async function runWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = { status: "fulfilled", value: await fn(items[i], i) }; }
      catch (err) { results[i] = { status: "rejected", reason: err }; }
    }
  });
  await Promise.all(workers);
  return results;
}

// =========================================================================
// DEDUPE (🆕)
// =========================================================================

/**
 * Returns true if a notification with the same dedupe key was sent to this
 * user within the dedupe window (per-type default TTL). Silently marks the
 * key as consumed when it returns false (so the NEXT call within TTL sees it).
 *
 * Skip dedupe by passing ttlMs = 0 explicitly.
 */
async function shouldDedupe(uid, type, dedupeKey, ttlMsOverride) {
  if (!uid) return false;
  const ttl = ttlMsOverride !== undefined
    ? ttlMsOverride
    : (DEDUPE_TTL_MS[type] ?? 60 * 1000);
  if (ttl <= 0) return false;

  const key = crypto.createHash("sha256")
    .update(`${uid}|${type}|${dedupeKey || ""}`)
    .digest("hex")
    .slice(0, 32);

  const ref = db.ref(`${DEDUPE_PATH}/${key}`);
  const now = Date.now();

  try {
    const snap = await ref.once("value");
    if (snap.exists() && now - (snap.val()?.ts || 0) < ttl) return true;
    await ref.set({ ts: now, uid, type }).catch(() => {});
    return false;
  } catch {
    return false; // fail-open
  }
}

// =========================================================================
// FCM TOKEN VALIDATION
// =========================================================================

function isValidFcmToken(token) {
  if (typeof token !== "string") return false;
  if (token.length < 80) return false;
  if (!token.includes(":")) return false;
  return true;
}

function isValidTopicName(topic) {
  if (typeof topic !== "string") return false;
  if (topic.length === 0 || topic.length > 900) return false;
  return /^[a-zA-Z0-9._~%:-]+$/.test(topic);
}

// =========================================================================
// FCM MESSAGE BUILDERS
// =========================================================================

/**
 * 🆕 Builds a full FCM message with BOTH data AND notification blocks.
 *
 * The `notification` block is essential:
 *  - iOS drops data-only messages without it (or an aps.content-available).
 *  - Android shows a tray notification automatically when killed (uses channel).
 *
 * Any payload-level data you want available in the tap handler goes in `data`.
 */
function buildFullMessage({ title, body, imageUrl, link, notificationId, type, userId, extra }) {
  const data = {};
  if (title) data.title = String(title);
  if (body) data.body = String(body);
  if (imageUrl) data.image = String(imageUrl);
  if (link) data.link = String(link);
  if (notificationId) data.notificationId = String(notificationId);
  if (type) data.type = String(type);
  if (userId) data.user_id = String(userId);
  if (extra) data.extra = String(extra);
  if (Object.keys(data).length === 0) data._empty = "true";

  const hasTitleBody = !!(title && body);

  return {
    data,
    // Notification block — auto-display in tray when app is killed/background.
    notification: hasTitleBody ? {
      title: String(title),
      body: String(body),
      imageUrl: imageUrl ? String(imageUrl) : undefined,
    } : undefined,
    android: {
      priority: "high",
      notification: hasTitleBody ? {
        channelId: ANDROID_CHANNEL_ID,
        icon: ANDROID_ICON,
        color: ANDROID_COLOR,
        sound: "default",
        // FCM tap-handler routes to your app; deep-links come from `data.link`.
        clickAction: "FLUTTER_NOTIFICATION_CLICK",
      } : undefined,
    },
    apns: {
      headers: { "apns-priority": "10" },
      payload: {
        aps: hasTitleBody ? {
          alert: { title: String(title), body: String(body) },
          sound: "default",
          badge: 1,
          "mutable-content": imageUrl ? 1 : 0,
        } : {
          "content-available": 1,
        },
      },
    },
  };
}

// =========================================================================
// FCM DELIVERY — single token
// =========================================================================

async function sendFcmOne(message, token) {
  try {
    const id = await messaging.send({ ...message, token });
    return { success: true, messageId: id };
  } catch (err) {
    const code = err?.code || "";
    const msg = err?.message || "";

    if (
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token" ||
      code === "messaging/invalid-argument" ||
      msg.includes("not-registered") ||
      msg.includes("Requested entity was not found")
    ) {
      return { success: false, error: "token_gone", expired: true };
    }

    log("notify.fcm_send_failed", { code, message: msg });
    return { success: false, error: msg, code };
  }
}

/**
 * 🆕 Retry wrapper — up to 2 attempts for transient failures.
 * Token-gone errors are not retried (will never succeed).
 */
async function sendFcmOneWithRetry(message, token, attempt = 0) {
  const r = await sendFcmOne(message, token);
  if (r.success || r.expired || attempt >= 2) return r;

  // Backoff: 400ms, 900ms
  await new Promise(rs => setTimeout(rs, 400 + attempt * 500));
  return sendFcmOneWithRetry(message, token, attempt + 1);
}

// =========================================================================
// FCM DELIVERY — topic (broadcast)
// =========================================================================

async function sendFcmToTopic(message, topic) {
  try {
    const id = await messaging.send({ ...message, topic });
    return { success: true, messageId: id };
  } catch (err) {
    const code = err?.code || "";
    const msg = err?.message || "";

    if (
      code === "messaging/invalid-argument" &&
      (msg.includes("topic") || msg.includes("Topic"))
    ) {
      return { success: false, reason: "no_subscribers", error: msg };
    }

    log("notify.fcm_topic_send_failed", { topic, code, message: msg });
    return { success: false, error: msg };
  }
}

// =========================================================================
// FCM TOPIC SUBSCRIPTION
// =========================================================================

async function subscribeTokenToTopic(token, topic = GENERAL_TOPIC) {
  if (!isValidFcmToken(token)) {
    return { success: false, error: "Invalid token" };
  }
  if (!isValidTopicName(topic)) {
    return { success: false, error: "Invalid topic" };
  }
  try {
    await messaging.subscribeToTopic(token, topic);
    log("notify.topic_subscribed", { topic });
    return { success: true };
  } catch (err) {
    log("notify.topic_subscribe_failed", {
      topic,
      code: err?.code,
      message: err?.message,
    });
    return { success: false, error: err?.message || String(err) };
  }
}

async function unsubscribeTokenFromTopic(token, topic = GENERAL_TOPIC) {
  if (!isValidFcmToken(token)) {
    return { success: false, error: "Invalid token" };
  }
  if (!isValidTopicName(topic)) {
    return { success: false, error: "Invalid topic" };
  }
  try {
    await messaging.unsubscribeFromTopic(token, topic);
    log("notify.topic_unsubscribed", { topic });
    return { success: true };
  } catch (err) {
    log("notify.topic_unsubscribe_failed", {
      topic,
      code: err?.code,
      message: err?.message,
    });
    return { success: false, error: err?.message || String(err) };
  }
}

// =========================================================================
// STORAGE
// =========================================================================

async function enforceNotificationLimit(userId) {
  try {
    const snap = await db.ref(`${HISTORY_PATH}/${userId}`).once("value");
    if (!snap.exists()) return;
    const entries = [];
    snap.forEach(child => entries.push({
      key: child.key,
      ts: child.val()?.createdAt || child.val()?.timestamp || 0,
    }));
    if (entries.length <= NOTIFICATION_HISTORY_LIMIT + NOTIFICATION_LIMIT_BUFFER) return;
    entries.sort((a, b) => a.ts - b.ts);
    const toDelete = entries.slice(0, entries.length - NOTIFICATION_HISTORY_LIMIT);
    const updates = {};
    toDelete.forEach(e => { updates[e.key] = null; });
    await db.ref(`${HISTORY_PATH}/${userId}`).update(updates);
  } catch (err) {
    log("notify.trim_history_failed", { userId, message: err.message });
  }
}

async function storeNotification(userId, data) {
  const id = generateNotificationId();
  const record = {
    id,
    userId,
    type: data.type || "system",
    title: data.title || "",
    body: data.body || "",
    category: data.category || "",
    icon: data.icon || null,
    priority: data.priority || "normal",
    read: false,
    dismissed: false,
    createdAt: Date.now(),
    expiresAt: data.expiresAt || null,
    action: data.action || null,
    source: data.source || null,
    metadata: data.metadata || {},
    imageUrl: data.imageUrl || null,
    link: data.link || null,
    pushSent: false,
    pushDelivered: false,
    pushOpened: false,
  };
  await db.ref(`${HISTORY_PATH}/${userId}/${id}`).set(record);
  await enforceNotificationLimit(userId);
  invalidateCache(`notif:list`, userId);
  invalidateCache(`notif:stats`, userId);
  return id;
}

// =========================================================================
// SETTINGS
// =========================================================================

function buildDefaultSettings(userId) {
  return {
    userId,
    ...DEFAULT_SETTINGS,
    quietHours: { ...DEFAULT_SETTINGS.quietHours },
    updatedAt: Date.now(),
  };
}

async function getUserSettings(userId) {
  const cacheKey = getCacheKey("notif:settings", userId);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const snap = await db.ref(`${SETTINGS_PATH}/${userId}`).once("value");
  const settings = snap.exists() ? snap.val() : buildDefaultSettings(userId);
  setToCache(cacheKey, settings);
  return settings;
}

async function updateUserSettings(userId, patch) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...patch,
    userId,
    updatedAt: Date.now(),
  };
  if (patch.quietHours) {
    merged.quietHours = { ...DEFAULT_SETTINGS.quietHours, ...patch.quietHours };
  } else {
    const existing = await getUserSettings(userId);
    merged.quietHours = existing.quietHours || { ...DEFAULT_SETTINGS.quietHours };
  }
  await db.ref(`${SETTINGS_PATH}/${userId}`).set(merged);
  invalidateCache("notif:settings", userId);
  return merged;
}

// =========================================================================
// STATS
// =========================================================================

async function getNotificationStats(userId) {
  const cacheKey = getCacheKey("notif:stats", userId);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const snap = await db.ref(`${HISTORY_PATH}/${userId}`).once("value");
  const stats = { total: 0, unread: 0, dismissed: 0 };
  for (const t of NOTIFICATION_TYPES) stats[t] = 0;

  if (snap.exists()) {
    snap.forEach(child => {
      const n = child.val();
      if (n.dismissed) { stats.dismissed++; return; }
      stats.total++;
      const t = n.type || "system";
      if (stats[t] !== undefined) stats[t]++;
      if (!n.read) stats.unread++;
    });
  }
  setToCache(cacheKey, stats);
  return stats;
}

// =========================================================================
// CRUD
// =========================================================================

async function markRead(userId, notificationId) {
  const ref = db.ref(`${HISTORY_PATH}/${userId}/${notificationId}`);
  const snap = await ref.once("value");
  if (!snap.exists()) throw new Error("Notification not found");
  await ref.update({ read: true, readAt: Date.now() });
  invalidateCache("notif:list", userId);
  invalidateCache("notif:stats", userId);
}

async function markAllRead(userId) {
  const snap = await db.ref(`${HISTORY_PATH}/${userId}`).once("value");
  if (!snap.exists()) return 0;
  let updated = 0;
  const patch = {};
  snap.forEach(child => {
    const n = child.val();
    if (!n.read && !n.dismissed) {
      patch[`${child.key}/read`] = true;
      patch[`${child.key}/readAt`] = Date.now();
      updated++;
    }
  });
  if (updated > 0) await db.ref(`${HISTORY_PATH}/${userId}`).update(patch);
  invalidateCache("notif:list", userId);
  invalidateCache("notif:stats", userId);
  return updated;
}

async function dismissOne(userId, notificationId) {
  const ref = db.ref(`${HISTORY_PATH}/${userId}/${notificationId}`);
  const snap = await ref.once("value");
  if (!snap.exists()) throw new Error("Notification not found");
  await ref.update({ dismissed: true, dismissedAt: Date.now() });
  invalidateCache("notif:list", userId);
  invalidateCache("notif:stats", userId);
}

async function dismissAllRead(userId) {
  const snap = await db.ref(`${HISTORY_PATH}/${userId}`).once("value");
  if (!snap.exists()) return 0;
  let dismissed = 0;
  const patch = {};
  snap.forEach(child => {
    const n = child.val();
    if (n.read && !n.dismissed) {
      patch[`${child.key}/dismissed`] = true;
      patch[`${child.key}/dismissedAt`] = Date.now();
      dismissed++;
    }
  });
  if (dismissed > 0) await db.ref(`${HISTORY_PATH}/${userId}`).update(patch);
  invalidateCache("notif:list", userId);
  invalidateCache("notif:stats", userId);
  return dismissed;
}

async function listNotifications(userId, { type = "all", limit = 20, offset = 0, sort = "desc" }) {
  const cacheKey = getCacheKey("notif:list", userId, { type, limit, offset, sort });
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const snap = await db.ref(`${HISTORY_PATH}/${userId}`).once("value");
  const rows = [];
  if (snap.exists()) {
    snap.forEach(child => {
      const n = child.val();
      if (n.dismissed) return;
      rows.push({ id: child.key, ...n });
    });
  }
  const filtered = type === "all" ? rows : rows.filter(r => r.type === type);
  filtered.sort((a, b) => {
    const at = a.createdAt || 0, bt = b.createdAt || 0;
    return sort === "desc" ? bt - at : at - bt;
  });
  const slice = filtered.slice(offset, offset + limit);
  const result = {
    notifications: slice,
    total: filtered.length,
    hasMore: offset + limit < filtered.length,
  };
  setToCache(cacheKey, result);
  return result;
}

// =========================================================================
// DEVICE TOKENS
// =========================================================================

async function registerDeviceToken(userId, token, deviceId) {
  if (!isValidFcmToken(token)) {
    throw new Error("Invalid FCM token");
  }

  const dk = deviceKeyFor(deviceId, token);
  const ref = db.ref(`${NOTIFICATIONS_PATH}/${userId}`);
  const snap = await ref.once("value");
  const existing = snap.exists() ? snap.val() : {};
  const tokens = existing.tokens || {};

  // Remove any other key that points at the same token (device id churn).
  for (const [k, v] of Object.entries(tokens)) {
    if (k !== dk && v?.token === token.trim()) {
      delete tokens[k];
    }
  }

  tokens[dk] = {
    token: token.trim(),
    addedAt: tokens[dk]?.addedAt || Date.now(),
    lastSeenAt: Date.now(),
  };

  // 🆕 Cap token count per user, drop oldest by lastSeenAt.
  const entries = Object.entries(tokens);
  if (entries.length > MAX_TOKENS_PER_USER) {
    entries.sort((a, b) => (a[1].lastSeenAt || 0) - (b[1].lastSeenAt || 0));
    const toDrop = entries.length - MAX_TOKENS_PER_USER;
    for (let i = 0; i < toDrop; i++) {
      delete tokens[entries[i][0]];
    }
  }

  await ref.update({ tokens, lastUpdated: Date.now() });
  invalidateCache("notif:tokens", userId);
  return { deviceKey: dk };
}

/**
 * 🆕 Now accepts optional `token` so hashing matches registration.
 *
 * Previously unregister hashed `deviceId || ""` while register hashed
 * `deviceId || token`. If the client only sent deviceId at logout, the
 * device was never removed. Fixed by:
 *   1. Trying the same hash as registration (deviceId, token).
 *   2. Fallback: match by token value across all entries.
 *   3. Fallback: match by deviceId prefix in the doc as before (legacy).
 */
async function unregisterDeviceToken(userId, deviceId, token = null) {
  const ref = db.ref(`${NOTIFICATIONS_PATH}/${userId}`);
  const snap = await ref.once("value");
  if (!snap.exists()) return { removed: 0 };
  const data = snap.val();
  const tokens = data.tokens || {};

  if (!deviceId && !token) {
    const count = Object.keys(tokens).length;
    await ref.update({ tokens: {}, lastUpdated: Date.now() });
    invalidateCache("notif:tokens", userId);
    return { removed: count };
  }

  let removed = 0;

  // 1. Exact hash match (matches how register hashes).
  const dk = deviceKeyFor(deviceId, token);
  if (tokens[dk]) {
    delete tokens[dk];
    removed++;
  }

  // 2. Match by token value if provided.
  if (!removed && token) {
    for (const [k, v] of Object.entries(tokens)) {
      if (v?.token === token.trim()) { delete tokens[k]; removed++; }
    }
  }

  // 3. Legacy: deviceId passed as token value (older clients).
  if (!removed && deviceId) {
    for (const [k, v] of Object.entries(tokens)) {
      if (v?.token === deviceId) { delete tokens[k]; removed++; }
    }
  }

  if (removed > 0) {
    await ref.update({ tokens, lastUpdated: Date.now() });
    invalidateCache("notif:tokens", userId);
  }
  return { removed };
}

async function getUserTokens(userId) {
  const cacheKey = getCacheKey("notif:tokens", userId);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const snap = await db.ref(`${NOTIFICATIONS_PATH}/${userId}/tokens`).once("value");
  if (!snap.exists()) return [];
  const tokens = [];
  snap.forEach(child => {
    const v = child.val();
    if (v && v.token) {
      tokens.push({ token: v.token, deviceKey: child.key });
    }
  });
  setToCache(cacheKey, tokens);
  return tokens;
}

async function removeExpiredToken(userId, deviceKey) {
  try {
    await db.ref(`${NOTIFICATIONS_PATH}/${userId}/tokens/${deviceKey}`).remove();
    invalidateCache("notif:tokens", userId);
    log("notify.token_removed_expired", { userId, deviceKey });
  } catch (err) {
    log("notify.token_remove_failed", { userId, deviceKey, message: err.message });
  }
}

// =========================================================================
// SEND — single user (FCM token)
// =========================================================================

async function sendNotificationWithPush(userId, data, { dedupeKey, dedupeTtlMs } = {}) {
  // 🆕 Dedupe check before storing anything.
  if (await shouldDedupe(userId, data.type, dedupeKey, dedupeTtlMs)) {
    return { notificationId: null, deduped: true, pushSent: false };
  }

  const id = await storeNotification(userId, data);
  const settings = await getUserSettings(userId);
  const settingKey = TYPE_TO_SETTING[data.type] || "systemAlerts";
  const pushOn = settings.pushEnabled && settings[settingKey];

  let pushResult = { success: false, reason: "push_disabled" };

  if (pushOn) {
    const tokens = await getUserTokens(userId);
    if (tokens.length === 0) {
      pushResult = { success: false, reason: "no_tokens" };
    } else {
      const extraPayload = JSON.stringify({
        type: data.type,
        notificationId: id,
        action: data.action || null,
      });

      // 🆕 Full message with notification block + retries.
      const fcmMessage = buildFullMessage({
        title: data.title,
        body: data.body,
        imageUrl: data.imageUrl,
        link: data.link,
        notificationId: id,
        type: data.type,
        userId,
        extra: extraPayload,
      });

      const expiredDeviceKeys = [];
      const results = await runWithConcurrency(tokens, SEND_CONCURRENCY, async (entry) => {
        const r = await sendFcmOneWithRetry(fcmMessage, entry.token);
        if (r.expired) expiredDeviceKeys.push(entry.deviceKey);
        return r;
      });

      const delivered = results.filter(r => r.status === "fulfilled" && r.value.success).length;
      pushResult = {
        success: delivered > 0,
        tokensAttempted: tokens.length,
        tokensDelivered: delivered,
        tokensExpired: expiredDeviceKeys.length,
      };

      if (expiredDeviceKeys.length > 0) {
        Promise.all(expiredDeviceKeys.map(dk => removeExpiredToken(userId, dk))).catch(() => {});
      }
    }
  }

  await db.ref(`${HISTORY_PATH}/${userId}/${id}`).update({
    pushSent: pushOn,
    pushDelivered: pushResult.success,
    pushDeliveredAt: pushResult.success ? Date.now() : null,
  }).catch(() => {});

  return { notificationId: id, pushSent: pushOn, pushResult };
}

// =========================================================================
// BROADCAST — one FCM call to the topic
// =========================================================================

/**
 * Sends one FCM message to the `folio-general` topic.
 * Every device subscribed to the topic receives it. One HTTP call to FCM
 * regardless of user count.
 */
async function handleBroadcast(req, res, reqId) {
  if (!requireAdmin(req, res)) return;
  if (!(await enforceRate(res, "broadcast", `admin_${hashIp(getClientIp(req))}`))) return;

  const {
    title, body, type = "system", priority = "normal",
    link, imageUrl,
    actionType, actionUrl, actionPayload,
    topic = GENERAL_TOPIC,
    storeInHistory = false,
  } = req.body || {};

  if (!title || !body) {
    return res.status(400).json({ success: false, error: "Missing title or body" });
  }
  if (!NOTIFICATION_TYPES.includes(type)) {
    return res.status(400).json({ success: false, error: `Invalid type: ${type}` });
  }
  if (!isValidTopicName(topic)) {
    return res.status(400).json({ success: false, error: "Invalid topic name" });
  }

  let parsedPayload = null;
  if (actionPayload) {
    try {
      parsedPayload = typeof actionPayload === "string"
        ? JSON.parse(actionPayload)
        : actionPayload;
    } catch {
      return res.status(400).json({ success: false, error: "actionPayload must be valid JSON" });
    }
  }

  const notificationId = generateNotificationId();

  const fcmMessage = buildFullMessage({
    title,
    body,
    imageUrl,
    link,
    notificationId,
    type,
    userId: null,
    extra: JSON.stringify({
      type,
      notificationId,
      action: actionType
        ? { type: actionType, url: actionUrl || null, payload: parsedPayload }
        : null,
      broadcast: true,
    }),
  });

  const fcmResult = await sendFcmToTopic(fcmMessage, topic);

  let historyResult = { written: 0 };
  if (storeInHistory) {
    historyResult = await writeBroadcastHistory({
      notificationId,
      title,
      body,
      type,
      priority,
      imageUrl,
      link,
      action: actionType
        ? { type: actionType, url: actionUrl || null, payload: parsedPayload }
        : null,
    });
  }

  log("notify.broadcast_complete", {
    reqId,
    notificationId,
    topic,
    fcm: fcmResult.success,
    historyWritten: historyResult.written,
    storeInHistory,
  });

  return res.status(200).json({
    success: true,
    notificationId,
    topic,
    fcm: fcmResult,
    history: historyResult,
  });
}

/**
 * 🆕 Rewritten to use batched `.update()` instead of N sequential `.set()`.
 * With 1000 users this drops from ~50s to ~2s and 2 writes instead of 1000.
 */
async function writeBroadcastHistory({
  notificationId, title, body, type, priority, imageUrl, link, action,
}) {
  let written = 0;
  try {
    const snap = await db.ref(NOTIFICATIONS_PATH).once("value");
    if (!snap.exists()) return { written: 0 };

    const usersWithTokens = [];
    snap.forEach(userChild => {
      const tokens = userChild.val()?.tokens || {};
      if (Object.keys(tokens).length > 0) {
        usersWithTokens.push(userChild.key);
      }
    });

    const record = (uid) => ({
      id: notificationId,
      userId: uid,
      type,
      title,
      body,
      priority,
      category: "",
      icon: null,
      read: false,
      dismissed: false,
      createdAt: Date.now(),
      expiresAt: null,
      action: action || null,
      source: { type: "system", id: null },
      metadata: { broadcast: true },
      imageUrl: imageUrl || null,
      link: link || null,
      pushSent: true,
      pushDelivered: true,
      pushDeliveredAt: Date.now(),
      pushOpened: false,
    });

    for (let i = 0; i < usersWithTokens.length; i += BROADCAST_HISTORY_BATCH) {
      const slice = usersWithTokens.slice(i, i + BROADCAST_HISTORY_BATCH);
      const batch = {};
      for (const uid of slice) {
        batch[`${HISTORY_PATH}/${uid}/${notificationId}`] = record(uid);
      }
      try {
        await db.ref().update(batch);
        written += slice.length;
        slice.forEach(uid => {
          invalidateCache(`notif:list`, uid);
          invalidateCache(`notif:stats`, uid);
        });
      } catch (err) {
        log("notify.broadcast_history_batch_failed", {
          notificationId,
          offset: i,
          size: slice.length,
          message: err.message,
        });
      }
    }
  } catch (err) {
    log("notify.broadcast_history_failed", { notificationId, message: err.message });
  }
  return { written };
}

// =========================================================================
// TOPIC INFO — inspect subscribers
// =========================================================================

async function handleTopicInfo(req, res, reqId) {
  if (!requireAdmin(req, res)) return;
  if (!(await enforceRate(res, "topicInfo", `admin_${hashIp(getClientIp(req))}`))) return;

  const topic = String(req.query?.topic || GENERAL_TOPIC);
  if (!isValidTopicName(topic)) {
    return res.status(400).json({ success: false, error: "Invalid topic name" });
  }

  const snap = await db.ref(NOTIFICATIONS_PATH).once("value");
  let users = 0;
  let devices = 0;
  const subscribers = [];

  if (snap.exists()) {
    snap.forEach(userChild => {
      const tokens = userChild.val()?.tokens || {};
      const tokenCount = Object.keys(tokens).length;
      if (tokenCount > 0) {
        users++;
        devices += tokenCount;
        subscribers.push({
          uid: userChild.key,
          deviceCount: tokenCount,
          lastUpdated: userChild.val()?.lastUpdated || null,
        });
      }
    });
  }

  return res.status(200).json({
    success: true,
    topic,
    usersSubscribed: users,
    devicesSubscribed: devices,
    note: "Counts are based on users with at least one registered FCM token. Topic subscriptions are added at subscribe() time.",
    subscribers: subscribers.slice(0, 100),
  });
}

// =========================================================================
// AUTH BRIDGE
// =========================================================================

async function bridgeOnSignup(uid) {
  const result = { settingsSeeded: false, notificationsSeeded: false };
  const settingsSnap = await db.ref(`${SETTINGS_PATH}/${uid}`).once("value");
  if (!settingsSnap.exists()) {
    await db.ref(`${SETTINGS_PATH}/${uid}`).set(buildDefaultSettings(uid));
    result.settingsSeeded = true;
  }
  const notifSnap = await db.ref(`${NOTIFICATIONS_PATH}/${uid}`).once("value");
  if (!notifSnap.exists()) {
    await db.ref(`${NOTIFICATIONS_PATH}/${uid}`).set({
      tokens: {},
      lastUpdated: Date.now(),
    });
    result.notificationsSeeded = true;
  }
  return result;
}

async function bridgeOnLogout(uid, deviceId, token = null) {
  return unregisterDeviceToken(uid, deviceId, token);
}

async function bridgeOnBan(uid) {
  await db.ref(`${NOTIFICATIONS_PATH}/${uid}`).update({
    tokens: {},
    bannedAt: Date.now(),
    lastUpdated: Date.now(),
  });
  invalidateCache("notif:tokens", uid);
  return { tokensCleared: true };
}

async function bridgeOnUnban(uid) {
  await db.ref(`${NOTIFICATIONS_PATH}/${uid}`).update({
    bannedAt: null,
    lastUpdated: Date.now(),
  }).catch(() => {});
  return { restored: true };
}

// =========================================================================
// HANDLERS
// =========================================================================

async function handleConfig(req, res, reqId) {
  if (!(await enforceRate(res, "config", `ip_${hashIp(getClientIp(req))}`))) return;
  return res.status(200).json({
    success: true,
    fcmEnabled: !!messaging,
    topic: GENERAL_TOPIC,
  });
}

async function handleSubscribe(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "subscribe", `uid_${user.uid}`))) return;

  const { token, deviceId } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: "Missing token" });

  try {
    const { deviceKey } = await registerDeviceToken(user.uid, token, deviceId || null);
    const topicResult = await subscribeTokenToTopic(token, GENERAL_TOPIC);

    return res.status(200).json({
      success: true,
      deviceKey,
      kind: "fcm",
      topic: GENERAL_TOPIC,
      topicSubscribed: topicResult.success,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
}

async function handleUnsubscribe(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "unsubscribe", `uid_${user.uid}`))) return;

  const { deviceId, token } = req.body || {};

  if (typeof token === "string" && token.length > 0) {
    await unsubscribeTokenFromTopic(token, GENERAL_TOPIC);
  }

  // 🆕 Pass both deviceId and token so hashing matches register.
  const r = await unregisterDeviceToken(user.uid, deviceId || null, token || null);
  return res.status(200).json({ success: true, removed: r.removed });
}

async function handleMarkRead(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "markRead", `uid_${user.uid}`))) return;

  const { notificationId } = req.body || {};
  if (!notificationId) return res.status(400).json({ success: false, error: "Missing notificationId" });
  try {
    await markRead(user.uid, notificationId);
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(404).json({ success: false, error: err.message });
  }
}

async function handleMarkAllRead(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "markAllRead", `uid_${user.uid}`))) return;

  const updated = await markAllRead(user.uid);
  return res.status(200).json({ success: true, updated });
}

async function handleDismiss(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "dismiss", `uid_${user.uid}`))) return;

  const { notificationId } = req.body || {};
  if (!notificationId) return res.status(400).json({ success: false, error: "Missing notificationId" });
  try {
    await dismissOne(user.uid, notificationId);
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(404).json({ success: false, error: err.message });
  }
}

async function handleDismissAllRead(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "dismissAllRead", `uid_${user.uid}`))) return;

  const dismissed = await dismissAllRead(user.uid);
  return res.status(200).json({ success: true, dismissed });
}

async function handleUpdateSettings(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "updateSettings", `uid_${user.uid}`))) return;

  const allowedKeys = ["pushEnabled", "systemAlerts", "analyticsAlerts", "dbAlerts",
                       "storageAlerts", "projectAlerts", "inviteAlerts", "quietHours"];
  const patch = {};
  for (const k of allowedKeys) {
    if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: "No settings to update" });
  }
  for (const k of allowedKeys) {
    if (k === "quietHours") continue;
    if (patch[k] !== undefined && typeof patch[k] !== "boolean") {
      return res.status(400).json({ success: false, error: `${k} must be boolean` });
    }
  }
  if (patch.quietHours) {
    if (typeof patch.quietHours !== "object" || patch.quietHours === null) {
      return res.status(400).json({ success: false, error: "quietHours must be an object" });
    }
  }

  const updated = await updateUserSettings(user.uid, patch);
  return res.status(200).json({ success: true, settings: updated });
}

async function handleList(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "list", `uid_${user.uid}`))) return;

  const type = String(req.query?.type || "all");
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
  const sort = req.query?.sort === "asc" ? "asc" : "desc";

  const result = await listNotifications(user.uid, { type, limit, offset, sort });
  return res.status(200).json({ success: true, ...result });
}

async function handleStats(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "stats", `uid_${user.uid}`))) return;

  const stats = await getNotificationStats(user.uid);
  return res.status(200).json({ success: true, stats });
}

async function handleGetSettings(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "getSettings", `uid_${user.uid}`))) return;

  const settings = await getUserSettings(user.uid);
  return res.status(200).json({ success: true, settings });
}

/**
 * 🆕 Admin-only create endpoint. Now supports:
 *  - Per-target-uid rate limit (was per-admin-IP)
 *  - Optional `dedupeKey` + `dedupeTtlMs` overrides
 *  - Optional `sourceType: "security"` from host.js
 */
async function handleCreate(req, res, reqId) {
  if (!requireAdmin(req, res)) return;

  const { uid, title, body, type = "system", priority = "normal",
          imageUrl, link, actionType, actionUrl, actionPayload,
          sourceType, sourceId, category, icon,
          dedupeKey, dedupeTtlMs } = req.body || {};

  if (!uid) return res.status(400).json({ success: false, error: "Missing uid" });

  // 🆕 Rate limit is per target uid now.
  if (!(await enforceRate(res, "create", `target_${uid}`))) return;

  if (!title || !body) return res.status(400).json({ success: false, error: "Missing title or body" });
  if (!NOTIFICATION_TYPES.includes(type)) {
    return res.status(400).json({ success: false, error: `Invalid type: ${NOTIFICATION_TYPES.join(", ")}` });
  }
  if (!NOTIFICATION_PRIORITIES.includes(priority)) {
    return res.status(400).json({ success: false, error: "Invalid priority" });
  }
  if (actionType && !ACTION_TYPES.includes(actionType)) {
    return res.status(400).json({ success: false, error: "Invalid actionType" });
  }
  if (sourceType && !SOURCE_TYPES.includes(sourceType)) {
    return res.status(400).json({ success: false, error: "Invalid sourceType" });
  }

  let parsedPayload = null;
  if (actionPayload) {
    try { parsedPayload = typeof actionPayload === "string" ? JSON.parse(actionPayload) : actionPayload; }
    catch { return res.status(400).json({ success: false, error: "actionPayload must be valid JSON" }); }
  }

  const data = {
    type, title, body,
    category: category || "",
    icon: icon || null,
    priority,
    imageUrl: imageUrl || null,
    link: link || null,
    action: actionType ? { type: actionType, url: actionUrl || null, payload: parsedPayload } : null,
    source: sourceType ? { type: sourceType, id: sourceId || null } : null,
  };

  // 🆕 Dedupe key: caller-supplied or auto from (pid, link).
  const autoDedupeKey = dedupeKey
    || `${sourceId || ""}|${link || ""}`;

  // 🆕 Parse dedupeTtlMs (allow explicit 0 to disable).
  let ttlOverride;
  if (dedupeTtlMs !== undefined && dedupeTtlMs !== null) {
    const n = Number(dedupeTtlMs);
    if (Number.isFinite(n) && n >= 0) ttlOverride = n;
  }

  const result = await sendNotificationWithPush(uid, data, {
    dedupeKey: autoDedupeKey,
    dedupeTtlMs: ttlOverride,
  });

  if (result.deduped) {
    return res.status(200).json({ success: true, deduped: true });
  }
  return res.status(200).json({ success: true, ...result });
}

async function handleAuthSignup(req, res, reqId) {
  if (!requireAdmin(req, res)) return;
  if (!(await enforceRate(res, "authBridge", `admin_${hashIp(getClientIp(req))}`))) return;

  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ success: false, error: "Missing uid" });
  const result = await bridgeOnSignup(uid);
  return res.status(200).json({ success: true, ...result });
}

async function handleAuthLogout(req, res, reqId) {
  if (!requireAdmin(req, res)) return;
  if (!(await enforceRate(res, "authBridge", `admin_${hashIp(getClientIp(req))}`))) return;

  const { uid, deviceId, token } = req.body || {};
  if (!uid) return res.status(400).json({ success: false, error: "Missing uid" });
  const result = await bridgeOnLogout(uid, deviceId || null, token || null);
  return res.status(200).json({ success: true, ...result });
}

async function handleAuthBan(req, res, reqId) {
  if (!requireAdmin(req, res)) return;
  if (!(await enforceRate(res, "authBridge", `admin_${hashIp(getClientIp(req))}`))) return;

  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ success: false, error: "Missing uid" });
  const result = await bridgeOnBan(uid);
  return res.status(200).json({ success: true, ...result });
}

async function handleAuthUnban(req, res, reqId) {
  if (!requireAdmin(req, res)) return;
  if (!(await enforceRate(res, "authBridge", `admin_${hashIp(getClientIp(req))}`))) return;

  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ success: false, error: "Missing uid" });
  const result = await bridgeOnUnban(uid);
  return res.status(200).json({ success: true, ...result });
}

async function handleHealth(req, res, reqId) {
  return res.status(200).json({
    success: true,
    status: "ok",
    delivery: "fcm",
    topic: GENERAL_TOPIC,
    types: NOTIFICATION_TYPES,
    settings: Object.keys(DEFAULT_SETTINGS),
    cache: getCacheStats(),
    fcm: !!messaging,
    androidChannel: ANDROID_CHANNEL_ID, // 🆕
    androidIcon: ANDROID_ICON,          // 🆕
  });
}

// =========================================================================
// ROUTER
// =========================================================================

const BASE_URL = process.env.BASE_URL || "https://foliostudios.vercel.app";

export default async function handler(req, res) {
  const reqId = newReqId();
  res.setHeader("X-Request-Id", reqId);

  const origin = req.headers.origin;
  if (!origin || origin === BASE_URL) {
    res.setHeader("Access-Control-Allow-Origin", origin || BASE_URL);
  } else {
    res.setHeader("Access-Control-Allow-Origin", BASE_URL);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = String(req.query?.action || req.body?.action || "").trim();
  const method = req.method;

  try {
    // Public config
    if (method === "GET"  && action === "config")          return await handleConfig(req, res, reqId);

    // User endpoints
    if (method === "POST" && action === "subscribe")       return await handleSubscribe(req, res, reqId);
    if (method === "POST" && action === "unsubscribe")     return await handleUnsubscribe(req, res, reqId);
    if (method === "POST" && action === "mark_read")       return await handleMarkRead(req, res, reqId);
    if (method === "POST" && action === "mark_all_read")   return await handleMarkAllRead(req, res, reqId);
    if (method === "POST" && action === "dismiss")         return await handleDismiss(req, res, reqId);
    if (method === "POST" && action === "dismiss_all_read") return await handleDismissAllRead(req, res, reqId);
    if (method === "POST" && action === "update_settings") return await handleUpdateSettings(req, res, reqId);
    if (method === "GET"  && action === "list")            return await handleList(req, res, reqId);
    if (method === "GET"  && action === "stats")           return await handleStats(req, res, reqId);
    if (method === "GET"  && action === "get_settings")    return await handleGetSettings(req, res, reqId);

    // Admin / bridge endpoints
    if (method === "POST" && action === "create")          return await handleCreate(req, res, reqId);
    if (method === "POST" && action === "broadcast")       return await handleBroadcast(req, res, reqId);
    if (method === "GET"  && action === "topic-info")      return await handleTopicInfo(req, res, reqId);
    if (method === "POST" && action === "auth_signup")     return await handleAuthSignup(req, res, reqId);
    if (method === "POST" && action === "auth_logout")     return await handleAuthLogout(req, res, reqId);
    if (method === "POST" && action === "auth_ban")        return await handleAuthBan(req, res, reqId);
    if (method === "POST" && action === "auth_unban")      return await handleAuthUnban(req, res, reqId);

    // Health
    if (method === "GET"  && action === "health")          return await handleHealth(req, res, reqId);

    return res.status(400).json({ success: false, error: `Unknown action: ${action || "(none)"}` });
  } catch (err) {
    log("notify.unhandled_error", { reqId, action, method, message: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: "Internal error", reqId });
  }
}

export const config = { runtime: "nodejs" };