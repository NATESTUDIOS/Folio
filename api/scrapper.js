// api/scraper.js
// ═══════════════════════════════════════════════════════════════════
//  Folio — Universal Website Scanner & Page Intelligence API
//  ────────────────────────────────────────────────────────────────
//  ONE FILE. NO AUTH. NO DB (in-memory job store; swap for Redis).
//
//  LEGACY ENDPOINTS (unchanged shapes)
//    POST ?action=scrape        Full page scrape (default)
//    GET  ?action=page          Page info only
//    GET  ?action=links         Discovered links
//    GET  ?action=assets        Images, videos, fonts, documents
//    GET  ?action=scripts       JS references + inline + imports
//    GET  ?action=styles        CSS references + inline + @imports
//    GET  ?action=resource      Fetch one resource by URL
//    GET  ?action=source        HTML / text / metadata
//    POST ?action=crawl         Recursive BFS crawl
//    GET  ?action=search        Filter discovered resources
//    GET  ?action=inspect       Classify one URL
//    GET  ?action=health        Liveness
//
//  NEW SCANNER ENDPOINTS
//    POST ?action=start-scan    Create a scan job
//    GET  ?action=discover      Discover pages/resources for a job
//    GET  ?action=get-queue     Pending items
//    POST ?action=fetch-batch   Fetch next batch
//    GET  ?action=scan-status   Progress + totals
//    POST ?action=render        Browser render a URL
//    GET  ?action=network       Captured network requests
//    GET  ?action=technology    Framework detection
//    GET  ?action=structure     DOM structure extraction
//    GET  ?action=get-map       Relationship trees
//    GET  ?action=get-results   Collected files
//    POST ?action=reconstruct   Editable reconstruction
//    POST ?action=export        Build ZIP
//    POST ?action=compare       Visual comparison
//    POST ?action=rescan        Rescan selected nodes
//
//  Optional deps (auto-detected, graceful fallback):
//    - linkedom        (better DOM)
//    - robots-parser   (robots.txt)
//    - jszip           (export ZIP)
//
//  Environment:
//    SCRAPER_MAX_BYTES          per-resource cap     (default 20MB)
//    SCRAPER_TIMEOUT_MS         per-fetch timeout    (default 15000)
//    PLAYWRIGHT_BROWSER_URL     remote CDP endpoint  (enables render)
//    SCANNER_JOB_TTL_MS         job retention        (default 1h)
//    SCANNER_MAX_JOBS           concurrent jobs      (default 25)
// ═══════════════════════════════════════════════════════════════════

import net from "node:net";
import dns from "node:dns/promises";
import crypto from "node:crypto";

// ── Optional deps ──────────────────────────────────────────────────
let linkedom = null;
try { linkedom = await import("linkedom"); } catch {}

let robotsParserMod = null;
try { robotsParserMod = await import("robots-parser"); } catch {}

let JSZipMod = null;
try { JSZipMod = await import("jszip"); } catch {}

const API_VERSION = "2.0";

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const MAX_BYTES = parseInt(process.env.SCRAPER_MAX_BYTES, 10) || 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS, 10) || 15_000;
const PLAYWRIGHT_BROWSER_URL = process.env.PLAYWRIGHT_BROWSER_URL || null;
const MAX_REDIRECTS = 5;
const MAX_HEAD_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = MAX_BYTES;
const MAX_INLINE_EXTRACT = 50_000;
const MAX_INLINE_SCRIPT_BYTES = 20_000;
const MAX_CRAWL_PAGES = 50;
const MAX_CRAWL_CONCURRENCY = 8;
const MAX_RESOURCE_FETCHES = 20;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;
const POLITENESS_DELAY_MS = 250;

const SCANNER_JOB_TTL_MS = parseInt(process.env.SCANNER_JOB_TTL_MS, 10) || 60 * 60 * 1000;
const SCANNER_MAX_JOBS = parseInt(process.env.SCANNER_MAX_JOBS, 10) || 25;
const SCANNER_MAX_PAGES = 500;
const SCANNER_MAX_DEPTH = 6;
const SCANNER_BATCH_MIN = 1;
const SCANNER_BATCH_MAX = 8;
const SCANNER_BATCH_DEFAULT = 3;

const UA = "Mozilla/5.0 (compatible; FolioScanner/2.0; +https://folio.studio/bot)";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const DATA_URI_RE = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/;

// ── Classification tables ──────────────────────────────────────────

const IMAGE_EXT = new Set(["jpg","jpeg","png","gif","webp","avif","svg","bmp","ico","tif","tiff","heic","heif"]);
const VIDEO_EXT = new Set(["mp4","webm","ogv","mov","m4v","avi","mkv","flv","wmv"]);
const AUDIO_EXT = new Set(["mp3","wav","ogg","m4a","aac","flac","opus","weba"]);
const FONT_EXT  = new Set(["woff","woff2","ttf","otf","eot"]);
const DOC_EXT   = new Set(["pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp","rtf","txt","md","csv"]);
const CODE_EXT  = new Set(["js","mjs","cjs","jsx","ts","tsx","css","scss","sass","less","html","htm","xml","json","yaml","yml","map"]);
const ARCHIVE_EXT = new Set(["zip","tar","gz","tgz","bz2","xz","rar","7z"]);

const CDN_HOSTS = new Set([
  "cdn.jsdelivr.net","unpkg.com","esm.sh","cdnjs.cloudflare.com",
  "cdn.skypack.dev","ga.jspm.io","fonts.googleapis.com","fonts.gstatic.com",
  "ajax.googleapis.com","code.jquery.com","stackpath.bootstrapcdn.com",
  "maxcdn.bootstrapcdn.com","use.fontawesome.com","kit.fontawesome.com",
  "cdn.tailwindcss.com","cdn.simpleicons.org",
]);

// ═══════════════════════════════════════════════════════════════════
// RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════════

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJson(res, status, payload) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-API-Version", API_VERSION);
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload, null, 2));
}

function fail(res, status, code, message, extra = {}) {
  return sendJson(res, status, {
    success: false, apiVersion: API_VERSION,
    error: { code, message, ...extra },
  });
}

function emptyResult(url) {
  return {
    success: true,
    apiVersion: API_VERSION,
    page: {
      url, finalUrl: url, requestedUrl: url,
      status: null, contentType: null, encoding: null,
      title: null, description: null, keywords: null,
      canonicalUrl: null, lang: null, charset: null,
      baseHref: null, favicon: null,
      og: {}, twitter: {}, meta: {},
      headings: { h1: [], h2: [], h3: [] },
      byteLength: 0,
      fetchedAt: new Date().toISOString(),
      redirectChain: [],
    },
    links:     { internal: [], external: [], documents: [], mailto: [], tel: [], anchors: [], all: [] },
    assets:    { images: [], videos: [], audio: [], fonts: [], archives: [], other: [], all: [] },
    scripts:   { external: [], inline: [], imports: [], dynamic: [] },
    styles:    { external: [], inline: [], imports: [], references: [] },
    forms:     [],
    iframes:   [],
    meta:      { preload: [], prefetch: [], dnsPrefetch: [], preconnect: [] },
    source:    { html_available: false, dom_available: false, text_available: false, text: null, text_full: null, html: null },
    statistics: { links_found: 0, external_links_found: 0, images_found: 0, videos_found: 0, fonts_found: 0, scripts_found: 0, stylesheets_found: 0, forms_found: 0, iframes_found: 0, total_bytes: 0, fetch_ms: 0 },
    warnings: [],
  };
}

// ═══════════════════════════════════════════════════════════════════
// SSRF + SAFE FETCH
// ═══════════════════════════════════════════════════════════════════

function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower === "::"
      || lower.startsWith("fc") || lower.startsWith("fd")
      || lower.startsWith("fe8") || lower.startsWith("fe9")
      || lower.startsWith("fea") || lower.startsWith("feb");
  }
  return true;
}

async function validateTargetUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); }
  catch { return { ok: false, reason: "Invalid URL" }; }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    return { ok: false, reason: `Protocol ${u.protocol} not allowed` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: "Credentials in URL not allowed" };
  }
  if (!u.hostname) return { ok: false, reason: "Missing hostname" };
  let ips;
  try { ips = await dns.lookup(u.hostname, { all: true }); }
  catch (err) { return { ok: false, reason: `DNS failed: ${err.code || err.message}` }; }
  if (!ips.length) return { ok: false, reason: "No DNS records" };
  for (const { address } of ips) {
    if (isPrivateOrReservedIp(address)) {
      return { ok: false, reason: `Resolves to private/reserved IP (${address})` };
    }
  }
  return { ok: true, resolvedIps: ips.map(i => i.address) };
}

async function safeFetch(rawUrl, {
  method = "GET", headers = {}, timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_BYTES, readBody = true,
} = {}) {
  const chain = [];
  let current = rawUrl;
  let hops = 0;

  while (hops <= MAX_REDIRECTS) {
    const valid = await validateTargetUrl(current);
    if (!valid.ok) return { ok: false, error: valid.reason, url: current, chain };
    chain.push(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(current, {
        method, headers: { "User-Agent": UA, "Accept": "*/*", ...headers },
        redirect: "manual", signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, error: err.name === "AbortError" ? "Timeout" : err.message, url: current, chain };
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get("location");
      if (!loc) return { ok: false, error: "Redirect with no Location", url: current, chain };
      try { current = new URL(loc, current).toString(); }
      catch { return { ok: false, error: "Malformed redirect target", url: current, chain }; }
      hops++;
      continue;
    }

    let body = null;
    let truncated = false;
    if (readBody) {
      try {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > maxBytes) {
            truncated = true;
            chunks.push(value.slice(0, Math.max(0, maxBytes - (total - value.length))));
            try { await reader.cancel(); } catch {}
            break;
          }
          chunks.push(value);
        }
        const merged = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        body = Buffer.from(merged.buffer);
      } catch (err) {
        return { ok: false, error: `Body read failed: ${err.message}`, url: current, chain };
      }
    }

    return {
      ok: true, url: current, status: response.status, statusText: response.statusText,
      headers: response.headers, body, truncated, chain,
    };
  }
  return { ok: false, error: `Too many redirects (>${MAX_REDIRECTS})`, url: current, chain };
}

// ═══════════════════════════════════════════════════════════════════
// URL UTILITIES
// ═══════════════════════════════════════════════════════════════════

function normalizeUrl(raw, base) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) return null;
  if (/^(mailto|tel|javascript|data):/i.test(trimmed)) return null;
  try {
    const u = base ? new URL(trimmed, base) : new URL(trimmed);
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) return null;
    u.hash = "";
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
    u.hostname = u.hostname.toLowerCase();
    const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of params) u.searchParams.append(k, v);
    return u.toString();
  } catch { return null; }
}

function getExt(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").pop() || "";
    const dot = seg.lastIndexOf(".");
    return dot >= 0 ? seg.slice(dot + 1).toLowerCase() : "";
  } catch { return ""; }
}

function classifyUrl(url, { pageOrigin = null } = {}) {
  let u;
  try { u = new URL(url); } catch { return { kind: "unknown", category: "other" }; }
  const ext = getExt(url);
  const host = u.hostname.toLowerCase();
  const isCdn = CDN_HOSTS.has(host);
  const isExternal = pageOrigin ? u.origin !== pageOrigin : false;

  let category = "page";
  if (IMAGE_EXT.has(ext)) category = "image";
  else if (VIDEO_EXT.has(ext)) category = "video";
  else if (AUDIO_EXT.has(ext)) category = "audio";
  else if (FONT_EXT.has(ext)) category = "font";
  else if (DOC_EXT.has(ext)) category = "document";
  else if (ARCHIVE_EXT.has(ext)) category = "archive";
  else if (ext === "js" || ext === "mjs" || ext === "cjs") category = "script";
  else if (ext === "css") category = "style";
  else if (ext === "json" || ext === "xml" || ext === "yaml" || ext === "yml") category = "data";
  else if (ext === "html" || ext === "htm" || !ext) category = "page";

  return { kind: category, category, ext, host, isExternal, isCdn };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ═══════════════════════════════════════════════════════════════════
// HTML EXTRACTION
// ═══════════════════════════════════════════════════════════════════

function extractAttr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = tag.match(re);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function extractWithRegex(html, pageUrl) {
  const meta = {};
  const metaTagRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaTagRe.exec(html)) !== null) {
    const name = extractAttr(m[0], "name") || extractAttr(m[0], "property");
    const content = extractAttr(m[0], "content");
    if (name && content != null) meta[name.toLowerCase()] = decodeEntities(content);
  }

  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descM  = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
              || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const canonM = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i);
  const baseM  = html.match(/<base[^>]+href=["']([^"']*)["']/i);
  const langM  = html.match(/<html[^>]+lang=["']([^"']*)["']/i);
  const iconM  = html.match(/<link[^>]+rel=["'](?:shortcut\s+)?icon["'][^>]+href=["']([^"']*)["']/i);

  const headings = { h1: [], h2: [], h3: [] };
  for (const lvl of ["h1", "h2", "h3"]) {
    const re = new RegExp(`<${lvl}\\b[^>]*>([\\s\\S]*?)<\\/${lvl}>`, "gi");
    let h;
    while ((h = re.exec(html)) !== null) {
      const txt = decodeEntities(h[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      if (txt) headings[lvl].push(txt.slice(0, 500));
      if (headings[lvl].length >= 50) break;
    }
  }

  const links = [];
  const linkRe = /<a\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const href = extractAttr(m[0], "href");
    const rel = extractAttr(m[0], "rel");
    if (href) links.push({ href, rel, text: "" });
  }

  const assets = { img: [], video: [], audio: [], source: [], iframe: [] };
  for (const tag of ["img", "video", "audio", "source", "iframe"]) {
    const re = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    while ((m = re.exec(html)) !== null) {
      const src = extractAttr(m[0], "src");
      const srcset = extractAttr(m[0], "srcset");
      const dataSrc = extractAttr(m[0], "data-src");
      const dataSrcset = extractAttr(m[0], "data-srcset");
      const alt = extractAttr(m[0], "alt");
      assets[tag]?.push({ src, srcset, dataSrc, dataSrcset, alt });
    }
  }

  const scripts = { src: [], inline: [] };
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  while ((m = scriptRe.exec(html)) !== null) {
    const attrs = m[1] || "";
    const src = extractAttr(`<script ${attrs}>`, "src");
    const type = extractAttr(`<script ${attrs}>`, "type");
    const body = m[2] || "";
    if (src) scripts.src.push({ src, type, async: /\basync\b/i.test(attrs), defer: /\bdefer\b/i.test(attrs), module: /type\s*=\s*["']module["']/i.test(attrs) });
    else if (body.trim()) scripts.inline.push({ type, body });
  }

  const styles = { link: [], inline: [] };
  const linkCssRe = /<link\b[^>]*>/gi;
  while ((m = linkCssRe.exec(html)) !== null) {
    if (/\brel\s*=\s*["'][^"']*stylesheet/i.test(m[0])) {
      styles.link.push({ href: extractAttr(m[0], "href"), media: extractAttr(m[0], "media") });
    }
  }
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleRe.exec(html)) !== null) styles.inline.push(m[1] || "");

  const forms = [];
  const formRe = /<form\b[^>]*>/gi;
  while ((m = formRe.exec(html)) !== null) {
    forms.push({
      action: extractAttr(m[0], "action"),
      method: (extractAttr(m[0], "method") || "get").toLowerCase(),
      enctype: extractAttr(m[0], "enctype"),
    });
  }

  const preload = [], prefetch = [], dnsPrefetch = [], preconnect = [];
  const linkRe2 = /<link\b[^>]*>/gi;
  while ((m = linkRe2.exec(html)) !== null) {
    const rel = (extractAttr(m[0], "rel") || "").toLowerCase();
    const href = extractAttr(m[0], "href");
    if (!href) continue;
    if (rel.includes("preload")) preload.push({ href, as: extractAttr(m[0], "as") });
    else if (rel.includes("prefetch")) prefetch.push({ href });
    else if (rel.includes("dns-prefetch")) dnsPrefetch.push({ href });
    else if (rel.includes("preconnect")) preconnect.push({ href });
  }

  return {
    title: titleM ? decodeEntities(titleM[1]).trim() : null,
    description: descM ? decodeEntities(descM[1]).trim() : null,
    canonicalUrl: canonM ? canonM[1] : null,
    baseHref: baseM ? baseM[1] : null,
    lang: langM ? langM[1] : null,
    favicon: iconM ? iconM[1] : null,
    og: Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith("og:"))),
    twitter: Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith("twitter:"))),
    meta, headings, links, assets, scripts, styles, forms,
    metaTags: { preload, prefetch, dnsPrefetch, preconnect },
  };
}

function extractWithLinkedom(html, pageUrl) {
  const { parseHTML } = linkedom;
  const { document } = parseHTML(html);
  const baseHref = document.querySelector("base[href]")?.getAttribute("href") || null;

  const meta = {};
  for (const el of document.querySelectorAll("meta")) {
    const key = (el.getAttribute("name") || el.getAttribute("property") || "").toLowerCase();
    const content = el.getAttribute("content");
    if (key && content != null) meta[key] = content;
  }

  const headings = { h1: [], h2: [], h3: [] };
  for (const lvl of ["h1", "h2", "h3"]) {
    headings[lvl] = Array.from(document.querySelectorAll(lvl))
      .map(el => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean).slice(0, 50);
  }

  const links = Array.from(document.querySelectorAll("a[href]")).map(a => ({
    href: a.getAttribute("href"),
    rel: a.getAttribute("rel"),
    text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
  }));

  const assets = { img: [], video: [], audio: [], source: [], iframe: [] };
  for (const tag of ["img", "video", "audio", "source", "iframe"]) {
    assets[tag] = Array.from(document.querySelectorAll(tag)).map(el => ({
      src: el.getAttribute("src"),
      srcset: el.getAttribute("srcset"),
      dataSrc: el.getAttribute("data-src"),
      dataSrcset: el.getAttribute("data-srcset"),
      alt: el.getAttribute("alt"),
    }));
  }

  const scripts = { src: [], inline: [] };
  for (const el of document.querySelectorAll("script")) {
    const src = el.getAttribute("src");
    const type = el.getAttribute("type");
    if (src) {
      scripts.src.push({ src, type, async: el.hasAttribute("async"), defer: el.hasAttribute("defer"), module: /module/i.test(type || "") });
    } else if (el.textContent?.trim()) {
      scripts.inline.push({ type, body: el.textContent });
    }
  }

  const styles = { link: [], inline: [] };
  for (const el of document.querySelectorAll('link[rel~="stylesheet"]')) {
    styles.link.push({ href: el.getAttribute("href"), media: el.getAttribute("media") });
  }
  for (const el of document.querySelectorAll("style")) styles.inline.push(el.textContent || "");

  const forms = Array.from(document.querySelectorAll("form")).map(f => ({
    action: f.getAttribute("action"),
    method: (f.getAttribute("method") || "get").toLowerCase(),
    enctype: f.getAttribute("enctype"),
  }));

  const metaTags = { preload: [], prefetch: [], dnsPrefetch: [], preconnect: [] };
  for (const el of document.querySelectorAll("link[rel]")) {
    const rel = (el.getAttribute("rel") || "").toLowerCase();
    const href = el.getAttribute("href");
    if (!href) continue;
    if (rel.includes("preload")) metaTags.preload.push({ href, as: el.getAttribute("as") });
    else if (rel.includes("prefetch")) metaTags.prefetch.push({ href });
    else if (rel.includes("dns-prefetch")) metaTags.dnsPrefetch.push({ href });
    else if (rel.includes("preconnect")) metaTags.preconnect.push({ href });
  }

  return {
    title: document.querySelector("title")?.textContent?.trim() || null,
    description: meta.description || null,
    canonicalUrl: document.querySelector('link[rel="canonical"]')?.getAttribute("href") || null,
    baseHref,
    lang: document.documentElement?.getAttribute("lang") || null,
    favicon: document.querySelector('link[rel~="icon"]')?.getAttribute("href") || null,
    og: Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith("og:"))),
    twitter: Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith("twitter:"))),
    meta, headings, links, assets, scripts, styles, forms,
    metaTags,
  };
}

function extractPage(html, pageUrl) {
  if (linkedom?.parseHTML) {
    try { return { parser: "linkedom", ...extractWithLinkedom(html, pageUrl) }; }
    catch {}
  }
  return { parser: "regex", ...extractWithRegex(html, pageUrl) };
}

function parseSrcset(srcset) {
  if (!srcset) return [];
  return String(srcset).split(",").map(part => {
    const bits = part.trim().split(/\s+/);
    return { url: bits[0], descriptor: bits[1] || null };
  }).filter(x => x.url);
}

function parseCssUrls(css, cssBaseUrl) {
  const out = new Set();
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m;
  while ((m = re.exec(css)) !== null) {
    const abs = normalizeUrl(m[2], cssBaseUrl);
    if (abs) out.add(abs);
  }
  return [...out];
}

function parseCssImports(css, cssBaseUrl) {
  const out = new Set();
  const re = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?/gi;
  let m;
  while ((m = re.exec(css)) !== null) {
    const abs = normalizeUrl(m[2], cssBaseUrl);
    if (abs) out.add(abs);
  }
  return [...out];
}

function parseJsImports(js, jsBaseUrl) {
  const staticImports = new Set();
  const dynamicImports = new Set();
  const staticRe = /(?:^|[\s;}])(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+)(['"])([^'"]+)\1/g;
  let m;
  while ((m = staticRe.exec(js)) !== null) {
    const abs = normalizeUrl(m[2], jsBaseUrl);
    if (abs) staticImports.add(abs);
    else if (m[2].startsWith(".")) staticImports.add(m[2]);
  }
  const dynamicRe = /import\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((m = dynamicRe.exec(js)) !== null) {
    const abs = normalizeUrl(m[2], jsBaseUrl);
    if (abs) dynamicImports.add(abs);
    else if (m[2].startsWith(".")) dynamicImports.add(m[2]);
  }
  return {
    static: [...staticImports],
    dynamic: [...dynamicImports],
    confidence: "low",
    note: "Static regex extraction — computed imports not detected",
  };
}

const TEXT_STRIP_TAGS = ["script","style","noscript","nav","footer","header","aside","iframe","svg","form","button"];
function extractReadableText(html) {
  let s = String(html);
  for (const tag of TEXT_STRIP_TAGS) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// ═══════════════════════════════════════════════════════════════════
// RESOURCE FETCHING
// ═══════════════════════════════════════════════════════════════════

async function fetchResource(url, { maxBytes = MAX_BINARY_BYTES, readBody = true } = {}) {
  const started = Date.now();
  const res = await safeFetch(url, { maxBytes, readBody });
  if (!res.ok) {
    return { url, ok: false, error: res.error, status: null, ms: Date.now() - started };
  }
  const contentType = res.headers.get("content-type") || "";
  const result = {
    url: res.url, ok: true, status: res.status, contentType,
    contentLength: res.headers.get("content-length"),
    truncated: res.truncated, ms: Date.now() - started,
    body: null, text: null, base64: null,
  };
  if (readBody && res.body) {
    const isText = /^text\/|json|xml|javascript|css|svg|html/i.test(contentType);
    if (isText) {
      result.text = res.body.toString("utf8");
      result.body = res.body;
    } else {
      result.base64 = res.body.toString("base64");
      result.body = res.body;
    }
    result.byteLength = res.body.length;
  }
  return result;
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (err) { results[i] = { error: err.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE
// ═══════════════════════════════════════════════════════════════════

const CACHE = new Map();
function cacheKey(url, opts) {
  const sig = JSON.stringify({ u: url, extract: (opts.extract || []).slice().sort(), render: !!opts.render, includeContent: !!opts.include_content });
  return crypto.createHash("sha256").update(sig).digest("hex").slice(0, 32);
}
function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) { CACHE.delete(key); return null; }
  return e.value;
}
function cacheSet(key, value) {
  if (CACHE.size >= CACHE_MAX) {
    const first = CACHE.keys().next().value;
    if (first) CACHE.delete(first);
  }
  CACHE.set(key, { value, at: Date.now() });
}

// ═══════════════════════════════════════════════════════════════════
// CORE SCRAPE
// ═══════════════════════════════════════════════════════════════════

async function scrapeOnce(rawUrl, options = {}) {
  const started = Date.now();
  const result = emptyResult(rawUrl);
  result.page.fetchedAt = new Date(started).toISOString();

  const opts = {
    render: false,
    extract: ["metadata","links","assets","scripts","styles","forms","meta","text"],
    include_content: false,
    include_text_full: false,
    resolve_urls: true,
    fetch_resource_contents: false,
    resource_fetch_limit: 5,
    max_bytes: MAX_HTML_BYTES,
    timeout_ms: FETCH_TIMEOUT_MS,
    ...options,
  };
  const extractSet = new Set(opts.extract);

  const fetched = await safeFetch(rawUrl, {
    maxBytes: opts.max_bytes, timeoutMs: opts.timeout_ms,
    headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  });
  if (!fetched.ok) return { ok: false, error: fetched.error, chain: fetched.chain, result };

  result.page.status = fetched.status;
  result.page.finalUrl = fetched.url;
  result.page.url = rawUrl;
  result.page.redirectChain = fetched.chain;
  result.page.contentType = fetched.headers.get("content-type");
  const charsetM = (fetched.headers.get("content-type") || "").match(/charset=([^;\s]+)/i);
  result.page.charset = charsetM ? charsetM[1] : null;

  const html = fetched.body ? fetched.body.toString("utf8") : "";
  result.page.byteLength = html.length;
  if (fetched.truncated) result.warnings.push("Response body truncated to size cap");

  if (!/html|xml/i.test(result.page.contentType || "")) {
    result.warnings.push(`Non-HTML content-type: ${result.page.contentType}`);
    if (extractSet.has("text") || opts.include_content) {
      result.source.text_available = true;
      result.source.text = html.slice(0, MAX_INLINE_EXTRACT);
    }
    if (opts.include_content || extractSet.has("html")) {
      result.source.html_available = true;
      result.source.html = html;
    }
    result.statistics.fetch_ms = Date.now() - started;
    return { ok: true, result };
  }

  const parsed = extractPage(html, fetched.url);
  result.parser = parsed.parser;

  let effectiveBase = fetched.url;
  if (opts.resolve_urls && parsed.baseHref) {
    const resolvedBase = normalizeUrl(parsed.baseHref, fetched.url);
    if (resolvedBase) effectiveBase = resolvedBase;
  }
  result.page.baseHref = effectiveBase !== fetched.url ? effectiveBase : null;

  result.page.title = parsed.title;
  result.page.description = parsed.description;
  result.page.keywords = parsed.meta.keywords || null;
  result.page.canonicalUrl = parsed.canonicalUrl ? normalizeUrl(parsed.canonicalUrl, effectiveBase) : null;
  result.page.lang = parsed.lang;
  result.page.favicon = parsed.favicon ? normalizeUrl(parsed.favicon, effectiveBase) : null;
  result.page.og = parsed.og;
  result.page.twitter = parsed.twitter;
  result.page.meta = parsed.meta;
  result.page.headings = parsed.headings;

  const pageOrigin = (() => { try { return new URL(fetched.url).origin; } catch { return null; } })();

  if (extractSet.has("links")) {
    const seen = new Set();
    const push = (bucket, url, source) => {
      if (!seen.has(url)) { seen.add(url); result.links.all.push({ url, kind: bucket, source }); }
      result.links[bucket].push({ url, source });
    };
    for (const l of parsed.links) {
      if (!l.href) continue;
      if (/^mailto:/i.test(l.href)) { result.links.mailto.push({ url: l.href, text: l.text }); continue; }
      if (/^tel:/i.test(l.href))    { result.links.tel.push({ url: l.href, text: l.text }); continue; }
      if (l.href.startsWith("#")) { result.links.anchors.push({ anchor: l.href, text: l.text }); continue; }
      const abs = opts.resolve_urls ? normalizeUrl(l.href, effectiveBase) : l.href;
      if (!abs) continue;
      const cls = classifyUrl(abs, { pageOrigin });
      const bucket = cls.isExternal ? "external" : (cls.category === "document" ? "documents" : "internal");
      push(bucket, abs, "a[href]");
    }
  }

  if (extractSet.has("assets")) {
    const add = (list, entry) => list.push(entry);
    for (const img of parsed.assets.img || []) {
      const candidates = new Set();
      if (img.src) candidates.add(img.src);
      if (img.dataSrc) candidates.add(img.dataSrc);
      for (const c of parseSrcset(img.srcset)) candidates.add(c.url);
      for (const c of parseSrcset(img.dataSrcset)) candidates.add(c.url);
      for (const c of candidates) {
        const abs = opts.resolve_urls ? normalizeUrl(c, effectiveBase) : c;
        if (!abs) continue;
        add(result.assets.images, { url: abs, alt: img.alt || null, source: "img" });
      }
    }
    for (const v of parsed.assets.video || []) {
      if (v.src) { const abs = normalizeUrl(v.src, effectiveBase); if (abs) add(result.assets.videos, { url: abs, source: "video" }); }
    }
    for (const a of parsed.assets.audio || []) {
      if (a.src) { const abs = normalizeUrl(a.src, effectiveBase); if (abs) add(result.assets.audio, { url: abs, source: "audio" }); }
    }
    for (const s of parsed.assets.source || []) {
      const abs = s.src ? normalizeUrl(s.src, effectiveBase) : null;
      if (!abs) continue;
      const cls = classifyUrl(abs);
      if (cls.category === "video") add(result.assets.videos, { url: abs, source: "source" });
      else if (cls.category === "audio") add(result.assets.audio, { url: abs, source: "source" });
      else if (cls.category === "image") add(result.assets.images, { url: abs, source: "source" });
    }
    for (const f of parsed.assets.iframe || []) {
      if (f.src) { const abs = normalizeUrl(f.src, effectiveBase); if (abs) result.iframes.push({ url: abs, source: "iframe" }); }
    }
  }

  const scriptsToFetch = [];
  if (extractSet.has("scripts")) {
    for (const s of parsed.scripts.src || []) {
      const abs = normalizeUrl(s.src, effectiveBase);
      if (!abs) continue;
      result.scripts.external.push({ url: abs, async: s.async, defer: s.defer, module: s.module, type: s.type || null });
      scriptsToFetch.push(abs);
    }
    for (const s of parsed.scripts.inline || []) {
      const body = String(s.body || "");
      const entry = {
        type: s.type || null, byteLength: body.length,
        body: body.length <= MAX_INLINE_SCRIPT_BYTES ? body : body.slice(0, MAX_INLINE_SCRIPT_BYTES) + "…[truncated]",
        truncated: body.length > MAX_INLINE_SCRIPT_BYTES,
      };
      result.scripts.inline.push(entry);
      const imports = parseJsImports(body, effectiveBase);
      for (const i of imports.static) result.scripts.imports.push({ url: i, from: "inline", confidence: "low" });
      for (const d of imports.dynamic) result.scripts.dynamic.push({ url: d, from: "inline", confidence: "low" });
    }
  }

  const stylesToFetch = [];
  if (extractSet.has("styles")) {
    for (const l of parsed.styles.link || []) {
      const abs = normalizeUrl(l.href, effectiveBase);
      if (!abs) continue;
      result.styles.external.push({ url: abs, media: l.media || null });
      stylesToFetch.push(abs);
    }
    for (const css of parsed.styles.inline || []) {
      const refs = parseCssUrls(css, effectiveBase);
      const imps = parseCssImports(css, effectiveBase);
      result.styles.inline.push({ byteLength: css.length, body: css.length <= MAX_INLINE_EXTRACT ? css : css.slice(0, MAX_INLINE_EXTRACT) + "…[truncated]" });
      for (const r of refs) result.styles.references.push({ url: r, from: "inline" });
      for (const i of imps) result.styles.imports.push({ url: i, from: "inline" });
    }
  }

  if (extractSet.has("forms") && parsed.forms) {
    for (const f of parsed.forms) {
      result.forms.push({
        action: f.action ? normalizeUrl(f.action, effectiveBase) : null,
        method: f.method, enctype: f.enctype || null,
      });
    }
  }

  if (extractSet.has("meta") && parsed.metaTags) {
    for (const p of parsed.metaTags.preload) result.meta.preload.push({ ...p, url: normalizeUrl(p.href, effectiveBase) });
    for (const p of parsed.metaTags.prefetch) result.meta.prefetch.push({ url: normalizeUrl(p.href, effectiveBase) });
    for (const p of parsed.metaTags.dnsPrefetch) result.meta.dnsPrefetch.push({ url: normalizeUrl(p.href, effectiveBase) });
    for (const p of parsed.metaTags.preconnect) result.meta.preconnect.push({ url: normalizeUrl(p.href, effectiveBase) });
  }

  if (extractSet.has("text") || opts.include_text_full) {
    const text = extractReadableText(html);
    result.source.text_available = true;
    result.source.text = text.slice(0, MAX_INLINE_EXTRACT);
    if (opts.include_text_full) result.source.text_full = text;
  }

  if (extractSet.has("html") || opts.include_content === "html") {
    result.source.html_available = true;
    result.source.html = html;
  }

  const contentsToFetch = [];
  if (opts.fetch_resource_contents || opts.include_content === "scripts" || opts.include_content === "styles" || opts.include_content === "all") {
    const includeScripts = opts.include_content === "scripts" || opts.include_content === "all" || opts.fetch_resource_contents;
    const includeStyles  = opts.include_content === "styles" || opts.include_content === "all" || opts.fetch_resource_contents;
    if (includeScripts) for (const s of scriptsToFetch.slice(0, opts.resource_fetch_limit)) contentsToFetch.push({ kind: "script", url: s });
    if (includeStyles)  for (const s of stylesToFetch.slice(0, opts.resource_fetch_limit)) contentsToFetch.push({ kind: "style", url: s });
  }

  if (contentsToFetch.length) {
    const fetchedResources = await pool(contentsToFetch, 6, async ({ kind, url }) => {
      const r = await fetchResource(url, { maxBytes: MAX_TEXT_BYTES });
      return { kind, ...r };
    });
    for (const r of fetchedResources) {
      if (!r || !r.ok) continue;
      const text = r.text || "";
      if (r.kind === "script") {
        const target = result.scripts.external.find(s => s.url === r.url);
        if (target) {
          target.byteLength = text.length;
          target.body = text.length <= MAX_TEXT_BYTES ? text : text.slice(0, MAX_TEXT_BYTES) + "…[truncated]";
          target.fetchMs = r.ms;
        }
        const imports = parseJsImports(text, r.url);
        for (const i of imports.static) result.scripts.imports.push({ url: i, from: r.url, confidence: "low" });
        for (const d of imports.dynamic) result.scripts.dynamic.push({ url: d, from: r.url, confidence: "low" });
      } else if (r.kind === "style") {
        const target = result.styles.external.find(s => s.url === r.url);
        if (target) {
          target.byteLength = text.length;
          target.body = text.length <= MAX_TEXT_BYTES ? text : text.slice(0, MAX_TEXT_BYTES) + "…[truncated]";
          target.fetchMs = r.ms;
        }
        const refs = parseCssUrls(text, r.url);
        const imps = parseCssImports(text, r.url);
        for (const u of refs) result.styles.references.push({ url: u, from: r.url });
        for (const u of imps) result.styles.imports.push({ url: u, from: r.url });
      }
    }
  }

  if (result.assets && extractSet.has("assets")) {
    const seen = new Set();
    const push = (bucket, entry) => {
      if (!entry.url || seen.has(entry.url)) return;
      seen.add(entry.url);
      bucket.push(entry);
      const cls = classifyUrl(entry.url, { pageOrigin });
      result.assets.all.push({ ...entry, category: cls.category });
    };
    const imgs = result.assets.images; result.assets.images = [];
    for (const i of imgs) push(result.assets.images, i);
    const vids = result.assets.videos; result.assets.videos = [];
    for (const v of vids) push(result.assets.videos, v);
    const auds = result.assets.audio; result.assets.audio = [];
    for (const a of auds) push(result.assets.audio, a);
  }

  result.statistics = {
    links_found: result.links.internal.length + result.links.external.length + result.links.documents.length,
    external_links_found: result.links.external.length,
    images_found: result.assets.images.length,
    videos_found: result.assets.videos.length,
    fonts_found: result.styles.references.filter(r => FONT_EXT.has(getExt(r.url))).length,
    scripts_found: result.scripts.external.length + result.scripts.inline.length,
    stylesheets_found: result.styles.external.length + result.styles.inline.length,
    forms_found: result.forms.length,
    iframes_found: result.iframes.length,
    total_bytes: result.page.byteLength,
    fetch_ms: Date.now() - started,
  };

  if (opts.render && !PLAYWRIGHT_BROWSER_URL) {
    result.warnings.push("render:true requested but no PLAYWRIGHT_BROWSER_URL configured — returned static HTML only");
  }

  return { ok: true, result };
}

// ═══════════════════════════════════════════════════════════════════
// ROBOTS
// ═══════════════════════════════════════════════════════════════════

const robotsCache = new Map();
async function getRobots(origin) {
  if (robotsCache.has(origin)) {
    const e = robotsCache.get(origin);
    if (Date.now() - e.at < 60 * 60 * 1000) return e.parser;
  }
  try {
    const res = await safeFetch(`${origin}/robots.txt`, { maxBytes: 200 * 1024, timeoutMs: 5000 });
    if (!res.ok || res.status !== 200 || !res.body) {
      robotsCache.set(origin, { parser: null, at: Date.now() });
      return null;
    }
    const txt = res.body.toString("utf8");
    let parser = null;
    if (robotsParserMod?.default || robotsParserMod) {
      const fn = robotsParserMod.default || robotsParserMod;
      parser = fn(`${origin}/robots.txt`, txt);
    }
    robotsCache.set(origin, { parser, at: Date.now() });
    return parser;
  } catch {
    robotsCache.set(origin, { parser: null, at: Date.now() });
    return null;
  }
}
async function isAllowedByRobots(url) {
  let origin;
  try { origin = new URL(url).origin; } catch { return true; }
  const parser = await getRobots(origin);
  if (!parser) return true;
  try { return parser.isAllowed(url, UA) !== false; }
  catch { return true; }
}

// ═══════════════════════════════════════════════════════════════════
// LEGACY CRAWL
// ═══════════════════════════════════════════════════════════════════

async function crawl(startUrl, options = {}) {
  const opts = {
    depth: 1, max_pages: 10, max_concurrency: 4,
    same_origin_only: true, respect_robots: true,
    extract: ["metadata","links","assets","scripts","styles"],
    include_content: false, ...options,
  };
  const maxPages = Math.min(Math.max(1, opts.max_pages), MAX_CRAWL_PAGES);
  const maxDepth = Math.max(0, Math.min(opts.depth, 5));
  const startOrigin = (() => { try { return new URL(startUrl).origin; } catch { return null; } })();

  const visited = new Set();
  const queued = new Set([startUrl]);
  const pages = [];
  const failures = [];
  const queue = [{ url: startUrl, depth: 0 }];

  const perHostLast = new Map();
  async function politeWait(url) {
    const host = (() => { try { return new URL(url).host; } catch { return "unknown"; } })();
    const last = perHostLast.get(host) || 0;
    const wait = Math.max(0, POLITENESS_DELAY_MS - (Date.now() - last));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    perHostLast.set(host, Date.now());
  }

  async function processOne({ url, depth }) {
    if (visited.size >= maxPages) return null;
    if (visited.has(url)) return null;
    visited.add(url);
    if (opts.respect_robots && !(await isAllowedByRobots(url))) {
      failures.push({ url, reason: "blocked_by_robots" });
      return null;
    }
    await politeWait(url);
    const r = await scrapeOnce(url, { extract: opts.extract, include_content: opts.include_content, resolve_urls: true });
    if (!r.ok) { failures.push({ url, reason: r.error }); return null; }
    const pageResult = {
      url, depth,
      finalUrl: r.result.page.finalUrl,
      status: r.result.page.status,
      title: r.result.page.title,
      links: r.result.links,
      stats: r.result.statistics,
    };
    if (depth < maxDepth) {
      const candidates = [...r.result.links.internal, ...r.result.links.external].map(l => l.url).filter(u => {
        if (!u) return false;
        if (opts.same_origin_only && startOrigin) {
          try { if (new URL(u).origin !== startOrigin) return false; } catch { return false; }
        }
        if (visited.has(u) || queued.has(u)) return false;
        return true;
      });
      for (const c of candidates) {
        if (visited.size + queued.size >= maxPages * 3) break;
        queued.add(c);
        queue.push({ url: c, depth: depth + 1 });
      }
    }
    return pageResult;
  }

  while (queue.length && pages.length + failures.length < maxPages) {
    const batch = [];
    while (batch.length < opts.max_concurrency && queue.length) batch.push(queue.shift());
    if (!batch.length) break;
    const results = await Promise.all(batch.map(processOne));
    for (const r of results) if (r) pages.push(r);
  }
  return { startUrl, depth: maxDepth, max_pages: maxPages, pages_fetched: pages.length, pages, failures };
}

// ═══════════════════════════════════════════════════════════════════
// SCANNER JOB STORE (in-memory, replace with Redis in prod)
// ═══════════════════════════════════════════════════════════════════

const JOBS = new Map();

class ScanJob {
  constructor(id, startUrl, options) {
    this.id = id;
    this.startUrl = startUrl;
    this.startOrigin = (() => { try { return new URL(startUrl).origin; } catch { return null; } })();
    this.options = options;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.status = "created"; // created | discovering | queued | fetching | paused | completed | failed

    // Nodes
    this.nodes = new Map();        // url -> NodeRecord
    this.byParent = new Map();     // parentUrl -> Set<childUrl>
    this.queue = [];               // { url, kind, depth, parent, addedAt }
    this.completedBatches = [];    // batch summaries
    this.failures = [];
    this.renders = [];
    this.network = [];             // network request captures
    this.apis = new Map();         // apiKey -> API record
    this.technology = {};
    this.pages = {};               // url -> page result (from scrapeOnce)
    this.resources = {};           // url -> { text/base64, contentType, byteLength, hash }
    this.broken = new Set();
    this.stats = {
      discovered: 0, queued: 0, fetched: 0, failed: 0, skipped: 0,
      bytes: 0, pages: 0, scripts: 0, styles: 0, images: 0, fonts: 0,
    };

    // Options
    this.maxPages = Math.min(options.max_pages || SCANNER_MAX_PAGES, SCANNER_MAX_PAGES);
    this.maxDepth = Math.min(options.depth ?? 2, SCANNER_MAX_DEPTH);
    this.sameOriginOnly = options.same_origin_only !== false;
    this.respectRobots = options.respect_robots !== false;
    this.batchSize = Math.min(Math.max(options.batch_size || SCANNER_BATCH_DEFAULT, SCANNER_BATCH_MIN), SCANNER_BATCH_MAX);
    this.includeContent = !!options.include_content;
    this.renderPages = !!options.render;
  }

  addNode(url, { kind, depth, parent, status = "discovered" } = {}) {
    if (this.nodes.has(url)) {
      const existing = this.nodes.get(url);
      if (parent && !existing.parents.includes(parent)) existing.parents.push(parent);
      return existing;
    }
    const n = {
      id: crypto.createHash("sha256").update(url).digest("hex").slice(0, 16),
      url, kind: kind || classifyUrl(url).category,
      depth: depth ?? 0,
      parents: parent ? [parent] : [],
      children: [],
      status,
      discoveredAt: Date.now(),
      fetchedAt: null,
      statusCode: null,
      contentType: null,
      byteLength: 0,
      error: null,
      hash: null,
    };
    this.nodes.set(url, n);
    if (parent) {
      if (!this.byParent.has(parent)) this.byParent.set(parent, new Set());
      this.byParent.get(parent).add(url);
      const parentNode = this.nodes.get(parent);
      if (parentNode && !parentNode.children.includes(url)) parentNode.children.push(url);
    }
    this.stats.discovered = this.nodes.size;
    return n;
  }

  enqueue(url, { kind, depth, parent } = {}) {
    if (!url) return;
    if (this.nodes.has(url) && this.nodes.get(url).status !== "discovered") return;
    if (this.queue.some(q => q.url === url)) return;
    this.addNode(url, { kind, depth, parent, status: "queued" });
    const node = this.nodes.get(url);
    node.status = "queued";
    this.queue.push({ url, kind, depth, parent, addedAt: Date.now() });
    this.stats.queued = this.queue.length;
  }

  nextBatch(size = this.batchSize) {
    const pages = [];
    const resources = [];
    while (this.queue.length && pages.length < size) {
      const item = this.queue[0];
      const kind = item.kind || classifyUrl(item.url).category;
      if (kind === "page") pages.push(this.queue.shift());
      else if (resources.length < size) resources.push(this.queue.shift());
      else break;
    }
    return [...pages, ...resources].slice(0, size);
  }

  touch() { this.updatedAt = Date.now(); }

  snapshotTree() {
    const nodeArr = [...this.nodes.values()].map(n => ({
      ...n,
      children: n.children.slice(),
      parents: n.parents.slice(),
    }));
    const orphanPages = nodeArr.filter(n => n.kind === "page" && n.depth > 0 && n.parents.length === 0).map(n => n.url);
    const orphanResources = nodeArr.filter(n => n.kind !== "page" && n.parents.length === 0).map(n => n.url);
    return {
      nodes: nodeArr,
      pagesTree: nodeArr.filter(n => n.kind === "page"),
      resourceTree: nodeArr.filter(n => n.kind !== "page"),
      orphanPages,
      orphanResources,
      broken: [...this.broken],
    };
  }

  apiList() {
    return [...this.apis.values()];
  }
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (now - job.updatedAt > SCANNER_JOB_TTL_MS) JOBS.delete(id);
  }
  if (JOBS.size > SCANNER_MAX_JOBS) {
    const sorted = [...JOBS.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    while (JOBS.size > SCANNER_MAX_JOBS && sorted.length) {
      const [id] = sorted.shift();
      JOBS.delete(id);
    }
  }
}

function createJob(startUrl, options) {
  pruneJobs();
  const id = crypto.randomBytes(12).toString("hex");
  const job = new ScanJob(id, startUrl, options);
  JOBS.set(id, job);
  return job;
}

function getJob(id) { return JOBS.get(id) || null; }

// ═══════════════════════════════════════════════════════════════════
// SCANNER: DISCOVERY
// ═══════════════════════════════════════════════════════════════════

async function runDiscovery(job) {
  job.status = "discovering";
  job.touch();

  // Seed
  job.addNode(job.startUrl, { kind: "page", depth: 0, status: "discovered" });
  job.enqueue(job.startUrl, { kind: "page", depth: 0, parent: null });

  // Fetch start page to seed children
  if (job.respectRobots && !(await isAllowedByRobots(job.startUrl))) {
    job.failures.push({ url: job.startUrl, reason: "blocked_by_robots" });
    job.status = "failed";
    return;
  }

  const startPage = await scrapeOnce(job.startUrl, {
    extract: ["metadata", "links", "assets", "scripts", "styles", "meta"],
    include_content: job.includeContent,
  });
  if (!startPage.ok) {
    job.failures.push({ url: job.startUrl, reason: startPage.error });
    job.status = "failed";
    return;
  }
  const node = job.nodes.get(job.startUrl);
  node.status = "completed";
  node.fetchedAt = Date.now();
  node.statusCode = startPage.result.page.status;
  node.contentType = startPage.result.page.contentType;
  node.byteLength = startPage.result.page.byteLength;
  job.stats.fetched++;
  job.stats.pages++;
  job.pages[job.startUrl] = startPage.result;
  job.stats.bytes += startPage.result.page.byteLength;

  // Cache content hash
  if (startPage.result.source.html) node.hash = sha256(startPage.result.source.html);

  // Enqueue children (up to maxPages)
  const childUrls = [];
  for (const bucket of ["internal", "external"]) {
    if (bucket === "external" && job.sameOriginOnly) continue;
    for (const l of startPage.result.links[bucket] || []) {
      if (childUrls.length >= job.maxPages) break;
      if (job.sameOriginOnly && job.startOrigin) {
        try { if (new URL(l.url).origin !== job.startOrigin) continue; } catch { continue; }
      }
      childUrls.push(l.url);
    }
  }
  for (const u of childUrls) {
    if (job.nodes.has(u)) continue;
    job.enqueue(u, { kind: "page", depth: 1, parent: job.startUrl });
  }

  // Enqueue resources
  const resources = new Set();
  for (const s of startPage.result.scripts.external) resources.add(s.url);
  for (const s of startPage.result.styles.external) resources.add(s.url);
  for (const i of startPage.result.assets.images) resources.add(i.url);
  for (const v of startPage.result.assets.videos) resources.add(v.url);
  for (const a of startPage.result.assets.audio) resources.add(a.url);
  for (const s of startPage.result.styles.references) resources.add(s.url);
  for (const s of startPage.result.scripts.imports) resources.add(s.url);
  for (const r of resources) {
    if (job.nodes.has(r)) continue;
    const cls = classifyUrl(r);
    if (cls.category === "page") continue;
    job.enqueue(r, { kind: cls.category, depth: 1, parent: job.startUrl });
  }

  // Sitemap + robots best-effort discovery
  await discoverSitemap(job);

  job.status = "queued";
  job.touch();
}

async function discoverSitemap(job) {
  if (!job.startOrigin) return;
  try {
    const res = await safeFetch(`${job.startOrigin}/sitemap.xml`, { maxBytes: 2 * 1024 * 1024, timeoutMs: 5000 });
    if (!res.ok || res.status !== 200 || !res.body) return;
    const xml = res.body.toString("utf8");
    const urls = new Set();
    const re = /<loc>\s*([^<]+)\s*<\/loc>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) urls.add(decodeEntities(m[1].trim()));
    for (const u of urls) {
      if (job.nodes.size >= job.maxPages * 2) break;
      if (job.sameOriginOnly && job.startOrigin) {
        try { if (new URL(u).origin !== job.startOrigin) continue; } catch { continue; }
      }
      if (!job.nodes.has(u)) job.enqueue(u, { kind: "page", depth: 1, parent: job.startUrl });
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════
// SCANNER: BATCH FETCH
// ═══════════════════════════════════════════════════════════════════

async function fetchBatch(job, size) {
  job.status = "fetching";
  job.touch();
  const batch = job.nextBatch(size || job.batchSize);
  const results = [];

  if (!batch.length) {
    if (job.queue.length === 0) job.status = "completed";
    return { jobId: job.id, batch: [], done: job.queue.length === 0 };
  }

  for (const item of batch) {
    const node = job.nodes.get(item.url);
    if (node) node.status = "fetching";

    if (job.respectRobots && !(await isAllowedByRobots(item.url))) {
      if (node) node.status = "skipped";
      job.failures.push({ url: item.url, reason: "blocked_by_robots" });
      job.stats.skipped++;
      results.push({ url: item.url, ok: false, reason: "blocked_by_robots" });
      continue;
    }

    const kind = item.kind || classifyUrl(item.url).category;

    try {
      if (kind === "page") {
        const r = await scrapeOnce(item.url, {
          extract: ["metadata", "links", "assets", "scripts", "styles", "meta"],
          include_content: job.includeContent,
        });
        if (!r.ok) {
          if (node) { node.status = "failed"; node.error = r.error; }
          job.failures.push({ url: item.url, reason: r.error });
          job.stats.failed++;
          results.push({ url: item.url, ok: false, reason: r.error });
          continue;
        }
        if (node) {
          node.status = "completed";
          node.fetchedAt = Date.now();
          node.statusCode = r.result.page.status;
          node.contentType = r.result.page.contentType;
          node.byteLength = r.result.page.byteLength;
        }
        job.pages[item.url] = r.result;
        job.stats.fetched++;
        job.stats.pages++;
        job.stats.bytes += r.result.page.byteLength;

        // Enqueue new children
        if (node && node.depth < job.maxDepth) {
          const discovered = new Set();
          for (const bucket of ["internal", "external"]) {
            if (bucket === "external" && job.sameOriginOnly) continue;
            for (const l of r.result.links[bucket] || []) discovered.add(l.url);
          }
          for (const u of discovered) {
            if (job.nodes.size >= job.maxPages) break;
            if (job.sameOriginOnly && job.startOrigin) {
              try { if (new URL(u).origin !== job.startOrigin) continue; } catch { continue; }
            }
            if (job.nodes.has(u) || job.queue.some(q => q.url === u)) continue;
            job.enqueue(u, { kind: "page", depth: node.depth + 1, parent: item.url });
          }
          // Resources
          const res = new Set();
          for (const s of r.result.scripts.external) res.add(s.url);
          for (const s of r.result.styles.external) res.add(s.url);
          for (const i of r.result.assets.images) res.add(i.url);
          for (const v of r.result.assets.videos) res.add(v.url);
          for (const a of r.result.assets.audio) res.add(a.url);
          for (const s of r.result.styles.references) res.add(s.url);
          for (const s of r.result.scripts.imports) res.add(s.url);
          for (const u of res) {
            if (job.nodes.has(u) || job.queue.some(q => q.url === u)) continue;
            const cls = classifyUrl(u);
            if (cls.category === "page") continue;
            job.enqueue(u, { kind: cls.category, depth: node.depth + 1, parent: item.url });
          }
        }
        results.push({ url: item.url, ok: true, kind: "page", statusCode: r.result.page.status, title: r.result.page.title });

      } else {
        // Resource fetch
        const maxBytes = kind === "image" || kind === "font" ? MAX_BINARY_BYTES : MAX_TEXT_BYTES;
        const r = await fetchResource(item.url, { maxBytes });
        if (!r.ok) {
          if (node) { node.status = "failed"; node.error = r.error; }
          job.failures.push({ url: item.url, reason: r.error });
          job.stats.failed++;
          job.broken.add(item.url);
          results.push({ url: item.url, ok: false, reason: r.error });
          continue;
        }
        if (node) {
          node.status = "completed";
          node.fetchedAt = Date.now();
          node.statusCode = r.status;
          node.contentType = r.contentType;
          node.byteLength = r.byteLength || 0;
          if (r.body) node.hash = sha256(r.body);
        }
        job.resources[item.url] = {
          text: r.text, base64: r.base64, contentType: r.contentType,
          byteLength: r.byteLength || 0, hash: node?.hash, truncated: r.truncated,
        };
        job.stats.fetched++;
        job.stats.bytes += r.byteLength || 0;
        if (kind === "script") job.stats.scripts++;
        else if (kind === "style") job.stats.styles++;
        else if (kind === "image") job.stats.images++;
        else if (kind === "font") job.stats.fonts++;

        // Follow CSS / JS imports one level deeper
        if (node && node.depth < job.maxDepth) {
          if (kind === "style" && r.text) {
            for (const u of parseCssImports(r.text, item.url)) {
              if (job.nodes.has(u) || job.queue.some(q => q.url === u)) continue;
              if (job.sameOriginOnly && job.startOrigin) {
                try { if (new URL(u).origin !== job.startOrigin) continue; } catch { continue; }
              }
              job.enqueue(u, { kind: "style", depth: node.depth + 1, parent: item.url });
            }
            for (const u of parseCssUrls(r.text, item.url)) {
              if (job.nodes.has(u) || job.queue.some(q => q.url === u)) continue;
              const cls = classifyUrl(u);
              if (cls.category === "page") continue;
              if (job.sameOriginOnly && job.startOrigin) {
                try { if (new URL(u).origin !== job.startOrigin) continue; } catch { continue; }
              }
              job.enqueue(u, { kind: cls.category, depth: node.depth + 1, parent: item.url });
            }
          }
          if (kind === "script" && r.text) {
            const imp = parseJsImports(r.text, item.url);
            for (const u of [...imp.static, ...imp.dynamic]) {
              if (!u.startsWith("http")) continue;
              if (job.nodes.has(u) || job.queue.some(q => q.url === u)) continue;
              job.enqueue(u, { kind: "script", depth: node.depth + 1, parent: item.url });
            }
          }
        }
        results.push({ url: item.url, ok: true, kind, contentType: r.contentType, byteLength: r.byteLength });
      }
    } catch (err) {
      if (node) { node.status = "failed"; node.error = err.message; }
      job.failures.push({ url: item.url, reason: err.message });
      job.stats.failed++;
      results.push({ url: item.url, ok: false, reason: err.message });
    }
  }

  job.completedBatches.push({ at: Date.now(), size: batch.length, items: results });
  job.touch();

  if (!job.queue.length && job.stats.fetching === 0) {
    job.status = "completed";
  } else {
    job.status = "queued";
  }

  return {
    jobId: job.id,
    batch: results,
    remaining: job.queue.length,
    done: job.queue.length === 0 && job.status === "completed",
    stats: { ...job.stats },
  };
}

// ═══════════════════════════════════════════════════════════════════
// SCANNER: TECHNOLOGY DETECTION
// ═══════════════════════════════════════════════════════════════════

function detectTechnology(job) {
  const signals = {
    nextjs: { weight: 0, evidence: [] },
    react: { weight: 0, evidence: [] },
    vue: { weight: 0, evidence: [] },
    nuxt: { weight: 0, evidence: [] },
    angular: { weight: 0, evidence: [] },
    svelte: { weight: 0, evidence: [] },
    sveltekit: { weight: 0, evidence: [] },
    astro: { weight: 0, evidence: [] },
    wordpress: { weight: 0, evidence: [] },
    webflow: { weight: 0, evidence: [] },
    shopify: { weight: 0, evidence: [] },
    tailwind: { weight: 0, evidence: [] },
    bootstrap: { weight: 0, evidence: [] },
    jquery: { weight: 0, evidence: [] },
  };
  const add = (t, w, e) => { if (signals[t]) { signals[t].weight += w; signals[t].evidence.push(e); } };

  for (const [url, page] of Object.entries(job.pages)) {
    const html = (page.source?.html || "").slice(0, 20000) + (page.page?.meta ? JSON.stringify(page.page.meta) : "");
    const gen = page.page?.meta?.["generator"] || "";
    if (/next/i.test(gen) || /__NEXT_DATA__/.test(html)) add("nextjs", 3, `generator/meta at ${url}`);
    if (/_next\/static\//.test(JSON.stringify(page.scripts)) || /_next\//.test(html)) add("nextjs", 2, `_next path at ${url}`);
    if (/react|__REACT/i.test(html) || page.scripts.external.some(s => /react/i.test(s.url))) add("react", 2, `react signal at ${url}`);
    if (/__VUE__|data-v-|vue\.runtime/i.test(html) || page.scripts.external.some(s => /vue/i.test(s.url))) add("vue", 2, `vue signal at ${url}`);
    if (/__NUXT__|_nuxt\//i.test(html)) add("nuxt", 3, `nuxt signal at ${url}`);
    if (/ng-version|angular/i.test(html)) add("angular", 2, `angular signal at ${url}`);
    if (/svelte-|__svelte/i.test(html) || page.scripts.external.some(s => /svelte/i.test(s.url))) add("svelte", 2, `svelte signal at ${url}`);
    if (/_app\/immutable\//.test(html)) add("sveltekit", 2, `sveltekit signal at ${url}`);
    if (/astro-|data-astro/i.test(html)) add("astro", 2, `astro signal at ${url}`);
    if (/wp-content\/|wp-includes\//i.test(html)) add("wordpress", 3, `wordpress paths at ${url}`);
    if (/webflow\.(?:js|css)|data-wf-/i.test(html)) add("webflow", 3, `webflow signal at ${url}`);
    if (/cdn\.shopify\.com|shopify\.theme/i.test(html)) add("shopify", 3, `shopify signal at ${url}`);
    if (/tailwind/i.test(JSON.stringify(page.styles)) || /tailwind/i.test(html)) add("tailwind", 1, `tailwind signal at ${url}`);
    if (/bootstrap/i.test(JSON.stringify(page.styles)) || /bootstrap/i.test(html)) add("bootstrap", 1, `bootstrap signal at ${url}`);
    if (/jquery/i.test(JSON.stringify(page.scripts))) add("jquery", 1, `jquery at ${url}`);
  }

  const detected = Object.entries(signals)
    .filter(([, v]) => v.weight > 0)
    .map(([name, v]) => ({
      name,
      confidence: Math.min(1, v.weight / 5),
      weight: v.weight,
      evidence: v.evidence.slice(0, 10),
    }))
    .sort((a, b) => b.weight - a.weight);

  return {
    primary: detected[0]?.name || "plain",
    detected,
  };
}

// ═══════════════════════════════════════════════════════════════════
// SCANNER: NETWORK / API CAPTURE
// ═══════════════════════════════════════════════════════════════════

function recordNetwork(job, { url, method = "GET", resourceType, sourcePage, headers = {}, status, contentType, bodySample, trigger }) {
  if (!url) return;
  let u;
  try { u = new URL(url); } catch { return; }
  const redactedHeaders = { ...headers };
  for (const k of Object.keys(redactedHeaders)) {
    if (/authorization|cookie|x-api-key|api-key|token|secret/i.test(k)) redactedHeaders[k] = "[redacted]";
  }
  const entry = {
    url: u.toString(),
    origin: u.origin,
    pathname: u.pathname,
    method: (method || "GET").toUpperCase(),
    resourceType: resourceType || "unknown",
    sourcePage: sourcePage || null,
    trigger: trigger || "page_load",
    status: status ?? null,
    contentType: contentType || null,
    headers: redactedHeaders,
    bodySample: bodySample ? String(bodySample).slice(0, 500) : null,
    observedAt: Date.now(),
    confidence: "observed",
  };
  job.network.push(entry);
  if (job.network.length > 5000) job.network.shift();

  // Record API candidates
  const isApi = /\/api\/|\/graphql|\/v\d+\/|\.json(\?|$)/i.test(u.pathname) ||
    /application\/json/i.test(contentType || "") ||
    (resourceType || "").toLowerCase() === "xhr" ||
    (resourceType || "").toLowerCase() === "fetch";
  if (isApi) {
    const key = `${entry.method} ${entry.origin}${entry.pathname}`;
    if (!job.apis.has(key)) {
      job.apis.set(key, {
        key, url: entry.url, method: entry.method,
        occurrences: [],
        sourcePages: new Set(),
        triggers: new Set(),
        statuses: new Set(),
        contentTypes: new Set(),
        confidence: "observed",
      });
    }
    const api = job.apis.get(key);
    api.occurrences.push({ at: entry.observedAt, sourcePage: entry.sourcePage, status: entry.status });
    if (api.occurrences.length > 100) api.occurrences.shift();
    if (entry.sourcePage) api.sourcePages.add(entry.sourcePage);
    api.triggers.add(entry.trigger);
    if (entry.status != null) api.statuses.add(entry.status);
    if (entry.contentType) api.contentTypes.add(entry.contentType);
  }
}

// ═══════════════════════════════════════════════════════════════════
// PLAYWRIGHT BRIDGE (best-effort)
// ═══════════════════════════════════════════════════════════════════

async function renderWithPlaywright(url, options = {}) {
  if (!PLAYWRIGHT_BROWSER_URL) {
    return { ok: false, error: "PLAYWRIGHT_BROWSER_URL not configured" };
  }
  try {
    // Minimal CDP-style JSON protocol expected from the remote service.
    const endpoint = PLAYWRIGHT_BROWSER_URL.replace(/\/$/, "") + "/render";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        viewport: options.viewport || { width: 1440, height: 900 },
        mobile: !!options.mobile,
        fullPage: options.fullPage !== false,
        captureNetwork: options.captureNetwork !== false,
        timeoutMs: options.timeoutMs || 20000,
        scroll: options.scroll !== false,
        userAgent: UA,
      }),
    });
    if (!res.ok) return { ok: false, error: `Remote render failed: ${res.status}` };
    const data = await res.json();
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// REQUEST PARSING
// ═══════════════════════════════════════════════════════════════════

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2_000_000) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { resolve({ _raw: raw }); }
    });
    req.on("error", reject);
  });
}

function parseQuery(req) { return req.query || {}; }

function normalizeOptions(input = {}) {
  const extract = Array.isArray(input.extract)
    ? input.extract.map(s => String(s).toLowerCase())
    : typeof input.extract === "string"
      ? input.extract.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
      : ["metadata","links","assets","scripts","styles","forms","meta","text"];
  const validExtract = ["metadata","links","assets","scripts","styles","forms","meta","text","html"];
  const filtered = extract.filter(x => validExtract.includes(x));
  return {
    render: !!input.render,
    extract: filtered.length ? filtered : ["metadata","links","assets","scripts","styles"],
    include_content: input.include_content ?? input.includeContent ?? false,
    include_text_full: !!(input.include_text_full ?? input.includeTextFull),
    resolve_urls: input.resolve_urls !== false,
    fetch_resource_contents: !!(input.fetch_resource_contents ?? input.fetchResourceContents),
    resource_fetch_limit: Math.min(Number(input.resource_fetch_limit ?? input.resourceFetchLimit) || 5, MAX_RESOURCE_FETCHES),
    max_bytes: Math.min(Number(input.max_bytes ?? input.maxBytes) || MAX_HTML_BYTES, MAX_HTML_BYTES),
    timeout_ms: Math.min(Number(input.timeout_ms ?? input.timeoutMs) || FETCH_TIMEOUT_MS, 60_000),
  };
}

// ═══════════════════════════════════════════════════════════════════
// LEGACY HANDLERS (unchanged behavior)
// ═══════════════════════════════════════════════════════════════════

async function handleScrape(req, res) {
  const body = req.method === "POST" ? await readBody(req) : {};
  const q = parseQuery(req);
  const url = body.url || q.url;
  if (!url) return fail(res, 400, "MISSING_URL", "Provide ?url= or body.url");
  const opts = normalizeOptions({ ...q, ...body, ...(body.options || {}) });
  const key = cacheKey(url, opts);
  const cached = cacheGet(key);
  if (cached) return sendJson(res, 200, { ...cached, cached: true });
  const r = await scrapeOnce(url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error || "Could not fetch URL", { chain: r.chain });
  cacheSet(key, r.result);
  return sendJson(res, 200, r.result);
}

async function handlePage(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const opts = normalizeOptions({ ...q, extract: ["metadata"] });
  const r = await scrapeOnce(q.url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);
  return sendJson(res, 200, { success: true, apiVersion: API_VERSION, page: r.result.page, statistics: r.result.statistics, warnings: r.result.warnings });
}

async function handleLinks(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const opts = normalizeOptions({ ...q, extract: ["links"] });
  const r = await scrapeOnce(q.url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);
  return sendJson(res, 200, { success: true, apiVersion: API_VERSION, url: q.url, finalUrl: r.result.page.finalUrl, links: r.result.links, statistics: { links_found: r.result.statistics.links_found } });
}

async function handleAssets(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const opts = normalizeOptions({ ...q, extract: ["assets"] });
  const r = await scrapeOnce(q.url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION, url: q.url, finalUrl: r.result.page.finalUrl,
    assets: r.result.assets,
    statistics: { images_found: r.result.statistics.images_found, videos_found: r.result.statistics.videos_found, fonts_found: r.result.statistics.fonts_found },
  });
}

async function handleScripts(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const opts = normalizeOptions({
    ...q, extract: ["scripts"],
    include_content: q.include_content === "1" || q.include_content === "true" || q.include_content === "scripts" ? "scripts" : false,
    fetch_resource_contents: q.fetch_resource_contents === "1" || q.fetch_resource_contents === "true",
  });
  const r = await scrapeOnce(q.url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);
  return sendJson(res, 200, { success: true, apiVersion: API_VERSION, url: q.url, finalUrl: r.result.page.finalUrl, scripts: r.result.scripts, statistics: { scripts_found: r.result.statistics.scripts_found } });
}

async function handleStyles(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const opts = normalizeOptions({
    ...q, extract: ["styles"],
    include_content: q.include_content === "1" || q.include_content === "true" || q.include_content === "styles" ? "styles" : false,
    fetch_resource_contents: q.fetch_resource_contents === "1" || q.fetch_resource_contents === "true",
  });
  const r = await scrapeOnce(q.url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);
  return sendJson(res, 200, { success: true, apiVersion: API_VERSION, url: q.url, finalUrl: r.result.page.finalUrl, styles: r.result.styles, statistics: { stylesheets_found: r.result.statistics.stylesheets_found } });
}

async function handleResource(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const maxBytes = Math.min(Number(q.max_bytes || q.maxBytes) || MAX_BINARY_BYTES, MAX_BINARY_BYTES);
  const asBase64 = q.base64 === "1" || q.base64 === "true";
  const r = await fetchResource(q.url, { maxBytes });
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error || "Could not fetch resource");
  const cls = classifyUrl(r.url);
  const payload = {
    success: true, apiVersion: API_VERSION, url: r.url, requestedUrl: q.url,
    status: r.status, contentType: r.contentType, contentLength: r.contentLength,
    byteLength: r.byteLength, truncated: r.truncated, classification: cls.category, fetch_ms: r.ms,
  };
  if (asBase64) payload.base64 = r.base64;
  else if (r.text != null) payload.text = r.text;
  else payload.base64 = r.base64;
  return sendJson(res, 200, payload);
}

async function handleSource(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const mode = (q.mode || "html").toLowerCase();
  const r = await scrapeOnce(q.url, {
    extract: [mode === "html" ? "html" : mode === "text" ? "text" : "metadata"],
    include_content: mode === "html" ? "html" : false,
    include_text_full: mode === "text",
  });
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);
  if (mode === "html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200);
    return res.end(r.result.source.html || "");
  }
  if (mode === "text") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200);
    return res.end(r.result.source.text_full || r.result.source.text || "");
  }
  if (mode === "metadata") {
    return sendJson(res, 200, {
      success: true, apiVersion: API_VERSION, url: q.url, finalUrl: r.result.page.finalUrl,
      metadata: {
        title: r.result.page.title, description: r.result.page.description,
        keywords: r.result.page.keywords, canonicalUrl: r.result.page.canonicalUrl,
        lang: r.result.page.lang, favicon: r.result.page.favicon,
        og: r.result.page.og, twitter: r.result.page.twitter,
        headings: r.result.page.headings, meta: r.result.page.meta,
      },
    });
  }
  return fail(res, 400, "INVALID_MODE", `mode must be html|text|metadata, got ${mode}`);
}

async function handleCrawl(req, res) {
  const body = req.method === "POST" ? await readBody(req) : {};
  const q = parseQuery(req);
  const url = body.url || q.url;
  if (!url) return fail(res, 400, "MISSING_URL", "Provide ?url= or body.url");
  const opts = {
    depth: Math.min(Number(body.depth ?? q.depth) || 1, 5),
    max_pages: Math.min(Number(body.max_pages ?? q.max_pages) || 10, MAX_CRAWL_PAGES),
    max_concurrency: Math.min(Number(body.max_concurrency ?? q.max_concurrency) || 4, MAX_CRAWL_CONCURRENCY),
    same_origin_only: body.same_origin_only !== false && q.same_origin_only !== "0",
    respect_robots: body.respect_robots !== false && q.respect_robots !== "0",
    extract: ["metadata","links","assets","scripts","styles"],
    include_content: false,
  };
  const crawlResult = await crawl(url, opts);
  return sendJson(res, 200, { success: true, apiVersion: API_VERSION, ...crawlResult });
}

async function handleSearch(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  if (!q.q && !q.kind && !q.ext && !q.domain && !q.contains) {
    return fail(res, 400, "MISSING_FILTER", "Provide at least one of: q, kind, ext, domain, contains");
  }
  const opts = normalizeOptions({ ...q, extract: ["links","assets","scripts","styles"] });
  const r = await scrapeOnce(q.url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);

  const flat = [];
  for (const bucket of ["internal","external","documents"]) for (const l of r.result.links[bucket]) flat.push({ source: "link", bucket, url: l.url });
  for (const bucket of ["images","videos","audio","all"]) for (const a of r.result.assets[bucket] || []) flat.push({ source: "asset", bucket, url: a.url });
  for (const s of r.result.scripts.external) flat.push({ source: "script", url: s.url });
  for (const s of r.result.styles.external) flat.push({ source: "style", url: s.url });
  for (const s of r.result.styles.references) flat.push({ source: "style-ref", url: s.url });
  for (const s of r.result.scripts.imports) flat.push({ source: "js-import", url: s.url });

  const seen = new Set();
  const unique = flat.filter(x => { if (!x.url || seen.has(x.url)) return false; seen.add(x.url); return true; });

  const qLower = String(q.q || q.contains || "").toLowerCase();
  const kind = q.kind ? String(q.kind).toLowerCase() : null;
  const ext = q.ext ? String(q.ext).toLowerCase().replace(/^\./, "") : null;
  const domain = q.domain ? String(q.domain).toLowerCase() : null;

  const matches = unique.filter(item => {
    if (qLower && !item.url.toLowerCase().includes(qLower)) return false;
    if (kind) {
      const cls = classifyUrl(item.url);
      if (cls.category !== kind && item.source !== kind && item.bucket !== kind) return false;
    }
    if (ext && getExt(item.url) !== ext) return false;
    if (domain) {
      try { if (new URL(item.url).hostname.toLowerCase() !== domain) return false; } catch { return false; }
    }
    return true;
  });

  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION, url: q.url, finalUrl: r.result.page.finalUrl,
    total_scanned: unique.length, match_count: matches.length, matches,
  });
}

async function handleInspect(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const cls = classifyUrl(q.url, { pageOrigin: q.origin || null });
  const valid = await validateTargetUrl(q.url);
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION, url: q.url, classification: cls,
    reachable: valid.ok, reason: valid.ok ? null : valid.reason,
    resolvedIps: valid.ok ? valid.resolvedIps : [],
  });
}

async function handleHealth(req, res) {
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION, status: "ok",
    dependencies: {
      linkedom: !!linkedom?.parseHTML,
      robots_parser: !!robotsParserMod,
      jszip: !!JSZipMod?.default,
      playwright: !!PLAYWRIGHT_BROWSER_URL,
    },
    limits: {
      max_bytes: MAX_BYTES, timeout_ms: FETCH_TIMEOUT_MS,
      max_crawl_pages: MAX_CRAWL_PAGES, max_crawl_concurrency: MAX_CRAWL_CONCURRENCY,
      max_resource_fetches: MAX_RESOURCE_FETCHES,
      max_scan_pages: SCANNER_MAX_PAGES, max_scan_depth: SCANNER_MAX_DEPTH,
      scanner_job_ttl_ms: SCANNER_JOB_TTL_MS, scanner_max_jobs: SCANNER_MAX_JOBS,
    },
    jobs: { active: JOBS.size },
    endpoints: [
      "scrape","page","links","assets","scripts","styles","resource","source",
      "crawl","search","inspect","health",
      "start-scan","discover","get-queue","fetch-batch","scan-status",
      "render","network","technology","structure","get-map","get-results",
      "reconstruct","export","compare","rescan",
    ],
    timestamp: new Date().toISOString(),
  });
}

// ═══════════════════════════════════════════════════════════════════
// NEW SCANNER HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function handleStartScan(req, res) {
  const body = req.method === "POST" ? await readBody(req) : {};
  const q = parseQuery(req);
  const url = body.url || q.url;
  if (!url) return fail(res, 400, "MISSING_URL", "Provide url");

  const valid = await validateTargetUrl(url);
  if (!valid.ok) return fail(res, 400, "INVALID_URL", valid.reason);

  const options = {
    depth: Math.min(Number(body.depth ?? q.depth) || 2, SCANNER_MAX_DEPTH),
    max_pages: Math.min(Number(body.max_pages ?? q.max_pages) || 100, SCANNER_MAX_PAGES),
    batch_size: Math.min(Math.max(Number(body.batch_size ?? q.batch_size) || SCANNER_BATCH_DEFAULT, SCANNER_BATCH_MIN), SCANNER_BATCH_MAX),
    same_origin_only: body.same_origin_only !== false && q.same_origin_only !== "0",
    respect_robots: body.respect_robots !== false && q.respect_robots !== "0",
    include_content: !!(body.include_content ?? body.includeContent),
    render: !!(body.render ?? q.render),
  };

  const job = createJob(url, options);

  // Fire discovery in background (Vercel: use waitUntil if available; otherwise inline best-effort)
  const discovery = runDiscovery(job).catch(err => {
    job.failures.push({ url, reason: err.message });
    job.status = "failed";
  });
  try {
    if (typeof req.waitUntil === "function") req.waitUntil(discovery);
    else await Promise.race([discovery, new Promise(r => setTimeout(r, 9000))]);
  } catch {}

  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    jobId: job.id,
    startUrl: job.startUrl,
    status: job.status,
    options: {
      depth: job.maxDepth, max_pages: job.maxPages,
      same_origin_only: job.sameOriginOnly, respect_robots: job.respectRobots,
      batch_size: job.batchSize, render: job.renderPages,
    },
    stats: { ...job.stats },
    next: `/api/scraper?action=get-queue&jobId=${job.id}`,
  });
}

async function handleDiscover(req, res) {
  const q = parseQuery(req);
  const job = getJob(q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");
  if (job.status === "created") await runDiscovery(job);
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    jobId: job.id, status: job.status,
    stats: { ...job.stats },
    queue: job.queue.slice(0, 50),
    nodes: [...job.nodes.values()].slice(0, 200).map(n => ({ url: n.url, kind: n.kind, status: n.status, depth: n.depth })),
  });
}

async function handleGetQueue(req, res) {
  const q = parseQuery(req);
  const job = getJob(q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");
  const limit = Math.min(Number(q.limit) || 100, 500);
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    jobId: job.id, status: job.status,
    batch_size: job.batchSize,
    queue_size: job.queue.length,
    queue: job.queue.slice(0, limit).map(x => ({ url: x.url, kind: x.kind, depth: x.depth, parent: x.parent, addedAt: x.addedAt })),
    stats: { ...job.stats },
  });
}

async function handleFetchBatch(req, res) {
  const body = req.method === "POST" ? await readBody(req) : {};
  const q = parseQuery(req);
  const job = getJob(body.jobId || q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");
  if (job.status === "created") return fail(res, 409, "NOT_DISCOVERED", "Call ?action=discover first");

  const size = Math.min(Math.max(Number(body.size ?? q.size) || job.batchSize, SCANNER_BATCH_MIN), SCANNER_BATCH_MAX);
  const result = await fetchBatch(job, size);
  return sendJson(res, 200, { success: true, apiVersion: API_VERSION, ...result });
}

async function handleScanStatus(req, res) {
  const q = parseQuery(req);
  const job = getJob(q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");
  const nodeStatuses = {};
  for (const n of job.nodes.values()) nodeStatuses[n.status] = (nodeStatuses[n.status] || 0) + 1;
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    jobId: job.id, status: job.status,
    startUrl: job.startUrl,
    startOrigin: job.startOrigin,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    stats: { ...job.stats },
    node_statuses: nodeStatuses,
    queue_size: job.queue.length,
    completed_batches: job.completedBatches.length,
    failures: job.failures.slice(-50),
    broken: [...job.broken].slice(0, 100),
    technology: job.technology.primary ? job.technology : null,
    apis_count: job.apis.size,
    network_count: job.network.length,
  });
}

async function handleRender(req, res) {
  const body = req.method === "POST" ? await readBody(req) : {};
  const q = parseQuery(req);
  const url = body.url || q.url;
  if (!url) return fail(res, 400, "MISSING_URL", "Provide url");
  const valid = await validateTargetUrl(url);
  if (!valid.ok) return fail(res, 400, "INVALID_URL", valid.reason);

  const r = await renderWithPlaywright(url, {
    viewport: body.viewport,
    mobile: !!body.mobile,
    fullPage: body.fullPage !== false,
    captureNetwork: body.captureNetwork !== false,
    scroll: body.scroll !== false,
    timeoutMs: body.timeoutMs,
  });
  if (!r.ok) return fail(res, 503, "RENDER_UNAVAILABLE", r.error);

  if (body.jobId) {
    const job = getJob(body.jobId);
    if (job) {
      job.renders.push({ url, at: Date.now(), ok: true, summary: { screenshots: r.screenshots ? Object.keys(r.screenshots) : [], network: (r.network || []).length } });
      for (const req of r.network || []) recordNetwork(job, { ...req, sourcePage: url, trigger: "page_load" });
      job.touch();
    }
  }

  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION, url,
    renderedHtml: r.html || null,
    screenshots: r.screenshots || {},
    dimensions: r.dimensions || null,
    network: r.network || [],
    warnings: r.warnings || [],
  });
}

async function handleNetwork(req, res) {
  const q = parseQuery(req);
  const job = getJob(q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");
  let items = job.network;
  if (q.sourcePage) items = items.filter(x => x.sourcePage === q.sourcePage);
  if (q.method) items = items.filter(x => x.method === String(q.method).toUpperCase());
  if (q.host) items = items.filter(x => { try { return new URL(x.url).hostname === q.host; } catch { return false; } });
  const limit = Math.min(Number(q.limit) || 500, 5000);
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION, jobId: job.id,
    count: items.length, requests: items.slice(-limit),
    apis: job.apiList().slice(0, 500),
  });
}

async function handleTechnology(req, res) {
  const q = parseQuery(req);
  const job = getJob(q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");
  if (!job.technology.primary && Object.keys(job.pages).length > 0) {
    job.technology = detectTechnology(job);
  }
  return sendJson(res, 200, { success: true, apiVersion: API_VERSION, jobId: job.id, technology: job.technology });
}

async function handleStructure(req, res) {
  const q = parseQuery(req);
  const job = getJob(q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide url");
  const page = job.pages[q.url];
  if (!page) return fail(res, 404, "PAGE_NOT_FOUND", "Page not in this job");
  const html = page.source?.html || "";
  const structure = { headings: page.page.headings, forms: page.forms, iframes: page.iframes, links: page.links, assets: page.assets, meta: page.meta };
  if (linkedom?.parseHTML && html) {
    try {
      const { parseHTML } = linkedom;
      const { document } = parseHTML(html);
      structure.domOutline = buildDomOutline(document, 0);
    } catch {}
  }
  return sendJson(res, 200, { success: true, apiVersion: API_VERSION, jobId: job.id, url: q.url, structure });
}

function buildDomOutline(node, depth) {
  if (!node || depth > 6) return null;
  const children = [];
  for (const el of node.children || []) {
    const tag = el.tagName?.toLowerCase();
    if (!tag) continue;
    const item = {
      tag,
      id: el.getAttribute?.("id") || null,
      classes: el.getAttribute?.("class")?.split(/\s+/).filter(Boolean) || [],
      text: (el.textContent || "").trim().slice(0, 120) || null,
    };
    item.children = buildDomOutline(el, depth + 1);
    children.push(item);
  }
  return children.length ? children : null;
}

async function handleGetMap(req, res) {
  const q = parseQuery(req);
  const job = getJob(q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");
  const tree = job.snapshotTree();
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION, jobId: job.id, status: job.status,
    tree,
    pagesTree: tree.pagesTree,
    resourceTree: tree.resourceTree,
    backendTree: {
      apis: job.apiList(),
      count: job.apis.size,
    },
    stats: { ...job.stats },
  });
}

async function handleGetResults(req, res) {
  const q = parseQuery(req);
  const job = getJob(q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");
  const kind = q.kind || "all";
  const includeBodies = q.bodies === "1" || q.bodies === "true";
  const out = { success: true, apiVersion: API_VERSION, jobId: job.id, kind };
  if (kind === "all" || kind === "pages") {
    out.pages = Object.fromEntries(Object.entries(job.pages).map(([u, p]) => [u, {
      url: u,
      finalUrl: p.page.finalUrl,
      title: p.page.title,
      statusCode: p.page.status,
      contentType: p.page.contentType,
      byteLength: p.page.byteLength,
      statistics: p.statistics,
    }]));
  }
  if (kind === "all" || kind === "resources") {
    out.resources = Object.fromEntries(Object.entries(job.resources).map(([u, r]) => [u, {
      url: u, contentType: r.contentType, byteLength: r.byteLength, hash: r.hash, truncated: r.truncated,
      ...(includeBodies ? { text: r.text, base64: r.base64 } : {}),
    }]));
  }
  if (kind === "all" || kind === "apis") out.apis = job.apiList();
  if (kind === "all" || kind === "network") out.network = job.network.slice(-2000);
  return sendJson(res, 200, out);
}

async function handleReconstruct(req, res) {
  const body = req.method === "POST" ? await readBody(req) : {};
  const q = parseQuery(req);
  const job = getJob(body.jobId || q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");

  // Determine original filenames & organize
  const pages = {};
  for (const [url, p] of Object.entries(job.pages)) {
    if (!p.source?.html) continue;
    const slug = urlToSlug(url);
    pages[slug] = {
      originalUrl: url,
      title: p.page.title,
      html: p.source.html,
      stylesheets: (p.styles.external || []).map(s => s.url),
      scripts: (p.scripts.external || []).map(s => s.url),
      images: (p.assets.images || []).map(i => i.url),
    };
  }

  const styles = {};
  const scripts = {};
  const assets = {};
  for (const [url, r] of Object.entries(job.resources)) {
    const slug = urlToSlug(url);
    if (/text\/css/i.test(r.contentType || "") || /\.css$/i.test(url)) styles[slug] = r.text || "";
    else if (/javascript/i.test(r.contentType || "") || /\.m?js$/i.test(url)) scripts[slug] = r.text || "";
    else assets[slug] = { contentType: r.contentType, byteLength: r.byteLength, base64: r.base64, text: r.text };
  }

  // Build an editable index
  const manifest = {
    generatedAt: new Date().toISOString(),
    jobId: job.id,
    startUrl: job.startUrl,
    technology: job.technology,
    stats: { ...job.stats },
    pages,
    styles: Object.keys(styles),
    scripts: Object.keys(scripts),
    assets: Object.keys(assets),
    apis: job.apiList().map(a => ({ key: a.key, url: a.url, method: a.method, sourcePages: [...a.sourcePages], triggers: [...a.triggers], statuses: [...a.statuses] })),
    missing: [...job.broken],
    unreproducible: identifyUnreproducible(job),
  };

  job.reconstruction = { pages, styles, scripts, assets, manifest };

  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION, jobId: job.id,
    reconstruction: {
      manifest,
      pageCount: Object.keys(pages).length,
      styleCount: Object.keys(styles).length,
      scriptCount: Object.keys(scripts).length,
      assetCount: Object.keys(assets).length,
    },
    note: "Use ?action=export to produce a ZIP. Reconstruction is an editable mirror of accessible content; it does not reproduce protected data.",
  });
}

function identifyUnreproducible(job) {
  const out = [];
  const pages = Object.keys(job.pages).length;
  if (pages === 0) out.push("No pages fetched yet");
  if (job.broken.size) out.push(`${job.broken.size} resources could not be fetched`);
  if (Object.values(job.pages).some(p => (p.scripts.inline || []).some(s => /eval\(|new Function/.test(s.body || "")))) {
    out.push("Some scripts use eval/Function — behavior may differ");
  }
  if (!PLAYWRIGHT_BROWSER_URL) out.push("Rendered DOM unavailable (no Playwright service configured)");
  return out;
}

async function handleExport(req, res) {
  const body = req.method === "POST" ? await readBody(req) : {};
  const q = parseQuery(req);
  const job = getJob(body.jobId || q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");
  if (!JSZipMod?.default) {
    return fail(res, 503, "EXPORT_UNAVAILABLE", "jszip not installed — add it to enable ZIP export");
  }
  if (!job.reconstruction) {
    await handleReconstruct(
      Object.assign(req, { method: "POST", body: { jobId: job.id } }),
      { status: () => {}, setHeader: () => {}, end: () => {} },
    );
  }

  const JSZip = JSZipMod.default;
  const zip = new JSZip();

  // manifest
  zip.file("manifest.json", JSON.stringify(job.reconstruction.manifest, null, 2));

  // original
  const original = zip.folder("original");
  const pagesFolder = original.folder("pages");
  const cssFolder = original.folder("css");
  const jsFolder = original.folder("js");
  const assetsFolder = original.folder("assets");

  for (const [slug, p] of Object.entries(job.reconstruction.pages)) {
    pagesFolder.file(`${slug}.html`, p.html || "");
  }
  for (const [slug, css] of Object.entries(job.reconstruction.styles)) {
    cssFolder.file(`${slug}.css`, css || "");
  }
  for (const [slug, js] of Object.entries(job.reconstruction.scripts)) {
    jsFolder.file(`${slug}.js`, js || "");
  }
  for (const [slug, a] of Object.entries(job.reconstruction.assets)) {
    const ext = a.contentType?.split("/")[1]?.split(";")[0] || "bin";
    const name = slug.includes(".") ? slug : `${slug}.${ext}`;
    if (a.base64) assetsFolder.file(name, a.base64, { base64: true });
    else if (a.text != null) assetsFolder.file(name, a.text);
  }

  // reconstructed (editable copy)
  const reconstructed = zip.folder("reconstructed");
  const rPages = reconstructed.folder("pages");
  const rStyles = reconstructed.folder("styles");
  const rScripts = reconstructed.folder("scripts");
  const rAssets = reconstructed.folder("assets");
  for (const [slug, p] of Object.entries(job.reconstruction.pages)) {
    rPages.file(`${slug}.html`, p.html || "");
  }
  for (const [slug, css] of Object.entries(job.reconstruction.styles)) rStyles.file(`${slug}.css`, css || "");
  for (const [slug, js] of Object.entries(job.reconstruction.scripts)) rScripts.file(`${slug}.js`, js || "");
  for (const [slug, a] of Object.entries(job.reconstruction.assets)) {
    const ext = a.contentType?.split("/")[1]?.split(";")[0] || "bin";
    const name = slug.includes(".") ? slug : `${slug}.${ext}`;
    if (a.base64) rAssets.file(name, a.base64, { base64: true });
    else if (a.text != null) rAssets.file(name, a.text);
  }

  // reports
  const reports = zip.folder("reports");
  reports.file("technology.json", JSON.stringify(job.technology, null, 2));
  reports.file("pages.json", JSON.stringify(job.reconstruction.pages, null, 2));
  reports.file("resources.json", JSON.stringify(
    Object.fromEntries(Object.entries(job.resources).map(([u, r]) => [u, { contentType: r.contentType, byteLength: r.byteLength, hash: r.hash, truncated: r.truncated }])),
    null, 2,
  ));
  reports.file("apis.json", JSON.stringify(job.apiList(), null, 2));
  reports.file("dependencies.json", JSON.stringify(buildDependencyReport(job), null, 2));
  reports.file("missing-resources.json", JSON.stringify([...job.broken], null, 2));
  reports.file("comparison.json", JSON.stringify(job.comparison || { note: "Use ?action=compare first" }, null, 2));

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="folio-scan-${job.id}.zip"`);
  res.status(200);
  return res.end(buffer);
}

function buildDependencyReport(job) {
  const parentOf = {};
  const childrenOf = {};
  for (const n of job.nodes.values()) {
    if (n.parents.length) parentOf[n.url] = n.parents;
    if (n.children.length) childrenOf[n.url] = n.children;
  }
  return { parentOf, childrenOf, broken: [...job.broken], orphans: job.snapshotTree().orphanResources };
}

async function handleCompare(req, res) {
  const body = req.method === "POST" ? await readBody(req) : {};
  const q = parseQuery(req);
  const job = getJob(body.jobId || q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");

  const comparison = {
    generatedAt: new Date().toISOString(),
    note: "Structural comparison of original vs reconstructed content. Visual diff requires Playwright screenshots.",
    original: {
      pages: Object.keys(job.pages).length,
      resources: Object.keys(job.resources).length,
      bytes: job.stats.bytes,
    },
    reconstructed: job.reconstruction
      ? {
          pages: Object.keys(job.reconstruction.pages).length,
          styles: Object.keys(job.reconstruction.styles).length,
          scripts: Object.keys(job.reconstruction.scripts).length,
          assets: Object.keys(job.reconstruction.assets).length,
        }
      : null,
    coverage: job.stats.discovered ? Math.min(1, job.stats.fetched / job.stats.discovered) : 0,
    broken: [...job.broken],
    missing: [...job.broken],
    unreproducible: identifyUnreproducible(job),
  };
  job.comparison = comparison;
  job.touch();
  return sendJson(res, 200, { success: true, apiVersion: API_VERSION, jobId: job.id, comparison });
}

async function handleRescan(req, res) {
  const body = req.method === "POST" ? await readBody(req) : {};
  const q = parseQuery(req);
  const job = getJob(body.jobId || q.jobId);
  if (!job) return fail(res, 404, "JOB_NOT_FOUND", "Unknown jobId");
  const targets = Array.isArray(body.urls) ? body.urls : (body.url ? [body.url] : (Array.isArray(q.urls) ? q.urls : (q.url ? [q.url] : [])));
  if (!targets.length) return fail(res, 400, "MISSING_URL", "Provide urls[] or url");
  const reaped = [];
  for (const u of targets) {
    const node = job.nodes.get(u);
    if (!node) { reaped.push({ url: u, ok: false, reason: "not_in_job" }); continue; }
    node.status = "queued";
    if (!job.queue.some(x => x.url === u)) job.queue.unshift({ url: u, kind: node.kind, depth: node.depth, parent: node.parents[0] || null, addedAt: Date.now() });
    reaped.push({ url: u, ok: true });
  }
  job.touch();
  return sendJson(res, 200, { success: true, apiVersion: API_VERSION, jobId: job.id, requeued: reaped, queue_size: job.queue.length });
}

function urlToSlug(url) {
  try {
    const u = new URL(url);
    const path = (u.pathname || "/").replace(/^\/|\/$/g, "");
    const name = path ? path.replace(/[^a-z0-9-_]+/gi, "_") : "index";
    return name + (getExt(url) ? "" : ".html");
  } catch { return "index.html"; }
}

// ═══════════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════════

const ROUTES = {
  // Legacy
  scrape: handleScrape,
  page: handlePage,
  links: handleLinks,
  assets: handleAssets,
  scripts: handleScripts,
  styles: handleStyles,
  resource: handleResource,
  source: handleSource,
  crawl: handleCrawl,
  search: handleSearch,
  inspect: handleInspect,
  health: handleHealth,
  // New scanner
  "start-scan": handleStartScan,
  discover: handleDiscover,
  "get-queue": handleGetQueue,
  "fetch-batch": handleFetchBatch,
  "scan-status": handleScanStatus,
  render: handleRender,
  network: handleNetwork,
  technology: handleTechnology,
  structure: handleStructure,
  "get-map": handleGetMap,
  "get-results": handleGetResults,
  reconstruct: handleReconstruct,
  export: handleExport,
  compare: handleCompare,
  rescan: handleRescan,
};

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204); return res.end(); }

  const q = parseQuery(req);
  const action = String(q.action || (req.method === "POST" ? "scrape" : "health")).toLowerCase();
  const fn = ROUTES[action];
  if (!fn) {
    return fail(res, 404, "UNKNOWN_ACTION", `Unknown action: ${action}`, { available: Object.keys(ROUTES) });
  }
  try {
    return await fn(req, res);
  } catch (err) {
    return fail(res, 500, "INTERNAL_ERROR", err.message || "Unhandled error");
  }
}

// ═══════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════

if (import.meta.url === `file://${process.argv[1]}`) {
  const argUrl = process.argv[2];
  if (!argUrl) { console.error("Usage: node api/scraper.js <url>"); process.exit(1); }
  const r = await scrapeOnce(argUrl, { extract: ["metadata","links","assets","scripts","styles","text"] });
  console.log(JSON.stringify(r.ok ? r.result : r, null, 2));
  process.exit(r.ok ? 0 : 1);
}