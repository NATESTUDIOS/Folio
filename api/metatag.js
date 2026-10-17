// api/metatag.js
import crypto from "node:crypto";
import { db } from "../utils/firebase.js";
import { log, newReqId } from "../utils/log.js";
import {
  requireAuth, requireProjectRole,
  getClientIp, hashIp, sanitizeFirebasePath,
} from "../utils/users.js";

// =========================================================================
// RATE LIMITS (per-API, Final Rule #16)
// =========================================================================

const API_NAME = "metatag";

const RATE_LIMITS = {
  generate:   { max: 20, window: 60 * 60 * 1000 },
  regenerate: { max: 5,  window: 60 * 60 * 1000 },
};

async function checkRateLimit(identifier, action) {
  const config = RATE_LIMITS[action];
  if (!config) return { allowed: true };

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
    log("metatag.rate_limit_failed", { action, message: err.message });
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
// OG IMAGE GENERATION
// =========================================================================
//
// INTEGRATION POINT — replace the two stubs below with your existing
// api/flier.js internals. The playbook §7 says:
//   "Calls flier.js internal template functions."
//
// Two functions to wire:
//   buildOgSvg(project) → SVG string
//   uploadPng(svgString) → public HTTPS URL
//
// Both are marked below. Once wired, the rest of this file is complete.

const BASE_URL = process.env.BASE_URL || "https://foliostudios.vercel.app";

/**
 * Build a 1200×630 OG SVG card for a project.
 *
 * TODO: swap this with the SVG builder from api/flier.js.
 * Expected input: project = { name, description, languages, ownerId }
 * Expected output: <svg> string sized 1200x630, ready to rasterize.
 */
function buildOgSvg(project) {
  const title = escapeXml(project.name || "Untitled project");
  const desc = escapeXml((project.description || "").slice(0, 120));
  const langLine = project.languages?.breakdown
    ? Object.entries(project.languages.breakdown)
        .slice(0, 4)
        .map(([n, v]) => `${n} ${v}%`)
        .join(" · ")
    : "";

  // Placeholder SVG — replace with flier template.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#0b0e14"/>
    <text x="80" y="120" fill="#7d8590" font-family="system-ui,sans-serif" font-size="28">FOLIO</text>
    <text x="80" y="280" fill="#e6edf3" font-family="system-ui,sans-serif" font-size="72" font-weight="700">${title}</text>
    <text x="80" y="360" fill="#adbac7" font-family="system-ui,sans-serif" font-size="36">${desc}</text>
    <text x="80" y="560" fill="#7d8590" font-family="system-ui,sans-serif" font-size="24">${escapeXml(langLine)}</text>
    <text x="80" y="600" fill="#5b6470" font-family="system-ui,sans-serif" font-size="20">${escapeXml(BASE_URL.replace(/^https?:\/\//, ""))}</text>
  </svg>`;
}

function escapeXml(s) {
  return String(s ?? "").replace(/[<>&"']/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  }[c]));
}

/**
 * Upload an SVG as a rasterized PNG and return the public HTTPS URL.
 *
 * TODO: swap this with flier.js's upload path (IMAGE_UPLOAD_API).
 * Expected input: SVG string
 * Expected output: { url: string }
 *
 * Until wired, this returns null and the endpoint falls back to
 * pointing clients at the SVG directly (which most OG consumers accept).
 */
async function uploadPng(svgString, { reqId, pid } = {}) {
  // Return data-URL style fallback: the raw SVG written to a data URL.
  // Not ideal for OG (some crawlers require image/png), but functional
  // until flier integration lands.
  try {
    const b64 = Buffer.from(svgString, "utf8").toString("base64");
    return { url: `data:image/svg+xml;base64,${b64}` };
  } catch (err) {
    log("metatag.upload_stub_failed", { reqId, pid, message: err.message });
    return { url: null };
  }
}

// =========================================================================
// HANDLERS
// =========================================================================

/**
 * GET /?pid — return the cached OG image, or generate one if stale/absent.
 * Auth: optional (public; used by social crawlers and share pages).
 */
async function handleGenerate(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });

  const ip = getClientIp(req);
  if (!(await enforceRate(res, "generate", `ip_${hashIp(ip)}_${pid}`))) return;

  const projectSnap = await db.ref(`projects/${pid}`).once("value");
  if (!projectSnap.exists()) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }
  const project = projectSnap.val();

  // Cache hit?
  const ogUrl = project.metaTags?.ogImage || project.ogImageUrl || null;
  const ogUpdatedAt = project.ogImageUpdatedAt || 0;
  const projectUpdatedAt = project.updatedAt || 0;

  if (ogUrl && ogUpdatedAt >= projectUpdatedAt) {
    return res.redirect(302, ogUrl);
  }

  // Generate
  const svg = buildOgSvg(project);
  const { url } = await uploadPng(svg, { reqId, pid });

  if (!url) {
    // Fallback: serve the SVG inline. Crawlers that accept SVG will render it.
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).send(svg);
  }

  // Persist
  await db.ref(`projects/${pid}`).update({
    ogImageUrl: url,
    ogImageUpdatedAt: Date.now(),
  }).catch(err => {
    log("metatag.persist_failed", { reqId, pid, message: err.message });
  });

  return res.redirect(302, url);
}

/**
 * POST /regenerate — force regeneration. Auth: editor+.
 */
async function handleRegenerate(req, res, reqId) {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "regenerate", `uid_${user.uid}`))) return;

  const access = await requireProjectRole(req, res, pid, "editor");
  if (!access) return;

  const projectSnap = await db.ref(`projects/${pid}`).once("value");
  if (!projectSnap.exists()) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }
  const project = projectSnap.val();

  const svg = buildOgSvg(project);
  const { url } = await uploadPng(svg, { reqId, pid });

  if (!url) {
    // Return the SVG directly so the client can display it
    return res.status(200).json({
      success: true,
      url: null,
      svgPreview: svg.slice(0, 200),
      warning: "Image upload not configured (flier.js integration pending)",
    });
  }

  await db.ref(`projects/${pid}`).update({
    ogImageUrl: url,
    ogImageUpdatedAt: Date.now(),
  });

  return res.status(200).json({ success: true, url });
}

// =========================================================================
// ROUTER
// =========================================================================

export default async function handler(req, res) {
  const reqId = newReqId();
  res.setHeader("X-Request-Id", reqId);

  res.setHeader("Access-Control-Allow-Origin", BASE_URL);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = String(req.query?.action || req.body?.action || "").trim();
  const method = req.method;

  try {
    // GET /?pid=... (no action)
    if (method === "GET" && !action && req.query?.pid) {
      return await handleGenerate(req, res, reqId);
    }
    if (method === "GET" && action === "generate") {
      return await handleGenerate(req, res, reqId);
    }
    if (method === "POST" && action === "regenerate") {
      return await handleRegenerate(req, res, reqId);
    }

    return res.status(404).json({ success: false, error: `Unknown request: ${method} ${action || "(none)"}` });
  } catch (err) {
    log("metatag.unhandled_error", { reqId, action, method, message: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: "Internal error", reqId });
  }
}

export const config = { runtime: "nodejs" };