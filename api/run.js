// api/run.js
// ═══════════════════════════════════════════════════════════════════
//  Folio — Private API Runtime (Vercel Serverless / Chromium)
//  ────────────────────────────────────────────────────────────────
//  POST /api/{pid}/{route}
//
//  Runs user-authored api/*.js in headless Chromium.
//  Full browser platform: fetch, import, Image, OffscreenCanvas,
//  DOMParser, crypto.subtle, WebAssembly, Blob, FileReader, URL.
//
//  ⚠  LATENCY NOTE
//  On Vercel free tier, every invocation launches Chromium fresh
//  (~1.5–2s cold start) because serverless functions cannot keep
//  processes alive between calls. Warm invocations do not exist
//  on free tier. Expect ~2s per /api/* call.
//
//  If you need ~150ms warm starts, deploy this file to Railway,
//  Fly Machines, or a self-hosted VPS running a persistent Node
//  process — the code works unchanged.
//
//  Timeout budget (10s total):
//    - Chromium launch:    ~1500ms
//    - Page setup:          ~200ms
//    - User code:           up to ~7500ms
//    - Response read:       ~100ms
//
//  If user code exceeds ~7.5s, the request times out.
// ═══════════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import net from "node:net";
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
} from "../utils/users.js";
import * as projectSecrets from "../utils/projectsecret.js";
import * as projectDb from "../utils/projectdb.js";

// =========================================================================
// CONSTANTS
// =========================================================================

const INVOKE_TIMEOUT_MS = 10000;
const USER_CODE_TIMEOUT_MS = 7000;
const PAGE_SETUP_TIMEOUT_MS = 3000;
const CHROMIUM_LAUNCH_TIMEOUT_MS = 4000;

const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RECURSION_DEPTH = 3;

const BUILTIN_ALLOWED_HOSTS = new Set([
  "api.openai.com",
  "api.groq.com",
  "api.anthropic.com",
  "api.stripe.com",
  "api.supabase.co",
  "api.resend.com",
]);

const ALLOWED_IMPORT_HOSTS = new Set([
  "cdn.jsdelivr.net",
  "esm.sh",
  "unpkg.com",
]);

const FOLIO_INTERNAL_HOSTS = new Set([
  "folio",
  "foliostudios.vercel.app",
]);

const RATE_LIMITS = {
  perSessionPerRoute: { max: 10, window: 60 * 1000 },
  perSessionAllRoutes: { max: 50, window: 60 * 1000 },
  perProjectHour: { max: 500, window: 60 * 60 * 1000 },
  perProjectDay: { max: 2000, window: 24 * 60 * 60 * 1000 },
  perProjectPerRouteHour: { max: 100, window: 60 * 60 * 1000 },
};

const BASE_URL = process.env.BASE_URL || "https://foliostudios.vercel.app";

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
  // Project API key
  const apiKey = req.headers["x-project-key"];
  if (apiKey && typeof apiKey === "string") {
    try {
      const ok = await verifyProjectKey(pid, apiKey);
      if (ok) return { uid: null, role: "editor", via: "api-key", sessionId: `key_${hashIp(getClientIp(req))}` };
    } catch {}
  }

  // Session bearer
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

function extractAllowHosts(source) {
  const hosts = new Set();
  let match;
  ALLOW_LINE_RE.lastIndex = 0;
  while ((match = ALLOW_LINE_RE.exec(source)) !== null) {
    hosts.add(match[1].toLowerCase().trim());
  }
  return [...hosts];
}

// =========================================================================
// HOST VALIDATION (only used for drift check; deploy already validated)
// =========================================================================

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
    import("@sparticuz/chromium").then((m) => m.default || m),
    import("puppeteer-core").then((m) => m.default || m),
  ]);
  _chromiumModule = chromiumMod;
  _puppeteerModule = puppeteerMod;
  return { chromium: chromiumMod, puppeteer: puppeteerMod };
}

async function launchBrowser() {
  const { chromium, puppeteer } = await loadChromiumModules();

  const executablePath = await chromium.executablePath();

  const browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-sandbox",
      "--single-process",
    ],
    executablePath,
    headless: "shell",
    defaultViewport: { width: 1280, height: 720 },
    timeout: CHROMIUM_LAUNCH_TIMEOUT_MS,
  });

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
// INTERNAL DB HANDLER
// =========================================================================

async function handleInternalDbRequest(pid, url, req, actor) {
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
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: "Database operation failed" }),
    };
  }
}

// =========================================================================
// HTML PAGE BUILDER
// =========================================================================

function escapeJsonForInline(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
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

    const serialized = typeof body === "string" ? body : JSON.stringify(body);

    window.__RESULT__ = {
      ok: true,
      status,
      contentType,
      body: serialized,
      bodyBytes: (typeof serialized === "string" ? serialized : "").length,
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
// PAGE SETUP + EXECUTION
// =========================================================================

async function runInPage(browser, { html, allowedHostsSet, pid, actor, reqId, route }) {
  const page = await browser.newPage();

  const fetchHosts = new Set();

  try {
    // Set up request interception
    await page.setRequestInterception(true);

    page.on("request", async (request) => {
      try {
        const urlObj = new URL(request.url());
        const host = urlObj.hostname.toLowerCase();

        // data:, about:, blob: allowed (page-origin resources)
        if (urlObj.protocol === "data:" || urlObj.protocol === "about:" || urlObj.protocol === "blob:") {
          return await request.continue();
        }

        // Folio internal (in-process DB resolution)
        if (FOLIO_INTERNAL_HOSTS.has(host)) {
          if (
            urlObj.pathname === "/api/host" &&
            urlObj.searchParams.get("action")?.startsWith("db/")
          ) {
            try {
              let reqBody = {};
              try {
                const postData = request.postData();
                if (postData) reqBody = JSON.parse(postData);
              } catch {}
              const result = await handleInternalDbRequest(
                pid,
                urlObj,
                { body: reqBody, method: request.method() },
                actor,
              );
              return await request.respond({
                status: result.status,
                contentType: result.contentType,
                body: result.body,
              });
            } catch (err) {
              log("run.internal_db_route_failed", { reqId, pid, message: err.message });
              return await request.abort("failed");
            }
          }
          return await request.abort("blockedbyclient");
        }

        // HTTPS only
        if (urlObj.protocol !== "https:") {
          return await request.abort("blockedbyclient");
        }

        // Whitelist check
        if (
          BUILTIN_ALLOWED_HOSTS.has(host) ||
          ALLOWED_IMPORT_HOSTS.has(host) ||
          allowedHostsSet.has(host)
        ) {
          fetchHosts.add(host);
          return await request.continue();
        }

        return await request.abort("blockedbyclient");
      } catch (err) {
        log("run.request_intercept_error", { reqId, message: err.message });
        try { await request.abort("failed"); } catch {}
      }
    });

    // Load the page
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_SETUP_TIMEOUT_MS,
    });

    // Wait for the result
    await page.waitForFunction(
      () => window.__RESULT__ !== undefined,
      { timeout: USER_CODE_TIMEOUT_MS, polling: 50 },
    );

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
// PROJECT METADATA LOADER
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
  const publicFiles = publicFilesSnap.exists() ? publicFilesSnap.val() : { files: [], count: 0, totalBytes: 0 };
  const apiRoutes = apiRoutesSnap.exists() ? apiRoutesSnap.val() : { system: [], user: [] };

  const isSystemRoute = Array.isArray(apiRoutes.system) && apiRoutes.system.includes(route);
  const isUserRoute = Array.isArray(apiRoutes.user) && apiRoutes.user.includes(route);

  return { project, deployment, publicFiles, apiRoutes, isSystemRoute, isUserRoute };
}

// =========================================================================
// ROUTE FILE LOADER
// =========================================================================

async function loadRouteFile(pid, route) {
  const safeKey = sanitizeFirebasePath(`api/${route}.js`.replace(/\//g, "__"));
  const snap = await db.ref(`api-files/${pid}/${safeKey}`).once("value");
  if (!snap.exists()) return null;
  const data = snap.val();
  return data?.content || "";
}

// =========================================================================
// MAIN HANDLER
// =========================================================================

export default async function handler(req, res) {
  const reqId = newReqId();
  const startTime = Date.now();
  res.setHeader("X-Request-Id", reqId);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Project-Key, X-Recursion-Depth");
  if (req.method === "OPTIONS") return res.status(204).end();

  // ── Parse URL: /api/{pid}/{route} ─────────────────────────────────
  const urlPath = String(req.url || "").split("?")[0];
  const parts = urlPath.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const pid = parts[0];
  const routeRaw = parts[1] || "";
  const route = routeRaw.replace(/\.js$/i, "");

  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });
  if (!route) return res.status(400).json({ success: false, error: "Missing route" });
  if (!/^[a-z0-9_-]+$/i.test(route)) {
    return res.status(400).json({ success: false, error: "Invalid route name" });
  }

  // ── Recursion depth ──────────────────────────────────────────────
  const depthHeader = String(req.headers["x-recursion-depth"] || "0");
  const depth = Math.max(0, Math.min(10, parseInt(depthHeader, 10) || 0));
  if (depth >= MAX_RECURSION_DEPTH) {
    return res.status(508).json({ success: false, error: "Recursion limit exceeded", route });
  }

  // ── Auth ─────────────────────────────────────────────────────────
  const actor = await authenticate(req, pid);
  if (!actor) {
    return res.status(401).json({ success: false, error: "Authentication required" });
  }

  // ── Rate limit ───────────────────────────────────────────────────
  const rate = await enforceRate(actor.sessionId, pid, route).catch(() => ({ allowed: false, retryAfter: 60 }));
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfter || 60));
    return res.status(429).json({ success: false, error: "Rate limit exceeded", retryAfter: rate.retryAfter });
  }

  // ── Load invocation context ──────────────────────────────────────
  const ctx = await loadInvocationContext(pid, route);
  if (!ctx) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }

  if (!ctx.isSystemRoute && !ctx.isUserRoute) {
    return res.status(404).json({ success: false, error: "Route not found", route });
  }

  // ── Load route file ──────────────────────────────────────────────
  const userCode = await loadRouteFile(pid, route);
  if (!userCode || !userCode.trim()) {
    return res.status(404).json({ success: false, error: "Route file not found", route });
  }

  // ── Parse @allow + build allowed host set ────────────────────────
  let declaredHostsSet = new Set();
  let driftDetected = false;

  try {
    const fileHosts = extractAllowHosts(userCode);

    if (fileHosts.length > 0) {
      const allowedHostsSnap = await db.ref(`projects/${pid}/allowedHosts`).once("value");
      const manifest = allowedHostsSnap.exists() ? allowedHostsSnap.val() : {};

      for (const host of fileHosts) {
        const entry = manifest[host];
        if (entry && entry.validatedOk) {
          declaredHostsSet.add(host);
        } else {
          // Host is in the file but not in the manifest — drift
          driftDetected = true;
        }
      }
    } else {
      // No @allow lines — still include any manifest hosts validated for other files
      const allowedHostsSnap = await db.ref(`projects/${pid}/allowedHosts`).once("value");
      if (allowedHostsSnap.exists()) {
        const manifest = allowedHostsSnap.val();
        for (const [host, meta] of Object.entries(manifest)) {
          if (meta && meta.validatedOk) declaredHostsSet.add(host);
        }
      }
    }

    if (driftDetected) {
      log("run.host_drift_detected", { reqId, pid, route });
      logProjectEvent(pid, actor.uid || null, "api", "host_drift_detected", { route }).catch(() => {});
    }
  } catch (err) {
    log("run.allow_parse_failed", { reqId, pid, route, message: err.message });
    return res.status(500).json({ success: false, error: "Failed to parse @allow hosts" });
  }

  // ── Load secrets (ENV) ───────────────────────────────────────────
  let env = {};
  try {
    env = await projectSecrets.readAllSecrets(pid);
    // readAllSecrets returns values keyed by name; also strip metadata
    const plain = {};
    for (const [k, v] of Object.entries(env || {})) {
      if (v && typeof v === "object" && "value" in v) {
        plain[k] = v.value;
      } else {
        plain[k] = v;
      }
    }
    env = plain;
  } catch (err) {
    log("run.secrets_failed", { reqId, pid, message: err.message });
    return res.status(500).json({ success: false, error: "Failed to load secrets" });
  }

  // ── Build request object for the page ────────────────────────────
  const reqObj = {
    route,
    method: req.method,
    headers: {
      "content-type": req.headers["content-type"] || "",
      "user-agent": (req.headers["user-agent"] || "").slice(0, 200),
    },
    body: typeof req.body === "object" && req.body !== null ? req.body : {},
    pid,
    projectName: ctx.project.name || null,
    deployedAt: ctx.deployment?.deployedAt || null,
    deploymentId: ctx.deployment?.deploymentId || null,
    versionId: ctx.deployment?.versionId || null,
    gitCommit: ctx.deployment?.gitCommit || null,
    deploymentUrl: ctx.deployment?.url || null,
    apiFileCount: (ctx.apiRoutes?.user?.length || 0) + (ctx.apiRoutes?.system?.length || 0),
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

  // ── Build HTML ───────────────────────────────────────────────────
  const files = {
    files: ctx.publicFiles?.files || [],
    count: ctx.publicFiles?.count || 0,
    totalBytes: ctx.publicFiles?.totalBytes || 0,
  };

  const html = buildPageHtml({
    userCode,
    env,
    files,
    reqObj,
  });

  // ── Check body size ──────────────────────────────────────────────
  const bodyBytes = JSON.stringify(reqObj.body).length;
  if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
    return res.status(413).json({
      success: false,
      error: `Request body exceeds ${MAX_REQUEST_BODY_BYTES / 1024} KB`,
    });
  }

  // ── Launch Chromium and run ──────────────────────────────────────
  let browser = null;
  let runResult = null;

  try {
    browser = await launchBrowser();
    runResult = await runInPage(browser, {
      html,
      allowedHostsSet: declaredHostsSet,
      pid,
      actor,
      reqId,
      route,
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
  }

  const durationMs = Date.now() - startTime;

  // ── Handle runtime failure ───────────────────────────────────────
  if (!runResult.ok) {
    const status = runResult.isTimeout ? 504 : 500;
    const message = runResult.isTimeout ? "Function timed out" : "Function threw an error";

    await db.ref(`projects/${pid}/apiLastError`).set({
      name: runResult.errorName || "Error",
      at: Date.now(),
      route,
    }).catch(() => {});

    await logProjectEvent(pid, actor.uid || null, "api", `run.${route}`, {
      status,
      durationMs,
      errorName: runResult.errorName || "Error",
      fetchHosts: runResult.fetchHosts || [],
    }).catch(() => {});

    log("run.execution_failed", { reqId, pid, route, status, durationMs, message });

    return res.status(status).json({ success: false, error: message, route });
  }

  // ── Emit response ────────────────────────────────────────────────
  const { result } = runResult;
  const responseBody = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
  const responseBytes = Buffer.byteLength(responseBody, "utf8");

  if (responseBytes > MAX_RESPONSE_BYTES) {
    await logProjectEvent(pid, actor.uid || null, "api", `run.${route}`, {
      status: 413,
      durationMs,
      bytesOut: responseBytes,
      fetchHosts: runResult.fetchHosts || [],
    }).catch(() => {});
    return res.status(413).json({ success: false, error: "Response too large" });
  }

  await logProjectEvent(pid, actor.uid || null, "api", `run.${route}`, {
    status: result.status || 200,
    durationMs,
    bytesOut: responseBytes,
    fetchHosts: runResult.fetchHosts || [],
  }).catch(() => {});

  log("run.completed", {
    reqId,
    pid,
    route,
    status: result.status,
    durationMs,
    bytesOut: responseBytes,
    fetchHosts: runResult.fetchHosts || [],
  });

  res.setHeader("Content-Type", result.contentType || "application/json");
  res.setHeader("X-Execution-Time", String(durationMs));
  res.setHeader("X-Fetch-Hosts", (runResult.fetchHosts || []).join(","));
  return res.status(result.status || 200).send(responseBody);
}

// =========================================================================
// VERCEL CONFIG
// =========================================================================

export const config = {
  runtime: "nodejs",
  // Chromium + V8 + user code needs memory
  memory: 1024,
  // 10s max on free tier
  maxDuration: 10,
};