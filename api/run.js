// api/run.js
// ═══════════════════════════════════════════════════════════════════
//  Folio — Private API Runtime (Vercel Serverless / Chromium)
//  ────────────────────────────────────────────────────────────────
//  Two URL shapes are supported:
//
//    1. Friendly:  POST /{username}/project/{slug}/api/{route}
//       → Vercel rewrite → /api/run?username=…&project=…&route=…
//       → runtime resolves username + project slug → pid
//
//    2. Direct:    POST /api/{pid}/{route}
//       → Vercel rewrite → /api/run?pid=…&route=…
//       → runtime uses pid directly (no lookup)
//
//  ⚠  AUTH MODEL
//  The runtime does NOT require authentication. The user's script
//  decides what needs a token. Use /api/host?action=verify-session
//  inside the sandbox to validate REQ.headers.authorization.
//
//  ⚠  SANDBOX ORIGIN
//  The user script runs inside a real HTTPS origin on Folio's own
//  domain: ${BASE_URL}/__sandbox. The request interceptor serves
//  the sandbox HTML for that URL, so no network call is ever made.
//
//  ⚠  CHROMIUM MIN
//  We use @sparticuz/chromium-min (not @sparticuz/chromium).
//  See CHROMIUM_PACK_URL below.
//
//  ⚠  LD_LIBRARY_PATH
//  Do NOT override process.env.LD_LIBRARY_PATH manually. chromium-min
//  sets it to /tmp/al2023/lib where the shared libs live.
//
//  ⚠  SYSTEM vs USER ROUTES
//  System routes (health, whoami, files, status, version, robots) are
//  served by _system.js. User routes are api/{route}.js.
// ═══════════════════════════════════════════════════════════════════

import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { db } from "../utils/firebase.js";
import { log, newReqId } from "../utils/log.js";
import {
  verifySession,
  canAccessProject,
  verifyProjectKey,
  getClientIp,
  hashIp,
  sanitizeFirebasePath,
  logProjectEvent,
  getUser,
} from "../utils/users.js";
import * as projectSecrets from "../utils/projectsecret.js";
import * as projectDb from "../utils/projectdb.js";

// =========================================================================
// CONFIG
// =========================================================================

const BASE_URL =
  process.env.BASE_URL ||
  process.env.NEXT_PUBLIC_BASE_URL ||
  "https://foliostudios.vercel.app";

const PUBLIC_SITE_BASE =
  process.env.PUBLIC_SITE_BASE ||
  BASE_URL;

const USER_CODE_TIMEOUT_MS = 7000;
const PAGE_SETUP_TIMEOUT_MS = 5000;
const CHROMIUM_LAUNCH_TIMEOUT_MS = 15000;

const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RECURSION_DEPTH = 3;

// Chromium pack URL — @sparticuz/chromium-min downloads this on first use.
const CHROMIUM_PACK_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v141.0.0/chromium-v141.0.0-pack.x64.tar";

const BUILTIN_ALLOWED_HOSTS = new Set([
  "api.openai.com",
  "api.groq.com",
  "api.anthropic.com",
  "api.stripe.com",
  "api.paystack.co",
  "api.supabase.co",
  "api.resend.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
]);

const TRUSTED_IMAGE_HOSTS = new Set([
  "picsum.photos",
  "fastly.picsum.photos",
  "images.unsplash.com",
  "images.pexels.com",
  "cdn.pixabay.com",
  "upload.wikimedia.org",
]);

const ALLOWED_IMPORT_HOSTS = new Set([
  "cdn.jsdelivr.net",
  "esm.sh",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "ga.jspm.io",
  "cdn.skypack.dev",
]);

let _folioHost = null;
try { _folioHost = new URL(BASE_URL).hostname.toLowerCase(); } catch {}
const FOLIO_INTERNAL_HOSTS = new Set(["folio", _folioHost].filter(Boolean));

const RATE_LIMITS = {
  perSessionPerRoute: { max: 10, window: 60 * 1000 },
  perSessionAllRoutes: { max: 50, window: 60 * 1000 },
  perProjectHour: { max: 500, window: 60 * 60 * 1000 },
  perProjectDay: { max: 2000, window: 24 * 60 * 60 * 1000 },
  perProjectPerRouteHour: { max: 100, window: 60 * 60 * 1000 },
};

const SLUG_CACHE_TTL = 60 * 1000;
const SLUG_CACHE_MAX = 500;

// =========================================================================
// CORS — origins loaded from public/assets/domains.json
// =========================================================================

let _corsOrigins = null;

function loadCorsOrigins() {
  if (_corsOrigins) return _corsOrigins;
  const envOverride = process.env.CORS_ORIGINS;
  if (envOverride) {
    _corsOrigins = new Set(
      envOverride.split(",").map((s) => s.trim()).filter(Boolean),
    );
    return _corsOrigins;
  }
  try {
    const p = path.join(process.cwd(), "public", "assets", "domains.json");
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.origins) ? parsed.origins : [];
    _corsOrigins = new Set(list.map((s) => String(s).trim()).filter(Boolean));
  } catch (err) {
    log("run.cors.load_failed", { message: err.message });
    _corsOrigins = new Set([
      BASE_URL,
      PUBLIC_SITE_BASE,
    ].filter(Boolean));
  }
  return _corsOrigins;
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  const allowed = loadCorsOrigins();
  if (origin && allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Vary", "Origin");
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Project-Key, X-Recursion-Depth, X-Caller-Route",
  );
  res.setHeader("Access-Control-Max-Age", "600");
}

// =========================================================================
// API LOGS — per-project ring buffer (max 50 entries)
// =========================================================================

const API_LOGS_MAX = 50;

async function recordApiLog(pid, entry) {
  try {
    const clean = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      route: String(entry.route || "").slice(0, 60),
      method: String(entry.method || "POST").slice(0, 10),
      status: Number(entry.status) || 200,
      durationMs: Math.max(0, Number(entry.durationMs) || 0),
      errorName: entry.errorName ? String(entry.errorName).slice(0, 100) : null,
      errorMessage: entry.errorMessage ? String(entry.errorMessage).slice(0, 500) : null,
      via: entry.via || "anon",
      requestId: entry.requestId ? String(entry.requestId).slice(0, 60) : null,
      stage: entry.stage ? String(entry.stage).slice(0, 60) : null,
      bytesIn: Number.isFinite(entry.bytesIn) ? Math.max(0, entry.bytesIn) : null,
      bytesOut: Number.isFinite(entry.bytesOut) ? Math.max(0, entry.bytesOut) : null,
      fetchHosts: Array.isArray(entry.fetchHosts)
        ? entry.fetchHosts.slice(0, 20).map((h) => String(h).slice(0, 100))
        : [],
      userAgent: entry.userAgent ? String(entry.userAgent).slice(0, 200) : null,
      ipHash: entry.ipHash ? String(entry.ipHash).slice(0, 40) : null,
      deploymentId: entry.deploymentId ? String(entry.deploymentId).slice(0, 60) : null,
    };

    let existing = {};
    try {
      const snap = await db.ref(`apiLogs/${pid}`).once("value");
      if (snap.exists()) existing = snap.val() || {};
    } catch {}

    existing[clean.id] = clean;

    const entries = Object.entries(existing)
      .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    const keep = new Set(entries.slice(0, API_LOGS_MAX).map(([id]) => id));

    const updates = {};
    for (const [id, val] of Object.entries(existing)) {
      updates[id] = keep.has(id) ? val : null;
    }

    await db.ref(`apiLogs/${pid}`).update(updates);
  } catch (err) {
    log("run.record_api_log_failed", { pid, message: err.message });
  }
}

// =========================================================================
// STAGE TIMING HELPER
// =========================================================================

let _lastStage = null;

function stageLog(reqId, stage, startTime, extra = {}) {
  _lastStage = stage;
  try {
    log("run.timing", {
      reqId,
      stage,
      elapsed: Date.now() - startTime,
      ...extra,
    });
  } catch {}
}

// =========================================================================
// SLUG RESOLUTION CACHE
// =========================================================================

const PROJECT_SLUG_CACHE = new Map();

function slugCacheGet(username, slug) {
  const key = `${username}/${slug}`;
  const entry = PROJECT_SLUG_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > SLUG_CACHE_TTL) {
    PROJECT_SLUG_CACHE.delete(key);
    return null;
  }
  return entry.pid;
}

function slugCacheSet(username, slug, pid) {
  if (PROJECT_SLUG_CACHE.size >= SLUG_CACHE_MAX) {
    const first = PROJECT_SLUG_CACHE.keys().next().value;
    if (first) PROJECT_SLUG_CACHE.delete(first);
  }
  PROJECT_SLUG_CACHE.set(`${username}/${slug}`, { pid, at: Date.now() });
}

async function resolveProjectBySlug(username, slug) {
  if (!username || !slug) return null;

  const cached = slugCacheGet(username, slug);
  if (cached) return cached;

  try {
    const idxSnap = await db
      .ref(`projectSlugs/${username}/${slug}`)
      .once("value");
    if (idxSnap.exists()) {
      const pid = idxSnap.val();
      if (typeof pid === "string" && pid.startsWith("p_")) {
        slugCacheSet(username, slug, pid);
        return pid;
      }
    }
  } catch (err) {
    log("run.slug_index_lookup_failed", { username, slug, message: err.message });
  }

  try {
    const userSnap = await db.ref(`usernames/${username}`).once("value");
    if (!userSnap.exists()) return null;
    const uid = userSnap.val();
    if (!uid) return null;

    const projectsSnap = await db
      .ref("projects")
      .orderByChild("ownerId")
      .equalTo(uid)
      .once("value");
    if (!projectsSnap.exists()) return null;

    let foundPid = null;
    projectsSnap.forEach((child) => {
      const p = child.val() || {};
      if (p.slug === slug && p.ownerId === uid) foundPid = child.key;
    });

    if (foundPid) {
      db.ref(`projectSlugs/${username}/${slug}`)
        .set(foundPid)
        .catch(() => {});
      slugCacheSet(username, slug, foundPid);
      return foundPid;
    }
  } catch (err) {
    log("run.slug_scan_failed", { username, slug, message: err.message });
  }

  return null;
}

// =========================================================================
// RATE LIMITING
// =========================================================================

async function checkRate(bucketKey, cfg) {
  const now = Date.now();
  const safeKey = sanitizeFirebasePath(bucketKey);
  const ref = db.ref(`rate_limit/run/${safeKey}`);
  const snap = await ref.once("value");

  if (!snap.exists()) {
    await ref.set({ count: 1, first: now, last: now });
    return { allowed: true, remaining: cfg.max - 1, limit: cfg.max, resetAt: now + cfg.window };
  }

  const d = snap.val();
  const resetAt = (d.first || now) + cfg.window;

  if (now > resetAt) {
    await ref.set({ count: 1, first: now, last: now });
    return { allowed: true, remaining: cfg.max - 1, limit: cfg.max, resetAt: now + cfg.window };
  }

  if ((d.count || 0) >= cfg.max) {
    return {
      allowed: false,
      remaining: 0,
      limit: cfg.max,
      resetAt,
      retryAfter: Math.ceil((resetAt - now) / 1000),
    };
  }

  await ref.update({ count: (d.count || 0) + 1, last: now });
  return { allowed: true, remaining: cfg.max - (d.count || 0) - 1, limit: cfg.max, resetAt };
}

async function enforceRate(sessionId, pid, route) {
  const day = new Date().toISOString().slice(0, 10);

  const checks = await Promise.all([
    checkRate(`sess_${sessionId}_route_${route}`, RATE_LIMITS.perSessionPerRoute),
    checkRate(`sess_${sessionId}_all`, RATE_LIMITS.perSessionAllRoutes),
    checkRate(`proj_${pid}_hour`, RATE_LIMITS.perProjectHour),
    checkRate(`proj_${pid}_day_${day}`, RATE_LIMITS.perProjectDay),
    checkRate(`proj_${pid}_route_${route}_hour`, RATE_LIMITS.perProjectPerRouteHour),
  ]);

  const blocked = checks.find((c) => !c.allowed);
  if (blocked) {
    return { allowed: false, retryAfter: blocked.retryAfter, resetAt: blocked.resetAt };
  }
  return { allowed: true };
}

// =========================================================================
// AUTH
// =========================================================================

async function authenticate(req, pid) {
  const apiKey = req.headers["x-project-key"];
  if (apiKey && typeof apiKey === "string") {
    try {
      const ok = await verifyProjectKey(pid, apiKey);
      if (ok) {
        return {
          uid: null,
          role: "editor",
          via: "api-key",
          sessionId: `key_${hashIp(getClientIp(req))}`,
        };
      }
    } catch {}
  }

  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const decoded = verifySession(auth.slice(7).trim());
    if (decoded?.uid) {
      const role = await canAccessProject(decoded.uid, pid).catch(() => null);
      if (role && ["owner", "editor", "viewer", "commenter"].includes(role)) {
        return { uid: decoded.uid, role, via: "session", sessionId: `user_${decoded.uid}` };
      }
    }
  }

  return null;
}

// =========================================================================
// @ALLOW PARSING
// =========================================================================

const ALLOW_LINE_RE = /^\s*\/\/\s*@allow\s+(\S+)\s*$/gm;
const ALLOW_HOST_LINE_RE = /^\s*\/\/\s*@allow-host\s+(\S+)\s*$/gm;

function extractAllowHosts(source) {
  const hosts = new Set();

  for (const re of [ALLOW_LINE_RE, ALLOW_HOST_LINE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const h = normalizeHost(m[1]);
      if (h) hosts.add(h);
    }
  }

  const URLLIKE = /https:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?=[\/:'"`\s])/gi;
  let m;
  while ((m = URLLIKE.exec(source)) !== null) {
    const h = normalizeHost(m[1]);
    if (h) hosts.add(h);
  }

  return [...hosts].filter(h => !isSkippableHost(h));
}

function normalizeHost(host) {
  if (!host || typeof host !== "string") return null;
  let h = host.toLowerCase().trim();
  h = h.replace(/^https?:\/\//, "");
  h = h.split("/")[0].split(":")[0];
  if (!h) return null;
  if (h.length > 253) return null;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h)) return null;
  return h;
}

function isSkippableHost(h) {
  if (FOLIO_INTERNAL_HOSTS.has(h)) return true;
  if (h.endsWith(".vercel.app")) return true;
  const SKIP = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "cdn.jsdelivr.net",
    "esm.sh",
    "unpkg.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
  ]);
  return SKIP.has(h);
}

// =========================================================================
// RESERVED ENV BUILDER
// =========================================================================

function buildProjectUrl(ownerUsername, slug, pid) {
  if (ownerUsername && slug) {
    return `${PUBLIC_SITE_BASE}/${encodeURIComponent(ownerUsername)}/project/${encodeURIComponent(slug)}`;
  }
  return `${BASE_URL}/api/host?action=serve&pid=${encodeURIComponent(pid)}&path=index.html`;
}

async function buildReservedEnv(pid, project, deployment, route, reqId) {
  let ownerUsername = project.ownerUsername || null;
  if (!ownerUsername && project.ownerId) {
    try {
      const owner = await getUser(project.ownerId);
      ownerUsername = owner?.profile?.username || null;
      if (ownerUsername) {
        db.ref(`projects/${pid}/ownerUsername`).set(ownerUsername).catch(() => {});
      }
    } catch {}
  }

  const projectUrl = buildProjectUrl(ownerUsername, project.slug, pid);

  return {
    PROJECT_ID: pid,
    PROJECT_NAME: project.name || null,
    PROJECT_SLUG: project.slug || null,
    PROJECT_URL: projectUrl,
    OWNER_USERNAME: ownerUsername,
    OWNER_UID: project.ownerId || null,
    DEPLOYMENT_ID: deployment?.deploymentId || null,
    DEPLOYMENT_URL: deployment?.url || projectUrl,
    FOLIO_BASE_URL: BASE_URL,
    FOLIO_API_URL: `${BASE_URL}/api`,
    API_ROUTE: route,
    REQUEST_ID: reqId,
  };
}

// =========================================================================
// CHROMIUM LIFECYCLE
// =========================================================================

let _chromiumModule = null;
let _puppeteerModule = null;

async function loadChromiumModules() {
  if (_chromiumModule && _puppeteerModule) {
    return { chromium: _chromiumModule, puppeteer: _puppeteerModule };
  }
  const [chromiumMod, puppeteerMod] = await Promise.all([
    import("@sparticuz/chromium-min").then((m) => m.default || m),
    import("puppeteer-core").then((m) => m.default || m),
  ]);
  _chromiumModule = chromiumMod;
  _puppeteerModule = puppeteerMod;
  return { chromium: chromiumMod, puppeteer: puppeteerMod };
}

async function launchBrowser(reqId, startTime) {
  stageLog(reqId, "chromium_modules_loading", startTime);

  const { chromium, puppeteer } = await loadChromiumModules();

  stageLog(reqId, "chromium_modules_loaded", startTime);

  const executablePath = await chromium.executablePath(CHROMIUM_PACK_URL);

  stageLog(reqId, "chromium_extracted", startTime, { executablePath });

  try {
    fs.mkdirSync("/tmp/.chromium/profile", { recursive: true });
  } catch {}

  stageLog(reqId, "chromium_launch_started", startTime);

  const browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-sandbox",
      "--single-process",
      "--no-zygote",
      "--disable-setuid-sandbox",
      "--disable-features=HttpsFirstBalancedModeAutoEnable",
      "--user-data-dir=/tmp/.chromium/profile",
    ],
    executablePath,
    headless: "shell",
    defaultViewport: { width: 1280, height: 720 },
    timeout: CHROMIUM_LAUNCH_TIMEOUT_MS,
  });

  stageLog(reqId, "chromium_launch_done", startTime);

  return browser;
}

async function closeBrowserQuietly(browser) {
  if (!browser) return;
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 2000)),
    ]);
  } catch {
    try { browser.process()?.kill("SIGKILL"); } catch {}
  }
}

// =========================================================================
// INTERNAL HOST HANDLER — serves /api/host?action=db/* and verify-session
// inside the sandbox without a real network round-trip.
// =========================================================================

async function handleInternalDbRequest(pid, url, req) {
  const action = url.searchParams.get("action");
  const reqId = newReqId();

  try {
    if (action === "db/get") {
      const [data, schema] = await Promise.all([
        projectDb.dbRead(pid),
        projectDb.dbSchemaGet(pid),
      ]);
      const used = JSON.stringify(data || {}).length;
      const LIMIT = 15 * 1024 * 1024;
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: data || {},
          schema: schema || null,
          space: {
            used,
            remaining: Math.max(0, LIMIT - used),
            limit: LIMIT,
            percentUsed: Math.min(100, Math.round((used / LIMIT) * 1000) / 10),
          },
        }),
      };
    }

    if (action === "db/set") {
      const body = typeof req.body === "object" ? req.body : {};
      const { key, value, data, mode } = body;

      if (key !== undefined) {
        const result = await projectDb.dbWritePath(pid, key, value);
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, mode: "path", key, space: result.space }),
        };
      }
      if (data !== undefined && mode === "merge") {
        const result = await projectDb.dbMerge(pid, data);
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, mode: "merge", space: result.space }),
        };
      }
      if (data !== undefined && mode === "replace") {
        const result = await projectDb.dbReplace(pid, data, { reqId });
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, mode: "replace", space: result.space }),
        };
      }
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Missing key or data+mode" }),
      };
    }

    if (action === "db/batch") {
      const { updates } = typeof req.body === "object" ? req.body : {};
      const result = await projectDb.dbBatch(pid, updates);
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          pathsWritten: result.pathsWritten,
          space: result.space,
        }),
      };
    }

    if (action === "db/increment") {
      const { key, by } = typeof req.body === "object" ? req.body : {};
      const result = await projectDb.dbIncrement(pid, key, by);
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, path: result.path, value: result.value }),
      };
    }

    // ── NEW: db/cas ───────────────────────────────────────────────
    if (action === "db/cas") {
      const body = typeof req.body === "object" ? req.body : {};
      const { key, expected, value } = body;
      if (!("expected" in body)) {
        return {
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "Missing expected field" }),
        };
      }
      const result = await projectDb.dbCas(pid, key, expected, value);
      if (!result.applied) {
        return {
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: "Value changed — CAS conflict",
            expected,
            current: result.current,
          }),
        };
      }
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, path: result.path, applied: true }),
      };
    }

    // ── NEW: db/schema ────────────────────────────────────────────
    if (action === "db/schema") {
      const body = typeof req.body === "object" ? req.body : {};
      const schema = body.schema;
      if (!schema || typeof schema !== "object") {
        return {
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "Missing schema" }),
        };
      }
      await projectDb.dbSchemaSet(pid, schema);
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      };
    }

    // ── NEW: db/snapshots (list) ──────────────────────────────────
    if (action === "db/snapshots") {
      const result = await projectDb.dbSnapshotList(pid);
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, ...result }),
      };
    }

    // ── NEW: db/restore-snapshot ──────────────────────────────────
    if (action === "db/restore-snapshot") {
      const body = typeof req.body === "object" ? req.body : {};
      const ts = body.ts;
      if (!ts) {
        return {
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "Missing ts" }),
        };
      }
      const result = await projectDb.dbSnapshotRestore(pid, ts);
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, ...result }),
      };
    }

    // ── NEW: verify-session ───────────────────────────────────────
    // Lets sandbox scripts validate REQ.headers.authorization without
    // exposing JWT_SECRET. Mirrors host.js handleVerifySession.
    if (action === "verify-session") {
      const auth = req.headers?.authorization || "";
      if (!auth.startsWith("Bearer ")) {
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ valid: false }),
        };
      }
      const decoded = verifySession(auth.slice(7).trim());
      if (!decoded?.uid) {
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ valid: false }),
        };
      }
      const user = await getUser(decoded.uid);
      if (!user) {
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ valid: false }),
        };
      }
      if (user.mode === "banned") {
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ valid: false, reason: "banned" }),
        };
      }
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          valid: true,
          uid: decoded.uid,
          username: user.profile?.username || null,
        }),
      };
    }

    if (action === "db/list") {
      const path = url.searchParams.get("path") || "";
      const result = await projectDb.dbList(pid, path, {
        orderBy: url.searchParams.get("orderBy") || null,
        limit: url.searchParams.get("limit"),
        startAt: url.searchParams.get("startAt"),
        endAt: url.searchParams.get("endAt"),
      });
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, ...result }),
      };
    }

    return {
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: `Unknown db action: ${action}` }),
    };
  } catch (err) {
    log("run.internal_db_failed", { pid, action, message: err.message });
    return {
      status: err.status || 500,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: err.message || "Database operation failed" }),
    };
  }
}

// =========================================================================
// HTML PAGE BUILDER
// =========================================================================

function escapeJsonForInline(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function buildPageHtml({ userCode, env, files, reqObj }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script>
  window.ENV = Object.freeze(${escapeJsonForInline(env)});
  window.FILES = Object.freeze(${escapeJsonForInline(files)});
  window.REQ = Object.freeze(${escapeJsonForInline(reqObj)});
</script>
</head>
<body>
<script type="module">
(async () => {
  try {
    const result = await (async () => {
${userCode}
    })();

    let contentType = "application/json";
    let body = result;
    let status = 200;

    if (result && typeof result === "object" && !Array.isArray(result)) {
      if ("__contentType" in result) {
        contentType = String(result.__contentType);
        body = result.__body !== undefined ? result.__body : null;
      }
      if ("__status" in result) {
        status = Number(result.__status) || 200;
      }
    } else if (typeof result === "string") {
      contentType = "text/plain; charset=utf-8";
      body = result;
    }

    let serialized;
    if (typeof body === "string") {
      serialized = body;
    } else if (body === undefined || body === null) {
      serialized = "null";
    } else {
      try {
        const s = JSON.stringify(body);
        serialized = typeof s === "string" ? s : "null";
      } catch {
        serialized = "null";
      }
    }

    window.__RESULT__ = {
      ok: true,
      status,
      contentType,
      body: serialized,
      bodyBytes: serialized.length,
    };
  } catch (err) {
    window.__RESULT__ = {
      ok: false,
      errorName: err && err.name ? String(err.name).slice(0, 100) : "Error",
      errorMessage: String(err && err.message ? err.message : err).slice(0, 500),
    };
  }
})();
</script>
</body>
</html>`;
}

// =========================================================================
// PAGE EXECUTION
// =========================================================================

async function runInPage(browser, { html, allowedHostsSet, pid, reqId, startTime }) {
  stageLog(reqId, "new_page_started", startTime);
  const page = await browser.newPage();
  stageLog(reqId, "new_page_done", startTime);

  const SANDBOX_URL = `${BASE_URL}/__sandbox`;

  const fetchHosts = new Set();

  try {
    await page.setRequestInterception(true);

    page.on("request", async (request) => {
      try {
        if (request.url() === SANDBOX_URL) {
          return await request.respond({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: html,
          });
        }

        const urlObj = new URL(request.url());
        const host = urlObj.hostname.toLowerCase();

        if (
          urlObj.protocol === "data:" ||
          urlObj.protocol === "about:" ||
          urlObj.protocol === "blob:"
        ) {
          return await request.continue();
        }

        if (FOLIO_INTERNAL_HOSTS.has(host)) {
          // Internal routes handled inline — no network round-trip.
          //   /api/host?action=db/*              → database ops
          //   /api/host?action=verify-session    → JWT validation
          if (urlObj.pathname === "/api/host") {
            const act = urlObj.searchParams.get("action") || "";
            if (act.startsWith("db/") || act === "verify-session") {
              try {
                let reqBody = {};
                try {
                  const postData = request.postData();
                  if (postData) reqBody = JSON.parse(postData);
                } catch {}
                const result = await handleInternalDbRequest(
                  pid,
                  urlObj,
                  {
                    body: reqBody,
                    method: request.method(),
                    headers: request.headers(),
                  },
                );
                return await request.respond({
                  status: result.status,
                  contentType: result.contentType,
                  body: result.body,
                });
              } catch (err) {
                log("run.internal_host_route_failed", { reqId, pid, act, message: err.message });
                return await request.abort("failed");
              }
            }
          }
          return await request.abort("blockedbyclient");
        }

        if (urlObj.protocol !== "https:") {
          return await request.abort("blockedbyclient");
        }

        if (TRUSTED_IMAGE_HOSTS.has(host)) {
          fetchHosts.add(host);
          return await request.continue();
        }

        if (
          BUILTIN_ALLOWED_HOSTS.has(host) ||
          ALLOWED_IMPORT_HOSTS.has(host) ||
          allowedHostsSet.has(host)
        ) {
          fetchHosts.add(host);
          return await request.continue();
        }

        log("run.host_blocked", { reqId, host, pid });
        try {
          logProjectEvent(pid, null, "api", "host_blocked", { host, route: null }).catch(() => {});
        } catch {}

        return await request.abort("blockedbyclient");
      } catch (err) {
        log("run.request_intercept_error", { reqId, message: err.message });
        try { await request.abort("failed"); } catch {}
      }
    });

    stageLog(reqId, "goto_started", startTime);

    await page.goto(SANDBOX_URL, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_SETUP_TIMEOUT_MS,
    });

    stageLog(reqId, "goto_done", startTime);

    stageLog(reqId, "waitforfunction_started", startTime);

    await page.waitForFunction(
      () => window.__RESULT__ !== undefined,
      { timeout: USER_CODE_TIMEOUT_MS, polling: 50 },
    );

    stageLog(reqId, "waitforfunction_done", startTime);

    const result = await page.evaluate(() => window.__RESULT__);
    return { ok: true, result, fetchHosts: [...fetchHosts] };
  } catch (err) {
    const isTimeout = /timeout|Timed out/i.test(err.message);
    return {
      ok: false,
      isTimeout,
      errorName: err.name || "Error",
      errorMessage: err.message || "Unknown error",
      fetchHosts: [...fetchHosts],
    };
  } finally {
    try { await page.close(); } catch {}
  }
}

// =========================================================================
// LOADERS
// =========================================================================

async function loadInvocationContext(pid, route) {
  const [projectSnap, deploymentSnap, publicFilesSnap, apiRoutesSnap] = await Promise.all([
    db.ref(`projects/${pid}`).once("value"),
    db.ref(`projects/${pid}/deployment`).once("value"),
    db.ref(`projects/${pid}/publicFileList`).once("value"),
    db.ref(`projects/${pid}/apiRoutes`).once("value"),
  ]);

  if (!projectSnap.exists()) return null;

  const project = { pid, ...projectSnap.val() };
  const deployment = deploymentSnap.exists() ? deploymentSnap.val() : null;
  const publicFiles = publicFilesSnap.exists()
    ? publicFilesSnap.val()
    : { files: [], count: 0, totalBytes: 0 };
  const apiRoutes = apiRoutesSnap.exists() ? apiRoutesSnap.val() : { system: [], user: [] };

  const isSystemRoute = Array.isArray(apiRoutes.system) && apiRoutes.system.includes(route);
  const isUserRoute = Array.isArray(apiRoutes.user) && apiRoutes.user.includes(route);

  return { project, deployment, publicFiles, apiRoutes, isSystemRoute, isUserRoute };
}

async function loadRouteFile(pid, route, isSystemRoute) {
  const candidates = [];

  if (isSystemRoute) {
    candidates.push(sanitizeFirebasePath("_system.js"));
    candidates.push(sanitizeFirebasePath("api___system.js"));
  }

  candidates.push(sanitizeFirebasePath(`api/${route}.js`.replace(/\//g, "__")));
  candidates.push(sanitizeFirebasePath(`${route}.js`));

  for (const key of candidates) {
    const snap = await db.ref(`api-files/${pid}/${key}`).once("value");
    if (snap.exists()) {
      const data = snap.val();
      if (data?.content && typeof data.content === "string") {
        return data.content;
      }
    }
  }
  return null;
}

// =========================================================================
// MAIN HANDLER
// =========================================================================

export default async function handler(req, res) {
  const reqId = newReqId();
  const startTime = Date.now();
  _lastStage = "entered";

  stageLog(reqId, "entered", startTime, {
    method: req.method,
    pid: req.query?.pid || null,
    username: req.query?.username || null,
    project: req.query?.project || null,
    route: req.query?.route || null,
  });

  res.setHeader("X-Request-Id", reqId);
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();

  // ── Parse query params (set by Vercel rewrites) ─────────────────
  let pid = String(req.query?.pid || "").trim();
  let username = String(req.query?.username || "").trim().toLowerCase();
  let projectSlug = String(req.query?.project || "").trim();
  let route = String(req.query?.route || "").trim();

  // ── Fallback: parse URL directly for /api/{pid}/{route} ─────────
  if (!pid && !username) {
    const urlPath = String(req.url || "").split("?")[0];
    const parts = urlPath.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    pid = parts[0] || "";
    route = route || (parts[1] || "");
  }

  route = route.replace(/\.js$/i, "").trim();

  stageLog(reqId, "query_parsed", startTime, { pid, route });

  // ── Resolve pid from slug if only username + project given ───────
  let resolutionError = null;
  if (!pid && username && projectSlug) {
    pid = await resolveProjectBySlug(username, projectSlug);
    if (!pid) resolutionError = "Project not found";
    stageLog(reqId, "slug_resolved", startTime, { pid: pid || null });
  }

  if (!pid) {
    return res.status(400).json({
      success: false,
      error: resolutionError || "Missing pid or username/project",
    });
  }

  if (!route) {
    return res.status(400).json({ success: false, error: "Missing route" });
  }

  if (!/^[a-z0-9_-]+$/i.test(route)) {
    return res.status(400).json({ success: false, error: "Invalid route name" });
  }

  // ── Recursion depth ────────────────────────────────────────────
  const depthHeader = String(req.headers["x-recursion-depth"] || "0");
  const depth = Math.max(0, Math.min(10, parseInt(depthHeader, 10) || 0));
  if (depth >= MAX_RECURSION_DEPTH) {
    return res.status(508).json({ success: false, error: "Recursion limit exceeded", route });
  }

  // ── Auth ───────────────────────────────────────────────────────
  const actor = await authenticate(req, pid).catch(() => null);

  stageLog(reqId, "auth_done", startTime, { via: actor?.via || "anon" });

  // ── Rate limit ─────────────────────────────────────────────────
  const sessionId = actor?.sessionId || `anon_${hashIp(getClientIp(req))}`;
  const rate = await enforceRate(sessionId, pid, route).catch(() => ({
    allowed: false,
    retryAfter: 60,
  }));
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfter || 60));
    return res.status(429).json({
      success: false,
      error: "Rate limit exceeded",
      retryAfter: rate.retryAfter,
    });
  }

  stageLog(reqId, "rate_done", startTime);

  // ── Load invocation context ────────────────────────────────────
  const ctx = await loadInvocationContext(pid, route);
  stageLog(reqId, "ctx_loaded", startTime, {
    isSystemRoute: ctx?.isSystemRoute || false,
    isUserRoute: ctx?.isUserRoute || false,
  });

  if (!ctx) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }

  // ── Route-not-found with self-heal fallback ────────────────────
  if (!ctx.isSystemRoute && !ctx.isUserRoute) {
    // Manifest may be stale (deploy wrote it best-effort). Check
    // the file tree directly before giving up.
    const fileSnap1 = await db.ref(`api-files/${pid}/api__${route}.js`).once("value");
    const fileSnap2 = fileSnap1.exists()
      ? fileSnap1
      : await db.ref(`api-files/${pid}/${route}.js`).once("value");
    if (!fileSnap2.exists()) {
      return res.status(404).json({ success: false, error: "Route not found", route });
    }
    // Self-heal the manifest in the background
    db.ref(`projects/${pid}/apiRoutes/user`).transaction((cur) => {
      const arr = Array.isArray(cur) ? cur : [];
      if (!arr.includes(route)) arr.push(route);
      return arr;
    }).catch(() => {});
    ctx.isUserRoute = true;
    stageLog(reqId, "route_self_healed", startTime, { route });
  }

  // ── Load route file ────────────────────────────────────────────
  const userCode = await loadRouteFile(pid, route, ctx.isSystemRoute);
  stageLog(reqId, "route_file_loaded", startTime, {
    bytes: userCode ? userCode.length : 0,
  });

  if (!userCode || !userCode.trim()) {
    return res.status(404).json({ success: false, error: "Route file not found", route });
  }

  // ── Allowed hosts from manifest ────────────────────────────────
  let declaredHostsSet = new Set();
  let driftDetected = false;

  try {
    const fileHosts = extractAllowHosts(userCode);
    const allowedHostsSnap = await db.ref(`projects/${pid}/allowedHosts`).once("value");
    const manifest = allowedHostsSnap.exists() ? allowedHostsSnap.val() : {};

    for (const host of fileHosts) {
      const entry = manifest[host];
      if (entry && entry.validatedOk) {
        declaredHostsSet.add(host);
      } else {
        driftDetected = true;
      }
    }

    for (const [host, meta] of Object.entries(manifest)) {
      if (meta && meta.validatedOk) declaredHostsSet.add(host);
    }

    if (driftDetected) {
      log("run.host_drift_detected", { reqId, pid, route });
      logProjectEvent(pid, actor?.uid || null, "api", "host_drift_detected", { route }).catch(
        () => {},
      );
    }

    stageLog(reqId, "hosts_parsed", startTime, { allowedHosts: [...declaredHostsSet] });
  } catch (err) {
    log("run.allow_parse_failed", { reqId, pid, route, message: err.message });
    return res.status(500).json({ success: false, error: "Failed to parse @allow hosts" });
  }

  // ── Build ENV ──────────────────────────────────────────────────
  let env = {};
  try {
    const reserved = await buildReservedEnv(pid, ctx.project, ctx.deployment, route, reqId);
    const userSecrets = await projectSecrets.readAllSecrets(pid);
    env = { ...userSecrets, ...reserved };

    stageLog(reqId, "secrets_loaded", startTime, {
      envKeys: Object.keys(env).length,
    });
  } catch (err) {
    log("run.secrets_failed", { reqId, pid, message: err.message });
    return res.status(500).json({ success: false, error: "Failed to load secrets" });
  }

  // ── Build REQ object ───────────────────────────────────────────
  //
  // Curated header allowlist — enough for auth, content negotiation,
  // and referrer-based logic, without leaking cookies or internal
  // proxy headers into the sandbox.
  const FORWARDED_HEADERS = [
    "content-type",
    "user-agent",
    "authorization",
    "accept",
    "accept-language",
    "referer",
    "origin",
    "x-request-id",
  ];
  const forwarded = {};
  for (const h of FORWARDED_HEADERS) {
    if (req.headers[h]) forwarded[h] = req.headers[h];
  }
  if (req.headers["x-forwarded-for"]) {
    forwarded["x-forwarded-for"] = hashIp(req.headers["x-forwarded-for"]);
  }

  const reqObj = {
    route,
    method: req.method,
    headers: forwarded,
    body: typeof req.body === "object" && req.body !== null ? req.body : {},
    query: req.query || {},
    pid,
    username: username || null,
    projectSlug: projectSlug || null,
    projectName: ctx.project.name || null,
    deployedAt: ctx.deployment?.deployedAt || null,
    deploymentId: ctx.deployment?.deploymentId || null,
    versionId: ctx.deployment?.versionId || null,
    gitCommit: ctx.deployment?.gitCommit || null,
    deploymentUrl: ctx.deployment?.url || null,
    apiFileCount:
      (ctx.apiRoutes?.user?.length || 0) + (ctx.apiRoutes?.system?.length || 0),
    publicFileCount: ctx.publicFiles?.count || 0,
    publicFileList: ctx.publicFiles?.files || [],
    region: process.env.VERCEL_REGION || null,
    runtime: "chromium",
    startTime,
    lastError: null,
    lastErrorAt: null,
    sitemapUrl: null,
    depth,
    caller: depth > 0 ? { route: req.headers["x-caller-route"] || null, depth } : undefined,
  };

  const files = {
    files: ctx.publicFiles?.files || [],
    count: ctx.publicFiles?.count || 0,
    totalBytes: ctx.publicFiles?.totalBytes || 0,
  };

  stageLog(reqId, "env_built", startTime);

  const html = buildPageHtml({ userCode, env, files, reqObj });
  stageLog(reqId, "html_built", startTime, { htmlBytes: html.length });

  // Body size check
  const bodyBytes = JSON.stringify(reqObj.body).length;
  if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
    return res.status(413).json({
      success: false,
      error: `Request body exceeds ${MAX_REQUEST_BODY_BYTES / 1024} KB`,
    });
  }

  // ── Execute ────────────────────────────────────────────────────
  let browser = null;
  let runResult = null;

  try {
    stageLog(reqId, "browser_launch_started", startTime);

    browser = await launchBrowser(reqId, startTime);

    stageLog(reqId, "browser_launched", startTime);

    runResult = await runInPage(browser, {
      html,
      allowedHostsSet: declaredHostsSet,
      pid,
      reqId,
      startTime,
    });

    stageLog(reqId, "page_executed", startTime, {
      runOk: runResult?.ok || false,
      errorMessage: runResult?.errorMessage || null,
    });
  } catch (err) {
    log("run.launch_or_execute_failed", { reqId, pid, route, message: err.message });
    runResult = {
      ok: false,
      isTimeout: /timeout/i.test(err.message),
      errorName: err.name || "Error",
      errorMessage: err.message,
      fetchHosts: [],
    };
  } finally {
    await closeBrowserQuietly(browser);
    stageLog(reqId, "browser_closed", startTime);
  }

  const durationMs = Date.now() - startTime;

  // ── Failure ────────────────────────────────────────────────────
  if (!runResult.ok) {
    const status = runResult.isTimeout ? 504 : 500;
    const message = runResult.isTimeout ? "Function timed out" : "Function threw an error";

    await db.ref(`projects/${pid}/apiLastError`).set({
      name: runResult.errorName || "Error",
      at: Date.now(),
      route,
    }).catch(() => {});

    await logProjectEvent(pid, actor?.uid || null, "api", `run.${route}`, {
      status,
      durationMs,
      errorName: runResult.errorName || "Error",
      fetchHosts: runResult.fetchHosts || [],
    }).catch(() => {});

    log("run.execution_failed", {
      reqId,
      pid,
      route,
      status,
      durationMs,
      message: runResult.errorMessage,
    });

    if (ctx.isUserRoute && !ctx.isSystemRoute) {
      recordApiLog(pid, {
        route,
        method: req.method,
        status,
        durationMs,
        errorName: runResult.errorName || "Error",
        errorMessage: runResult.errorMessage || null,
        via: actor?.via || "anon",
        requestId: reqId,
        stage: _lastStage,
        bytesIn: bodyBytes,
        bytesOut: 0,
        fetchHosts: runResult.fetchHosts || [],
        userAgent: (req.headers["user-agent"] || "").slice(0, 200),
        ipHash: hashIp(getClientIp(req)),
        deploymentId: ctx.deployment?.deploymentId || null,
      }).catch(() => {});
    }

    return res.status(status).json({ success: false, error: message, route });
  }

  // ── Response ───────────────────────────────────────────────────
  const { result } = runResult;

  let responseBody;
  if (typeof result?.body === "string") {
    responseBody = result.body;
  } else if (result?.body === undefined || result?.body === null) {
    responseBody = "null";
  } else {
    try {
      const s = JSON.stringify(result.body);
      responseBody = typeof s === "string" ? s : "null";
    } catch {
      responseBody = "null";
    }
  }

  if (typeof responseBody !== "string") responseBody = String(responseBody);

  const responseBytes = Buffer.byteLength(responseBody, "utf8");
  const responseStatus = Number(result?.status) || 200;

  if (responseBytes > MAX_RESPONSE_BYTES) {
    await logProjectEvent(pid, actor?.uid || null, "api", `run.${route}`, {
      status: 413,
      durationMs,
      bytesOut: responseBytes,
      fetchHosts: runResult.fetchHosts || [],
    }).catch(() => {});
    return res.status(413).json({ success: false, error: "Response too large" });
  }

  await logProjectEvent(pid, actor?.uid || null, "api", `run.${route}`, {
    status: responseStatus,
    durationMs,
    bytesOut: responseBytes,
    fetchHosts: runResult.fetchHosts || [],
  }).catch(() => {});

  log("run.completed", {
    reqId,
    pid,
    route,
    status: responseStatus,
    durationMs,
    bytesOut: responseBytes,
    fetchHosts: runResult.fetchHosts || [],
    via: actor?.via || "anon",
  });

  if (ctx.isUserRoute && !ctx.isSystemRoute) {
    recordApiLog(pid, {
      route,
      method: req.method,
      status: responseStatus,
      durationMs,
      errorName: null,
      errorMessage: null,
      via: actor?.via || "anon",
      requestId: reqId,
      stage: _lastStage,
      bytesIn: bodyBytes,
      bytesOut: responseBytes,
      fetchHosts: runResult.fetchHosts || [],
      userAgent: (req.headers["user-agent"] || "").slice(0, 200),
      ipHash: hashIp(getClientIp(req)),
      deploymentId: ctx.deployment?.deploymentId || null,
    }).catch(() => {});
  }

  stageLog(reqId, "completed", startTime, { status: responseStatus, bytes: responseBytes });

  res.setHeader("Content-Type", result?.contentType || "application/json");
  res.setHeader("X-Execution-Time", String(durationMs));
  res.setHeader("X-Fetch-Hosts", (runResult.fetchHosts || []).join(","));

  return res.status(responseStatus).send(responseBody);
}

// =========================================================================
// VERCEL CONFIG
// =========================================================================

export const config = {
  runtime: "nodejs",
  memory: 1024,
  maxDuration: 30,
};

export { BASE_URL, PUBLIC_SITE_BASE };