// api/shortlink.js — Folio short link API
// Deployed on the secondary Vercel project (foliosites.vercel.app).
//
// ═══════════════════════════════════════════════════════════════════
//  SUPPORTED DOMAINS (short links live on these)
// ═══════════════════════════════════════════════════════════════════
//   folio.xo.je              (primary — free domain)
//   foliosites.vercel.app    (fallback — secondary Vercel project)
//   foliostudios.vercel.app  (fallback — main app)
//
//  Configure SHORT_DOMAIN to change which one shortUrlFor() returns.
//
// ═══════════════════════════════════════════════════════════════════
//  ENDPOINTS
// ═══════════════════════════════════════════════════════════════════
//   GET    ?key=X                → resolve (public)
//   GET    ?action=info&key=X    → metadata (public)
//   GET    ?action=domains       → supported domains (public)
//   POST   ?action=create        → auto-create on deploy
//   POST   ?action=claim         → claim custom key (2-step collision)
//   POST   ?action=edit          → rename existing key (keeps URL)
//   POST   ?action=transfer      → move a key to another project
//   DELETE ?action=release&key=X → free a key
//   GET    ?action=list          → admin: list all keys
//
//  All write paths auto-number on collision. Rate-limited, but on hit
//  they fall back to numbered keys instead of 429. Only total exhaustion
//  (99 attempts) returns 429.
// ═══════════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import { db, messaging } from "../utils/firebase.js";
import { log, newReqId } from "../utils/log.js";
import {
  verifySession,
  getUser,
  getClientIp,
  hashIp,
  sanitizeFirebasePath,
  logProjectEvent,
  logUserEvent,
} from "../utils/users.js";

// =========================================================================
// CONFIG
// =========================================================================

const API_NAME = "shortlink";

const SHORT_URL =
  (process.env.SHORT_URL || "https://folio.xo.je").replace(/\/+$/, "");
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
const BASE_URL = process.env.BASE_URL || "https://foliostudios.vercel.app";
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || "";
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID || "";

const KEY_RE = /^[a-z][a-z0-9]{2,29}$/;
const KEY_MAX_LEN = 30;
const MAX_NUMBERED_ATTEMPTS = 99;

// =========================================================================
// SUPPORTED DOMAINS
// =========================================================================

const SUPPORTED_DOMAINS = new Set([
  "folio.xo.je",
  "foliosites.vercel.app",
  "foliostudios.vercel.app",
]);

// =========================================================================
// RESERVED
// =========================================================================

const RESERVED_EXACT = new Set([
  "api", "s", "app", "www", "admin", "mail", "ftp", "cdn",
  "static", "assets", "health", "login", "register", "profile",
  "settings", "dashboard", "docs", "help", "support", "about",
  "terms", "privacy", "folio", "foliosites", "xo",
]);

const RESERVED_PREFIXES = ["api", "s", "admin", "static", "assets", "www"];

function isReserved(key) {
  if (RESERVED_EXACT.has(key)) return true;
  for (const p of RESERVED_PREFIXES) if (key.startsWith(p)) return true;
  return false;
}

// =========================================================================
// RATE LIMITS
// =========================================================================
//
// In-memory per Vercel function instance. For a small app this is fine
// — hostile traffic is distributed across instances, each enforces its
// own ceiling. For strict global limits, back this with Firebase.

const RATE_LIMITS = {
  resolve: { max: 600, window: 60_000 },
  create:  { max: 10,  window: 60_000 },
  claim:   { max: 15,  window: 60_000 },
  edit:    { max: 15,  window: 60_000 },
  transfer: { max: 10, window: 60_000 },
  release: { max: 10,  window: 60_000 },
  info:    { max: 120, window: 60_000 },
};

const RATE_CACHE = new Map();

function checkRateLimit(identifier, action) {
  const cfg = RATE_LIMITS[action];
  if (!cfg) return { allowed: true, remaining: Infinity };

  const now = Date.now();
  const id = `${action}|${identifier}`;
  let bucket = RATE_CACHE.get(id);

  if (!bucket || now - bucket.start > cfg.window) {
    bucket = { count: 0, start: now };
    RATE_CACHE.set(id, bucket);
  }

  if (bucket.count >= cfg.max) {
    const resetAt = bucket.start + cfg.window;
    return {
      allowed: false,
      limit: cfg.max,
      remaining: 0,
      resetAt,
      retryAfter: Math.ceil((resetAt - now) / 1000),
    };
  }

  bucket.count++;
  return {
    allowed: true,
    limit: cfg.max,
    remaining: cfg.max - bucket.count,
    resetAt: bucket.start + cfg.window,
  };
}

function setRateHeaders(res, rl) {
  if (!rl) return;
  if (Number.isFinite(rl.limit)) res.setHeader("X-RateLimit-Limit", String(rl.limit));
  if (Number.isFinite(rl.remaining)) res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  if (rl.resetAt) res.setHeader("X-RateLimit-Reset", new Date(rl.resetAt).toISOString());
}

// Periodic sweep — keeps the Map bounded
if (typeof setInterval === "function") {
  const t = setInterval(() => {
    const now = Date.now();
    const maxWindow = Math.max(...Object.values(RATE_LIMITS).map(c => c.window));
    for (const [k, v] of RATE_CACHE) {
      if (now - v.start > maxWindow * 2) RATE_CACHE.delete(k);
    }
  }, 10 * 60 * 1000);
  if (t.unref) t.unref();
}

// =========================================================================
// CORS
// =========================================================================

const ALLOWED_ORIGINS = new Set([
  "https://folio.xo.je",
  "https://foliosites.vercel.app",
  "https://foliostudios.vercel.app",
]);

function setCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader(
    "Access-Control-Allow-Origin",
    ALLOWED_ORIGINS.has(origin) ? origin : "https://folio.xo.je"
  );
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-api-key, Authorization"
  );
}

// =========================================================================
// CACHES
// =========================================================================

// Hot cache: key → record. LRU, 60s, 1000 entries per instance.
const HOT = new Map();
const HOT_TTL = 60_000;
const HOT_MAX = 1000;

// Negative cache: key → timestamp. 30s, 1000 entries.
const NEG = new Map();
const NEG_TTL = 30_000;
const NEG_MAX = 1000;

// Click batch: key → { count, timer }. Flushed every 5s.
const CLICK_BATCH = new Map();
const CLICK_FLUSH_MS = 5000;

function hotGet(key) {
  const e = HOT.get(key);
  if (!e) return null;
  if (Date.now() - e.at > HOT_TTL) {
    HOT.delete(key);
    return null;
  }
  // LRU promote
  HOT.delete(key);
  HOT.set(key, e);
  return e.record;
}

function hotSet(key, record) {
  if (HOT.size >= HOT_MAX) HOT.delete(HOT.keys().next().value);
  HOT.set(key, { record, at: Date.now() });
}

function hotDelete(key) { HOT.delete(key); }

function negGet(key) {
  const t = NEG.get(key);
  if (!t) return false;
  if (Date.now() - t > NEG_TTL) {
    NEG.delete(key);
    return false;
  }
  return true;
}

function negSet(key) {
  if (NEG.size >= NEG_MAX) NEG.delete(NEG.keys().next().value);
  NEG.set(key, Date.now());
}

function negDelete(key) { NEG.delete(key); }

// =========================================================================
// CLICK TRACKING (batched)
// =========================================================================

function trackClick(key, reqId) {
  let b = CLICK_BATCH.get(key);
  if (!b) {
    b = { count: 0, timer: null };
    CLICK_BATCH.set(key, b);
  }
  b.count++;
  if (!b.timer) {
    b.timer = setTimeout(() => {
      const batch = CLICK_BATCH.get(key);
      CLICK_BATCH.delete(key);
      if (batch && batch.count > 0) {
        const updates = {};
        updates[`links/${key}/c`] = admin.database.ServerValue.increment(batch.count);
        updates[`links/${key}/l`] = Date.now();
        db.ref().update(updates).catch(err => {
          log("shortlink.click_flush_failed", { reqId, key, message: err.message });
        });
      }
    }, CLICK_FLUSH_MS);
    if (b.timer.unref) b.timer.unref();
  }
}

// =========================================================================
// CACHE INVALIDATION
// =========================================================================

async function invalidateKey(key, reqId) {
  hotDelete(key);
  negDelete(key);

  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) return;

  try {
    await fetch("https://api.vercel.com/v1/edge-cache/purge", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${VERCEL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: VERCEL_PROJECT_ID,
        paths: [`/api/shortlink?key=${encodeURIComponent(key)}`],
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    log("shortlink.edge_purge_failed", { reqId, key, message: err.message });
  }
}

// =========================================================================
// KEY BUILDING
// =========================================================================

function buildBaseKey(raw) {
  let s = String(raw || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^[a-z]/.test(s)) s = "p" + s;
  if (s.length > KEY_MAX_LEN - 2) s = s.slice(0, KEY_MAX_LEN - 2);
  if (s.length < 3) s = s.padEnd(3, "x");
  return s;
}

function candidateKey(base, n) {
  return n <= 1 ? base : `${base}${n}`;
}

// =========================================================================
// AVAILABILITY / CLAIM PRIMITIVES
// =========================================================================

async function findNextAvailable(base, count, pid) {
  const out = [];
  let n = 1;
  let attempts = 0;

  while (out.length < count && n <= MAX_NUMBERED_ATTEMPTS && attempts < 20) {
    attempts++;
    const candidate = candidateKey(base, n);
    const snap = await db.ref(`links/${candidate}`).once("value");
    if (!snap.exists()) {
      out.push(candidate);
    } else if (pid && snap.val().p === pid) {
      out.push(candidate);
    }
    n++;
  }
  return out;
}

async function tryClaim(key, record) {
  const result = await db.ref(`links/${key}`).transaction(current => {
    if (current !== null) return;
    return record;
  });
  return result.committed;
}

async function claimFirstAvailableFrom(base, makeRecord, pid, startNumber = 1) {
  let n = Math.max(1, startNumber);
  let attempts = 0;

  while (n <= MAX_NUMBERED_ATTEMPTS && attempts < MAX_NUMBERED_ATTEMPTS + 5) {
    attempts++;
    const candidate = candidateKey(base, n);

    const snap = await db.ref(`links/${candidate}`).once("value");
    if (snap.exists() && snap.val().p === pid) return candidate;
    if (!snap.exists()) {
      const committed = await tryClaim(candidate, makeRecord(candidate));
      if (committed) return candidate;
    }
    n++;
  }
  return null;
}

async function releaseKey(key, pid) {
  const snap = await db.ref(`links/${key}`).once("value");
  if (!snap.exists()) return false;
  if (pid && snap.val().p !== pid) return false;
  await db.ref(`links/${key}`).remove();
  hotDelete(key);
  negDelete(key);
  return true;
}

// =========================================================================
// RESPONSE HELPERS
// =========================================================================

function shortUrlFor(key) {
  return `${SHORT_URL}/${key}`;
}

function publicRecord(key, record) {
  return {
    key,
    url: record.u,
    name: record.n || key,
    imageUrl: record.i || null,
    clicks: record.c || 0,
    createdAt: record.t || null,
    lastAccessed: record.l || null,
    editedAt: record.e || null,
  };
}

// =========================================================================
// AUTHORIZATION
// =========================================================================

async function isAdmin(req) {
  const key = req.headers["x-api-key"] || req.headers["admin-api-key"] || "";
  if (!ADMIN_API_KEY || key.length !== ADMIN_API_KEY.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_API_KEY));
  } catch {
    return false;
  }
}

async function authorizeProject(req, res, pid) {
  if (await isAdmin(req)) {
    return { ok: true, via: "admin", uid: null };
  }

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Authentication required" };
  }
  const decoded = verifySession(auth.slice(7).trim());
  if (!decoded || !decoded.uid) {
    return { ok: false, status: 401, error: "Invalid session" };
  }

  const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
  if (!ownerSnap.exists()) {
    return { ok: false, status: 404, error: "Project not found" };
  }
  if (ownerSnap.val() !== decoded.uid) {
    return { ok: false, status: 403, error: "Not your project" };
  }

  return { ok: true, via: "session", uid: decoded.uid };
}

// =========================================================================
// NOTIFICATIONS (via notify API, same pattern as host.js)
// =========================================================================

async function callNotify(type, uid, payload) {
  if (!uid) return;
  try {
    const res = await fetch(`${BASE_URL}/api/notify?action=create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ADMIN_API_KEY,
      },
      body: JSON.stringify({ type, uid, ...payload }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) log("shortlink.notify_failed", { type, uid, status: res.status });
  } catch (err) {
    log("shortlink.notify_error", { type, uid, message: err.message });
  }
}

async function notifyKeyEvent({
  uid, title, body, link, extra, dedupeKey, dedupeTtlMs,
}) {
  if (!uid) return;
  await callNotify("project", uid, {
    title,
    body,
    link,
    extra,
    dedupeKey,
    dedupeTtlMs,
  });
}

// =========================================================================
// HANDLER: GET ?key=X — resolve (hot path)
// =========================================================================

async function handleResolve(req, res, reqId) {
  const key = String(req.query.key || "").trim();

  if (!KEY_RE.test(key)) {
    return res.status(400).json({ success: false, error: "Invalid key format" });
  }

  // Hot cache
  const cached = hotGet(key);
  if (cached) {
    trackClick(key, reqId);
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
    log("shortlink.resolve.hit", { reqId, key, source: "hot" });
    return res.status(200).json({
      success: true,
      data: publicRecord(key, cached),
      cached: "hot",
    });
  }

  // Negative cache
  if (negGet(key)) {
    res.setHeader("Cache-Control", "public, max-age=5, s-maxage=10");
    log("shortlink.resolve.miss", { reqId, key, source: "negative" });
    return res.status(404).json({ success: false, error: "Link not found" });
  }

  // Firebase
  try {
    const snap = await db.ref(`links/${key}`).once("value");
    if (!snap.exists()) {
      negSet(key);
      res.setHeader("Cache-Control", "public, max-age=5, s-maxage=10");
      log("shortlink.resolve.miss", { reqId, key, source: "firebase" });
      return res.status(404).json({ success: false, error: "Link not found" });
    }

    const record = snap.val();
    hotSet(key, record);
    trackClick(key, reqId);

    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
    log("shortlink.resolve.hit", { reqId, key, source: "firebase" });
    return res.status(200).json({
      success: true,
      data: publicRecord(key, record),
      cached: "firebase",
    });
  } catch (err) {
    log("shortlink.resolve.error", { reqId, key, message: err.message });
    return res.status(503).json({ success: false, error: "Temporarily unavailable" });
  }
}

// =========================================================================
// HANDLER: GET ?action=info&key=X
// =========================================================================

async function handleInfo(req, res, reqId) {
  const key = String(req.query.key || "").trim();
  if (!KEY_RE.test(key)) {
    return res.status(400).json({ success: false, error: "Invalid key" });
  }

  const cached = hotGet(key);
  if (cached) {
    return res.status(200).json({ success: true, data: publicRecord(key, cached) });
  }

  const snap = await db.ref(`links/${key}`).once("value");
  if (!snap.exists()) {
    return res.status(404).json({ success: false, error: "Link not found" });
  }
  const record = snap.val();
  hotSet(key, record);
  return res.status(200).json({ success: true, data: publicRecord(key, record) });
}

// =========================================================================
// HANDLER: GET ?action=domains
// =========================================================================

async function handleDomains(req, res, reqId) {
  return res.status(200).json({
    success: true,
    primary: SHORT_DOMAIN,
    domains: [...SUPPORTED_DOMAINS],
  });
}

// =========================================================================
// HANDLER: POST ?action=create (auto on deploy)
// =========================================================================

async function handleCreate(req, res, reqId) {
  const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const { pid, url, imageUrl, name } = body;

  if (!pid || !url || !/^https:\/\//i.test(url)) {
    return res.status(400).json({ success: false, error: "Missing pid or invalid url" });
  }

  const authResult = await authorizeProject(req, res, pid);
  if (!authResult.ok) {
    return res.status(authResult.status).json({ success: false, error: authResult.error });
  }

  const rateId = authResult.via === "admin"
    ? `admin_${hashIp(getClientIp(req))}`
    : `uid_${authResult.uid}`;
  const rl = checkRateLimit(rateId, "create");
  setRateHeaders(res, rl);

  const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
  const ownerUid = ownerSnap.exists() ? ownerSnap.val() : null;
  if (!ownerUid) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }

  // Existing key → repoint
  const idxSnap = await db.ref(`linksByPid/${pid}`).once("value");
  if (idxSnap.exists()) {
    const key = idxSnap.val();
    const updates = {};
    updates[`links/${key}/u`] = url;
    updates[`links/${key}/l`] = Date.now();
    if (imageUrl) updates[`links/${key}/i`] = imageUrl;
    if (name) updates[`links/${key}/n`] = name;
    await db.ref().update(updates);
    await invalidateKey(key, reqId);

    await logProjectEvent(pid, ownerUid, "shortlink", "shortlink.repointed", {
      key, url,
    });

    log("shortlink.create.repointed", { reqId, pid, key });
    return res.status(200).json({
      success: true,
      key,
      shortUrl: shortUrlFor(key),
      reused: true,
      strategy: "proj",
    });
  }

  // Cold create
  const slugSnap = await db.ref(`projects/${pid}/slug`).once("value");
  const slug = slugSnap.exists() ? slugSnap.val() : "";
  let base = buildBaseKey(slug || name || "project");
  if (isReserved(base)) base = buildBaseKey("p" + base);

  const startNumber = rl.allowed ? 1 : 2;
  const makeRecord = (key) => ({
    u: url,
    p: pid,
    o: ownerUid,
    c: 0,
    l: null,
    t: Date.now(),
    s: "proj",
    i: imageUrl || null,
    n: name || key,
  });

  const key = await claimFirstAvailableFrom(base, makeRecord, pid, startNumber);

  if (!key) {
    log("shortlink.create.exhausted", { reqId, pid, base });
    return res.status(429).json({
      success: false,
      error: "Could not allocate a key — try again later",
      retryAfter: rl.retryAfter || 60,
    });
  }

  await db.ref(`linksByPid/${pid}`).set(key);
  await db.ref(`projects/${pid}/shortKey`).set(key);
  await invalidateKey(key, reqId);

  await logProjectEvent(pid, ownerUid, "shortlink", "shortlink.created", {
    key,
    shortUrl: shortUrlFor(key),
    numbered: key !== base,
  });

  await notifyKeyEvent({
    uid: ownerUid,
    title: "Short link created",
    body: `Your project now has a short link: ${shortUrlFor(key)}`,
    link: `${BASE_URL}/project?pid=${pid}`,
    extra: { pid, key },
    dedupeKey: `shortlink_create_${pid}`,
    dedupeTtlMs: 60 * 1000,
  });

  log("shortlink.create.new", {
    reqId, pid, key,
    numbered: key !== base,
    rateLimited: !rl.allowed,
    via: authResult.via,
  });

  return res.status(200).json({
    success: true,
    key,
    shortUrl: shortUrlFor(key),
    reused: false,
    strategy: "proj",
    numbered: key !== base,
  });
}

// =========================================================================
// HANDLER: POST ?action=claim (custom claim, 2-step on collision)
// =========================================================================

async function handleClaim(req, res, reqId) {
  const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const { pid, url, imageUrl, name, baseName, strategy, confirmed } = body;

  if (!pid || !baseName || !url) {
    return res.status(400).json({ success: false, error: "Missing pid, baseName, or url" });
  }
  if (!["custom", "userproj"].includes(strategy)) {
    return res.status(400).json({ success: false, error: "Invalid strategy" });
  }
  if (!/^https:\/\//i.test(url)) {
    return res.status(400).json({ success: false, error: "Invalid url" });
  }

  const authResult = await authorizeProject(req, res, pid);
  if (!authResult.ok) {
    return res.status(authResult.status).json({ success: false, error: authResult.error });
  }

  const rateId = authResult.via === "admin"
    ? `admin_${hashIp(getClientIp(req))}`
    : `uid_${authResult.uid}`;
  const rl = checkRateLimit(rateId, "claim");
  setRateHeaders(res, rl);

  const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
  const ownerUid = ownerSnap.exists() ? ownerSnap.val() : null;
  if (!ownerUid) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }

  // Validate base
  let base;
  if (strategy === "custom") {
    const cleaned = String(baseName).toLowerCase().trim();
    if (!KEY_RE.test(cleaned)) {
      return res.status(400).json({
        success: false,
        error: "Invalid key: 3-30 chars, lowercase letters + digits, starts with a letter",
      });
    }
    if (isReserved(cleaned)) {
      return res.status(400).json({ success: false, error: "This key is reserved" });
    }
    base = cleaned;
  } else {
    base = buildBaseKey(baseName);
    if (isReserved(base)) base = buildBaseKey("p" + base);
  }

  const idxSnap = await db.ref(`linksByPid/${pid}`).once("value");
  const existingKey = idxSnap.exists() ? idxSnap.val() : null;

  if (existingKey === base && !confirmed) {
    return res.status(200).json({
      success: true,
      key: base,
      shortUrl: shortUrlFor(base),
      strategy,
      reused: true,
      unchanged: true,
    });
  }

  const makeRecord = (key) => ({
    u: url,
    p: pid,
    o: ownerUid,
    c: 0,
    l: null,
    t: Date.now(),
    s: strategy,
    i: imageUrl || null,
    n: name || key,
  });

  const startNumber = rl.allowed && !confirmed ? 1 : 2;

  // Step 1: try bare (only first attempt, not confirmed, not rate-limited)
  if (!confirmed && rl.allowed) {
    const bareSnap = await db.ref(`links/${base}`).once("value");
    if (!bareSnap.exists()) {
      const committed = await tryClaim(base, makeRecord(base));
      if (committed) {
        if (existingKey && existingKey !== base) {
          await releaseKey(existingKey, pid);
          await invalidateKey(existingKey, reqId);
        }
        await db.ref(`linksByPid/${pid}`).set(base);
        await db.ref(`projects/${pid}/shortKey`).set(base);
        await invalidateKey(base, reqId);

        await logProjectEvent(pid, ownerUid, "shortlink", "shortlink.claimed", {
          key: base, strategy, previousKey: existingKey,
        });

        log("shortlink.claim.success", {
          reqId, pid, key: base, strategy, numbered: false, via: authResult.via,
        });

        return res.status(200).json({
          success: true,
          key: base,
          shortUrl: shortUrlFor(base),
          strategy,
          previousKey: existingKey !== base ? existingKey : null,
        });
      }
    }
  }

  // Step 2: bare taken → return 409 with suggestions
  if (!confirmed && rl.allowed) {
    const suggestions = await findNextAvailable(base, 3, pid);
    log("shortlink.claim.conflict", { reqId, pid, base, suggestions });

    // Notify the user that their requested name was taken
    await notifyKeyEvent({
      uid: ownerUid,
      title: "Short link name taken",
      body: `"${base}" is already in use. Suggested: ${suggestions.slice(0, 3).join(", ")}`,
      link: `${BASE_URL}/project?pid=${pid}`,
      extra: { pid, base, suggestions },
      dedupeKey: `shortlink_conflict_${pid}_${base}`,
      dedupeTtlMs: 5 * 60 * 1000,
    });

    return res.status(409).json({
      success: false,
      error: "Key already taken",
      base,
      suggestions,
      message: `"${base}" is taken. Continue with "${suggestions[0] || base + "2"}"?`,
    });
  }

  // Step 3: confirmed or rate-limited → claim numbered
  const key = await claimFirstAvailableFrom(base, makeRecord, pid, startNumber);

  if (!key) {
    log("shortlink.claim.exhausted", { reqId, pid, base, rateLimited: !rl.allowed });
    return res.status(429).json({
      success: false,
      error: "Could not allocate a key — try again later",
      retryAfter: rl.retryAfter || 60,
    });
  }

  if (existingKey && existingKey !== key) {
    await releaseKey(existingKey, pid);
    await invalidateKey(existingKey, reqId);
  }
  await db.ref(`linksByPid/${pid}`).set(key);
  await db.ref(`projects/${pid}/shortKey`).set(key);
  await invalidateKey(key, reqId);

  await logProjectEvent(pid, ownerUid, "shortlink", "shortlink.claimed", {
    key, strategy, numbered: key !== base, rateLimited: !rl.allowed, previousKey: existingKey,
  });

  await notifyKeyEvent({
    uid: ownerUid,
    title: "Short link claimed",
    body: `Your project's short link is ${shortUrlFor(key)}${key !== base ? " (numbered)" : ""}.`,
    link: `${BASE_URL}/project?pid=${pid}`,
    extra: { pid, key, strategy },
    dedupeKey: `shortlink_claim_${pid}_${key}`,
    dedupeTtlMs: 5 * 60 * 1000,
  });

  log("shortlink.claim.success", {
    reqId, pid, key, strategy,
    numbered: key !== base,
    rateLimited: !rl.allowed,
    via: authResult.via,
  });

  return res.status(200).json({
    success: true,
    key,
    shortUrl: shortUrlFor(key),
    strategy,
    numbered: key !== base,
    previousKey: existingKey !== key ? existingKey : null,
  });
}

// =========================================================================
// HANDLER: POST ?action=edit (rename key, same record)
// =========================================================================

async function handleEdit(req, res, reqId) {
  const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const { pid, newName, confirmed } = body;

  if (!pid || !newName) {
    return res.status(400).json({ success: false, error: "Missing pid or newName" });
  }

  const authResult = await authorizeProject(req, res, pid);
  if (!authResult.ok) {
    return res.status(authResult.status).json({ success: false, error: authResult.error });
  }

  // Validate new name
  const clean = String(newName).toLowerCase().trim();
  if (!KEY_RE.test(clean)) {
    return res.status(400).json({
      success: false,
      error: "Invalid key: 3-30 chars, lowercase letters + digits, starts with a letter",
    });
  }
  if (isReserved(clean)) {
    return res.status(400).json({ success: false, error: "This key is reserved" });
  }

  // Current key
  const idxSnap = await db.ref(`linksByPid/${pid}`).once("value");
  const currentKey = idxSnap.exists() ? idxSnap.val() : null;

  if (!currentKey) {
    return res.status(404).json({
      success: false,
      error: "No short link to edit — create one first",
    });
  }

  // ── Unchanged-name guard (BEFORE rate limit) ──
  if (clean === currentKey) {
    log("shortlink.edit.unchanged", { reqId, pid, key: clean });
    return res.status(200).json({
      success: true,
      key: clean,
      shortUrl: shortUrlFor(clean),
      unchanged: true,
      message: "Key unchanged",
    });
  }

  // Rate limit (only for real renames)
  const rateId = authResult.via === "admin"
    ? `admin_${hashIp(getClientIp(req))}`
    : `uid_${authResult.uid}`;
  const rl = checkRateLimit(rateId, "edit");
  setRateHeaders(res, rl);

  // Fetch current record to preserve URL, clicks, createdAt
  const curSnap = await db.ref(`links/${currentKey}`).once("value");
  if (!curSnap.exists()) {
    return res.status(404).json({ success: false, error: "Current link record missing" });
  }
  const cur = curSnap.val();
  const ownerUid = cur.o || null;

  const makeRecord = (key) => ({
    u: cur.u,
    p: pid,
    o: ownerUid,
    c: cur.c || 0,
    l: cur.l || null,
    t: cur.t || Date.now(),
    s: cur.s || "custom",
    i: cur.i || null,
    n: cur.n || key,
    e: Date.now(),
  });

  const startNumber = rl.allowed && !confirmed ? 1 : 2;

  // Step 1: try bare
  if (!confirmed && rl.allowed) {
    const bareSnap = await db.ref(`links/${clean}`).once("value");
    if (!bareSnap.exists()) {
      const committed = await tryClaim(clean, makeRecord(clean));
      if (committed) {
        await releaseKey(currentKey, pid);
        await invalidateKey(currentKey, reqId);

        await db.ref(`linksByPid/${pid}`).set(clean);
        await db.ref(`projects/${pid}/shortKey`).set(clean);
        await invalidateKey(clean, reqId);

        await logProjectEvent(pid, ownerUid, "shortlink", "shortlink.edited", {
          from: currentKey, to: clean, numbered: false,
        });

        await notifyKeyEvent({
          uid: ownerUid,
          title: "Short link renamed",
          body: `Your short link changed from ${shortUrlFor(currentKey)} to ${shortUrlFor(clean)}.`,
          link: `${BASE_URL}/project?pid=${pid}`,
          extra: { pid, from: currentKey, to: clean },
          dedupeKey: `shortlink_edit_${pid}_${clean}`,
          dedupeTtlMs: 5 * 60 * 1000,
        });

        log("shortlink.edit.success", {
          reqId, pid, from: currentKey, to: clean, numbered: false, via: authResult.via,
        });

        return res.status(200).json({
          success: true,
          key: clean,
          shortUrl: shortUrlFor(clean),
          previousKey: currentKey,
          numbered: false,
        });
      }
    }
  }

  // Step 2: bare taken → 409 with suggestions
  if (!confirmed && rl.allowed) {
    const suggestions = await findNextAvailable(clean, 3, pid);
    log("shortlink.edit.conflict", { reqId, pid, from: currentKey, base: clean, suggestions });

    await notifyKeyEvent({
      uid: ownerUid,
      title: "Short link rename conflict",
      body: `"${clean}" is taken. Suggested: ${suggestions.slice(0, 3).join(", ")}`,
      link: `${BASE_URL}/project?pid=${pid}`,
      extra: { pid, from: currentKey, base: clean, suggestions },
      dedupeKey: `shortlink_editconflict_${pid}_${clean}`,
      dedupeTtlMs: 5 * 60 * 1000,
    });

    return res.status(409).json({
      success: false,
      error: "Key already taken",
      base: clean,
      suggestions,
      previousKey: currentKey,
      message: `"${clean}" is taken. Continue with "${suggestions[0] || clean + "2"}"?`,
    });
  }

  // Step 3: confirmed or rate-limited
  const newKey = await claimFirstAvailableFrom(clean, makeRecord, pid, startNumber);

  if (!newKey) {
    log("shortlink.edit.exhausted", { reqId, pid, base: clean, rateLimited: !rl.allowed });
    return res.status(429).json({
      success: false,
      error: "Could not allocate a key — try again later",
      retryAfter: rl.retryAfter || 60,
    });
  }

  await releaseKey(currentKey, pid);
  await invalidateKey(currentKey, reqId);

  await db.ref(`linksByPid/${pid}`).set(newKey);
  await db.ref(`projects/${pid}/shortKey`).set(newKey);
  await invalidateKey(newKey, reqId);

  await logProjectEvent(pid, ownerUid, "shortlink", "shortlink.edited", {
    from: currentKey, to: newKey, numbered: newKey !== clean, rateLimited: !rl.allowed,
  });

  await notifyKeyEvent({
    uid: ownerUid,
    title: "Short link renamed",
    body: `Your short link is now ${shortUrlFor(newKey)}${newKey !== clean ? " (numbered)" : ""}.`,
    link: `${BASE_URL}/project?pid=${pid}`,
    extra: { pid, from: currentKey, to: newKey },
    dedupeKey: `shortlink_edit_${pid}_${newKey}`,
    dedupeTtlMs: 5 * 60 * 1000,
  });

  log("shortlink.edit.success", {
    reqId, pid, from: currentKey, to: newKey,
    numbered: newKey !== clean,
    rateLimited: !rl.allowed,
    via: authResult.via,
  });

  return res.status(200).json({
    success: true,
    key: newKey,
    shortUrl: shortUrlFor(newKey),
    previousKey: currentKey,
    numbered: newKey !== clean,
  });
}

// =========================================================================
// HANDLER: POST ?action=transfer (move a key to a different project)
// =========================================================================
//
// A key belongs to exactly one project. Transfer moves a key from one
// pid to another, keeping the same key + URL mapping. Used when a user
// rebuilds a project and wants to preserve the short link.

async function handleTransfer(req, res, reqId) {
  const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const { fromPid, toPid } = body;

  if (!fromPid || !toPid || fromPid === toPid) {
    return res.status(400).json({ success: false, error: "Missing or invalid pids" });
  }

  // Must own the destination project (and via admin, both)
  const authResult = await authorizeProject(req, res, toPid);
  if (!authResult.ok) {
    return res.status(authResult.status).json({ success: false, error: authResult.error });
  }

  // Transfer is admin-only — users can't move keys between projects
  if (authResult.via !== "admin") {
    return res.status(403).json({
      success: false,
      error: "Transfer requires admin key",
    });
  }

  const rl = checkRateLimit(`admin_${hashIp(getClientIp(req))}`, "transfer");
  setRateHeaders(res, rl);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Rate limit exceeded", retryAfter: rl.retryAfter });
  }

  const fromIdxSnap = await db.ref(`linksByPid/${fromPid}`).once("value");
  if (!fromIdxSnap.exists()) {
    return res.status(404).json({ success: false, error: "Source project has no short link" });
  }
  const key = fromIdxSnap.val();

  const keySnap = await db.ref(`links/${key}`).once("value");
  if (!keySnap.exists()) {
    return res.status(404).json({ success: false, error: "Key record missing" });
  }

  const toIdxSnap = await db.ref(`linksByPid/${toPid}`).once("value");
  if (toIdxSnap.exists() && toIdxSnap.val() !== key) {
    return res.status(409).json({
      success: false,
      error: "Destination project already has a short link",
      existingKey: toIdxSnap.val(),
    });
  }

  const updates = {};
  updates[`links/${key}/p`] = toPid;
  updates[`linksByPid/${fromPid}`] = null;
  updates[`linksByPid/${toPid}`] = key;
  updates[`projects/${toPid}/shortKey`] = key;
  await db.ref().update(updates);

  await invalidateKey(key, reqId);

  await logProjectEvent(fromPid, null, "shortlink", "shortlink.transferred_out", { key, toPid });
  await logProjectEvent(toPid, null, "shortlink", "shortlink.transferred_in", { key, fromPid });

  log("shortlink.transfer.ok", { reqId, key, fromPid, toPid });

  return res.status(200).json({
    success: true,
    key,
    shortUrl: shortUrlFor(key),
    fromPid,
    toPid,
  });
}

// =========================================================================
// HANDLER: DELETE ?action=release
// =========================================================================

async function handleRelease(req, res, reqId) {
  const key = String(req.query.key || "").trim();
  const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const pid = body.pid;

  if (!KEY_RE.test(key) || !pid) {
    return res.status(400).json({ success: false, error: "Missing or invalid key/pid" });
  }

  const authResult = await authorizeProject(req, res, pid);
  if (!authResult.ok) {
    return res.status(authResult.status).json({ success: false, error: authResult.error });
  }

  const rateId = authResult.via === "admin"
    ? `admin_${hashIp(getClientIp(req))}`
    : `uid_${authResult.uid}`;
  if (!checkRateLimit(rateId, "release").allowed) {
    return res.status(429).json({ success: false, error: "Rate limit exceeded", retryAfter: 60 });
  }

  const snap = await db.ref(`links/${key}`).once("value");
  if (!snap.exists()) {
    return res.status(404).json({ success: false, error: "Key not found" });
  }
  if (snap.val().p !== pid) {
    return res.status(403).json({ success: false, error: "Not your key" });
  }

  const ownerUid = snap.val().o || null;

  await releaseKey(key, pid);

  const updates = {};
  updates[`linksByPid/${pid}`] = null;
  updates[`projects/${pid}/shortKey`] = null;
  await db.ref().update(updates).catch(() => {});

  await invalidateKey(key, reqId);

  await logProjectEvent(pid, ownerUid, "shortlink", "shortlink.released", { key });

  await notifyKeyEvent({
    uid: ownerUid,
    title: "Short link released",
    body: `${shortUrlFor(key)} is no longer connected to your project.`,
    link: `${BASE_URL}/project?pid=${pid}`,
    extra: { pid, key },
    dedupeKey: `shortlink_release_${pid}_${key}`,
    dedupeTtlMs: 60 * 1000,
  });

  log("shortlink.release", { reqId, pid, key, released: true });
  return res.status(200).json({ success: true, key, released: true });
}

// =========================================================================
// HANDLER: GET ?action=list (admin)
// =========================================================================

async function handleList(req, res, reqId) {
  if (!(await isAdmin(req))) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const snap = await db.ref("links").once("value");
  const all = [];
  if (snap.exists()) {
    snap.forEach(child => {
      const v = child.val();
      all.push({
        key: child.key,
        url: v.u,
        pid: v.p,
        ownerUid: v.o,
        clicks: v.c || 0,
        createdAt: v.t || null,
        lastAccessed: v.l || null,
        strategy: v.s || null,
      });
    });
  }
  all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return res.status(200).json({
    success: true,
    total: all.length,
    offset,
    limit,
    links: all.slice(offset, offset + limit),
  });
}

// =========================================================================
// ROUTER
// =========================================================================

export default async function handler(req, res) {
  const reqId = newReqId();
  const startTime = Date.now();
  res.setHeader("X-Request-Id", reqId);

  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = String(req.query.action || "").trim();
  const method = req.method;

  if (req.body && typeof req.body === "string" && method !== "GET") {
    try { req.body = JSON.parse(req.body); }
    catch {
      return res.status(400).json({ success: false, error: "Invalid JSON body" });
    }
  }

  const ipHash = hashIp(getClientIp(req));

  try {
    // ── Public reads ──
    if (method === "GET" && !action && req.query.key) {
      const rl = checkRateLimit(`ip_${ipHash}`, "resolve");
      setRateHeaders(res, rl);
      if (!rl.allowed) {
        return res.status(429).json({
          success: false, error: "Rate limit exceeded", retryAfter: rl.retryAfter,
        });
      }
      return await handleResolve(req, res, reqId);
    }

    if (method === "GET" && action === "info") {
      return await handleInfo(req, res, reqId);
    }

    if (method === "GET" && action === "domains") {
      return await handleDomains(req, res, reqId);
    }

    // ── Writes ──
    if (method === "POST" && action === "create") {
      return await handleCreate(req, res, reqId);
    }

    if (method === "POST" && action === "claim") {
      return await handleClaim(req, res, reqId);
    }

    if (method === "POST" && action === "edit") {
      return await handleEdit(req, res, reqId);
    }

    if (method === "POST" && action === "transfer") {
      return await handleTransfer(req, res, reqId);
    }

    if (method === "DELETE" && action === "release") {
      return await handleRelease(req, res, reqId);
    }

    // ── Admin ──
    if (method === "GET" && action === "list") {
      return await handleList(req, res, reqId);
    }

    return res.status(404).json({ success: false, error: `Unknown action: ${action || "(none)"}` });
  } catch (err) {
    log("shortlink.unhandled_error", {
      reqId, action, method,
      message: err.message,
      stack: err.stack?.slice(0, 500),
    });
    return res.status(500).json({ success: false, error: "Internal error", reqId });
  } finally {
    log("shortlink.timing", {
      reqId, action: action || "(resolve)", method,
      elapsed: Date.now() - startTime,
    });
  }
}

export const config = { runtime: "nodejs" };