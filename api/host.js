// api/host.js
// ═══════════════════════════════════════════════════════════════════
//  Folio — Host API
//  ────────────────────────────────────────────────────────────────
//  Single entry point for all project operations:
//    - Deploy (files + api/*.js + manifests)
//    - Serve (public files, secret injection)
//    - Files, versions, DB, secrets, api keys, invites, visibility
//    - System routes (api/_system.js templates)
//
//  ⚠  BASE_URL is defined ONCE at the top of this file.
//  ⚠  Change it there when you move to a custom domain.
//  ⚠  Do not hardcode "foliostudios.vercel.app" anywhere else.
// ═══════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import dns from "node:dns/promises";
import { db } from "../utils/firebase.js";
import { log, newReqId } from "../utils/log.js";
import * as projectDb from "../utils/projectdb.js";
import * as projectSecrets from "../utils/projectsecret.js";
import {
  requireAuth,
  requireProjectRole,
  canAccessProject,
  canEditProject,
  hasVisibility,
  verifyProjectKey,
  generateApiKey,
  generateInviteToken,
  getUserByUsername,
  getUser,
  cleanUsername,
  getClientIp,
  hashIp,
  sanitizeFirebasePath,
  logUserEvent,
  logProjectEvent,
  logProjectApiCall,
  listUserProjects,
  createProjectRecord,
  deleteProjectRecord,
  verifySession,
} from "../utils/users.js";

// =========================================================================
// BASE URL — the only place it's defined
// =========================================================================

const BASE_URL =
  process.env.BASE_URL ||
  process.env.NEXT_PUBLIC_BASE_URL ||
  "https://foliostudios.vercel.app";

const API_NAME = "host";

// =========================================================================
// CONSTANTS
// =========================================================================

const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

const MAX_DEPLOYMENTS_PER_PROJECT = 5;
const DEPLOY_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEPLOY_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const DEPLOY_PARALLEL_WRITES = 5;

const MAX_SERVE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_PATH_LENGTH = 500;
const MAX_PATH_SEGMENT_LENGTH = 100;

const MAX_LOG_ENTRIES_PER_PROJECT = 200;
const LOG_PRUNE_EVERY_N_WRITES = 20;

const PROJECT_CACHE_TTL = 60_000;
const META_CACHE_TTL = 60_000;
const RATE_CACHE_TTL = 2_000;
const TOUCH_MIN_INTERVAL = 30_000;

const CLIENT_ERROR_RATE_LIMIT = 10;
const CLIENT_ERROR_RATE_WINDOW_MS = 60_000;

const BOT_UA_RE =
  /bot|crawler|spider|preview|curl|wget|python-requests|httpclient/i;

// ── API folder (private runtime) ────────────────────────────────────

const MAX_API_FILES = 10;
const MAX_API_FILE_BYTES = 50 * 1024;
const MAX_API_TOTAL_BYTES = 200 * 1024;
const MAX_ALLOW_LINES_PER_FILE = 20;
const MAX_UNIQUE_ALLOW_HOSTS = 50;
const API_SYSTEM_FILENAME = "_system.js";

const RESERVED_API_NAMES = new Set([
  "index.js", "run.js",
  "health.js", "whoami.js", "files.js", "status.js", "version.js", "robots.js",
]);

const BUILTIN_ALLOWED_HOSTS = new Set([
  "api.openai.com",
  "api.groq.com",
  "api.anthropic.com",
  "api.stripe.com",
  "api.supabase.co",
  "api.resend.com",
]);

const FOLIO_INTERNAL_HOSTS = new Set([
  "folio",
  new URL(BASE_URL).hostname,
]);

// ── Reserved usernames and slugs ────────────────────────────────────

const RESERVED_USERNAMES = new Set([
  "api", "p", "register", "profile", "project", "tools", "settings",
  "analytics", "offline", "invite", "notifications", "icons", "js", "css",
  "_next", "manifest.json", "sitemap.xml", "robots.txt", "favicon.ico",
  "sw.js", "firebase-messaging-sw.js",
]);

const RESERVED_SLUGS = new Set([
  "api", "p", "register", "profile", "project", "projects", "tools",
  "settings", "analytics", "offline", "invite", "notifications", "icons",
  "js", "css", "_next",
]);

function slugifyProjectName(name) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  if (!base) return "";
  if (RESERVED_SLUGS.has(base)) return `${base}-site`;
  return base;
}

// =========================================================================
// RATE LIMITS
// =========================================================================

const RATE_LIMITS = {
  deploy: { max: 10, window: 60 * 60 * 1000 },
  redeploy: { max: 10, window: 60 * 60 * 1000 },
  status: { max: 120, window: 60 * 60 * 1000 },
  dbSchema: { max: 10, window: 60 * 60 * 1000 },
  apikeyGenerate: { max: 5, window: 60 * 60 * 1000 },
  visibility: { max: 20, window: 60 * 60 * 1000 },
  fileVisibility: { max: 100, window: 60 * 60 * 1000 },
  inviteCreate: { max: 20, window: 60 * 60 * 1000 },
  inviteList: { max: 60, window: 60 * 60 * 1000 },
  inviteAccept: { max: 10, window: 60 * 60 * 1000 },
  inviteCancel: { max: 20, window: 60 * 60 * 1000 },
  collaboratorRemove: { max: 20, window: 60 * 60 * 1000 },
  metatagsSave: { max: 20, window: 60 * 60 * 1000 },
  share: { max: 60, window: 60 * 1000 },
  profilePublic: { max: 60, window: 60 * 1000 },
  view: { max: 10, window: 60 * 1000 },
  logs: { max: 60, window: 60 * 60 * 1000 },
  projectsList: { max: 60, window: 60 * 60 * 1000 },
  projectsGet: { max: 120, window: 60 * 60 * 1000 },
  projectsCreate: { max: 20, window: 60 * 60 * 1000 },
  projectsDelete: { max: 10, window: 60 * 60 * 1000 },
  projectsUpdate: { max: 60, window: 60 * 60 * 1000 },
  deploymentHistory: { max: 120, window: 60 * 60 * 1000 },
  deploymentOffline: { max: 10, window: 60 * 60 * 1000 },
  deploymentDelete: { max: 20, window: 60 * 60 * 1000 },
  versionsClear: { max: 5, window: 60 * 60 * 1000 },
  cacheClear: { max: 10, window: 60 * 60 * 1000 },
  projectExport: { max: 30, window: 60 * 60 * 1000 },
  projectSyncBack: { max: 60, window: 60 * 60 * 1000 },
  projectCopy: { max: 20, window: 60 * 60 * 1000 },
  fileGet: { max: 120, window: 60 * 60 * 1000 },
  fileList: { max: 120, window: 60 * 60 * 1000 },
  fileDelete: { max: 60, window: 60 * 60 * 1000 },
  fileSave: { max: 300, window: 60 * 60 * 1000 },
  projectHydrate: { max: 60, window: 60 * 60 * 1000 },
  serve: { max: 1200, window: 60 * 1000 },
  clientError: { max: 20, window: 60 * 1000 },
  secretsList:   { max: 60,  window: 60 * 60 * 1000 },
  secretsGet:    { max: 20,  window: 60 * 60 * 1000 },
  secretsSet:    { max: 20,  window: 60 * 60 * 1000 },
  secretsDelete: { max: 20,  window: 60 * 60 * 1000 },
  secretsVisibility: { max: 60, window: 60 * 60 * 1000 },
  apiRoutes: { max: 120, window: 60 * 60 * 1000 },
  apiSystemDefault: { max: 120, window: 60 * 60 * 1000 },
  dbBatch: { max: 100, window: 60 * 1000 },
  dbCas: { max: 200, window: 60 * 1000 },
  dbIncrement: { max: 300, window: 60 * 1000 },
  dbList: { max: 300, window: 60 * 1000 },
  dbBackup: { max: 5, window: 60 * 60 * 1000 },
  dbSet: { max: 300, window: 60 * 1000 },
  dbGet: { max: 600, window: 60 * 1000 },
};

// =========================================================================
// RATE LIMITER
// =========================================================================

async function checkRateLimit(identifier, action) {
  const config = RATE_LIMITS[action];
  if (!config) return { allowed: true };
  const now = Date.now();
  const key = sanitizeFirebasePath(String(identifier).toLowerCase());
  const ref = db.ref(`rate_limit/${API_NAME}/${action}/${key}`);
  const snap = await ref.once("value");

  if (!snap.exists()) {
    await ref.set({ count: 1, first_request: now, last_request: now });
    return {
      allowed: true,
      remaining: config.max - 1,
      limit: config.max,
      reset: new Date(now + config.window).toISOString(),
    };
  }
  const d = snap.val();
  const resetAt = (d.first_request || now) + config.window;
  if (now > resetAt) {
    await ref.set({ count: 1, first_request: now, last_request: now });
    return {
      allowed: true,
      remaining: config.max - 1,
      limit: config.max,
      reset: new Date(now + config.window).toISOString(),
    };
  }
  if ((d.count || 0) >= config.max) {
    return {
      allowed: false,
      remaining: 0,
      limit: config.max,
      reset: new Date(resetAt).toISOString(),
      retryAfter: Math.ceil((resetAt - now) / 1000),
    };
  }
  await ref.update({ count: (d.count || 0) + 1, last_request: now });
  return {
    allowed: true,
    remaining: config.max - (d.count || 0) - 1,
    limit: config.max,
    reset: new Date(resetAt).toISOString(),
  };
}

function setRateHeaders(res, r) {
  if (!r) return;
  if (Number.isFinite(r.limit))
    res.setHeader("X-RateLimit-Limit", String(r.limit));
  if (Number.isFinite(r.remaining))
    res.setHeader("X-RateLimit-Remaining", String(r.remaining));
  if (r.reset) res.setHeader("X-RateLimit-Reset", r.reset);
}

async function enforceRate(req, res, action, identifier) {
  const r = await checkRateLimit(identifier, action);
  setRateHeaders(res, r);
  if (!r.allowed) {
    res.status(429).json({
      success: false,
      error: "Rate limit exceeded",
      retryAfter: r.retryAfter,
      reset: r.reset,
    });
    try {
      await maybeNotifyRateLimitAbuse(action, identifier, r).catch(() => {});
    } catch {}
    return false;
  }
  return true;
}

function ipKey(req) {
  return `ip_${hashIp(getClientIp(req))}`;
}

function isAdminRequest(req) {
  const key = req.headers["x-api-key"] || req.headers["admin-api-key"] || "";
  const expected = process.env.ADMIN_API_KEY || "";
  if (!expected || key.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
  } catch {
    return false;
  }
}

// =========================================================================
// IN-PROCESS CACHES
// =========================================================================

const PROJECT_CACHE = new Map();
const META_CACHE = new Map();
const RATE_CACHE = new Map();
const TOUCH_CACHE = new Map();
const LOG_WRITE_COUNTER = new Map();

function invalidateProject(pid) {
  PROJECT_CACHE.delete(pid);
  META_CACHE.delete(pid);
}

async function getProjectCached(pid) {
  const c = PROJECT_CACHE.get(pid);
  if (c && Date.now() - c.at < PROJECT_CACHE_TTL) return c.project;
  const snap = await db.ref(`projects/${pid}`).once("value");
  const project = snap.exists() ? snap.val() : null;
  if (project) PROJECT_CACHE.set(pid, { project, at: Date.now() });
  return project;
}

async function touchProject(pid, minInterval = TOUCH_MIN_INTERVAL) {
  const last = TOUCH_CACHE.get(pid) || 0;
  if (Date.now() - last < minInterval) return;
  TOUCH_CACHE.set(pid, Date.now());
  await db.ref(`projects/${pid}/updatedAt`).set(Date.now()).catch(() => {});
  invalidateProject(pid);
}

async function maybePruneProjectLogs(pid) {
  const count = (LOG_WRITE_COUNTER.get(pid) || 0) + 1;
  LOG_WRITE_COUNTER.set(pid, count);
  if (count % LOG_PRUNE_EVERY_N_WRITES !== 0) return;
  try {
    const snap = await db.ref(`logs/project/${pid}`).once("value");
    if (!snap.exists()) return;
    const entries = [];
    snap.forEach((c) => entries.push({ id: c.key, ts: c.val()?.ts || 0 }));
    if (entries.length <= MAX_LOG_ENTRIES_PER_PROJECT) return;
    entries.sort((a, b) => a.ts - b.ts);
    const toDelete = entries.slice(0, entries.length - MAX_LOG_ENTRIES_PER_PROJECT);
    const updates = {};
    for (const e of toDelete) updates[`logs/project/${pid}/${e.id}`] = null;
    if (Object.keys(updates).length) await db.ref().update(updates);
  } catch (err) {
    log("host.logs.prune_failed", { pid, message: err.message });
  }
}

// =========================================================================
// STORAGE WARNING HOOK
// =========================================================================

projectDb.setStorageWarningHandler(async (pid, size, limit) => {
  try {
    const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
    if (!ownerSnap.exists()) return;
    const percentUsed = Math.round((size / limit) * 1000) / 10;
    await notifyStorageWarning(
      pid,
      ownerSnap.val(),
      size,
      limit,
      percentUsed,
      size >= limit ? "full" : "nearly_full",
    );
  } catch (err) {
    log("host.storage_warning_failed", { pid, message: err.message });
  }
});

// =========================================================================
// API FOLDER HELPERS
// =========================================================================

function analyzeApiFiles(apiFiles) {
  const valid = {};
  const rejected = [];
  let totalBytes = 0;

  const names = Object.keys(apiFiles).sort();

  for (const name of names) {
    const content = apiFiles[name];

    if (typeof content !== "string") {
      rejected.push({ name, reason: "not a string" });
      continue;
    }
    if (!/\.js$/i.test(name)) {
      rejected.push({ name, reason: "must end in .js" });
      continue;
    }
    if (name !== name.toLowerCase()) {
      rejected.push({ name, reason: "must be lowercase" });
      continue;
    }
    if (name.includes("/")) {
      rejected.push({ name, reason: "no subfolders in api/" });
      continue;
    }
    if (RESERVED_API_NAMES.has(name)) {
      rejected.push({ name, reason: "reserved name" });
      continue;
    }
    if (name.startsWith("_") && name !== API_SYSTEM_FILENAME) {
      rejected.push({ name, reason: "underscore prefix reserved for _system.js" });
      continue;
    }
    if (!/^[a-z0-9_\-]+\.js$/.test(name)) {
      rejected.push({ name, reason: "invalid characters" });
      continue;
    }

    // @allow line count check
    const allowMatches = content.match(/^\s*\/\/\s*@allow\s+\S+\s*$/gm) || [];
    if (allowMatches.length > MAX_ALLOW_LINES_PER_FILE) {
      rejected.push({
        name,
        reason: `exceeds ${MAX_ALLOW_LINES_PER_FILE} @allow lines`,
      });
      continue;
    }

    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_API_FILE_BYTES) {
      rejected.push({ name, reason: `exceeds ${MAX_API_FILE_BYTES / 1024} KB` });
      continue;
    }
    if (totalBytes + bytes > MAX_API_TOTAL_BYTES) {
      rejected.push({ name, reason: `total would exceed ${MAX_API_TOTAL_BYTES / 1024} KB` });
      continue;
    }
    if (Object.keys(valid).length >= MAX_API_FILES) {
      rejected.push({ name, reason: `exceeds ${MAX_API_FILES}-file limit` });
      continue;
    }

    valid[name] = content;
    totalBytes += bytes;
  }

  return {
    valid,
    rejected,
    totalFiles: Object.keys(valid).length,
    totalBytes,
  };
}

const ALLOW_LINE_RE = /^\s*\/\/\s*@allow\s+(\S+)\s*$/gm;

function extractAllowHosts(source) {
  const hosts = new Set();
  let match;
  ALLOW_LINE_RE.lastIndex = 0;
  while ((match = ALLOW_LINE_RE.exec(source)) !== null) {
    hosts.add(match[1].toLowerCase().trim());
  }
  return [...hosts];
}

function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a >= 224 && a <= 239) ||
      a >= 240
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    );
  }
  return true;
}

async function validateAllowHost(host) {
  if (!host || typeof host !== "string") {
    return { ok: false, reason: "Missing host" };
  }
  if (host.length > 253) {
    return { ok: false, reason: "Host too long" };
  }
  if (/^https?:\/\//i.test(host)) {
    return { ok: false, reason: "Scheme not allowed (hostname only)" };
  }
  if (host.includes(":")) {
    return { ok: false, reason: "Port not allowed" };
  }
  if (host.includes("/")) {
    return { ok: false, reason: "Path not allowed" };
  }
  if (host.includes("*")) {
    return { ok: false, reason: "Wildcards not supported" };
  }
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) {
    return { ok: false, reason: "Invalid hostname format" };
  }

  // Reject Folio's own infra
  if (FOLIO_INTERNAL_HOSTS.has(host) || host.endsWith(".vercel.app")) {
    return { ok: false, reason: "Folio infrastructure not allowed" };
  }

  // DNS resolution
  let ips;
  try {
    ips = await dns.lookup(host, { all: true });
  } catch (err) {
    return { ok: false, reason: `Cannot resolve: ${err.code || err.message}` };
  }
  if (!ips || ips.length === 0) {
    return { ok: false, reason: "No IPs resolved" };
  }
  for (const { address } of ips) {
    if (isPrivateOrReservedIp(address)) {
      return { ok: false, reason: `Resolves to private/reserved IP (${address})` };
    }
  }

  // HTTPS reachability (HEAD, 5s)
  try {
    await fetch(`https://${host}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
      redirect: "manual",
    });
  } catch (err) {
    return { ok: false, reason: `Does not respond to HTTPS: ${err.message}` };
  }

  return { ok: true };
}

function getDefaultSystemJs() {
  return `// api/_system.js
// Runs in a browser sandbox. All standard browser globals are available.
// REQ is the request. ENV is the project's secrets. return is the response.

if (REQ.route === "health") {
  return {
    status: "ok",
    pid: REQ.pid,
    deployed: REQ.deployedAt,
    responseMs: Date.now() - REQ.startTime,
  };
}

if (REQ.route === "whoami") {
  return {
    pid: REQ.pid,
    name: REQ.projectName,
    deployedAt: REQ.deployedAt,
    apiVersion: 1,
  };
}

if (REQ.route === "files") {
  return FILES;
}

if (REQ.route === "status") {
  return {
    status: "ok",
    pid: REQ.pid,
    deployed: REQ.deployedAt,
    responseMs: Date.now() - REQ.startTime,
    region: REQ.region,
    runtime: "chromium",
    apiFiles: REQ.apiFileCount,
    publicFiles: REQ.publicFileCount,
    lastError: REQ.lastError,
    lastErrorAt: REQ.lastErrorAt,
  };
}

if (REQ.route === "version") {
  return {
    deploymentId: REQ.deploymentId,
    deployedAt: REQ.deployedAt,
    versionId: REQ.versionId,
    gitCommit: REQ.gitCommit,
    url: REQ.deploymentUrl,
  };
}

if (REQ.route === "robots") {
  return {
    __contentType: "text/plain",
    __body: "User-agent: *\\nAllow: /\\nDisallow: /api/\\n",
  };
}

throw new Error("Unknown system route: " + REQ.route);
`;
}

async function buildPublicFileList(pid) {
  const snap = await db.ref(`files/${pid}`).once("value");
  const files = [];
  let totalBytes = 0;

  if (snap.exists()) {
    snap.forEach((child) => {
      const v = child.val() || {};
      const p = v.path || child.key.replace(/__/g, "/");
      if (!p) return;
      if (p.startsWith("api/") || p === "api") return;
      if (p === "notes.json") return;
      if (/(^|\/)\.gitkeep$/i.test(p) || /(^|\/)\.keep$/i.test(p)) return;

      const bytes = Buffer.byteLength(String(v.content || ""), "utf8");
      files.push({ path: p, bytes, type: mimeFor(p) });
      totalBytes += bytes;
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    count: files.length,
    totalBytes,
    updatedAt: Date.now(),
  };
}

function buildApiRoutes(apiFiles) {
  const system = ["health", "whoami", "files", "status", "version", "robots"];
  const user = Object.keys(apiFiles)
    .filter((name) => name !== API_SYSTEM_FILENAME)
    .map((name) => name.replace(/\.js$/, ""))
    .sort();

  return { system, user, updatedAt: Date.now() };
}

// =========================================================================
// SHARED HELPERS
// =========================================================================

const FALLBACK_OG = { project: null, profile: null };
const FLIER_MEM_CACHE = new Map();
const FLIER_MEM_TTL = 5 * 60 * 1000;
const FLIER_MEM_MAX = 200;
const OG_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const OG_URL_MAX_LENGTH = 500;
const LANGUAGES_CACHE_TTL = 24 * 60 * 60 * 1000;
const THUMBNAIL_SIZE = "512x512";
const OG_SIZE = "1200x630";

const PROJECT_SCENES = ["skyline", "ribbon", "terminal", "vinyl", "shelf", "halftone", "grid_wave", "window_sill"];
const PROFILE_SCENES = ["ribbon", "halftone", "glass_cards", "book_spine", "rooftop", "cassette"];
const PALETTES = ["warm", "cool", "neon", "earth", "sunset", "mono"];

function isBot(req) {
  const ua = req.headers["user-agent"] || "";
  return BOT_UA_RE.test(ua);
}

function dayString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function shortId(pid) {
  return pid.replace(/[^a-z0-9]/gi, "").slice(-8);
}

function nowIso() {
  return new Date().toISOString();
}

function formatTimeAgo(ts) {
  if (!ts) return "—";
  const n = typeof ts === "number" ? ts : new Date(ts).getTime();
  if (!Number.isFinite(n)) return "—";
  const diff = Date.now() - n;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return new Date(n).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function formatDate(ts, { withDay = false } = {}) {
  if (!ts) return "—";
  const n = typeof ts === "number" ? ts : new Date(ts).getTime();
  if (!Number.isFinite(n)) return "—";
  return new Date(n).toLocaleDateString(
    "en-US",
    withDay
      ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", year: "numeric" },
  );
}

function initialsOf(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join("").toUpperCase();
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function avatarHtmlFor(profile, { size = 40, username = "" } = {}) {
  const url = profile?.avatarUrl;
  if (url) {
    return `<img src="${escapeHtml(url)}" alt="" width="${size}" height="${size}" style="object-fit:cover;border-radius:${Math.round(size * 0.28)}px;display:block;">`;
  }
  const initials = initialsOf(profile?.displayName || username || "?");
  return `<span style="display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.28)}px;background:linear-gradient(135deg,#F59E0B,#f97316);color:#0a0c10;font-weight:800;font-size:${Math.round(size * 0.38)}px;">${escapeHtml(initials)}</span>`;
}

function projectIconHtmlFor(project) {
  const url = project?.iconUrl;
  if (url) {
    return `<img src="${escapeHtml(url)}" alt="" width="56" height="56" style="object-fit:cover;border-radius:14px;display:block;">`;
  }
  const initials = initialsOf(project?.name || project?.slug || "?");
  return `<span style="display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#F59E0B,#f97316);color:#0a0c10;font-weight:800;font-size:20px;">${escapeHtml(initials)}</span>`;
}

function inlineSvg(name, size = 16) {
  const icons = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  };
  const body = icons[name] || "";
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

const templateCache = new Map();
function readTemplate(name) {
  if (templateCache.has(name)) return templateCache.get(name);
  const p = path.join(process.cwd(), "public", name);
  const content = fs.readFileSync(p, "utf8");
  templateCache.set(name, content);
  return content;
}

function applyTemplate(template, vars) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in vars)) return "";
    const v = vars[key];
    if (v && typeof v === "object" && v.raw !== undefined) return String(v.raw);
    return String(v ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  });
}

const PAGE_STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
:root{color-scheme:dark}
body{background:#0a0c10;background-image:radial-gradient(circle at 50% -10%,rgba(245,158,11,0.14) 0%,transparent 60%);color:#e8ecf1;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;line-height:1.5}
.card{background:rgba(21,25,34,0.72);border:1px solid rgba(255,255,255,0.09);border-radius:20px;padding:32px 24px;max-width:520px;width:100%;text-align:center}
.icon{width:56px;height:56px;border-radius:16px;background:rgba(245,158,11,0.14);color:#F59E0B;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
h1{font-size:20px;font-weight:800;letter-spacing:-0.4px;margin-bottom:8px}
p{font-size:13px;color:rgba(232,236,241,0.72);margin-bottom:20px}
.actions{display:flex;flex-direction:column;gap:8px}
a.btn{display:flex;align-items:center;justify-content:center;padding:11px 16px;border-radius:10px;font-size:13px;font-weight:700;text-decoration:none;transition:background 0.15s}
a.btn.primary{background:#F59E0B;color:#0a0c10}
a.btn.primary:hover{background:#fbbf24}
a.btn.ghost{background:transparent;color:rgba(232,236,241,0.72);border:1px solid rgba(255,255,255,0.08)}
a.btn.ghost:hover{background:rgba(255,255,255,0.05);color:#e8ecf1}
.subtle{margin-top:14px;font-size:11px;color:rgba(232,236,241,0.5)}
.subtle a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.file-list{list-style:none;text-align:left;margin-top:16px;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px}
.file-list li{border-bottom:1px solid rgba(255,255,255,0.06)}
.file-list li:last-child{border-bottom:none}
.file-list a{display:flex;align-items:center;gap:8px;padding:10px 4px;color:#e8ecf1;text-decoration:none}
.file-list a:hover{background:rgba(255,255,255,0.04)}
.file-list .dir{color:#F59E0B;font-weight:600}
.file-list .meta{margin-left:auto;font-size:10px;color:rgba(232,236,241,0.4)}
`;

function sendHtmlPage(res, {
  title, heading, message, signinUrl, browseUrl = BASE_URL,
  icon = "alert", status = 200, extraHtml = "", robotsNoIndex = true,
}) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0c10">
<meta name="generator" content="Folio">
${robotsNoIndex ? '<meta name="robots" content="noindex,nofollow">' : ""}
<title>${escapeHtml(title)} — Folio</title>
<style>${PAGE_STYLE}</style>
</head><body>
<div class="card">
  <div class="icon">${inlineSvg(icon, 26)}</div>
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(message)}</p>
  ${extraHtml}
  <div class="actions">
    ${signinUrl ? `<a class="btn primary" href="${escapeHtml(signinUrl)}">Sign in</a>` : ""}
    <a class="btn ghost" href="${escapeHtml(browseUrl)}">← Back to Folio</a>
  </div>
</div>
</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (robotsNoIndex) res.setHeader("X-Robots-Tag", "noindex, nofollow");
  return res.status(status).send(html);
}

// =========================================================================
// META
// =========================================================================

const META_KEYS_BY_NAME = new Set([
  "description", "keywords", "author", "robots", "theme-color",
  "twitter:card", "twitter:title", "twitter:description", "twitter:image", "generator",
]);
const META_KEYS_BY_PROP = new Set([
  "og:title", "og:description", "og:image", "og:type", "og:url", "og:site_name", "og:locale",
]);

function buildMetaLines({ project, meta, canonicalUrl, robotsNoIndex }) {
  const lines = [];
  const title = meta?.title || project?.name || "";
  const description = meta?.description || project?.description || "";
  const ogImage = meta?.ogImage || "";
  const ogType = meta?.ogType || "website";
  const twitterCard = meta?.twitterCard || (ogImage ? "summary_large_image" : "summary");

  if (title) lines.push(`<title>${escapeHtml(title)}</title>`);
  if (description) lines.push(`<meta name="description" content="${escapeHtml(description)}">`);
  lines.push(`<meta name="viewport" content="width=device-width, initial-scale=1.0">`);
  lines.push(`<meta name="generator" content="Folio">`);
  lines.push(`<meta name="theme-color" content="${escapeHtml(meta?.themeColor || "#0a0c10")}">`);
  if (robotsNoIndex) lines.push(`<meta name="robots" content="noindex,nofollow">`);
  if (canonicalUrl) lines.push(`<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`);
  lines.push(`<meta property="og:type" content="${escapeHtml(ogType)}">`);
  if (title) lines.push(`<meta property="og:title" content="${escapeHtml(title)}">`);
  if (description) lines.push(`<meta property="og:description" content="${escapeHtml(description)}">`);
  if (canonicalUrl) lines.push(`<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`);
  lines.push(`<meta property="og:site_name" content="Folio">`);
  lines.push(`<meta property="og:locale" content="en_US">`);
  if (ogImage) lines.push(`<meta property="og:image" content="${escapeHtml(ogImage)}">`);
  lines.push(`<meta name="twitter:card" content="${escapeHtml(twitterCard)}">`);
  if (title) lines.push(`<meta name="twitter:title" content="${escapeHtml(title)}">`);
  if (description) lines.push(`<meta name="twitter:description" content="${escapeHtml(description)}">`);
  if (ogImage) lines.push(`<meta name="twitter:image" content="${escapeHtml(ogImage)}">`);
  if (project?.iconUrl) lines.push(`<link rel="icon" href="${escapeHtml(project.iconUrl)}">`);
  return lines;
}

function stripEquivalentTags(html) {
  let cleaned = String(html);
  cleaned = cleaned.replace(/<title>[\s\S]*?<\/title>/i, "");
  cleaned = cleaned.replace(
    /<meta\s+name=["']([^"']+)["'][^>]*>/gi,
    (m, name) => (META_KEYS_BY_NAME.has(name.toLowerCase()) ? "" : m),
  );
  cleaned = cleaned.replace(
    /<meta\s+property=["']([^"']+)["'][^>]*>/gi,
    (m, prop) => (META_KEYS_BY_PROP.has(prop.toLowerCase()) ? "" : m),
  );
  cleaned = cleaned.replace(/<link\s+rel=["']canonical["'][^>]*>/gi, "");
  cleaned = cleaned.replace(/<meta\s+name=["']viewport["'][^>]*>/gi, "");
  cleaned = cleaned.replace(/<meta\s+name=["']generator["'][^>]*>/gi, "");
  cleaned = cleaned.replace(/<meta\s+name=["']theme-color["'][^>]*>/gi, "");
  cleaned = cleaned.replace(/<link\s+rel=["'](?:shortcut\s+)?icon["'][^>]*>/gi, "");
  return cleaned;
}

function injectMetaIntoHtml(html, opts) {
  const lines = buildMetaLines(opts);
  if (lines.length === 0) return html;
  const block = lines.join("\n  ");
  const cleaned = stripEquivalentTags(html);
  if (/<\/head>/i.test(cleaned)) return cleaned.replace(/<\/head>/i, `  ${block}\n</head>`);
  if (/<head[^>]*>/i.test(cleaned)) return cleaned.replace(/<head[^>]*>/i, (m) => m + `\n  ${block}\n`);
  return `<head>\n  ${block}\n</head>\n${cleaned}`;
}

// =========================================================================
// PATH VALIDATION
// =========================================================================

function isValidFilePath(p) {
  if (typeof p !== "string") return false;
  if (!p || p.length > MAX_FILE_PATH_LENGTH) return false;
  if (p.startsWith("/")) return false;
  if (/[\x00-\x1F\x7F]/.test(p)) return false;
  const parts = p.split("/");
  for (const seg of parts) {
    if (!seg || seg === "." || seg === "..") return false;
    if (seg.length > MAX_PATH_SEGMENT_LENGTH) return false;
  }
  return true;
}

function isValidRoutePath(p) {
  if (typeof p !== "string") return false;
  if (p.length > MAX_FILE_PATH_LENGTH) return false;
  if (/[\x00-\x1F\x7F]/.test(p)) return false;
  if (/%2e%2e/i.test(p) || /\.\.\//.test(p) || /\/\.\./.test(p)) return false;
  return true;
}

function filesToSnapshot(files) {
  const snapshot = {};
  for (const [p, c] of Object.entries(files || {})) {
    if (typeof c !== "string") continue;
    const safeKey = sanitizeFirebasePath(p.replace(/\//g, "__"));
    if (!safeKey) continue;
    snapshot[safeKey] = { path: p, content: c };
  }
  return snapshot;
}

function snapshotToFiles(snapshot) {
  const out = {};
  for (const [k, v] of Object.entries(snapshot || {})) {
    if (v && typeof v === "object" && typeof v.path === "string") {
      out[v.path] = v.content ?? "";
    } else if (typeof v === "string") {
      out[k.replace(/__/g, "/")] = v;
    }
  }
  return out;
}

// =========================================================================
// PROJECT LOOKUP
// =========================================================================

async function findProjectBySlug(username, slug) {
  const owner = await getUserByUsername(username);
  if (!owner) return null;
  const snap = await db.ref("projects").orderByChild("ownerId").equalTo(owner.uid).once("value");
  if (!snap.exists()) return null;
  let found = null;
  snap.forEach((child) => {
    const p = child.val();
    if (p.slug === slug) found = { pid: child.key, project: p, owner };
  });
  return found;
}

async function findProjectByUidAndSlug(uid, slug) {
  const user = await getUser(uid);
  if (!user) return null;
  const pids = user.projectIds || {};
  for (const pid of Object.keys(pids)) {
    const snap = await db.ref(`projects/${pid}`).once("value");
    if (!snap.exists()) continue;
    const p = snap.val();
    if (p.slug === slug && p.ownerId === uid) return { pid, project: p };
  }
  return null;
}

async function getProjectOwnerUsername(pid, project) {
  const cached = project?.ownerUsername;
  if (cached) return cached;
  try {
    const ownerId = project?.ownerId;
    if (!ownerId) return null;
    const owner = await getUser(ownerId);
    const username = owner?.profile?.username || null;
    if (username) {
      await db.ref(`projects/${pid}/ownerUsername`).set(username).catch(() => {});
      invalidateProject(pid);
    }
    return username;
  } catch {
    return null;
  }
}

function buildProjectCleanUrl(username, project, pid = null) {
  if (!username) return null;
  const slug = project?.slug || "";
  if (slug) return `${BASE_URL}/${encodeURIComponent(username)}/project/${encodeURIComponent(slug)}`;
  const fallbackPid = pid || project?.pid || null;
  if (!fallbackPid) return `${BASE_URL}/${encodeURIComponent(username)}`;
  return `${BASE_URL}/api/host?action=serve&pid=${encodeURIComponent(fallbackPid)}&path=index.html`;
}

function buildLiveSiteUrl(username, project) {
  const slug = project?.slug || "";
  if (!username || !slug) return null;
  return `${BASE_URL}/${username}/project/${encodeURIComponent(slug)}`;
}

function buildLiveSiteUrlForPath(username, project, relPath) {
  const base = buildLiveSiteUrl(username, project);
  if (!base) return null;
  if (!relPath) return base;
  const clean = String(relPath).replace(/^\/+/, "");
  return base + "/" + clean.split("/").map(encodeURIComponent).join("/");
}

function buildProjectCleanUrlForPath(username, project, relPath) {
  const base = buildProjectCleanUrl(username, project);
  if (!base) return null;
  if (!relPath) return base;
  return base + String(relPath).split("/").map(encodeURIComponent).join("/");
}

// =========================================================================
// MIME + LANGUAGE
// =========================================================================

const MIME_TYPES = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8", js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8", cjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8", svg: "image/svg+xml",
  xml: "application/xml; charset=utf-8", yml: "text/yaml; charset=utf-8",
  yaml: "text/yaml; charset=utf-8", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", zip: "application/zip",
};

function mimeFor(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function isBinaryMime(mime) {
  return mime && !/^text\/|^application\/(javascript|json|xml)|^image\/svg/i.test(mime);
}

const LANG_MAP = {
  html: "HTML", htm: "HTML", css: "CSS", scss: "CSS", sass: "CSS", less: "CSS",
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JSX",
  ts: "TypeScript", tsx: "TSX", json: "JSON", md: "Markdown", markdown: "Markdown",
  svg: "SVG", xml: "XML", yml: "YAML", yaml: "YAML", py: "Python",
  rb: "Ruby", go: "Go", rs: "Rust", php: "PHP", java: "Java",
  kt: "Kotlin", swift: "Swift",
};

function computeLanguageBreakdown(files) {
  const byExt = {};
  let total = 0;
  for (const [p, content] of Object.entries(files || {})) {
    const ext = (p.split(".").pop() || "").toLowerCase();
    const lang = LANG_MAP[ext];
    if (!lang) continue;
    if (typeof content !== "string") continue;
    const lines = content.split("\n").length;
    byExt[lang] = (byExt[lang] || 0) + lines;
    total += lines;
  }
  if (total === 0) return { breakdown: {}, totalLines: 0, computedAt: Date.now() };
  const breakdown = {};
  for (const [lang, lines] of Object.entries(byExt)) {
    breakdown[lang] = Math.round((lines / total) * 1000) / 10;
  }
  return { breakdown, totalLines: total, computedAt: Date.now() };
}

// =========================================================================
// FLIER + OG + THUMBNAIL
// =========================================================================

const FLIER_INTERNAL_URL = process.env.FLIER_INTERNAL_URL || `${BASE_URL}/api/flier`;
const DATA_URI_RE = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/;

function tryDecodeDataUri(content) {
  if (typeof content !== "string") return null;
  const m = content.match(DATA_URI_RE);
  if (!m) return null;
  const declaredMime = (m[1] || "application/octet-stream").trim() || "application/octet-stream";
  const isBase64 = !!m[2];
  const payload = m[3];
  try {
    const body = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { mime: declaredMime, body, isBase64 };
  } catch (err) {
    log("host.datauri_decode_failed", { message: err.message });
    return null;
  }
}

async function uploadViaFlier(dataUri, name, reqId) {
  if (typeof dataUri !== "string" || !dataUri.startsWith("data:")) {
    throw Object.assign(new Error("Not a data URI"), { status: 400 });
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}/api/flier?action=upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.ADMIN_API_KEY || "",
      },
      body: JSON.stringify({
        dataUrl: dataUri,
        kind: "image",
        scope: "project",
        name: String(name || `asset_${Date.now()}`).slice(0, 60),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    log("host.flier_upload.network", { reqId, message: err.message });
    throw Object.assign(new Error("Upload service unreachable"), { status: 502 });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    log("host.flier_upload.http", { reqId, status: res.status, body: text.slice(0, 200) });
    throw Object.assign(new Error(`Upload service HTTP ${res.status}`), {
      status: res.status === 429 ? 429 : 502,
    });
  }
  const json = await res.json().catch(() => ({}));
  const url = json?.url || json?.data?.url || json?.display_url;
  if (!url || !/^https:\/\//.test(url)) {
    log("host.flier_upload.bad_response", { reqId, response: json });
    throw Object.assign(new Error("Upload service returned no URL"), { status: 502 });
  }
  return url;
}

async function deleteViaFlier(url, reqId) {
  if (!url || typeof url !== "string") return false;
  try {
    const res = await fetch(`${BASE_URL}/api/flier?action=delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.ADMIN_API_KEY || "",
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch (err) {
    log("host.flier_delete.error", { reqId, url, message: err.message });
    return false;
  }
}

function ogSignature(...parts) {
  const raw = parts.map((p) => String(p ?? "")).join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function isValidOgUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.length > OG_URL_MAX_LENGTH) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const ext = u.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    if (ext && !OG_IMAGE_EXTENSIONS.includes(ext)) return false;
    return true;
  } catch {
    return false;
  }
}

function flierCacheKey(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

function flierCacheGet(key) {
  const c = FLIER_MEM_CACHE.get(key);
  if (!c) return null;
  if (Date.now() - c.at > FLIER_MEM_TTL) {
    FLIER_MEM_CACHE.delete(key);
    return null;
  }
  return c.url;
}

function flierCacheSet(key, url) {
  if (FLIER_MEM_CACHE.size >= FLIER_MEM_MAX) {
    const first = FLIER_MEM_CACHE.keys().next().value;
    if (first) FLIER_MEM_CACHE.delete(first);
  }
  FLIER_MEM_CACHE.set(key, { url, at: Date.now() });
}

async function callFlier(payload, { retries = 1 } = {}) {
  const cacheKey = flierCacheKey(payload);
  const cached = flierCacheGet(cacheKey);
  if (cached && isValidOgUrl(cached)) return cached;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(FLIER_INTERNAL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": process.env.ADMIN_API_KEY || "",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        log("og_image.flier_http", { status: res.status, attempt, body: text.slice(0, 200) });
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 400 + attempt * 600));
          continue;
        }
        return null;
      }
      const json = await res.json();
      if (!json.success || !json.url) {
        log("og_image.flier_no_url", { attempt, response: json });
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 400 + attempt * 600));
          continue;
        }
        return null;
      }
      if (!isValidOgUrl(json.url)) {
        log("og_image.flier_bad_url", { attempt, url: json.url });
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 400 + attempt * 600));
          continue;
        }
        return null;
      }
      flierCacheSet(cacheKey, json.url);
      return json.url;
    } catch (err) {
      log("og_image.flier_error", { attempt, message: err.message });
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 + attempt * 600));
        continue;
      }
    }
  }
  return null;
}

async function getFallbackOg(kind) {
  if (FALLBACK_OG[kind]) return FALLBACK_OG[kind];
  const cached = await db.ref(`og_defaults/${kind}/url`).once("value").catch(() => null);
  if (cached?.exists() && isValidOgUrl(cached.val())) {
    FALLBACK_OG[kind] = cached.val();
    return cached.val();
  }
  const payload = {
    mode: "upload", type: "template", template: "hero-short", size: OG_SIZE,
    data: {
      text: {
        kicker: "FOLIO",
        headline: kind === "project" ? "A project on Folio" : "A creator on Folio",
      },
      style: {
        variant: "dark",
        scene: kind === "project" ? "skyline" : "ribbon",
        scenePalette: "warm",
        colors: { primary: "#F59E0B", accent: "#fbbf24" },
      },
    },
    upload: { name: `og_default_${kind}` },
  };
  const url = await callFlier(payload, { retries: 2 });
  if (!url) {
    log("og_image.fallback_failed", { kind });
    return null;
  }
  await db.ref(`og_defaults/${kind}`).set({ url, generatedAt: Date.now() }).catch(() => {});
  FALLBACK_OG[kind] = url;
  return url;
}

function pickSceneForProject(project) {
  const hash = crypto.createHash("sha256").update(String(project.name || project.pid || "")).digest();
  return PROJECT_SCENES[hash[0] % PROJECT_SCENES.length];
}
function pickPaletteForProject(project) {
  const hash = crypto.createHash("sha256").update(String(project.name || project.pid || "")).digest();
  return PALETTES[hash[1] % PALETTES.length];
}
function pickSceneForProfile(user, username) {
  const hash = crypto.createHash("sha256").update(String(user.profile?.displayName || username || "")).digest();
  return PROFILE_SCENES[hash[0] % PROFILE_SCENES.length];
}
function pickPaletteForProfile(user, username) {
  const hash = crypto.createHash("sha256").update(String(user.profile?.displayName || username || "")).digest();
  return PALETTES[hash[1] % PALETTES.length];
}

function deriveProjectDescription(project, files) {
  if (project.description?.trim()) return project.description.trim().slice(0, 160);
  if (files) {
    const htmlFile =
      files["index.html"] ||
      files["index.htm"] ||
      Object.entries(files).find(([p]) => /\.html?$/i.test(p))?.[1];
    if (htmlFile) {
      const h1 = String(htmlFile).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      const p = String(htmlFile).match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const raw = (h1?.[1] || p?.[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (raw.length > 15) return raw.slice(0, 160);
    }
  }
  const langs = Object.keys(project.languages?.breakdown || {});
  if (langs.length > 0) return `${langs.slice(0, 3).join(", ")} project on Folio`;
  return `${project.name || "A Folio project"} — built with Folio.`;
}

function pickProjectTemplate(project, derivedDesc, langs) {
  const nameLen = (project.name || "").length;
  const descLen = (derivedDesc || "").length;
  const hasIcon = !!project.iconUrl;
  const langCount = langs.length;
  if (nameLen > 32 && descLen < 40) return "hero-short";
  if (hasIcon && descLen > 60) return "image-shadow-bottom";
  if (langCount >= 3 && descLen > 40) return "product-grid-2";
  if (descLen > 100) return "poster-centered";
  if (nameLen <= 20 && descLen > 0) return "quote-card";
  return "event-poster";
}

function pickProfileTemplate(user, derivedBio) {
  const displayName = (user.profile?.displayName || "").trim();
  const nameLen = displayName.length;
  const bioLen = (derivedBio || "").length;
  const hasAvatar = !!user.profile?.avatarUrl;
  if (nameLen <= 16) return "hero-short";
  if (hasAvatar && nameLen > 16) return "image-shadow-bottom";
  if (bioLen > 100) return "poster-centered";
  return "quote-card";
}

async function ensureProjectOgImage({ pid, project, files }) {
  const derivedDesc = deriveProjectDescription(project, files);
  const langs = Object.entries(project.languages?.breakdown || {})
    .sort(([, a], [, b]) => b - a)
    .map(([lang]) => lang);
  const sig = ogSignature(project.name, derivedDesc, project.iconUrl, langs.slice(0, 4).join(","));
  const cached = project.ogImage;
  if (cached?.url && cached.signature === sig && isValidOgUrl(cached.url)) return cached.url;

  const template = pickProjectTemplate(project, derivedDesc, langs);
  const scene = pickSceneForProject(project);
  const palette = pickPaletteForProject(project);
  const payload = {
    mode: "upload", type: "template", template, size: OG_SIZE, seed: pid,
    data: {
      text: {
        kicker: langs.length ? langs.slice(0, 2).join(" · ") : "FOLIO",
        headline: project.name || "Untitled project",
        subheadline: derivedDesc,
      },
      style: {
        variant: "dark",
        align: template === "product-grid-2" ? "left" : "center",
        colors: { primary: "#F59E0B" },
        headlineCase: "auto",
        watermark: true,
        scene,
        scenePalette: palette,
        sceneOpacity: 0.85,
      },
      images: project.iconUrl ? { primary: { url: project.iconUrl } } : {},
    },
    upload: { name: `og_${pid}_${sig}` },
  };
  const url = await callFlier(payload);
  if (!url) {
    log("og_image.project_fallback", { pid, template, scene, palette });
    return await getFallbackOg("project");
  }
  await db.ref(`projects/${pid}/ogImage`).set({
    url, signature: sig, template, scene, palette, generatedAt: Date.now(),
  }).catch(() => {});
  invalidateProject(pid);
  return url;
}

async function ensureProfileOgImage({ user, username }) {
  const displayName = user.profile?.displayName || username;
  const derivedBio = (user.profile?.bio || "").trim().slice(0, 160);
  const sig = ogSignature(displayName, derivedBio, user.profile?.avatarUrl);
  const cached = user.profile?.ogImage;
  if (cached?.url && cached.signature === sig && isValidOgUrl(cached.url)) return cached.url;

  const template = pickProfileTemplate(user, derivedBio);
  const scene = pickSceneForProfile(user, username);
  const palette = pickPaletteForProfile(user, username);
  const payload = {
    mode: "upload", type: "template", template, size: OG_SIZE, seed: username,
    data: {
      text: { kicker: `@${username}`, headline: displayName, subheadline: derivedBio },
      style: {
        variant: "dark",
        align: template === "hero-short" ? "center" : "left",
        colors: { primary: "#F59E0B" },
        scene,
        scenePalette: palette,
      },
      images: user.profile?.avatarUrl ? { primary: { url: user.profile.avatarUrl } } : {},
    },
    upload: { name: `og_profile_${username}_${sig}` },
  };
  const url = await callFlier(payload);
  if (!url) {
    log("og_image.profile_fallback", { username, template });
    return await getFallbackOg("profile");
  }
  await db.ref(`users/${user.uid}/profile/ogImage`).set({
    url, signature: sig, template, scene, palette, generatedAt: Date.now(),
  }).catch(() => {});
  return url;
}

async function invalidateProjectOgImage(pid) {
  await db.ref(`projects/${pid}/ogImage`).remove().catch(() => {});
  invalidateProject(pid);
}

async function invalidateProfileOgImage(uid) {
  await db.ref(`users/${uid}/profile/ogImage`).remove().catch(() => {});
  await db.ref(`users/${uid}/profile/ogImageUrl`).remove().catch(() => {});
}

async function resolveProjectMeta(pid, project) {
  const cached = META_CACHE.get(pid);
  if (cached && Date.now() - cached.at < META_CACHE_TTL) return cached.meta;

  const meta = { ...(project.metaTags || {}) };

  if (!meta.ogImage || !isValidOgUrl(meta.ogImage)) {
    let files = null;
    if (!project.description?.trim()) {
      const snap = await db.ref(`files/${pid}`).once("value").catch(() => null);
      files = {};
      if (snap?.exists()) {
        snap.forEach((c) => {
          const v = c.val();
          if (v?.path) files[v.path] = v.content || "";
        });
      }
    }
    const gen = await ensureProjectOgImage({ pid, project, files });
    if (gen) meta.ogImage = gen;
  }
  if (!meta.description) meta.description = deriveProjectDescription(project, null);

  META_CACHE.set(pid, { meta, at: Date.now() });
  return meta;
}

async function ensureProjectLanguages(pid, project, files) {
  const cached = project.languages;
  if (
    cached?.breakdown &&
    Object.keys(cached.breakdown).length > 0 &&
    cached.computedAt &&
    Date.now() - cached.computedAt < LANGUAGES_CACHE_TTL
  ) {
    return cached;
  }
  if (!files) {
    const snap = await db.ref(`files/${pid}`).once("value").catch(() => null);
    if (!snap?.exists()) return { breakdown: {}, totalLines: 0, computedAt: Date.now() };
    files = {};
    snap.forEach((c) => {
      const v = c.val();
      if (v?.path) files[v.path] = v.content || "";
    });
  }
  const record = computeLanguageBreakdown(files);
  await db.ref(`projects/${pid}/languages`).set(record).catch(() => {});
  invalidateProject(pid);
  return record;
}

function hasDetailedIndex(files) {
  if (!files || typeof files !== "object") return false;
  const html =
    files["index.html"] ||
    files["index.htm"] ||
    Object.entries(files).find(([p]) => /\.html?$/i.test(p))?.[1];
  if (!html || typeof html !== "string" || html.length < 500) return false;
  const hasH1 = /<h1[^>]*>[\s\S]{3,}<\/h1>/i.test(html);
  const hasP = /<p[^>]*>[\s\S]{15,}<\/p>/i.test(html);
  const hasNav = /<nav[\s>]/i.test(html);
  return (hasH1 && hasP) || hasNav;
}

async function ensureProjectThumbnail(pid, files) {
  if (!files) {
    const snap = await db.ref(`files/${pid}`).once("value").catch(() => null);
    if (!snap?.exists()) return null;
    files = {};
    snap.forEach((c) => {
      const v = c.val();
      if (v?.path) files[v.path] = v.content || "";
    });
  }

  const detailed = hasDetailedIndex(files);
  const renderMode = detailed ? "browser-frame" : "html";

  const indexHtml =
    files["index.html"] ||
    files["index.htm"] ||
    Object.entries(files).find(([p]) => /\.html?$/i.test(p))?.[1];
  if (!indexHtml) return null;

  const sig = crypto
    .createHash("sha256")
    .update(`${renderMode}:${indexHtml.slice(0, 5000)}`)
    .digest("hex")
    .slice(0, 16);

  const existing = await db.ref(`projects/${pid}/thumbnail`).once("value").catch(() => null);
  if (existing?.exists()) {
    const t = existing.val();
    if (t.signature === sig && isValidOgUrl(t.url)) return t.url;
  }

  let payload;
  if (detailed) {
    const projectSnap = await db.ref(`projects/${pid}`).once("value").catch(() => null);
    const project = projectSnap?.exists() ? projectSnap.val() : {};
    const derivedDesc = deriveProjectDescription(project, files);
    payload = {
      mode: "upload", type: "template", template: "browser-frame", size: THUMBNAIL_SIZE, seed: pid,
      data: {
        text: {
          headline: project.name || "Untitled project",
          subheadline: derivedDesc,
          kicker: project.slug ? `${project.slug}.folio.app` : "",
          footer: "Visit project",
        },
        style: {
          variant: "dark",
          colors: { primary: "#F59E0B" },
          scene: "grid_wave",
          scenePalette: "warm",
          sceneOpacity: 0.6,
        },
        images: project.iconUrl ? { primary: { url: project.iconUrl } } : {},
      },
      upload: { name: `thumb_${pid}_${sig}` },
    };
  } else {
    payload = {
      mode: "upload", type: "html",
      html: indexHtml.slice(0, 200_000),
      size: THUMBNAIL_SIZE,
      upload: { name: `thumb_${pid}_${sig}` },
    };
  }

  const url = await callFlier(payload);
  if (!url) return null;
  await db.ref(`projects/${pid}/thumbnail`).set({
    url, signature: sig, renderMode, generatedAt: Date.now(),
  }).catch(() => {});
  invalidateProject(pid);
  return url;
}

async function ensureDeploymentThumbnail(pid, deploymentId, files) {
  if (!files) return null;
  const indexHtml =
    files["index.html"] ||
    files["index.htm"] ||
    Object.entries(files).find(([p]) => /\.html?$/i.test(p))?.[1];
  if (!indexHtml) return null;
  const sig = crypto.createHash("sha256").update(indexHtml.slice(0, 5000)).digest("hex").slice(0, 16);
  const existing = await db.ref(`projects/${pid}/deployments/${deploymentId}/thumbnail`).once("value").catch(() => null);
  if (existing?.exists()) {
    const t = existing.val();
    if (t.signature === sig && isValidOgUrl(t.url)) return t.url;
  }
  const proj = await db.ref(`projects/${pid}/thumbnail`).once("value").catch(() => null);
  if (proj?.exists() && proj.val().signature === sig && isValidOgUrl(proj.val().url)) {
    const record = proj.val();
    await db.ref(`projects/${pid}/deployments/${deploymentId}/thumbnail`).set(record).catch(() => {});
    return record.url;
  }
  const payload = {
    mode: "upload", type: "html",
    html: indexHtml.slice(0, 200_000),
    size: THUMBNAIL_SIZE,
    upload: { name: `thumb_${pid}_${deploymentId}` },
  };
  const url = await callFlier(payload);
  if (!url) return null;
  const record = { url, signature: sig, generatedAt: Date.now() };
  await db.ref(`projects/${pid}/deployments/${deploymentId}/thumbnail`).set(record).catch(() => {});
  return url;
}

async function ensureUserAvatar(uid, displayName, username) {
  if (!uid || !username) return null;
  const existing = await db.ref(`users/${uid}/profile/avatarUrl`).once("value").catch(() => null);
  if (existing?.exists() && existing.val()) return existing.val();
  try {
    const res = await fetch(`${BASE_URL}/api/flier?action=avatar/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, displayName }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.success || !Array.isArray(json.variants) || json.variants.length === 0) return null;
    const chosen = json.variants[0];
    if (!chosen?.dataUrl) return null;
    const upRes = await fetch(`${BASE_URL}/api/flier?action=avatar/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: chosen.dataUrl, username }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!upRes.ok) return null;
    const upJson = await upRes.json();
    if (!upJson.success || !upJson.url || !isValidOgUrl(upJson.url)) return null;
    await db.ref(`users/${uid}/profile/avatarUrl`).set(upJson.url).catch(() => {});
    return upJson.url;
  } catch (err) {
    log("host.avatar_generate_failed", { uid, username, message: err.message });
    return null;
  }
}

async function notificationImageUrl({
  title, subtitle = "", template = "hero-short",
  scene = "auto", palette = "warm", seed = null, size = OG_SIZE,
} = {}) {
  if (!title) return null;
  const payload = {
    mode: "upload", type: "template", template, size,
    seed: seed || `${title}:${subtitle}`,
    data: {
      text: { kicker: "FOLIO", headline: title, subheadline: subtitle },
      style: {
        variant: "dark", scene, scenePalette: palette,
        colors: { primary: "#F59E0B" },
      },
    },
    upload: { name: `notif_${Date.now()}` },
  };
  return await callFlier(payload);
}

// =========================================================================
// NOTIFICATIONS
// =========================================================================

async function callNotify(type, uid, payload) {
  if (!uid) return;
  try {
    const res = await fetch(`${BASE_URL}/api/notify?action=create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ADMIN_API_KEY || "",
      },
      body: JSON.stringify({ type, uid, ...payload }),
    });
    if (!res.ok) log("host.notify_failed", { type, uid, status: res.status });
  } catch (err) {
    log("host.notify_error", { type, uid, message: err.message });
  }
}

async function notifyMany(type, uids, payload) {
  const unique = [...new Set((uids || []).filter(Boolean))];
  await Promise.allSettled(unique.map((uid) => callNotify(type, uid, payload)));
}

async function getProjectAudience(pid) {
  try {
    const snap = await db.ref(`projects/${pid}`).once("value");
    if (!snap.exists()) return { ownerId: null, uids: [] };
    const p = snap.val();
    const uids = new Set();
    if (p.ownerId) uids.add(p.ownerId);
    for (const uid of Object.keys(p.roles || {})) uids.add(uid);
    return { ownerId: p.ownerId || null, uids: [...uids] };
  } catch {
    return { ownerId: null, uids: [] };
  }
}

async function getVisibleContributors(pid, project, { viewerUid = null } = {}) {
  try {
    const roles = project.roles || {};
    const ownerId = project.ownerId;
    if (!ownerId) return [];
    const uids = Object.keys(roles).filter((uid) => uid !== ownerId);
    if (!uids.length) return [];
    const isOwnerViewer = viewerUid && viewerUid === ownerId;
    const profilePublic = project.visibility?.profile === "public";
    if (!profilePublic && !isOwnerViewer) return [];
    const contributors = await Promise.all(
      uids.slice(0, 20).map(async (uid) => {
        try {
          const user = await getUser(uid);
          if (!user) return null;
          const username = user.profile?.username || null;
          if (!username) return null;
          if (!isOwnerViewer && user.settings?.profileVisibility === "private") return null;
          return {
            uid, username,
            displayName: user.profile?.displayName || username,
            avatarUrl: user.profile?.avatarUrl || null,
            role: roles[uid] || "viewer",
          };
        } catch {
          return null;
        }
      }),
    );
    return contributors.filter(Boolean);
  } catch (err) {
    log("host.contributors_failed", { pid, message: err.message });
    return [];
  }
}

async function shouldNotifyOnce(uid, key, ttlMs = 24 * 60 * 60 * 1000) {
  if (!uid) return false;
  try {
    const ref = db.ref(`notify_dedupe/${uid}/${sanitizeFirebasePath(key)}`);
    const snap = await ref.once("value");
    const now = Date.now();
    if (snap.exists() && now - (snap.val()?.ts || 0) < ttlMs) return false;
    await ref.set({ ts: now }).catch(() => {});
    return true;
  } catch {
    return true;
  }
}

async function notifyDeployFailed(access, pid, projectName, reason, status) {
  if (!access?.uid || access.uid === "api") return;
  let imageUrl = null;
  try {
    imageUrl = await notificationImageUrl({
      title: "Deployment failed", subtitle: reason,
      template: "stat-hero", scene: "grid_wave", palette: "sunset",
    });
  } catch (err) {
    log("host.notify_deploy_failed.image_error", { message: err.message });
  }
  await callNotify("project", access.uid, {
    title: "Deployment failed",
    body: `Deploy to "${projectName || "project"}" failed: ${reason}`,
    imageUrl,
    link: `${BASE_URL}/project?pid=${pid}`,
    extra: { pid, status, kind: "deploy_failed" },
  });
}

async function notifyStorageWarning(pid, ownerId, finalSize, LIMIT, percentUsed, kind = "nearly_full") {
  if (!ownerId) return;
  const key = `storage_${kind}_${pid}`;
  const ttl = kind === "full" ? 6 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
  if (!(await shouldNotifyOnce(ownerId, key, ttl))) return;
  let imageUrl = null;
  try {
    imageUrl = await notificationImageUrl({
      title: kind === "full" ? "100% full" : `${percentUsed}% full`,
      subtitle: `${Math.round(finalSize / 1024 / 1024)} MB of ${Math.round(LIMIT / 1024 / 1024)} MB used`,
      template: "stat-hero", scene: "grid_wave",
      palette: kind === "full" ? "sunset" : "warm",
    });
  } catch (err) {
    log("host.notify_storage.image_error", { message: err.message });
  }
  await callNotify("storage", ownerId, {
    title: kind === "full" ? "Database limit reached" : "Database nearly full",
    body: kind === "full"
      ? `Writes to this project are being rejected — ${percentUsed}% full.`
      : `Database is ${percentUsed}% full (${Math.round(finalSize / 1024 / 1024)} MB of ${Math.round(LIMIT / 1024 / 1024)} MB).`,
    imageUrl,
    link: `${BASE_URL}/project?pid=${pid}`,
    extra: { pid, size: finalSize, limit: LIMIT, percentUsed, kind },
  });
}

async function maybeNotifyRateLimitAbuse(action, identifier, rateResult) {
  const s = String(identifier || "");
  let pid = null;
  let directUid = null;
  if (s.startsWith("pid_")) pid = s.slice(4);
  else if (s.startsWith("uid_")) directUid = s.slice(4);
  else return;

  const windowKey = `rl_abuse_${action}_${sanitizeFirebasePath(s)}`;
  const ref = db.ref(`rate_limit_abuse/${windowKey}`);
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  let fired = false;
  let ownerId = directUid;
  try {
    await ref.transaction((cur) => {
      const c = cur && now - (cur.first || 0) < HOUR ? cur : { count: 0, first: now };
      c.count += 1;
      if (c.count === 5 && !c.fired) {
        c.fired = true;
        fired = true;
      }
      return c;
    });
  } catch {
    return;
  }
  if (!fired) return;
  if (!ownerId && pid) {
    const snap = await db.ref(`projects/${pid}/ownerId`).once("value").catch(() => null);
    if (snap?.exists()) ownerId = snap.val();
  }
  if (!ownerId) return;
  await callNotify("security", ownerId, {
    title: "Repeated rate-limit warnings",
    body: `"${action}" is being rejected repeatedly${pid ? " on one of your projects" : ""}. Possible abuse or a stuck client.`,
    link: pid ? `${BASE_URL}/project?pid=${pid}` : `${BASE_URL}/projects`,
    extra: { action, pid, identifier: s, retryAfter: rateResult?.retryAfter },
  });
}

// =========================================================================
// DEPLOY
// =========================================================================

async function ensureDeployVersion(pid, files, versionId) {
  if (versionId) {
    const snap = await db.ref(`versions/${pid}/${versionId}`).once("value").catch(() => null);
    if (snap?.exists()) return versionId;
  }
  const vid = `v_deploy_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`;
  await db.ref(`versions/${pid}/${vid}`).set({
    message: `Deploy — ${new Date().toISOString()}`,
    files: filesToSnapshot(files),
    createdAt: Date.now(),
    kind: "deploy",
  });
  return vid;
}

async function pruneDeployments(pid) {
  const dSnap = await db.ref(`projects/${pid}/deployments`).once("value");
  if (!dSnap.exists()) return;
  const entries = [];
  dSnap.forEach((c) => {
    const v = c.val() || {};
    entries.push({ id: c.key, at: v.deployedAt || 0, vid: v.versionId || null });
  });
  if (entries.length <= MAX_DEPLOYMENTS_PER_PROJECT) return;

  entries.sort((a, b) => b.at - a.at);
  const toDelete = entries.slice(MAX_DEPLOYMENTS_PER_PROJECT);
  const updates = {};
  for (const d of toDelete) {
    updates[`projects/${pid}/deployments/${d.id}`] = null;
    if (d.vid) updates[`versions/${pid}/${d.vid}`] = null;
  }
  try {
    await db.ref().update(updates);
  } catch (err) {
    log("host.deploy.prune_failed", { pid, message: err.message });
  }

  const currentSnap = await db.ref(`projects/${pid}/deployment/deploymentId`).once("value");
  const currentId = currentSnap.exists() ? currentSnap.val() : null;
  if (currentId && toDelete.some((d) => d.id === currentId)) {
    const next = entries.find((e) => e.id !== currentId && !toDelete.some((d) => d.id === e.id));
    if (next) {
      const recSnap = await db.ref(`projects/${pid}/deployments/${next.id}`).once("value");
      if (recSnap.exists()) await db.ref(`projects/${pid}/deployment`).set(recSnap.val());
      else await db.ref(`projects/${pid}/deployment`).remove();
    } else {
      await db.ref(`projects/${pid}/deployment`).remove();
    }
  }
}

async function writeFilesInBatches(pid, fileMap, reqId, { tree = "files" } = {}) {
  const entries = Object.entries(fileMap);
  let written = 0;
  const skipped = [];
  for (let i = 0; i < entries.length; i += DEPLOY_PARALLEL_WRITES) {
    const batch = entries.slice(i, i + DEPLOY_PARALLEL_WRITES);
    await Promise.allSettled(
      batch.map(async ([p, c]) => {
        if (typeof c !== "string") { skipped.push(p); return; }
        if (!isValidFilePath(p)) { skipped.push(p); return; }
        try {
          await db.ref(`${tree}/${pid}/${sanitizeFirebasePath(p.replace(/\//g, "__"))}`).set({
            path: p, content: c, updatedAt: Date.now(),
          });
          written++;
        } catch (err) {
          log("host.deploy.file_failed", { reqId, pid, tree, filePath: p, message: err.message });
          skipped.push(p);
        }
      }),
    );
  }
  return { written, skipped };
}

async function validateAndStoreAllowHosts(pid, apiFiles) {
  // Collect all @allow hosts across all files
  const allHosts = new Set();
  const declaredBy = new Map(); // host -> Set of files

  for (const [name, content] of Object.entries(apiFiles)) {
    const hosts = extractAllowHosts(content);
    for (const host of hosts) {
      allHosts.add(host);
      if (!declaredBy.has(host)) declaredBy.set(host, new Set());
      declaredBy.get(host).add(name);
    }
  }

  if (allHosts.size > MAX_UNIQUE_ALLOW_HOSTS) {
    return {
      ok: false,
      reason: `Too many @allow hosts (${allHosts.size}). Max is ${MAX_UNIQUE_ALLOW_HOSTS}.`,
    };
  }

  const results = [];

  for (const host of allHosts) {
    // Built-in hosts are pre-approved
    if (BUILTIN_ALLOWED_HOSTS.has(host)) {
      results.push({ host, ok: true, builtin: true });
      continue;
    }

    const validation = await validateAllowHost(host);
    results.push({
      host,
      ok: validation.ok,
      reason: validation.reason,
      builtin: false,
    });
  }

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    return {
      ok: false,
      reason: `Host validation failed`,
      violations: failures.map((f) => ({
        host: f.host,
        reason: f.reason,
        files: [...(declaredBy.get(f.host) || [])],
      })),
    };
  }

  // All good — write the manifest
  const manifest = {};
  for (const r of results) {
    if (r.builtin) continue; // built-ins aren't stored
    manifest[r.host] = {
      declaredBy: [...(declaredBy.get(r.host) || [])],
      validatedAt: Date.now(),
      validatedOk: true,
    };
  }

  // Read existing manifest, merge, remove hosts no longer referenced
  const existingSnap = await db.ref(`projects/${pid}/allowedHosts`).once("value");
  const existing = existingSnap.exists() ? existingSnap.val() : {};

  const updates = {};
  for (const [host, meta] of Object.entries(manifest)) {
    updates[`projects/${pid}/allowedHosts/${host}`] = meta;
  }
  for (const host of Object.keys(existing)) {
    if (!manifest[host]) {
      updates[`projects/${pid}/allowedHosts/${host}`] = null;
    }
  }

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  return { ok: true, hosts: Object.keys(manifest) };
}

async function handleDeploy(req, res, reqId) {
  const { pid, files, versionId, clientRequestId } = req.body || {};
  if (!pid || !files || typeof files !== "object") {
    return res.status(400).json({ success: false, error: "Missing pid or files" });
  }
  if (!(await enforceRate(req, res, "deploy", `pid_${pid}`))) return;

  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  invalidateProject(pid);
  const project = await getProjectCached(pid);
  if (!project) return res.status(404).json({ success: false, error: "Project not found" });

  // ── Split api/* from regular files ────────────────────────────────
  const apiFiles = {};
  const regularFiles = {};

  for (const [p, c] of Object.entries(files)) {
    if (typeof c !== "string") continue;
    if (c.length > DEPLOY_MAX_FILE_BYTES) continue;
    if (!isValidFilePath(p)) continue;

    if (p.startsWith("api/")) {
      const rel = p.slice(4);
      if (!rel.includes("/")) {
        apiFiles[rel] = c;
      }
      // Subfolders under api/ are silently dropped
    } else {
      regularFiles[p] = c;
    }
  }

  // ── Validate API files ────────────────────────────────────────────
  const apiAnalysis = analyzeApiFiles(apiFiles);
  if (apiAnalysis.rejected.length > 0) {
    return res.status(400).json({
      success: false,
      error: "API file validation failed",
      rejected: apiAnalysis.rejected,
    });
  }

  // ── Validate @allow hosts ─────────────────────────────────────────
  const allowResult = await validateAndStoreAllowHosts(pid, apiAnalysis.valid);
  if (!allowResult.ok) {
    return res.status(400).json({
      success: false,
      error: allowResult.reason,
      violations: allowResult.violations || [],
    });
  }

  // ── Auto-inject _system.js ────────────────────────────────────────
  if (!apiAnalysis.valid[API_SYSTEM_FILENAME]) {
    apiAnalysis.valid[API_SYSTEM_FILENAME] = getDefaultSystemJs();
  }

  // ── Total size check ──────────────────────────────────────────────
  let totalBytes = 0;
  for (const [p, c] of Object.entries(regularFiles)) {
    totalBytes += c.length;
    if (totalBytes > DEPLOY_MAX_TOTAL_BYTES) {
      try {
        await notifyDeployFailed(access, pid, project.name, "payload exceeds size limit", 413);
      } catch {}
      return res.status(413).json({
        success: false,
        error: "Project too large to deploy",
        limit: DEPLOY_MAX_TOTAL_BYTES,
      });
    }
  }

  if (Object.keys(regularFiles).length === 0 && Object.keys(apiAnalysis.valid).length === 0) {
    return res.status(400).json({ success: false, error: "No valid files to deploy" });
  }

  // ── Ensure version ────────────────────────────────────────────────
  const allFiles = { ...regularFiles };
  for (const [name, content] of Object.entries(apiAnalysis.valid)) {
    allFiles[`api/${name}`] = content;
  }

  let resolvedVid = null;
  try {
    resolvedVid = await ensureDeployVersion(pid, allFiles, versionId);
  } catch (err) {
    log("host.deploy.version_failed", { pid, message: err.message });
    resolvedVid = null;
  }

  // ── Write regular files to files/{pid} ───────────────────────────
  const regularWrite = await writeFilesInBatches(pid, regularFiles, reqId, { tree: "files" });

  // ── Write api files to api-files/{pid} ───────────────────────────
  const apiWrite = await writeFilesInBatches(pid, apiAnalysis.valid, reqId, { tree: "api-files" });

  const totalWritten = regularWrite.written + apiWrite.written;
  if (totalWritten === 0) {
    try {
      await notifyDeployFailed(access, pid, project.name, "no files written", 500);
    } catch {}
    return res.status(500).json({ success: false, error: "No files were written" });
  }

  // ── Write manifests ──────────────────────────────────────────────
  let publicFileList = null;
  try {
    publicFileList = await buildPublicFileList(pid);
    await db.ref(`projects/${pid}/publicFileList`).set(publicFileList);
  } catch (err) {
    log("host.deploy.public_file_list_failed", { pid, message: err.message });
  }

  try {
    const apiRoutes = buildApiRoutes(apiAnalysis.valid);
    await db.ref(`projects/${pid}/apiRoutes`).set(apiRoutes);
  } catch (err) {
    log("host.deploy.api_routes_failed", { pid, message: err.message });
  }

  // ── Thumbnail + languages + OG ───────────────────────────────────
  try {
    await ensureProjectLanguages(pid, project, regularFiles);
  } catch (err) {
    log("host.deploy.languages_failed", { pid, message: err.message });
  }
  try {
    await ensureProjectThumbnail(pid, regularFiles);
  } catch (err) {
    log("host.deploy.thumbnail_failed", { pid, message: err.message });
  }
  await invalidateProjectOgImage(pid).catch(() => {});

  // ── Compute storage used (public files only) ─────────────────────
  let storageUsed = 0;
  try {
    const fSnap = await db.ref(`files/${pid}`).once("value");
    if (fSnap.exists()) {
      fSnap.forEach((c) => {
        const v = c.val();
        if (v?.content && typeof v.content === "string") storageUsed += v.content.length;
      });
    }
  } catch {}

  // ── Resolve owner username ───────────────────────────────────────
  const ownerUsername = await getProjectOwnerUsername(pid, project);
  const cleanUrl = ownerUsername
    ? buildProjectCleanUrl(ownerUsername, project, pid)
    : `${BASE_URL}/api/host?action=serve&pid=${pid}&path=index.html`;
  const serveUrl = `${BASE_URL}/api/host?action=serve&pid=${pid}&path=index.html`;

  // ═════════════════════════════════════════════════════════════════
  // ✅ NEW: Write the slug index for the friendly API URL
  // ═════════════════════════════════════════════════════════════════
  // Populates projectSlugs/{username}/{slug} = pid so that
  // api/run.js can resolve /{username}/project/{slug}/api/{route}
  // without falling back to the slower scan.
  //
  // Also removes stale entries when the slug or username changed
  // since the last deploy (defensive — normally handleProjectsUpdate
  // already cleans these up, but this catches any drift).
  if (ownerUsername && project.slug) {
    try {
      await db.ref(`projectSlugs/${ownerUsername}/${project.slug}`).set(pid);

      // Remove stale slug entries for this pid under this user
      // (in case the slug changed without the index being cleaned up)
      const userSlugsSnap = await db.ref(`projectSlugs/${ownerUsername}`).once("value");
      if (userSlugsSnap.exists()) {
        const updates = {};
        userSlugsSnap.forEach((child) => {
          if (child.val() === pid && child.key !== project.slug) {
            updates[`projectSlugs/${ownerUsername}/${child.key}`] = null;
          }
        });
        if (Object.keys(updates).length > 0) {
          await db.ref().update(updates);
        }
      }
    } catch (err) {
      // Non-fatal — the runtime resolver self-heals on the first call
      log("host.deploy.slug_index_failed", { pid, message: err.message });
    }
  }

  const deploymentId = `db_${pid}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const deploymentRecord = {
    url: cleanUrl,
    serveUrl,
    versionId: resolvedVid || null,
    deployedAt: Date.now(),
    deploymentId,
    state: "READY",
    deployedBy: access.uid,
    ...(clientRequestId ? { clientRequestId } : {}),
  };

  await db.ref(`projects/${pid}/deployment`).set(deploymentRecord);
  await db.ref(`projects/${pid}/deployments/${deploymentId}`).set(deploymentRecord);
  await db.ref(`projects/${pid}/updatedAt`).set(Date.now());
  await db.ref(`projects/${pid}/storageUsed`).set(storageUsed).catch(() => {});
  invalidateProject(pid);

  await pruneDeployments(pid);

  await logProjectEvent(pid, access.uid, "deploy", "project.deployed", {
    url: cleanUrl, versionId: resolvedVid,
    filesWritten: totalWritten,
    apiFilesWritten: apiWrite.written,
    filesSkipped: regularWrite.skipped.length + apiWrite.skipped.length,
  });
  await maybePruneProjectLogs(pid);

  try {
    await ensureDeploymentThumbnail(pid, deploymentId, regularFiles);
  } catch (err) {
    log("host.deploy.deployment_thumb_failed", { pid, deploymentId, message: err.message });
  }

  try {
    const audience = await getProjectAudience(pid);
    const others = audience.uids.filter((u) => u !== access.uid);
    if (others.length) {
      const thumb = await db.ref(`projects/${pid}/thumbnail/url`).once("value").catch(() => null);
      const imageUrl = thumb?.exists() && isValidOgUrl(thumb.val()) ? thumb.val() : null;
      await notifyMany("project", others, {
        title: "Deployment complete",
        body: `Project "${project.name}" is live.`,
        imageUrl, link: cleanUrl,
        extra: { pid, deploymentId },
      });
    }
  } catch {}

  return res.status(202).json({
    success: true,
    deploymentId,
    url: cleanUrl,
    serveUrl,
    versionId: resolvedVid,
    filesWritten: totalWritten,
    filesSkipped: regularWrite.skipped.length + apiWrite.skipped.length,
    apiFileCount: apiAnalysis.totalFiles + 1, // +1 for _system.js
    apiRejected: apiAnalysis.rejected,
    allowedHosts: allowResult.hosts || [],
  });
}

async function handleRedeploy(req, res, reqId) {
  const { pid, versionId } = req.body || {};
  if (!pid || !versionId) {
    return res.status(400).json({ success: false, error: "Missing pid or versionId" });
  }
  if (!(await enforceRate(req, res, "redeploy", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const versionSnap = await db.ref(`versions/${pid}/${versionId}`).once("value");
  if (!versionSnap.exists()) return res.status(404).json({ success: false, error: "Version not found" });
  const version = versionSnap.val();
  const files = snapshotToFiles(version.files);
  if (!files || Object.keys(files).length === 0) {
    return res.status(400).json({ success: false, error: "Version has no files" });
  }

  return handleDeploy({ ...req, body: { pid, files, versionId } }, res, reqId);
}

async function handleStatus(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "status", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "viewer");
  if (!access) return;
  const snap = await db.ref(`projects/${pid}/deployment`).once("value");
  const deployment = snap.exists() ? snap.val() : null;
  return res.status(200).json({ success: true, deployment });
}

async function handleDeploymentHistory(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "deploymentHistory", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "viewer");
  if (!access) return;

  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

  const [snap, versionsSnap, currentSnap, project] = await Promise.all([
    db.ref(`projects/${pid}/deployments`).once("value"),
    db.ref(`versions/${pid}`).once("value").catch(() => null),
    db.ref(`projects/${pid}/deployment/deploymentId`).once("value"),
    getProjectCached(pid),
  ]);

  const existingVersions = new Set();
  if (versionsSnap?.exists()) versionsSnap.forEach((c) => existingVersions.add(c.key));

  const deployments = [];
  if (snap.exists()) {
    snap.forEach((child) => {
      const v = child.val() || {};
      deployments.push({
        id: child.key, ...v,
        hasSnapshot: !!(v.versionId && existingVersions.has(v.versionId)),
      });
    });
  }
  deployments.sort((a, b) => (b.deployedAt || 0) - (a.deployedAt || 0));
  const slice = deployments.slice(offset, offset + limit);

  await Promise.all(
    slice.map(async (d) => {
      try {
        const t = await db.ref(`projects/${pid}/deployments/${d.id}/thumbnail/url`).once("value");
        if (t?.exists() && isValidOgUrl(t.val())) d.thumbnailUrl = t.val();
      } catch {}
    }),
  );

  const ownerUsername =
    project?.ownerUsername ||
    (project ? await getProjectOwnerUsername(pid, project) : null);
  const cleanBase =
    ownerUsername && project?.slug
      ? `${BASE_URL}/${encodeURIComponent(ownerUsername)}/project/${encodeURIComponent(project.slug)}`
      : `${BASE_URL}/api/host?action=serve&pid=${encodeURIComponent(pid)}`;

  for (const d of slice) {
    if (!d.hasSnapshot) { d.previewUrl = null; continue; }
    const sep = cleanBase.includes("?") ? "&" : "?";
    d.previewUrl = `${cleanBase}${sep}from=${encodeURIComponent(d.id)}`;
  }

  const currentId = currentSnap.exists() ? currentSnap.val() : null;

  return res.status(200).json({
    success: true, deployments: slice, total: deployments.length,
    hasMore: offset + limit < deployments.length,
    currentDeploymentId: currentId,
    maxDeployments: MAX_DEPLOYMENTS_PER_PROJECT,
  });
}

async function handleDeploymentOffline(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "deploymentOffline", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const deploymentSnap = await db.ref(`projects/${pid}/deployment`).once("value");
  if (!deploymentSnap.exists()) {
    return res.status(400).json({ success: false, error: "No active deployment" });
  }
  const current = deploymentSnap.val();

  await db.ref(`projects/${pid}/deployment`).update({
    state: "OFFLINE",
    offlineAt: Date.now(),
    offlineBy: access.uid,
    previousUrl: current.url || null,
    url: null,
  });
  invalidateProject(pid);

  await logProjectEvent(pid, access.uid, "deploy", "deployment.offline", {});

  try {
    const audience = await getProjectAudience(pid);
    const others = audience.uids.filter((u) => u !== access.uid);
    if (others.length) {
      const nameSnap = await db.ref(`projects/${pid}/name`).once("value");
      const pname = nameSnap.exists() ? nameSnap.val() : "a project";
      let imageUrl = null;
      try {
        const t = await db.ref(`projects/${pid}/thumbnail/url`).once("value").catch(() => null);
        if (t?.exists() && isValidOgUrl(t.val())) imageUrl = t.val();
      } catch {}
      await notifyMany("project", others, {
        title: "Deployment taken offline",
        body: `"${pname}" was taken offline.`,
        imageUrl,
        link: `${BASE_URL}/project?pid=${pid}`,
        extra: { pid, kind: "offline" },
      });
    }
  } catch {}

  return res.status(200).json({ success: true });
}

async function handleDeploymentDelete(req, res, reqId) {
  const { pid, deploymentId } = req.body || {};
  if (!pid || !deploymentId) {
    return res.status(400).json({ success: false, error: "Missing pid or deploymentId" });
  }
  if (!(await enforceRate(req, res, "deploymentDelete", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  const [currentSnap, targetSnap] = await Promise.all([
    db.ref(`projects/${pid}/deployment/deploymentId`).once("value"),
    db.ref(`projects/${pid}/deployments/${deploymentId}`).once("value"),
  ]);
  const isCurrent = currentSnap.exists() && currentSnap.val() === deploymentId;
  const pairedVersionId = targetSnap.exists() ? targetSnap.val()?.versionId || null : null;

  const updates = {};
  updates[`projects/${pid}/deployments/${deploymentId}`] = null;
  if (pairedVersionId) updates[`versions/${pid}/${pairedVersionId}`] = null;
  if (isCurrent) updates[`projects/${pid}/deployment`] = null;
  await db.ref().update(updates);
  invalidateProject(pid);

  await logProjectEvent(pid, access.uid, "deploy", "deployment.deleted", {
    deploymentId, pairedVersionId,
  });

  try {
    const audience = await getProjectAudience(pid);
    const others = audience.uids.filter((u) => u !== access.uid);
    if (others.length) {
      await notifyMany("project", others, {
        title: "Deployment removed",
        body: `A ${isCurrent ? "current " : ""}deployment record was deleted.`,
        link: `${BASE_URL}/project?pid=${pid}`,
        extra: { pid, deploymentId, isCurrent, kind: "deploy_deleted" },
      });
    }
  } catch {}

  return res.status(200).json({ success: true, pairedVersionDeleted: !!pairedVersionId });
}

// =========================================================================
// SERVE
// =========================================================================

function rewriteRelativeUrls(html, ctx) {
  const { pid, username, slug, currentPath, cacheKey, fromId } = ctx;
  const baseDir = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/") + 1) : "";
  const buildUrl = (target) => {
    const rel = target.startsWith("/") ? target.slice(1) : baseDir + target;
    const cleanBase =
      username && slug
        ? `${BASE_URL}/${encodeURIComponent(username)}/project/${encodeURIComponent(slug)}/`
        : `${BASE_URL}/api/host?action=serve&pid=${encodeURIComponent(pid)}&path=`;
    const encoded = rel.split("/").map(encodeURIComponent).join("/");
    const params = new URLSearchParams();
    if (cacheKey) params.set("v", cacheKey);
    if (fromId) params.set("from", fromId);
    const qs = params.toString();
    if (username && slug) return cleanBase + encoded + (qs ? "?" + qs : "");
    return `${cleanBase}${encodeURIComponent(rel)}${qs ? "&" + qs : ""}`;
  };
  return html.replace(
    /\b(href|src|action)\s*=\s*(["'])((?!https?:|\/\/|data:|mailto:|#|javascript:)[^"']+)\2/gi,
    (m, attr, q, ref) => `${attr}=${q}${buildUrl(ref)}${q}`,
  );
}

function rewriteCssUrls(css, ctx) {
  const { pid, username, slug, currentPath, cacheKey, fromId } = ctx;
  const baseDir = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/") + 1) : "";
  const buildUrl = (ref) => {
    const rel = ref.startsWith("/") ? ref.slice(1) : baseDir + ref;
    const cleanBase =
      username && slug
        ? `${BASE_URL}/${encodeURIComponent(username)}/project/${encodeURIComponent(slug)}/`
        : `${BASE_URL}/api/host?action=serve&pid=${encodeURIComponent(pid)}&path=`;
    const encoded = rel.split("/").map(encodeURIComponent).join("/");
    const params = new URLSearchParams();
    if (cacheKey) params.set("v", cacheKey);
    if (fromId) params.set("from", fromId);
    const qs = params.toString();
    if (username && slug) return cleanBase + encoded + (qs ? "?" + qs : "");
    return `${cleanBase}${encodeURIComponent(rel)}${qs ? "&" + qs : ""}`;
  };
  return css.replace(
    /url\(\s*(["']?)((?!https?:|\/\/|data:)[^"')]+)\1\s*\)/gi,
    (m, q, ref) => `url("${buildUrl(ref)}")`,
  );
}

function injectTracker(html, pid) {
  const snippet = `<script>(function(){try{var p=location.pathname,r=document.referrer||"";fetch(${JSON.stringify(BASE_URL)}+"/api/analytics?action=hit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:${JSON.stringify(pid)},path:p,referrer:r}),keepalive:true}).catch(function(){})}catch(e){}})();</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, snippet + "\n</body>");
  return html + "\n" + snippet;
}

function isTextExt(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return ["html","htm","css","js","mjs","cjs","json","md","txt","svg","xml","yml","yaml","ts","tsx","jsx"].includes(ext);
}

function contentByteLength(content) {
  if (typeof content !== "string") return 0;
  const decoded = tryDecodeDataUri(content);
  if (decoded) return decoded.body.length;
  return Buffer.byteLength(content, "utf8");
}

async function readFileFromSource(pid, path, contentMap) {
  if (contentMap) {
    if (Object.prototype.hasOwnProperty.call(contentMap, path)) {
      return { path, content: contentMap[path] ?? "" };
    }
    return null;
  }
  const safeKey = sanitizeFirebasePath(path.replace(/\//g, "__"));
  const snap = await db.ref(`files/${pid}/${safeKey}`).once("value");
  if (!snap.exists()) return null;
  const v = snap.val() || {};
  return { path: v.path || path, content: String(v.content ?? "") };
}

async function listFilesFromSource(pid, contentMap) {
  if (contentMap) {
    return Object.entries(contentMap).map(([p, c]) => ({ path: p, content: String(c ?? "") }));
  }
  const snap = await db.ref(`files/${pid}`).once("value");
  const out = [];
  if (snap.exists()) {
    snap.forEach((c) => {
      const v = c.val();
      if (v?.path) out.push({ path: v.path, content: String(v.content ?? "") });
    });
  }
  return out;
}

async function resolveRequestPath(pid, wantPath, contentMap) {
  const cleaned = String(wantPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleaned) {
    const idx = (await readFileFromSource(pid, "index.html", contentMap)) ||
                (await readFileFromSource(pid, "index.htm", contentMap));
    if (idx) return { kind: "file", path: idx.path, content: idx.content };
    return { kind: "folder", path: "" };
  }

  const hasExt = /\.[a-zA-Z0-9]+$/.test(cleaned.split("/").pop() || "");

  if (!hasExt) {
    const idx = (await readFileFromSource(pid, `${cleaned}/index.html`, contentMap)) ||
                (await readFileFromSource(pid, `${cleaned}/index.htm`, contentMap));
    if (idx) return { kind: "file", path: idx.path, content: idx.content };
    const html = (await readFileFromSource(pid, `${cleaned}.html`, contentMap)) ||
                 (await readFileFromSource(pid, `${cleaned}.htm`, contentMap));
    if (html) return { kind: "file", path: html.path, content: html.content };
    return { kind: "folder", path: cleaned };
  }

  const file = await readFileFromSource(pid, cleaned, contentMap);
  if (file) return { kind: "file", path: file.path, content: file.content };
  return { kind: "notfound", path: cleaned };
}

async function renderFolderListing(res, {
  pid, project, folderPath, contentMap, username, slug,
  cacheKey, fromId, canAccessPrivate,
}) {
  if (!canAccessPrivate && project.visibility?.liveSite !== "public") {
    return sendHtmlPage(res, {
      title: "Private folder", heading: "This folder is private",
      message: "The owner hasn't published file browsing publicly.",
      icon: "lock", status: 403,
    });
  }

  const allFiles = await listFilesFromSource(pid, contentMap);
  const prefix = folderPath ? folderPath + "/" : "";
  const direct = [];
  const subFolders = new Set();
  for (const f of allFiles) {
    if (prefix && !f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) direct.push({ name: rest, path: f.path, size: contentByteLength(f.content) });
    else subFolders.add(rest.slice(0, slash));
  }
  direct.sort((a, b) => a.name.localeCompare(b.name));
  const foldersArr = [...subFolders].sort();

  const buildHref = (rel) => {
    const relPath = folderPath ? `${folderPath}/${rel}` : rel;
    const base = username && slug
      ? `${BASE_URL}/${encodeURIComponent(username)}/project/${encodeURIComponent(slug)}/${relPath.split("/").map(encodeURIComponent).join("/")}`
      : `${BASE_URL}/api/host?action=serve&pid=${encodeURIComponent(pid)}&path=${encodeURIComponent(relPath)}`;
    const params = new URLSearchParams();
    if (cacheKey) params.set("v", cacheKey);
    if (fromId) params.set("from", fromId);
    const qs = params.toString();
    if (!qs) return base;
    return base + (username && slug ? "?" : "&") + qs;
  };

  const rows = [];
  for (const f of foldersArr) {
    rows.push(`<li><a href="${escapeHtml(buildHref(f + "/"))}"><span class="dir">${inlineSvg("folder", 13)}</span> ${escapeHtml(f)}/</a></li>`);
  }
  for (const f of direct) {
    const icon = isTextExt(f.name) ? "code" : "file";
    rows.push(`<li><a href="${escapeHtml(buildHref(f.name))}"><span>${inlineSvg(icon, 13)}</span> ${escapeHtml(f.name)}<span class="meta">${Math.round(f.size / 1024)} KB</span></a></li>`);
  }

  const titlePath = folderPath ? `${project.name || "Project"} / ${folderPath}` : project.name || "Project";
  const parentLink = folderPath ? `<a class="btn ghost" href="${escapeHtml(buildHref("../"))}" style="margin-bottom:8px;">← Up</a>` : "";
  const extraHtml = rows.length
    ? `${parentLink}<ul class="file-list">${rows.join("")}</ul>`
    : `${parentLink}<p style="color:rgba(232,236,241,0.5);font-size:12px;">This folder is empty.</p>`;

  return sendHtmlPage(res, {
    title: titlePath,
    heading: folderPath || project.name || "Project files",
    message: "Browse files in this folder.",
    icon: "folder", status: 200, extraHtml, robotsNoIndex: true,
  });
}

async function handleServe(req, res, reqId) {
  const sendText = (status, body) => {
    res.status(status).setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(body);
  };

  // ── Block api/* and secrets/* paths (defense in depth) ──────────
  const initialPath = String(req.query?.path || "").replace(/^\/+/, "");
  if (initialPath.startsWith("api/") || initialPath === "api") {
    return sendText(404, "Not found");
  }
  if (initialPath.startsWith("secrets") || initialPath === "secrets") {
    return sendText(404, "Not found");
  }

  let username = String(req.query?.username || "").trim().toLowerCase();
  let projectSlug = String(req.query?.project || "").trim();
  let pid = String(req.query?.pid || "").trim();

  if (username) {
    try {
      const prev = await db.ref(`previousUsernames/${username}`).once("value");
      if (prev.exists() && prev.val() && prev.val() !== username) {
        const target = `/` + prev.val() + `/project/` + encodeURIComponent(projectSlug);
        return res.redirect(301, `${BASE_URL}${target}`);
      }
    } catch {}
  }

  if (username && projectSlug) {
    const found = await findProjectBySlug(username, projectSlug);
    if (found) {
      if (found.pid !== pid) pid = found.pid;
    } else if (pid) {
      try {
        const ps = await db.ref(`previousSlugs/${pid}`).once("value");
        if (ps.exists()) {
          const map = ps.val() || {};
          if (map[projectSlug]) {
            return res.redirect(301, `${BASE_URL}/${username}/project/${map[projectSlug]}`);
          }
        }
      } catch {}
    } else {
      return sendHtmlPage(res, {
        title: "Project not found", heading: "Project not found",
        message: "The link you followed may be broken, or the project may have been deleted.",
        icon: "alert", status: 404,
      });
    }
  }

  if (!pid && !username) return sendText(400, "Missing pid or username/project");

  if (!pid && username && projectSlug) {
    const found = await findProjectBySlug(username, projectSlug);
    if (!found) {
      return sendHtmlPage(res, {
        title: "Project not found", heading: "Project not found",
        message: "The link you followed may be broken, or the project may have been deleted.",
        icon: "alert", status: 404,
      });
    }
    pid = found.pid;
  }

  if (!(await enforceRate(req, res, "serve", ipKey(req)))) return;

  const project = await getProjectCached(pid);
  if (!project) {
    return sendHtmlPage(res, {
      title: "Not found", heading: "Project not found",
      message: "This project does not exist or has been deleted.",
      icon: "alert", status: 404,
    });
  }

  const signedIn = await canAccessProjectFromReq(req);
  const canAccessPrivate = signedIn && (signedIn.role === "owner" || signedIn.role === "editor");

  const liveSitePublic = project.visibility?.liveSite === "public";
  if (!liveSitePublic && !canAccessPrivate) {
    const ownerUsername =
      username || project.ownerUsername ||
      (await getProjectOwnerUsername(pid, project)) || "";
    if (ownerUsername && project.slug && project.visibility?.profile === "public") {
      return res.redirect(301, `${BASE_URL}/${ownerUsername}/${project.slug}`);
    }
    return sendHtmlPage(res, {
      title: "Not found", heading: "This site is not live",
      message: "The owner hasn't published this project's live site publicly.",
      icon: "lock", status: 404,
    });
  }

  const fromId = String(req.query?.from || "").trim();
  let contentMap = null;
  if (fromId) {
    const dSnap = await db.ref(`projects/${pid}/deployments/${fromId}`).once("value");
    if (!dSnap.exists()) {
      return sendHtmlPage(res, {
        title: "Deployment not found", heading: "Deployment not found",
        message: "This deployment no longer exists.",
        icon: "alert", status: 404,
      });
    }
    const vid = dSnap.val()?.versionId;
    if (!vid) {
      return sendHtmlPage(res, {
        title: "Snapshot unavailable", heading: "Snapshot unavailable",
        message: "This deployment was created before snapshots were supported.",
        icon: "alert", status: 404,
      });
    }
    const vSnap = await db.ref(`versions/${pid}/${vid}`).once("value");
    if (!vSnap.exists()) {
      return sendHtmlPage(res, {
        title: "Snapshot unavailable", heading: "Snapshot unavailable",
        message: "The snapshot for this deployment has been deleted.",
        icon: "alert", status: 404,
      });
    }
    contentMap = snapshotToFiles(vSnap.val()?.files);
  }

  // ── Normalize path ──────────────────────────────────────────
  // Vercel passes `path` in several shapes depending on how the
  // rewrite captured the URL:
  //
  //   /user/project                    → path is undefined
  //   /user/project/                   → path is "" or "/" or undefined
  //   /user/project/index.html         → path is "index.html"
  //   /user/project/css/app.css        → path is "css/app.css"
  //   /user/project/view               → path is "view"
  //
  // All forms are normalized to a leading-slash-free, trailing-slash-
  // free string. Empty means "serve index.html".
  let wantPath = String(req.query?.path || "").trim();
  wantPath = wantPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!wantPath) {
    if (project.primaryFile) {
      wantPath = project.primaryFile;
    } else {
      wantPath = "index.html";
    }
  }

  if (!isValidRoutePath(wantPath)) return sendText(400, "Invalid path");

  const resolved = await resolveRequestPath(pid, wantPath, contentMap);

  if (resolved.kind === "folder") {
    const ownerUsername =
      username || project.ownerUsername ||
      (await getProjectOwnerUsername(pid, project)) || "";
    const cacheKey = fromId || project.deployment?.deploymentId || "dev";
    return renderFolderListing(res, {
      pid, project, folderPath: resolved.path, contentMap,
      username: ownerUsername, slug: project.slug,
      cacheKey, fromId, canAccessPrivate,
    });
  }

  if (resolved.kind === "notfound" || !resolved.content) {
    return sendHtmlPage(res, {
      title: "Not found", heading: "Not found",
      message: "The page you requested doesn't exist.",
      icon: "alert", status: 404,
    });
  }

  const relPath = resolved.path;
  const content = resolved.content;

  if (content.length > MAX_SERVE_FILE_BYTES) return sendText(413, "File too large to serve");

  const ownerUsername =
    username || project.ownerUsername ||
    (await getProjectOwnerUsername(pid, project)) || "";
  const cacheKey = fromId || project.deployment?.deploymentId || "dev";
  const mime = mimeFor(relPath);

  res.setHeader("Content-Type", mime);
  if (fromId) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("X-Folio-Deployment", fromId);
  }

  if (/\.html?$/i.test(relPath)) {
    let html = content;
    try {
      let meta = await resolveProjectMeta(pid, project);

      if (fromId) {
        try {
          const dThumb = await db
            .ref(`projects/${pid}/deployments/${fromId}/thumbnail/url`)
            .once("value");
          if (dThumb?.exists() && isValidOgUrl(dThumb.val())) {
            meta = { ...meta, ogImage: dThumb.val() };
          }
        } catch {}
      }

      const canonicalPath =
        relPath === "index.html" || relPath === "index.htm" ? "" : relPath;
      const baseCanonical = buildLiveSiteUrlForPath(
        ownerUsername,
        project,
        canonicalPath,
      );
      const canonicalUrl = fromId
        ? `${baseCanonical}?from=${encodeURIComponent(fromId)}`
        : baseCanonical;

      html = injectMetaIntoHtml(html, {
        project,
        meta,
        canonicalUrl,
        robotsNoIndex: !!fromId || !liveSitePublic,
      });
    } catch (err) {
      log("host.serve.meta_failed", { pid, message: err.message });
    }
    html = injectTracker(html, pid);
    html = rewriteRelativeUrls(html, {
      pid,
      username: ownerUsername,
      slug: project.slug,
      currentPath: relPath,
      cacheKey,
      fromId,
    });

    // ── Inject public secrets (only from live deployment) ───────
    if (!fromId) {
      try {
        const publicSecrets = await projectSecrets.readPublicSecrets(pid);
        if (publicSecrets && Object.keys(publicSecrets).length > 0) {
          const payload = JSON.stringify(publicSecrets).replace(/</g, "\\u003c");
          const script = `<script>window.__SECRETS__=Object.freeze(${payload});</script>`;
          if (/<\/head>/i.test(html)) {
            html = html.replace(/<\/head>/i, script + "\n</head>");
          } else {
            html = script + html;
          }
        }
      } catch (err) {
        log("host.serve.secrets_inject_failed", { pid, message: err.message });
      }
    }

    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    return res.status(200).send(html);
  }

  if (/\.css$/i.test(relPath)) {
    const rewritten = rewriteCssUrls(content, {
      pid, username: ownerUsername, slug: project.slug,
      currentPath: relPath, cacheKey, fromId,
    });
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    return res.status(200).send(rewritten);
  }

  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");

  if (/^https?:\/\//i.test(content)) {
    return res.redirect(302, content);
  }

  const decoded = tryDecodeDataUri(content);
  if (decoded) {
    res.setHeader("Content-Type", decoded.mime);
    res.setHeader("Content-Length", String(decoded.body.length));
    if (isBinaryMime(decoded.mime) && req.query?.download === "1") {
      const fname = relPath.split("/").pop() || "file";
      res.setHeader("Content-Disposition", `attachment; filename="${fname.replace(/"/g, "")}"`);
    }
    res.setHeader("Accept-Ranges", "none");
    return res.status(200).send(decoded.body);
  }

  if (isBinaryMime(mime)) {
    if (req.query?.download === "1") {
      const fname = relPath.split("/").pop() || "file";
      res.setHeader("Content-Disposition", `attachment; filename="${fname.replace(/"/g, "")}"`);
    }
    res.setHeader("Accept-Ranges", "none");
  }
  return res.status(200).send(content);
}

// =========================================================================
// API SYSTEM DEFAULT + API ROUTES
// =========================================================================

async function handleApiSystemDefault(req, res, reqId) {
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  try {
    const p = path.join(process.cwd(), "public", "api-system-default.js");
    const content = fs.readFileSync(p, "utf8");
    return res.status(200).send(content);
  } catch {
    return res.status(200).send(getDefaultSystemJs());
  }
}

async function handleApiRoutes(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });

  const access = await requireProjectRole(req, res, pid, "viewer");
  if (!access) return;

  const [routesSnap, hostsSnap, filesSnap, project] = await Promise.all([
    db.ref(`projects/${pid}/apiRoutes`).once("value"),
    db.ref(`projects/${pid}/allowedHosts`).once("value"),
    db.ref(`projects/${pid}/publicFileList`).once("value"),
    getProjectCached(pid),
  ]);

  const routes = routesSnap.exists() ? routesSnap.val() : { system: [], user: [] };
  const hosts = hostsSnap.exists() ? hostsSnap.val() : {};
  const publicFiles = filesSnap.exists()
    ? filesSnap.val()
    : { files: [], count: 0, totalBytes: 0 };

  // ✅ Build both URL styles
  const ownerUsername = project
    ? (project.ownerUsername || (await getProjectOwnerUsername(pid, project)))
    : null;
  const slug = project?.slug || null;

  // Friendly URL — requires both username and slug
  const friendlyBaseUrl =
    ownerUsername && slug
      ? `${BASE_URL}/${encodeURIComponent(ownerUsername)}/project/${encodeURIComponent(slug)}/api`
      : null;

  // Direct URL — always works, no lookup needed
  const directBaseUrl = `${BASE_URL}/api/${encodeURIComponent(pid)}`;

  // Preferred URL for display in the dashboard
  const primaryBaseUrl = friendlyBaseUrl || directBaseUrl;

  return res.status(200).json({
    success: true,
    system: routes.system || [],
    user: routes.user || [],
    maxFiles: MAX_API_FILES,
    baseUrl: primaryBaseUrl,           // ← what the dashboard shows by default
    friendlyBaseUrl,                    // ← null if username/slug unavailable
    directBaseUrl,                      // ← always present
    ownerUsername: ownerUsername || null,
    slug: slug || null,
    pid,
    allowedHosts: {
      builtin: [...BUILTIN_ALLOWED_HOSTS],
      declared: Object.entries(hosts).map(([host, meta]) => ({
        host,
        declaredBy: meta.declaredBy || [],
        validatedAt: meta.validatedAt,
        validatedOk: meta.validatedOk === true,
      })),
    },
    publicFiles: {
      files: publicFiles.files || [],
      count: publicFiles.count || 0,
      totalBytes: publicFiles.totalBytes || 0,
    },
  });
}

// =========================================================================
// PROJECTS CRUD
// =========================================================================

async function handleProjectsList(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "projectsList", `uid_${user.uid}`))) return;

  const projects = await listUserProjects(user.uid);

  const enriched = await Promise.all(
    projects.map(async (p) => {
      if (!p || !p.pid) return p;
      try {
        const full = await getProjectCached(p.pid);
        if (!full) return p;
        const thumbnail = full.thumbnail?.url && isValidOgUrl(full.thumbnail.url)
          ? { url: full.thumbnail.url, generatedAt: full.thumbnail.generatedAt || null }
          : null;
        const ogImage = full.ogImage?.url && isValidOgUrl(full.ogImage.url)
          ? {
              url: full.ogImage.url,
              template: full.ogImage.template || null,
              scene: full.ogImage.scene || null,
              palette: full.ogImage.palette || null,
              generatedAt: full.ogImage.generatedAt || null,
            }
          : null;
        const languages = full.languages?.breakdown && Object.keys(full.languages.breakdown).length > 0
          ? {
              breakdown: full.languages.breakdown,
              totalLines: full.languages.totalLines || 0,
              computedAt: full.languages.computedAt || null,
            }
          : null;
        const storageUsed = full.storageUsed || 0;
        return { ...p, thumbnail, ogImage, languages, storageUsed };
      } catch {
        return p;
      }
    }),
  );

  return res.status(200).json({ success: true, projects: enriched });
}

async function handleProjectsGet(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectsGet", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "viewer");
  if (!access) return;

  const p = await getProjectCached(pid);
  if (!p) return res.status(404).json({ success: false, error: "Not found" });

  let fileCount = 0;
  try {
    const filesSnap = await db.ref(`files/${pid}`).once("value");
    if (filesSnap.exists()) fileCount = filesSnap.numChildren();
  } catch {}

  const { apiKeyHash, ...safe } = p;
  return res.status(200).json({
    success: true,
    project: { pid, ...safe, fileCount, myRole: access.role },
  });
}

async function handleProjectsCreate(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "projectsCreate", `uid_${user.uid}`))) return;

  const { name, description } = req.body || {};
  if (!name || typeof name !== "string" || name.length < 1 || name.length > 100) {
    return res.status(400).json({ success: false, error: "name must be 1–100 chars" });
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
    return res.status(400).json({ success: false, error: "description must be ≤500 chars" });
  }

  try {
    const project = await createProjectRecord(user.uid, {
      name: name.trim(),
      description: description?.trim() || "",
      storageLimit: user.settings?.globalLimit || 10 * 1024 * 1024,
    });

    const safeSlug = slugifyProjectName(project.name || name);
    if (safeSlug && safeSlug !== project.slug) {
      await db.ref(`projects/${project.pid}/slug`).set(safeSlug).catch(() => {});
      project.slug = safeSlug;
    }

    const ownerUsername = user.profile?.username || null;
    if (ownerUsername) {
      await db.ref(`projects/${project.pid}/ownerUsername`).set(ownerUsername).catch(() => {});

      // ✅ NEW: populate slug index for the friendly API URL
      //    /{username}/project/{slug}/api/{route}
      if (project.slug) {
        await db.ref(`projectSlugs/${ownerUsername}/${project.slug}`)
          .set(project.pid)
          .catch(() => {});
      }
    }

    await db.ref(`projects/${project.pid}/ownerId`).set(user.uid).catch(() => {});
    await db.ref(`projects/${project.pid}/roles/${user.uid}`).set("owner").catch(() => {});
    await db.ref(`users/${user.uid}/projectIds/${project.pid}`).set(true).catch(() => {});

    invalidateProject(project.pid);

    await logProjectEvent(project.pid, user.uid, "project", "project.created", { name: project.name });
    const { apiKeyHash, ...safe } = project;
    return res.status(200).json({
      success: true, pid: project.pid,
      project: { ...safe, ownerId: user.uid, ownerUsername },
    });
  } catch (err) {
    log("host.projects_create.failed", { reqId, uid: user.uid, message: err.message });
    return res.status(500).json({ success: false, error: "Could not create project" });
  }
}

async function handleProjectsUpdate(req, res, reqId) {
  const { pid, name, description, iconUrl } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectsUpdate", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const existing = await getProjectCached(pid);
  if (!existing) return res.status(404).json({ success: false, error: "Project not found" });

  const patch = {};
  if (name !== undefined) {
    if (typeof name !== "string" || name.length < 1 || name.length > 100) {
      return res.status(400).json({ success: false, error: "name must be 1–100 chars" });
    }
    patch.name = name.trim();
  }
  if (description !== undefined) {
    if (typeof description !== "string" || description.length > 500) {
      return res.status(400).json({ success: false, error: "description must be ≤500 chars" });
    }
    patch.description = description.trim();
  }
  if (iconUrl !== undefined) {
    if (iconUrl !== null) {
      if (typeof iconUrl !== "string" || iconUrl.length > 500) {
        return res.status(400).json({ success: false, error: "iconUrl must be a string ≤500 chars or null" });
      }
      if (!iconUrl.startsWith("https://")) {
        return res.status(400).json({ success: false, error: "iconUrl must be an HTTPS URL — upload the image first" });
      }
    }
    patch.iconUrl = iconUrl;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: "No fields to update" });
  }

  if (patch.name && patch.name !== existing.name) {
    const newSlug = slugifyProjectName(patch.name) || existing.slug;
    if (newSlug && newSlug !== existing.slug) {
      try {
        const collisions = await db.ref("projects").orderByChild("ownerId").equalTo(existing.ownerId).once("value");
        let conflict = false;
        if (collisions.exists()) {
          collisions.forEach((child) => {
            const v = child.val() || {};
            if (child.key !== pid && v.slug === newSlug) conflict = true;
          });
        }
        if (!conflict) {
          patch.slug = newSlug;
          const MAX_PREV_SLUGS = 20;
          const prevSnap = await db.ref(`previousSlugs/${pid}`).once("value").catch(() => null);
          const prevMap = prevSnap?.exists() ? prevSnap.val() || {} : {};
          const updates = {};
          if (existing.slug) updates[`previousSlugs/${pid}/${existing.slug}`] = newSlug;
          const prevKeys = Object.keys(prevMap);
          if (prevKeys.length > MAX_PREV_SLUGS) {
            const sorted = prevKeys.sort((a, b) =>
              (prevMap[a] ? String(prevMap[a]).length : 0) - (prevMap[b] ? String(prevMap[b]).length : 0)
            );
            for (const k of sorted.slice(0, prevKeys.length - MAX_PREV_SLUGS)) {
              updates[`previousSlugs/${pid}/${k}`] = null;
            }
          }
          if (Object.keys(updates).length) await db.ref().update(updates).catch(() => {});

          // ✅ NEW: update slug index for the friendly API URL
          //    Remove the old entry, add the new one.
          try {
            const ownerUsername = await getProjectOwnerUsername(pid, existing);
            if (ownerUsername) {
              if (existing.slug && existing.slug !== newSlug) {
                await db.ref(`projectSlugs/${ownerUsername}/${existing.slug}`)
                  .remove()
                  .catch(() => {});
              }
              await db.ref(`projectSlugs/${ownerUsername}/${newSlug}`)
                .set(pid)
                .catch(() => {});
            }
          } catch (slugIdxErr) {
            log("host.projects_update.slug_index_failed", { pid, message: slugIdxErr.message });
          }
        }
      } catch {}
    }
  }

  patch.updatedAt = Date.now();
  await db.ref(`projects/${pid}`).update(patch);
  invalidateProject(pid);

  await logProjectEvent(pid, access.uid, "project", "project.updated", {
    fields: Object.keys(patch).filter((k) => k !== "updatedAt"),
  });

  if (patch.name !== undefined || patch.description !== undefined || patch.iconUrl !== undefined) {
    await invalidateProjectOgImage(pid);
    await db.ref(`projects/${pid}/thumbnail`).remove().catch(() => {});
    try {
      const dSnap = await db.ref(`projects/${pid}/deployments`).once("value");
      if (dSnap.exists()) {
        const updates = {};
        dSnap.forEach((child) => {
          updates[`projects/${pid}/deployments/${child.key}/thumbnail`] = null;
        });
        if (Object.keys(updates).length) await db.ref().update(updates);
      }
    } catch {}
  }

  const p = await getProjectCached(pid);
  const { apiKeyHash, ...safe } = p || {};
  return res.status(200).json({ success: true, project: { pid, ...safe } });
}

async function handleRegeneratePreview(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectsUpdate", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const project = await getProjectCached(pid);
  if (!project) return res.status(404).json({ success: false, error: "Project not found" });

  let files = null;
  try {
    const filesSnap = await db.ref(`files/${pid}`).once("value");
    files = {};
    if (filesSnap.exists()) {
      filesSnap.forEach((c) => {
        const v = c.val();
        if (v?.path) files[v.path] = v.content || "";
      });
    }
  } catch {}

  try {
    const languages = await ensureProjectLanguages(pid, project, files);
    const thumbnailUrl = await ensureProjectThumbnail(pid, files);
    await invalidateProjectOgImage(pid).catch(() => {});
    return res.status(200).json({
      success: true, languages,
      thumbnailUrl: thumbnailUrl || null, regeneratedAt: Date.now(),
    });
  } catch (err) {
    log("host.regenerate_preview.failed", { pid, message: err.message });
    return res.status(500).json({ success: false, error: err.message || "Regenerate failed" });
  }
}

async function handleProjectsDelete(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectsDelete", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  let projectName = "";
  let collaborators = [];
  try {
    const audience = await getProjectAudience(pid);
    collaborators = audience.uids.filter((u) => u !== access.uid);
    const nameSnap = await db.ref(`projects/${pid}/name`).once("value");
    projectName = nameSnap.exists() ? nameSnap.val() : "";
  } catch {}

  // ✅ NEW: clean up slug index entries before delete
  //    Removes projectSlugs/{username}/{slug} = pid so the friendly
  //    API URL resolver doesn't return a stale pid after deletion.
  try {
    const ownerSnap = await db.ref(`projects/${pid}`).once("value");
    const ownerId = ownerSnap.val()?.ownerId;
    if (ownerId) {
      const owner = await getUser(ownerId);
      const ownerUsername = owner?.profile?.username;
      if (ownerUsername) {
        const slugsSnap = await db.ref(`projectSlugs/${ownerUsername}`).once("value");
        if (slugsSnap.exists()) {
          const updates = {};
          slugsSnap.forEach((child) => {
            if (child.val() === pid) {
              updates[`projectSlugs/${ownerUsername}/${child.key}`] = null;
            }
          });
          if (Object.keys(updates).length > 0) {
            await db.ref().update(updates);
          }
        }
      }
    }
  } catch (err) {
    log("host.projects_delete.slug_index_cleanup_failed", { pid, message: err.message });
  }

  try {
    await deleteProjectCdnAssets(pid, reqId);
  } catch (err) {
    log("host.projects_delete.cdn_cleanup_failed", { pid, message: err.message });
  }
  try {
    await projectSecrets.deleteAllSecrets(pid);
  } catch (err) {
    log("host.projects_delete.secrets_cleanup_failed", { pid, message: err.message });
  }

  try {
    await deleteProjectRecord(pid, access.uid);
    invalidateProject(pid);
    projectDb.dbCacheInvalidate(pid);
    if (collaborators.length) {
      await notifyMany("project", collaborators, {
        title: "Project deleted",
        body: `"${projectName || "A project you collaborated on"}" was deleted by its owner.`,
        link: `${BASE_URL}/projects`,
        extra: { pid, deleted: true },
      });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    log("host.projects_delete.failed", { reqId, pid, message: err.message });
    return res.status(500).json({ success: false, error: "Could not delete project" });
  }
}

async function handleVersionsClear(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "versionsClear", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  const snap = await db.ref(`versions/${pid}`).once("value");
  let cleared = 0;
  let preservedDeploy = 0;
  if (snap.exists()) {
    const updates = {};
    snap.forEach((child) => {
      const v = child.val() || {};
      if (v.kind === "deploy") { preservedDeploy++; return; }
      updates[child.key] = null;
      cleared++;
    });
    if (cleared > 0) await db.ref(`versions/${pid}`).update(updates);
  }

  await logProjectEvent(pid, access.uid, "version", "versions.cleared", {
    count: cleared, preservedDeploy,
  });
  return res.status(200).json({ success: true, cleared, preservedDeploy });
}

async function handleCacheClear(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "cacheClear", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;
  await logProjectEvent(pid, access.uid, "project", "cache.cleared", {});
  return res.status(200).json({ success: true, message: "Client cache is clearable via project.html" });
}

// =========================================================================
// EXPORT / SYNC-BACK / COPY
// =========================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dt = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: dt };
}

function buildZip(entries) {
  const localHeaders = [];
  const centralDir = [];
  let offset = 0;
  const { time, date } = dosDateTime();
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);
    localHeaders.push(localHeader, data);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralDir.push(central);
    offset += localHeader.length + data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralDir) centralSize += c.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centralDir.length, 8);
  end.writeUInt16LE(centralDir.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localHeaders, ...centralDir, end]);
}

async function handleProjectExport(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  const format = String(req.query?.format || "folio").toLowerCase();
  const versionId = String(req.query?.versionId || "").trim();
  const publicOnly = String(req.query?.publicOnly || "false") === "true";
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!["folio", "zip"].includes(format)) {
    return res.status(400).json({ success: false, error: "format must be folio or zip" });
  }
  if (!(await enforceRate(req, res, "projectExport", `pid_${pid}`))) return;

  let access = null;
  if (publicOnly) {
    const user = await requireAuth(req, res);
    if (!user) return;
    access = await canAccessProject(user.uid, pid);
    if (!access) {
      const visSnap = await db.ref(`projects/${pid}/visibility/profile`).once("value");
      if (!visSnap.exists() || visSnap.val() !== "public") {
        return res.status(403).json({ success: false, error: "Project is not public" });
      }
      access = { uid: null, role: "viewer" };
    }
  } else {
    const a = await requireProjectRole(req, res, pid, "viewer");
    if (!a) return;
    access = a;
  }

  const project = await getProjectCached(pid);
  if (!project) return res.status(404).json({ success: false, error: "Project not found" });
  const { apiKeyHash, roles, ...safeProject } = project;

  let filesObj = {};
  if (versionId) {
    const vSnap = await db.ref(`versions/${pid}/${versionId}`).once("value");
    if (!vSnap.exists()) return res.status(404).json({ success: false, error: "Version not found" });
    filesObj = snapshotToFiles(vSnap.val().files);
  } else {
    const filesSnap = await db.ref(`files/${pid}`).once("value");
    if (filesSnap.exists()) {
      filesSnap.forEach((child) => {
        filesObj[child.key] = child.val()?.content || "";
      });
    }
  }

  if (publicOnly) {
    const publicFiles = project.publicFiles || {};
    const filtered = {};
    for (const [filePath, content] of Object.entries(filesObj)) {
      const safePath = sanitizeFirebasePath(filePath.replace(/\//g, "__"));
      if (publicFiles[safePath]) filtered[filePath] = content;
    }
    filesObj = filtered;
  }

  let versionsObj = {};
  if (format === "folio" && !publicOnly) {
    const vSnap = await db.ref(`versions/${pid}`).once("value");
    if (vSnap.exists()) {
      vSnap.forEach((child) => { versionsObj[child.key] = child.val(); });
    }
  }

  let jsonDb = null;
  let jsonDbSchema = null;
  if (format === "folio" && !publicOnly) {
    jsonDb = await projectDb.dbRead(pid);
    jsonDbSchema = await projectDb.dbSchemaGet(pid);
  }

  const entries = [];
  const manifest = {
    folioVersion: 1,
    exportedAt: nowIso(),
    exportedBy: access.uid || null,
    pid,
    name: safeProject.name || "",
    slug: safeProject.slug || "",
    description: safeProject.description || "",
    language: safeProject.languages?.breakdown || {},
    project: safeProject,
    versions: format === "folio" ? Object.keys(versionsObj) : [],
    hasJsonDb: !!jsonDb,
    hasSchema: !!jsonDbSchema,
    publicOnly,
  };
  entries.push({
    name: "manifest.json",
    data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
  });

  for (const [filePath, content] of Object.entries(filesObj)) {
    let buf;
    const decoded = tryDecodeDataUri(content);
    if (decoded) buf = decoded.body;
    else buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(String(content));
    entries.push({ name: `files/${filePath}`, data: buf });
  }

  if (format === "folio" && !publicOnly) {
    for (const [vid, v] of Object.entries(versionsObj)) {
      entries.push({
        name: `versions/${vid}.json`,
        data: Buffer.from(JSON.stringify(v, null, 2), "utf8"),
      });
    }
    if (jsonDb) {
      entries.push({
        name: "db.json",
        data: Buffer.from(JSON.stringify(jsonDb, null, 2), "utf8"),
      });
    }
    if (jsonDbSchema) {
      entries.push({
        name: "schema.json",
        data: Buffer.from(JSON.stringify(jsonDbSchema, null, 2), "utf8"),
      });
    }
  }

  const zipBuffer = buildZip(entries);
  const filename = `${safeProject.slug || "project"}-${pid.slice(-6)}.${format === "folio" ? "folio" : "zip"}`;
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Project-Pid", pid);
  res.setHeader("X-Project-Format", format);
  res.setHeader("X-Project-Files", String(Object.keys(filesObj).length));
  await logProjectEvent(pid, access.uid, "project", "project.exported", {
    format, fileCount: Object.keys(filesObj).length, publicOnly,
  });
  return res.status(200).send(zipBuffer);
}

async function handleProjectSyncBack(req, res, reqId) {
  const { pid, files, versions, db: jsonDb, schema: jsonSchema, manifest } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectSyncBack", `pid_${pid}`))) return;

  invalidateProject(pid);
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const project = await getProjectCached(pid);
  if (!project) return res.status(404).json({ success: false, error: "Project not found" });

  const result = {
    filesWritten: 0, filesSkipped: 0,
    versionsWritten: 0, dbWritten: false, schemaWritten: false,
  };

  if (files && typeof files === "object") {
    const entries = Object.entries(files).filter(([p, c]) => typeof c === "string" && isValidFilePath(p));
    for (let i = 0; i < entries.length; i += DEPLOY_PARALLEL_WRITES) {
      const batch = entries.slice(i, i + DEPLOY_PARALLEL_WRITES);
      await Promise.allSettled(
        batch.map(async ([p, c]) => {
          try {
            let stored = c;
            if (
              c.startsWith("data:image/") ||
              c.startsWith("data:application/pdf") ||
              c.startsWith("data:font/") ||
              c.startsWith("data:video/") ||
              c.startsWith("data:audio/")
            ) {
              try {
                stored = await uploadViaFlier(c, p.split("/").pop(), reqId);
              } catch (err) {
                log("host.sync_back.upload_failed", { pid, path: p, message: err.message });
                result.filesSkipped++;
                return;
              }
            }
            await db.ref(`files/${pid}/${sanitizeFirebasePath(p.replace(/\//g, "__"))}`).set({
              path: p, content: stored, updatedAt: Date.now(),
            });
            result.filesWritten++;
          } catch (err) {
            log("host.sync_back.file_failed", { pid, path: p, message: err.message });
            result.filesSkipped++;
          }
        }),
      );
    }
  }

  if (versions && typeof versions === "object") {
    for (const [vid, v] of Object.entries(versions)) {
      try {
        const exists = await db.ref(`versions/${pid}/${vid}`).once("value");
        if (exists.exists()) continue;
        const rawFiles = v?.files;
        let normalisedFiles = {};
        if (rawFiles && typeof rawFiles === "object") {
          const firstVal = Object.values(rawFiles)[0];
          if (firstVal && typeof firstVal === "object" && typeof firstVal.path === "string") {
            normalisedFiles = rawFiles;
          } else {
            const flat = {};
            for (const [k, c] of Object.entries(rawFiles)) {
              if (typeof c === "string") {
                const restoredPath = k.includes("__") ? k.replace(/__/g, "/") : k;
                flat[restoredPath] = c;
              }
            }
            normalisedFiles = filesToSnapshot(flat);
          }
        }
        await db.ref(`versions/${pid}/${vid}`).set({ ...v, files: normalisedFiles });
        result.versionsWritten++;
      } catch (err) {
        log("host.sync_back.version_failed", { pid, vid, message: err.message });
      }
    }
  }

  if (jsonDb !== undefined && jsonDb !== null) {
    try {
      await db.ref(`projectData/${pid}`).set(jsonDb);
      projectDb.dbCacheInvalidate(pid);
      result.dbWritten = true;
    } catch {}
  }
  if (jsonSchema !== undefined && jsonSchema !== null) {
    try {
      await db.ref(`projectSchemas/${pid}`).set(jsonSchema);
      result.schemaWritten = true;
    } catch {}
  }

  await touchProject(pid);
  await logProjectEvent(pid, access.uid, "project", "project.synced_back", {
    ...result,
    manifestAt: manifest?.exportedAt || null,
  });

  if (result.filesWritten > 0) {
    try {
      await ensureProjectLanguages(pid, project, files);
    } catch (err) {
      log("host.sync_back.languages_failed", { pid, message: err.message });
    }
    try {
      await ensureProjectThumbnail(pid, files);
    } catch (err) {
      log("host.sync_back.thumbnail_failed", { pid, message: err.message });
    }
    await invalidateProjectOgImage(pid).catch(() => {});
  }

  return res.status(200).json({ success: true, ...result });
}

// =========================================================================
// FILES
// =========================================================================

async function canAccessProjectFromReq(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const decoded = verifySession(header.slice(7).trim());
  if (!decoded) return null;
  const pid = req.query?.pid || req.body?.pid || "";
  if (!pid) return null;
  const role = await canAccessProject(decoded.uid, pid);
  return role ? { uid: decoded.uid, role } : null;
}

async function handleFileList(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "fileList", `pid_${pid}`))) return;

  let role = null;
  const signedIn = await canAccessProjectFromReq(req);
  if (signedIn) role = signedIn.role;

  let isCodePublic = false;
  try {
    const visSnap = await db.ref(`projects/${pid}/visibility/code`).once("value");
    isCodePublic = visSnap.exists() && visSnap.val() === "public";
  } catch {}

  if (!role && !isCodePublic) return res.status(403).json({ success: false, error: "Access denied" });

  const project = await getProjectCached(pid);
  if (!project) return res.status(404).json({ success: false, error: "Project not found" });

  const publicFiles = project.publicFiles || {};
  const hasPublicFilesList = Object.keys(publicFiles).length > 0;
  const enforceFileList = !role && hasPublicFilesList;

  const filesSnap = await db.ref(`files/${pid}`).once("value");
  const files = [];
  if (filesSnap.exists()) {
    filesSnap.forEach((child) => {
      const v = child.val() || {};
      const p = v.path || child.key.replace(/__/g, "/");
      // Never expose api/* files through the file list
      if (p.startsWith("api/")) return;
      if (enforceFileList) {
        const safePath = sanitizeFirebasePath(p.replace(/\//g, "__"));
        if (!publicFiles[safePath]) return;
      }
      files.push({ path: p, size: (v.content || "").length, updatedAt: v.updatedAt || null });
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  let thumbnailUrl = null;
  try {
    const thumbSnap = await db.ref(`projects/${pid}/thumbnail/url`).once("value").catch(() => null);
    if (thumbSnap?.exists() && isValidOgUrl(thumbSnap.val())) thumbnailUrl = thumbSnap.val();
  } catch {}

  return res.status(200).json({
    success: true, files, total: files.length, isCodePublic,
    isEditor: role === "owner" || role === "editor", thumbnailUrl,
  });
}

async function handleFileGet(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  const filePath = String(req.query?.path || "").trim();
  if (!pid || !filePath) {
    return res.status(400).json({ success: false, error: "Missing pid or path" });
  }
  if (!isValidFilePath(filePath)) return res.status(400).json({ success: false, error: "Invalid path" });
  if (!(await enforceRate(req, res, "fileGet", `pid_${pid}`))) return;

  // Never serve api/* files
  if (filePath.startsWith("api/")) {
    return res.status(404).json({ success: false, error: "File not found" });
  }

  let role = null;
  const signedIn = await canAccessProjectFromReq(req);
  if (signedIn) role = signedIn.role;

  let isCodePublic = false;
  try {
    const visSnap = await db.ref(`projects/${pid}/visibility/code`).once("value");
    isCodePublic = visSnap.exists() && visSnap.val() === "public";
  } catch {}

  if (!role && !isCodePublic) return res.status(403).json({ success: false, error: "Access denied" });

  if (!role) {
    const publicSnap = await db.ref(`projects/${pid}/publicFiles`).once("value");
    const publicFiles = publicSnap.exists() ? publicSnap.val() : {};
    if (Object.keys(publicFiles).length > 0) {
      const safePath = sanitizeFirebasePath(filePath.replace(/\//g, "__"));
      if (!publicFiles[safePath]) return res.status(403).json({ success: false, error: "File not public" });
    }
  }

  const safePath = sanitizeFirebasePath(filePath.replace(/\//g, "__"));
  const snap = await db.ref(`files/${pid}/${safePath}`).once("value");
  if (!snap.exists()) return res.status(404).json({ success: false, error: "File not found" });
  const file = snap.val() || {};
  const MAX_RETURN = 2 * 1024 * 1024;
  const raw = String(file.content || "");
  const truncated = raw.length > MAX_RETURN;
  return res.status(200).json({
    success: true, path: file.path || filePath,
    content: truncated ? raw.slice(0, MAX_RETURN) : raw,
    truncated, bytes: raw.length, updatedAt: file.updatedAt || null,
  });
}

async function handleFileDelete(req, res, reqId) {
  const { pid, path: filePath } = req.body || {};
  if (!pid || !filePath) {
    return res.status(400).json({ success: false, error: "Missing pid or path" });
  }
  if (!isValidFilePath(filePath)) return res.status(400).json({ success: false, error: "Invalid path" });
  if (!(await enforceRate(req, res, "fileDelete", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  // Route to the correct tree
  const isApi = filePath.startsWith("api/");
  const tree = isApi ? "api-files" : "files";
  const rel = isApi ? filePath.slice(4) : filePath;
  const safePath = sanitizeFirebasePath(rel.replace(/\//g, "__"));

  await db.ref(`${tree}/${pid}/${safePath}`).remove();
  await touchProject(pid);
  await logProjectEvent(pid, access.uid, "file", "file.deleted", { path: filePath });
  invalidateProject(pid);
  return res.status(200).json({ success: true });
}

async function handleFileSave(req, res, reqId) {
  const { pid, path: filePath, content } = req.body || {};
  if (!pid || !filePath || typeof content !== "string") {
    return res.status(400).json({ success: false, error: "Missing pid, path, or content" });
  }
  if (!isValidFilePath(filePath)) return res.status(400).json({ success: false, error: "Invalid path" });
  if (!(await enforceRate(req, res, "fileSave", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const isApi = filePath.startsWith("api/");
  const tree = isApi ? "api-files" : "files";
  const rel = isApi ? filePath.slice(4) : filePath;

  let storedContent = content;
  let uploadedUrl = null;

  const isDataUri = content.startsWith("data:");
  const isBinaryData = isDataUri && (
    content.startsWith("data:image/") ||
    content.startsWith("data:application/pdf") ||
    content.startsWith("data:font/") ||
    content.startsWith("data:video/") ||
    content.startsWith("data:audio/")
  );

  if (isBinaryData && !isApi) {
    try {
      uploadedUrl = await uploadViaFlier(content, filePath.split("/").pop(), reqId);
    } catch (err) {
      return res.status(err.status || 500).json({ success: false, error: err.message || "Upload failed" });
    }
    storedContent = uploadedUrl;
  } else if (content.length > MAX_SERVE_FILE_BYTES) {
    return res.status(413).json({
      success: false,
      error: `Content exceeds ${Math.round(MAX_SERVE_FILE_BYTES / 1024)} KB`,
    });
  }

  try {
    await db.ref(`${tree}/${pid}/${sanitizeFirebasePath(rel.replace(/\//g, "__"))}`).set({
      path: rel, content: storedContent, updatedAt: Date.now(),
    });
  } catch (err) {
    log("host.file_save.write_failed", { reqId, pid, tree, message: err.message });
    return res.status(500).json({ success: false, error: "Write failed" });
  }

  await touchProject(pid);
  await logProjectEvent(pid, access.uid, "file", "file.saved", {
    path: filePath, bytes: storedContent.length, uploaded: !!uploadedUrl,
  });

  return res.status(200).json({
    success: true, path: filePath,
    content: storedContent, url: uploadedUrl,
  });
}

async function handleMigrateImages(req, res, reqId) {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ success: false, error: "Admin credentials required" });
  }
  const pid = String(req.body?.pid || req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });

  const filesSnap = await db.ref(`files/${pid}`).once("value");
  if (!filesSnap.exists()) {
    return res.status(200).json({ success: true, migrated: 0, total: 0 });
  }

  const entries = [];
  filesSnap.forEach((child) => {
    const v = child.val();
    if (!v || typeof v.content !== "string") return;
    if (!v.content.startsWith("data:image/")) return;
    entries.push({ key: child.key, path: v.path || child.key, content: v.content });
  });

  let migrated = 0;
  const errors = [];
  for (const e of entries) {
    try {
      const url = await uploadViaFlier(e.content, e.path.split("/").pop(), reqId);
      await db.ref(`files/${pid}/${e.key}`).update({ content: url, migratedAt: Date.now() });
      migrated++;
    } catch (err) {
      errors.push({ path: e.path, error: err.message });
    }
  }

  log("host.migrate_images.done", { reqId, pid, migrated, total: entries.length, failed: errors.length });

  return res.status(200).json({
    success: true, pid, total: entries.length, migrated,
    failed: errors.length, errors: errors.slice(0, 20),
  });
}

async function deleteProjectCdnAssets(pid, reqId) {
  const snap = await db.ref(`files/${pid}`).once("value").catch(() => null);
  if (!snap?.exists()) return { total: 0, deleted: 0 };

  const urls = [];
  snap.forEach((child) => {
    const v = child.val();
    if (v && typeof v.content === "string" && /^https?:\/\//i.test(v.content)) {
      urls.push(v.content);
    }
  });
  if (urls.length === 0) return { total: 0, deleted: 0 };

  let deleted = 0;
  for (const url of urls) {
    const ok = await deleteViaFlier(url, reqId);
    if (ok) deleted++;
  }

  log("host.cdn_assets_deleted", { reqId, pid, total: urls.length, deleted });
  return { total: urls.length, deleted };
}

// =========================================================================
// PROJECT HYDRATE
// =========================================================================

async function handleProjectHydrate(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectHydrate", `pid_${pid}`))) return;

  const access = await requireProjectRole(req, res, pid, "viewer");
  if (!access) return;

  const project = await getProjectCached(pid);
  if (!project) return res.status(404).json({ success: false, error: "Project not found" });

  const filesSnap = await db.ref(`files/${pid}`).once("value");
  const files = {};
  if (filesSnap.exists()) {
    filesSnap.forEach((child) => {
      const v = child.val() || {};
      const p = v.path || child.key.replace(/__/g, "/");
      // Never hydrate api/* files
      if (p.startsWith("api/")) return;
      if (v.path && typeof v.content === "string") files[v.path] = v.content;
    });
  }

  const versionsSnap = await db.ref(`versions/${pid}`).once("value").catch(() => null);
  const versions = {};
  if (versionsSnap?.exists()) {
    const entries = [];
    versionsSnap.forEach((child) => {
      const v = child.val() || {};
      entries.push({ vid: child.key, data: v });
    });
    entries.sort((a, b) => (b.data.createdAt || 0) - (a.data.createdAt || 0));
    for (const { vid, data } of entries.slice(0, 30)) {
      versions[vid] = { ...data, files: snapshotToFiles(data.files) };
    }
  }

  return res.status(200).json({
    success: true, pid, files, versions,
    fileCount: Object.keys(files).length,
    versionCount: Object.keys(versions).length,
    hydratedAt: Date.now(),
  });
}

// =========================================================================
// PROJECT COPY
// =========================================================================

async function handleProjectCopy(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { pid: sourcePid, newName } = req.body || {};
  if (!sourcePid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectCopy", `uid_${user.uid}`))) return;

  const source = await getProjectCached(sourcePid);
  if (!source) return res.status(404).json({ success: false, error: "Source project not found" });

  const role = await canAccessProject(user.uid, sourcePid);
  const canFullCopy = role === "owner" || role === "editor";
  const isPublic = source.visibility?.profile === "public";
  if (!canFullCopy && !isPublic) {
    return res.status(403).json({ success: false, error: "Cannot copy this project" });
  }

  let newProject;
  try {
    newProject = await createProjectRecord(user.uid, {
      name: (newName || `${source.name || "Copy"} (Copy)`).trim().slice(0, 100),
      description: source.description || "",
      storageLimit: user.settings?.globalLimit || 10 * 1024 * 1024,
    });
    const ownerUsername = user.profile?.username;
    if (ownerUsername) {
      await db.ref(`projects/${newProject.pid}/ownerUsername`).set(ownerUsername).catch(() => {});
    }
  } catch (err) {
    log("host.project_copy.create_failed", { reqId, uid: user.uid, message: err.message });
    return res.status(500).json({ success: false, error: "Could not create project" });
  }

  const filesSnap = await db.ref(`files/${sourcePid}`).once("value");
  let copiedFiles = 0;
  if (filesSnap.exists()) {
    const publicFiles = source.publicFiles || {};
    const filesToCopy = [];
    filesSnap.forEach((child) => {
      const v = child.val() || {};
      const p = v.path;
      const content = v.content || "";
      if (!p) return;
      // Never copy api/* files
      if (p.startsWith("api/")) return;
      if (!canFullCopy) {
        const safePath = sanitizeFirebasePath(p.replace(/\//g, "__"));
        if (!publicFiles[safePath]) return;
      }
      filesToCopy.push([p, content]);
    });
    for (let i = 0; i < filesToCopy.length; i += DEPLOY_PARALLEL_WRITES) {
      const batch = filesToCopy.slice(i, i + DEPLOY_PARALLEL_WRITES);
      await Promise.allSettled(
        batch.map(async ([p, c]) => {
          try {
            await db.ref(`files/${newProject.pid}/${sanitizeFirebasePath(p.replace(/\//g, "__"))}`).set({
              path: p, content: c, updatedAt: Date.now(),
            });
            copiedFiles++;
          } catch {}
        }),
      );
    }
  }

  if (canFullCopy) {
    try {
      const dbData = await projectDb.dbRead(sourcePid);
      if (dbData && Object.keys(dbData).length > 0) {
        await db.ref(`projectData/${newProject.pid}`).set(dbData);
        projectDb.dbCacheInvalidate(newProject.pid);
      }
      const schemaData = await projectDb.dbSchemaGet(sourcePid);
      if (schemaData) {
        await db.ref(`projectSchemas/${newProject.pid}`).set(schemaData);
      }
    } catch {}
  }

  await db.ref(`projects/${newProject.pid}`).update({
    forkedFrom: sourcePid, forkedAt: Date.now(), forkedBy: user.uid,
  });
  await logProjectEvent(newProject.pid, user.uid, "project", "project.copied", {
    sourcePid, copiedFiles, fullCopy: canFullCopy,
  });

  const { apiKeyHash, ...safeNew } = newProject;
  return res.status(200).json({
    success: true, pid: newProject.pid, project: safeNew,
    copiedFiles, fullCopy: canFullCopy,
  });
}

// =========================================================================
// JSON DB — HTTP wrappers
// =========================================================================

async function checkProjectKeyOrRole(req, res, pid, minRole) {
  const key = req.headers["x-project-key"];
  if (key && pid) {
    const ok = await verifyProjectKey(pid, key);
    if (ok) return { uid: "api", role: "editor" };
  }
  return requireProjectRole(req, res, pid, minRole);
}

async function handleDbSet(req, res, reqId) {
  const { pid, key, value, data, mode } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });

  const rl = await checkRateLimit(`pid_${pid}`, "dbSet");
  setRateHeaders(res, rl);
  if (!rl.allowed) {
    return res.status(429).json({
      success: false,
      error: "Rate limit exceeded",
      retryAfter: rl.retryAfter, reset: rl.reset,
    });
  }
  const rateLimitMeta = { limit: rl.limit, remaining: rl.remaining, reset: rl.reset };

  if (data !== undefined && mode !== "replace") {
    return res.status(400).json({
      success: false,
      error: "Full-replace writes require mode='replace'.",
      rateLimit: rateLimitMeta,
    });
  }

  const access = await checkProjectKeyOrRole(req, res, pid, "editor");
  if (!access) return;
  const uidForLog = access.uid === "api" ? null : access.uid;

  try {
    if (key !== undefined) {
      const result = await projectDb.dbWritePath(pid, key, value);
      await touchProject(pid);
      await maybePruneProjectLogs(pid);
      await logProjectEvent(pid, uidForLog, "db", "db.written", {
        key, mode: "path", bytes: result.bytes, viaApiKey: access.uid === "api",
      });
      return res.status(200).json({
        success: true, mode: "path", key,
        space: result.space, rateLimit: rateLimitMeta,
      });
    }

    if (data !== undefined && mode === "merge") {
      const result = await projectDb.dbMerge(pid, data);
      await touchProject(pid);
      await maybePruneProjectLogs(pid);
      await logProjectEvent(pid, uidForLog, "db", "db.written", {
        mode: "merge", keys: result.keys, bytes: result.bytes,
        viaApiKey: access.uid === "api",
      });
      return res.status(200).json({
        success: true, mode: "merge", keys: result.keys,
        space: result.space, rateLimit: rateLimitMeta,
      });
    }

    if (data !== undefined && mode === "replace") {
      const result = await projectDb.dbReplace(pid, data, { reqId });
      await touchProject(pid);
      await maybePruneProjectLogs(pid);
      await logProjectEvent(pid, uidForLog, "db", "db.written", {
        mode: "replace", bytes: result.bytes, viaApiKey: access.uid === "api",
      });
      return res.status(200).json({
        success: true, mode: "replace",
        space: result.space, rateLimit: rateLimitMeta,
      });
    }

    return res.status(400).json({ success: false, error: "Missing key or data", rateLimit: rateLimitMeta });
  } catch (err) {
    log("host.dbSet.error", { reqId, pid, message: err.message });
    return res.status(err.status || 500).json({
      success: false, error: err.message || "Write failed",
      rateLimit: rateLimitMeta,
    });
  }
}

async function handleDbGet(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "dbGet", `pid_${pid}`))) return;

  const key = req.headers["x-project-key"];
  let authorized = false;
  let uidForLog = null;
  if (key) authorized = await verifyProjectKey(pid, key);
  if (!authorized) {
    const access = await canAccessProjectFromReq(req);
    if (access) { authorized = true; uidForLog = access.uid; }
  }
  if (!authorized) authorized = await hasVisibility(pid, "db");
  if (!authorized) return res.status(403).json({ success: false, error: "Access denied" });

  const [data, schema] = await Promise.all([
    projectDb.dbRead(pid),
    projectDb.dbSchemaGet(pid),
  ]);

  const today = dayString();
  const serialized = JSON.stringify(data || {});
  const bytesOut = serialized.length;

  await db.ref(`analytics/${pid}/db/${today}`).transaction((cur) => {
    const c = cur || { reads: 0, writes: 0, bytesIn: 0, bytesOut: 0 };
    c.reads = (c.reads || 0) + 1;
    c.bytesOut = (c.bytesOut || 0) + bytesOut;
    return c;
  }).catch(() => {});

  let totalWrites = 0, todayWrites = 0, totalReads = 0;
  try {
    const a = await db.ref(`analytics/${pid}/db`).once("value");
    if (a.exists()) {
      a.forEach((d) => {
        const v = d.val() || {};
        const w = typeof v.writes === "number" ? v.writes : 0;
        const r = typeof v.reads === "number" ? v.reads : 0;
        totalWrites += w;
        totalReads += r;
        if (d.key === today) todayWrites = w;
      });
    }
  } catch {}

  const LIMIT = 15 * 1024 * 1024;
  const used = serialized.length;
  const space = {
    used,
    remaining: Math.max(0, LIMIT - used),
    limit: LIMIT,
    percentUsed: LIMIT > 0 ? Math.min(100, Math.round((used / LIMIT) * 1000) / 10) : 0,
  };

  const cacheKey = `dbSet:${sanitizeFirebasePath(String(`pid_${pid}`).toLowerCase())}`;
  const cached = RATE_CACHE.get(cacheKey);
  let rateLimit;
  const cfg = RATE_LIMITS.dbSet;
  if (cached && Date.now() - cached.at < RATE_CACHE_TTL) {
    rateLimit = cached.value;
  } else {
    try {
      const rlKey = sanitizeFirebasePath(String(`pid_${pid}`).toLowerCase());
      const rlSnap = await db.ref(`rate_limit/${API_NAME}/dbSet/${rlKey}`).once("value");
      if (rlSnap.exists()) {
        const d = rlSnap.val();
        const now = Date.now();
        const resetAt = (d.first_request || now) + cfg.window;
        if (now > resetAt) rateLimit = { limit: cfg.max, remaining: cfg.max, reset: null };
        else rateLimit = {
          limit: cfg.max,
          remaining: Math.max(0, cfg.max - (d.count || 0)),
          reset: new Date(resetAt).toISOString(),
        };
      } else {
        rateLimit = { limit: cfg.max, remaining: cfg.max, reset: null };
      }
      RATE_CACHE.set(cacheKey, { value: rateLimit, at: Date.now() });
    } catch {
      rateLimit = { limit: cfg.max, remaining: cfg.max, reset: null };
    }
  }

  return res.status(200).json({
    success: true, data, schema,
    calls: { total: totalWrites, today: todayWrites, reads: totalReads },
    rateLimit, space,
  });
}

async function handleDbBatch(req, res, reqId) {
  const { pid, updates } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "dbBatch", `pid_${pid}`))) return;
  const access = await checkProjectKeyOrRole(req, res, pid, "editor");
  if (!access) return;

  try {
    const result = await projectDb.dbBatch(pid, updates);
    await touchProject(pid);
    await maybePruneProjectLogs(pid);
    await logProjectEvent(pid, access.uid === "api" ? null : access.uid, "db", "db.batched", {
      paths: result.pathsWritten, bytes: result.bytes,
    });
    return res.status(200).json({
      success: true, pathsWritten: result.pathsWritten,
      bytes: result.bytes, space: result.space,
    });
  } catch (err) {
    log("host.db_batch.error", { reqId, pid, message: err.message });
    return res.status(err.status || 500).json({
      success: false, error: err.message || "Batch failed",
    });
  }
}

async function handleDbCas(req, res, reqId) {
  const { pid, key, expected, value } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!("expected" in req.body)) {
    return res.status(400).json({
      success: false,
      error: "Missing expected field",
    });
  }
  if (!(await enforceRate(req, res, "dbCas", `pid_${pid}`))) return;
  const access = await checkProjectKeyOrRole(req, res, pid, "editor");
  if (!access) return;

  try {
    const result = await projectDb.dbCas(pid, key, expected, value);
    if (!result.applied) {
      return res.status(409).json({
        success: false,
        error: "Value changed — CAS conflict",
        expected, current: result.current,
      });
    }
    await touchProject(pid);
    return res.status(200).json({ success: true, path: result.path, applied: true });
  } catch (err) {
    log("host.db_cas.error", { reqId, pid, key, message: err.message });
    return res.status(err.status || 500).json({
      success: false, error: err.message || "CAS failed",
    });
  }
}

async function handleDbIncrement(req, res, reqId) {
  const { pid, key, by = 1 } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "dbIncrement", `pid_${pid}`))) return;
  const access = await checkProjectKeyOrRole(req, res, pid, "editor");
  if (!access) return;

  try {
    const result = await projectDb.dbIncrement(pid, key, by);
    await touchProject(pid);
    return res.status(200).json({ success: true, path: result.path, value: result.value });
  } catch (err) {
    log("host.db_increment.error", { reqId, pid, key, message: err.message });
    return res.status(err.status || 500).json({
      success: false, error: err.message || "Increment failed",
    });
  }
}

async function handleDbList(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  const path = String(req.query?.path || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "dbList", `pid_${pid}`))) return;
  const access = await checkProjectKeyOrRole(req, res, pid, "viewer");
  if (!access) return;

  try {
    const result = await projectDb.dbList(pid, path, {
      orderBy: String(req.query?.orderBy || "").trim() || null,
      limit: req.query?.limit,
      startAt: req.query?.startAt != null ? req.query.startAt : null,
      endAt: req.query?.endAt != null ? req.query.endAt : null,
    });
    return res.status(200).json({
      success: true, path: result.path, items: result.items,
      count: result.count, limit: result.limit, orderBy: result.orderBy,
    });
  } catch (err) {
    log("host.db_list.error", { reqId, pid, path, message: err.message });
    return res.status(err.status || 500).json({
      success: false, error: err.message || "List failed",
    });
  }
}

async function handleDbBackup(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "dbBackup", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  try {
    const result = await projectDb.dbBackup(pid, access.uid);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    log("host.db_backup.error", { reqId, pid, message: err.message });
    return res.status(err.status || 500).json({
      success: false, error: err.message || "Backup failed",
    });
  }
}

async function handleDbSnapshotList(req, res, reqId) {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ success: false, error: "Admin required" });
  }
  const pid = String(req.query?.pid || req.body?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });

  try {
    const result = await projectDb.dbSnapshotList(pid);
    return res.status(200).json({ success: true, ...result });
  } catch {
    return res.status(500).json({ success: false, error: "Failed to list snapshots" });
  }
}

async function handleDbSnapshotRestore(req, res, reqId) {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ success: false, error: "Admin required" });
  }
  const { pid, ts } = req.body || {};
  if (!pid || !ts) {
    return res.status(400).json({ success: false, error: "Missing pid or ts" });
  }

  try {
    const result = await projectDb.dbSnapshotRestore(pid, ts);
    log("host.db_snapshot.restored", { reqId, pid, ts });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false, error: err.message || "Restore failed",
    });
  }
}

async function handleDbSchema(req, res, reqId) {
  const { pid, schema } = req.body || {};
  if (!pid || typeof schema !== "object" || schema === null) {
    return res.status(400).json({ success: false, error: "Missing pid or schema" });
  }
  if (!(await enforceRate(req, res, "dbSchema", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  try {
    await projectDb.dbSchemaSet(pid, schema);
    await logProjectEvent(pid, access.uid, "db", "schema.updated", {
      fieldCount: Array.isArray(schema.fields) ? schema.fields.length : 0,
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false, error: err.message || "Schema save failed",
    });
  }
}

// =========================================================================
// SECRETS
// =========================================================================

async function handleSecretsList(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "secretsList", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  try {
    const { keys, count, publicCount } = await projectSecrets.listSecretKeys(pid);
    return res.status(200).json({
      success: true,
      keys,
      count,
      publicCount,
      encryptionEnabled: projectSecrets.isEncryptionEnabled(),
    });
  } catch (err) {
    log("host.secrets_list.error", { reqId, pid, message: err.message });
    return res.status(500).json({ success: false, error: "Failed to list secrets" });
  }
}

async function handleSecretsGet(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "secretsGet", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  try {
    const { entries, meta } = await projectSecrets.readSecrets(pid);
    const isOwner = access.role === "owner";
    const safeEntries = {};
    for (const [key, entry] of Object.entries(entries)) {
      safeEntries[key] = {
        value: isOwner ? entry.value : null,
        hasValue: !!entry.value,
        note: entry.note,
        visibility: entry.visibility,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        error: entry.error || null,
      };
    }
    return res.status(200).json({
      success: true,
      entries: safeEntries,
      meta,
      isOwner,
    });
  } catch (err) {
    log("host.secrets_get.error", { reqId, pid, message: err.message });
    return res.status(500).json({ success: false, error: "Failed to read secrets" });
  }
}

async function handleSecretsSet(req, res, reqId) {
  const { pid, key, value, note, visibility } = req.body || {};
  if (!pid || !key) {
    return res.status(400).json({ success: false, error: "Missing pid or key" });
  }
  if (!(await enforceRate(req, res, "secretsSet", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  try {
    const result = await projectSecrets.setSecret(pid, access.uid, key, value, note, visibility);
    await logProjectEvent(pid, access.uid, "secret", "secret.set", {
      key,
      visibility: result.visibility,
      bytes: Buffer.byteLength(String(value || ""), "utf8"),
    });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    log("host.secrets_set.error", { reqId, pid, key, message: err.message });
    return res.status(err.status || 500).json({
      success: false,
      error: err.message || "Failed to set secret",
    });
  }
}

async function handleSecretsDelete(req, res, reqId) {
  const { pid, key } = req.body || {};
  if (!pid || !key) {
    return res.status(400).json({ success: false, error: "Missing pid or key" });
  }
  if (!(await enforceRate(req, res, "secretsDelete", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  try {
    const result = await projectSecrets.deleteSecret(pid, access.uid, key);
    await logProjectEvent(pid, access.uid, "secret", "secret.deleted", { key });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    log("host.secrets_delete.error", { reqId, pid, key, message: err.message });
    return res.status(err.status || 500).json({
      success: false,
      error: err.message || "Failed to delete secret",
    });
  }
}

async function handleSecretsVisibility(req, res, reqId) {
  const { pid, key, visibility } = req.body || {};
  if (!pid || !key || !visibility) {
    return res.status(400).json({ success: false, error: "Missing pid, key, or visibility" });
  }
  if (!(await enforceRate(req, res, "secretsVisibility", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  try {
    const result = await projectSecrets.updateSecretVisibility(pid, access.uid, key, visibility);
    await logProjectEvent(pid, access.uid, "secret", "secret.visibility", {
      key,
      visibility: result.visibility,
      changed: result.changed,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    log("host.secrets_visibility.error", { reqId, pid, key, message: err.message });
    return res.status(err.status || 500).json({
      success: false,
      error: err.message || "Failed to update visibility",
    });
  }
}

// =========================================================================
// API KEYS
// =========================================================================

async function handleApiKeyGenerate(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "apikeyGenerate", `uid_${user.uid}`))) return;
  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  const { key, hash } = generateApiKey();
  await db.ref(`projects/${pid}`).update({ apiKeyHash: hash, apiKeyCreatedAt: Date.now() });
  invalidateProject(pid);

  // Store as FOLIO_API_KEY secret (private, internal-write to bypass reserved check)
  let storedInEnv = false;
  try {
    await projectSecrets.setSecret(
      pid,
      access.uid,
      "FOLIO_API_KEY",
      key,
      "Auto-generated project API key (used by api/*.js for Folio-internal calls)",
      "private",
      { allowReserved: true },
    );
    storedInEnv = true;
  } catch (err) {
    log("host.apikey.secret_store_failed", { pid, message: err.message });
  }

  await logProjectEvent(pid, access.uid, "project", "apikey.generated", { storedInEnv });

  try {
    const audience = await getProjectAudience(pid);
    const nameSnap = await db.ref(`projects/${pid}/name`).once("value");
    const pname = nameSnap.exists() ? nameSnap.val() : "your project";
    let imageUrl = null;
    try {
      imageUrl = await notificationImageUrl({
        title: "New API key", subtitle: `for "${pname}"`,
        template: "hero-short", scene: "halftone", palette: "mono",
      });
    } catch (err) {
      log("host.apikey_generate.image_error", { message: err.message });
    }
    await notifyMany("project", audience.uids, {
      title: "New API key generated",
      body: `A new API key was created for "${pname}". If this wasn't you, revoke it now.`,
      imageUrl, link: `${BASE_URL}/project?pid=${pid}`,
      extra: { pid, security: true },
    });
  } catch {}

  return res.status(200).json({
    success: true,
    key,
    storedInEnv,
    warning: storedInEnv ? null : "API key generated but could not be stored in ENV. Delete an unused secret and regenerate.",
  });
}

// =========================================================================
// VISIBILITY / INVITES / COLLABORATORS / METATAGS
// =========================================================================

const VISIBILITY_AXES = ["profile", "liveSite", "code", "languages", "db", "secrets"];
const SECRETS_VISIBILITY_VALUES = ["off", "inject", "private"];

async function handleVisibility(req, res, reqId) {
  const { pid, visibility } = req.body || {};
  if (!pid || typeof visibility !== "object" || visibility === null) {
    return res.status(400).json({ success: false, error: "Missing pid or visibility" });
  }
  if (!(await enforceRate(req, res, "visibility", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  const patch = {};
  const changes = {};
  for (const axis of VISIBILITY_AXES) {
    if (visibility[axis] === undefined) continue;
    if (axis === "secrets") {
      if (!SECRETS_VISIBILITY_VALUES.includes(visibility[axis])) {
        return res.status(400).json({
          success: false,
          error: `visibility.secrets must be one of: ${SECRETS_VISIBILITY_VALUES.join(", ")}`,
        });
      }
    } else if (visibility[axis] !== "public" && visibility[axis] !== "private") {
      return res.status(400).json({
        success: false,
        error: `visibility.${axis} must be "public" or "private"`,
      });
    }
    patch[`visibility/${axis}`] = visibility[axis];
    changes[axis] = visibility[axis];
  }
  if (Object.keys(patch).length === 0)
    return res.status(400).json({ success: false, error: "No visibility axes to update" });
  patch.updatedAt = Date.now();
  await db.ref(`projects/${pid}`).update(patch);
  invalidateProject(pid);
  await logProjectEvent(pid, access.uid, "project", "visibility.updated", { changes });

  return res.status(200).json({ success: true });
}

async function handleFileVisibility(req, res, reqId) {
  const { pid, path: filePath, isPublic } = req.body || {};
  if (!pid || !filePath || typeof isPublic !== "boolean") {
    return res.status(400).json({ success: false, error: "Missing pid, path, or isPublic" });
  }
  if (!(await enforceRate(req, res, "fileVisibility", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const safePath = sanitizeFirebasePath(filePath.replace(/\//g, "__"));
  if (isPublic) await db.ref(`projects/${pid}/publicFiles/${safePath}`).set(true);
  else await db.ref(`projects/${pid}/publicFiles/${safePath}`).remove();
  invalidateProject(pid);
  await logProjectEvent(pid, access.uid, "file", "file.visibility", { path: filePath, isPublic });
  return res.status(200).json({ success: true });
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 32);
}

async function lookupInviteByToken(token) {
  const tokenHash = hashToken(token);
  const byHash = await db.ref(`invites/${tokenHash}`).once("value");
  if (byHash.exists()) return { key: tokenHash, invite: byHash.val() };
  const byRaw = await db.ref(`invites/${token}`).once("value");
  if (byRaw.exists()) {
    const invite = byRaw.val();
    await db.ref(`invites/${tokenHash}`).set(invite).catch(() => {});
    await db.ref(`invites/${token}`).remove().catch(() => {});
    return { key: tokenHash, invite };
  }
  return null;
}

async function handleInviteCreate(req, res, reqId) {
  const { pid, username, role } = req.body || {};
  if (!pid || !username || !role) {
    return res.status(400).json({ success: false, error: "Missing pid, username, or role" });
  }
  if (!["viewer", "commenter", "editor"].includes(role)) {
    return res.status(400).json({ success: false, error: "Invalid role" });
  }
  if (!(await enforceRate(req, res, "inviteCreate", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const invited = await getUserByUsername(username);
  if (!invited) return res.status(404).json({ success: false, error: "User not found" });
  if (invited.uid === access.uid) {
    return res.status(400).json({ success: false, error: "Cannot invite yourself" });
  }
  const existingRole = await canAccessProject(invited.uid, pid);
  if (existingRole) {
    return res.status(409).json({ success: false, error: `User already has role: ${existingRole}` });
  }

  const token = generateInviteToken();
  const tokenHash = hashToken(token);
  const now = Date.now();
  await db.ref(`invites/${tokenHash}`).set({
    pid, role, invitedBy: access.uid, invitedUid: invited.uid,
    expiresAt: now + INVITE_TTL_MS,
    used: false, usedAt: null, createdAt: now,
  });

  try {
    const nameSnap = await db.ref(`projects/${pid}/name`).once("value");
    const pname = nameSnap.exists() ? nameSnap.val() : "a project";
    let imageUrl = null;
    try {
      imageUrl = await notificationImageUrl({
        title: `Invited to "${pname}"`, subtitle: `Join as ${role}`,
        template: "hero-short", scene: "ribbon", palette: "warm",
      });
    } catch (err) {
      log("host.invite_create.image_error", { message: err.message });
    }
    await callNotify("invite", invited.uid, {
      title: "Project invitation",
      body: `You've been invited to join "${pname}" as ${role}.`,
      imageUrl,
      link: `${BASE_URL}/invite.html?token=${token}`,
      extra: { token, pid, role },
    });
  } catch {}

  await logProjectEvent(pid, access.uid, "invite", "invite.sent", { invitedUid: invited.uid, role });
  return res.status(200).json({
    success: true, token,
    inviteUrl: `${BASE_URL}/invite.html?token=${token}`,
    expiresAt: now + INVITE_TTL_MS,
  });
}

async function handleInviteList(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "inviteList", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const snap = await db.ref("invites").once("value");
  const invites = [];
  const now = Date.now();
  if (snap.exists()) {
    snap.forEach((child) => {
      const v = child.val();
      if (!v || v.pid !== pid) return;
      const expiresAt = v.expiresAt || (v.createdAt ? v.createdAt + INVITE_TTL_MS : null);
      const expired = !!(expiresAt && expiresAt < now);
      invites.push({
        token: child.key,
        role: v.role || "viewer",
        invitedUid: v.invitedUid || null,
        invitedBy: v.invitedBy || null,
        createdAt: v.createdAt || null,
        expiresAt, expired,
        used: !!v.used,
        usedAt: v.usedAt || null,
      });
    });
  }
  const includeUsed = String(req.query?.includeUsed || "false") === "true";
  const filtered = invites.filter((i) => includeUsed || (!i.used && !i.expired));
  filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return res.status(200).json({
    success: true, invites: filtered, total: filtered.length,
    pending: invites.filter((i) => !i.used && !i.expired).length,
    expired: invites.filter((i) => !i.used && i.expired).length,
    used: invites.filter((i) => i.used).length,
  });
}

async function handleInviteAccept(req, res, reqId) {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: "Missing token" });
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "inviteAccept", `uid_${user.uid}`))) return;

  const found = await lookupInviteByToken(token);
  if (!found) return res.status(404).json({ success: false, error: "Invite not found" });
  const invite = found.invite;

  if (invite.used) return res.status(410).json({ success: false, error: "Invite already used" });
  if (invite.expiresAt && invite.expiresAt < Date.now()) {
    return res.status(410).json({ success: false, error: "Invite expired" });
  }
  if (invite.invitedUid !== user.uid) {
    return res.status(403).json({ success: false, error: "This invite is for someone else" });
  }

  await db.ref(`projects/${invite.pid}/roles/${user.uid}`).set(invite.role);
  await db.ref(`users/${user.uid}/projectIds/${invite.pid}`).set(true);
  await db.ref(`invites/${found.key}`).update({ used: true, usedAt: Date.now() });
  invalidateProject(invite.pid);
  await logProjectEvent(invite.pid, user.uid, "invite", "invite.accepted", { role: invite.role });

  try {
    if (invite.invitedBy && invite.invitedBy !== user.uid) {
      const [nameSnap, acceptorUser] = await Promise.all([
        db.ref(`projects/${invite.pid}/name`).once("value"),
        getUser(user.uid),
      ]);
      const pname = nameSnap.exists() ? nameSnap.val() : "your project";
      const who = acceptorUser?.profile?.username ? `@${acceptorUser.profile.username}` : "Someone";
      await callNotify("invite", invite.invitedBy, {
        title: "Invitation accepted",
        body: `${who} joined "${pname}" as ${invite.role}.`,
        link: `${BASE_URL}/project?pid=${invite.pid}`,
        extra: { pid: invite.pid, uid: user.uid, role: invite.role },
      });
    }
  } catch {}

  return res.status(200).json({ success: true, pid: invite.pid, role: invite.role });
}

async function handleInviteCancel(req, res, reqId) {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: "Missing token" });
  const found = await lookupInviteByToken(token);
  if (!found) return res.status(404).json({ success: false, error: "Invite not found" });
  const invite = found.invite;
  if (!(await enforceRate(req, res, "inviteCancel", `pid_${invite.pid}`))) return;
  const access = await requireProjectRole(req, res, invite.pid, "owner");
  if (!access) return;
  await db.ref(`invites/${found.key}`).remove();
  await logProjectEvent(invite.pid, access.uid, "invite", "invite.cancelled", {});
  return res.status(200).json({ success: true });
}

async function handleCollaboratorRemove(req, res, reqId) {
  const { pid, uid: targetUid } = req.body || {};
  if (!pid || !targetUid) return res.status(400).json({ success: false, error: "Missing pid or uid" });
  if (!(await enforceRate(req, res, "collaboratorRemove", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;
  await db.ref(`projects/${pid}/roles/${targetUid}`).remove();
  await db.ref(`users/${targetUid}/projectIds/${pid}`).remove();
  invalidateProject(pid);
  await logProjectEvent(pid, access.uid, "invite", "collaborator.removed", { targetUid });
  return res.status(200).json({ success: true });
}

async function handleMetatagsSave(req, res, reqId) {
  const { pid, metaTags } = req.body || {};
  if (!pid || typeof metaTags !== "object" || metaTags === null) {
    return res.status(400).json({ success: false, error: "Missing pid or metaTags" });
  }
  if (!(await enforceRate(req, res, "metatagsSave", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const clean = {};
  if (metaTags.title !== undefined) {
    if (typeof metaTags.title !== "string" || metaTags.title.length > 70) {
      return res.status(400).json({ success: false, error: "title must be ≤70 chars" });
    }
    clean.title = metaTags.title;
  }
  if (metaTags.description !== undefined) {
    if (typeof metaTags.description !== "string" || metaTags.description.length > 200) {
      return res.status(400).json({ success: false, error: "description must be ≤200 chars" });
    }
    clean.description = metaTags.description;
  }
  if (metaTags.ogImage !== undefined) {
    if (metaTags.ogImage !== null) {
      try {
        const u = new URL(metaTags.ogImage);
        if (u.protocol !== "https:") throw 0;
      } catch {
        return res.status(400).json({ success: false, error: "ogImage must be HTTPS or null" });
      }
    }
    clean.ogImage = metaTags.ogImage;
  }
  if (metaTags.ogType !== undefined) {
    if (!["website", "article", "profile"].includes(metaTags.ogType)) {
      return res.status(400).json({ success: false, error: "ogType invalid" });
    }
    clean.ogType = metaTags.ogType;
  }
  if (metaTags.twitterCard !== undefined) {
    if (!["summary", "summary_large_image"].includes(metaTags.twitterCard)) {
      return res.status(400).json({ success: false, error: "twitterCard invalid" });
    }
    clean.twitterCard = metaTags.twitterCard;
  }

  await db.ref(`projects/${pid}/metaTags`).set(clean);
  await db.ref(`projects/${pid}/updatedAt`).set(Date.now());
  invalidateProject(pid);
  await logProjectEvent(pid, access.uid, "project", "metatags.updated", {});
  return res.status(200).json({ success: true });
}

// =========================================================================
// SHARE / PROFILE / VIEW / LOGS
// =========================================================================

async function handleShare(req, res, reqId) {
  if (!(await enforceRate(req, res, "share", ipKey(req)))) return;

  const username = String(req.query?.username || "").trim().toLowerCase();
  const pidParam = String(req.query?.pid || "").trim();
  const slug = String(req.query?.project || "").trim();

  let found = null;
  if (pidParam) {
    const p = await getProjectCached(pidParam);
    if (p) {
      const owner = await getUser(p.ownerId);
      if (owner) found = { pid: pidParam, project: p, owner };
    }
  } else if (username && slug) {
    const bySlug = await findProjectBySlug(username, slug);
    if (bySlug) {
      const owner = bySlug.owner || (await getUserByUsername(username));
      if (owner) found = { ...bySlug, owner };
    }
  }

  if (!found) {
    return sendHtmlPage(res, {
      title: "Project not found", heading: "Project not found",
      message: "The link you followed may be broken, or the project may have been deleted.",
      icon: "alert", status: 404,
    });
  }

  const { pid, project, owner } = found;

  if (!project.languages?.breakdown || Object.keys(project.languages.breakdown).length === 0) {
    try {
      project.languages = await ensureProjectLanguages(pid, project, null);
    } catch (err) {
      log("host.share.languages_failed", { pid, message: err.message });
    }
  }

  const langsAvailable = project.languages?.breakdown && Object.keys(project.languages.breakdown).length > 0;
  if (!langsAvailable) {
    project.languages = { breakdown: {}, totalLines: 0, computedAt: Date.now() };
  }

  let projectThumbnailUrl = null;
  try {
    const t = await db.ref(`projects/${pid}/thumbnail/url`).once("value").catch(() => null);
    if (t?.exists() && isValidOgUrl(t.val())) projectThumbnailUrl = t.val();
  } catch {}

  const isProfilePublic = project.visibility?.profile === "public";

  let viewerUid = null;
  let viewerUsername = null;
  let viewerIsOwner = false;
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const decoded = verifySession(authHeader.slice(7).trim());
      if (decoded?.uid) {
        viewerUid = decoded.uid;
        const v = await getUser(decoded.uid);
        viewerUsername = v?.profile?.username || null;
        viewerIsOwner =
          project.ownerId === decoded.uid ||
          (project.roles && project.roles[decoded.uid] === "editor");
      }
    } catch {}
  }
  const isSignedIn = !!viewerUid;

  if (!isProfilePublic && !viewerIsOwner) {
    const liveSitePublic = project.visibility?.liveSite === "public";
    const hasLiveDeployment = project.deployment?.state === "READY" && !!project.slug;
    const ownerUsername = owner.profile?.username || username || project.ownerUsername || "";
    if (liveSitePublic && hasLiveDeployment && ownerUsername) {
      return res.redirect(302, `${BASE_URL}/${encodeURIComponent(ownerUsername)}/project/${encodeURIComponent(project.slug)}`);
    }
    return sendHtmlPage(res, {
      title: "Private project", heading: "This project page is private",
      message: "The owner hasn't published this project page yet.",
      icon: "lock", status: 404,
    });
  }

  const liveSitePublic = project.visibility?.liveSite === "public";
  const codePublic = project.visibility?.code === "public";
  const dbPublic = project.visibility?.db === "public";
  const languagesPublic = project.visibility?.languages !== "private" && langsAvailable;

  const ownerUsername = owner.profile?.username || username || project.ownerUsername || "";

  const detailsUrl = ownerUsername && project.slug
    ? buildProjectCleanUrl(ownerUsername, project, pid)
    : `${BASE_URL}/p/${pid}`;

  const hasLiveDeployment = project.deployment?.state === "READY" && !!project.slug;
  const liveUrl = liveSitePublic && hasLiveDeployment && ownerUsername
    ? buildLiveSiteUrl(ownerUsername, project)
    : null;

  const canCopy = isProfilePublic && isSignedIn && !viewerIsOwner;

  const resolvedMeta = await resolveProjectMeta(pid, project);
  const ogImageUrl = resolvedMeta.ogImage || null;

  const langBadges = languagesPublic && project.languages?.breakdown
    ? Object.entries(project.languages.breakdown)
        .sort(([, a], [, b]) => b - a)
        .map(([name, pct]) => `<span class="lang-badge"><span class="lang-dot"></span>${escapeHtml(name)} ${pct}%</span>`)
        .join("")
    : "";

  const liveBadge = liveUrl
    ? `<span class="status-badge live"><span class="dot"></span>Live</span>`
    : `<span class="status-badge">Not deployed</span>`;

  let ctaHtml = "";
  if (viewerIsOwner) {
    ctaHtml = `<a class="btn primary" href="${BASE_URL}/project?pid=${escapeHtml(pid)}">${inlineSvg("external", 14)} Open dashboard</a>`;
  } else if (canCopy) {
    ctaHtml = `<button class="btn primary" data-action="copy" data-pid="${escapeHtml(pid)}" type="button">${inlineSvg("copy", 14)} Save a copy</button>`;
  } else if (!isSignedIn) {
    const next = encodeURIComponent("/" + (ownerUsername || "") + "/" + (project.slug || ""));
    ctaHtml = `<a class="btn primary" href="${BASE_URL}/register?next=${next}">${inlineSvg("user", 14)} Sign in to copy</a>`;
  }

  const liveButtonHtml = liveUrl
    ? `<a class="btn secondary" href="${escapeHtml(liveUrl)}" target="_blank" rel="noopener">${inlineSvg("external", 14)} Visit live site</a>`
    : "";

  const codeButtonHtml = codePublic
    ? `<button class="btn secondary" data-action="view-code" type="button">${inlineSvg("code", 14)} View code</button>`
    : "";

  const projectIconHtml = projectIconHtmlFor(project);
  const ownerAvatarHtml = avatarHtmlFor(owner.profile, { size: 32, username: ownerUsername });
  const updatedAgo = formatTimeAgo(project.updatedAt);
  const createdLabel = formatDate(project.createdAt);

  const ownerAvatarUrl = owner.profile?.avatarUrl || null;
  const ownerProfileUrl = ownerUsername ? `/${ownerUsername}` : `${BASE_URL}`;
  const ownerDisplayName = owner.profile?.displayName || ownerUsername || "Anonymous";

  const contributors = await getVisibleContributors(pid, project, { viewerUid });

  const payload = {
    pid,
    slug: project.slug || "",
    name: project.name || "",
    description: project.description || "",
    ownerUsername,
    ownerDisplayName,
    ownerUid: project.ownerId || null,
    ownerAvatarUrl,
    ownerProfileUrl,
    contributors,
    detailsUrl,
    liveUrl: liveUrl || null,
    codePublic, dbPublic, languagesPublic,
    isOwnerViewer: viewerIsOwner,
    isSignedIn, canCopy, viewerUsername,
    canonicalPath: project.slug ? `/${ownerUsername}/${project.slug}` : `p/${pid}`,
    languages: languagesPublic ? project.languages?.breakdown || {} : {},
    updatedAt: project.updatedAt || null,
    createdAt: project.createdAt || null,
    deployedAt: project.deployment?.deployedAt || null,
    viewCount: typeof project.viewCount === "number" ? project.viewCount : 0,
    visibility: {
      profile: project.visibility?.profile || "private",
      liveSite: project.visibility?.liveSite || "private",
      code: project.visibility?.code || "private",
      languages: project.visibility?.languages || "private",
      db: project.visibility?.db || "private",
    },
    thumbnailUrl: projectThumbnailUrl || null,
    ogImageUrl: ogImageUrl || null,
    scene: project.ogImage?.scene || null,
    palette: project.ogImage?.palette || null,
    ogImageTemplate: project.ogImage?.template || null,
    ogImageGeneratedAt: project.ogImage?.generatedAt || null,
    baseUrl: BASE_URL,
    editorUrl: viewerIsOwner ? `${BASE_URL}/project?pid=${pid}` : null,
  };
  const projectScript = `<script>window.__PROJECT__ = ${JSON.stringify(payload).replace(/</g, "\\u003c")};</script>`;

  const ogImageMeta = ogImageUrl ? `<meta property="og:image" content="${escapeHtml(ogImageUrl)}">` : "";
  const twitterImageMeta = ogImageUrl ? `<meta name="twitter:image" content="${escapeHtml(ogImageUrl)}">` : "";

  const projectPreviewHtml = projectThumbnailUrl
    ? `<div class="project-hero"><img class="project-hero-image" src="${escapeHtml(projectThumbnailUrl)}" alt="${escapeHtml(project.name || "")} preview" loading="lazy" /></div>`
    : "";

  const ogPreviewHtml = viewerIsOwner && ogImageUrl
    ? `<div class="og-preview-panel"><div class="og-preview-head"><span class="og-preview-label">Share preview</span><span class="og-preview-badge">${escapeHtml(project.ogImage?.template || "auto")}</span></div><img class="og-preview-image" src="${escapeHtml(ogImageUrl)}" alt="OG preview" loading="lazy" /></div>`
    : "";

  try {
    const tmpl = readTemplate("project-template.html");
    const html = applyTemplate(tmpl, {
      PROJECT_NAME: project.name || project.slug || "Untitled project",
      PROJECT_SLUG: project.slug || "",
      PROJECT_PID: pid,
      PROJECT_DESCRIPTION: project.description || "",
      PROJECT_ICON_HTML: { raw: projectIconHtml },
      LANGUAGES: { raw: langBadges },
      UPDATED_AT: updatedAgo,
      CREATED_AT: createdLabel,
      OWNER_USERNAME: ownerUsername,
      OWNER_DISPLAY_NAME: ownerDisplayName,
      OWNER_AVATAR_HTML: { raw: ownerAvatarHtml },
      OWNER_PROFILE_URL: ownerProfileUrl,
      VIEWER_IS_OWNER: String(viewerIsOwner),
      IS_SIGNED_IN: String(isSignedIn),
      CAN_COPY: String(canCopy),
      LIVE_SITE_ENABLED: String(!!liveUrl),
      CODE_ENABLED: String(codePublic),
      DB_ENABLED: String(dbPublic),
      LANGUAGES_ENABLED: String(languagesPublic),
      CTA_HTML: { raw: ctaHtml },
      LIVE_BUTTON_HTML: { raw: liveButtonHtml },
      CODE_BUTTON_HTML: { raw: codeButtonHtml },
      LIVE_BADGE_HTML: { raw: liveBadge },
      OG_TITLE: project.metaTags?.title || project.name || project.slug || "",
      OG_DESCRIPTION: resolvedMeta.description || "",
      OG_IMAGE_META: { raw: ogImageMeta },
      TWITTER_IMAGE_META: { raw: twitterImageMeta },
      CANONICAL_URL: detailsUrl,
      SHARE_URL: detailsUrl,
      INJECT_PROJECT_SCRIPT: { raw: projectScript },
      PROJECT_PREVIEW_HTML: { raw: projectPreviewHtml },
      OG_PREVIEW_HTML: { raw: ogPreviewHtml },
      PROJECT_THUMBNAIL_URL: projectThumbnailUrl || "",
      PROJECT_OG_IMAGE_URL: ogImageUrl || "",
      PROJECT_SCENE: project.ogImage?.scene || "",
      PROJECT_PALETTE: project.ogImage?.palette || "",
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    return res.status(200).send(html);
  } catch (err) {
    log("host.share.template_failed", { pid, message: err.message });
    return sendHtmlPage(res, {
      title: project.name || "Project",
      heading: project.name || "Project",
      message: project.description || "A project on Folio.",
      status: 200, robotsNoIndex: false,
    });
  }
}

async function handleProfilePublic(req, res, reqId) {
  if (!(await enforceRate(req, res, "profilePublic", ipKey(req)))) return;

  const username = String(req.query?.username || "").trim().toLowerCase();
  if (!username) {
    return sendHtmlPage(res, {
      title: "Missing username", heading: "Profile not found",
      message: "No username was provided in the URL.",
      status: 400, icon: "alert",
    });
  }
  if (!/^[a-z0-9_-]{1,30}$/.test(username)) {
    return sendHtmlPage(res, {
      title: "Invalid username", heading: "Profile not found",
      message: "The username in the URL is not valid.",
      status: 400, icon: "user",
    });
  }
  if (RESERVED_USERNAMES.has(username)) {
    return sendHtmlPage(res, {
      title: "Profile not found", heading: "Profile not found",
      message: "This username is reserved.",
      status: 404, icon: "user",
    });
  }

  const prevSnap = await db.ref(`previousUsernames/${username}`).once("value");
  if (prevSnap.exists()) return res.redirect(301, `${BASE_URL}/${prevSnap.val()}`);

  const user = await getUserByUsername(username);
  if (!user) {
    return sendHtmlPage(res, {
      title: "Profile not found", heading: "Profile not found",
      message: `@${username} doesn't have a Folio account, or has changed their username.`,
      status: 404, icon: "user",
    });
  }

  if (!user.profile?.avatarUrl) {
    (async () => {
      try {
        const generated = await ensureUserAvatar(user.uid, user.profile?.displayName, username);
        if (generated) log("host.profile.avatar_generated_bg", { uid: user.uid, username });
      } catch (err) {
        log("host.profile.avatar_bg_failed", { uid: user.uid, message: err.message });
      }
    })();
  }

  let viewerUid = null;
  let viewerUsername = null;
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const decoded = verifySession(authHeader.slice(7).trim());
      if (decoded?.uid) {
        viewerUid = decoded.uid;
        const v = await getUser(decoded.uid);
        viewerUsername = v?.profile?.username || null;
      }
    } catch {}
  }
  const isSignedIn = !!viewerUid;
  const isOwner = viewerUid === user.uid;

  const projectIds = user.projectIds || {};
  const projectList = [];
  for (const pid of Object.keys(projectIds)) {
    const p = await getProjectCached(pid);
    if (!p) continue;
    if (!isOwner && p.visibility?.profile !== "public") continue;
    let thumbnailUrl = null;
    try {
      const t = await db.ref(`projects/${pid}/thumbnail/url`).once("value");
      if (t?.exists() && isValidOgUrl(t.val())) thumbnailUrl = t.val();
    } catch {}

    const url = p.slug ? `${BASE_URL}/${username}/${p.slug}` : `${BASE_URL}/p/${pid}`;
    const hasLiveDeployment = p.deployment?.state === "READY" && !!p.slug;
    const liveUrl = p.visibility?.liveSite === "public" && hasLiveDeployment
      ? `${BASE_URL}/${username}/project/${p.slug}`
      : null;

    projectList.push({
      pid, slug: p.slug || "", name: p.name || "Untitled",
      description: p.description || "",
      iconUrl: p.iconUrl || null, thumbnailUrl,
      languages: p.visibility?.languages !== "private" ? p.languages?.breakdown || {} : {},
      updatedAt: p.updatedAt || null,
      url, liveUrl,
      deploymentUrl: p.deployment?.url || null,
      viewCount: typeof p.viewCount === "number" ? p.viewCount : 0,
    });
  }
  projectList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const grid = projectList.length > 0
    ? projectList.map((pr) => {
        const iconHtml = pr.iconUrl
          ? `<img src="${escapeHtml(pr.iconUrl)}" alt="" style="width:44px;height:44px;border-radius:11px;object-fit:cover;display:block;">`
          : `<span style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:11px;background:linear-gradient(135deg,#F59E0B,#f97316);color:#0a0c10;font-weight:800;font-size:15px;">${escapeHtml(initialsOf(pr.name))}</span>`;
        const thumbHtml = pr.thumbnailUrl
          ? `<div class="project-card-thumb" style="background-image:url('${escapeHtml(pr.thumbnailUrl)}')"></div>`
          : `<div class="project-icon">${iconHtml}</div>`;
        const langBadges = Object.entries(pr.languages).slice(0, 3)
          .map(([n, v]) => `<span class="lang-badge"><span class="lang-dot"></span>${escapeHtml(n)} ${v}%</span>`)
          .join("");
        return `
          <a class="project-card" href="${escapeHtml(pr.url)}">
            ${thumbHtml}
            <div class="project-card-body">
              <h3 class="project-name">${escapeHtml(pr.name)}</h3>
              ${pr.description ? `<p class="project-desc">${escapeHtml(pr.description)}</p>` : ""}
              ${langBadges ? `<div class="card-badges">${langBadges}</div>` : ""}
              <span class="project-time">${formatTimeAgo(pr.updatedAt)}</span>
            </div>
          </a>`;
      }).join("")
    : `<div class="empty-state">
        <div class="empty-icon">${inlineSvg("folder", 22)}</div>
        <h3>No public projects yet</h3>
        <p>${isOwner ? "Publish a project to see it here." : `When @${escapeHtml(username)} publishes a project, it will appear here.`}</p>
        ${isOwner ? `<a class="btn primary" href="${BASE_URL}/projects">${inlineSvg("folder", 14)} Manage projects</a>` : ""}
      </div>`;

  const ownerControls = isOwner
    ? `<div class="owner-controls">
         <a class="btn secondary" href="${BASE_URL}/profile">${inlineSvg("user", 14)} Edit profile</a>
         <a class="btn ghost" href="${BASE_URL}/projects">${inlineSvg("folder", 14)} Manage projects</a>
       </div>`
    : "";

  const avatarHtml = avatarHtmlFor(user.profile, { size: 96, username });
  const bioBlock = user.profile?.bio ? `<p class="profile-bio">${escapeHtml(user.profile.bio)}</p>` : "";
  const linksEntries = Object.entries(user.profile?.links || {});
  const linksBlock = linksEntries.length
    ? `<div class="profile-links">${linksEntries
        .map(([k, v]) => `<a class="profile-link" href="${escapeHtml(v)}" target="_blank" rel="noopener">${escapeHtml(k)}</a>`)
        .join("")}</div>`
    : "";

  const profileUrl = `${BASE_URL}/${username}`;
  const shareProfileHtml = `<button class="btn ghost" type="button" data-action="share-profile" data-url="${escapeHtml(profileUrl)}">${inlineSvg("copy", 14)} Copy profile link</button>`;

  const signInCtaHtml = !isSignedIn
    ? `<div class="signin-banner"><span>Signed out — ${inlineSvg("user", 12)} viewing as guest</span><a class="btn primary btn-sm" href="${BASE_URL}/register?next=${encodeURIComponent("/" + username)}">Sign in</a></div>`
    : "";

  const profileOgImage = await ensureProfileOgImage({ user, username });
  const ogImageMeta = profileOgImage ? `<meta property="og:image" content="${escapeHtml(profileOgImage)}">` : "";
  const twitterImageMeta = profileOgImage ? `<meta name="twitter:image" content="${escapeHtml(profileOgImage)}">` : "";

  const profileJson = {
    username,
    displayName: user.profile?.displayName || username,
    bio: user.profile?.bio || "",
    avatarUrl: user.profile?.avatarUrl || null,
    isOwner, isSignedIn, viewerUsername,
    uid: user.uid,
    canonicalPath: `/${username}`,
    projectCount: projectList.length,
    joinedAt: user.createdAt || null,
    ogImageUrl: profileOgImage || null,
    scene: user.profile?.ogImage?.scene || null,
    ogImageTemplate: user.profile?.ogImage?.template || null,
    ogImageGeneratedAt: user.profile?.ogImage?.generatedAt || null,
    palette: user.profile?.ogImage?.palette || null,
    baseUrl: BASE_URL,
    projects: projectList,
    links: user.profile?.links || {},
  };
  const profileScript = `<script>window.__PROFILE__ = ${JSON.stringify(profileJson).replace(/</g, "\\u003c")};</script>`;

  const avatarPreloadHtml = user.profile?.avatarUrl
    ? `<link rel="preload" as="image" href="${escapeHtml(user.profile.avatarUrl)}">`
    : "";

  try {
    const tmpl = readTemplate("profile-template.html");
    const html = applyTemplate(tmpl, {
      DISPLAY_NAME: user.profile?.displayName || username,
      USERNAME: username,
      AVATAR_HTML: { raw: avatarHtml },
      BIO_BLOCK: { raw: bioBlock },
      LINKS_BLOCK: { raw: linksBlock },
      OWNER_CONTROLS: { raw: ownerControls },
      PROJECT_GRID: { raw: grid },
      PROJECT_COUNT: String(projectList.length),
      JOINED_AT: formatDate(user.createdAt, { withDay: true }),
      VIEWER_IS_OWNER: String(isOwner),
      IS_SIGNED_IN: String(isSignedIn),
      SHARE_PROFILE_HTML: { raw: shareProfileHtml },
      SIGNIN_CTA_HTML: { raw: signInCtaHtml },
      OG_TITLE: user.profile?.displayName || username,
      OG_DESCRIPTION: user.profile?.bio || "",
      OG_IMAGE_META: { raw: ogImageMeta },
      TWITTER_IMAGE_META: { raw: twitterImageMeta },
      CANONICAL_URL: `${BASE_URL}/${username}`,
      PROFILE_URL: `${BASE_URL}/${username}`,
      INJECT_PROFILE_SCRIPT: { raw: profileScript },
      PROFILE_AVATAR_PRELOAD_HTML: { raw: avatarPreloadHtml },
      PROFILE_AVATAR_URL: user.profile?.avatarUrl || "",
      PROFILE_OG_IMAGE_URL: profileOgImage || "",
      PROFILE_SCENE: user.profile?.ogImage?.scene || "",
      PROFILE_PALETTE: user.profile?.ogImage?.palette || "",
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    return res.status(200).send(html);
  } catch (err) {
    log("host.profile.template_failed", { username, message: err.message });
    return sendHtmlPage(res, {
      title: user.profile?.displayName || username,
      heading: user.profile?.displayName || username,
      message: user.profile?.bio || "A creator on Folio.",
      status: 200, robotsNoIndex: false,
    });
  }
}

async function handleView(req, res, reqId) {
  if (!(await enforceRate(req, res, "view", ipKey(req)))) return;
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ success: false, error: "Missing username" });
  if (isBot(req)) return res.status(200).json({ success: true, skipped: "bot" });
  const user = await getUserByUsername(username);
  if (!user) return res.status(404).json({ success: false, error: "User not found" });
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const decoded = verifySession(authHeader.slice(7).trim());
      if (decoded && decoded.uid === user.uid) return res.status(200).json({ success: true, skipped: "owner" });
    } catch {}
  }
  const ip = getClientIp(req);
  const ua = req.headers["user-agent"] || "";
  const today = dayString();
  const visitorHash = crypto.createHash("sha256").update(`${ip}|${ua}|${today}`).digest("hex").slice(0, 12);
  await db.ref(`analytics/${user.uid}/profile/views/${today}/${visitorHash}`).set({ ts: Date.now() });
  return res.status(200).json({ success: true });
}

async function handleLogs(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "logs", `pid_${pid}`))) return;
  const access = await requireProjectRole(req, res, pid, "viewer");
  if (!access) return;

  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
  const typeFilter = String(req.query?.type || "all");

  const snap = await db.ref(`logs/project/${pid}`).once("value");
  if (!snap.exists()) {
    return res.status(200).json({ success: true, logs: [], total: 0, hasMore: false });
  }

  const all = [];
  snap.forEach((child) => {
    const v = child.val();
    if (typeFilter !== "all" && v.type !== typeFilter) return;
    all.push({ id: child.key, ...v });
  });
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const slice = all.slice(offset, offset + limit);
  return res.status(200).json({
    success: true, logs: slice, total: all.length,
    hasMore: offset + limit < all.length,
  });
}

// =========================================================================
// CLIENT ERROR
// =========================================================================

const CLIENT_ERROR_RL = new Map();

async function handleClientError(req, res, reqId) {
  const ip = hashIp(getClientIp(req));
  const now = Date.now();
  let bucket = CLIENT_ERROR_RL.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + CLIENT_ERROR_RATE_WINDOW_MS };
    CLIENT_ERROR_RL.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > CLIENT_ERROR_RATE_LIMIT) {
    return res.status(429).json({ success: false, error: "Rate limited" });
  }

  const { message, stack, url, requestId, source } = req.body || {};
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res.status(400).json({ success: false, error: "Invalid message" });
  }
  const safeStack = typeof stack === "string" ? stack.slice(0, 4000) : null;
  const safeUrl = typeof url === "string" ? url.slice(0, 500) : null;
  const safeSource = typeof source === "string" ? source.slice(0, 60) : "unknown";
  const safeRequestId = typeof requestId === "string" ? requestId.slice(0, 60) : null;

  try {
    const day = dayString();
    const id = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    await db.ref(`logs/system/${day}/${id}`).set({
      ts: now,
      message: message.slice(0, 2000),
      stack: safeStack,
      url: safeUrl,
      source: safeSource,
      requestId: safeRequestId,
      ipHash: ip,
      ua: (req.headers["user-agent"] || "").slice(0, 200),
    });
  } catch (err) {
    log("host.client_error.write_failed", { message: err.message });
  }
  return res.status(204).end();
}

// =========================================================================
// ROUTER
// =========================================================================

export default async function handler(req, res) {
  const reqId = newReqId();
  res.setHeader("X-Request-Id", reqId);
  res.setHeader("Access-Control-Allow-Origin", BASE_URL);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Project-Key");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = String(req.query?.action || req.body?.action || "").trim();
  const method = req.method;
  const pidForLog = req.query?.pid || req.body?.pid || null;

  try {
    if (method === "GET" && action === "projects/list")
      return await handleProjectsList(req, res, reqId);
    if (method === "GET" && action === "projects/get")
      return await handleProjectsGet(req, res, reqId);
    if (method === "POST" && action === "projects/create")
      return await handleProjectsCreate(req, res, reqId);
    if (method === "POST" && action === "projects/update")
      return await handleProjectsUpdate(req, res, reqId);
    if (method === "POST" && action === "projects/delete")
      return await handleProjectsDelete(req, res, reqId);
    if (method === "POST" && action === "project/regenerate-preview")
      return await handleRegeneratePreview(req, res, reqId);

    if (method === "POST" && action === "deploy")
      return await handleDeploy(req, res, reqId);
    if (method === "POST" && action === "redeploy")
      return await handleRedeploy(req, res, reqId);
    if (method === "GET" && action === "status")
      return await handleStatus(req, res, reqId);

    if (method === "GET" && action === "deployment/history")
      return await handleDeploymentHistory(req, res, reqId);
    if (method === "POST" && action === "deployment/offline")
      return await handleDeploymentOffline(req, res, reqId);
    if (method === "POST" && action === "deployment/delete")
      return await handleDeploymentDelete(req, res, reqId);

    if (method === "POST" && action === "versions/clear")
      return await handleVersionsClear(req, res, reqId);
    if (method === "POST" && action === "cache/clear")
      return await handleCacheClear(req, res, reqId);

    if (method === "GET" && action === "project/export")
      return await handleProjectExport(req, res, reqId);
    if (method === "POST" && action === "project/sync-back")
      return await handleProjectSyncBack(req, res, reqId);
    if (method === "POST" && action === "project/copy")
      return await handleProjectCopy(req, res, reqId);

    if (method === "GET" && action === "file/list")
      return await handleFileList(req, res, reqId);
    if (method === "GET" && action === "file/get")
      return await handleFileGet(req, res, reqId);
    if (method === "POST" && action === "file/delete")
      return await handleFileDelete(req, res, reqId);
    if (method === "POST" && action === "file/save")
      return await handleFileSave(req, res, reqId);
    if (method === "POST" && action === "migrate-images")
      return await handleMigrateImages(req, res, reqId);
    if (method === "GET" && action === "project/hydrate")
      return await handleProjectHydrate(req, res, reqId);
    if (method === "GET" && action === "serve")
      return await handleServe(req, res, reqId);

    if (method === "POST" && action === "db/set")
      return await handleDbSet(req, res, reqId);
    if (method === "GET" && action === "db/get")
      return await handleDbGet(req, res, reqId);
    if (method === "POST" && action === "db/schema")
      return await handleDbSchema(req, res, reqId);

    if (method === "POST" && action === "db/batch")
      return await handleDbBatch(req, res, reqId);
    if (method === "POST" && action === "db/cas")
      return await handleDbCas(req, res, reqId);
    if (method === "POST" && action === "db/increment")
      return await handleDbIncrement(req, res, reqId);
    if (method === "GET" && action === "db/list")
      return await handleDbList(req, res, reqId);
    if (method === "POST" && action === "db/backup")
      return await handleDbBackup(req, res, reqId);
    if (method === "GET" && action === "db/snapshots")
      return await handleDbSnapshotList(req, res, reqId);
    if (method === "POST" && action === "db/restore-snapshot")
      return await handleDbSnapshotRestore(req, res, reqId);

    if (method === "GET" && action === "secrets/list")
      return await handleSecretsList(req, res, reqId);
    if (method === "GET" && action === "secrets/get")
      return await handleSecretsGet(req, res, reqId);
    if (method === "POST" && action === "secrets/set")
      return await handleSecretsSet(req, res, reqId);
    if (method === "POST" && action === "secrets/delete")
      return await handleSecretsDelete(req, res, reqId);
    if (method === "POST" && action === "secrets/visibility")
      return await handleSecretsVisibility(req, res, reqId);

    if (method === "GET" && action === "api-system-default")
      return await handleApiSystemDefault(req, res, reqId);
    if (method === "GET" && action === "api-routes")
      return await handleApiRoutes(req, res, reqId);

    if (method === "POST" && action === "apikey/generate")
      return await handleApiKeyGenerate(req, res, reqId);
    if (method === "POST" && action === "visibility")
      return await handleVisibility(req, res, reqId);
    if (method === "POST" && action === "file-visibility")
      return await handleFileVisibility(req, res, reqId);
    if (method === "POST" && action === "invite/create")
      return await handleInviteCreate(req, res, reqId);
    if (method === "GET" && action === "invite/list")
      return await handleInviteList(req, res, reqId);
    if (method === "POST" && action === "invite/accept")
      return await handleInviteAccept(req, res, reqId);
    if (method === "POST" && action === "invite/cancel")
      return await handleInviteCancel(req, res, reqId);
    if (method === "POST" && action === "collaborator/remove")
      return await handleCollaboratorRemove(req, res, reqId);
    if (method === "POST" && action === "metatags/save")
      return await handleMetatagsSave(req, res, reqId);

    if (method === "GET" && action === "share")
      return await handleShare(req, res, reqId);
    if (method === "GET" && action === "profile")
      return await handleProfilePublic(req, res, reqId);
    if (method === "POST" && action === "view")
      return await handleView(req, res, reqId);

    if (method === "GET" && action === "logs")
      return await handleLogs(req, res, reqId);

    if (method === "POST" && action === "client-error")
      return await handleClientError(req, res, reqId);

    return res.status(404).json({ success: false, error: `Unknown action: ${action || "(none)"}` });
  } catch (err) {
    log("host.unhandled_error", {
      reqId, action, method,
      message: err.message, stack: err.stack,
    });
    if (pidForLog) logProjectApiCall(pidForLog, false).catch(() => {});
    return res.status(500).json({ success: false, error: "Internal error", reqId });
  } finally {
    if (pidForLog) logProjectApiCall(pidForLog, true).catch(() => {});
  }
}

export const config = { runtime: "nodejs" };

export {
  invalidateProfileOgImage,
  ensureProjectOgImage,
  ensureProfileOgImage,
  ensureProjectLanguages,
  ensureProjectThumbnail,
  notificationImageUrl,
  buildProjectCleanUrl,
  buildLiveSiteUrl,
  buildLiveSiteUrlForPath,
  buildProjectCleanUrlForPath,
  rewriteRelativeUrls,
  rewriteCssUrls,
  injectMetaIntoHtml,
  getProjectCached,
  BASE_URL,
};