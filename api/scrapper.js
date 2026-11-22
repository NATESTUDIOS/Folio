// api/scraper.js
// ═══════════════════════════════════════════════════════════════════
//  Folio — Universal Web Scraper & Page Intelligence API
//  ────────────────────────────────────────────────────────────────
//  ONE FILE. NO AUTH. NO DB. NO LOGGING.
//
//  Endpoints (all via ?action= on a single Vercel handler):
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
//  Optional dependencies (auto-detected, graceful fallback):
//    - linkedom        (better DOM; falls back to regex parser)
//    - robots-parser   (robots.txt; falls back to naive allow-all)
//
//  Environment:
//    SCRAPER_MAX_BYTES       per-resource cap  (default 20MB)
//    SCRAPER_TIMEOUT_MS      per-fetch timeout (default 15000)
//    PLAYWRIGHT_BROWSER_URL  optional remote CDP (render:true)
// ═══════════════════════════════════════════════════════════════════

import net from "node:net";
import dns from "node:dns/promises";
import crypto from "node:crypto";

// ── Optional deps (never hard-fail) ────────────────────────────────
let linkedom = null;
try { linkedom = await import("linkedom"); } catch { /* fallback */ }

let robotsParserMod = null;
try { robotsParserMod = await import("robots-parser"); } catch { /* fallback */ }

const API_VERSION = "1.0";

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const MAX_BYTES = parseInt(process.env.SCRAPER_MAX_BYTES, 10) || 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS, 10) || 15_000;
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

const UA = "Mozilla/5.0 (compatible; FolioScraper/1.0; +https://folio.studio/bot)";

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

// ── SSRF protection sets ───────────────────────────────────────────

const RESERVED_V4_PREFIXES = [
  [0,"0.0.0.0/8"],[10,"10.0.0.0/8"],[100,[64,127]],[127,"127.0.0.0/8"],
  [169,254],[172,[16,31]],[192,168],[224,239],[240,255],
];

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
    if (!valid.ok) {
      return { ok: false, error: valid.reason, url: current, chain };
    }
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
      if (!loc) {
        return { ok: false, error: "Redirect with no Location", url: current, chain };
      }
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
      ok: true,
      url: current,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body, truncated,
      chain,
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
    if ((u.protocol === "http:" && u.port === "80")
      || (u.protocol === "https:" && u.port === "443")) u.port = "";
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

// ── Regex-based parser (fallback + fast path) ──────────────────────

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
    const text = ""; // regex can't easily pair text; keep light
    if (href) links.push({ href, rel, text });
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
      const tagObj = { src, srcset, dataSrc, dataSrcset, alt };
      assets[tag]?.push(tagObj);
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

// ── linkedom parser (preferred when available) ─────────────────────

function extractWithLinkedom(html, pageUrl) {
  const { parseHTML } = linkedom;
  const { document } = parseHTML(html);
  const baseHref = document.querySelector("base[href]")?.getAttribute("href") || null;

  const pick = (sel, attr) => Array.from(document.querySelectorAll(sel))
    .map(el => el.getAttribute(attr))
    .filter(Boolean);

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
    catch { /* fall through */ }
  }
  return { parser: "regex", ...extractWithRegex(html, pageUrl) };
}

// ── srcset ─────────────────────────────────────────────────────────

function parseSrcset(srcset) {
  if (!srcset) return [];
  return String(srcset).split(",").map(part => {
    const bits = part.trim().split(/\s+/);
    return { url: bits[0], descriptor: bits[1] || null };
  }).filter(x => x.url);
}

// ── CSS parsing ────────────────────────────────────────────────────

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

// ── JS parsing (regex, low confidence) ─────────────────────────────

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

// ── Text extraction (readability-lite) ─────────────────────────────

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
    url: res.url,
    ok: true,
    status: res.status,
    contentType,
    contentLength: res.headers.get("content-length"),
    truncated: res.truncated,
    ms: Date.now() - started,
    body: null,
    text: null,
    base64: null,
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

// ── Concurrency pool ───────────────────────────────────────────────

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
  const sig = JSON.stringify({
    u: url,
    extract: (opts.extract || []).slice().sort(),
    render: !!opts.render,
    includeContent: !!opts.include_content,
  });
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
    maxBytes: opts.max_bytes,
    timeoutMs: opts.timeout_ms,
    headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  });
  if (!fetched.ok) {
    return { ok: false, error: fetched.error, chain: fetched.chain, result };
  }

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

  // ── Parse ──────────────────────────────────────────────────────
  const parsed = extractPage(html, fetched.url);
  result.parser = parsed.parser;

  // Base for URL resolution: <base href> > final URL
  let effectiveBase = fetched.url;
  if (opts.resolve_urls && parsed.baseHref) {
    const resolvedBase = normalizeUrl(parsed.baseHref, fetched.url);
    if (resolvedBase) effectiveBase = resolvedBase;
  }
  result.page.baseHref = effectiveBase !== fetched.url ? effectiveBase : null;

  // ── Metadata ───────────────────────────────────────────────────
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

  // ── Links ──────────────────────────────────────────────────────
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
    // srcset / picture / iframe contributors to links.all too? keep to a[href] and forms.
  }

  // ── Assets ─────────────────────────────────────────────────────
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
      if (v.src) {
        const abs = normalizeUrl(v.src, effectiveBase);
        if (abs) add(result.assets.videos, { url: abs, source: "video" });
      }
    }
    for (const a of parsed.assets.audio || []) {
      if (a.src) {
        const abs = normalizeUrl(a.src, effectiveBase);
        if (abs) add(result.assets.audio, { url: abs, source: "audio" });
      }
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
      if (f.src) {
        const abs = normalizeUrl(f.src, effectiveBase);
        if (abs) result.iframes.push({ url: abs, source: "iframe" });
      }
    }
  }

  // ── Scripts ────────────────────────────────────────────────────
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
        type: s.type || null,
        byteLength: body.length,
        body: body.length <= MAX_INLINE_SCRIPT_BYTES ? body : body.slice(0, MAX_INLINE_SCRIPT_BYTES) + "…[truncated]",
        truncated: body.length > MAX_INLINE_SCRIPT_BYTES,
      };
      result.scripts.inline.push(entry);
      const imports = parseJsImports(body, effectiveBase);
      for (const i of imports.static) result.scripts.imports.push({ url: i, from: "inline", confidence: "low" });
      for (const d of imports.dynamic) result.scripts.dynamic.push({ url: d, from: "inline", confidence: "low" });
    }
  }

  // ── Styles ─────────────────────────────────────────────────────
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

  // ── Forms ──────────────────────────────────────────────────────
  if (extractSet.has("forms") && parsed.forms) {
    for (const f of parsed.forms) {
      result.forms.push({
        action: f.action ? normalizeUrl(f.action, effectiveBase) : null,
        method: f.method,
        enctype: f.enctype || null,
      });
    }
  }

  // ── Meta tags (preload, prefetch, etc.) ────────────────────────
  if (extractSet.has("meta") && parsed.metaTags) {
    for (const p of parsed.metaTags.preload) result.meta.preload.push({ ...p, url: normalizeUrl(p.href, effectiveBase) });
    for (const p of parsed.metaTags.prefetch) result.meta.prefetch.push({ url: normalizeUrl(p.href, effectiveBase) });
    for (const p of parsed.metaTags.dnsPrefetch) result.meta.dnsPrefetch.push({ url: normalizeUrl(p.href, effectiveBase) });
    for (const p of parsed.metaTags.preconnect) result.meta.preconnect.push({ url: normalizeUrl(p.href, effectiveBase) });
  }

  // ── Text ───────────────────────────────────────────────────────
  if (extractSet.has("text") || opts.include_text_full) {
    const text = extractReadableText(html);
    result.source.text_available = true;
    result.source.text = text.slice(0, MAX_INLINE_EXTRACT);
    if (opts.include_text_full) result.source.text_full = text;
  }

  // ── HTML (only when explicitly requested) ──────────────────────
  if (extractSet.has("html") || opts.include_content === "html") {
    result.source.html_available = true;
    result.source.html = html;
  }

  // ── Fetch resource contents (scripts + styles) ─────────────────
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

  // ── Dedup + classify asset "all" ───────────────────────────────
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

  // ── Stats ──────────────────────────────────────────────────────
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

  if (opts.render) {
    result.warnings.push("render:true requested but no PLAYWRIGHT_BROWSER_URL configured — returned static HTML only");
  }

  return { ok: true, result };
}

// ═══════════════════════════════════════════════════════════════════
// ROBOTS.TXT
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
// CRAWL ENGINE
// ═══════════════════════════════════════════════════════════════════

async function crawl(startUrl, options = {}) {
  const opts = {
    depth: 1,
    max_pages: 10,
    max_concurrency: 4,
    same_origin_only: true,
    respect_robots: true,
    extract: ["metadata","links","assets","scripts","styles"],
    include_content: false,
    ...options,
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
    const r = await scrapeOnce(url, {
      extract: opts.extract,
      include_content: opts.include_content,
      resolve_urls: true,
    });
    if (!r.ok) {
      failures.push({ url, reason: r.error });
      return null;
    }
    const pageResult = {
      url, depth,
      finalUrl: r.result.page.finalUrl,
      status: r.result.page.status,
      title: r.result.page.title,
      links: r.result.links,
      stats: r.result.statistics,
    };
    // Enqueue children
    if (depth < maxDepth) {
      const candidates = [...r.result.links.internal, ...r.result.links.external]
        .map(l => l.url)
        .filter(u => {
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

  // BFS
  while (queue.length && pages.length + failures.length < maxPages) {
    const batch = [];
    while (batch.length < opts.max_concurrency && queue.length) batch.push(queue.shift());
    if (!batch.length) break;
    const results = await Promise.all(batch.map(processOne));
    for (const r of results) if (r) pages.push(r);
  }

  return {
    startUrl,
    depth: maxDepth,
    max_pages: maxPages,
    pages_fetched: pages.length,
    pages: pages,
    failures,
  };
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
      if (size > 1_000_000) { reject(new Error("Request body too large")); req.destroy(); return; }
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

function parseQuery(req) {
  return req.query || {};
}

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
// HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function handleScrape(req, res) {
  const body = req.method === "POST" ? await readBody(req) : {};
  const q = parseQuery(req);
  const url = body.url || q.url;
  if (!url) return fail(res, 400, "MISSING_URL", "Provide ?url= or body.url");

  const opts = normalizeOptions({ ...q, ...body, ...(body.options || {}) });
  const key = cacheKey(url, opts);
  const cached = cacheGet(key);
  if (cached) {
    return sendJson(res, 200, { ...cached, cached: true });
  }

  const r = await scrapeOnce(url, opts);
  if (!r.ok) {
    return fail(res, 502, "FETCH_FAILED", r.error || "Could not fetch URL", { chain: r.chain });
  }
  cacheSet(key, r.result);
  return sendJson(res, 200, r.result);
}

async function handlePage(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const opts = normalizeOptions({ ...q, extract: ["metadata"] });
  const r = await scrapeOnce(q.url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    page: r.result.page,
    statistics: r.result.statistics,
    warnings: r.result.warnings,
  });
}

async function handleLinks(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const opts = normalizeOptions({ ...q, extract: ["links"] });
  const r = await scrapeOnce(q.url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    url: q.url, finalUrl: r.result.page.finalUrl,
    links: r.result.links,
    statistics: { links_found: r.result.statistics.links_found },
  });
}

async function handleAssets(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const opts = normalizeOptions({ ...q, extract: ["assets"] });
  const r = await scrapeOnce(q.url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    url: q.url, finalUrl: r.result.page.finalUrl,
    assets: r.result.assets,
    statistics: {
      images_found: r.result.statistics.images_found,
      videos_found: r.result.statistics.videos_found,
      fonts_found: r.result.statistics.fonts_found,
    },
  });
}

async function handleScripts(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const opts = normalizeOptions({
    ...q,
    extract: ["scripts"],
    include_content: q.include_content === "1" || q.include_content === "true" || q.include_content === "scripts" ? "scripts" : false,
    fetch_resource_contents: q.fetch_resource_contents === "1" || q.fetch_resource_contents === "true",
  });
  const r = await scrapeOnce(q.url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    url: q.url, finalUrl: r.result.page.finalUrl,
    scripts: r.result.scripts,
    statistics: { scripts_found: r.result.statistics.scripts_found },
  });
}

async function handleStyles(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const opts = normalizeOptions({
    ...q,
    extract: ["styles"],
    include_content: q.include_content === "1" || q.include_content === "true" || q.include_content === "styles" ? "styles" : false,
    fetch_resource_contents: q.fetch_resource_contents === "1" || q.fetch_resource_contents === "true",
  });
  const r = await scrapeOnce(q.url, opts);
  if (!r.ok) return fail(res, 502, "FETCH_FAILED", r.error);
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    url: q.url, finalUrl: r.result.page.finalUrl,
    styles: r.result.styles,
    statistics: { stylesheets_found: r.result.statistics.stylesheets_found },
  });
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
    success: true, apiVersion: API_VERSION,
    url: r.url, requestedUrl: q.url,
    status: r.status,
    contentType: r.contentType,
    contentLength: r.contentLength,
    byteLength: r.byteLength,
    truncated: r.truncated,
    classification: cls.category,
    fetch_ms: r.ms,
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
      success: true, apiVersion: API_VERSION,
      url: q.url, finalUrl: r.result.page.finalUrl,
      metadata: {
        title: r.result.page.title,
        description: r.result.page.description,
        keywords: r.result.page.keywords,
        canonicalUrl: r.result.page.canonicalUrl,
        lang: r.result.page.lang,
        favicon: r.result.page.favicon,
        og: r.result.page.og,
        twitter: r.result.page.twitter,
        headings: r.result.page.headings,
        meta: r.result.page.meta,
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
  for (const bucket of ["internal","external","documents"]) {
    for (const l of r.result.links[bucket]) flat.push({ source: "link", bucket, url: l.url });
  }
  for (const bucket of ["images","videos","audio","all"]) {
    for (const a of r.result.assets[bucket] || []) flat.push({ source: "asset", bucket, url: a.url });
  }
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
      try { if (new URL(item.url).hostname.toLowerCase() !== domain) return false; }
      catch { return false; }
    }
    return true;
  });

  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    url: q.url, finalUrl: r.result.page.finalUrl,
    total_scanned: unique.length,
    match_count: matches.length,
    matches,
  });
}

async function handleInspect(req, res) {
  const q = parseQuery(req);
  if (!q.url) return fail(res, 400, "MISSING_URL", "Provide ?url=");
  const cls = classifyUrl(q.url, { pageOrigin: q.origin || null });
  const valid = await validateTargetUrl(q.url);
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    url: q.url,
    classification: cls,
    reachable: valid.ok,
    reason: valid.ok ? null : valid.reason,
    resolvedIps: valid.ok ? valid.resolvedIps : [],
  });
}

async function handleHealth(req, res) {
  return sendJson(res, 200, {
    success: true, apiVersion: API_VERSION,
    status: "ok",
    dependencies: {
      linkedom: !!linkedom?.parseHTML,
      robots_parser: !!robotsParserMod,
    },
    limits: {
      max_bytes: MAX_BYTES,
      timeout_ms: FETCH_TIMEOUT_MS,
      max_crawl_pages: MAX_CRAWL_PAGES,
      max_crawl_concurrency: MAX_CRAWL_CONCURRENCY,
      max_resource_fetches: MAX_RESOURCE_FETCHES,
    },
    endpoints: [
      "scrape","page","links","assets","scripts","styles",
      "resource","source","crawl","search","inspect","health",
    ],
    timestamp: new Date().toISOString(),
  });
}

// ═══════════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════════

const ROUTES = {
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
};

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204);
    return res.end();
  }

  const q = parseQuery(req);
  const action = String(q.action || (req.method === "POST" ? "scrape" : "health")).toLowerCase();
  const fn = ROUTES[action];
  if (!fn) {
    return fail(res, 404, "UNKNOWN_ACTION", `Unknown action: ${action}`, {
      available: Object.keys(ROUTES),
    });
  }

  try {
    return await fn(req, res);
  } catch (err) {
    return fail(res, 500, "INTERNAL_ERROR", err.message || "Unhandled error");
  }
}

// ═══════════════════════════════════════════════════════════════════
// CLI (optional: `node api/scraper.js <url>`)
// ═══════════════════════════════════════════════════════════════════

if (import.meta.url === `file://${process.argv[1]}`) {
  const argUrl = process.argv[2];
  if (!argUrl) {
    console.error("Usage: node api/scraper.js <url>");
    process.exit(1);
  }
  const r = await scrapeOnce(argUrl, { extract: ["metadata","links","assets","scripts","styles","text"], include_text_full: false });
  console.log(JSON.stringify(r.ok ? r.result : r, null, 2));
  process.exit(r.ok ? 0 : 1);
}