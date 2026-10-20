// api/host.js
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "../utils/firebase.js";
import { log, newReqId } from "../utils/log.js";
import {
  requireAuth, requireProjectRole,
  canAccessProject, canEditProject, hasVisibility,
  verifyProjectKey, generateApiKey,
  generateInviteToken,
  getUserByUsername, getUser,
  cleanUsername,
  getClientIp, hashIp, sanitizeFirebasePath,
  logUserEvent, logProjectEvent, logProjectApiCall,
  listUserProjects, createProjectRecord, deleteProjectRecord,
} from "../utils/users.js";

// =========================================================================
// RATE LIMITS
// =========================================================================

const API_NAME = "host";

const RATE_LIMITS = {
  deploy:             { max: 10,   window: 60 * 60 * 1000 },
  redeploy:           { max: 10,   window: 60 * 60 * 1000 },
  status:             { max: 120,  window: 60 * 60 * 1000 },
  dbSet:              { max: 100,  window: 60 * 1000 },
  dbGet:              { max: 300,  window: 60 * 1000 },
  dbSchema:           { max: 10,   window: 60 * 60 * 1000 },
  apikeyGenerate:     { max: 5,    window: 60 * 60 * 1000 },
  visibility:         { max: 20,   window: 60 * 60 * 1000 },
  fileVisibility:     { max: 100,  window: 60 * 60 * 1000 },
  inviteCreate:       { max: 20,   window: 60 * 60 * 1000 },
  inviteList:         { max: 60,   window: 60 * 60 * 1000 },
  inviteAccept:       { max: 10,   window: 60 * 60 * 1000 },
  inviteCancel:       { max: 20,   window: 60 * 60 * 1000 },
  collaboratorRemove: { max: 20,   window: 60 * 60 * 1000 },
  metatagsSave:       { max: 20,   window: 60 * 60 * 1000 },
  share:              { max: 60,   window: 60 * 1000 },
  profilePublic:      { max: 60,   window: 60 * 1000 },
  view:               { max: 10,   window: 60 * 1000 },
  logs:               { max: 60,   window: 60 * 60 * 1000 },
  projectsList:       { max: 60,   window: 60 * 60 * 1000 },
  projectsGet:        { max: 120,  window: 60 * 60 * 1000 },
  projectsCreate:     { max: 20,   window: 60 * 60 * 1000 },
  projectsDelete:     { max: 10,   window: 60 * 60 * 1000 },
  projectsUpdate:     { max: 60,   window: 60 * 60 * 1000 },
  deploymentHistory:  { max: 120,  window: 60 * 60 * 1000 },
  deploymentOffline:  { max: 10,   window: 60 * 60 * 1000 },
  deploymentDelete:   { max: 20,   window: 60 * 60 * 1000 },
  versionsClear:      { max: 5,    window: 60 * 60 * 1000 },
  cacheClear:         { max: 10,   window: 60 * 60 * 1000 },
  projectExport:      { max: 30,   window: 60 * 60 * 1000 },
  projectSyncBack:    { max: 60,   window: 60 * 60 * 1000 },
  projectCopy:        { max: 20,   window: 60 * 60 * 1000 },
  fileGet:            { max: 120,  window: 60 * 60 * 1000 },
  fileList:           { max: 120,  window: 60 * 60 * 1000 },
  serve:              { max: 1200, window: 60 * 1000 },
};

async function checkRateLimit(identifier, action) {
  const config = RATE_LIMITS[action];
  if (!config) return { allowed: true };
  const now = Date.now();
  const key = sanitizeFirebasePath(String(identifier).toLowerCase());
  const ref = db.ref(`rate_limit/${API_NAME}/${action}/${key}`);
  const snap = await ref.once("value");

  if (!snap.exists()) {
    await ref.set({ count: 1, first_request: now, last_request: now });
    return { allowed: true, remaining: config.max - 1, limit: config.max,
             reset: new Date(now + config.window).toISOString() };
  }
  const d = snap.val();
  const resetAt = (d.first_request || now) + config.window;
  if (now > resetAt) {
    await ref.set({ count: 1, first_request: now, last_request: now });
    return { allowed: true, remaining: config.max - 1, limit: config.max,
             reset: new Date(now + config.window).toISOString() };
  }
  if ((d.count || 0) >= config.max) {
    return { allowed: false, remaining: 0, limit: config.max,
             reset: new Date(resetAt).toISOString(),
             retryAfter: Math.ceil((resetAt - now) / 1000) };
  }
  await ref.update({ count: (d.count || 0) + 1, last_request: now });
  return { allowed: true, remaining: config.max - (d.count || 0) - 1,
           limit: config.max, reset: new Date(resetAt).toISOString() };
}

function setRateHeaders(res, r) {
  if (!r) return;
  if (Number.isFinite(r.limit)) res.setHeader("X-RateLimit-Limit", String(r.limit));
  if (Number.isFinite(r.remaining)) res.setHeader("X-RateLimit-Remaining", String(r.remaining));
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

// =========================================================================
// HELPERS
// =========================================================================

const BASE_URL = process.env.BASE_URL || "https://foliostudios.vercel.app";

const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

const BOT_UA_RE = /bot|crawler|spider|preview|curl|wget|python-requests|httpclient/i;

// ── Fallback OG images ──
const FALLBACK_OG = { project: null, profile: null };

// ── Flier memory cache ──
const FLIER_MEM_CACHE = new Map();
const FLIER_MEM_TTL = 5 * 60 * 1000;
const FLIER_MEM_MAX = 200;

// ── OG URL validation ──
const OG_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const OG_URL_MAX_LENGTH = 500;

// ── Language cache TTL ──
const LANGUAGES_CACHE_TTL = 24 * 60 * 60 * 1000;

// ── Thumbnail sizes ──
const THUMBNAIL_SIZE = "512x512";
const OG_SIZE = "1200x630";

// ── Deterministic scene/palette pools ──
const PROJECT_SCENES = [
  "skyline", "ribbon", "terminal", "vinyl",
  "shelf", "halftone", "grid_wave", "window_sill",
];
const PROFILE_SCENES = [
  "ribbon", "halftone", "glass_cards",
  "book_spine", "rooftop", "cassette",
];
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
  return new Date(n).toLocaleDateString("en-US", withDay
    ? { month: "short", day: "numeric", year: "numeric" }
    : { month: "short", year: "numeric" });
}

function initialsOf(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]).join("").toUpperCase();
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
  };
  const body = icons[name] || "";
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function sendHtmlPage(res, { title, heading, message, signinUrl, browseUrl = `${BASE_URL}/projects`, icon = "alert", status = 200 }) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0c10">
<title>${escapeHtml(title)} — Folio</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{color-scheme:dark}
  body{background:#0a0c10;background-image:radial-gradient(circle at 50% -10%,rgba(245,158,11,0.14) 0%,transparent 60%);color:#e8ecf1;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;line-height:1.5}
  .card{background:rgba(21,25,34,0.72);border:1px solid rgba(255,255,255,0.09);border-radius:20px;padding:32px 24px;max-width:440px;width:100%;text-align:center}
  .icon{width:56px;height:56px;border-radius:16px;background:rgba(245,158,11,0.14);color:#F59E0B;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
  h1{font-size:20px;font-weight:800;letter-spacing:-0.4px;margin-bottom:8px}
  p{font-size:13px;color:rgba(232,236,241,0.72);margin-bottom:20px}
  .actions{display:flex;flex-direction:column;gap:8px}
  a.btn{display:flex;align-items:center;justify-content:center;padding:11px 16px;border-radius:10px;font-size:13px;font-weight:700;text-decoration:none;transition:background 0.15s}
  a.btn.primary{background:#F59E0B;color:#0a0c10}
  a.btn.primary:hover{background:#fbbf24}
  a.btn.ghost{background:transparent;color:rgba(232,236,241,0.72);border:1px solid rgba(255,255,255,0.08)}
  a.btn.ghost:hover{background:rgba(255,255,255,0.05);color:#e8ecf1}
</style>
</head><body>
<div class="card">
  <div class="icon">${inlineSvg(icon, 26)}</div>
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(message)}</p>
  <div class="actions">
    ${signinUrl ? `<a class="btn primary" href="${escapeHtml(signinUrl)}">Sign in</a>` : ""}
    <a class="btn ghost" href="${escapeHtml(browseUrl)}">Browse projects</a>
  </div>
</div>
</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(status).send(html);
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
    return String(v ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  });
}

async function findProjectBySlug(username, slug) {
  const owner = await getUserByUsername(username);
  if (!owner) return null;
  const snap = await db.ref("projects").orderByChild("ownerId").equalTo(owner.uid).once("value");
  if (!snap.exists()) return null;
  let found = null;
  snap.forEach(child => {
    const p = child.val();
    if (p.slug === slug) found = { pid: child.key, project: p };
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
    if (p.slug === slug && p.ownerId === uid) {
      return { pid, project: p };
    }
  }
  return null;
}

const LANG_MAP = {
  html: "HTML", htm: "HTML",
  css: "CSS", scss: "CSS", sass: "CSS", less: "CSS",
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  jsx: "JSX", ts: "TypeScript", tsx: "TSX",
  json: "JSON", md: "Markdown", markdown: "Markdown",
  svg: "SVG", xml: "XML", yml: "YAML", yaml: "YAML",
  py: "Python", rb: "Ruby", go: "Go", rs: "Rust",
  php: "PHP", java: "Java", kt: "Kotlin", swift: "Swift",
};

function computeLanguageBreakdown(publicFiles, fileContents) {
  const byExt = {};
  let total = 0;
  for (const p of Object.keys(publicFiles || {})) {
    const ext = (p.split(".").pop() || "").toLowerCase();
    const lang = LANG_MAP[ext];
    if (!lang) continue;
    const content = fileContents?.[p];
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

function injectHead(html, metaTags, pid) {
  const tags = [];
  const title = metaTags?.title || "";
  const desc = metaTags?.description || "";
  const og = metaTags?.ogImage || "";
  const ogType = metaTags?.ogType || "website";
  const tw = metaTags?.twitterCard || "summary_large_image";

  if (title) tags.push(`<title>${escapeHtml(title)}</title>`);
  if (desc) tags.push(`<meta name="description" content="${escapeHtml(desc)}">`);
  if (og) tags.push(`<meta property="og:image" content="${escapeHtml(og)}">`);
  tags.push(`<meta property="og:type" content="${escapeHtml(ogType)}">`);
  if (title) tags.push(`<meta property="og:title" content="${escapeHtml(title)}">`);
  if (desc) tags.push(`<meta property="og:description" content="${escapeHtml(desc)}">`);
  tags.push(`<meta name="twitter:card" content="${escapeHtml(tw)}">`);
  if (title) tags.push(`<meta name="twitter:title" content="${escapeHtml(title)}">`);
  if (desc) tags.push(`<meta name="twitter:description" content="${escapeHtml(desc)}">`);
  if (og) tags.push(`<meta name="twitter:image" content="${escapeHtml(og)}">`);

  const headClose = html.search(/<\/head>/i);
  if (headClose >= 0) {
    return html.slice(0, headClose) + tags.join("\n") + "\n" + html.slice(headClose);
  }
  return tags.join("\n") + "\n" + html;
}

function injectTracker(html, pid) {
  const snippet = `<script>(function(){try{var d=document,p=location.pathname,r=document.referrer||"";fetch(${JSON.stringify(BASE_URL)}+"/api/analytics?action=hit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:${JSON.stringify(pid)},path:p,referrer:r}),keepalive:true}).catch(function(){})}catch(e){}})();</script>`;
  const bodyClose = html.search(/<\/body>/i);
  if (bodyClose >= 0) {
    return html.slice(0, bodyClose) + snippet + "\n" + html.slice(bodyClose);
  }
  return html + "\n" + snippet;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// =========================================================================
// SERVE FROM DB — MIME + URL REWRITERS
// =========================================================================

const MIME_TYPES = {
  html:  "text/html; charset=utf-8",
  htm:   "text/html; charset=utf-8",
  css:   "text/css; charset=utf-8",
  js:    "application/javascript; charset=utf-8",
  mjs:   "application/javascript; charset=utf-8",
  cjs:   "application/javascript; charset=utf-8",
  json:  "application/json; charset=utf-8",
  md:    "text/markdown; charset=utf-8",
  txt:   "text/plain; charset=utf-8",
  svg:   "image/svg+xml",
  xml:   "application/xml; charset=utf-8",
  yml:   "text/yaml; charset=utf-8",
  yaml:  "text/yaml; charset=utf-8",
  png:   "image/png",
  jpg:   "image/jpeg",
  jpeg:  "image/jpeg",
  gif:   "image/gif",
  webp:  "image/webp",
  ico:   "image/x-icon",
  woff:  "font/woff",
  woff2: "font/woff2",
  ttf:   "font/ttf",
  otf:   "font/otf",
};

function mimeFor(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function rewriteRelativeUrls(html, pid, currentPath) {
  const baseDir = currentPath.includes("/")
    ? currentPath.slice(0, currentPath.lastIndexOf("/") + 1)
    : "";
  const serveUrl = (target) =>
    `/api/host?action=serve&pid=${encodeURIComponent(pid)}&path=${encodeURIComponent(target)}`;
  return html.replace(
    /\b(href|src|action)\s*=\s*(["'])((?!https?:|\/\/|data:|mailto:|#|javascript:)[^"']+)\2/gi,
    (m, attr, q, ref) => {
      const target = ref.startsWith("/") ? ref.slice(1) : baseDir + ref;
      return `${attr}=${q}${serveUrl(target)}${q}`;
    },
  );
}

function rewriteCssUrls(css, pid, currentPath) {
  const baseDir = currentPath.includes("/")
    ? currentPath.slice(0, currentPath.lastIndexOf("/") + 1)
    : "";
  return css.replace(
    /url\(\s*(["']?)((?!https?:|\/\/|data:)[^"')]+)\1\s*\)/gi,
    (m, q, ref) => {
      const target = ref.startsWith("/") ? ref.slice(1) : baseDir + ref;
      return `url("/api/host?action=serve&pid=${encodeURIComponent(pid)}&path=${encodeURIComponent(target)}")`;
    },
  );
}

// =========================================================================
// OG IMAGE GENERATION — lazily-generated, cached, signature-invalidated
// =========================================================================

const FLIER_INTERNAL_URL = process.env.FLIER_INTERNAL_URL || `${BASE_URL}/api/flier`;

function ogSignature(...parts) {
  const raw = parts.map(p => String(p ?? "")).join("|");
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
  return crypto.createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 32);
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
        log("og_image.flier_http", {
          status: res.status,
          attempt,
          body: text.slice(0, 200),
        });
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 400 + attempt * 600));
          continue;
        }
        return null;
      }

      const json = await res.json();

      if (!json.success || !json.url) {
        log("og_image.flier_no_url", { attempt, response: json });
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 400 + attempt * 600));
          continue;
        }
        return null;
      }

      if (!isValidOgUrl(json.url)) {
        log("og_image.flier_bad_url", { attempt, url: json.url });
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 400 + attempt * 600));
          continue;
        }
        return null;
      }

      flierCacheSet(cacheKey, json.url);

      if (json.imageReport) {
        for (const [slot, report] of Object.entries(json.imageReport)) {
          if (report && report.ok === false && report.code !== "NONE") {
            log("og_image.image_failed", {
              slot,
              code: report.code,
              message: report.message,
            });
          }
        }
      }

      return json.url;
    } catch (err) {
      log("og_image.flier_error", { attempt, message: err.message });
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 400 + attempt * 600));
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
    mode: "upload",
    type: "template",
    template: "hero-short",
    size: OG_SIZE,
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

  await db.ref(`og_defaults/${kind}`).set({
    url,
    generatedAt: Date.now(),
  }).catch(() => {});

  FALLBACK_OG[kind] = url;
  return url;
}

function pickSceneForProject(project) {
  const hash = crypto.createHash("sha256")
    .update(String(project.name || project.pid || ""))
    .digest();
  return PROJECT_SCENES[hash[0] % PROJECT_SCENES.length];
}

function pickPaletteForProject(project) {
  const hash = crypto.createHash("sha256")
    .update(String(project.name || project.pid || ""))
    .digest();
  return PALETTES[hash[1] % PALETTES.length];
}

function pickSceneForProfile(user, username) {
  const hash = crypto.createHash("sha256")
    .update(String(user.profile?.displayName || username || ""))
    .digest();
  return PROFILE_SCENES[hash[0] % PROFILE_SCENES.length];
}

function pickPaletteForProfile(user, username) {
  const hash = crypto.createHash("sha256")
    .update(String(user.profile?.displayName || username || ""))
    .digest();
  return PALETTES[hash[1] % PALETTES.length];
}

function deriveProjectDescription(project, files) {
  if (project.description?.trim()) return project.description.trim().slice(0, 160);

  if (files) {
    const htmlFile = files["index.html"] || files["index.htm"] ||
                     Object.entries(files).find(([p]) => /\.html?$/i.test(p))?.[1];
    if (htmlFile) {
      const h1 = String(htmlFile).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      const p  = String(htmlFile).match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const raw = (h1?.[1] || p?.[1] || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (raw.length > 15) return raw.slice(0, 160);
    }
  }

  const langs = Object.keys(project.languages?.breakdown || {});
  if (langs.length > 0) return `${langs.slice(0, 3).join(", ")} project on Folio`;
  return `${project.name || "A Folio project"} — built with Folio.`;
}

function pickProjectTemplate(project, derivedDesc, langs) {
  const nameLen   = (project.name || "").length;
  const descLen   = (derivedDesc || "").length;
  const hasIcon   = !!project.iconUrl;
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
  const nameLen     = displayName.length;
  const bioLen      = (derivedBio || "").length;
  const hasAvatar   = !!user.profile?.avatarUrl;

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

  const sig = ogSignature(
    project.name,
    derivedDesc,
    project.iconUrl,
    langs.slice(0, 4).join(","),
  );

  const cached = project.ogImage;
  if (cached?.url && cached.signature === sig && isValidOgUrl(cached.url)) {
    return cached.url;
  }

  const template = pickProjectTemplate(project, derivedDesc, langs);
  const scene = pickSceneForProject(project);
  const palette = pickPaletteForProject(project);

  const payload = {
    mode: "upload",
    type: "template",
    template,
    size: OG_SIZE,
    data: {
      text: {
        kicker: langs.length ? langs.slice(0, 2).join(" · ") : "FOLIO",
        headline: project.name || "Untitled project",
        subheadline: derivedDesc,
      },
      style: {
        variant: "dark",
        align: template === "product-grid-2" ? "left" : "center",
        colors: { primary: "#F59E0B", accent: "#fbbf24" },
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
    url,
    signature: sig,
    template,
    scene,
    palette,
    generatedAt: Date.now(),
  }).catch(() => {});

  return url;
}

async function ensureProfileOgImage({ user, username }) {
  const displayName = user.profile?.displayName || username;
  const derivedBio = (user.profile?.bio || "").trim().slice(0, 160);

  const sig = ogSignature(displayName, derivedBio, user.profile?.avatarUrl);

  const cached = user.profile?.ogImage;
  if (cached?.url && cached.signature === sig && isValidOgUrl(cached.url)) {
    return cached.url;
  }

  const template = pickProfileTemplate(user, derivedBio);
  const scene = pickSceneForProfile(user, username);
  const palette = pickPaletteForProfile(user, username);

  const payload = {
    mode: "upload",
    type: "template",
    template,
    size: OG_SIZE,
    data: {
      text: {
        kicker: `@${username}`,
        headline: displayName,
        subheadline: derivedBio,
      },
      style: {
        variant: "dark",
        align: template === "hero-short" ? "center" : "left",
        colors: { primary: "#F59E0B", accent: "#fbbf24" },
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
    url,
    signature: sig,
    template,
    scene,
    palette,
    generatedAt: Date.now(),
  }).catch(() => {});

  return url;
}

async function invalidateProjectOgImage(pid) {
  await db.ref(`projects/${pid}/ogImage`).remove().catch(() => {});
}

async function invalidateProfileOgImage(uid) {
  await db.ref(`users/${uid}/profile/ogImage`).remove().catch(() => {});
  await db.ref(`users/${uid}/profile/ogImageUrl`).remove().catch(() => {});
}

async function resolveProjectMeta(pid, project) {
  const meta = { ...(project.metaTags || {}) };

  if (!meta.ogImage || !isValidOgUrl(meta.ogImage)) {
    let files = null;
    if (!project.description?.trim()) {
      const snap = await db.ref(`files/${pid}`).once("value").catch(() => null);
      files = {};
      if (snap?.exists()) {
        snap.forEach(c => {
          const v = c.val();
          if (v?.path) files[v.path] = v.content || "";
        });
      }
    }
    const gen = await ensureProjectOgImage({ pid, project, files });
    if (gen) meta.ogImage = gen;
  }

  if (!meta.description) {
    meta.description = deriveProjectDescription(project, null);
  }

  return meta;
}

// =========================================================================
// LANGUAGE HELPERS
// =========================================================================

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
    if (!snap?.exists()) {
      return { breakdown: {}, totalLines: 0, computedAt: Date.now() };
    }
    files = {};
    snap.forEach(c => {
      const v = c.val();
      if (v?.path) files[v.path] = v.content || "";
    });
  }

  const { breakdown, totalLines, computedAt } = computeLanguageBreakdown(files, files);
  const record = { breakdown, totalLines, computedAt };

  await db.ref(`projects/${pid}/languages`).set(record).catch(() => {});

  return record;
}

// =========================================================================
// THUMBNAIL HELPERS
// =========================================================================

async function ensureProjectThumbnail(pid, files) {
  if (!files) {
    const snap = await db.ref(`files/${pid}`).once("value").catch(() => null);
    if (!snap?.exists()) return null;
    files = {};
    snap.forEach(c => {
      const v = c.val();
      if (v?.path) files[v.path] = v.content || "";
    });
  }

  const indexHtml =
    files["index.html"] ||
    files["index.htm"] ||
    Object.entries(files).find(([p]) => /\.html?$/i.test(p))?.[1];

  if (!indexHtml) return null;

  const sig = crypto.createHash("sha256")
    .update(indexHtml.slice(0, 5000))
    .digest("hex")
    .slice(0, 16);

  const existing = await db.ref(`projects/${pid}/thumbnail`).once("value").catch(() => null);
  if (existing?.exists()) {
    const t = existing.val();
    if (t.signature === sig && isValidOgUrl(t.url)) return t.url;
  }

  const payload = {
    mode: "upload",
    type: "html",
    html: indexHtml.slice(0, 200_000),
    size: THUMBNAIL_SIZE,
    upload: { name: `thumb_${pid}_${sig}` },
  };

  const url = await callFlier(payload);
  if (!url) return null;

  await db.ref(`projects/${pid}/thumbnail`).set({
    url,
    signature: sig,
    generatedAt: Date.now(),
  }).catch(() => {});

  return url;
}

async function ensureDeploymentThumbnail(pid, deploymentId, files) {
  if (!files) return null;

  const indexHtml =
    files["index.html"] ||
    files["index.htm"] ||
    Object.entries(files).find(([p]) => /\.html?$/i.test(p))?.[1];

  if (!indexHtml) return null;

  const sig = crypto.createHash("sha256")
    .update(indexHtml.slice(0, 5000))
    .digest("hex")
    .slice(0, 16);

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
    mode: "upload",
    type: "html",
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

// =========================================================================
// AVATAR HELPERS
// =========================================================================

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
    if (!json.success || !Array.isArray(json.variants) || json.variants.length === 0) {
      return null;
    }

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
    if (!upJson.success || !upJson.url || !isValidOgUrl(upJson.url)) {
      return null;
    }

    await db.ref(`users/${uid}/profile/avatarUrl`).set(upJson.url).catch(() => {});
    return upJson.url;
  } catch (err) {
    log("host.avatar_generate_failed", { uid, username, message: err.message });
    return null;
  }
}

// =========================================================================
// NOTIFICATION IMAGE HELPER
// =========================================================================

async function notificationImageUrl({
  title,
  subtitle = "",
  template = "hero-short",
  scene = "auto",
  palette = "warm",
  size = OG_SIZE,
} = {}) {
  if (!title) return null;

  const payload = {
    mode: "upload",
    type: "template",
    template,
    size,
    data: {
      text: {
        kicker: "FOLIO",
        headline: title,
        subheadline: subtitle,
      },
      style: {
        variant: "dark",
        scene,
        scenePalette: palette,
        colors: { primary: "#F59E0B", accent: "#fbbf24" },
      },
    },
    upload: { name: `notif_${Date.now()}` },
  };

  return await callFlier(payload);
}

// =========================================================================
// NOTIFICATIONS — helpers
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
  await Promise.allSettled(unique.map(uid => callNotify(type, uid, payload)));
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
      title: "Deployment failed",
      subtitle: reason,
      template: "stat-hero",
      scene: "grid_wave",
      palette: "sunset",
    });
  } catch (err) {
    log("host.notify_deploy_failed.image_error", { message: err.message });
  }

  await callNotify("project", access.uid, {
    title: "Deployment failed",
    body: `Deploy to "${projectName || "project"}" failed: ${reason}`,
    imageUrl,
    link: `${BASE_URL}/project.html?pid=${pid}`,
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
      template: "stat-hero",
      scene: "grid_wave",
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
    link: `${BASE_URL}/project.html?pid=${pid}`,
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
    await ref.transaction(cur => {
      const c = cur && (now - (cur.first || 0) < HOUR) ? cur : { count: 0, first: now };
      c.count += 1;
      if (c.count === 5 && !c.fired) { c.fired = true; fired = true; }
      return c;
    });
  } catch { return; }

  if (!fired) return;
  if (!ownerId && pid) {
    const snap = await db.ref(`projects/${pid}/ownerId`).once("value").catch(() => null);
    if (snap?.exists()) ownerId = snap.val();
  }
  if (!ownerId) return;

  await callNotify("security", ownerId, {
    title: "Repeated rate-limit warnings",
    body: `"${action}" is being rejected repeatedly${pid ? " on one of your projects" : ""}. Possible abuse or a stuck client.`,
    link: pid ? `${BASE_URL}/project.html?pid=${pid}` : `${BASE_URL}/projects`,
    extra: { action, pid, identifier: s, retryAfter: rateResult?.retryAfter },
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

  // Enrich each project with thumbnail, ogImage, languages, storageUsed
  const enriched = await Promise.all(projects.map(async (p) => {
    if (!p || !p.pid) return p;
    try {
      const snap = await db.ref(`projects/${p.pid}`).once("value");
      if (!snap.exists()) return p;
      const full = snap.val();

      const thumbnail = full.thumbnail?.url && isValidOgUrl(full.thumbnail.url)
        ? {
            url: full.thumbnail.url,
            generatedAt: full.thumbnail.generatedAt || null,
          }
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

      // Compute storageUsed from files if not stored
      let storageUsed = full.storageUsed || 0;
      if (!storageUsed) {
        try {
          const filesSnap = await db.ref(`files/${p.pid}`).once("value");
          if (filesSnap.exists()) {
            filesSnap.forEach(c => {
              const v = c.val();
              if (v?.content && typeof v.content === "string") {
                storageUsed += v.content.length;
              }
            });
          }
        } catch {}
      }

      return {
        ...p,
        thumbnail,
        ogImage,
        languages,
        storageUsed,
      };
    } catch {
      return p;
    }
  }));

  return res.status(200).json({ success: true, projects: enriched });
}

async function handleProjectsGet(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectsGet", `pid_${pid}`))) return;

  const access = await requireProjectRole(req, res, pid, "viewer");
  if (!access) return;

  const snap = await db.ref(`projects/${pid}`).once("value");
  if (!snap.exists()) return res.status(404).json({ success: false, error: "Not found" });

  const p = snap.val();
  const { apiKeyHash, ...safe } = p;

  return res.status(200).json({
    success: true,
    project: { pid, ...safe, myRole: access.role },
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
    await logProjectEvent(project.pid, user.uid, "project", "project.created", { name: project.name });
    const { apiKeyHash, ...safe } = project;
    return res.status(200).json({ success: true, pid: project.pid, project: safe });
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
    if (iconUrl !== null && (typeof iconUrl !== "string" || iconUrl.length > 500)) {
      return res.status(400).json({ success: false, error: "iconUrl must be a string ≤500 chars or null" });
    }
    patch.iconUrl = iconUrl;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: "No fields to update" });
  }

  patch.updatedAt = Date.now();
  await db.ref(`projects/${pid}`).update(patch);
  await logProjectEvent(pid, access.uid, "project", "project.updated", {
    fields: Object.keys(patch).filter(k => k !== "updatedAt"),
  });

  if (patch.name !== undefined || patch.description !== undefined || patch.iconUrl !== undefined) {
    await invalidateProjectOgImage(pid);
  }

  try {
    const audience = await getProjectAudience(pid);
    const others = audience.uids.filter(u => u !== access.uid);
    if (others.length) {
      const touched = Object.keys(patch).filter(k => ["name", "description", "iconUrl"].includes(k));
      if (touched.length) {
        let imageUrl = null;
        try {
          const t = await db.ref(`projects/${pid}/ogImage/url`).once("value").catch(() => null);
          if (t?.exists() && isValidOgUrl(t.val())) imageUrl = t.val();
        } catch {}
        await notifyMany("project", others, {
          title: "Project details updated",
          body: `Someone updated ${touched.join(", ")} on a project you collaborate on.`,
          imageUrl,
          link: `${BASE_URL}/project.html?pid=${pid}`,
          extra: { pid, fields: touched },
        });
      }
    }
  } catch {}

  const snap = await db.ref(`projects/${pid}`).once("value");
  const p = snap.exists() ? snap.val() : {};
  const { apiKeyHash, ...safe } = p;
  return res.status(200).json({ success: true, project: { pid, ...safe } });
}
async function handleRegeneratePreview(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectsUpdate", `pid_${pid}`))) return;

  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const projSnap = await db.ref(`projects/${pid}`).once("value");
  if (!projSnap.exists()) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }
  const project = projSnap.val();

  // Read files for language + thumbnail computation
  let files = null;
  try {
    const filesSnap = await db.ref(`files/${pid}`).once("value");
    files = {};
    if (filesSnap.exists()) {
      filesSnap.forEach(c => {
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
      success: true,
      languages,
      thumbnailUrl: thumbnailUrl || null,
      regeneratedAt: Date.now(),
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
    collaborators = audience.uids.filter(u => u !== access.uid);
    const nameSnap = await db.ref(`projects/${pid}/name`).once("value");
    projectName = nameSnap.exists() ? nameSnap.val() : "";
  } catch {}

  try {
    await deleteProjectRecord(pid, access.uid);
    if (collaborators.length) {
      let imageUrl = null;
      try {
        const t = await db.ref(`projects/${pid}/ogImage/url`).once("value").catch(() => null);
        if (t?.exists() && isValidOgUrl(t.val())) imageUrl = t.val();
      } catch {}
      await notifyMany("project", collaborators, {
        title: "Project deleted",
        body: `"${projectName || "A project you collaborated on"}" was deleted by its owner.`,
        imageUrl,
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

// =========================================================================
// DEPLOY (DB-only)
// =========================================================================

async function handleDeploy(req, res, reqId) {
  const { pid, files, versionId } = req.body || {};
  if (!pid || !files || typeof files !== "object") {
    return res.status(400).json({ success: false, error: "Missing pid or files" });
  }
  if (!(await enforceRate(req, res, "deploy", `pid_${pid}`))) return;

  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const projSnap = await db.ref(`projects/${pid}`).once("value");
  if (!projSnap.exists()) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }
  const project = projSnap.val();

  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
  let totalBytes = 0;
  let filesWritten = 0;
  const skipped = [];

  for (const [filePath, content] of Object.entries(files)) {
    if (typeof content !== "string") { skipped.push(filePath); continue; }
    if (content.length > MAX_FILE_BYTES) { skipped.push(filePath); continue; }
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      try { await notifyDeployFailed(access, pid, project.name, "payload exceeds size limit", 413); } catch {}
      if (project.ownerId && project.ownerId !== access.uid) {
        try { await notifyDeployFailed({ uid: project.ownerId }, pid, project.name, "payload exceeds size limit", 413); } catch {}
      }
      return res.status(413).json({
        success: false,
        error: "Project too large to deploy",
        limit: MAX_TOTAL_BYTES,
        hint: "Split into smaller projects or remove large assets.",
      });
    }
    try {
      await db.ref(`files/${pid}/${sanitizeFirebasePath(filePath.replace(/\//g, "__"))}`).set({
        path: filePath,
        content,
        updatedAt: Date.now(),
      });
      filesWritten++;
    } catch (err) {
      log("host.deploy.file_failed", { reqId, pid, filePath, message: err.message });
      skipped.push(filePath);
    }
  }

  if (filesWritten === 0) {
    try { await notifyDeployFailed(access, pid, project.name, "no valid files in payload", 400); } catch {}
    return res.status(400).json({ success: false, error: "No valid files to deploy" });
  }

  // ── Language compute ──
  try {
    await ensureProjectLanguages(pid, project, files);
  } catch (err) {
    log("host.deploy.languages_failed", { pid, message: err.message });
  }

  // ── Project thumbnail ──
  try {
    await ensureProjectThumbnail(pid, files);
  } catch (err) {
    log("host.deploy.thumbnail_failed", { pid, message: err.message });
  }

  // ── Invalidate OG ──
  await invalidateProjectOgImage(pid).catch(() => {});

  const publicUrl =
    `${BASE_URL}/api/host?action=serve&pid=${encodeURIComponent(pid)}&path=index.html`;

  const deploymentRecord = {
    url: publicUrl,
    versionId: versionId || null,
    deployedAt: Date.now(),
    deploymentId: `db_${pid}_${Date.now()}`,
    state: "READY",
    stateUrl: null,
    deployedBy: access.uid,
  };

  await db.ref(`projects/${pid}/deployment`).set(deploymentRecord);
  await db.ref(`projects/${pid}/deployments/${deploymentRecord.deploymentId}`).set(deploymentRecord);

  try {
    const histSnap = await db.ref(`projects/${pid}/deployments`).once("value");
    if (histSnap.exists()) {
      const entries = [];
      histSnap.forEach(child => {
        entries.push({ id: child.key, at: child.val()?.deployedAt || 0 });
      });
      if (entries.length > 30) {
        entries.sort((a, b) => a.at - b.at);
        const updates = {};
        entries.slice(0, entries.length - 30).forEach(e => { updates[e.id] = null; });
        await db.ref(`projects/${pid}/deployments`).update(updates);
      }
    }
  } catch {}

  await db.ref(`projects/${pid}/updatedAt`).set(Date.now());

  await logProjectEvent(pid, access.uid, "deploy", "project.deployed", {
    url: publicUrl,
    versionId: versionId || null,
    filesWritten,
    filesSkipped: skipped.length,
  });

  // ── Deployment thumbnail ──
  try {
    await ensureDeploymentThumbnail(pid, deploymentRecord.deploymentId, files);
  } catch (err) {
    log("host.deploy.deployment_thumb_failed", {
      pid,
      deploymentId: deploymentRecord.deploymentId,
      message: err.message,
    });
  }

  try {
    const audience = await getProjectAudience(pid);
    const others = audience.uids.filter(u => u !== access.uid);
    if (others.length) {
      const thumb = await db.ref(`projects/${pid}/thumbnail/url`).once("value").catch(() => null);
      const imageUrl = thumb?.exists() && isValidOgUrl(thumb.val()) ? thumb.val() : null;
      await notifyMany("project", others, {
        title: "Deployment complete",
        body: `Project "${project.name}" is live.`,
        imageUrl,
        link: `${BASE_URL}/project.html?pid=${pid}`,
        extra: { pid, deploymentId: deploymentRecord.deploymentId },
      });
    }
  } catch {}

  return res.status(202).json({
    success: true,
    deploymentId: deploymentRecord.deploymentId,
    stateUrl: null,
    url: publicUrl,
    filesWritten,
    filesSkipped: skipped.length,
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
  if (!versionSnap.exists()) {
    return res.status(404).json({ success: false, error: "Version not found" });
  }
  const version = versionSnap.val();
  const files = version.files;
  if (!files || typeof files !== "object") {
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

  const snap = await db.ref(`projects/${pid}/deployments`).once("value");
  const deployments = [];
  if (snap.exists()) {
    snap.forEach(child => {
      deployments.push({ id: child.key, ...child.val() });
    });
  }
  deployments.sort((a, b) => (b.deployedAt || 0) - (a.deployedAt || 0));

  const slice = deployments.slice(offset, offset + limit);

  await Promise.all(slice.map(async d => {
    try {
      const t = await db.ref(`projects/${pid}/deployments/${d.id}/thumbnail/url`).once("value");
      if (t?.exists() && isValidOgUrl(t.val())) {
        d.thumbnailUrl = t.val();
      }
    } catch {}
  }));

  const currentSnap = await db.ref(`projects/${pid}/deployment/deploymentId`).once("value");
  const currentId = currentSnap.exists() ? currentSnap.val() : null;

  return res.status(200).json({
    success: true,
    deployments: slice,
    total: deployments.length,
    hasMore: offset + limit < deployments.length,
    currentDeploymentId: currentId,
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

  await logProjectEvent(pid, access.uid, "deploy", "deployment.offline", {});

  try {
    const audience = await getProjectAudience(pid);
    const others = audience.uids.filter(u => u !== access.uid);
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
        link: `${BASE_URL}/project.html?pid=${pid}`,
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

  const currentSnap = await db.ref(`projects/${pid}/deployment/deploymentId`).once("value");
  const isCurrent = currentSnap.exists() && currentSnap.val() === deploymentId;

  await db.ref(`projects/${pid}/deployments/${deploymentId}`).remove();
  if (isCurrent) await db.ref(`projects/${pid}/deployment`).remove();

  await logProjectEvent(pid, access.uid, "deploy", "deployment.deleted", { deploymentId });

  try {
    const audience = await getProjectAudience(pid);
    const others = audience.uids.filter(u => u !== access.uid);
    if (others.length) {
      await notifyMany("project", others, {
        title: "Deployment removed",
        body: `A ${isCurrent ? "current " : ""}deployment record was deleted.`,
        link: `${BASE_URL}/project.html?pid=${pid}`,
        extra: { pid, deploymentId, isCurrent, kind: "deploy_deleted" },
      });
    }
  } catch {}

  return res.status(200).json({ success: true, vercelDeleted: false });
}

// =========================================================================
// SERVE (static files out of DB)
// =========================================================================

async function handleServe(req, res, reqId) {
  const sendText = (status, body) => {
    res.status(status).setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(body);
  };

  let pid = String(req.query?.pid || "").trim();
  if (!pid && req.query.username && req.query.project) {
    const found = await findProjectBySlug(
      String(req.query.username).toLowerCase(),
      String(req.query.project),
    );
    if (!found) return sendText(404, "Not found");
    pid = found.pid;
  }
  if (!pid) return sendText(400, "Missing pid");

  if (!(await enforceRate(req, res, "serve", ipKey(req)))) return;

  const projSnap = await db.ref(`projects/${pid}`).once("value");
  if (!projSnap.exists()) return sendText(404, "Not found");
  const project = projSnap.val();

  if (project.deployment?.state === "OFFLINE") {
    return sendText(410, "This project is offline");
  }

  if (!project.languages?.breakdown || Object.keys(project.languages.breakdown).length === 0) {
    try {
      project.languages = await ensureProjectLanguages(pid, project, null);
    } catch (err) {
      log("host.serve.languages_failed", { pid, message: err.message });
    }
  }

  const isPublic =
    project.visibility?.profile === "public" ||
    project.visibility?.liveSite === "public";

  if (!isPublic) {
    const access = await canAccessProjectFromReq(req);
    if (!access) return sendText(403, "Project is not public");
  }

  let wantPath = String(req.query?.path || "").replace(/^\/+/, "");
  if (!wantPath) {
    if (project.primaryFile) wantPath = project.primaryFile;
    else {
      const filesSnap = await db.ref(`files/${pid}`).once("value");
      if (filesSnap.exists()) {
        filesSnap.forEach(child => {
          const p = child.val()?.path || "";
          if (!wantPath && /\.html?$/i.test(p)) wantPath = p;
        });
      }
    }
    if (!wantPath) return sendText(404, "No HTML file");
  }

  const safeKey = sanitizeFirebasePath(wantPath.replace(/\//g, "__"));
  const fileSnap = await db.ref(`files/${pid}/${safeKey}`).once("value");
  if (!fileSnap.exists()) {
    return sendText(404, `Not found: ${wantPath}`);
  }
  const file = fileSnap.val() || {};
  const content = String(file.content ?? "");

  const MAX_BYTES = 4 * 1024 * 1024;
  if (content.length > MAX_BYTES) {
    return sendText(413, "File too large to serve");
  }

  res.setHeader("Content-Type", mimeFor(wantPath));
  res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");

  if (/\.html?$/i.test(wantPath)) {
    let html = content;
    const meta = await resolveProjectMeta(pid, project);
    html = injectHead(html, meta, pid);
    html = injectTracker(html, pid);
    html = rewriteRelativeUrls(html, pid, wantPath);
    return res.status(200).send(html);
  }

  if (/\.css$/i.test(wantPath)) {
    return res.status(200).send(rewriteCssUrls(content, pid, wantPath));
  }

  return res.status(200).send(content);
}

// =========================================================================
// VERSIONS CLEAR / CACHE CLEAR
// =========================================================================

async function handleVersionsClear(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "versionsClear", `pid_${pid}`))) return;

  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  const snap = await db.ref(`versions/${pid}`).once("value");
  let cleared = 0;
  if (snap.exists()) {
    const updates = {};
    snap.forEach(child => { updates[child.key] = null; cleared++; });
    if (cleared > 0) await db.ref(`versions/${pid}`).update(updates);
  }

  await logProjectEvent(pid, access.uid, "version", "versions.cleared", { count: cleared });
  return res.status(200).json({ success: true, cleared });
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
// PROJECT EXPORT (folio/zip)
// =========================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1F) << 11)
    | ((date.getMinutes() & 0x3F) << 5)
    | ((Math.floor(date.getSeconds() / 2)) & 0x1F);
  const dt = (((date.getFullYear() - 1980) & 0x7F) << 9)
    | (((date.getMonth() + 1) & 0x0F) << 5)
    | (date.getDate() & 0x1F);
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

    localHeaders.push(localHeader);
    localHeaders.push(data);

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

  const projectSnap = await db.ref(`projects/${pid}`).once("value");
  if (!projectSnap.exists()) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }
  const project = projectSnap.val();
  const { apiKeyHash, roles, ...safeProject } = project;

  let filesObj = {};
  if (versionId) {
    const vSnap = await db.ref(`versions/${pid}/${versionId}`).once("value");
    if (!vSnap.exists()) {
      return res.status(404).json({ success: false, error: "Version not found" });
    }
    filesObj = vSnap.val().files || {};
  } else {
    const filesSnap = await db.ref(`files/${pid}`).once("value");
    if (filesSnap.exists()) {
      filesSnap.forEach(child => {
        filesObj[child.key] = child.val()?.content || "";
      });
    }
  }

  if (publicOnly) {
    const publicFiles = project.publicFiles || {};
    const filtered = {};
    for (const [path, content] of Object.entries(filesObj)) {
      const safePath = sanitizeFirebasePath(path.replace(/\//g, "__"));
      if (publicFiles[safePath]) filtered[path] = content;
    }
    filesObj = filtered;
  }

  let versionsObj = {};
  if (format === "folio" && !publicOnly) {
    const vSnap = await db.ref(`versions/${pid}`).once("value");
    if (vSnap.exists()) {
      vSnap.forEach(child => { versionsObj[child.key] = child.val(); });
    }
  }

  let jsonDb = null;
  let jsonDbSchema = null;
  if (format === "folio" && !publicOnly) {
    const dbSnap = await db.ref(`projectData/${pid}`).once("value");
    const schemaSnap = await db.ref(`projectSchemas/${pid}`).once("value");
    jsonDb = dbSnap.exists() ? dbSnap.val() : null;
    jsonDbSchema = schemaSnap.exists() ? schemaSnap.val() : null;
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
    const safeName = `files/${filePath}`;
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(String(content));
    entries.push({ name: safeName, data: buf });
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
  const filename = `${(safeProject.slug || "project")}-${pid.slice(-6)}.${format === "folio" ? "folio" : "zip"}`;

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Project-Pid", pid);
  res.setHeader("X-Project-Format", format);
  res.setHeader("X-Project-Files", String(Object.keys(filesObj).length));

  await logProjectEvent(pid, access.uid, "project", "project.exported", {
    format,
    fileCount: Object.keys(filesObj).length,
    publicOnly,
  });

  try {
    if (publicOnly && access.uid && project.ownerId && project.ownerId !== access.uid) {
      const exporter = await getUser(access.uid);
      const who = exporter?.profile?.username ? `@${exporter.profile.username}` : "a user";
      if (await shouldNotifyOnce(project.ownerId, `export_${pid}_${access.uid}`, 24 * 60 * 60 * 1000)) {
        let imageUrl = null;
        try {
          const t = await db.ref(`projects/${pid}/ogImage/url`).once("value").catch(() => null);
          if (t?.exists() && isValidOgUrl(t.val())) imageUrl = t.val();
        } catch {}
        await callNotify("project", project.ownerId, {
          title: "Someone downloaded your project",
          body: `${who} exported a copy of "${safeProject.name || "your project"}".`,
          imageUrl,
          link: `${BASE_URL}/project.html?pid=${pid}`,
          extra: { pid, exporterUid: access.uid, format },
        });
      }
    }
  } catch {}

  return res.status(200).send(zipBuffer);
}

// =========================================================================
// PROJECT SYNC-BACK
// =========================================================================

async function handleProjectSyncBack(req, res, reqId) {
  const { pid, files, versions, db: jsonDb, schema: jsonSchema, manifest } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectSyncBack", `pid_${pid}`))) return;

  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const projSnap = await db.ref(`projects/${pid}`).once("value");
  if (!projSnap.exists()) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }
  const project = projSnap.val();

  const result = {
    filesWritten: 0,
    filesSkipped: 0,
    versionsWritten: 0,
    dbWritten: false,
    schemaWritten: false,
  };

  if (files && typeof files === "object") {
    for (const [filePath, content] of Object.entries(files)) {
      if (typeof content !== "string") { result.filesSkipped++; continue; }
      try {
        await db.ref(`files/${pid}/${sanitizeFirebasePath(filePath.replace(/\//g, "__"))}`).set({
          path: filePath,
          content,
          updatedAt: Date.now(),
        });
        result.filesWritten++;
      } catch (err) {
        log("host.sync_back.file_failed", { pid, path: filePath, message: err.message });
        result.filesSkipped++;
      }
    }
  }

  if (versions && typeof versions === "object") {
    for (const [vid, v] of Object.entries(versions)) {
      try {
        const exists = await db.ref(`versions/${pid}/${vid}`).once("value");
        if (exists.exists()) continue;
        await db.ref(`versions/${pid}/${vid}`).set(v);
        result.versionsWritten++;
      } catch {}
    }
  }

  if (jsonDb !== undefined && jsonDb !== null) {
    try {
      await db.ref(`projectData/${pid}`).set(jsonDb);
      result.dbWritten = true;
    } catch {}
  }

  if (jsonSchema !== undefined && jsonSchema !== null) {
    try {
      await db.ref(`projectSchemas/${pid}`).set(jsonSchema);
      result.schemaWritten = true;
    } catch {}
  }

  await db.ref(`projects/${pid}/updatedAt`).set(Date.now());

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

  try {
    if (result.filesWritten > 0 || result.dbWritten || result.schemaWritten) {
      const audience = await getProjectAudience(pid);
      const others = audience.uids.filter(u => u !== access.uid);
      if (others.length) {
        const thumb = await db.ref(`projects/${pid}/thumbnail/url`).once("value").catch(() => null);
        const imageUrl = thumb?.exists() && isValidOgUrl(thumb.val()) ? thumb.val() : null;
        await notifyMany("project", others, {
          title: "Project updated from sync",
          body: `${result.filesWritten} file(s) synced back${result.dbWritten ? ", DB imported" : ""}.`,
          imageUrl,
          link: `${BASE_URL}/project.html?pid=${pid}`,
          extra: { pid, ...result },
        });
      }
    }
  } catch {}

  return res.status(200).json({ success: true, ...result });
}

// =========================================================================
// FILE LIST + FILE GET
// =========================================================================

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

  if (!role && !isCodePublic) {
    return res.status(403).json({ success: false, error: "Access denied" });
  }

  const projectSnap = await db.ref(`projects/${pid}`).once("value");
  if (!projectSnap.exists()) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }
  const project = projectSnap.val();

  const publicFiles = project.publicFiles || {};
  const hasPublicFilesList = Object.keys(publicFiles).length > 0;
  const enforceFileList = !role && hasPublicFilesList;

  const filesSnap = await db.ref(`files/${pid}`).once("value");
  const files = [];
  if (filesSnap.exists()) {
    filesSnap.forEach(child => {
      const v = child.val() || {};
      const path = v.path || child.key.replace(/__/g, "/");
      if (enforceFileList) {
        const safePath = sanitizeFirebasePath(path.replace(/\//g, "__"));
        if (!publicFiles[safePath]) return;
      }
      files.push({
        path,
        size: (v.content || "").length,
        updatedAt: v.updatedAt || null,
      });
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  let thumbnailUrl = null;
  try {
    const thumbSnap = await db.ref(`projects/${pid}/thumbnail/url`).once("value").catch(() => null);
    if (thumbSnap?.exists() && isValidOgUrl(thumbSnap.val())) {
      thumbnailUrl = thumbSnap.val();
    }
  } catch {}

  return res.status(200).json({
    success: true,
    files,
    total: files.length,
    isCodePublic,
    isEditor: role === "owner" || role === "editor",
    thumbnailUrl,
  });
}

async function handleFileGet(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  const filePath = String(req.query?.path || "").trim();
  if (!pid || !filePath) {
    return res.status(400).json({ success: false, error: "Missing pid or path" });
  }
  if (!(await enforceRate(req, res, "fileGet", `pid_${pid}`))) return;

  let role = null;
  const signedIn = await canAccessProjectFromReq(req);
  if (signedIn) role = signedIn.role;

  let isCodePublic = false;
  try {
    const visSnap = await db.ref(`projects/${pid}/visibility/code`).once("value");
    isCodePublic = visSnap.exists() && visSnap.val() === "public";
  } catch {}

  if (!role && !isCodePublic) {
    return res.status(403).json({ success: false, error: "Access denied" });
  }

  if (!role) {
    const publicSnap = await db.ref(`projects/${pid}/publicFiles`).once("value");
    const publicFiles = publicSnap.exists() ? publicSnap.val() : {};
    if (Object.keys(publicFiles).length > 0) {
      const safePath = sanitizeFirebasePath(filePath.replace(/\//g, "__"));
      if (!publicFiles[safePath]) {
        return res.status(403).json({ success: false, error: "File not public" });
      }
    }
  }

  const safePath = sanitizeFirebasePath(filePath.replace(/\//g, "__"));
  const snap = await db.ref(`files/${pid}/${safePath}`).once("value");
  if (!snap.exists()) {
    return res.status(404).json({ success: false, error: "File not found" });
  }
  const file = snap.val() || {};

  const MAX_RETURN = 2 * 1024 * 1024;
  const raw = String(file.content || "");
  const truncated = raw.length > MAX_RETURN;
  const content = truncated ? raw.slice(0, MAX_RETURN) : raw;

  return res.status(200).json({
    success: true,
    path: file.path || filePath,
    content,
    truncated,
    bytes: raw.length,
    updatedAt: file.updatedAt || null,
  });
}

// =========================================================================
// PROJECT COPY (fork)
// =========================================================================

async function handleProjectCopy(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const { pid: sourcePid, newName } = req.body || {};
  if (!sourcePid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectCopy", `uid_${user.uid}`))) return;

  const sourceSnap = await db.ref(`projects/${sourcePid}`).once("value");
  if (!sourceSnap.exists()) {
    return res.status(404).json({ success: false, error: "Source project not found" });
  }
  const source = sourceSnap.val();

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
  } catch (err) {
    log("host.project_copy.create_failed", { reqId, uid: user.uid, message: err.message });
    return res.status(500).json({ success: false, error: "Could not create project" });
  }

  const filesSnap = await db.ref(`files/${sourcePid}`).once("value");
  let copiedFiles = 0;
  if (filesSnap.exists()) {
    const publicFiles = source.publicFiles || {};
    for (const child of Object.values(filesSnap.toJSON ? filesSnap.toJSON() : {})) {
      const path = child.path;
      const content = child.content || "";
      if (!canFullCopy) {
        const safePath = sanitizeFirebasePath(path.replace(/\//g, "__"));
        if (!publicFiles[safePath]) continue;
      }
      try {
        await db.ref(`files/${newProject.pid}/${sanitizeFirebasePath(path.replace(/\//g, "__"))}`).set({
          path,
          content,
          updatedAt: Date.now(),
        });
        copiedFiles++;
      } catch {}
    }
  }

  if (canFullCopy) {
    try {
      const dbSnap = await db.ref(`projectData/${sourcePid}`).once("value");
      if (dbSnap.exists()) await db.ref(`projectData/${newProject.pid}`).set(dbSnap.val());
      const schemaSnap = await db.ref(`projectSchemas/${sourcePid}`).once("value");
      if (schemaSnap.exists()) await db.ref(`projectSchemas/${newProject.pid}`).set(schemaSnap.val());
    } catch {}
  }

  await db.ref(`projects/${newProject.pid}`).update({
    forkedFrom: sourcePid,
    forkedAt: Date.now(),
    forkedBy: user.uid,
  });

  await logProjectEvent(newProject.pid, user.uid, "project", "project.copied", {
    sourcePid,
    copiedFiles,
    fullCopy: canFullCopy,
  });

  try {
    if (source.ownerId && source.ownerId !== user.uid) {
      if (await shouldNotifyOnce(source.ownerId, `fork_${sourcePid}_${user.uid}`, 24 * 60 * 60 * 1000)) {
        const forker = await getUser(user.uid);
        const who = forker?.profile?.username ? `@${forker.profile.username}` : "someone";
        let imageUrl = null;
        try {
          const t = await db.ref(`projects/${sourcePid}/ogImage/url`).once("value").catch(() => null);
          if (t?.exists() && isValidOgUrl(t.val())) imageUrl = t.val();
        } catch {}
        await callNotify("project", source.ownerId, {
          title: "Someone copied your project",
          body: `${who} saved a copy of "${source.name || "your project"}".`,
          imageUrl,
          link: `${BASE_URL}/${forker?.profile?.username || ""}/${newProject.slug || ""}`,
          extra: { sourcePid, newPid: newProject.pid, forkerUid: user.uid },
        });
      }
    }
  } catch {}

  const { apiKeyHash, ...safeNew } = newProject;
  return res.status(200).json({
    success: true,
    pid: newProject.pid,
    project: safeNew,
    copiedFiles,
    fullCopy: canFullCopy,
  });
}

// =========================================================================
// PROJECT JSON DATABASE
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
      retryAfter: rl.retryAfter,
      reset: rl.reset,
      rateLimit: { limit: rl.limit, remaining: rl.remaining, reset: rl.reset },
    });
  }
  const rateLimitMeta = { limit: rl.limit, remaining: rl.remaining, reset: rl.reset };

  const access = await checkProjectKeyOrRole(req, res, pid, "editor");
  if (!access) return;

  const LIMIT = 15 * 1024 * 1024;
  const dbRef = db.ref(`projectData/${pid}`);
  const today = dayString();
  const uidForLog = access.uid === "api" ? null : access.uid;

  if (key !== undefined) {
    if (data !== undefined) {
      return res.status(400).json({
        success: false,
        error: "Send either `key` or `data`, not both",
        rateLimit: rateLimitMeta,
      });
    }

    const parts = String(key).split("/").filter(Boolean);
    if (parts.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid key path",
        rateLimit: rateLimitMeta,
      });
    }

    const safeParts = [];
    for (const seg of parts) {
      const safe = sanitizeFirebasePath(seg);
      if (!safe) {
        return res.status(400).json({
          success: false,
          error: `Invalid path segment: "${seg}"`,
          rateLimit: rateLimitMeta,
        });
      }
      safeParts.push(safe);
    }

    let nested = value === undefined ? null : value;
    for (let i = safeParts.length - 1; i >= 0; i--) {
      nested = { [safeParts[i]]: nested };
    }

    const serialized = JSON.stringify(value === undefined ? null : value);
    if (serialized.length > LIMIT) {
      return res.status(413).json({
        success: false,
        error: "Payload too large (15 MB max)",
        size: serialized.length,
        limit: LIMIT,
        rateLimit: rateLimitMeta,
      });
    }

    try {
      await dbRef.update(nested);
    } catch (err) {
      log("host.dbSet.path_write_failed", { reqId, pid, key, message: err.message });
      return res.status(500).json({
        success: false,
        error: "Write failed",
        rateLimit: rateLimitMeta,
      });
    }

    let finalSize = 0;
    try {
      const sizeSnap = await dbRef.once("value");
      finalSize = JSON.stringify(sizeSnap.val() || {}).length;
    } catch {}

    if (finalSize > LIMIT) {
      try {
        const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
        if (ownerSnap.exists()) {
          await notifyStorageWarning(pid, ownerSnap.val(), finalSize, LIMIT, 100, "full");
        }
      } catch {}
      return res.status(413).json({
        success: false,
        error: "Database exceeds 15 MB limit after write",
        size: finalSize,
        limit: LIMIT,
        space: { used: finalSize, remaining: 0, limit: LIMIT, percentUsed: 100 },
        rateLimit: rateLimitMeta,
      });
    }

    const spaceRemaining = Math.max(0, LIMIT - finalSize);
    const percentUsed = Math.min(100, Math.round((finalSize / LIMIT) * 1000) / 10);

    await db.ref(`analytics/${pid}/db/${today}`).transaction(cur => {
      const c = cur || { reads: 0, writes: 0, bytesIn: 0, bytesOut: 0 };
      c.writes = (c.writes || 0) + 1;
      c.bytesIn = (c.bytesIn || 0) + serialized.length;
      return c;
    }).catch(() => {});

    let totalWrites = 0;
    let todayWrites = 0;
    try {
      const a = await db.ref(`analytics/${pid}/db`).once("value");
      if (a.exists()) {
        a.forEach(d => {
          const v = d.val() || {};
          const w = typeof v.writes === "number" ? v.writes : 0;
          totalWrites += w;
          if (d.key === today) todayWrites = w;
        });
      }
    } catch {}

    await logProjectEvent(pid, uidForLog, "db", "db.written", {
      key,
      mode: "path",
      bytes: serialized.length,
      viaApiKey: access.uid === "api",
    });

    try {
      if (finalSize > LIMIT * 0.8) {
        const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
        if (ownerSnap.exists()) {
          await notifyStorageWarning(pid, ownerSnap.val(), finalSize, LIMIT, percentUsed, "nearly_full");
        }
      }
    } catch {}

    return res.status(200).json({
      success: true,
      mode: "path",
      key,
      space: { used: finalSize, remaining: spaceRemaining, limit: LIMIT, percentUsed },
      rateLimit: rateLimitMeta,
      calls: { total: totalWrites, today: todayWrites },
    });
  }

  if (data !== undefined && mode === "merge") {
    const serialized = JSON.stringify(data ?? null);
    if (serialized.length > LIMIT) {
      return res.status(413).json({
        success: false,
        error: "Payload too large (15 MB max)",
        size: serialized.length,
        limit: LIMIT,
        rateLimit: rateLimitMeta,
      });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return res.status(400).json({
        success: false,
        error: "Merge data must be a plain object",
        rateLimit: rateLimitMeta,
      });
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({
        success: false,
        error: "Nothing to merge",
        rateLimit: rateLimitMeta,
      });
    }

    try {
      await dbRef.update(data);
    } catch (err) {
      log("host.dbSet.merge_failed", { reqId, pid, message: err.message });
      return res.status(500).json({
        success: false,
        error: "Write failed",
        rateLimit: rateLimitMeta,
      });
    }

    let finalSize = 0;
    try {
      const s = await dbRef.once("value");
      finalSize = JSON.stringify(s.val() || {}).length;
    } catch {}
    if (finalSize > LIMIT) {
      try {
        const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
        if (ownerSnap.exists()) {
          await notifyStorageWarning(pid, ownerSnap.val(), finalSize, LIMIT, 100, "full");
        }
      } catch {}
      return res.status(413).json({
        success: false,
        error: "Database exceeds 15 MB limit after write",
        size: finalSize,
        limit: LIMIT,
        space: { used: finalSize, remaining: 0, limit: LIMIT, percentUsed: 100 },
        rateLimit: rateLimitMeta,
      });
    }
    const spaceRemaining = Math.max(0, LIMIT - finalSize);
    const percentUsed = Math.min(100, Math.round((finalSize / LIMIT) * 1000) / 10);

    await db.ref(`analytics/${pid}/db/${today}`).transaction(cur => {
      const c = cur || { reads: 0, writes: 0, bytesIn: 0, bytesOut: 0 };
      c.writes = (c.writes || 0) + 1;
      c.bytesIn = (c.bytesIn || 0) + serialized.length;
      return c;
    }).catch(() => {});

    let totalWrites = 0;
    let todayWrites = 0;
    try {
      const a = await db.ref(`analytics/${pid}/db`).once("value");
      if (a.exists()) {
        a.forEach(d => {
          const v = d.val() || {};
          const w = typeof v.writes === "number" ? v.writes : 0;
          totalWrites += w;
          if (d.key === today) todayWrites = w;
        });
      }
    } catch {}

    await logProjectEvent(pid, uidForLog, "db", "db.written", {
      key: null,
      mode: "merge",
      keys: Object.keys(data),
      bytes: serialized.length,
      viaApiKey: access.uid === "api",
    });

    try {
      if (finalSize > LIMIT * 0.8) {
        const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
        if (ownerSnap.exists()) {
          await notifyStorageWarning(pid, ownerSnap.val(), finalSize, LIMIT, percentUsed, "nearly_full");
        }
      }
    } catch {}

    return res.status(200).json({
      success: true,
      mode: "merge",
      keys: Object.keys(data),
      space: { used: finalSize, remaining: spaceRemaining, limit: LIMIT, percentUsed },
      rateLimit: rateLimitMeta,
      calls: { total: totalWrites, today: todayWrites },
    });
  }

  if (data !== undefined) {
    const serialized = JSON.stringify(data ?? null);
    if (serialized.length > LIMIT) {
      return res.status(413).json({
        success: false,
        error: "Payload too large (15 MB max)",
        size: serialized.length,
        limit: LIMIT,
        rateLimit: rateLimitMeta,
      });
    }

    try {
      await dbRef.set(data);
    } catch (err) {
      log("host.dbSet.replace_failed", { reqId, pid, message: err.message });
      return res.status(500).json({
        success: false,
        error: "Write failed",
        rateLimit: rateLimitMeta,
      });
    }

    let finalSize = 0;
    try {
      const s = await dbRef.once("value");
      finalSize = JSON.stringify(s.val() || {}).length;
    } catch {}
    const spaceRemaining = Math.max(0, LIMIT - finalSize);
    const percentUsed = LIMIT > 0
      ? Math.min(100, Math.round((finalSize / LIMIT) * 1000) / 10)
      : 0;

    await db.ref(`analytics/${pid}/db/${today}`).transaction(cur => {
      const c = cur || { reads: 0, writes: 0, bytesIn: 0, bytesOut: 0 };
      c.writes = (c.writes || 0) + 1;
      c.bytesIn = (c.bytesIn || 0) + serialized.length;
      return c;
    }).catch(() => {});

    let totalWrites = 0;
    let todayWrites = 0;
    try {
      const a = await db.ref(`analytics/${pid}/db`).once("value");
      if (a.exists()) {
        a.forEach(d => {
          const v = d.val() || {};
          const w = typeof v.writes === "number" ? v.writes : 0;
          totalWrites += w;
          if (d.key === today) todayWrites = w;
        });
      }
    } catch {}

    await logProjectEvent(pid, uidForLog, "db", "db.written", {
      key: null,
      mode: "replace",
      bytes: serialized.length,
      viaApiKey: access.uid === "api",
    });

    try {
      if (finalSize > LIMIT * 0.8) {
        const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
        if (ownerSnap.exists()) {
          await notifyStorageWarning(pid, ownerSnap.val(), finalSize, LIMIT, percentUsed, "nearly_full");
        }
      }
    } catch {}

    return res.status(200).json({
      success: true,
      mode: "replace",
      space: { used: finalSize, remaining: spaceRemaining, limit: LIMIT, percentUsed },
      rateLimit: rateLimitMeta,
      calls: { total: totalWrites, today: todayWrites },
    });
  }

  return res.status(400).json({
    success: false,
    error: "Missing key or data",
    rateLimit: rateLimitMeta,
  });
}

async function handleDbGet(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "dbGet", `pid_${pid}`))) return;

  const key = req.headers["x-project-key"];
  let authorized = false;
  let uidForLog = null;

  if (key) {
    authorized = await verifyProjectKey(pid, key);
    if (authorized) uidForLog = null;
  }
  if (!authorized) {
    const access = await canAccessProjectFromReq(req);
    if (access) { authorized = true; uidForLog = access.uid; }
  }
  if (!authorized) {
    authorized = await hasVisibility(pid, "db");
  }
  if (!authorized) {
    return res.status(403).json({ success: false, error: "Access denied" });
  }

  const dataSnap = await db.ref(`projectData/${pid}`).once("value");
  const schemaSnap = await db.ref(`projectSchemas/${pid}`).once("value");
  const data = dataSnap.exists() ? dataSnap.val() : {};
  const schema = schemaSnap.exists() ? schemaSnap.val() : null;

  const today = dayString();
  const serialized = JSON.stringify(data || {});
  const bytesOut = serialized.length;

  await db.ref(`analytics/${pid}/db/${today}`).transaction(cur => {
    const c = cur || { reads: 0, writes: 0, bytesIn: 0, bytesOut: 0 };
    c.reads = (c.reads || 0) + 1;
    c.bytesOut = (c.bytesOut || 0) + bytesOut;
    return c;
  }).catch(() => {});

  let totalWrites = 0;
  let todayWrites = 0;
  let totalReads = 0;
  try {
    const a = await db.ref(`analytics/${pid}/db`).once("value");
    if (a.exists()) {
      a.forEach(d => {
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

  const cfg = RATE_LIMITS.dbSet;
  let rateLimit = { limit: cfg.max, remaining: cfg.max, reset: null };
  try {
    const rlKey = sanitizeFirebasePath(String(`pid_${pid}`).toLowerCase());
    const rlSnap = await db.ref(`rate_limit/${API_NAME}/dbSet/${rlKey}`).once("value");
    if (rlSnap.exists()) {
      const d = rlSnap.val();
      const now = Date.now();
      const resetAt = (d.first_request || now) + cfg.window;
      if (now > resetAt) {
        rateLimit = { limit: cfg.max, remaining: cfg.max, reset: null };
      } else {
        const usedCount = d.count || 0;
        rateLimit = {
          limit: cfg.max,
          remaining: Math.max(0, cfg.max - usedCount),
          reset: new Date(resetAt).toISOString(),
        };
      }
    }
  } catch {}

  return res.status(200).json({
    success: true,
    data,
    schema,
    calls: { total: totalWrites, today: todayWrites, reads: totalReads },
    rateLimit,
    space,
  });
}

async function canAccessProjectFromReq(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const { verifySession } = await import("../utils/users.js");
  const decoded = verifySession(header.slice(7).trim());
  if (!decoded) return null;
  const role = await canAccessProject(decoded.uid, req.query?.pid || "");
  return role ? { uid: decoded.uid, role } : null;
}

async function handleDbSchema(req, res, reqId) {
  const { pid, schema } = req.body || {};
  if (!pid || typeof schema !== "object" || schema === null) {
    return res.status(400).json({ success: false, error: "Missing pid or schema" });
  }
  if (!(await enforceRate(req, res, "dbSchema", `pid_${pid}`))) return;

  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const fields = Array.isArray(schema.fields) ? schema.fields : [];
  if (fields.length > 100) {
    return res.status(400).json({ success: false, error: "Too many schema fields (max 100)" });
  }

  await db.ref(`projectSchemas/${pid}`).set({
    fields,
    layout: schema.layout || null,
    updatedAt: Date.now(),
  });
  await logProjectEvent(pid, access.uid, "db", "schema.updated", {
    fieldCount: fields.length,
  });

  return res.status(200).json({ success: true });
}

// =========================================================================
// API KEYS
// =========================================================================

async function handleApiKeyGenerate(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "apikeyGenerate", `uid_${req.user?.uid || "anon"}`))) return;

  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  const { key, hash } = generateApiKey();
  await db.ref(`projects/${pid}`).update({
    apiKeyHash: hash,
    apiKeyCreatedAt: Date.now(),
  });
  await logProjectEvent(pid, access.uid, "project", "apikey.generated", {});

  try {
    const audience = await getProjectAudience(pid);
    const nameSnap = await db.ref(`projects/${pid}/name`).once("value");
    const pname = nameSnap.exists() ? nameSnap.val() : "your project";
    let imageUrl = null;
    try {
      imageUrl = await notificationImageUrl({
        title: "New API key",
        subtitle: `for "${pname}"`,
        template: "hero-short",
        scene: "halftone",
        palette: "mono",
      });
    } catch (err) {
      log("host.apikey_generate.image_error", { message: err.message });
    }
    await notifyMany("project", audience.uids, {
      title: "New API key generated",
      body: `A new API key was created for "${pname}". If this wasn't you, revoke it now.`,
      imageUrl,
      link: `${BASE_URL}/project.html?pid=${pid}`,
      extra: { pid, security: true },
    });
  } catch {}

  return res.status(200).json({ success: true, key });
}

// =========================================================================
// VISIBILITY
// =========================================================================

const VISIBILITY_AXES = ["profile", "liveSite", "code", "languages", "db"];

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
    if (visibility[axis] !== "public" && visibility[axis] !== "private") {
      return res.status(400).json({ success: false, error: `visibility.${axis} must be "public" or "private"` });
    }
    patch[`visibility/${axis}`] = visibility[axis];
    changes[axis] = visibility[axis];
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: "No visibility axes to update" });
  }
  patch.updatedAt = Date.now();
  await db.ref(`projects/${pid}`).update(patch);
  await logProjectEvent(pid, access.uid, "project", "visibility.updated", { changes });

  try {
    const significant = ["profile", "liveSite"].filter(a => changes[a]);
    if (significant.length) {
      const audience = await getProjectAudience(pid);
      const others = audience.uids.filter(u => u !== access.uid);
      if (others.length) {
        const wentPublic = significant.some(a => changes[a] === "public");
        let imageUrl = null;
        try {
          const t = await db.ref(`projects/${pid}/ogImage/url`).once("value").catch(() => null);
          if (t?.exists() && isValidOgUrl(t.val())) imageUrl = t.val();
        } catch {}
        await notifyMany("project", others, {
          title: wentPublic ? "Project went public" : "Project made private",
          body: `${significant.join(", ")} visibility changed.`,
          imageUrl,
          link: `${BASE_URL}/project.html?pid=${pid}`,
          extra: { pid, changes },
        });
      }
    }
  } catch {}

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
  if (isPublic) {
    await db.ref(`projects/${pid}/publicFiles/${safePath}`).set(true);
  } else {
    await db.ref(`projects/${pid}/publicFiles/${safePath}`).remove();
  }
  await logProjectEvent(pid, access.uid, "file", "file.visibility", {
    path: filePath,
    isPublic,
  });

  return res.status(200).json({ success: true });
}

// =========================================================================
// INVITES
// =========================================================================

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
  if (!invited) {
    return res.status(404).json({ success: false, error: "User not found" });
  }
  if (invited.uid === access.uid) {
    return res.status(400).json({ success: false, error: "Cannot invite yourself" });
  }
  const existingRole = await canAccessProject(invited.uid, pid);
  if (existingRole) {
    return res.status(409).json({ success: false, error: `User already has role: ${existingRole}` });
  }

  const token = generateInviteToken();
  const now = Date.now();
  await db.ref(`invites/${token}`).set({
    pid,
    role,
    invitedBy: access.uid,
    invitedUid: invited.uid,
    expiresAt: now + INVITE_TTL_MS,
    used: false,
    usedAt: null,
    createdAt: now,
  });

  try {
    const nameSnap = await db.ref(`projects/${pid}/name`).once("value");
    const pname = nameSnap.exists() ? nameSnap.val() : "a project";

    let imageUrl = null;
    try {
      imageUrl = await notificationImageUrl({
        title: `Invited to "${pname}"`,
        subtitle: `Join as ${role}`,
        template: "hero-short",
        scene: "ribbon",
        palette: "warm",
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

  await logProjectEvent(pid, access.uid, "invite", "invite.sent", {
    invitedUid: invited.uid,
    role,
  });

  return res.status(200).json({
    success: true,
    token,
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
    snap.forEach(child => {
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
        expiresAt,
        expired,
        used: !!v.used,
        usedAt: v.usedAt || null,
      });
    });
  }

  const includeUsed = String(req.query?.includeUsed || "false") === "true";
  const filtered = invites.filter(i => (includeUsed || (!i.used && !i.expired)));
  filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return res.status(200).json({
    success: true,
    invites: filtered,
    total: filtered.length,
    pending: invites.filter(i => !i.used && !i.expired).length,
    expired: invites.filter(i => !i.used && i.expired).length,
    used: invites.filter(i => i.used).length,
  });
}

async function handleInviteAccept(req, res, reqId) {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: "Missing token" });
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "inviteAccept", `uid_${user.uid}`))) return;

  const snap = await db.ref(`invites/${token}`).once("value");
  if (!snap.exists()) return res.status(404).json({ success: false, error: "Invite not found" });
  const invite = snap.val();

  if (invite.used) return res.status(410).json({ success: false, error: "Invite already used" });
  if (invite.expiresAt && invite.expiresAt < Date.now()) {
    return res.status(410).json({ success: false, error: "Invite expired" });
  }
  if (invite.invitedUid !== user.uid) {
    return res.status(403).json({ success: false, error: "This invite is for someone else" });
  }

  await db.ref(`projects/${invite.pid}/roles/${user.uid}`).set(invite.role);
  await db.ref(`users/${user.uid}/projectIds/${invite.pid}`).set(true);
  await db.ref(`invites/${token}`).update({ used: true, usedAt: Date.now() });
  await logProjectEvent(invite.pid, user.uid, "invite", "invite.accepted", { role: invite.role });

  try {
    if (invite.invitedBy && invite.invitedBy !== user.uid) {
      const [nameSnap, acceptorUser] = await Promise.all([
        db.ref(`projects/${invite.pid}/name`).once("value"),
        getUser(user.uid),
      ]);
      const pname = nameSnap.exists() ? nameSnap.val() : "your project";
      const who = acceptorUser?.profile?.username ? `@${acceptorUser.profile.username}` : "Someone";
      let imageUrl = null;
      try {
        const t = await db.ref(`projects/${invite.pid}/thumbnail/url`).once("value").catch(() => null);
        if (t?.exists() && isValidOgUrl(t.val())) imageUrl = t.val();
      } catch {}
      await callNotify("invite", invite.invitedBy, {
        title: "Invitation accepted",
        body: `${who} joined "${pname}" as ${invite.role}.`,
        imageUrl,
        link: `${BASE_URL}/project.html?pid=${invite.pid}`,
        extra: { pid: invite.pid, uid: user.uid, role: invite.role },
      });
    }
  } catch {}

  return res.status(200).json({ success: true, pid: invite.pid, role: invite.role });
}

async function handleInviteCancel(req, res, reqId) {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: "Missing token" });

  const snap = await db.ref(`invites/${token}`).once("value");
  if (!snap.exists()) return res.status(404).json({ success: false, error: "Invite not found" });
  const invite = snap.val();

  if (!(await enforceRate(req, res, "inviteCancel", `pid_${invite.pid}`))) return;
  const access = await requireProjectRole(req, res, invite.pid, "owner");
  if (!access) return;

  await db.ref(`invites/${token}`).remove();
  await logProjectEvent(invite.pid, access.uid, "invite", "invite.cancelled", {});

  try {
    if (invite.invitedUid) {
      const nameSnap = await db.ref(`projects/${invite.pid}/name`).once("value");
      const pname = nameSnap.exists() ? nameSnap.val() : "a project";
      await callNotify("invite", invite.invitedUid, {
        title: "Invitation cancelled",
        body: `Your invitation to "${pname}" was cancelled.`,
        link: `${BASE_URL}/projects`,
        extra: { pid: invite.pid },
      });
    }
  } catch {}

  return res.status(200).json({ success: true });
}

async function handleCollaboratorRemove(req, res, reqId) {
  const { pid, uid: targetUid } = req.body || {};
  if (!pid || !targetUid) {
    return res.status(400).json({ success: false, error: "Missing pid or uid" });
  }
  if (!(await enforceRate(req, res, "collaboratorRemove", `pid_${pid}`))) return;

  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  await db.ref(`projects/${pid}/roles/${targetUid}`).remove();
  await db.ref(`users/${targetUid}/projectIds/${pid}`).remove();
  await logProjectEvent(pid, access.uid, "invite", "collaborator.removed", { targetUid });

  try {
    const nameSnap = await db.ref(`projects/${pid}/name`).once("value");
    const pname = nameSnap.exists() ? nameSnap.val() : "a project";
    await callNotify("project", targetUid, {
      title: "Removed from project",
      body: `You no longer have access to "${pname}".`,
      link: `${BASE_URL}/projects`,
      extra: { pid },
    });
  } catch {}

  return res.status(200).json({ success: true });
}

// =========================================================================
// METATAGS
// =========================================================================

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
  await logProjectEvent(pid, access.uid, "project", "metatags.updated", {});

  return res.status(200).json({ success: true });
}

// =========================================================================
// PUBLIC RENDERS
// =========================================================================

async function handleShare(req, res, reqId) {
  if (!(await enforceRate(req, res, "share", ipKey(req)))) return;

  const username = String(req.query?.username || "").trim().toLowerCase();
  const pidParam = String(req.query?.pid || "").trim();
  const slug = String(req.query?.project || "").trim();
  const fileParam = String(req.query?.file || "").trim();

  let found = null;
  if (pidParam) {
    const snap = await db.ref(`projects/${pidParam}`).once("value");
    if (snap.exists()) {
      const p = snap.val();
      const owner = await getUser(p.ownerId);
      if (owner) found = { pid: pidParam, project: p, owner };
    }
  } else if (username && slug) {
    const bySlug = await findProjectBySlug(username, slug);
    if (bySlug) {
      const owner = await getUserByUsername(username);
      if (owner) found = { ...bySlug, owner };
    }
  }

  if (!found) {
    return sendHtmlPage(res, {
      title: "Project not found",
      heading: "Project not found",
      message: "The link you followed may be broken, or the project may have been deleted.",
      status: 404,
      icon: "alert",
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

  let projectThumbnailUrl = null;
  try {
    const t = await db.ref(`projects/${pid}/thumbnail/url`).once("value").catch(() => null);
    if (t?.exists() && isValidOgUrl(t.val())) {
      projectThumbnailUrl = t.val();
    }
  } catch {}

  const isProfilePublic = project.visibility?.profile === "public";

  let viewerUid = null;
  let viewerUsername = null;
  let viewerIsOwner = false;
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const { verifySession } = await import("../utils/users.js");
      const decoded = verifySession(authHeader.slice(7).trim());
      if (decoded?.uid) {
        viewerUid = decoded.uid;
        const v = await getUser(decoded.uid);
        viewerUsername = v?.profile?.username || null;
        viewerIsOwner = (project.ownerId === decoded.uid) ||
          (project.roles && project.roles[decoded.uid] === "editor");
      }
    } catch {}
  }
  const isSignedIn = !!viewerUid;

  if (!isProfilePublic && !viewerIsOwner) {
    return sendHtmlPage(res, {
      title: "Private project",
      heading: "This project is private",
      message: "The owner hasn't published this project publicly. Sign in if it's yours.",
      signinUrl: isSignedIn ? null : `${BASE_URL}/register?next=${encodeURIComponent("/" + (owner.profile?.username || "") + "/" + (project.slug || ""))}`,
      status: 200,
      icon: "lock",
    });
  }

  const liveSitePublic = project.visibility?.liveSite === "public";
  const codePublic = project.visibility?.code === "public";
  const dbPublic = project.visibility?.db === "public";
  const languagesPublic = project.visibility?.languages !== "private";

  const liveUrl = liveSitePublic && project.deployment?.url ? project.deployment.url : null;
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
    ctaHtml = `<a class="btn primary" href="${BASE_URL}/project.html?pid=${escapeHtml(pid)}">${inlineSvg("external", 14)} Open dashboard</a>`;
  } else if (canCopy) {
    ctaHtml = `<button class="btn primary" data-action="copy" data-pid="${escapeHtml(pid)}" type="button">${inlineSvg("copy", 14)} Save a copy</button>`;
  } else if (!isSignedIn) {
    const next = encodeURIComponent("/" + (owner.profile?.username || "") + "/" + (project.slug || ""));
    ctaHtml = `<a class="btn primary" href="${BASE_URL}/register?next=${next}">Sign in to copy</a>`;
  }

  const liveButtonHtml = liveUrl
    ? `<a class="btn secondary" href="${escapeHtml(liveUrl)}" target="_blank" rel="noopener">${inlineSvg("external", 14)} Visit live site</a>`
    : "";

  const codeButtonHtml = codePublic
    ? `<button class="btn secondary" data-action="view-code" type="button">${inlineSvg("code", 14)} View code</button>`
    : "";

  const projectIconHtml = projectIconHtmlFor(project);
  const ownerAvatarHtml = avatarHtmlFor(owner.profile, { size: 32, username: owner.profile?.username || username });
  const updatedAgo = formatTimeAgo(project.updatedAt);
  const createdLabel = formatDate(project.createdAt);

  const payload = {
    pid,
    slug: project.slug || "",
    name: project.name || "",
    description: project.description || "",
    ownerUsername: owner.profile?.username || username || "",
    ownerDisplayName: owner.profile?.displayName || owner.profile?.username || "",
    liveUrl: liveUrl || null,
    codePublic,
    dbPublic,
    languagesPublic,
    isOwnerViewer: viewerIsOwner,
    isSignedIn,
    canCopy,
    ownerUid: project.ownerId || null,
    viewerUsername,
    fileParam: fileParam || null,
    canonicalPath: `/${owner.profile?.username || username}/${project.slug || ""}`,
    languages: languagesPublic ? (project.languages?.breakdown || {}) : {},
    updatedAt: project.updatedAt || null,
    createdAt: project.createdAt || null,
    thumbnailUrl: projectThumbnailUrl || null,
    ogImageUrl: ogImageUrl || null,
    scene: project.ogImage?.scene || null,
    palette: project.ogImage?.palette || null,
    ogImageTemplate: project.ogImage?.template || null,
    ogImageGeneratedAt: project.ogImage?.generatedAt || null,
    baseUrl: BASE_URL,
    editorUrl: viewerIsOwner ? `${BASE_URL}/project.html?pid=${pid}` : null,
  };
  const projectScript = `<script>window.__PROJECT__ = ${JSON.stringify(payload).replace(/</g, "\\u003c")};</script>`;

  const ogImageMeta = ogImageUrl
    ? `<meta property="og:image" content="${escapeHtml(ogImageUrl)}">`
    : "";
  const twitterImageMeta = ogImageUrl
    ? `<meta name="twitter:image" content="${escapeHtml(ogImageUrl)}">`
    : "";

  const projectPreviewHtml = projectThumbnailUrl ? `
    <div class="project-hero">
      <img class="project-hero-image" src="${escapeHtml(projectThumbnailUrl)}" alt="${escapeHtml(project.name || "")} preview" loading="lazy" />
    </div>
  ` : "";

  const ogPreviewHtml = (viewerIsOwner && ogImageUrl) ? `
    <div class="og-preview-panel">
      <div class="og-preview-head">
        <span class="og-preview-label">Share preview</span>
        <span class="og-preview-badge">${escapeHtml(project.ogImage?.template || "auto")}</span>
      </div>
      <img class="og-preview-image" src="${escapeHtml(ogImageUrl)}" alt="OG preview" loading="lazy" />
    </div>
  ` : "";

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
    OWNER_USERNAME: owner.profile?.username || username || "",
    OWNER_DISPLAY_NAME: owner.profile?.displayName || owner.profile?.username || "",
    OWNER_AVATAR_HTML: { raw: ownerAvatarHtml },
    OWNER_PROFILE_URL: owner.profile?.username ? `${BASE_URL}/${owner.profile.username}` : `${BASE_URL}`,
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
    CANONICAL_URL: `${BASE_URL}/${owner.profile?.username || username}/${project.slug || ""}`,
    SHARE_URL: `${BASE_URL}/${owner.profile?.username || username}/${project.slug || ""}`,
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
}

async function handleProfilePublic(req, res, reqId) {
  if (!(await enforceRate(req, res, "profilePublic", ipKey(req)))) return;

  const username = String(req.query?.username || "").trim().toLowerCase();
  if (!username) {
    return sendHtmlPage(res, {
      title: "Missing username",
      heading: "Profile not found",
      message: "No username was provided in the URL.",
      status: 400,
      icon: "alert",
    });
  }

  if (!/^[a-z0-9_-]{1,30}$/.test(username)) {
    return sendHtmlPage(res, {
      title: "Invalid username",
      heading: "Profile not found",
      message: "The username in the URL is not valid.",
      status: 400,
      icon: "user",
    });
  }

  const prevSnap = await db.ref(`previousUsernames/${username}`).once("value");
  if (prevSnap.exists()) {
    return res.redirect(301, `${BASE_URL}/${prevSnap.val()}`);
  }

  const user = await getUserByUsername(username);
  if (!user) {
    return sendHtmlPage(res, {
      title: "Profile not found",
      heading: "Profile not found",
      message: `@${username} doesn't have a Folio account, or has changed their username.`,
      status: 404,
      icon: "user",
    });
  }

  if (!user.profile?.avatarUrl) {
    (async () => {
      try {
        const generated = await ensureUserAvatar(
          user.uid,
          user.profile?.displayName,
          username,
        );
        if (generated) {
          log("host.profile.avatar_generated_bg", { uid: user.uid, username });
        }
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
      const { verifySession } = await import("../utils/users.js");
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
    const snap = await db.ref(`projects/${pid}`).once("value");
    if (!snap.exists()) continue;
    const p = snap.val();
    if (!isOwner && p.visibility?.profile !== "public") continue;

    let thumbnailUrl = null;
    try {
      const t = await db.ref(`projects/${pid}/thumbnail/url`).once("value");
      if (t?.exists() && isValidOgUrl(t.val())) thumbnailUrl = t.val();
    } catch {}

    projectList.push({
      pid,
      slug: p.slug || "",
      name: p.name || "Untitled",
      description: p.description || "",
      iconUrl: p.iconUrl || null,
      thumbnailUrl,
      languages: p.visibility?.languages !== "private" ? (p.languages?.breakdown || {}) : {},
      updatedAt: p.updatedAt || null,
      url: p.slug ? `${BASE_URL}/${username}/${p.slug}` : `${BASE_URL}/${username}`,
    });
  }
  projectList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const grid = projectList.length > 0
    ? projectList.map(pr => {
        const iconHtml = pr.iconUrl
          ? `<img src="${escapeHtml(pr.iconUrl)}" alt="" style="width:44px;height:44px;border-radius:11px;object-fit:cover;display:block;">`
          : `<span style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:11px;background:linear-gradient(135deg,#F59E0B,#f97316);color:#0a0c10;font-weight:800;font-size:15px;">${escapeHtml(initialsOf(pr.name))}</span>`;
        const thumbHtml = pr.thumbnailUrl
          ? `<div class="project-card-thumb" style="background-image:url('${escapeHtml(pr.thumbnailUrl)}')"></div>`
          : `<div class="project-icon">${iconHtml}</div>`;
        const langBadges = Object.entries(pr.languages).slice(0, 3).map(([n, v]) =>
          `<span class="lang-badge"><span class="lang-dot"></span>${escapeHtml(n)} ${v}%</span>`
        ).join("");
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
  const bioBlock = user.profile?.bio
    ? `<p class="profile-bio">${escapeHtml(user.profile.bio)}</p>`
    : "";
  const linksEntries = Object.entries(user.profile?.links || {});
  const linksBlock = linksEntries.length
    ? `<div class="profile-links">${linksEntries.map(([k, v]) =>
        `<a class="profile-link" href="${escapeHtml(v)}" target="_blank" rel="noopener">${escapeHtml(k)}</a>`
      ).join("")}</div>`
    : "";

  const profileUrl = `${BASE_URL}/${username}`;
  const shareProfileHtml = `
    <button class="btn ghost" type="button" data-action="share-profile" data-url="${escapeHtml(profileUrl)}">
      ${inlineSvg("copy", 14)} Copy profile link
    </button>`;

  const signInCtaHtml = !isSignedIn
    ? `<div class="signin-banner">
         <span>Signed out — ${inlineSvg("user", 12)} viewing as guest</span>
         <a class="btn primary btn-sm" href="${BASE_URL}/register?next=${encodeURIComponent("/" + username)}">Sign in</a>
       </div>`
    : "";

  const profileOgImage = await ensureProfileOgImage({ user, username });
  const ogImageMeta = profileOgImage
    ? `<meta property="og:image" content="${escapeHtml(profileOgImage)}">`
    : "";
  const twitterImageMeta = profileOgImage
    ? `<meta name="twitter:image" content="${escapeHtml(profileOgImage)}">`
    : "";

  const profileJson = {
    username,
    displayName: user.profile?.displayName || username,
    bio: user.profile?.bio || "",
    avatarUrl: user.profile?.avatarUrl || null,
    isOwner,
    isSignedIn,
    viewerUsername,
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
  };
  const profileScript = `<script>window.__PROFILE__ = ${JSON.stringify(profileJson).replace(/</g, "\\u003c")};</script>`;

  const avatarPreloadHtml = user.profile?.avatarUrl
    ? `<link rel="preload" as="image" href="${escapeHtml(user.profile.avatarUrl)}">`
    : "";

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
}

async function tryOwnerView(req, pid) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  const { verifySession } = await import("../utils/users.js");
  const decoded = verifySession(header.slice(7).trim());
  if (!decoded) return false;
  const role = await canAccessProject(decoded.uid, pid);
  return role === "owner" || role === "editor";
}

async function tryOwnerViewer(req, uid) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  const { verifySession } = await import("../utils/users.js");
  const decoded = verifySession(header.slice(7).trim());
  return decoded && decoded.uid === uid;
}

async function handleView(req, res, reqId) {
  if (!(await enforceRate(req, res, "view", ipKey(req)))) return;

  const { username } = req.body || {};
  if (!username) return res.status(400).json({ success: false, error: "Missing username" });

  if (isBot(req)) return res.status(200).json({ success: true, skipped: "bot" });

  const user = await getUserByUsername(username);
  if (!user) return res.status(404).json({ success: false, error: "User not found" });

  const isOwner = await tryOwnerViewer(req, user.uid);
  if (isOwner) return res.status(200).json({ success: true, skipped: "owner" });

  const ip = getClientIp(req);
  const ua = req.headers["user-agent"] || "";
  const today = dayString();
  const visitorHash = crypto.createHash("sha256")
    .update(`${ip}|${ua}|${today}`).digest("hex").slice(0, 12);

  await db.ref(`analytics/${user.uid}/profile/views/${today}/${visitorHash}`).set({
    ts: Date.now(),
  });

  return res.status(200).json({ success: true });
}

// =========================================================================
// LOGS
// =========================================================================

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
  snap.forEach(child => {
    const v = child.val();
    if (typeFilter !== "all" && v.type !== typeFilter) return;
    all.push({ id: child.key, ...v });
  });
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const slice = all.slice(offset, offset + limit);

  return res.status(200).json({
    success: true,
    logs: slice,
    total: all.length,
    hasMore: offset + limit < all.length,
  });
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
    if (method === "GET"  && action === "projects/list")        return await handleProjectsList(req, res, reqId);
    if (method === "GET"  && action === "projects/get")         return await handleProjectsGet(req, res, reqId);
    if (method === "POST" && action === "projects/create")      return await handleProjectsCreate(req, res, reqId);
    if (method === "POST" && action === "projects/update")      return await handleProjectsUpdate(req, res, reqId);
    if (method === "POST" && action === "projects/delete")      return await handleProjectsDelete(req, res, reqId);
    if (method === "POST" && action === "project/regenerate-preview") return await handleRegeneratePreview(req, res, reqId);

    if (method === "POST" && action === "deploy")               return await handleDeploy(req, res, reqId);
    if (method === "POST" && action === "redeploy")             return await handleRedeploy(req, res, reqId);
    if (method === "GET"  && action === "status")               return await handleStatus(req, res, reqId);

    if (method === "GET"  && action === "deployment/history")   return await handleDeploymentHistory(req, res, reqId);
    if (method === "POST" && action === "deployment/offline")   return await handleDeploymentOffline(req, res, reqId);
    if (method === "POST" && action === "deployment/delete")    return await handleDeploymentDelete(req, res, reqId);

    if (method === "POST" && action === "versions/clear")       return await handleVersionsClear(req, res, reqId);
    if (method === "POST" && action === "cache/clear")          return await handleCacheClear(req, res, reqId);

    if (method === "GET"  && action === "project/export")       return await handleProjectExport(req, res, reqId);
    if (method === "POST" && action === "project/sync-back")    return await handleProjectSyncBack(req, res, reqId);
    if (method === "POST" && action === "project/copy")         return await handleProjectCopy(req, res, reqId);

    if (method === "GET"  && action === "file/list")            return await handleFileList(req, res, reqId);
    if (method === "GET"  && action === "file/get")             return await handleFileGet(req, res, reqId);

    if (method === "GET"  && action === "serve")                return await handleServe(req, res, reqId);

    if (method === "POST" && action === "db/set")               return await handleDbSet(req, res, reqId);
    if (method === "GET"  && action === "db/get")               return await handleDbGet(req, res, reqId);
    if (method === "POST" && action === "db/schema")            return await handleDbSchema(req, res, reqId);

    if (method === "POST" && action === "apikey/generate")      return await handleApiKeyGenerate(req, res, reqId);
    if (method === "POST" && action === "visibility")           return await handleVisibility(req, res, reqId);
    if (method === "POST" && action === "file-visibility")      return await handleFileVisibility(req, res, reqId);
    if (method === "POST" && action === "invite/create")        return await handleInviteCreate(req, res, reqId);
    if (method === "GET"  && action === "invite/list")          return await handleInviteList(req, res, reqId);
    if (method === "POST" && action === "invite/accept")        return await handleInviteAccept(req, res, reqId);
    if (method === "POST" && action === "invite/cancel")        return await handleInviteCancel(req, res, reqId);
    if (method === "POST" && action === "collaborator/remove")  return await handleCollaboratorRemove(req, res, reqId);
    if (method === "POST" && action === "metatags/save")        return await handleMetatagsSave(req, res, reqId);

    if (method === "GET"  && action === "share")                return await handleShare(req, res, reqId);
    if (method === "GET"  && action === "profile")              return await handleProfilePublic(req, res, reqId);
    if (method === "POST" && action === "view")                 return await handleView(req, res, reqId);

    if (method === "GET"  && action === "logs")                 return await handleLogs(req, res, reqId);

    return res.status(404).json({ success: false, error: `Unknown action: ${action || "(none)"}` });
  } catch (err) {
    log("host.unhandled_error", { reqId, action, method, message: err.message, stack: err.stack });
    if (pidForLog) {
      logProjectApiCall(pidForLog, false).catch(() => {});
    }
    return res.status(500).json({ success: false, error: "Internal error", reqId });
  } finally {
    if (pidForLog) {
      logProjectApiCall(pidForLog, true).catch(() => {});
    }
  }
}

export const config = { runtime: "nodejs" };

// =========================================================================
// MODULE EXPORTS (for cross-module use — e.g. auth.js profile edits)
// =========================================================================

export {
  invalidateProfileOgImage,
  ensureProjectOgImage,
  ensureProfileOgImage,
  ensureProjectLanguages,
  ensureProjectThumbnail,
  notificationImageUrl,
};