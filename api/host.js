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

function nowIso() {
  return new Date().toISOString();
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

async function callVercelDeleteDeployment(deploymentId) {
  if (!deploymentId) return { ok: false, reason: "no_id" };
  const url = VERCEL_TEAM_ID
    ? `https://api.vercel.com/v13/deployments/${deploymentId}?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`
    : `https://api.vercel.com/v13/deployments/${deploymentId}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${VERCEL_TOKEN}` },
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    log("host.vercel_delete_failed", { deploymentId, message: err.message });
    return { ok: false, reason: err.message };
  }
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
// ZIP BUILDER (server-side, no external dep)
// =========================================================================
// Minimal store-only ZIP writer — no compression, no encryption.
// Good enough for .folio/.zip project exports up to a few MB.

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
  // entries: [{ name: "path/to/file", data: Buffer }]
  const localHeaders = [];
  const centralDir = [];
  let offset = 0;

  const { time, date } = dosDateTime();

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);

    // Local file header (30 bytes + name)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);       // signature
    localHeader.writeUInt16LE(20, 4);               // version needed
    localHeader.writeUInt16LE(0x0800, 6);           // flags (UTF-8)
    localHeader.writeUInt16LE(0, 8);                // compression (store)
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);     // compressed size
    localHeader.writeUInt32LE(data.length, 22);     // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);               // extra length
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader);
    localHeaders.push(data);

    // Central directory header (46 bytes + name)
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);           // signature
    central.writeUInt16LE(20, 4);                   // version made by
    central.writeUInt16LE(20, 6);                   // version needed
    central.writeUInt16LE(0x0800, 8);               // flags
    central.writeUInt16LE(0, 10);                   // compression
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);                   // extra length
    central.writeUInt16LE(0, 32);                   // comment length
    central.writeUInt16LE(0, 34);                   // disk number
    central.writeUInt16LE(0, 36);                   // internal attrs
    central.writeUInt32LE(0, 38);                   // external attrs
    central.writeUInt32LE(offset, 42);              // local header offset
    nameBuf.copy(central, 46);

    centralDir.push(central);
    offset += localHeader.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralDir) centralSize += c.length;

  // End of central directory (22 bytes)
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

// =========================================================================
// PROJECTS CRUD
// =========================================================================

async function handleProjectsList(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "projectsList", `uid_${user.uid}`))) return;

  const projects = await listUserProjects(user.uid);
  return res.status(200).json({ success: true, projects });
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
  const { pid, name, description } = req.body || {};
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
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: "No fields to update" });
  }

  patch.updatedAt = Date.now();
  await db.ref(`projects/${pid}`).update(patch);
  await logProjectEvent(pid, access.uid, "project", "project.updated", {
    fields: Object.keys(patch).filter(k => k !== "updatedAt"),
  });

  const snap = await db.ref(`projects/${pid}`).once("value");
  const p = snap.exists() ? snap.val() : {};
  const { apiKeyHash, ...safe } = p;
  return res.status(200).json({ success: true, project: { pid, ...safe } });
}

async function handleProjectsDelete(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "projectsDelete", `pid_${pid}`))) return;

  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  try {
    await deleteProjectRecord(pid, access.uid);
    return res.status(200).json({ success: true });
  } catch (err) {
    log("host.projects_delete.failed", { reqId, pid, message: err.message });
    return res.status(500).json({ success: false, error: "Could not delete project" });
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

  const deploymentRecord = {
    url,
    versionId: versionId || null,
    deployedAt: Date.now(),
    deploymentId: deployment.id || null,
    state: deployment.readyState || "QUEUED",
    stateUrl,
    deployedBy: access.uid,
  };

  // Current deployment
  await db.ref(`projects/${pid}/deployment`).set(deploymentRecord);

  // Append to history (last 30 kept)
  if (deployment.id) {
    await db.ref(`projects/${pid}/deployments/${deployment.id}`).set(deploymentRecord);
    try {
      const histSnap = await db.ref(`projects/${pid}/deployments`).once("value");
      if (histSnap.exists()) {
        const entries = [];
        histSnap.forEach(child => {
          entries.push({ id: child.key, at: child.val()?.deployedAt || 0 });
        });
        if (entries.length > 30) {
          entries.sort((a, b) => a.at - b.at);
          const toDelete = entries.slice(0, entries.length - 30);
          const updates = {};
          toDelete.forEach(e => { updates[e.id] = null; });
          await db.ref(`projects/${pid}/deployments`).update(updates);
        }
      }
    } catch {}
  }

  await db.ref(`projects/${pid}/updatedAt`).set(Date.now());

  await logProjectEvent(pid, access.uid, "deploy", "project.deployed", {
    url,
    versionId: versionId || null,
  });

  callNotify("project", project.ownerId, {
    title: "Deployment started",
    body: `Project "${project.name}" is deploying.`,
    link: `${BASE_URL}/project?pid=${pid}`,
    extra: { pid },
  }).catch(() => {});

  return res.status(202).json({
    success: true,
    deploymentId: deployment.id || null,
    stateUrl,
    url,
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

  // Mark current deployment as offline in DB but don't delete from Vercel.
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

  // Check if this is the current deployment
  const currentSnap = await db.ref(`projects/${pid}/deployment/deploymentId`).once("value");
  const isCurrent = currentSnap.exists() && currentSnap.val() === deploymentId;

  // Best-effort Vercel delete
  const vercelResult = await callVercelDeleteDeployment(deploymentId);

  // Remove from history
  await db.ref(`projects/${pid}/deployments/${deploymentId}`).remove();

  // If it was the current deployment, clear the current node
  if (isCurrent) {
    await db.ref(`projects/${pid}/deployment`).remove();
  }

  await logProjectEvent(pid, access.uid, "deploy", "deployment.deleted", {
    deploymentId,
    vercelOk: vercelResult.ok,
  });

  return res.status(200).json({
    success: true,
    vercelDeleted: vercelResult.ok,
  });
}

// =========================================================================
// VERSIONS CLEAR
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

// =========================================================================
// CACHE CLEAR
// =========================================================================

async function handleCacheClear(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "cacheClear", `pid_${pid}`))) return;

  const access = await requireProjectRole(req, res, pid, "owner");
  if (!access) return;

  // Cache on the server side isn't a thing here (project.html caches client-side).
  // But we can clear analytics counters, activity feed, or stale data if needed.
  // For now: log the event; client clears IndexedDB itself.
  await logProjectEvent(pid, access.uid, "project", "cache.cleared", {});
  return res.status(200).json({ success: true, message: "Client cache is clearable via project.html" });
}

// =========================================================================
// PROJECT EXPORT (folio/zip)
// =========================================================================

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

  // Viewer+ can export public-only; editor+ can export full
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

  // Get files: either from a version or from current files in DB
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

  // Filter for public-only
  if (publicOnly) {
    const publicFiles = project.publicFiles || {};
    const filtered = {};
    for (const [path, content] of Object.entries(filesObj)) {
      const safePath = sanitizeFirebasePath(path.replace(/\//g, "__"));
      if (publicFiles[safePath]) filtered[path] = content;
    }
    filesObj = filtered;
  }

  // Get versions (only for full .folio)
  let versionsObj = {};
  if (format === "folio" && !publicOnly) {
    const vSnap = await db.ref(`versions/${pid}`).once("value");
    if (vSnap.exists()) {
      vSnap.forEach(child => {
        versionsObj[child.key] = child.val();
      });
    }
  }

  // Get JSON DB (only for full .folio)
  let jsonDb = null;
  let jsonDbSchema = null;
  if (format === "folio" && !publicOnly) {
    const dbSnap = await db.ref(`projectData/${pid}`).once("value");
    const schemaSnap = await db.ref(`projectSchemas/${pid}`).once("value");
    jsonDb = dbSnap.exists() ? dbSnap.val() : null;
    jsonDbSchema = schemaSnap.exists() ? schemaSnap.val() : null;
  }

  // Build zip entries
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

  // Files
  for (const [filePath, content] of Object.entries(filesObj)) {
    const safeName = `files/${filePath}`;
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(String(content));
    entries.push({ name: safeName, data: buf });
  }

  // Versions (folio only)
  if (format === "folio" && !publicOnly) {
    for (const [vid, v] of Object.entries(versionsObj)) {
      entries.push({
        name: `versions/${vid}.json`,
        data: Buffer.from(JSON.stringify(v, null, 2), "utf8"),
      });
    }
  }

  // JSON DB (folio only)
  if (format === "folio" && !publicOnly) {
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

  // Last-write-wins for v1
  const result = {
    filesWritten: 0,
    filesSkipped: 0,
    versionsWritten: 0,
    dbWritten: false,
    schemaWritten: false,
  };

  // Files
  if (files && typeof files === "object") {
    for (const [filePath, content] of Object.entries(files)) {
      if (typeof content !== "string") {
        result.filesSkipped++;
        continue;
      }
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

  // Versions (if provided and not already present)
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

  // JSON DB
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

  return res.status(200).json({ success: true, ...result });
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

  // Determine access: owner/editor gets full copy, viewer/public gets public files only
  const role = await canAccessProject(user.uid, sourcePid);
  const canFullCopy = role === "owner" || role === "editor";
  const isPublic = source.visibility?.profile === "public";
  if (!canFullCopy && !isPublic) {
    return res.status(403).json({ success: false, error: "Cannot copy this project" });
  }

  // Create new project
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

  // Copy files (full or public-only)
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

  // Copy JSON DB (only for full copy)
  if (canFullCopy) {
    try {
      const dbSnap = await db.ref(`projectData/${sourcePid}`).once("value");
      if (dbSnap.exists()) await db.ref(`projectData/${newProject.pid}`).set(dbSnap.val());
      const schemaSnap = await db.ref(`projectSchemas/${sourcePid}`).once("value");
      if (schemaSnap.exists()) await db.ref(`projectSchemas/${newProject.pid}`).set(schemaSnap.val());
    } catch {}
  }

  // Record fork source
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
  const { pid, key, value, data } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!(await enforceRate(req, res, "dbSet", `pid_${pid}`))) return;

  const access = await checkProjectKeyOrRole(req, res, pid, "editor");
  if (!access) return;

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

  await db.ref(`analytics/${pid}/db/${today}`).transaction(cur => {
    const c = cur || { reads: 0, writes: 0, bytesIn: 0, bytesOut: 0 };
    c.writes = (c.writes || 0) + 1;
    c.bytesIn = (c.bytesIn || 0) + serialized.length;
    return c;
  }).catch(() => {});

  await logProjectEvent(pid, uidForLog, "db", "db.written", {
    key: key || null,
    bytes: serialized.length,
    viaApiKey: access.uid === "api",
  });

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
          link: `${BASE_URL}/project?pid=${pid}`,
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
    ? `<a class="btn" href="${BASE_URL}/project?pid=${escapeHtml(pid)}">Open dashboard</a>`
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

  const projectJson = {
    pid,
    name: project.name || slug,
    slug,
    description: project.description || "",
    ownerUsername: owner.profile?.username || username,
    isOwner: isOwnerViewer,
    liveUrl: project.visibility?.liveSite === "public" ? (project.deployment?.url || null) : null,
    codePublic: project.visibility?.code === "public",
    languages: project.languages?.breakdown || {},
  };
  const projectScript = `<script>window.__PROJECT__ = ${JSON.stringify(projectJson).replace(/</g, "\\u003c")};</script>`;

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
    INJECT_PROJECT_SCRIPT: { raw: projectScript },
  });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  return res.status(200).send(html);
}

async function handleProfilePublic(req, res, reqId) {
  if (!(await enforceRate(req, res, "profilePublic", ipKey(req)))) return;

  const username = String(req.query?.username || "").trim().toLowerCase();
  if (!username) return res.status(400).send("Missing username");

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
    ? `<div class="owner-controls"><a class="btn primary" href="${BASE_URL}/">Open editor</a></div>`
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

  const profileJson = {
    username,
    displayName: user.profile?.displayName || username,
    bio: user.profile?.bio || "",
    avatarUrl: user.profile?.avatarUrl || null,
    isOwner,
    projectCount: projectList.length,
  };
  const profileScript = `<script>window.__PROFILE__ = ${JSON.stringify(profileJson).replace(/</g, "\\u003c")};</script>`;

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
    INJECT_PROFILE_SCRIPT: { raw: profileScript },
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
    // Projects CRUD
    if (method === "GET"  && action === "projects/list")        return await handleProjectsList(req, res, reqId);
    if (method === "GET"  && action === "projects/get")         return await handleProjectsGet(req, res, reqId);
    if (method === "POST" && action === "projects/create")      return await handleProjectsCreate(req, res, reqId);
    if (method === "POST" && action === "projects/update")      return await handleProjectsUpdate(req, res, reqId);
    if (method === "POST" && action === "projects/delete")      return await handleProjectsDelete(req, res, reqId);

    // Deploy
    if (method === "POST" && action === "deploy")               return await handleDeploy(req, res, reqId);
    if (method === "POST" && action === "redeploy")             return await handleRedeploy(req, res, reqId);
    if (method === "GET"  && action === "status")               return await handleStatus(req, res, reqId);

    // Deployment history + lifecycle
    if (method === "GET"  && action === "deployment/history")   return await handleDeploymentHistory(req, res, reqId);
    if (method === "POST" && action === "deployment/offline")   return await handleDeploymentOffline(req, res, reqId);
    if (method === "POST" && action === "deployment/delete")    return await handleDeploymentDelete(req, res, reqId);

    // Versions / cache
    if (method === "POST" && action === "versions/clear")       return await handleVersionsClear(req, res, reqId);
    if (method === "POST" && action === "cache/clear")          return await handleCacheClear(req, res, reqId);

    // Project export / sync / copy
    if (method === "GET"  && action === "project/export")       return await handleProjectExport(req, res, reqId);
    if (method === "POST" && action === "project/sync-back")    return await handleProjectSyncBack(req, res, reqId);
    if (method === "POST" && action === "project/copy")         return await handleProjectCopy(req, res, reqId);

    // JSON DB
    if (method === "POST" && action === "db/set")               return await handleDbSet(req, res, reqId);
    if (method === "GET"  && action === "db/get")               return await handleDbGet(req, res, reqId);
    if (method === "POST" && action === "db/schema")            return await handleDbSchema(req, res, reqId);

    // Sharing / permissions
    if (method === "POST" && action === "apikey/generate")      return await handleApiKeyGenerate(req, res, reqId);
    if (method === "POST" && action === "visibility")           return await handleVisibility(req, res, reqId);
    if (method === "POST" && action === "file-visibility")      return await handleFileVisibility(req, res, reqId);
    if (method === "POST" && action === "invite/create")        return await handleInviteCreate(req, res, reqId);
    if (method === "POST" && action === "invite/accept")        return await handleInviteAccept(req, res, reqId);
    if (method === "POST" && action === "invite/cancel")        return await handleInviteCancel(req, res, reqId);
    if (method === "POST" && action === "collaborator/remove")  return await handleCollaboratorRemove(req, res, reqId);
    if (method === "POST" && action === "metatags/save")        return await handleMetatagsSave(req, res, reqId);

    // Public renders
    if (method === "GET"  && action === "share")                return await handleShare(req, res, reqId);
    if (method === "GET"  && action === "profile")              return await handleProfilePublic(req, res, reqId);
    if (method === "POST" && action === "view")                 return await handleView(req, res, reqId);

    // Logs
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