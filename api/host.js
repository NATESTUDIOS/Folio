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
  logUserEvent, logProjectEvent,
} from "../utils/users.js";

// =========================================================================
// RATE LIMITS (per-API, per Final Rule #16)
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
  inviteAccept:       { max: 10,   window: 60 * 60 * 1000 },
  inviteCancel:       { max: 20,   window: 60 * 60 * 1000 },
  collaboratorRemove: { max: 20,   window: 60 * 60 * 1000 },
  metatagsSave:       { max: 20,   window: 60 * 60 * 1000 },
  share:              { max: 60,   window: 60 * 1000 },
  profilePublic:      { max: 60,   window: 60 * 1000 },
  view:               { max: 10,   window: 60 * 1000 },
  logs:               { max: 60,   window: 60 * 60 * 1000 },
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
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || "";
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || "";

const BOT_UA_RE = /bot|crawler|spider|preview|curl|wget|python-requests|httpclient/i;

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

/**
 * Read a static HTML file from public/. Cached in memory per cold start.
 * Templates are static with {{PLACEHOLDER}} tokens (playbook §2 Rule 5).
 */
const templateCache = new Map();
function readTemplate(name) {
  if (templateCache.has(name)) return templateCache.get(name);
  const p = path.join(process.cwd(), "public", name);
  const content = fs.readFileSync(p, "utf8");
  templateCache.set(name, content);
  return content;
}

/**
 * Replace {{KEY}} tokens. Values are stringified, HTML-escaped for
 * text contexts. For raw HTML injection, wrap value in { raw: "..." }.
 */
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

/**
 * Look up a project by owner username + slug.
 * Returns { pid, project } or null.
 */
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

/**
 * Look up a project by owner uid + slug. Faster than by-slug scan.
 */
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

/**
 * Compute language breakdown from a set of file paths.
 * Preset mapping — no full AST analysis in v1.
 */
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

/**
 * Inject meta tags + tracker into a file's contents (typically index.html).
 */
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

  // Insert before </head> if present, else at top
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

/**
 * Vercel deploy payload from a files map.
 * files: { "path/name.ext": "content", ... }
 */
function buildVercelPayload(name, files, metaTags) {
  const vercelFiles = [];
  for (const [filePath, content] of Object.entries(files)) {
    let data = content;
    if (typeof data !== "string") {
      log("host.deploy.non_string_file", { filePath });
      continue;
    }
    if (/\.html?$/i.test(filePath)) {
      data = injectHead(data, metaTags, name);
      data = injectTracker(data, name);
    }
    vercelFiles.push({ file: filePath, data });
  }
  return {
    name,
    files: vercelFiles,
    target: "production",
    projectSettings: { framework: null },
  };
}

async function callVercelDeploy(payload) {
  const url = VERCEL_TEAM_ID
    ? `https://api.vercel.com/v13/deployments?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`
    : "https://api.vercel.com/v13/deployments";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${VERCEL_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error?.message || `Vercel deploy failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function callNotify(type, uid, payload) {
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

// =========================================================================
// DEPLOY
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
  const name = `${project.slug}-${shortId(pid)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  const payload = buildVercelPayload(name, files, project.metaTags || {});

  let deployment;
  try {
    deployment = await callVercelDeploy(payload);
  } catch (err) {
    log("host.deploy.vercel_error", { reqId, pid, status: err.status, message: err.message });
    return res.status(502).json({ success: false, error: "Deployment failed upstream" });
  }

  const url = deployment.url ? `https://${deployment.url}` : null;
  const stateUrl = deployment.inspectorUrl || null;

  await db.ref(`projects/${pid}/deployment`).set({
    url,
    versionId: versionId || null,
    deployedAt: Date.now(),
    deploymentId: deployment.id || null,
    state: deployment.readyState || "QUEUED",
    stateUrl,
  });
  await db.ref(`projects/${pid}/updatedAt`).set(Date.now());

  await logProjectEvent(pid, access.uid, "deploy", "project.deployed", {
    url,
    versionId: versionId || null,
  });

  callNotify("project", project.ownerId, {
    title: "Deployment started",
    body: `Project "${project.name}" is deploying.`,
    link: `${BASE_URL}/app?pid=${pid}`,
    extra: { pid },
  }).catch(() => {});

  return res.status(202).json({
    success: true,
    deploymentId: deployment.id || null,
    stateUrl,
    url, // may be provisional until ready
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

  // Reuse the deploy path
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
  const { pid, key, value, data } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "dbSet", `pid_${pid}`))) return;

  const access = await checkProjectKeyOrRole(req, res, pid, "editor");
  if (!access) return;

  // Validate size
  const payload = data !== undefined ? data : value;
  const serialized = JSON.stringify(payload ?? null);
  if (serialized.length > 10 * 1024 * 1024) {
    return res.status(413).json({ success: false, error: "Payload too large (10 MB max)" });
  }

  const today = dayString();
  const uidForLog = access.uid === "api" ? null : access.uid;

  try {
    if (data !== undefined) {
      await db.ref(`projectData/${pid}`).set(data);
    } else if (key !== undefined) {
      await db.ref(`projectData/${pid}/${sanitizeFirebasePath(key)}`).set(value);
    } else {
      return res.status(400).json({ success: false, error: "Missing key or data" });
    }
  } catch (err) {
    log("host.dbSet.write_failed", { reqId, pid, message: err.message });
    return res.status(500).json({ success: false, error: "Write failed" });
  }

  // Update analytics counter
  await db.ref(`analytics/${pid}/db/${today}`).transaction(cur => {
    const c = cur || { reads: 0, writes: 0, bytesIn: 0, bytesOut: 0 };
    c.writes = (c.writes || 0) + 1;
    c.bytesIn = (c.bytesIn || 0) + serialized.length;
    return c;
  }).catch(() => {});

  // Log
  await logProjectEvent(pid, uidForLog, "db", "db.written", {
    key: key || null,
    bytes: serialized.length,
    viaApiKey: access.uid === "api",
  });

  // Storage warning (80% threshold) — best effort
  try {
    const sizeSnap = await db.ref(`projectData/${pid}`).once("value");
    const totalSize = JSON.stringify(sizeSnap.val() || {}).length;
    const limitSnap = await db.ref(`projects/${pid}/storageLimit`).once("value");
    const limit = limitSnap.exists() ? limitSnap.val() : 1024 * 1024;
    if (totalSize > limit * 0.8) {
      const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
      if (ownerSnap.exists()) {
        callNotify("storage", ownerSnap.val(), {
          title: "Storage nearly full",
          body: `Project is ${Math.round((totalSize / limit) * 100)}% full.`,
          link: `${BASE_URL}/app?pid=${pid}`,
          extra: { pid },
        }).catch(() => {});
      }
    }
  } catch {}

  return res.status(200).json({ success: true });
}

async function handleDbGet(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "dbGet", `pid_${pid}`))) return;

  // Auth path: project key OR explicit role OR public visibility
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
  const bytesOut = JSON.stringify(data).length;

  await db.ref(`analytics/${pid}/db/${today}`).transaction(cur => {
    const c = cur || { reads: 0, writes: 0, bytesIn: 0, bytesOut: 0 };
    c.reads = (c.reads || 0) + 1;
    c.bytesOut = (c.bytesOut || 0) + bytesOut;
    return c;
  }).catch(() => {});

  return res.status(200).json({ success: true, data, schema });
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
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    used: false,
    usedAt: null,
    createdAt: now,
  });

  callNotify("invite", invited.uid, {
    title: "Project invitation",
    body: `You've been invited to join a project as ${role}.`,
    link: `${BASE_URL}/invite?token=${token}`,
    extra: { token, pid, role },
  }).catch(() => {});

  await logProjectEvent(pid, access.uid, "invite", "invite.sent", {
    invitedUid: invited.uid,
    role,
  });

  return res.status(200).json({
    success: true,
    token,
    inviteUrl: `${BASE_URL}/invite?token=${token}`,
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
      found = { ...bySlug, owner };
    }
  }

  if (!found) {
    return res.status(404).send("Project not found");
  }

  const { pid, project, owner } = found;
  const isProfilePublic = project.visibility?.profile === "public";
  const isOwnerViewer = await tryOwnerView(req, pid);

  if (!isProfilePublic && !isOwnerViewer) {
    return res.status(403).send("This project is private");
  }

  const liveBtn = project.visibility?.liveSite === "public" && project.deployment?.url
    ? `<a class="btn primary" href="${escapeHtml(project.deployment.url)}" target="_blank" rel="noopener">View live site</a>`
    : "";
  const codeBtn = project.visibility?.code === "public" && fileParam
    ? `<a class="btn" href="${BASE_URL}/${escapeHtml(username)}/${escapeHtml(slug)}/${escapeHtml(fileParam)}">View code</a>`
    : "";
  const editorBtn = isOwnerViewer
    ? `<a class="btn" href="${BASE_URL}/app?pid=${escapeHtml(pid)}">Open in editor</a>`
    : "";

  const langs = project.languages?.breakdown
    ? Object.entries(project.languages.breakdown)
        .map(([name, pct]) => `<span class="lang-badge"><span class="lang-dot"></span>${escapeHtml(name)} ${pct}%</span>`)
        .join("")
    : "";

  const ogImageMeta = project.metaTags?.ogImage
    ? `<meta property="og:image" content="${escapeHtml(project.metaTags.ogImage)}">`
    : "";
  const twitterImageMeta = project.metaTags?.ogImage
    ? `<meta name="twitter:image" content="${escapeHtml(project.metaTags.ogImage)}">`
    : "";
  const emptyNote = !project.deployment?.url
    ? `<div class="empty-note">This project hasn't been deployed to a live site yet.</div>`
    : "";

  const tmpl = readTemplate("project-template.html");
  const html = applyTemplate(tmpl, {
    PROJECT_NAME: project.name || slug,
    PROJECT_DESCRIPTION: project.description || "",
    OWNER_USERNAME: owner.profile?.username || username,
    LANGUAGES: { raw: langs },
    LIVE_BUTTON: { raw: liveBtn },
    CODE_BUTTON: { raw: codeBtn },
    EDITOR_BUTTON: { raw: editorBtn },
    OG_TITLE: project.metaTags?.title || project.name || slug,
    OG_DESCRIPTION: project.metaTags?.description || project.description || "",
    OG_IMAGE_META: { raw: ogImageMeta },
    TWITTER_IMAGE_META: { raw: twitterImageMeta },
    CANONICAL_URL: `${BASE_URL}/${username}/${slug}`,
    EMPTY_NOTE: { raw: emptyNote },
  });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  return res.status(200).send(html);
}

async function handleProfilePublic(req, res, reqId) {
  if (!(await enforceRate(req, res, "profilePublic", ipKey(req)))) return;

  const username = String(req.query?.username || "").trim().toLowerCase();
  if (!username) return res.status(400).send("Missing username");

  // Previous username → 301 to new
  const prevSnap = await db.ref(`previousUsernames/${username}`).once("value");
  if (prevSnap.exists()) {
    return res.redirect(301, `${BASE_URL}/${prevSnap.val()}`);
  }

  const user = await getUserByUsername(username);
  if (!user) return res.status(404).send("User not found");

  const isOwner = await tryOwnerViewer(req, user.uid);
  const projectIds = user.projectIds || {};
  const projectList = [];
  for (const pid of Object.keys(projectIds)) {
    const snap = await db.ref(`projects/${pid}`).once("value");
    if (!snap.exists()) continue;
    const p = snap.val();
    if (!isOwner && p.visibility?.profile !== "public") continue;
    projectList.push({
      pid,
      slug: p.slug,
      name: p.name,
      description: p.description || "",
      languages: p.languages?.breakdown || {},
    });
  }

  const grid = projectList.map(pr => `
    <a class="project-card" href="${BASE_URL}/${escapeHtml(username)}/${escapeHtml(pr.slug)}">
      <h3>${escapeHtml(pr.name || pr.slug)}</h3>
      <p>${escapeHtml(pr.description)}</p>
      <div class="card-badges">${Object.entries(pr.languages).map(([n, v]) =>
        `<span class="lang-badge"><span class="lang-dot"></span>${escapeHtml(n)} ${v}%</span>`
      ).join("")}</div>
    </a>
  `).join("") || `<div class="empty-state"><h3>No public projects yet</h3><p>When ${escapeHtml(username)} publishes a project, it will appear here.</p></div>`;

  const ownerControls = isOwner
    ? `<div class="owner-controls"><a class="btn primary" href="${BASE_URL}/app">Open editor</a></div>`
    : "";

  const avatarHtml = user.profile?.avatarUrl
    ? `<img src="${escapeHtml(user.profile.avatarUrl)}" alt="${escapeHtml(user.profile.displayName || username)}">`
    : escapeHtml((user.profile?.displayName || username).charAt(0).toUpperCase());

  const bioBlock = user.profile?.bio
    ? `<p class="bio">${escapeHtml(user.profile.bio)}</p>`
    : "";

  const linksEntries = Object.entries(user.profile?.links || {});
  const linksBlock = linksEntries.length
    ? `<div class="links">${linksEntries.map(([k, v]) =>
        `<a href="${escapeHtml(v)}" target="_blank" rel="noopener">${escapeHtml(k)}</a>`
      ).join("")}</div>`
    : "";

  const ogImageMeta = user.profile?.ogImageUrl
    ? `<meta property="og:image" content="${escapeHtml(user.profile.ogImageUrl)}">`
    : "";
  const twitterImageMeta = user.profile?.ogImageUrl
    ? `<meta name="twitter:image" content="${escapeHtml(user.profile.ogImageUrl)}">`
    : "";

  const tmpl = readTemplate("profile-template.html");
  const html = applyTemplate(tmpl, {
    DISPLAY_NAME: user.profile?.displayName || username,
    USERNAME: username,
    AVATAR: { raw: avatarHtml },
    BIO_BLOCK: { raw: bioBlock },
    LINKS_BLOCK: { raw: linksBlock },
    OWNER_CONTROLS: { raw: ownerControls },
    PROJECT_GRID: { raw: grid },
    PROJECT_COUNT: String(projectList.length),
    OG_TITLE: user.profile?.displayName || username,
    OG_DESCRIPTION: user.profile?.bio || "",
    OG_IMAGE_META: { raw: ogImageMeta },
    TWITTER_IMAGE_META: { raw: twitterImageMeta },
    CANONICAL_URL: `${BASE_URL}/${username}`,
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

  try {
    if (method === "POST" && action === "deploy")               return await handleDeploy(req, res, reqId);
    if (method === "POST" && action === "redeploy")             return await handleRedeploy(req, res, reqId);
    if (method === "GET"  && action === "status")               return await handleStatus(req, res, reqId);
    if (method === "POST" && action === "db/set")               return await handleDbSet(req, res, reqId);
    if (method === "GET"  && action === "db/get")               return await handleDbGet(req, res, reqId);
    if (method === "POST" && action === "db/schema")            return await handleDbSchema(req, res, reqId);
    if (method === "POST" && action === "apikey/generate")      return await handleApiKeyGenerate(req, res, reqId);
    if (method === "POST" && action === "visibility")           return await handleVisibility(req, res, reqId);
    if (method === "POST" && action === "file-visibility")      return await handleFileVisibility(req, res, reqId);
    if (method === "POST" && action === "invite/create")        return await handleInviteCreate(req, res, reqId);
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
    return res.status(500).json({ success: false, error: "Internal error", reqId });
  }
}

export const config = { runtime: "nodejs" };