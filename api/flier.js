// api/flier.js
// ═══════════════════════════════════════════════════════════════════
//  FLIER — universal image generator  (v3.1.0-folio)
//  ────────────────────────────────────────────────────────────────
//
//  v3.1.0-folio changes:
//    • Seeded random palettes when colors/bg not explicitly set
//    • Gradient derives from colors when bg.from/bg.to missing
//    • Avatar preview variants: random palettes per variant (seeded)
//    • OG/thumbnail callers keep primary amber, accent seeded
//    • New browser-frame template (needs detailed index.html)
//    • Fetched SVGs sanitized (script/foreignObject/external href)
//    • Static dns/promises import
//    • All existing endpoints/caches/rate limits preserved
// ═══════════════════════════════════════════════════════════════════

import { Resvg } from "@resvg/resvg-js";
import * as cheerio from "cheerio";
import crypto from "crypto";
import dns from "node:dns";
import { log, newReqId } from "../utils/log.js";
import { verifySession } from "../utils/users.js";

// ═══════════════════════════════════════════════════════════════════
//  BUNDLED FONT
// ═══════════════════════════════════════════════════════════════════

const BUNDLED_FONT_B64 = "";
const BUNDLED_FONT_FAMILY = "FlierSans";

let fontBuffers = null;
let fontFamily = null;

function initFont() {
  if (fontBuffers !== null) return;
  if (!BUNDLED_FONT_B64) {
    fontBuffers = [];
    fontFamily = null;
    log("font.none", { note: "no bundled font, stroke fallback active" });
    return;
  }
  try {
    const buf = Buffer.from(BUNDLED_FONT_B64, "base64");
    if (buf.length < 1000) throw new Error("font buffer too small");
    const tag = buf.slice(0, 4).toString("ascii");
    if (tag !== "OTTO" && tag !== "true" && tag !== "\x00\x01\x00\x00") {
      throw new Error(`unexpected font magic: ${tag}`);
    }
    fontBuffers = [buf];
    fontFamily = BUNDLED_FONT_FAMILY;
    log("font.loaded", { bytes: buf.length, family: fontFamily });
  } catch (e) {
    log("font.load_failed", { message: e.message });
    fontBuffers = [];
    fontFamily = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const IMAGE_UPLOAD_API =
  process.env.IMAGE_UPLOAD_API ||
  "https://kx-services.vercel.app/api/tools/imageupload";

const ALLOWED_DOMAINS = [
  "folios",
  "foliostudios.vercel.app",
  "folio.vercel.app",
  "folios.app",
  "folio.app",
];
const LOCAL_PATTERN = /^localhost:\d+$|^127\.0\.0\.1:\d+$/;

const SIZES = {
  "1080x1080": { w: 1080, h: 1080 },
  "1080x1350": { w: 1080, h: 1350 },
  "1080x1920": { w: 1080, h: 1920 },
  "1200x630": { w: 1200, h: 630 },
  "1200x1200": { w: 1200, h: 1200 },
  "1600x900": { w: 1600, h: 900 },
  "512x512": { w: 512, h: 512 },
};

const MAX_TEXT = {
  kicker: 40, headline: 120, subheadline: 180, body: 600,
  footer: 120, attribution: 60, date: 40, location: 60,
  price: 20, cta: 40, metric: 32, metricLabel: 60,
};

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const REQUEST_IMAGE_BUDGET = 12 * 1024 * 1024;
const MAX_SVG_CHARS = 300_000;
const MAX_HTML_CHARS = 200_000;
const FETCH_TIMEOUT_MS = 8000;
const FETCH_MAX_REDIRECTS = 5;

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_EDGE = 2048;

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_IP = 40;
const RATE_LIMIT_KEY = 200;

const AVATAR_RATE_WINDOW_MS = 60 * 60 * 1000;
const AVATAR_RATE_LIMIT_IP = 20;

const AVATAR_CUSTOM_RATE_WINDOW_MS = 60 * 60 * 1000;
const AVATAR_CUSTOM_RATE_LIMIT_UID = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const GENERATE_DAILY_LIMIT_IP = 7;
const GENERATE_DAILY_LIMIT_UID = 70;
const UPLOAD_DAILY_LIMIT_IP = 5;
const UPLOAD_DAILY_LIMIT_UID = 30;

const THUMB_RATE_LIMIT_IP = 60;
const THUMB_RATE_WINDOW_MS = 60 * 60 * 1000;

const PREVIEW_CACHE_MAX = 200;
const PREVIEW_CACHE_TTL = 10 * 60 * 1000;

const IMAGE_CACHE_MAX = 100;
const IMAGE_CACHE_TTL = 10 * 60 * 1000;

const AVATAR_CACHE_MAX = 200;
const AVATAR_CACHE_TTL = 5 * 60 * 1000;

const THUMB_CACHE_MAX = 60;
const THUMB_CACHE_TTL = 60 * 60 * 1000;

const SCENE_CACHE_MAX = 100;
const SCENE_CACHE_TTL = 30 * 60 * 1000;

const UPLOAD_MAX_BYTES = 1 * 1024 * 1024;
const UPLOAD_MAX_EDGE = 4096;

// ═══════════════════════════════════════════════════════════════════
//  PALETTE SEEDS — 12 curated quadruples
//  Each entry: { primary, accent, from, to }
//  Used when caller doesn't set colors/background. Deterministic via
//  seed hash so the same project renders the same tint each time.
// ═══════════════════════════════════════════════════════════════════

const PALETTE_SEEDS = [
  { primary: "#F59E0B", accent: "#fbbf24", from: "#F59E0B", to: "#f97316" }, // amber
  { primary: "#3B82F6", accent: "#60a5fa", from: "#3B82F6", to: "#6366f1" }, // sky
  { primary: "#a855f7", accent: "#c084fc", from: "#a855f7", to: "#6d28d9" }, // violet
  { primary: "#10B981", accent: "#34d399", from: "#10B981", to: "#059669" }, // emerald
  { primary: "#ec4899", accent: "#f472b6", from: "#ec4899", to: "#be185d" }, // rose
  { primary: "#06b6d4", accent: "#22d3ee", from: "#06b6d4", to: "#0891b2" }, // cyan
  { primary: "#6366f1", accent: "#818cf8", from: "#6366f1", to: "#4f46e5" }, // indigo
  { primary: "#14b8a6", accent: "#2dd4bf", from: "#14b8a6", to: "#0d9488" }, // teal
  { primary: "#f97316", accent: "#fb923c", from: "#f97316", to: "#ea580c" }, // orange
  { primary: "#84cc16", accent: "#a3e635", from: "#84cc16", to: "#65a30d" }, // lime
  { primary: "#d946ef", accent: "#e879f9", from: "#d946ef", to: "#a21caf" }, // fuchsia
  { primary: "#64748b", accent: "#94a3b8", from: "#64748b", to: "#475569" }, // slate
];

function pickPaletteSeed(seed) {
  const s = String(seed || "x");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return PALETTE_SEEDS[Math.abs(h) % PALETTE_SEEDS.length];
}

// ═══════════════════════════════════════════════════════════════════
//  STROKE FONT — glyph table
// ═══════════════════════════════════════════════════════════════════

const GLYPHS = {
  " ": { w: 0.30, s: [] },
  "0": { w: 0.62, s: [[["M",0.10,0.50],["C",0.10,0.72, 0.14,0.86, 0.31,0.86],["C",0.48,0.86, 0.52,0.72, 0.52,0.50],["C",0.52,0.28, 0.48,0.14, 0.31,0.14],["C",0.14,0.14, 0.10,0.28, 0.10,0.50]]]},
  "1": { w: 0.62, s: [[["M",0.18,0.72],["L",0.34,0.86],["L",0.34,0.14]],[["M",0.14,0.14],["L",0.54,0.14]]]},
  "2": { w: 0.62, s: [[["M",0.10,0.72],["C",0.14,0.84, 0.20,0.86, 0.31,0.86],["C",0.44,0.86, 0.52,0.80, 0.52,0.68],["C",0.52,0.56, 0.44,0.48, 0.10,0.14],["L",0.52,0.14]]]},
  "3": { w: 0.62, s: [[["M",0.10,0.86],["L",0.50,0.86],["L",0.32,0.56]],[["M",0.32,0.56],["C",0.44,0.56, 0.52,0.50, 0.52,0.36],["C",0.52,0.22, 0.42,0.14, 0.30,0.14],["C",0.18,0.14, 0.12,0.18, 0.10,0.28]]]},
  "4": { w: 0.62, s: [[["M",0.44,0.86],["L",0.44,0.14]],[["M",0.44,0.86],["L",0.10,0.42],["L",0.54,0.42]]]},
  "5": { w: 0.62, s: [[["M",0.50,0.86],["L",0.16,0.86],["L",0.12,0.56]],[["M",0.12,0.56],["C",0.20,0.62, 0.28,0.62, 0.36,0.60],["C",0.48,0.58, 0.52,0.48, 0.52,0.36],["C",0.52,0.22, 0.42,0.14, 0.30,0.14],["C",0.18,0.14, 0.12,0.18, 0.10,0.28]]]},
  "6": { w: 0.62, s: [[["M",0.48,0.80],["C",0.44,0.84, 0.38,0.86, 0.30,0.86],["C",0.16,0.86, 0.10,0.76, 0.10,0.50],["C",0.10,0.24, 0.16,0.14, 0.30,0.14],["C",0.44,0.14, 0.50,0.24, 0.50,0.36],["C",0.50,0.48, 0.44,0.56, 0.30,0.56],["C",0.18,0.56, 0.12,0.50, 0.10,0.42]]]},
  "7": { w: 0.62, s: [[["M",0.10,0.86],["L",0.52,0.86],["L",0.22,0.14]]]},
  "8": { w: 0.62, s: [[["M",0.30,0.56],["C",0.18,0.62, 0.16,0.72, 0.16,0.78],["C",0.16,0.84, 0.22,0.86, 0.30,0.86],["C",0.38,0.86, 0.44,0.84, 0.44,0.78],["C",0.44,0.72, 0.42,0.62, 0.30,0.56],["C",0.16,0.48, 0.14,0.36, 0.14,0.26],["C",0.14,0.16, 0.22,0.14, 0.30,0.14],["C",0.38,0.14, 0.46,0.16, 0.46,0.26],["C",0.46,0.36, 0.44,0.48, 0.30,0.56]]]},
  "9": { w: 0.62, s: [[["M",0.50,0.42],["C",0.48,0.50, 0.42,0.56, 0.30,0.56],["C",0.18,0.56, 0.10,0.48, 0.10,0.36],["C",0.10,0.24, 0.16,0.14, 0.30,0.14],["C",0.44,0.14, 0.50,0.24, 0.50,0.50],["C",0.50,0.76, 0.44,0.86, 0.30,0.86],["C",0.22,0.86, 0.16,0.84, 0.12,0.80]]]},
  A: { w: 0.68, s: [[["M",0.00,0.14],["L",0.34,0.86],["L",0.68,0.14]],[["M",0.12,0.40],["L",0.56,0.40]]]},
  B: { w: 0.62, s: [[["M",0.10,0.14],["L",0.10,0.86]],[["M",0.10,0.86],["C",0.30,0.86, 0.38,0.86, 0.44,0.82],["C",0.52,0.76, 0.52,0.68, 0.48,0.62],["C",0.44,0.56, 0.34,0.52, 0.10,0.52]],[["M",0.10,0.52],["C",0.32,0.52, 0.44,0.52, 0.50,0.46],["C",0.56,0.40, 0.56,0.32, 0.52,0.24],["C",0.46,0.16, 0.34,0.14, 0.10,0.14]]]},
  C: { w: 0.66, s: [[["M",0.56,0.72],["C",0.50,0.82, 0.42,0.86, 0.32,0.86],["C",0.16,0.86, 0.10,0.74, 0.10,0.50],["C",0.10,0.26, 0.16,0.14, 0.32,0.14],["C",0.42,0.14, 0.50,0.18, 0.56,0.28]]]},
  D: { w: 0.66, s: [[["M",0.10,0.14],["L",0.10,0.86],["L",0.32,0.86]],[["M",0.32,0.86],["C",0.48,0.86, 0.56,0.76, 0.56,0.50],["C",0.56,0.24, 0.48,0.14, 0.32,0.14],["L",0.10,0.14]]]},
  E: { w: 0.56, s: [[["M",0.52,0.86],["L",0.10,0.86],["L",0.10,0.14],["L",0.52,0.14]],[["M",0.10,0.52],["L",0.44,0.52]]]},
  F: { w: 0.54, s: [[["M",0.52,0.86],["L",0.10,0.86],["L",0.10,0.14]],[["M",0.10,0.52],["L",0.44,0.52]]]},
  G: { w: 0.68, s: [[["M",0.56,0.72],["C",0.50,0.82, 0.42,0.86, 0.32,0.86],["C",0.16,0.86, 0.10,0.74, 0.10,0.50],["C",0.10,0.26, 0.16,0.14, 0.32,0.14],["C",0.46,0.14, 0.56,0.22, 0.56,0.36]],[["M",0.56,0.36],["L",0.56,0.48],["L",0.40,0.48]]]},
  H: { w: 0.64, s: [[["M",0.10,0.14],["L",0.10,0.86]],[["M",0.54,0.14],["L",0.54,0.86]],[["M",0.10,0.52],["L",0.54,0.52]]]},
  I: { w: 0.22, s: [[["M",0.11,0.14],["L",0.11,0.86]]]},
  J: { w: 0.50, s: [[["M",0.40,0.86],["L",0.40,0.28],["C",0.40,0.18, 0.32,0.14, 0.24,0.14],["C",0.16,0.14, 0.08,0.18, 0.08,0.28]]]},
  K: { w: 0.62, s: [[["M",0.10,0.14],["L",0.10,0.86]],[["M",0.54,0.86],["L",0.10,0.48]],[["M",0.24,0.58],["L",0.56,0.14]]]},
  L: { w: 0.52, s: [[["M",0.10,0.86],["L",0.10,0.14],["L",0.48,0.14]]]},
  M: { w: 0.80, s: [[["M",0.10,0.14],["L",0.10,0.86],["L",0.40,0.40],["L",0.70,0.86],["L",0.70,0.14]]]},
  N: { w: 0.68, s: [[["M",0.10,0.14],["L",0.10,0.86],["L",0.56,0.14],["L",0.56,0.86]]]},
  O: { w: 0.72, s: [[["M",0.36,0.14],["C",0.18,0.14, 0.10,0.28, 0.10,0.50],["C",0.10,0.72, 0.18,0.86, 0.36,0.86],["C",0.54,0.86, 0.62,0.72, 0.62,0.50],["C",0.62,0.28, 0.54,0.14, 0.36,0.14]]]},
  P: { w: 0.60, s: [[["M",0.10,0.14],["L",0.10,0.86],["L",0.40,0.86]],[["M",0.40,0.86],["C",0.52,0.86, 0.56,0.78, 0.56,0.64],["C",0.56,0.50, 0.52,0.44, 0.40,0.44],["L",0.10,0.44]]]},
  Q: { w: 0.72, s: [[["M",0.36,0.14],["C",0.18,0.14, 0.10,0.28, 0.10,0.50],["C",0.10,0.72, 0.18,0.86, 0.36,0.86],["C",0.54,0.86, 0.62,0.72, 0.62,0.50],["C",0.62,0.28, 0.54,0.14, 0.36,0.14]],[["M",0.42,0.32],["L",0.66,0.06]]]},
  R: { w: 0.62, s: [[["M",0.10,0.14],["L",0.10,0.86],["L",0.40,0.86]],[["M",0.40,0.86],["C",0.52,0.86, 0.56,0.78, 0.56,0.66],["C",0.56,0.54, 0.52,0.46, 0.40,0.46],["L",0.10,0.46]],[["M",0.34,0.46],["L",0.56,0.14]]]},
  S: { w: 0.60, s: [[["M",0.50,0.76],["C",0.46,0.84, 0.38,0.86, 0.30,0.86],["C",0.20,0.86, 0.10,0.82, 0.10,0.70],["C",0.10,0.58, 0.20,0.54, 0.32,0.52],["C",0.44,0.50, 0.52,0.44, 0.52,0.30],["C",0.52,0.18, 0.42,0.14, 0.32,0.14],["C",0.22,0.14, 0.14,0.16, 0.10,0.24]]]},
  T: { w: 0.60, s: [[["M",0.10,0.86],["L",0.50,0.86]],[["M",0.30,0.86],["L",0.30,0.14]]]},
  U: { w: 0.64, s: [[["M",0.10,0.86],["L",0.10,0.30],["C",0.10,0.18, 0.18,0.14, 0.32,0.14],["C",0.46,0.14, 0.54,0.18, 0.54,0.30],["L",0.54,0.86]]]},
  V: { w: 0.66, s: [[["M",0.10,0.86],["L",0.34,0.14],["L",0.56,0.86]]]},
  W: { w: 0.92, s: [[["M",0.10,0.86],["L",0.26,0.14],["L",0.46,0.62],["L",0.66,0.14],["L",0.82,0.86]]]},
  X: { w: 0.64, s: [[["M",0.10,0.86],["L",0.54,0.14]],[["M",0.54,0.86],["L",0.10,0.14]]]},
  Y: { w: 0.64, s: [[["M",0.10,0.86],["L",0.32,0.50],["L",0.54,0.86]],[["M",0.32,0.50],["L",0.32,0.14]]]},
  Z: { w: 0.60, s: [[["M",0.10,0.86],["L",0.50,0.86],["L",0.10,0.14],["L",0.50,0.14]]]},
  a: { w: 0.56, s: [[["M",0.14,0.58],["C",0.18,0.66, 0.24,0.70, 0.32,0.70],["C",0.42,0.70, 0.50,0.66, 0.50,0.56],["L",0.50,0.14]],[["M",0.50,0.46],["L",0.24,0.46],["C",0.14,0.46, 0.10,0.40, 0.10,0.32],["C",0.10,0.20, 0.16,0.14, 0.28,0.14],["C",0.40,0.14, 0.46,0.20, 0.50,0.26]]]},
  b: { w: 0.56, s: [[["M",0.10,0.86],["L",0.10,0.14]],[["M",0.10,0.58],["C",0.14,0.66, 0.20,0.70, 0.30,0.70],["C",0.42,0.70, 0.50,0.64, 0.50,0.42],["C",0.50,0.20, 0.42,0.14, 0.30,0.14],["C",0.20,0.14, 0.14,0.18, 0.10,0.26]]]},
  c: { w: 0.52, s: [[["M",0.46,0.58],["C",0.42,0.66, 0.36,0.70, 0.28,0.70],["C",0.16,0.70, 0.10,0.62, 0.10,0.42],["C",0.10,0.22, 0.16,0.14, 0.28,0.14],["C",0.36,0.14, 0.42,0.18, 0.46,0.26]]]},
  d: { w: 0.56, s: [[["M",0.50,0.86],["L",0.50,0.14]],[["M",0.50,0.58],["C",0.46,0.66, 0.40,0.70, 0.30,0.70],["C",0.18,0.70, 0.10,0.64, 0.10,0.42],["C",0.10,0.20, 0.18,0.14, 0.30,0.14],["C",0.40,0.14, 0.46,0.18, 0.50,0.26]]]},
  e: { w: 0.54, s: [[["M",0.10,0.42],["L",0.50,0.42],["C",0.50,0.62, 0.44,0.70, 0.30,0.70],["C",0.16,0.70, 0.10,0.62, 0.10,0.42],["C",0.10,0.22, 0.16,0.14, 0.30,0.14],["C",0.40,0.14, 0.46,0.18, 0.50,0.24]]]},
  f: { w: 0.38, s: [[["M",0.32,0.84],["C",0.28,0.88, 0.22,0.90, 0.16,0.86],["C",0.12,0.82, 0.12,0.76, 0.12,0.70],["L",0.12,0.14]],[["M",0.02,0.70],["L",0.30,0.70]]]},
  g: { w: 0.56, s: [[["M",0.50,0.70],["L",0.50,0.06],["C",0.50,-0.04, 0.42,-0.08, 0.30,-0.08],["C",0.22,-0.08, 0.16,-0.06, 0.12,-0.02]],[["M",0.50,0.58],["C",0.46,0.66, 0.40,0.70, 0.30,0.70],["C",0.18,0.70, 0.10,0.64, 0.10,0.42],["C",0.10,0.20, 0.18,0.14, 0.30,0.14],["C",0.40,0.14, 0.46,0.18, 0.50,0.26]]]},
  h: { w: 0.56, s: [[["M",0.10,0.86],["L",0.10,0.14]],[["M",0.10,0.56],["C",0.14,0.64, 0.20,0.70, 0.30,0.70],["C",0.42,0.70, 0.50,0.64, 0.50,0.52],["L",0.50,0.14]]]},
  i: { w: 0.22, s: [[["M",0.11,0.70],["L",0.11,0.14]],[["M",0.11,0.86],["L",0.11,0.90]]]},
  j: { w: 0.26, s: [[["M",0.18,0.70],["L",0.18,-0.06],["C",0.18,-0.14, 0.12,-0.16, 0.06,-0.14],["C",0.02,-0.12, 0.00,-0.10, 0.00,-0.06]],[["M",0.18,0.86],["L",0.18,0.90]]]},
  k: { w: 0.52, s: [[["M",0.10,0.86],["L",0.10,0.14]],[["M",0.44,0.70],["L",0.10,0.40]],[["M",0.22,0.50],["L",0.46,0.14]]]},
  l: { w: 0.22, s: [[["M",0.11,0.86],["L",0.11,0.14]]]},
  m: { w: 0.86, s: [[["M",0.10,0.70],["L",0.10,0.14]],[["M",0.10,0.58],["C",0.14,0.64, 0.20,0.70, 0.28,0.70],["C",0.36,0.70, 0.42,0.66, 0.42,0.56],["L",0.42,0.14]],[["M",0.42,0.56],["C",0.46,0.64, 0.52,0.70, 0.60,0.70],["C",0.68,0.70, 0.74,0.66, 0.74,0.56],["L",0.74,0.14]]]},
  n: { w: 0.56, s: [[["M",0.10,0.70],["L",0.10,0.14]],[["M",0.10,0.56],["C",0.14,0.64, 0.20,0.70, 0.30,0.70],["C",0.42,0.70, 0.50,0.64, 0.50,0.52],["L",0.50,0.14]]]},
  o: { w: 0.56, s: [[["M",0.28,0.14],["C",0.16,0.14, 0.10,0.22, 0.10,0.42],["C",0.10,0.62, 0.16,0.70, 0.28,0.70],["C",0.40,0.70, 0.46,0.62, 0.46,0.42],["C",0.46,0.22, 0.40,0.14, 0.28,0.14]]]},
  p: { w: 0.56, s: [[["M",0.10,0.70],["L",0.10,-0.14]],[["M",0.10,0.58],["C",0.14,0.66, 0.20,0.70, 0.30,0.70],["C",0.42,0.70, 0.50,0.64, 0.50,0.42],["C",0.50,0.20, 0.42,0.14, 0.30,0.14],["C",0.20,0.14, 0.14,0.18, 0.10,0.26]]]},
  q: { w: 0.56, s: [[["M",0.50,0.70],["L",0.50,-0.14]],[["M",0.50,0.58],["C",0.46,0.66, 0.40,0.70, 0.30,0.70],["C",0.18,0.70, 0.10,0.64, 0.10,0.42],["C",0.10,0.20, 0.18,0.14, 0.30,0.14],["C",0.40,0.14, 0.46,0.18, 0.50,0.26]]]},
  r: { w: 0.42, s: [[["M",0.10,0.70],["L",0.10,0.14]],[["M",0.10,0.48],["C",0.16,0.60, 0.24,0.68, 0.34,0.70]]]},
  s: { w: 0.50, s: [[["M",0.42,0.56],["C",0.40,0.64, 0.34,0.70, 0.26,0.70],["C",0.18,0.70, 0.10,0.66, 0.10,0.58],["C",0.10,0.50, 0.18,0.46, 0.26,0.44],["C",0.34,0.42, 0.42,0.38, 0.42,0.28],["C",0.42,0.18, 0.34,0.14, 0.26,0.14],["C",0.16,0.14, 0.10,0.18, 0.08,0.26]]]},
  t: { w: 0.36, s: [[["M",0.20,0.86],["L",0.20,0.24],["C",0.20,0.16, 0.26,0.14, 0.32,0.14]],[["M",0.04,0.70],["L",0.32,0.70]]]},
  u: { w: 0.56, s: [[["M",0.10,0.70],["L",0.10,0.28],["C",0.10,0.18, 0.16,0.14, 0.26,0.14],["C",0.36,0.14, 0.42,0.18, 0.46,0.26]],[["M",0.50,0.70],["L",0.50,0.14]]]},
  v: { w: 0.54, s: [[["M",0.10,0.70],["L",0.28,0.14],["L",0.44,0.70]]]},
  w: { w: 0.78, s: [[["M",0.10,0.70],["L",0.24,0.14],["L",0.38,0.52],["L",0.52,0.14],["L",0.66,0.70]]]},
  x: { w: 0.54, s: [[["M",0.10,0.70],["L",0.44,0.14]],[["M",0.44,0.70],["L",0.10,0.14]]]},
  y: { w: 0.54, s: [[["M",0.10,0.70],["L",0.28,0.22]],[["M",0.44,0.70],["L",0.16,-0.14]]]},
  z: { w: 0.50, s: [[["M",0.10,0.70],["L",0.42,0.70],["L",0.10,0.14],["L",0.42,0.14]]]},
  ".": { w: 0.24, s: [[["M",0.11,0.12],["L",0.11,0.14]]]},
  ",": { w: 0.24, s: [[["M",0.13,0.12],["L",0.09,-0.06]]]},
  ":": { w: 0.24, s: [[["M",0.11,0.38],["L",0.11,0.40]],[["M",0.11,0.12],["L",0.11,0.14]]]},
  ";": { w: 0.24, s: [[["M",0.11,0.38],["L",0.11,0.40]],[["M",0.13,0.12],["L",0.09,-0.06]]]},
  "!": { w: 0.24, s: [[["M",0.11,0.66],["L",0.11,0.86]],[["M",0.11,0.12],["L",0.11,0.14]]]},
  "?": { w: 0.52, s: [[["M",0.10,0.72],["C",0.14,0.82, 0.20,0.86, 0.30,0.86],["C",0.42,0.86, 0.48,0.80, 0.48,0.68],["C",0.48,0.58, 0.40,0.52, 0.30,0.46],["L",0.28,0.32]],[["M",0.28,0.12],["L",0.28,0.14]]]},
  "-": { w: 0.42, s: [[["M",0.06,0.42],["L",0.36,0.42]]]},
  "—": { w: 0.94, s: [[["M",0.06,0.42],["L",0.88,0.42]]]},
  "_": { w: 0.56, s: [[["M",0.00,-0.14],["L",0.56,-0.14]]]},
  "'": { w: 0.20, s: [[["M",0.10,0.66],["L",0.10,0.86]]]},
  '"': { w: 0.32, s: [[["M",0.09,0.66],["L",0.09,0.86]],[["M",0.23,0.66],["L",0.23,0.86]]]},
  "(": { w: 0.32, s: [[["M",0.24,0.90],["C",0.16,0.78, 0.10,0.62, 0.10,0.44],["C",0.10,0.26, 0.16,0.10, 0.24,-0.02]]]},
  ")": { w: 0.32, s: [[["M",0.08,0.90],["C",0.16,0.78, 0.22,0.62, 0.22,0.44],["C",0.22,0.26, 0.16,0.10, 0.08,-0.02]]]},
  "[": { w: 0.30, s: [[["M",0.24,0.86],["L",0.10,0.86],["L",0.10,0.10],["L",0.24,0.10]]]},
  "]": { w: 0.30, s: [[["M",0.06,0.86],["L",0.20,0.86],["L",0.20,0.10],["L",0.06,0.10]]]},
  "/": { w: 0.46, s: [[["M",0.04,0.10],["L",0.42,0.86]]]},
  "\\": { w: 0.46, s: [[["M",0.04,0.86],["L",0.42,0.10]]]},
  "&": { w: 0.72, s: [[["M",0.56,0.20],["C",0.50,0.14, 0.42,0.12, 0.34,0.14],["C",0.24,0.16, 0.18,0.24, 0.18,0.32],["C",0.18,0.42, 0.28,0.50, 0.40,0.58],["C",0.48,0.64, 0.52,0.72, 0.48,0.78],["C",0.42,0.86, 0.30,0.86, 0.24,0.80],["C",0.18,0.74, 0.20,0.66, 0.26,0.58],["L",0.56,0.14]]]},
  "@": { w: 0.88, s: [[["M",0.62,0.34],["C",0.60,0.42, 0.54,0.46, 0.46,0.46],["C",0.38,0.46, 0.34,0.40, 0.34,0.32],["C",0.34,0.24, 0.40,0.20, 0.48,0.20],["C",0.54,0.20, 0.58,0.24, 0.62,0.30]],[["M",0.62,0.44],["L",0.62,0.18],["C",0.62,0.14, 0.66,0.12, 0.70,0.14],["C",0.76,0.18, 0.78,0.26, 0.78,0.40],["C",0.78,0.58, 0.68,0.72, 0.50,0.78],["C",0.32,0.84, 0.16,0.76, 0.12,0.58],["C",0.08,0.40, 0.16,0.22, 0.34,0.14],["C",0.52,0.06, 0.68,0.12, 0.78,0.22]]]},
  "#": { w: 0.68, s: [[["M",0.20,0.60],["L",0.56,0.60]],[["M",0.16,0.34],["L",0.52,0.34]],[["M",0.30,0.86],["L",0.24,0.14]],[["M",0.46,0.86],["L",0.40,0.14]]]},
  "%": { w: 0.72, s: [[["M",0.10,0.18],["C",0.10,0.24, 0.14,0.30, 0.20,0.30],["C",0.26,0.30, 0.30,0.24, 0.30,0.18],["C",0.30,0.12, 0.26,0.08, 0.20,0.08],["C",0.14,0.08, 0.10,0.12, 0.10,0.18]],[["M",0.60,0.82],["C",0.60,0.88, 0.64,0.92, 0.70,0.92],["C",0.76,0.92, 0.80,0.88, 0.80,0.82],["C",0.80,0.76, 0.76,0.72, 0.70,0.72],["C",0.64,0.72, 0.60,0.76, 0.60,0.82]],[["M",0.14,0.12],["L",0.62,0.86]]]},
  "+": { w: 0.60, s: [[["M",0.10,0.42],["L",0.50,0.42]],[["M",0.30,0.22],["L",0.30,0.62]]]},
  "=": { w: 0.60, s: [[["M",0.10,0.52],["L",0.50,0.52]],[["M",0.10,0.32],["L",0.50,0.32]]]},
  "*": { w: 0.50, s: [[["M",0.25,0.62],["L",0.25,0.90]],[["M",0.09,0.70],["L",0.41,0.82]],[["M",0.41,0.70],["L",0.09,0.82]]]},
  "<": { w: 0.50, s: [[["M",0.40,0.70],["L",0.12,0.42],["L",0.40,0.14]]]},
  ">": { w: 0.50, s: [[["M",0.12,0.70],["L",0.40,0.42],["L",0.12,0.14]]]},
  "|": { w: 0.22, s: [[["M",0.11,0.86],["L",0.11,0.10]]]},
  "~": { w: 0.56, s: [[["M",0.06,0.40],["C",0.12,0.46, 0.18,0.48, 0.24,0.44],["C",0.30,0.40, 0.36,0.42, 0.42,0.46],["C",0.46,0.48, 0.48,0.48, 0.50,0.46]]]},
  "·": { w: 0.24, s: [[["M",0.11,0.36],["L",0.11,0.38]]]},
  "$": { w: 0.60, s: [[["M",0.50,0.72],["C",0.44,0.82, 0.38,0.86, 0.30,0.86],["C",0.20,0.86, 0.14,0.80, 0.14,0.70],["C",0.14,0.60, 0.22,0.54, 0.32,0.50],["C",0.42,0.46, 0.48,0.40, 0.48,0.30],["C",0.48,0.20, 0.42,0.14, 0.32,0.14],["C",0.22,0.14, 0.14,0.18, 0.10,0.28]],[["M",0.30,0.96],["L",0.30,0.04]]]},
  "€": { w: 0.66, s: [[["M",0.56,0.72],["C",0.50,0.82, 0.42,0.86, 0.32,0.86],["C",0.16,0.86, 0.10,0.74, 0.10,0.50],["C",0.10,0.26, 0.16,0.14, 0.32,0.14],["C",0.42,0.14, 0.50,0.18, 0.56,0.28]],[["M",0.06,0.42],["L",0.44,0.42]],[["M",0.06,0.58],["L",0.44,0.58]]]},
  "£": { w: 0.60, s: [[["M",0.50,0.76],["C",0.44,0.84, 0.38,0.86, 0.30,0.86],["C",0.20,0.86, 0.14,0.80, 0.14,0.70],["L",0.14,0.14],["L",0.48,0.14]],[["M",0.06,0.50],["L",0.36,0.50]]]},
  "¥": { w: 0.64, s: [[["M",0.10,0.86],["L",0.32,0.54],["L",0.54,0.86]],[["M",0.10,0.54],["L",0.54,0.54]],[["M",0.10,0.36],["L",0.54,0.36]],[["M",0.32,0.54],["L",0.32,0.14]]]},
  "°": { w: 0.40, s: [[["M",0.20,0.70],["C",0.14,0.70, 0.10,0.74, 0.10,0.80],["C",0.10,0.86, 0.14,0.90, 0.20,0.90],["C",0.26,0.90, 0.30,0.86, 0.30,0.80],["C",0.30,0.74, 0.26,0.70, 0.20,0.70]]]},
};

const GLYPH_FALLBACK = GLYPHS["?"];

function glyphFor(ch) {
  if (GLYPHS[ch]) return GLYPHS[ch];
  const up = ch.toUpperCase();
  if (GLYPHS[up]) return GLYPHS[up];
  return GLYPH_FALLBACK;
}

// ═══════════════════════════════════════════════════════════════════
//  SCENES + PALETTES (unchanged)
// ═══════════════════════════════════════════════════════════════════

const PALETTES = {
  warm:   { primary: "#F59E0B", secondary: "#f97316", accent: "#fbbf24", sky: "#2a1810", ground: "#1a0f08", ink: "#fde8c4" },
  cool:   { primary: "#3B82F6", secondary: "#6366f1", accent: "#38bdf8", sky: "#0f172a", ground: "#0a0f1f", ink: "#dbeafe" },
  neon:   { primary: "#ec4899", secondary: "#a855f7", accent: "#06b6d4", sky: "#1a0a24", ground: "#0d0412", ink: "#fae8ff" },
  earth:  { primary: "#b0793a", secondary: "#d9a441", accent: "#7a4d1f", sky: "#1a130a", ground: "#0f0a05", ink: "#f5ebd8" },
  sunset: { primary: "#f97316", secondary: "#dc2626", accent: "#a855f7", sky: "#2a1410", ground: "#180a08", ink: "#fde4d4" },
  mono:   { primary: "#a1a1aa", secondary: "#52525b", accent: "#ffffff", sky: "#1a1a1f", ground: "#0f0f12", ink: "#f4f4f5" },
};

function resolvePalette(name, primaryHex, accentHex) {
  const p = { ...(PALETTES[name] || PALETTES.warm) };
  if (primaryHex) p.primary = primaryHex;
  if (accentHex) p.accent = accentHex;
  return p;
}

const SCENES = {
  paper_stack: (ctx) => {
    const { W, H, palette: p, seed } = ctx;
    const rng = seededRandom(seed + "paper");
    const baseY = H * 0.78;
    const sheets = [];
    for (let i = 0; i < 3; i++) {
      const ang = -8 + i * 4 + rng() * 3;
      const offX = (i - 1) * W * 0.03 + rng() * W * 0.02;
      const offY = i * H * 0.015;
      sheets.push(`<g transform="translate(${(W / 2 + offX).toFixed(1)},${(baseY + offY).toFixed(1)}) rotate(${ang.toFixed(1)})">
        <rect x="${(-W * 0.22).toFixed(1)}" y="${(-H * 0.14).toFixed(1)}" width="${(W * 0.44).toFixed(1)}" height="${(H * 0.28).toFixed(1)}" rx="${(W * 0.008).toFixed(1)}" fill="${p.ink}" opacity="0.9"/>
        <rect x="${(-W * 0.22).toFixed(1)}" y="${(-H * 0.14).toFixed(1)}" width="${(W * 0.44).toFixed(1)}" height="${(H * 0.28).toFixed(1)}" rx="${(W * 0.008).toFixed(1)}" fill="none" stroke="${p.ink}" stroke-width="${(W * 0.0008).toFixed(2)}" opacity="0.3"/>
      </g>`);
    }
    const lines = [];
    for (let i = 0; i < 5; i++) {
      const ly = baseY - H * 0.10 + i * H * 0.03;
      const lw = W * (0.18 + rng() * 0.10);
      lines.push(`<rect x="${(W / 2 - lw / 2).toFixed(1)}" y="${ly.toFixed(1)}" width="${lw.toFixed(1)}" height="${(H * 0.004).toFixed(2)}" rx="${(H * 0.002).toFixed(2)}" fill="${p.primary}" opacity="0.45"/>`);
    }
    return `<g opacity="${ctx.opacity}">${sheets.join("")}${lines.join("")}</g>`;
  },
  newspaper_fold: (ctx) => {
    const { W, H, palette: p } = ctx;
    const foldY = H * 0.30;
    return `<g opacity="${ctx.opacity}">
      <rect x="${(W * 0.08).toFixed(1)}" y="${(H * 0.15).toFixed(1)}" width="${(W * 0.84).toFixed(1)}" height="${(H * 0.22).toFixed(1)}" rx="${(W * 0.005).toFixed(1)}" fill="${p.ink}" opacity="0.92"/>
      <rect x="${(W * 0.08).toFixed(1)}" y="${(H * 0.15).toFixed(1)}" width="${(W * 0.84).toFixed(1)}" height="${(H * 0.22).toFixed(1)}" rx="${(W * 0.005).toFixed(1)}" fill="none" stroke="${p.primary}" stroke-width="${(W * 0.0008).toFixed(2)}" opacity="0.25"/>
      <line x1="${(W * 0.08).toFixed(1)}" y1="${foldY.toFixed(1)}" x2="${(W * 0.92).toFixed(1)}" y2="${foldY.toFixed(1)}" stroke="${p.primary}" stroke-width="${(W * 0.0012).toFixed(2)}" opacity="0.4"/>
      <rect x="${(W * 0.12).toFixed(1)}" y="${(H * 0.19).toFixed(1)}" width="${(W * 0.50).toFixed(1)}" height="${(H * 0.035).toFixed(1)}" rx="${(H * 0.004).toFixed(1)}" fill="${p.primary}" opacity="0.7"/>
      <rect x="${(W * 0.12).toFixed(1)}" y="${(H * 0.235).toFixed(1)}" width="${(W * 0.34).toFixed(1)}" height="${(H * 0.014).toFixed(1)}" rx="${(H * 0.003).toFixed(1)}" fill="${p.primary}" opacity="0.4"/>
      <rect x="${(W * 0.64).toFixed(1)}" y="${(H * 0.19).toFixed(1)}" width="${(W * 0.24).toFixed(1)}" height="${(H * 0.015).toFixed(1)}" rx="${(H * 0.003).toFixed(1)}" fill="${p.primary}" opacity="0.3"/>
      <rect x="${(W * 0.64).toFixed(1)}" y="${(H * 0.212).toFixed(1)}" width="${(W * 0.24).toFixed(1)}" height="${(H * 0.015).toFixed(1)}" rx="${(H * 0.003).toFixed(1)}" fill="${p.primary}" opacity="0.3"/>
      <rect x="${(W * 0.64).toFixed(1)}" y="${(H * 0.234).toFixed(1)}" width="${(W * 0.20).toFixed(1)}" height="${(H * 0.015).toFixed(1)}" rx="${(H * 0.003).toFixed(1)}" fill="${p.primary}" opacity="0.3"/>
    </g>`;
  },
  type_specimen: (ctx) => {
    const { W, H, palette: p } = ctx;
    const letter = String.fromCharCode(65 + Math.floor(seededRandom(ctx.seed + "letter")() * 26));
    const g = glyphFor(letter);
    const size = Math.min(W, H) * 0.65;
    const cx = W * 0.5;
    const cy = H * 0.62;
    const pathEls = [];
    for (const poly of g.s) {
      let d = "";
      for (const seg of poly) {
        if (seg[0] === "M") d += `M${(seg[1] * size).toFixed(1)},${(-seg[2] * size).toFixed(1)} `;
        else if (seg[0] === "L") d += `L${(seg[1] * size).toFixed(1)},${(-seg[2] * size).toFixed(1)} `;
        else if (seg[0] === "C") d += `C${(seg[1] * size).toFixed(1)},${(-seg[2] * size).toFixed(1)} ${(seg[3] * size).toFixed(1)},${(-seg[4] * size).toFixed(1)} ${(seg[5] * size).toFixed(1)},${(-seg[6] * size).toFixed(1)} `;
      }
      pathEls.push(`<path d="${d.trim()}" fill="none" stroke="${p.primary}" stroke-width="${(size * 0.055).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`);
    }
    return `<g transform="translate(${(cx - size * 0.3).toFixed(1)},${cy.toFixed(1)})" opacity="${ctx.opacity}">
      ${pathEls.join("")}
      <line x1="${(-size * 0.15).toFixed(1)}" y1="${(size * 0.9).toFixed(1)}" x2="${(size * 0.7).toFixed(1)}" y2="${(size * 0.9).toFixed(1)}" stroke="${p.accent}" stroke-width="${(size * 0.008).toFixed(1)}" opacity="0.6"/>
      <line x1="${(-size * 0.15).toFixed(1)}" y1="${(size * 1.05).toFixed(1)}" x2="${(size * 0.4).toFixed(1)}" y2="${(size * 1.05).toFixed(1)}" stroke="${p.accent}" stroke-width="${(size * 0.008).toFixed(1)}" opacity="0.4"/>
    </g>`;
  },
  book_spine: (ctx) => {
    const { W, H, palette: p, seed } = ctx;
    const rng = seededRandom(seed + "books");
    const baseY = H * 0.72;
    const bookH = H * 0.16;
    const books = [];
    let x = W * 0.10;
    for (let i = 0; i < 7; i++) {
      const bw = W * (0.05 + rng() * 0.03);
      const bh = bookH * (0.85 + rng() * 0.25);
      const tone = i % 3 === 0 ? p.primary : (i % 3 === 1 ? p.accent : p.ink);
      books.push(`<rect x="${x.toFixed(1)}" y="${(baseY - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${(W * 0.003).toFixed(1)}" fill="${tone}" opacity="${(0.6 + rng() * 0.3).toFixed(2)}"/>`);
      books.push(`<line x1="${x.toFixed(1)}" y1="${(baseY - bh * 0.15).toFixed(1)}" x2="${(x + bw).toFixed(1)}" y2="${(baseY - bh * 0.15).toFixed(1)}" stroke="${p.sky}" stroke-width="${(W * 0.001).toFixed(2)}" opacity="0.4"/>`);
      x += bw + W * 0.008;
    }
    const pulledX = W * 0.42;
    books.push(`<rect x="${pulledX.toFixed(1)}" y="${(baseY - bookH * 1.1).toFixed(1)}" width="${(W * 0.06).toFixed(1)}" height="${(bookH * 1.1).toFixed(1)}" rx="${(W * 0.003).toFixed(1)}" fill="${p.primary}" opacity="0.9" transform="rotate(-12 ${pulledX.toFixed(1)} ${(baseY - bookH * 1.1).toFixed(1)})"/>`);
    return `<g opacity="${ctx.opacity}">${books.join("")}<line x1="${(W * 0.10).toFixed(1)}" y1="${baseY.toFixed(1)}" x2="${(W * 0.90).toFixed(1)}" y2="${baseY.toFixed(1)}" stroke="${p.primary}" stroke-width="${(W * 0.0015).toFixed(2)}" opacity="0.5"/></g>`;
  },
  terminal: (ctx) => {
    const { W, H, palette: p, seed } = ctx;
    const rng = seededRandom(seed + "term");
    const x0 = W * 0.12;
    const y0 = H * 0.18;
    const w = W * 0.76;
    const h = H * 0.28;
    const lines = [];
    for (let i = 0; i < 6; i++) {
      const ly = y0 + h * (0.20 + i * 0.13);
      const lw = w * (0.25 + rng() * 0.45);
      const color = i === 1 ? p.accent : p.primary;
      lines.push(`<rect x="${(x0 + w * 0.06).toFixed(1)}" y="${ly.toFixed(1)}" width="${lw.toFixed(1)}" height="${(h * 0.028).toFixed(2)}" rx="${(h * 0.008).toFixed(2)}" fill="${color}" opacity="${(0.5 + rng() * 0.35).toFixed(2)}"/>`);
    }
    return `<g opacity="${ctx.opacity}">
      <rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(W * 0.012).toFixed(1)}" fill="${p.ground}" stroke="${p.primary}" stroke-width="${(W * 0.0012).toFixed(2)}" opacity="0.9"/>
      <circle cx="${(x0 + W * 0.02).toFixed(1)}" cy="${(y0 + W * 0.015).toFixed(1)}" r="${(W * 0.004).toFixed(2)}" fill="${p.primary}" opacity="0.7"/>
      <circle cx="${(x0 + W * 0.035).toFixed(1)}" cy="${(y0 + W * 0.015).toFixed(1)}" r="${(W * 0.004).toFixed(2)}" fill="${p.accent}" opacity="0.7"/>
      <circle cx="${(x0 + W * 0.05).toFixed(1)}" cy="${(y0 + W * 0.015).toFixed(1)}" r="${(W * 0.004).toFixed(2)}" fill="${p.ink}" opacity="0.5"/>
      ${lines.join("")}
      <rect x="${(x0 + w * 0.06).toFixed(1)}" y="${(y0 + h * 0.88).toFixed(1)}" width="${(w * 0.012).toFixed(2)}" height="${(h * 0.06).toFixed(2)}" fill="${p.accent}" opacity="0.9"/>
    </g>`;
  },
  grid_wave: (ctx) => {
    const { W, H, palette: p } = ctx;
    const lines = [];
    const rows = 12;
    const cols = 16;
    const cx = W * 0.5;
    const cy = H * 0.55;
    for (let r = 0; r < rows; r++) {
      const pts = [];
      for (let c = 0; c < cols; c++) {
        const px = (c / (cols - 1)) * W;
        const py = H * 0.35 + (r / (rows - 1)) * H * 0.28;
        const dist = Math.hypot(px - cx, py - cy) / Math.max(W, H);
        const push = Math.sin(dist * 12 + r * 0.4) * H * 0.02 * (1 - r / rows);
        pts.push(`${px.toFixed(1)},${(py + push).toFixed(1)}`);
      }
      lines.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${r % 3 === 0 ? p.accent : p.primary}" stroke-width="${(W * 0.0008).toFixed(2)}" opacity="${(0.3 + (r / rows) * 0.4).toFixed(2)}"/>`);
    }
    for (let c = 0; c < cols; c += 2) {
      const px = (c / (cols - 1)) * W;
      lines.push(`<line x1="${px.toFixed(1)}" y1="${(H * 0.35).toFixed(1)}" x2="${px.toFixed(1)}" y2="${(H * 0.63).toFixed(1)}" stroke="${p.primary}" stroke-width="${(W * 0.0006).toFixed(2)}" opacity="0.18"/>`);
    }
    return `<g opacity="${ctx.opacity}">${lines.join("")}</g>`;
  },
  circuit: (ctx) => {
    const { W, H, palette: p, seed } = ctx;
    const rng = seededRandom(seed + "circ");
    const traces = [];
    for (let i = 0; i < 8; i++) {
      const y = H * (0.12 + i * 0.10);
      const x1 = W * (0.05 + rng() * 0.15);
      const x2 = W * (0.80 + rng() * 0.15);
      const midY = y + (rng() - 0.5) * H * 0.04;
      const midX = (x1 + x2) / 2;
      const color = i === 3 ? p.accent : p.primary;
      traces.push(`<path d="M${x1.toFixed(1)},${y.toFixed(1)} L${midX.toFixed(1)},${y.toFixed(1)} L${midX.toFixed(1)},${midY.toFixed(1)} L${x2.toFixed(1)},${midY.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${(W * 0.0012).toFixed(2)}" opacity="${(0.4 + rng() * 0.4).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`);
      traces.push(`<circle cx="${x1.toFixed(1)}" cy="${y.toFixed(1)}" r="${(W * 0.006).toFixed(2)}" fill="${color}" opacity="0.7"/>`);
      traces.push(`<circle cx="${x2.toFixed(1)}" cy="${midY.toFixed(1)}" r="${(W * 0.006).toFixed(2)}" fill="${color}" opacity="0.7"/>`);
    }
    return `<g opacity="${ctx.opacity}">${traces.join("")}</g>`;
  },
  skyline: (ctx) => {
    const { W, H, palette: p, seed, night } = ctx;
    const rng = seededRandom(seed + "sky");
    const baseY = H * 0.78;
    const buildings = [];
    let x = 0;
    while (x < W) {
      const bw = W * (0.06 + rng() * 0.08);
      const bh = H * (0.15 + rng() * 0.35);
      const tone = rng() > 0.5 ? p.primary : p.secondary;
      buildings.push(`<rect x="${x.toFixed(1)}" y="${(baseY - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${tone}" opacity="${(0.55 + rng() * 0.3).toFixed(2)}"/>`);
      if (rng() > 0.7) {
        buildings.push(`<line x1="${(x + bw / 2).toFixed(1)}" y1="${(baseY - bh).toFixed(1)}" x2="${(x + bw / 2).toFixed(1)}" y2="${(baseY - bh - H * 0.04).toFixed(1)}" stroke="${p.accent}" stroke-width="${(W * 0.0008).toFixed(2)}" opacity="0.7"/>`);
      }
      x += bw + W * 0.006;
    }
    const lit = [];
    if (night) {
      for (let i = 0; i < 12; i++) {
        lit.push(`<rect x="${(rng() * W).toFixed(1)}" y="${(baseY - H * (0.10 + rng() * 0.30)).toFixed(1)}" width="${(W * 0.005).toFixed(2)}" height="${(W * 0.005).toFixed(2)}" fill="${p.accent}" opacity="${(0.5 + rng() * 0.4).toFixed(2)}"/>`);
      }
    }
    return `<g opacity="${ctx.opacity}">${buildings.join("")}${lit.join("")}<line x1="0" y1="${baseY.toFixed(1)}" x2="${W}" y2="${baseY.toFixed(1)}" stroke="${p.accent}" stroke-width="${(W * 0.0015).toFixed(2)}" opacity="0.5"/></g>`;
  },
  soundwave: (ctx) => {
    const { W, H, palette: p, seed } = ctx;
    const rng = seededRandom(seed + "wave");
    const baseY = H * 0.68;
    const bars = [];
    const count = 24;
    for (let i = 0; i < count; i++) {
      const px = W * 0.06 + (i / (count - 1)) * W * 0.88;
      const bh = H * (0.02 + rng() * 0.20) * (0.5 + Math.sin(i / count * Math.PI) * 0.6);
      const bw = W * 0.014;
      const color = i % 6 === 3 ? p.accent : p.primary;
      bars.push(`<rect x="${(px - bw / 2).toFixed(1)}" y="${(baseY - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${(bw * 0.3).toFixed(2)}" fill="${color}" opacity="${(0.6 + rng() * 0.3).toFixed(2)}"/>`);
      bars.push(`<rect x="${(px - bw / 2).toFixed(1)}" y="${baseY.toFixed(1)}" width="${bw.toFixed(1)}" height="${(bh * 0.3).toFixed(1)}" rx="${(bw * 0.3).toFixed(2)}" fill="${color}" opacity="0.15"/>`);
    }
    return `<g opacity="${ctx.opacity}">${bars.join("")}</g>`;
  },
  vinyl: (ctx) => {
    const { W, H, palette: p } = ctx;
    const cx = W * 0.5;
    const cy = H * 0.5;
    const r = Math.min(W, H) * 0.30;
    const grooves = [];
    for (let i = 1; i <= 8; i++) {
      const gr = r * (0.35 + i * 0.08);
      grooves.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${gr.toFixed(1)}" fill="none" stroke="${p.ink}" stroke-width="${(W * 0.0006).toFixed(2)}" opacity="${(0.10 + i * 0.02).toFixed(2)}"/>`);
    }
    return `<g opacity="${ctx.opacity}">
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${p.ground}" opacity="0.9"/>
      ${grooves.join("")}
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 0.30).toFixed(1)}" fill="${p.primary}" opacity="0.9"/>
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 0.05).toFixed(1)}" fill="${p.ground}"/>
    </g>`;
  },
  stage_light: (ctx) => {
    const { W, H, palette: p, seed } = ctx;
    const rng = seededRandom(seed + "stage");
    const beams = [];
    for (let i = 0; i < 3; i++) {
      const originX = W * (0.20 + i * 0.30);
      const spread = W * 0.10;
      const color = [p.primary, p.accent, p.secondary][i];
      beams.push(`<polygon points="${originX.toFixed(1)},0 ${(originX - spread).toFixed(1)},${(H * 0.72).toFixed(1)} ${(originX + spread).toFixed(1)},${(H * 0.72).toFixed(1)}" fill="${color}" opacity="0.28"/>`);
    }
    const motes = [];
    for (let i = 0; i < 15; i++) {
      motes.push(`<circle cx="${(rng() * W).toFixed(1)}" cy="${(rng() * H * 0.72).toFixed(1)}" r="${(1 + rng() * 2).toFixed(1)}" fill="${p.accent}" opacity="${(0.3 + rng() * 0.5).toFixed(2)}"/>`);
    }
    const speaker = `<rect x="${(W * 0.06).toFixed(1)}" y="${(H * 0.62).toFixed(1)}" width="${(W * 0.10).toFixed(1)}" height="${(H * 0.16).toFixed(1)}" rx="${(W * 0.005).toFixed(1)}" fill="${p.ground}" stroke="${p.primary}" stroke-width="${(W * 0.0008).toFixed(2)}" opacity="0.9"/>
      <circle cx="${(W * 0.11).toFixed(1)}" cy="${(H * 0.68).toFixed(1)}" r="${(W * 0.025).toFixed(1)}" fill="${p.primary}" opacity="0.6"/>
      <circle cx="${(W * 0.11).toFixed(1)}" cy="${(H * 0.74).toFixed(1)}" r="${(W * 0.020).toFixed(1)}" fill="${p.accent}" opacity="0.5"/>`;
    return `<g opacity="${ctx.opacity}">${beams.join("")}${motes.join("")}${speaker}</g>`;
  },
  cassette: (ctx) => {
    const { W, H, palette: p } = ctx;
    const x0 = W * 0.18;
    const y0 = H * 0.32;
    const w = W * 0.64;
    const h = H * 0.32;
    const r1x = x0 + w * 0.30;
    const r2x = x0 + w * 0.70;
    const ry = y0 + h * 0.58;
    return `<g opacity="${ctx.opacity}">
      <rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(W * 0.012).toFixed(1)}" fill="${p.ground}" stroke="${p.primary}" stroke-width="${(W * 0.0012).toFixed(2)}" opacity="0.9"/>
      <rect x="${(x0 + w * 0.08).toFixed(1)}" y="${(y0 + h * 0.10).toFixed(1)}" width="${(w * 0.84).toFixed(1)}" height="${(h * 0.40).toFixed(1)}" rx="${(W * 0.006).toFixed(1)}" fill="${p.primary}" opacity="0.25"/>
      <circle cx="${r1x.toFixed(1)}" cy="${ry.toFixed(1)}" r="${(w * 0.10).toFixed(1)}" fill="none" stroke="${p.accent}" stroke-width="${(W * 0.0018).toFixed(2)}" opacity="0.9"/>
      <circle cx="${r2x.toFixed(1)}" cy="${ry.toFixed(1)}" r="${(w * 0.10).toFixed(1)}" fill="none" stroke="${p.accent}" stroke-width="${(W * 0.0018).toFixed(2)}" opacity="0.9"/>
      <circle cx="${r1x.toFixed(1)}" cy="${ry.toFixed(1)}" r="${(w * 0.02).toFixed(1)}" fill="${p.primary}"/>
      <circle cx="${r2x.toFixed(1)}" cy="${ry.toFixed(1)}" r="${(w * 0.02).toFixed(1)}" fill="${p.primary}"/>
      <rect x="${(x0 + w * 0.10).toFixed(1)}" y="${(y0 + h * 0.80).toFixed(1)}" width="${(w * 0.60).toFixed(1)}" height="${(h * 0.08).toFixed(1)}" rx="${(W * 0.003).toFixed(1)}" fill="${p.primary}" opacity="0.4"/>
    </g>`;
  },
  window_sill: (ctx) => {
    const { W, H, palette: p, night } = ctx;
    const x0 = W * 0.18;
    const y0 = H * 0.10;
    const w = W * 0.64;
    const h = H * 0.50;
    const frame = `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(W * 0.006).toFixed(1)}" fill="${p.sky}" stroke="${p.primary}" stroke-width="${(W * 0.0020).toFixed(2)}" opacity="0.9"/>
      <line x1="${(x0 + w / 2).toFixed(1)}" y1="${y0.toFixed(1)}" x2="${(x0 + w / 2).toFixed(1)}" y2="${(y0 + h).toFixed(1)}" stroke="${p.primary}" stroke-width="${(W * 0.0016).toFixed(2)}" opacity="0.7"/>
      <line x1="${x0.toFixed(1)}" y1="${(y0 + h * 0.55).toFixed(1)}" x2="${(x0 + w).toFixed(1)}" y2="${(y0 + h * 0.55).toFixed(1)}" stroke="${p.primary}" stroke-width="${(W * 0.0016).toFixed(2)}" opacity="0.7"/>`;
    const sun = night
      ? `<circle cx="${(x0 + w * 0.75).toFixed(1)}" cy="${(y0 + h * 0.30).toFixed(1)}" r="${(W * 0.018).toFixed(1)}" fill="${p.accent}" opacity="0.85"/>`
      : `<circle cx="${(x0 + w * 0.70).toFixed(1)}" cy="${(y0 + h * 0.30).toFixed(1)}" r="${(W * 0.022).toFixed(1)}" fill="${p.accent}" opacity="0.9"/>`;
    const plant = `<line x1="${(x0 + w * 0.20).toFixed(1)}" y1="${(y0 + h).toFixed(1)}" x2="${(x0 + w * 0.20).toFixed(1)}" y2="${(y0 + h * 0.82).toFixed(1)}" stroke="${p.primary}" stroke-width="${(W * 0.0018).toFixed(2)}" opacity="0.8"/>
      <ellipse cx="${(x0 + w * 0.16).toFixed(1)}" cy="${(y0 + h * 0.80).toFixed(1)}" rx="${(W * 0.020).toFixed(1)}" ry="${(W * 0.008).toFixed(1)}" fill="${p.primary}" opacity="0.7" transform="rotate(-20 ${(x0 + w * 0.16).toFixed(1)} ${(y0 + h * 0.80).toFixed(1)})"/>
      <ellipse cx="${(x0 + w * 0.24).toFixed(1)}" cy="${(y0 + h * 0.82).toFixed(1)}" rx="${(W * 0.020).toFixed(1)}" ry="${(W * 0.008).toFixed(1)}" fill="${p.primary}" opacity="0.7" transform="rotate(20 ${(x0 + w * 0.24).toFixed(1)} ${(y0 + h * 0.82).toFixed(1)})"/>`;
    const sill = `<rect x="${(W * 0.14).toFixed(1)}" y="${(y0 + h).toFixed(1)}" width="${(W * 0.72).toFixed(1)}" height="${(H * 0.05).toFixed(1)}" fill="${p.ground}" opacity="0.9"/>`;
    return `<g opacity="${ctx.opacity}">${frame}${sun}${plant}${sill}</g>`;
  },
  shelf: (ctx) => {
    const { W, H, palette: p, seed } = ctx;
    const rng = seededRandom(seed + "shelf");
    const shelves = [];
    for (let s = 0; s < 2; s++) {
      const sy = H * (0.30 + s * 0.28);
      shelves.push(`<rect x="${(W * 0.10).toFixed(1)}" y="${sy.toFixed(1)}" width="${(W * 0.80).toFixed(1)}" height="${(H * 0.012).toFixed(1)}" fill="${p.primary}" opacity="0.5"/>`);
      let x = W * 0.14;
      while (x < W * 0.86) {
        const iw = W * (0.03 + rng() * 0.03);
        const ih = H * (0.06 + rng() * 0.06);
        const tone = rng() > 0.6 ? p.accent : p.primary;
        shelves.push(`<rect x="${x.toFixed(1)}" y="${(sy - ih).toFixed(1)}" width="${iw.toFixed(1)}" height="${ih.toFixed(1)}" rx="${(W * 0.002).toFixed(1)}" fill="${tone}" opacity="${(0.5 + rng() * 0.4).toFixed(2)}"/>`);
        x += iw + W * 0.006;
      }
    }
    return `<g opacity="${ctx.opacity}">${shelves.join("")}</g>`;
  },
  rooftop: (ctx) => {
    const { W, H, palette: p, night } = ctx;
    const baseY = H * 0.68;
    const string = [];
    for (let i = 0; i < 8; i++) {
      const x = W * 0.08 + i * (W * 0.84 / 7);
      string.push(`<circle cx="${x.toFixed(1)}" cy="${(baseY - H * 0.20 - Math.sin(i / 7 * Math.PI) * H * 0.02).toFixed(1)}" r="${(W * 0.006).toFixed(2)}" fill="${p.accent}" opacity="0.9"/>`);
    }
    return `<g opacity="${ctx.opacity}">
      ${night ? `<circle cx="${(W * 0.78).toFixed(1)}" cy="${(H * 0.20).toFixed(1)}" r="${(W * 0.04).toFixed(1)}" fill="${p.accent}" opacity="0.7"/>` : `<circle cx="${(W * 0.72).toFixed(1)}" cy="${(H * 0.24).toFixed(1)}" r="${(W * 0.06).toFixed(1)}" fill="${p.accent}" opacity="0.55"/>`}
      <line x1="${(W * 0.08).toFixed(1)}" y1="${(baseY - H * 0.20).toFixed(1)}" x2="${(W * 0.92).toFixed(1)}" y2="${(baseY - H * 0.20).toFixed(1)}" stroke="${p.primary}" stroke-width="${(W * 0.0010).toFixed(2)}" opacity="0.4"/>
      ${string.join("")}
      <rect x="${(W * 0.06).toFixed(1)}" y="${baseY.toFixed(1)}" width="${(W * 0.88).toFixed(1)}" height="${(H * 0.16).toFixed(1)}" fill="${p.ground}" opacity="0.9"/>
      <rect x="${(W * 0.20).toFixed(1)}" y="${(baseY - H * 0.06).toFixed(1)}" width="${(W * 0.16).toFixed(1)}" height="${(H * 0.10).toFixed(1)}" rx="${(W * 0.004).toFixed(1)}" fill="${p.primary}" opacity="0.65"/>
      <rect x="${(W * 0.24).toFixed(1)}" y="${(baseY - H * 0.045).toFixed(1)}" width="${(W * 0.10).toFixed(1)}" height="${(H * 0.012).toFixed(1)}" fill="${p.accent}" opacity="0.6"/>
    </g>`;
  },
  ribbon: (ctx) => {
    const { W, H, palette: p } = ctx;
    const path = `M${(W * 0.05).toFixed(1)},${(H * 0.60).toFixed(1)} C${(W * 0.25).toFixed(1)},${(H * 0.30).toFixed(1)} ${(W * 0.45).toFixed(1)},${(H * 0.75).toFixed(1)} ${(W * 0.65).toFixed(1)},${(H * 0.45).toFixed(1)} C${(W * 0.85).toFixed(1)},${(H * 0.20).toFixed(1)} ${(W * 0.95).toFixed(1)},${(H * 0.55).toFixed(1)} ${(W * 1.05).toFixed(1)},${(H * 0.40).toFixed(1)}`;
    return `<g opacity="${ctx.opacity}">
      <defs><linearGradient id="ribbon-grad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="${p.primary}"/>
        <stop offset="0.5" stop-color="${p.accent}"/>
        <stop offset="1" stop-color="${p.secondary}"/>
      </linearGradient></defs>
      <path d="${path}" fill="none" stroke="url(#ribbon-grad)" stroke-width="${(W * 0.08).toFixed(1)}" stroke-linecap="round" opacity="0.85"/>
      <path d="${path}" fill="none" stroke="${p.ink}" stroke-width="${(W * 0.002).toFixed(1)}" opacity="0.25"/>
    </g>`;
  },
  glass_cards: (ctx) => {
    const { W, H, palette: p } = ctx;
    const cards = [
      { x: 0.15, y: 0.30, r: -12, o: 0.55 },
      { x: 0.30, y: 0.42, r: -6, o: 0.65 },
      { x: 0.45, y: 0.54, r: 0, o: 0.75 },
    ];
    const els = cards.map((c, i) => {
      const cw = W * 0.42;
      const ch = H * 0.24;
      return `<g transform="translate(${(W * c.x).toFixed(1)},${(H * c.y).toFixed(1)}) rotate(${c.r})">
        <rect width="${cw.toFixed(1)}" height="${ch.toFixed(1)}" rx="${(W * 0.012).toFixed(1)}" fill="${i === 2 ? p.primary : p.ink}" opacity="${c.o}"/>
        <rect width="${cw.toFixed(1)}" height="${ch.toFixed(1)}" rx="${(W * 0.012).toFixed(1)}" fill="none" stroke="${p.accent}" stroke-width="${(W * 0.0012).toFixed(2)}" opacity="0.4"/>
        <line x1="${(cw * 0.08).toFixed(1)}" y1="${(ch * 0.30).toFixed(1)}" x2="${(cw * 0.62).toFixed(1)}" y2="${(ch * 0.30).toFixed(1)}" stroke="${p.accent}" stroke-width="${(W * 0.0016).toFixed(2)}" opacity="0.6"/>
        <line x1="${(cw * 0.08).toFixed(1)}" y1="${(ch * 0.50).toFixed(1)}" x2="${(cw * 0.45).toFixed(1)}" y2="${(ch * 0.50).toFixed(1)}" stroke="${p.accent}" stroke-width="${(W * 0.0012).toFixed(2)}" opacity="0.4"/>
      </g>`;
    });
    return `<g opacity="${ctx.opacity}">${els.join("")}</g>`;
  },
  halftone: (ctx) => {
    const { W, H, palette: p, seed } = ctx;
    const rng = seededRandom(seed + "half");
    const cols = 14;
    const rows = 14;
    const dots = [];
    const cx = W * 0.5;
    const cy = H * 0.5;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const px = (c + 0.5) / cols * W;
        const py = (r + 0.5) / rows * H;
        const dist = Math.hypot(px - cx, py - cy) / Math.max(W, H);
        const rad = Math.max(0.5, (1 - dist * 1.6) * W * 0.014);
        const op = Math.max(0.05, 0.7 - dist * 0.8);
        dots.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${rad.toFixed(2)}" fill="${p.primary}" opacity="${op.toFixed(2)}"/>`);
      }
    }
    const accentX = W * (0.20 + rng() * 0.60);
    const accentY = H * (0.20 + rng() * 0.60);
    dots.push(`<circle cx="${accentX.toFixed(1)}" cy="${accentY.toFixed(1)}" r="${(W * 0.024).toFixed(1)}" fill="${p.accent}" opacity="0.85"/>`);
    return `<g opacity="${ctx.opacity}">${dots.join("")}</g>`;
  },
};

const SCENE_META = {
  paper_stack:     { label: "Paper Stack",      group: "editorial", hasNight: false },
  newspaper_fold:  { label: "Newspaper Fold",   group: "editorial", hasNight: false },
  type_specimen:   { label: "Type Specimen",    group: "editorial", hasNight: false },
  book_spine:      { label: "Book Spine",       group: "editorial", hasNight: false },
  terminal:        { label: "Terminal",         group: "tech",      hasNight: false },
  grid_wave:       { label: "Grid Wave",        group: "tech",      hasNight: false },
  circuit:         { label: "Circuit",          group: "tech",      hasNight: false },
  skyline:         { label: "Skyline",          group: "tech",      hasNight: true  },
  soundwave:       { label: "Soundwave",        group: "music",     hasNight: false },
  vinyl:           { label: "Vinyl",            group: "music",     hasNight: false },
  stage_light:     { label: "Stage Light",      group: "music",     hasNight: false },
  cassette:        { label: "Cassette",         group: "music",     hasNight: false },
  window_sill:     { label: "Window Sill",      group: "home",      hasNight: true  },
  shelf:           { label: "Shelf",            group: "home",      hasNight: false },
  rooftop:         { label: "Rooftop",          group: "home",      hasNight: true  },
  ribbon:          { label: "Ribbon",           group: "abstract",  hasNight: false },
  glass_cards:     { label: "Glass Cards",      group: "abstract",  hasNight: false },
  halftone:        { label: "Halftone",         group: "abstract",  hasNight: false },
};

const SCENE_IDS = Object.keys(SCENES);

const SCENE_AFFINITY = {
  "scene-poster":       ["skyline", "ribbon", "grid_wave", "terminal", "stage_light"],
  "scene-card":         ["shelf", "window_sill", "vinyl", "glass_cards", "paper_stack"],
  "strip-bottom":       ["soundwave", "halftone", "newspaper_fold", "rooftop"],
  "hero-short":         ["ribbon", "halftone", "grid_wave", "type_specimen"],
  "poster-centered":    ["ribbon", "skyline", "type_specimen", "halftone"],
  "quote-card":         ["ribbon", "glass_cards", "paper_stack"],
  "stat-hero":          ["grid_wave", "circuit", "halftone"],
  "newspaper-classic":  ["newspaper_fold", "paper_stack", "type_specimen"],
  "event-poster":       ["stage_light", "cassette", "soundwave"],
  "random-lines-top":   ["halftone", "grid_wave", "ribbon"],
  "product-grid-2":     ["shelf", "glass_cards", "paper_stack"],
  "feature-image-top":  ["window_sill", "shelf", "rooftop"],
  "split-image-side":   ["rooftop", "shelf", "skyline"],
  "image-badge-overlay":["vinyl", "circuit", "grid_wave"],
  "image-shadow-bottom":["skyline", "rooftop", "window_sill"],
  "image-blur-text":    ["ribbon", "halftone", "glass_cards"],
  "image-card-side-text":["shelf", "window_sill", "vinyl"],
  "browser-frame":      ["ribbon", "grid_wave", "halftone", "glass_cards"],
};

function pickScene(seed, template, explicit) {
  if (explicit === false) return null;
  if (explicit === "none") return null;
  if (typeof explicit === "string" && SCENES[explicit]) return explicit;
  if (explicit === "random") {
    return SCENE_IDS[Math.floor(Math.random() * SCENE_IDS.length)];
  }
  const pool = SCENE_AFFINITY[template] || SCENE_IDS;
  let h = 0;
  const s = String(seed || template || "x");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return pool[Math.abs(h) % pool.length];
}

function sceneSafe(W, H) {
  return { centerX: W * 0.5, centerY: H * 0.5, quietTop: H * 0.30, quietBottom: H * 0.70 };
}

// ═══════════════════════════════════════════════════════════════════
//  SEEDED RNG + HASH
// ═══════════════════════════════════════════════════════════════════

function seededRandom(seed) {
  let s = 0;
  const str = String(seed || "x");
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

function stableHash(str) {
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ═══════════════════════════════════════════════════════════════════
//  TEXT MEASUREMENT + LAYOUT
// ═══════════════════════════════════════════════════════════════════

const WEIGHT_NUM = { regular: 400, medium: 500, bold: 700, black: 900 };

function textTracking(size, weight) {
  if (weight === "black") return -size * 0.022;
  if (weight === "bold") return -size * 0.012;
  return size * 0.005;
}

function measureText(str, size, weight = "regular", letterSpacing = null) {
  const s = String(str ?? "");
  if (!s) return 0;
  const tracking = letterSpacing != null ? Number(letterSpacing) : textTracking(size, weight);
  if (fontFamily) {
    const ratio = weight === "black" ? 0.56 : weight === "bold" ? 0.54 : weight === "medium" ? 0.52 : 0.50;
    return s.length * size * ratio + (s.length - 1) * tracking;
  }
  let w = 0;
  for (const ch of s) w += glyphFor(ch).w * size + tracking;
  return Math.max(0, w - tracking);
}

function fitText(text, maxWidth, maxSize, weight = "regular", minSize = 12) {
  const str = String(text ?? "");
  if (!str) return maxSize;
  let size = maxSize;
  while (size > minSize && measureText(str, size, weight) > maxWidth) size -= 1;
  return size;
}

function wrapToWidth(text, maxWidth, size, weight = "regular") {
  const str = String(text ?? "");
  if (!str) return [];
  const words = str.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (measureText(candidate, size, weight) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) { lines.push(line); line = ""; }
    if (measureText(w, size, weight) <= maxWidth) { line = w; continue; }
    let remaining = w;
    while (remaining.length > 0) {
      let cut = remaining.length;
      while (cut > 1 && measureText(remaining.slice(0, cut), size, weight) > maxWidth) cut--;
      lines.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines;
}

function safeArea(W, H) {
  const pad = Math.max(Math.round(Math.min(W, H) * 0.075), 24);
  return { pad, top: pad, bottom: pad, left: pad, right: pad };
}

function typeScale(H, base = "poster") {
  if (base === "compact") {
    return {
      display: Math.round(H * 0.16),
      headline: Math.round(H * 0.062),
      sub: Math.round(H * 0.026),
      body: Math.round(H * 0.019),
      caption: Math.round(H * 0.016),
      kicker: Math.round(H * 0.018),
      label: Math.round(H * 0.014),
    };
  }
  return {
    display: Math.round(H * 0.24),
    headline: Math.round(H * 0.078),
    sub: Math.round(H * 0.030),
    body: Math.round(H * 0.021),
    caption: Math.round(H * 0.018),
    kicker: Math.round(H * 0.020),
    label: Math.round(H * 0.016),
  };
}

function applyHeadlineCase(text, mode) {
  if (!text) return text;
  const str = String(text);
  switch (mode) {
    case "upper": return str.toUpperCase();
    case "title": return str.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    case "sentence": return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    case "auto": {
      const wc = str.trim().split(/\s+/).filter(Boolean).length;
      if (wc <= 3) return str.toUpperCase();
      if (wc <= 6) return str.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
      return str;
    }
    default: return str;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  WATERMARK
// ═══════════════════════════════════════════════════════════════════

function watermark(dims, theme) {
  const { w: W, h: H } = dims;
  const minEdge = Math.min(W, H);
  const isLight = theme.variant === "light";
  const isCompact = minEdge < 512;

  const inset = Math.max(Math.round(minEdge * 0.035), 16);
  const markSize = Math.round(minEdge * (isCompact ? 0.060 : 0.052));
  const wordSize = Math.round(markSize * 0.42);
  const gap = Math.round(markSize * 0.30);
  const wordText = "FOLIO";
  const wordWidth = measureText(wordText, wordSize, "black", wordSize * 0.14);

  const markX = W - inset - markSize;
  const markY = H - inset - markSize;
  const wordX = markX - gap;
  const wordY = markY + markSize * 0.5 + wordSize * 0.35;

  const strokeA = isLight ? theme.colors.primary : theme.colors.accent;
  const strokeB = isLight ? theme.colors.accent : theme.colors.primary;
  const markText = isLight ? "#0f0f12" : "#ffffff";
  const wordColor = isLight ? "rgba(15,15,18,0.62)" : "rgba(255,255,255,0.72)";

  const monogramH = Math.round(markSize * 0.62);
  const fGlyph = GLYPHS["F"];
  const fPaths = [];
  const fCursorX = markX + markSize * 0.5 - (fGlyph.w * monogramH) * 0.5;
  const fBaseY = markY + markSize * 0.5 + monogramH * 0.5;
  for (const poly of fGlyph.s) {
    let d = "";
    for (const seg of poly) {
      if (seg[0] === "M") d += `M${(fCursorX + seg[1] * monogramH).toFixed(2)},${(fBaseY - seg[2] * monogramH).toFixed(2)} `;
      else if (seg[0] === "L") d += `L${(fCursorX + seg[1] * monogramH).toFixed(2)},${(fBaseY - seg[2] * monogramH).toFixed(2)} `;
      else if (seg[0] === "C") d +=
        `C${(fCursorX + seg[1] * monogramH).toFixed(2)},${(fBaseY - seg[2] * monogramH).toFixed(2)} ` +
        `${(fCursorX + seg[3] * monogramH).toFixed(2)},${(fBaseY - seg[4] * monogramH).toFixed(2)} ` +
        `${(fCursorX + seg[5] * monogramH).toFixed(2)},${(fBaseY - seg[6] * monogramH).toFixed(2)} `;
    }
    fPaths.push(`<path d="${d.trim()}" fill="none" stroke="${markText}" stroke-width="${(monogramH * 0.10).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }

  const gradId = `wm-g-${stableHash(theme.colors.primary + theme.colors.accent)}`;
  const grad = `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${strokeA}"/>
    <stop offset="1" stop-color="${strokeB}"/>
  </linearGradient></defs>`;

  const backdrop = isCompact ? "" : (() => {
    const bx = wordX - minEdge * 0.03;
    const by = markY - minEdge * 0.04;
    const bw = (markX + markSize - bx) + minEdge * 0.06;
    const bh = (markY + markSize - by) + minEdge * 0.06;
    const bId = `wm-b-${stableHash(theme.colors.primary)}`;
    return `<defs><radialGradient id="${bId}" cx="0.5" cy="0.5" r="0.6">
      <stop offset="0" stop-color="${isLight ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)"}"/>
      <stop offset="1" stop-color="${isLight ? "rgba(255,255,255,0)" : "rgba(0,0,0,0)"}"/>
    </radialGradient></defs>
    <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${(bh / 2).toFixed(1)}" fill="url(#${bId})"/>`;
  })();

  const markRect = `<rect x="${markX.toFixed(1)}" y="${markY.toFixed(1)}" width="${markSize.toFixed(1)}" height="${markSize.toFixed(1)}" rx="${(markSize * 0.22).toFixed(1)}" fill="none" stroke="url(#${gradId})" stroke-width="${Math.max(1.5, markSize * 0.075).toFixed(2)}"/>`;

  const wordEl = isCompact ? "" : `<text x="${wordX.toFixed(1)}" y="${wordY.toFixed(1)}" font-family="${fontFamily || "FlierSans"}" font-size="${wordSize}" font-weight="900" letter-spacing="${(wordSize * 0.14).toFixed(2)}" text-anchor="end" fill="${wordColor}">${wordText}</text>`;

  return `<g>${grad}${backdrop}${markRect}${fPaths.join("")}${wordEl}</g>`;
}

// ═══════════════════════════════════════════════════════════════════
//  TEXT RENDERING
// ═══════════════════════════════════════════════════════════════════

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function escAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function textNode({ x, y, text, anchor = "start", size, weight = "regular", fill, letterSpacing = null, opacity = null, style = null, family = null, fillOpacity = null }) {
  const str = String(text ?? "");
  if (!str) return "";
  const op = opacity != null ? ` opacity="${opacity}"` : "";
  const italic = style === "italic" ? ` font-style="italic"` : "";
  const fillOp = fillOpacity != null ? ` fill-opacity="${fillOpacity}"` : "";

  if (fontFamily) {
    const fw = WEIGHT_NUM[weight] || 400;
    const tracking = letterSpacing != null ? Number(letterSpacing) : textTracking(size, weight);
    const lsAttr = tracking !== 0 ? ` letter-spacing="${tracking.toFixed(2)}"` : "";
    return `<text x="${x}" y="${y}" font-family="${escAttr(family || fontFamily)}" font-size="${size}" font-weight="${fw}"${italic}${lsAttr} text-anchor="${anchor}" fill="${escAttr(fill)}"${fillOp}${op}>${esc(str)}</text>`;
  }

  const tracking = letterSpacing != null ? Number(letterSpacing) : textTracking(size, weight);
  const totalWidth = measureText(str, size, weight, tracking);

  let cursor = x;
  if (anchor === "middle") cursor = x - totalWidth / 2;
  else if (anchor === "end") cursor = x - totalWidth;

  const baseStroke = weight === "black" ? 0.100 : weight === "bold" ? 0.085 : weight === "medium" ? 0.072 : 0.060;
  const optical = 1 + 0.12 * Math.log2(Math.max(8, size) / 40);
  const strokeWidth = Math.max(1, size * baseStroke * optical);

  const parts = [];
  const transform = style === "italic" ? ` transform="skewX(-12)"` : "";
  parts.push(`<g${op}${transform}>`);

  for (const ch of str) {
    const g = glyphFor(ch);
    for (const poly of g.s) {
      if (!poly.length) continue;
      let d = "";
      for (const seg of poly) {
        if (seg[0] === "M") d += `M${(cursor + seg[1] * size).toFixed(2)},${(y - seg[2] * size).toFixed(2)} `;
        else if (seg[0] === "L") d += `L${(cursor + seg[1] * size).toFixed(2)},${(y - seg[2] * size).toFixed(2)} `;
        else if (seg[0] === "C") d +=
          `C${(cursor + seg[1] * size).toFixed(2)},${(y - seg[2] * size).toFixed(2)} ` +
          `${(cursor + seg[3] * size).toFixed(2)},${(y - seg[4] * size).toFixed(2)} ` +
          `${(cursor + seg[5] * size).toFixed(2)},${(y - seg[6] * size).toFixed(2)} `;
      }
      parts.push(`<path d="${d.trim()}" fill="none" stroke="${escAttr(fill)}" stroke-width="${strokeWidth.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"${fillOp}/>`);
    }
    cursor += g.w * size + tracking;
  }
  parts.push(`</g>`);
  return parts.join("");
}

function layoutStack(blocks, opts) {
  const { x = 0, anchor = "start", cursorY = 0 } = opts || {};
  const nodes = [];
  let y = cursorY;
  let lastSize = 0;
  for (const block of blocks) {
    const { lines, size, weight = "regular", fill, lineHeight = 1.15, gapBefore = 0, gapAfter = 0, letterSpacing = null } = block;
    if (!lines || lines.length === 0) continue;
    y += gapBefore;
    if (lastSize > 0) y += lastSize * 0.2;
    for (const line of lines) {
      y += size * lineHeight;
      nodes.push(textNode({ x, y, text: line, anchor, size, weight, fill, letterSpacing }));
    }
    y += gapAfter;
    lastSize = size;
  }
  return { nodes, height: y - cursorY, cursorY: y };
}

// ═══════════════════════════════════════════════════════════════════
//  CORS + AUTH
// ═══════════════════════════════════════════════════════════════════

function isOriginAllowed(origin, req) {
  const auth = req.headers.authorization;
  const key = req.headers["x-api-key"];
  if (auth?.startsWith("Bearer ") && auth.slice(7) === ADMIN_API_KEY) return true;
  if (key && key === ADMIN_API_KEY) return true;
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    if (ALLOWED_DOMAINS.some((d) => h === d || h.endsWith("." + d))) return true;
    if (h === "localhost" || h === "127.0.0.1") return true;
    if (LOCAL_PATTERN.test(u.host.toLowerCase())) return true;
    return false;
  } catch { return false; }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!isOriginAllowed(origin, req)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

function isAdmin(req) {
  const auth = req.headers.authorization;
  const key = req.headers["x-api-key"];
  return key === ADMIN_API_KEY ||
    (auth?.startsWith("Bearer ") && auth.slice(7) === ADMIN_API_KEY);
}

function tryVerifyJwt(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return { uid: null, isAuth: false };
  try {
    const decoded = verifySession(authHeader.slice(7).trim());
    if (decoded && decoded.uid) return { uid: decoded.uid, isAuth: true };
  } catch {}
  return { uid: null, isAuth: false };
}

// ═══════════════════════════════════════════════════════════════════
//  RATE LIMITS
// ═══════════════════════════════════════════════════════════════════

const RL = new Map();
const AVATAR_RL = new Map();
const AVATAR_CUSTOM_RL = new Map();
const RL_GENERATE_IP = new Map();
const RL_GENERATE_UID = new Map();
const RL_UPLOAD_IP = new Map();
const RL_UPLOAD_UID = new Map();
const RL_THUMB_IP = new Map();

function rateLimit(id, max) {
  const now = Date.now();
  let b = RL.get(id);
  if (!b || now - b.start > RATE_WINDOW_MS) { b = { count: 0, start: now }; RL.set(id, b); }
  b.count++;
  if (RL.size > 5000) { const first = RL.keys().next().value; if (first) RL.delete(first); }
  return { ok: b.count <= max, remaining: Math.max(0, max - b.count), limit: max };
}

function avatarRateLimit(id) {
  const now = Date.now();
  let b = AVATAR_RL.get(id);
  if (!b || now - b.start > AVATAR_RATE_WINDOW_MS) { b = { count: 0, start: now }; AVATAR_RL.set(id, b); }
  b.count++;
  if (AVATAR_RL.size > 5000) { const first = AVATAR_RL.keys().next().value; if (first) AVATAR_RL.delete(first); }
  return { ok: b.count <= AVATAR_RATE_LIMIT_IP, remaining: Math.max(0, AVATAR_RATE_LIMIT_IP - b.count), limit: AVATAR_RATE_LIMIT_IP };
}

function avatarCustomRateLimit(uid) {
  const now = Date.now();
  let b = AVATAR_CUSTOM_RL.get(uid);
  if (!b || now - b.start > AVATAR_CUSTOM_RATE_WINDOW_MS) {
    b = { count: 0, start: now };
    AVATAR_CUSTOM_RL.set(uid, b);
  }
  b.count++;
  if (AVATAR_CUSTOM_RL.size > 5000) {
    const first = AVATAR_CUSTOM_RL.keys().next().value;
    if (first) AVATAR_CUSTOM_RL.delete(first);
  }
  const resetAt = b.start + AVATAR_CUSTOM_RATE_WINDOW_MS;
  return {
    ok: b.count <= AVATAR_CUSTOM_RATE_LIMIT_UID,
    remaining: Math.max(0, AVATAR_CUSTOM_RATE_LIMIT_UID - b.count),
    limit: AVATAR_CUSTOM_RATE_LIMIT_UID,
    resetAt: new Date(resetAt).toISOString(),
  };
}

function checkDailyQuota(map, key, limit) {
  const now = Date.now();
  let b = map.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + DAY_MS };
    map.set(key, b);
  }
  b.count++;
  const ok = b.count <= limit;
  return {
    ok,
    limit,
    remaining: Math.max(0, limit - b.count),
    resetAt: new Date(b.resetAt).toISOString(),
  };
}

function thumbRateLimit(id) {
  const now = Date.now();
  let b = RL_THUMB_IP.get(id);
  if (!b || now - b.start > THUMB_RATE_WINDOW_MS) { b = { count: 0, start: now }; RL_THUMB_IP.set(id, b); }
  b.count++;
  if (RL_THUMB_IP.size > 5000) { const first = RL_THUMB_IP.keys().next().value; if (first) RL_THUMB_IP.delete(first); }
  return {
    ok: b.count <= THUMB_RATE_LIMIT_IP,
    remaining: Math.max(0, THUMB_RATE_LIMIT_IP - b.count),
    limit: THUMB_RATE_LIMIT_IP,
    resetAt: new Date(b.start + THUMB_RATE_WINDOW_MS).toISOString(),
  };
}

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.headers["x-real-ip"]
    || req.socket?.remoteAddress
    || "unknown";
}

function ipHash(req) {
  return crypto.createHash("sha256").update(clientIp(req)).digest("hex").slice(0, 16);
}

function keyHash(req) {
  const raw = String(req.headers["x-api-key"] || req.headers.authorization || "");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function setRateHeaders(res, rl, bucket, scope) {
  if (!rl) return;
  res.setHeader("X-RateLimit-Limit", String(rl.limit));
  res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  if (rl.resetAt) res.setHeader("X-RateLimit-Reset", rl.resetAt);
  if (bucket) res.setHeader("X-RateLimit-Bucket", bucket);
  if (scope) res.setHeader("X-RateLimit-Scope", scope);
}

if (typeof setInterval === "function") {
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const map of [RL, AVATAR_RL, AVATAR_CUSTOM_RL, RL_GENERATE_IP, RL_GENERATE_UID, RL_UPLOAD_IP, RL_UPLOAD_UID, RL_THUMB_IP]) {
      for (const [key, bucket] of map) {
        const resetAt = bucket.resetAt ? new Date(bucket.resetAt).getTime() : (bucket.start + RATE_WINDOW_MS);
        if (now >= resetAt + RATE_WINDOW_MS) map.delete(key);
      }
    }
  }, 10 * 60 * 1000);
  if (sweep.unref) sweep.unref();
}

// ═══════════════════════════════════════════════════════════════════
//  CACHES
// ═══════════════════════════════════════════════════════════════════

const previewCache = new Map();
const IMAGE_CACHE = new Map();
const AVATAR_CACHE = new Map();
const THUMB_CACHE = new Map();
const SCENE_CACHE = new Map();

function canonicalize(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
  return out;
}
function cacheKey(obj) { return crypto.createHash("sha256").update(JSON.stringify(canonicalize(obj))).digest("hex"); }

function lruGet(map, key, ttl) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > ttl) { map.delete(key); return null; }
  map.delete(key);
  map.set(key, entry);
  return entry.v;
}
function lruSet(map, key, value, max) {
  if (map.size >= max) { const first = map.keys().next().value; if (first) map.delete(first); }
  map.set(key, { v: value, t: Date.now() });
}
function cacheGet(key) { return lruGet(previewCache, key, PREVIEW_CACHE_TTL); }
function cacheSet(key, value) { lruSet(previewCache, key, value, PREVIEW_CACHE_MAX); }
function imageCacheGet(key) { return lruGet(IMAGE_CACHE, key, IMAGE_CACHE_TTL); }
function imageCacheSet(key, value) { lruSet(IMAGE_CACHE, key, value, IMAGE_CACHE_MAX); }
function avatarCacheGet(key) { return lruGet(AVATAR_CACHE, key, AVATAR_CACHE_TTL); }
function avatarCacheSet(key, value) { lruSet(AVATAR_CACHE, key, value, AVATAR_CACHE_MAX); }
function thumbCacheGet(key) { return lruGet(THUMB_CACHE, key, THUMB_CACHE_TTL); }
function thumbCacheSet(key, value) { lruSet(THUMB_CACHE, key, value, THUMB_CACHE_MAX); }
function sceneCacheGet(key) { return lruGet(SCENE_CACHE, key, SCENE_CACHE_TTL); }
function sceneCacheSet(key, value) { lruSet(SCENE_CACHE, key, value, SCENE_CACHE_MAX); }

// ═══════════════════════════════════════════════════════════════════
//  SANITIZE
// ═══════════════════════════════════════════════════════════════════

function cleanText(v, max) {
  if (v == null) return "";
  return String(v).replace(/[\x00-\x1F\x7F]/g, " ").trim().slice(0, max);
}
function cleanColor(v, fallback) {
  if (!v) return fallback;
  const s = String(v).trim();
  if (/^[a-zA-Z0-9#(),.%\s-]+$/.test(s) && s.length <= 40) return s;
  return fallback;
}
function cleanSize(v) { return SIZES[v] ? v : "1080x1080"; }
function cleanFont() { return "FlierSans"; }
function cleanAlign(v) { return ["left", "center", "right"].includes(v) ? v : "center"; }
function cleanNumber(v, min, max, fallback) { const n = Number(v); return !Number.isFinite(n) ? fallback : Math.max(min, Math.min(max, n)); }
function cleanBool(v, fallback = false) { if (typeof v === "boolean") return v; if (v === "true") return true; if (v === "false") return false; return fallback; }
function cleanVariant(v) { return ["dark", "light", "auto"].includes(v) ? v : "dark"; }
function cleanPattern(v) { return ["none", "dots", "grid", "diagonal", "noise"].includes(v) ? v : "none"; }
function cleanAccentPosition(v) { return ["top-left", "top-right", "bottom-left", "bottom-right"].includes(v) ? v : "top-left"; }
function cleanHeadlineCase(v) { return ["auto", "upper", "title", "sentence"].includes(v) ? v : "auto"; }
function cleanScene(v) {
  if (v === false || v === "none" || v === "random") return v;
  if (typeof v === "string" && SCENES[v]) return v;
  return null;
}
function sanitizeUploadName(name) {
  const s = String(name || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
  return s || `flier_${Date.now()}`;
}

// ═══════════════════════════════════════════════════════════════════
//  IMAGE FETCH — hardened, with SVG sanitization on fetched content
// ═══════════════════════════════════════════════════════════════════

const MAGIC_BYTES = {
  png: [0x89, 0x50, 0x4E, 0x47],
  jpeg: [0xFF, 0xD8, 0xFF],
  gif: [0x47, 0x49, 0x46],
  webpRiff: [0x52, 0x49, 0x46, 0x46],
  webpTag: [0x57, 0x45, 0x42, 0x50],
};

function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === MAGIC_BYTES.png[0] && buf[1] === MAGIC_BYTES.png[1] && buf[2] === MAGIC_BYTES.png[2] && buf[3] === MAGIC_BYTES.png[3]) return "image/png";
  if (buf[0] === MAGIC_BYTES.jpeg[0] && buf[1] === MAGIC_BYTES.jpeg[1] && buf[2] === MAGIC_BYTES.jpeg[2]) return "image/jpeg";
  if (buf[0] === MAGIC_BYTES.gif[0] && buf[1] === MAGIC_BYTES.gif[1] && buf[2] === MAGIC_BYTES.gif[2]) return "image/gif";
  if (buf.length >= 12 && buf[0] === MAGIC_BYTES.webpRiff[0] && buf[1] === MAGIC_BYTES.webpRiff[1] && buf[2] === MAGIC_BYTES.webpRiff[2] && buf[3] === MAGIC_BYTES.webpRiff[3] &&
      buf[8] === MAGIC_BYTES.webpTag[0] && buf[9] === MAGIC_BYTES.webpTag[1] && buf[10] === MAGIC_BYTES.webpTag[2] && buf[11] === MAGIC_BYTES.webpTag[3]) {
    return "image/webp";
  }
  const head = buf.slice(0, 256).toString("utf8").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "image/svg+xml";
  return null;
}

function parseIPv4(h) {
  const parts = h.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(p => {
    if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
    if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : NaN;
  });
  if (nums.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isPrivateIPv4(nums) {
  if (!nums) return false;
  const [a, b, c, d] = nums;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isSafeImageUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const rawHost = u.hostname.toLowerCase();
    if (rawHost === "localhost" || rawHost === "0.0.0.0") return false;
    if (rawHost.endsWith(".local") || rawHost.endsWith(".internal")) return false;
    if (rawHost.startsWith("[")) {
      const inner = rawHost.slice(1, -1);
      if (inner === "::1" || inner === "::") return false;
      if (/^f[cd][0-9a-f]{2}:/i.test(inner)) return false;
      if (/^::ffff:/i.test(inner)) {
        const mapped = inner.slice(7);
        const nums = parseIPv4(mapped);
        if (isPrivateIPv4(nums)) return false;
      }
      return true;
    }
    if (/^\d+$/.test(rawHost)) {
      const n = Number(rawHost);
      if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFFFF) {
        const nums = [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
        if (isPrivateIPv4(nums)) return false;
      }
      return true;
    }
    const nums = parseIPv4(rawHost);
    if (nums && isPrivateIPv4(nums)) return false;
    return true;
  } catch { return false; }
}

async function resolveHostSafe(host) {
  if (!host) return false;
  const raw = host.toLowerCase();
  if (raw.startsWith("[")) return true;
  const nums = parseIPv4(raw);
  if (nums) return !isPrivateIPv4(nums);
  try {
    const result = await dns.promises.lookup(raw, { all: true });
    for (const r of result) {
      const v4 = parseIPv4(r.address);
      if (v4 && isPrivateIPv4(v4)) return false;
      if (r.address.includes(":") && (r.address === "::1" || /^f[cd]/i.test(r.address))) return false;
    }
    return true;
  } catch {
    return true;
  }
}

// SVG content safety — reused by both fetch and upload paths
function isSafeSvgText(text) {
  if (typeof text !== "string") return false;
  if (/<script[\s>]/i.test(text)) return false;
  if (/<foreignObject[\s>]/i.test(text)) return false;
  if (/javascript:/i.test(text)) return false;
  // Block external hrefs on <image>/<use> inside SVG
  const externalHref = /<[^>]+\b(?:href|xlink:href)\s*=\s*["'](https?:|\/\/)[^"']+["']/i;
  if (externalHref.test(text)) {
    // Only reject if it's on use/image/link — allow <a href>
    if (/<(?:use|image|link)[^>]+\b(?:href|xlink:href)\s*=\s*["'](https?:|\/\/)/i.test(text)) return false;
  }
  return true;
}

async function fetchImageAsDataUri(url, warn, referer = null) {
  const cacheKeyStr = `${url}|${referer || ""}`;
  const cacheHash = crypto.createHash("sha256").update(cacheKeyStr).digest("hex");
  const cached = imageCacheGet(cacheHash);
  if (cached) return { dataUri: cached.dataUri, mime: cached.mime, bytes: cached.bytes, ms: 0, cached: true };

  if (!isSafeImageUrl(url)) {
    if (warn) warn("image url rejected (unsafe)");
    return { error: "UNSAFE_URL", message: "url not allowed" };
  }

  let currentUrl = url;
  let hops = 0;
  const start = Date.now();

  while (hops <= FETCH_MAX_REDIRECTS) {
    const host = (() => { try { return new URL(currentUrl).hostname; } catch { return null; } })();
    if (!host) return { error: "UNSAFE_URL", message: "invalid url" };
    if (!(await resolveHostSafe(host))) {
      if (warn) warn("image host resolves to private address");
      return { error: "UNSAFE_URL", message: "private address" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), FETCH_TIMEOUT_MS);

    let res;
    try {
      const headers = { Accept: "image/*", "User-Agent": "FolioFlier/3.1" };
      if (referer) headers.Referer = referer;
      res = await fetch(currentUrl, { signal: controller.signal, redirect: "manual", headers });
    } catch (e) {
      clearTimeout(timer);
      if (warn) warn(`image fetch failed: ${e.message}`);
      return { error: "NETWORK_ERROR", message: e.message };
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { error: "HTTP_REDIRECT", message: "no location" };
      let nextUrl;
      try { nextUrl = new URL(loc, currentUrl).toString(); } catch { return { error: "HTTP_REDIRECT", message: "bad location" }; }
      if (!isSafeImageUrl(nextUrl)) {
        if (warn) warn("image redirect to unsafe host");
        return { error: "REDIRECT_UNSAFE", message: "redirect not allowed" };
      }
      currentUrl = nextUrl;
      hops++;
      continue;
    }

    if (!res.ok) {
      if (warn) warn(`image fetch HTTP ${res.status}`);
      return { error: `HTTP_${res.status}`, message: `http ${res.status}` };
    }

    const declaredLen = Number(res.headers.get("content-length") || 0);
    if (declaredLen && declaredLen > MAX_IMAGE_BYTES) {
      if (warn) warn("image too large (declared)");
      return { error: "TOO_LARGE", message: "declared length exceeds limit" };
    }

    const chunks = [];
    let total = 0;
    try {
      const reader = res.body?.getReader ? res.body.getReader() : null;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_IMAGE_BYTES) {
            try { reader.cancel(); } catch {}
            if (warn) warn("image too large (streamed)");
            return { error: "TOO_LARGE", message: "exceeds limit while streaming" };
          }
          chunks.push(Buffer.from(value));
        }
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        total = buf.length;
        if (total > MAX_IMAGE_BYTES) {
          if (warn) warn("image too large");
          return { error: "TOO_LARGE", message: "exceeds limit" };
        }
        chunks.push(buf);
      }
    } catch (e) {
      return { error: "NETWORK_ERROR", message: e.message };
    }

    const buf = Buffer.concat(chunks);
    const sniffed = sniffMime(buf);
    if (!sniffed) {
      if (warn) warn("not a valid image (magic bytes)");
      return { error: "NOT_IMAGE", message: "magic bytes mismatch" };
    }

    if (sniffed === "image/svg+xml") {
      const text = buf.toString("utf8");
      if (!isSafeSvgText(text)) {
        if (warn) warn("svg content rejected (unsafe)");
        return { error: "UNSAFE_SVG", message: "svg contained disallowed content" };
      }
    }

    const dataUri = `data:${sniffed};base64,${buf.toString("base64")}`;
    const result = { dataUri, mime: sniffed, bytes: buf.length, ms: Date.now() - start, cached: false };
    imageCacheSet(cacheHash, { dataUri, mime: sniffed, bytes: buf.length });
    return result;
  }

  return { error: "TOO_MANY_REDIRECTS", message: "redirect limit exceeded" };
}

async function imageToDataUri(spec, warn, budget) {
  if (!spec) return { dataUri: null };
  if (typeof spec === "string") spec = { url: spec };

  if (spec.uploadId && typeof spec.uploadId === "string") {
    return { error: "UPLOAD_ID_NOT_SUPPORTED", message: "uploadId not supported, use url" };
  }

  if (spec.url && !spec.base64) {
    const result = await fetchImageAsDataUri(spec.url, warn, spec.referer || null);
    if (result.error) return result;
    if (budget) {
      budget.used += result.bytes;
      if (budget.used > REQUEST_IMAGE_BUDGET) {
        return { error: "REQUEST_IMAGE_BUDGET_EXCEEDED", message: "request image budget exceeded" };
      }
    }
    return result;
  }

  if (spec.base64 && typeof spec.base64 === "string") {
    const s = spec.base64;
    if (!s.startsWith("data:image/")) return { error: "INVALID_IMAGE", message: "data URI required" };
    const comma = s.indexOf(",");
    if (comma < 0) return { error: "INVALID_IMAGE", message: "malformed data URI" };
    const declared = s.slice(5, comma).split(";")[0];
    const b64 = s.slice(comma + 1);
    let buf;
    try { buf = Buffer.from(b64, "base64"); } catch { return { error: "INVALID_IMAGE", message: "bad base64" }; }
    if (buf.length > MAX_IMAGE_BYTES) return { error: "TOO_LARGE", message: "base64 exceeds limit" };
    const sniffed = sniffMime(buf);
    if (!sniffed) return { error: "INVALID_IMAGE", message: "magic bytes mismatch" };
    if (sniffed === "image/svg+xml") {
      if (!isSafeSvgText(buf.toString("utf8"))) {
        return { error: "UNSAFE_SVG", message: "svg contained disallowed content" };
      }
    }
    if (declared) {
      const norm = declared.split("/")[1];
      if (norm && norm !== "jpg" && !sniffed.includes(norm)) {
        return { error: "INVALID_IMAGE", message: "declared MIME does not match bytes" };
      }
    }
    if (budget) {
      budget.used += buf.length;
      if (budget.used > REQUEST_IMAGE_BUDGET) {
        return { error: "REQUEST_IMAGE_BUDGET_EXCEEDED", message: "request image budget exceeded" };
      }
    }
    return { dataUri: s, mime: sniffed, bytes: buf.length, ms: 0, cached: false };
  }

  return { dataUri: null };
}

// ═══════════════════════════════════════════════════════════════════
//  INPUT NORMALIZER
// ═══════════════════════════════════════════════════════════════════

function nearestSize(w, h) {
  let best = "1080x1080"; let bestDist = Infinity;
  for (const [key, dims] of Object.entries(SIZES)) {
    const dist = Math.abs(dims.w - w) + Math.abs(dims.h - h);
    if (dist < bestDist) { bestDist = dist; best = key; }
  }
  return best;
}

function normalizeInput(raw) {
  const warnings = [];
  const warn = (msg) => { if (!warnings.includes(msg)) warnings.push(msg); };

  const out = {
    mode: raw.mode || "preview",
    type: raw.type || "template",
    template: raw.template || "default",
    size: raw.size || "1080x1080",
    svg: raw.svg || null,
    html: raw.html || null,
    seed: raw.seed || null,
    data: { text: {}, style: {}, images: {} },
    upload: raw.upload || {},
    warnings,
  };

  if (typeof raw.text === "string") out.data.text.headline = raw.text;
  else if (raw.text && typeof raw.text === "object") Object.assign(out.data.text, raw.text);
  if (typeof raw.data?.text === "string") out.data.text.headline = raw.data.text;
  else if (raw.data?.text && typeof raw.data.text === "object") Object.assign(out.data.text, raw.data.text);

  if (raw.subtitle) out.data.text.subheadline = raw.subtitle;
  if (raw.caption) out.data.text.body = raw.caption;
  if (raw.tag) out.data.text.kicker = raw.tag;
  if (raw.date) out.data.text.date = raw.date;
  if (raw.location) out.data.text.location = raw.location;
  if (raw.price) out.data.text.price = raw.price;
  if (raw.cta) out.data.text.cta = raw.cta;
  if (raw.metric) out.data.text.metric = raw.metric;
  if (raw.metricLabel) out.data.text.metricLabel = raw.metricLabel;

  if (raw.data?.style && typeof raw.data.style === "object") Object.assign(out.data.style, raw.data.style);
  if (raw.color) out.data.style.colors = { ...(out.data.style.colors || {}), primary: raw.color };
  if (raw.data?.color) out.data.style.colors = { ...(out.data.style.colors || {}), primary: raw.data.color };
  if (raw.variant) out.data.style.variant = raw.variant;
  if (raw.pattern) out.data.style.pattern = raw.pattern;
  if (raw.align) out.data.style.align = raw.align;
  if (raw.headlineCase) out.data.style.headlineCase = raw.headlineCase;
  if (raw.radius != null) out.data.style.radius = raw.radius;
  if (raw.scene != null) out.data.style.scene = raw.scene;
  if (raw.sceneNight != null) out.data.style.sceneNight = raw.sceneNight;
  if (raw.sceneOpacity != null) out.data.style.sceneOpacity = raw.sceneOpacity;

  if (raw.size) out.size = raw.size;
  else if (raw.data?.style?.size) out.size = raw.data.style.size;
  else if (raw.width && raw.height) {
    out.size = nearestSize(Number(raw.width), Number(raw.height));
    if (out.size !== `${raw.width}x${raw.height}`) warn(`size ${raw.width}x${raw.height} not available, used ${out.size}`);
  }

  if (raw.data?.images && typeof raw.data.images === "object") Object.assign(out.data.images, raw.data.images);
  if (raw.image) out.data.images.primary = { url: raw.image };
  if (raw.bg) out.data.images.background = { ...(out.data.images.background || {}), url: raw.bg, type: "image" };
  if (raw.background) {
    out.data.images.background = {
      ...(out.data.images.background || {}),
      ...(typeof raw.background === "string" ? { url: raw.background, type: "image" } : raw.background),
    };
  }

  if (out.type === "template") {
    const hasText = out.data.text.headline || out.data.text.subheadline || out.data.text.body || out.data.text.metric;
    if (!hasText) { out.data.text.headline = "Your image"; warn("no text provided, using placeholder"); }
  }
  if (out.type === "svg" && !out.svg) throw Object.assign(new Error("svg required when type=svg"), { status: 400 });
  if (out.type === "html" && !out.html) throw Object.assign(new Error("html required when type=html"), { status: 400 });

  out.size = cleanSize(out.size);
  return out;
}

// ═══════════════════════════════════════════════════════════════════
//  THEME — resolved with seeded random palette defaults
// ═══════════════════════════════════════════════════════════════════

const LIGHT_PALETTE = { text: "#0f0f12", muted: "rgba(15,15,18,0.68)", surface: "rgba(0,0,0,0.06)" };
const DARK_PALETTE = { text: "#ffffff", muted: "rgba(255,255,255,0.72)", surface: "rgba(255,255,255,0.08)" };

function isLightColor(c) {
  const s = String(c).trim().toLowerCase();
  const named = { white: [255,255,255], black: [0,0,0], yellow: [255,255,0] };
  let r, g, b;
  if (named[s]) [r, g, b] = named[s];
  else {
    const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return false;
    let hex = m[1];
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
  }
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.65;
}

function resolveTheme(data, seed) {
  const style = data?.style || {};
  const colors = style.colors || {};
  const bg = data?.images?.background || {};
  const variant = cleanVariant(style.variant);
  let effectiveVariant = variant;
  if (variant === "auto") {
    const bgType = bg.type || "gradient";
    if (bgType === "solid") {
      const col = String(bg.color || "#0a0a0d").toLowerCase();
      effectiveVariant = isLightColor(col) ? "light" : "dark";
    } else effectiveVariant = "dark";
  }
  const palette = effectiveVariant === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  const scene = cleanScene(style.scene);

  // Seed-derived palette defaults — used only when the caller didn't specify
  const paletteSeed = pickPaletteSeed(seed || style.seed || data?.text?.headline || "flier");

  const primary = colors.primary ? cleanColor(colors.primary, paletteSeed.primary) : paletteSeed.primary;
  const accent = colors.accent ? cleanColor(colors.accent, paletteSeed.accent) : paletteSeed.accent;

  // Gradient endpoints: explicit bg wins; otherwise derive from colors; otherwise from seed
  const bgFrom = bg.from ? cleanColor(bg.from, primary) : primary;
  const bgTo = bg.to ? cleanColor(bg.to, accent) : accent;
  const bgVia = bg.via ? cleanColor(bg.via, null) : null;

  return {
    variant: effectiveVariant,
    seed: seed || null,
    colors: {
      primary,
      text: cleanColor(colors.text, palette.text),
      accent,
      muted: cleanColor(colors.muted, palette.muted),
      surface: cleanColor(colors.surface, palette.surface),
    },
    font: cleanFont(),
    align: cleanAlign(style.align || "center"),
    watermark: true,
    watermarkText: cleanText(style.watermarkText || "FOLIO", 40),
    pattern: cleanPattern(style.pattern || "none"),
    radius: cleanNumber(style.radius, 0, 80, 24),
    accentPosition: cleanAccentPosition(style.accentPosition || "top-left"),
    headlineCase: cleanHeadlineCase(style.headlineCase || "auto"),
    scene,
    sceneNight: cleanBool(style.sceneNight, false),
    sceneOpacity: cleanNumber(style.sceneOpacity, 0.3, 1, 0.9),
    scenePalette: style.scenePalette || "warm",
    background: {
      type: ["solid", "gradient", "linear", "radial", "mesh", "image"].includes(bg.type) ? bg.type : "gradient",
      color: cleanColor(bg.color, "#0a0a0d"),
      from: bgFrom,
      via: bgVia,
      to: bgTo,
      angle: cleanNumber(bg.angle, 0, 360, 135),
      cx: cleanNumber(bg.cx, 0, 1, 0.5),
      cy: cleanNumber(bg.cy, 0, 1, 0.5),
      r: cleanNumber(bg.r, 0.1, 1, 0.7),
      stops: Array.isArray(bg.stops) ? bg.stops.map(s => ({ offset: Number(s.offset) || 0, color: cleanColor(s.color, bgFrom) })) : null,
      overlay: cleanColor(bg.overlay, "rgba(0,0,0,0.55)"),
      blur: cleanNumber(bg.blur, 0, 40, 0),
      dataUri: null,
    },
  };
}

function resolveText(data) {
  const t = data?.text || {};
  return {
    kicker: cleanText(t.kicker, MAX_TEXT.kicker),
    headline: cleanText(t.headline, MAX_TEXT.headline),
    subheadline: cleanText(t.subheadline, MAX_TEXT.subheadline),
    body: cleanText(t.body, MAX_TEXT.body),
    footer: cleanText(t.footer, MAX_TEXT.footer),
    attribution: cleanText(t.attribution, MAX_TEXT.attribution),
    date: cleanText(t.date, MAX_TEXT.date),
    location: cleanText(t.location, MAX_TEXT.location),
    price: cleanText(t.price, MAX_TEXT.price),
    cta: cleanText(t.cta, MAX_TEXT.cta),
    metric: cleanText(t.metric, MAX_TEXT.metric),
    metricLabel: cleanText(t.metricLabel, MAX_TEXT.metricLabel),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  BACKGROUND + SCENE LAYERS
// ═══════════════════════════════════════════════════════════════════

function patternLayer(dims, theme) {
  const pat = theme.pattern;
  if (pat === "none") return "";
  const { w: W, h: H } = dims;
  const c = theme.colors.primary;
  const op = theme.variant === "light" ? 0.10 : 0.14;

  if (pat === "dots") return `<defs><pattern id="pat-dots" width="48" height="48" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="1.6" fill="${escAttr(c)}"/></pattern></defs><rect width="${W}" height="${H}" fill="url(#pat-dots)" opacity="${op}"/>`;
  if (pat === "grid") return `<defs><pattern id="pat-grid" width="72" height="72" patternUnits="userSpaceOnUse"><path d="M72 0 L0 0 0 72" fill="none" stroke="${escAttr(c)}" stroke-width="1"/></pattern></defs><rect width="${W}" height="${H}" fill="url(#pat-grid)" opacity="${op}"/>`;
  if (pat === "diagonal") return `<defs><pattern id="pat-diag" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="40" stroke="${escAttr(c)}" stroke-width="1.5"/></pattern></defs><rect width="${W}" height="${H}" fill="url(#pat-diag)" opacity="${op}"/>`;
  if (pat === "noise") {
    return `<defs><filter id="pat-noise" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.6 0"/></filter></defs><rect width="${W}" height="${H}" fill="${escAttr(c)}" filter="url(#pat-noise)" opacity="${op}"/>`;
  }
  return "";
}

function sceneLayer(dims, theme, template) {
  const sceneId = theme.scene === "random"
    ? pickScene("rand-" + Date.now() + Math.random(), template, "random")
    : pickScene(theme.seed || theme.text?.headline || template, template, theme.scene);
  if (!sceneId) return "";

  const { w: W, h: H } = dims;
  const palette = resolvePalette(theme.scenePalette, theme.colors.primary, theme.colors.accent);
  const sceneCacheKey = crypto.createHash("sha256")
    .update(`${sceneId}|${W}|${H}|${theme.scenePalette}|${theme.sceneNight}|${theme.seed || ""}`)
    .digest("hex");

  let sceneSvg = sceneCacheGet(sceneCacheKey);
  if (!sceneSvg) {
    const ctx = { W, H, palette, opacity: 1, seed: theme.seed || sceneId, variant: theme.variant, night: theme.sceneNight };
    const fn = SCENES[sceneId];
    if (!fn) return "";
    sceneSvg = fn(ctx);
    sceneCacheSet(sceneCacheKey, sceneSvg);
  }
  return `<g opacity="${theme.sceneOpacity}">${sceneSvg}</g>`;
}

function gradientDefs(W, H, bg, idSuffix = "") {
  const id = `bg-grad${idSuffix}`;
  if (bg.type === "solid") {
    return { def: "", rect: `<rect width="${W}" height="${H}" fill="${escAttr(bg.color)}"/>` };
  }
  if (bg.type === "radial") {
    const stops = bg.stops && bg.stops.length
      ? bg.stops.map(s => `<stop offset="${s.offset}" stop-color="${escAttr(s.color)}"/>`).join("")
      : `<stop offset="0" stop-color="${escAttr(bg.from)}"/><stop offset="1" stop-color="${escAttr(bg.to)}"/>`;
    return {
      def: `<defs><radialGradient id="${id}" cx="${bg.cx}" cy="${bg.cy}" r="${bg.r}">${stops}</radialGradient></defs>`,
      rect: `<rect width="${W}" height="${H}" fill="url(#${id})"/>`,
    };
  }
  if (bg.type === "mesh") {
    const corners = [
      { cx: 0.1, cy: 0.1, color: bg.from },
      { cx: 0.9, cy: 0.1, color: bg.via || bg.to },
      { cx: 0.1, cy: 0.9, color: bg.to },
      { cx: 0.9, cy: 0.9, color: bg.accent || bg.from },
    ];
    const defs = [];
    const rects = [];
    for (let i = 0; i < 4; i++) {
      const gid = `mesh-${idSuffix}-${i}`;
      defs.push(`<radialGradient id="${gid}" cx="${corners[i].cx}" cy="${corners[i].cy}" r="0.7">
        <stop offset="0" stop-color="${escAttr(corners[i].color)}" stop-opacity="0.9"/>
        <stop offset="1" stop-color="${escAttr(corners[i].color)}" stop-opacity="0"/>
      </radialGradient>`);
      rects.push(`<rect width="${W}" height="${H}" fill="url(#${gid})"/>`);
    }
    return {
      def: `<defs>${defs.join("")}</defs>`,
      rect: `<rect width="${W}" height="${H}" fill="${escAttr(bg.color)}"/>${rects.join("")}`,
    };
  }
  const rad = (bg.angle * Math.PI) / 180;
  const x1 = 0.5 - Math.cos(rad) * 0.5;
  const y1 = 0.5 - Math.sin(rad) * 0.5;
  const x2 = 0.5 + Math.cos(rad) * 0.5;
  const y2 = 0.5 + Math.sin(rad) * 0.5;
  const stops = bg.stops && bg.stops.length
    ? bg.stops.map(s => `<stop offset="${s.offset}" stop-color="${escAttr(s.color)}"/>`).join("")
    : bg.via
      ? `<stop offset="0" stop-color="${escAttr(bg.from)}"/><stop offset="0.5" stop-color="${escAttr(bg.via)}"/><stop offset="1" stop-color="${escAttr(bg.to)}"/>`
      : `<stop offset="0" stop-color="${escAttr(bg.from)}"/><stop offset="1" stop-color="${escAttr(bg.to)}"/>`;
  return {
    def: `<defs><linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient></defs>`,
    rect: `<rect width="${W}" height="${H}" fill="url(#${id})"/>`,
  };
}

function backgroundLayer(dims, theme, template) {
  const { w: W, h: H } = dims;
  const bg = theme.background;

  if (bg.type === "image" && bg.dataUri) {
    const blur = bg.blur > 0 ? `<filter id="bg-blur" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${bg.blur}"/></filter>` : "";
    const filterAttr = bg.blur > 0 ? ' filter="url(#bg-blur)"' : "";
    const scene = sceneLayer(dims, theme, template);
    return `<defs><clipPath id="clip-frame"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>${blur}</defs><g clip-path="url(#clip-frame)"><image href="${escAttr(bg.dataUri)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"${filterAttr}/></g><rect x="0" y="0" width="${W}" height="${H}" fill="${escAttr(bg.overlay || "rgba(0,0,0,0.4)")}"/>${scene}${patternLayer(dims, theme)}`;
  }

  const grad = gradientDefs(W, H, bg);
  const scene = sceneLayer(dims, theme, template);
  return `${grad.def}${grad.rect}${scene}${patternLayer(dims, theme)}`;
}

function svgWrap(dims, theme, body) {
  const { w: W, h: H } = dims;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
}

// ═══════════════════════════════════════════════════════════════════
//  TEMPLATES (existing + browser-frame)
// ═══════════════════════════════════════════════════════════════════

function tpl_default(data, theme, dims) {
  const { text } = data;
  const hasImage = !!theme.background.dataUri;
  const hasSub = !!text.subheadline;
  const hasBody = !!text.body;
  const hasAttr = !!text.attribution;
  const wc = text.headline.split(/\s+/).filter(Boolean).length;
  if (hasImage) return tpl_image_shadow_bottom(data, theme, dims);
  if (hasAttr) return tpl_quote_card(data, theme, dims);
  if (text.metric) return tpl_stat_hero(data, theme, dims);
  if (!hasSub && !hasBody && wc <= 6) return tpl_hero_short(data, theme, dims);
  return tpl_poster_centered(data, theme, dims);
}

function tpl_hero_short(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const sa = safeArea(W, H);
  const boxW = W - sa.left - sa.right;
  const scale = typeScale(H, "compact");
  const headSize = fitText(applyHeadlineCase(t.headline, theme.headlineCase), boxW, scale.headline * 1.5, "black");
  const lines = wrapToWidth(applyHeadlineCase(t.headline, theme.headlineCase), boxW, headSize, "black");
  const lh = headSize * 1.02;
  const blockH = lines.length * lh;
  let y = (H - blockH) / 2 + headSize * 0.85;
  const out = [backgroundLayer(dims, theme, "hero-short")];
  for (const line of lines) {
    out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: headSize, weight: "black", fill: theme.colors.text }));
    y += lh;
  }
  if (t.footer) {
    const footSize = scale.label;
    out.push(textNode({ x: W / 2, y: H - sa.bottom, text: t.footer, anchor: "middle", size: footSize, weight: "bold", fill: theme.colors.primary }));
  }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_poster_centered(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const sa = safeArea(W, H);
  const boxW = W - sa.left - sa.right;
  const scale = typeScale(H);
  const headSize = scale.headline;
  const subSize = scale.sub;
  const bodySize = scale.body;
  const footSize = scale.caption;
  const kickSize = scale.kicker;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, boxW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, boxW, subSize, "medium");
  const bodyLines = wrapToWidth(t.body, boxW, bodySize, "regular");
  const headLH = headSize * 1.06;
  const subLH = subSize * 1.35;
  const bodyLH = bodySize * 1.6;
  const kickerBlock = t.kicker ? kickSize * 2.0 : 0;
  const footBlock = t.footer ? footSize * 2.0 : 0;
  const blockH = kickerBlock + headLines.length * headLH + (subLines.length ? subLines.length * subLH + subSize * 0.4 : 0) + (bodyLines.length ? bodyLines.length * bodyLH + bodySize * 0.6 : 0) + footBlock;
  let y = (H - blockH) / 2 + headSize;
  const out = [backgroundLayer(dims, theme, "poster-centered")];
  if (t.kicker) {
    y += Math.round(kickSize * 0.5);
    out.push(textNode({ x: W / 2, y, text: t.kicker.toUpperCase(), anchor: "middle", size: kickSize, weight: "black", letterSpacing: kickSize * 0.14, fill: theme.colors.accent }));
    y += Math.round(kickSize * 1.5);
  }
  for (const line of headLines) { out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.4); for (const line of subLines) { out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (bodyLines.length) { y += Math.round(bodySize * 0.6); for (const line of bodyLines) { out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: bodySize, weight: "regular", fill: theme.colors.muted })); y += bodyLH; } }
  if (t.footer) { y += Math.round(footSize * 0.6); out.push(textNode({ x: W / 2, y, text: t.footer, anchor: "middle", size: footSize, weight: "bold", fill: theme.colors.primary })); }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_image_shadow_bottom(data, theme, dims) {
  const { w: W, h: H } = dims;
  const sa = safeArea(W, H);
  const t = data.text;
  const align = theme.align;
  const anchor = align === "center" ? "middle" : align === "start" || align === "left" ? "start" : "end";
  const x = align === "center" ? W / 2 : align === "right" ? W - sa.right : sa.left;
  const boxW = W - sa.left - sa.right;
  const scale = typeScale(H);
  const headSize = scale.headline * 1.08;
  const subSize = scale.sub;
  const footSize = scale.caption;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, boxW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, boxW, subSize, "medium");
  const headLH = headSize * 1.02;
  const subLH = subSize * 1.3;
  const blockH = headLines.length * headLH + (subLines.length ? subLines.length * subLH + subSize * 0.4 : 0) + (t.footer ? footSize * 2 : 0) + H * 0.06;
  const blockTop = H - blockH - sa.bottom;
  const out = [backgroundLayer(dims, theme, "image-shadow-bottom")];
  const gradH = Math.min(H, blockH + H * 0.15);
  const gradTop = H - gradH;
  out.push(`<defs><linearGradient id="shadow-btm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(0,0,0,0)"/><stop offset="0.35" stop-color="rgba(0,0,0,0.55)"/><stop offset="1" stop-color="rgba(0,0,0,0.94)"/></linearGradient></defs><rect x="0" y="${gradTop}" width="${W}" height="${gradH}" fill="url(#shadow-btm)"/>`);
  let y = blockTop + headSize * 0.85;
  for (const line of headLines) { out.push(textNode({ x, y, text: line, anchor, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.4); for (const line of subLines) { out.push(textNode({ x, y, text: line, anchor, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (t.footer) { y += Math.round(footSize * 1.0); out.push(textNode({ x, y, text: t.footer, anchor, size: footSize, weight: "bold", fill: theme.colors.primary })); }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_image_blur_text(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const scale = typeScale(H);
  const headSize = scale.headline * 0.80;
  const subSize = scale.sub * 0.87;
  const boxW = W * 0.82;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, boxW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, boxW, subSize, "medium");
  const headLH = headSize * 1.08;
  const subLH = subSize * 1.35;
  const blockH = headLines.length * headLH + subLines.length * subLH + 40;
  let y = (H - blockH) / 2 + headSize;
  const out = [backgroundLayer(dims, theme, "image-blur-text")];
  out.push(`<defs><radialGradient id="scrim" cx="0.5" cy="0.5" r="0.55"><stop offset="0" stop-color="rgba(0,0,0,0.55)"/><stop offset="1" stop-color="rgba(0,0,0,0)"/></radialGradient></defs><rect x="0" y="0" width="${W}" height="${H}" fill="url(#scrim)"/>`);
  for (const line of headLines) { out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.6); for (const line of subLines) { out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_newspaper_classic(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.055);
  const boxW = W - pad * 2;
  const innerPad = Math.round(pad * 0.35);
  const paper = "#f5f1e8"; const ink = "#0f0f12"; const inkSoft = "#2a2a2a";
  const mastSize = Math.round(H * 0.026); const headSize = Math.round(H * 0.098);
  const deckSize = Math.round(H * 0.030); const bodySize = Math.round(H * 0.021);
  const metaSize = Math.round(H * 0.019);
  const headline = applyHeadlineCase(t.headline, theme.headlineCase || "auto");
  const headLines = wrapToWidth(headline, boxW - innerPad * 2, headSize, "black");
  const deckLines = wrapToWidth(t.subheadline, boxW - innerPad * 2, deckSize, "medium");
  const bodyLines = wrapToWidth(t.body, boxW - innerPad * 2, bodySize, "regular");
  const out = [];
  out.push(`<rect width="${W}" height="${H}" fill="${paper}"/>`);
  const frameT = Math.max(4, Math.round(W * 0.004));
  out.push(`<rect x="${pad}" y="${pad}" width="${boxW}" height="${H - pad * 2}" fill="none" stroke="${ink}" stroke-width="${frameT}"/>`);
  let y = pad + innerPad + mastSize;
  const mastText = (t.kicker || "THE DAILY FOLIO").toUpperCase();
  out.push(textNode({ x: W / 2, y, text: mastText, anchor: "middle", size: mastSize, weight: "black", letterSpacing: mastSize * 0.28, fill: ink }));
  y += Math.round(mastSize * 0.5);
  out.push(`<line x1="${pad + innerPad}" y1="${y}" x2="${W - pad - innerPad}" y2="${y}" stroke="${ink}" stroke-width="1"/>`);
  y += 6;
  out.push(`<line x1="${pad + innerPad}" y1="${y}" x2="${W - pad - innerPad}" y2="${y}" stroke="${ink}" stroke-width="${frameT}"/>`);
  y += Math.round(metaSize * 1.8);
  const leftMeta = (t.location || "").toUpperCase();
  const rightMeta = (t.date || "").toUpperCase();
  if (leftMeta) out.push(textNode({ x: pad + innerPad, y, text: leftMeta, size: metaSize, weight: "bold", letterSpacing: metaSize * 0.15, fill: inkSoft }));
  if (rightMeta) out.push(textNode({ x: W - pad - innerPad, y, text: rightMeta, anchor: "end", size: metaSize, weight: "bold", letterSpacing: metaSize * 0.15, fill: inkSoft }));
  y += Math.round(headSize * 1.15);
  for (const line of headLines) { out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: headSize, weight: "black", fill: ink })); y += Math.round(headSize * 1.04); }
  if (deckLines.length) {
    y += Math.round(deckSize * 0.6);
    out.push(`<line x1="${pad + innerPad}" y1="${y}" x2="${W - pad - innerPad}" y2="${y}" stroke="${ink}" stroke-width="1"/>`);
    y += Math.round(deckSize * 1.4);
    for (const line of deckLines) { out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: deckSize, weight: "medium", style: "italic", fill: inkSoft })); y += Math.round(deckSize * 1.28); }
  }
  if (bodyLines.length) {
    y += Math.round(bodySize * 1.2);
    out.push(`<line x1="${pad + innerPad}" y1="${y}" x2="${W - pad - innerPad}" y2="${y}" stroke="${ink}" stroke-width="1"/>`);
    y += Math.round(bodySize * 1.5);
    for (const line of bodyLines) { out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: bodySize, weight: "regular", fill: ink })); y += Math.round(bodySize * 1.62); }
  }
  if (t.footer) {
    const fy = H - pad - innerPad - metaSize;
    out.push(`<line x1="${pad + innerPad}" y1="${fy - metaSize * 1.2}" x2="${W - pad - innerPad}" y2="${fy - metaSize * 1.2}" stroke="${ink}" stroke-width="1"/>`);
    out.push(textNode({ x: W / 2, y: fy, text: t.footer, anchor: "middle", size: metaSize, weight: "bold", fill: ink }));
  }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_quote_card(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.12);
  const boxW = W - pad * 2;
  const scale = typeScale(H);
  const quoteSize = scale.headline * 0.67;
  const attrSize = scale.sub * 0.73;
  const quoteText = t.headline || t.body || "";
  const attribution = t.subheadline || t.attribution || "";
  const lines = wrapToWidth(quoteText, boxW, quoteSize, "bold");
  const lh = quoteSize * 1.32;
  const blockH = lines.length * lh;
  let y = (H - blockH) / 2 + quoteSize * 0.85;
  const out = [backgroundLayer(dims, theme, "quote-card")];
  out.push(textNode({ x: W / 2 - boxW / 2 + quoteSize * 0.4, y: y - lh * lines.length - quoteSize * 0.2, text: "\u201C", size: quoteSize * 3.2, weight: "black", fill: theme.colors.primary, opacity: 0.18 }));
  for (const line of lines) { out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: quoteSize, weight: "bold", fill: theme.colors.text })); y += lh; }
  if (attribution) {
    y += Math.round(attrSize * 1.4);
    out.push(`<line x1="${W / 2 - 24}" y1="${y - attrSize * 1.0}" x2="${W / 2 + 24}" y2="${y - attrSize * 1.0}" stroke="${escAttr(theme.colors.primary)}" stroke-width="2"/>`);
    y += Math.round(attrSize * 0.4);
    out.push(textNode({ x: W / 2, y, text: `— ${attribution}`, anchor: "middle", size: attrSize, weight: "medium", fill: theme.colors.muted }));
  }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_random_lines_top(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.09);
  const boxW = W - pad * 2;
  const scale = typeScale(H, "compact");
  const headSize = scale.headline * 1.5;
  const subSize = scale.sub;
  const rng = seededRandom(t.headline || t.body || "lines");
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, boxW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, boxW, subSize, "medium");
  const headLH = headSize * 1.05;
  const subLH = subSize * 1.35;
  const textTop = H * 0.52;
  let y = textTop + headSize * 0.85;
  const lineZoneH = textTop + headSize * 0.4;
  const lines = [];
  for (let i = 0; i < 26; i++) {
    const x1 = rng() * W; const y1 = rng() * lineZoneH;
    const x2 = x1 + (rng() * 260 - 130); const y2 = y1 + (rng() * 240 - 120);
    const op = 0.10 + rng() * 0.22; const sw = 1 + rng() * 2.2;
    lines.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${escAttr(theme.colors.primary)}" stroke-width="${sw.toFixed(2)}" opacity="${op.toFixed(3)}"/>`);
  }
  const out = [backgroundLayer(dims, theme, "random-lines-top"), ...lines];
  if (t.kicker) out.push(textNode({ x: pad, y: pad + H * 0.025, text: t.kicker.toUpperCase(), size: Math.round(H * 0.020), weight: "black", letterSpacing: H * 0.003, fill: theme.colors.accent }));
  for (const line of headLines) { out.push(textNode({ x: pad, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { out.push(textNode({ x: pad, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  out.push(`<rect x="${pad}" y="${H - Math.round(H * 0.10)}" width="80" height="6" rx="3" fill="${escAttr(theme.colors.primary)}"/>`);
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_image_card_side_text(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.06);
  const gap = Math.round(W * 0.05);
  const isWide = W > H;
  const cardW = isWide ? Math.round(W * 0.42) : Math.round(W * 0.80);
  const cardH = isWide ? Math.round(H - pad * 2) : Math.round(cardW * 0.75);
  const cardY = pad;
  const cardX = isWide ? pad : (W - cardW) / 2;
  const textX = isWide ? cardX + cardW + gap : pad;
  const textW = isWide ? W - textX - pad : W - pad * 2;
  const textTop = isWide ? pad : cardY + cardH + Math.round(pad * 1.5);
  const scale = typeScale(H, "compact");
  const headSize = scale.headline;
  const subSize = scale.sub;
  const bodySize = scale.body;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, textW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, textW, subSize, "medium");
  const bodyLines = wrapToWidth(t.body, textW, bodySize, "regular");
  const headLH = headSize * 1.08;
  const subLH = subSize * 1.4;
  const bodyLH = bodySize * 1.62;
  const blockH = headLines.length * headLH + (subLines.length ? subLines.length * subLH + subSize * 0.5 : 0) + (bodyLines.length ? bodyLines.length * bodyLH + bodySize * 0.7 : 0);
  let y = isWide ? (H - blockH) / 2 + headSize : textTop + headSize;
  const out = [backgroundLayer(dims, theme, "image-card-side-text")];
  const radius = theme.radius;
  const cardImage = data.images?.primary?.dataUri;
  if (cardImage) {
    out.push(`<defs><clipPath id="card-clip"><rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="${radius}"/></clipPath></defs><image href="${escAttr(cardImage)}" x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#card-clip)"/>`);
  } else {
    out.push(`<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="${radius}" fill="${escAttr(theme.colors.surface)}"/>`);
    out.push(`<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="${radius}" fill="none" stroke="${escAttr(theme.colors.primary)}" stroke-width="2" stroke-dasharray="6 6" opacity="0.4"/>`);
  }
  for (const line of headLines) { out.push(textNode({ x: textX, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { out.push(textNode({ x: textX, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (bodyLines.length) { y += Math.round(bodySize * 0.7); for (const line of bodyLines) { out.push(textNode({ x: textX, y, text: line, size: bodySize, weight: "regular", fill: theme.colors.muted })); y += bodyLH; } }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_event_poster(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.08);
  const boxW = W - pad * 2;
  const scale = typeScale(H);
  const kickSize = scale.kicker;
  const headSize = scale.headline * 1.28;
  const subSize = scale.sub * 1.13;
  const metaSize = scale.caption * 1.33;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase || "upper");
  const headLines = wrapToWidth(headline, boxW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, boxW, subSize, "medium");
  const out = [backgroundLayer(dims, theme, "event-poster")];
  let y = pad + kickSize * 1.4;
  if (t.kicker) out.push(textNode({ x: pad, y, text: t.kicker.toUpperCase(), size: kickSize, weight: "black", letterSpacing: kickSize * 0.15, fill: theme.colors.accent }));
  y += Math.round(headSize * 0.75);
  for (const line of headLines) { out.push(textNode({ x: pad, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += Math.round(headSize * 1.04); }
  y += Math.round(subSize * 0.2);
  out.push(`<rect x="${pad}" y="${y}" width="80" height="6" rx="3" fill="${escAttr(theme.colors.primary)}"/>`);
  y += Math.round(subSize * 1.3);
  for (const line of subLines) { out.push(textNode({ x: pad, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += Math.round(subSize * 1.3); }
  const metaY = H - pad - metaSize * 0.6;
  if (t.date || t.location) {
    const meta = [t.date, t.location].filter(Boolean).join("  ·  ");
    out.push(textNode({ x: pad, y: metaY, text: meta, size: metaSize, weight: "bold", fill: theme.colors.primary }));
  }
  if (t.footer) out.push(textNode({ x: W - pad, y: metaY, text: t.footer, anchor: "end", size: metaSize, weight: "medium", fill: theme.colors.muted }));
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_split_image_side(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const vertical = H >= W;
  const imgFrac = 0.5;
  let imgX, imgY, imgW, imgH, panelX, panelY, panelW, panelH;
  if (vertical) { imgX = 0; imgY = 0; imgW = W; imgH = Math.round(H * imgFrac); panelX = 0; panelY = imgH; panelW = W; panelH = H - imgH; }
  else { imgX = 0; imgY = 0; imgW = Math.round(W * imgFrac); imgH = H; panelX = imgW; panelY = 0; panelW = W - imgW; panelH = H; }
  const pad = Math.round(Math.min(panelW, panelH) * 0.10);
  const textW = panelW - pad * 2;
  const scale = typeScale(panelH, "compact");
  const headSize = scale.headline;
  const subSize = scale.sub;
  const bodySize = scale.body;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, textW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, textW, subSize, "medium");
  const bodyLines = wrapToWidth(t.body, textW, bodySize, "regular");
  const headLH = headSize * 1.06;
  const subLH = subSize * 1.36;
  const bodyLH = bodySize * 1.6;
  const blockH = headLines.length * headLH + (subLines.length ? subLines.length * subLH + subSize * 0.5 : 0) + (bodyLines.length ? bodyLines.length * bodyLH + bodySize * 0.7 : 0);
  let y = panelY + (panelH - blockH) / 2 + headSize * 0.85;
  const textX = panelX + pad;
  const out = [];
  const panelFrom = theme.colors.primary;
  const panelTo = theme.colors.accent;
  out.push(`<defs><linearGradient id="split-grad" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}"><stop offset="0" stop-color="${escAttr(panelFrom)}" stop-opacity="0.14"/><stop offset="1" stop-color="${escAttr(panelTo)}" stop-opacity="0.06"/></linearGradient></defs><rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" fill="#0f0f12"/><rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" fill="url(#split-grad)"/>`);
  const pat = patternLayer({ w: panelW, h: panelH }, theme);
  if (pat) out.push(`<g transform="translate(${panelX},${panelY})">${pat}</g>`);
  const imageData = data.images?.primary?.dataUri || theme.background.dataUri;
  if (imageData) {
    out.push(`<defs><clipPath id="split-img-clip"><rect x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}"/></clipPath></defs><image href="${escAttr(imageData)}" x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#split-img-clip)"/>`);
  } else {
    out.push(`<rect x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" fill="${escAttr(theme.colors.surface)}"/>`);
    out.push(`<rect x="${imgX + 16}" y="${imgY + 16}" width="${imgW - 32}" height="${imgH - 32}" fill="none" stroke="${escAttr(theme.colors.primary)}" stroke-width="2" stroke-dasharray="8 8" opacity="0.35"/>`);
  }
  if (vertical) out.push(`<rect x="0" y="${imgH - 4}" width="${W}" height="4" fill="${escAttr(theme.colors.primary)}"/>`);
  else out.push(`<rect x="${imgW - 4}" y="0" width="4" height="${H}" fill="${escAttr(theme.colors.primary)}"/>`);
  if (t.kicker) out.push(textNode({ x: textX, y: y - headSize * 1.2, text: t.kicker.toUpperCase(), size: Math.round(headSize * 0.28), weight: "black", letterSpacing: headSize * 0.05, fill: theme.colors.accent }));
  for (const line of headLines) { out.push(textNode({ x: textX, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { out.push(textNode({ x: textX, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (bodyLines.length) { y += Math.round(bodySize * 0.7); for (const line of bodyLines) { out.push(textNode({ x: textX, y, text: line, size: bodySize, weight: "regular", fill: theme.colors.muted })); y += bodyLH; } }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_feature_image_top(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.07);
  const imgH = Math.round(H * 0.44);
  const imgX = pad; const imgY = pad; const imgW = W - pad * 2;
  const radius = theme.radius;
  const textTop = imgY + imgH + Math.round(H * 0.05);
  const textW = W - pad * 2;
  const scale = typeScale(H, "compact");
  const headSize = scale.headline;
  const subSize = scale.sub;
  const bodySize = scale.body;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, textW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, textW, subSize, "medium");
  const bodyLines = wrapToWidth(t.body, textW, bodySize, "regular");
  const headLH = headSize * 1.08;
  const subLH = subSize * 1.4;
  const bodyLH = bodySize * 1.62;
  let y = textTop + headSize * 0.85;
  const out = [backgroundLayer(dims, theme, "feature-image-top")];
  const imageData = data.images?.primary?.dataUri;
  if (imageData) {
    out.push(`<defs><clipPath id="feat-img-clip"><rect x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" rx="${radius}"/></clipPath></defs><image href="${escAttr(imageData)}" x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#feat-img-clip)"/>`);
  } else {
    out.push(`<rect x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" rx="${radius}" fill="${escAttr(theme.colors.surface)}"/>`);
    out.push(`<rect x="${imgX + 16}" y="${imgY + 16}" width="${imgW - 32}" height="${imgH - 32}" rx="${radius}" fill="none" stroke="${escAttr(theme.colors.primary)}" stroke-width="2" stroke-dasharray="8 8" opacity="0.35"/>`);
  }
  if (t.kicker) out.push(textNode({ x: pad, y: textTop - Math.round(headSize * 0.4), text: t.kicker.toUpperCase(), size: Math.round(headSize * 0.32), weight: "black", letterSpacing: headSize * 0.06, fill: theme.colors.accent }));
  for (const line of headLines) { out.push(textNode({ x: pad, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { out.push(textNode({ x: pad, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (bodyLines.length) { y += Math.round(bodySize * 0.7); for (const line of bodyLines) { out.push(textNode({ x: pad, y, text: line, size: bodySize, weight: "regular", fill: theme.colors.muted })); y += bodyLH; } }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_image_badge_overlay(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.08);
  const badgeSize = Math.round(Math.min(W, H) * 0.22);
  const badgeX = W - pad - badgeSize;
  const badgeY = pad;
  const scale = typeScale(H);
  const headSize = scale.headline;
  const subSize = scale.sub;
  const bodySize = scale.body;
  const textW = W - pad * 2;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, textW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, textW, subSize, "medium");
  const bodyLines = wrapToWidth(t.body, textW, bodySize, "regular");
  const headLH = headSize * 1.06;
  const subLH = subSize * 1.36;
  const bodyLH = bodySize * 1.62;
  const textTop = badgeY + badgeSize + Math.round(H * 0.06);
  let y = textTop + headSize * 0.85;
  const out = [backgroundLayer(dims, theme, "image-badge-overlay")];
  out.push(`<defs><linearGradient id="badge-scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(0,0,0,0)"/><stop offset="0.5" stop-color="rgba(0,0,0,0.35)"/><stop offset="1" stop-color="rgba(0,0,0,0.72)"/></linearGradient></defs><rect x="0" y="${H * 0.30}" width="${W}" height="${H * 0.70}" fill="url(#badge-scrim)"/>`);
  const imageData = data.images?.primary?.dataUri;
  const badgeR = Math.round(badgeSize / 2);
  if (imageData) {
    out.push(`<defs><clipPath id="badge-clip"><circle cx="${badgeX + badgeR}" cy="${badgeY + badgeR}" r="${badgeR}"/></clipPath></defs><circle cx="${badgeX + badgeR}" cy="${badgeY + badgeR}" r="${badgeR + 6}" fill="${escAttr(theme.colors.primary)}" opacity="0.25"/><image href="${escAttr(imageData)}" x="${badgeX}" y="${badgeY}" width="${badgeSize}" height="${badgeSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#badge-clip)"/><circle cx="${badgeX + badgeR}" cy="${badgeY + badgeR}" r="${badgeR}" fill="none" stroke="${escAttr(theme.colors.primary)}" stroke-width="4"/>`);
  } else {
    out.push(`<circle cx="${badgeX + badgeR}" cy="${badgeY + badgeR}" r="${badgeR}" fill="${escAttr(theme.colors.surface)}" stroke="${escAttr(theme.colors.primary)}" stroke-width="4" stroke-dasharray="6 6"/>`);
  }
  if (t.kicker) out.push(textNode({ x: pad, y: textTop - headSize * 0.4, text: t.kicker.toUpperCase(), size: Math.round(headSize * 0.30), weight: "black", letterSpacing: headSize * 0.06, fill: theme.colors.accent }));
  for (const line of headLines) { out.push(textNode({ x: pad, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { out.push(textNode({ x: pad, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (bodyLines.length) { y += Math.round(bodySize * 0.7); for (const line of bodyLines) { out.push(textNode({ x: pad, y, text: line, size: bodySize, weight: "regular", fill: theme.colors.muted })); y += bodyLH; } }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_strip_bottom(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.08);
  const stripH = Math.round(H * 0.38);
  const stripY = H - stripH;
  const textZoneH = stripY;
  const scale = typeScale(textZoneH);
  const headSize = scale.headline;
  const subSize = scale.sub;
  const bodySize = scale.body;
  const textW = W - pad * 2;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, textW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, textW, subSize, "medium");
  const bodyLines = wrapToWidth(t.body, textW, bodySize, "regular");
  const headLH = headSize * 1.06;
  const subLH = subSize * 1.4;
  const bodyLH = bodySize * 1.62;
  const blockH = headLines.length * headLH + (subLines.length ? subLines.length * subLH + subSize * 0.5 : 0) + (bodyLines.length ? bodyLines.length * bodyLH + bodySize * 0.7 : 0);
  const blockTop = Math.max(pad, (stripY - blockH) / 2 + headSize * 0.85);

  const out = [backgroundLayer(dims, theme, "strip-bottom")];

  const imageData = data.images?.primary?.dataUri;
  if (imageData) {
    out.push(`<defs><clipPath id="strip-clip"><rect x="0" y="${stripY}" width="${W}" height="${stripH}"/></clipPath></defs><image href="${escAttr(imageData)}" x="0" y="${stripY}" width="${W}" height="${stripH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#strip-clip)"/><rect x="0" y="${stripY}" width="${W}" height="${stripH}" fill="${escAttr(theme.colors.primary)}" opacity="0.18"/>`);
  } else {
    out.push(`<rect x="0" y="${stripY}" width="${W}" height="${stripH}" fill="${escAttr(theme.colors.primary)}" opacity="0.14"/>`);
    const stripes = [];
    for (let i = 0; i < 12; i++) {
      const x = (i / 11) * W;
      const w = Math.max(2, W * 0.004);
      stripes.push(`<rect x="${x.toFixed(1)}" y="${stripY}" width="${w.toFixed(1)}" height="${stripH}" fill="${escAttr(theme.colors.primary)}" opacity="${(0.06 + i * 0.02).toFixed(3)}"/>`);
    }
    out.push(`<g opacity="0.7">${stripes.join("")}</g>`);
  }

  out.push(`<defs><clipPath id="strip-text-clip"><rect x="0" y="0" width="${W}" height="${stripY}"/></clipPath></defs>`);
  const textGroup = [];
  let y = blockTop;
  if (t.kicker) textGroup.push(textNode({ x: pad, y: y - headSize * 1.0, text: t.kicker.toUpperCase(), size: Math.round(headSize * 0.28), weight: "black", letterSpacing: headSize * 0.05, fill: theme.colors.accent }));
  for (const line of headLines) { textGroup.push(textNode({ x: pad, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { textGroup.push(textNode({ x: pad, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (bodyLines.length) { y += Math.round(bodySize * 0.7); for (const line of bodyLines) { textGroup.push(textNode({ x: pad, y, text: line, size: bodySize, weight: "regular", fill: theme.colors.muted })); y += bodyLH; } }
  out.push(`<g clip-path="url(#strip-text-clip)">${textGroup.join("")}</g>`);

  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_stat_hero(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.10);
  const textW = W - pad * 2;
  const metric = t.metric || t.headline;
  const scale = typeScale(H);
  const metricMax = scale.display;
  const fitSize = fitText(metric, textW, metricMax, "black");
  const labelSize = scale.sub;
  const subSize = scale.body;
  const label = applyHeadlineCase(t.metricLabel || t.subheadline, theme.headlineCase);
  const labelLines = wrapToWidth(label, textW, labelSize, "medium");
  const subLines = wrapToWidth(t.body, textW, subSize, "regular");
  const labelLH = labelSize * 1.3;
  const subLH = subSize * 1.6;
  const blockH = fitSize * 1.0 + labelLines.length * labelLH + (subLines.length ? subLines.length * subLH + subSize * 0.5 : 0);
  let y = (H - blockH) / 2 + fitSize * 0.78;
  const out = [backgroundLayer(dims, theme, "stat-hero")];
  out.push(textNode({ x: W / 2, y, text: metric, anchor: "middle", size: fitSize, weight: "black", fill: theme.colors.primary }));
  y += Math.round(fitSize * 0.15);
  for (let i = 0; i < labelLines.length; i++) {
    y += labelLH;
    out.push(textNode({ x: W / 2, y, text: labelLines[i], anchor: "middle", size: labelSize, weight: "medium", fill: theme.colors.text }));
  }
  if (subLines.length) {
    y += Math.round(subSize * 0.6);
    for (const line of subLines) {
      y += subLH;
      out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: subSize, weight: "regular", fill: theme.colors.muted }));
    }
  }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_product_grid_2(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.06);
  const gap = Math.round(W * 0.03);
  const gridH = Math.round(H * 0.46);
  const cellW = Math.floor((W - pad * 2 - gap) / 2);
  const cellH = gridH;
  const radius = theme.radius;
  const textTop = pad + gridH + Math.round(H * 0.05);
  const textW = W - pad * 2;
  const scale = typeScale(H, "compact");
  const headSize = scale.headline;
  const subSize = scale.sub;
  const bodySize = scale.body;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, textW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, textW, subSize, "medium");
  const bodyLines = wrapToWidth(t.body, textW, bodySize, "regular");
  const headLH = headSize * 1.08;
  const subLH = subSize * 1.4;
  const bodyLH = bodySize * 1.62;
  let y = textTop + headSize * 0.85;
  const out = [backgroundLayer(dims, theme, "product-grid-2")];
  const slotA = data.images?.primary?.dataUri;
  const slotB = data.images?.secondary?.dataUri;
  const drawCell = (dataUri, x, y, id) => {
    if (dataUri) {
      out.push(`<defs><clipPath id="cell-clip-${id}"><rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="${radius}"/></clipPath></defs><image href="${escAttr(dataUri)}" x="${x}" y="${y}" width="${cellW}" height="${cellH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cell-clip-${id})"/>`);
    } else {
      out.push(`<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="${radius}" fill="${escAttr(theme.colors.surface)}"/>`);
      out.push(`<rect x="${x + 12}" y="${y + 12}" width="${cellW - 24}" height="${cellH - 24}" rx="${radius}" fill="none" stroke="${escAttr(theme.colors.primary)}" stroke-width="2" stroke-dasharray="6 6" opacity="0.35"/>`);
    }
  };
  drawCell(slotA, pad, pad, "a");
  drawCell(slotB, pad + cellW + gap, pad, "b");
  if (t.kicker) out.push(textNode({ x: pad, y: textTop - headSize * 0.35, text: t.kicker.toUpperCase(), size: Math.round(headSize * 0.32), weight: "black", letterSpacing: headSize * 0.06, fill: theme.colors.accent }));
  for (const line of headLines) { out.push(textNode({ x: pad, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { out.push(textNode({ x: pad, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (bodyLines.length) { y += Math.round(bodySize * 0.7); for (const line of bodyLines) { out.push(textNode({ x: pad, y, text: line, size: bodySize, weight: "regular", fill: theme.colors.muted })); y += bodyLH; } }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_scene_poster(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const sa = safeArea(W, H);
  const boxW = W - sa.left - sa.right;
  const scale = typeScale(H);
  const headSize = scale.headline * 1.12;
  const subSize = scale.sub;
  const footSize = scale.caption;
  const kickSize = scale.kicker;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, boxW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, boxW, subSize, "medium");
  const headLH = headSize * 1.04;
  const subLH = subSize * 1.32;
  const blockH = headLines.length * headLH + (subLines.length ? subLines.length * subLH + subSize * 0.5 : 0) + (t.footer ? footSize * 2 : 0) + (t.kicker ? kickSize * 2 : 0);
  const blockTop = H - blockH - sa.bottom - H * 0.03;

  const out = [backgroundLayer(dims, theme, "scene-poster")];
  out.push(`<defs><linearGradient id="scene-scrim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="rgba(0,0,0,0)"/>
    <stop offset="0.6" stop-color="rgba(0,0,0,0.45)"/>
    <stop offset="1" stop-color="rgba(0,0,0,0.88)"/>
  </linearGradient></defs>
  <rect x="0" y="${(H * 0.30).toFixed(1)}" width="${W}" height="${(H * 0.70).toFixed(1)}" fill="url(#scene-scrim)"/>`);

  let y = blockTop + headSize * 0.85;
  if (t.kicker) {
    out.push(textNode({ x: sa.left, y: blockTop - kickSize * 0.2, text: t.kicker.toUpperCase(), size: kickSize, weight: "black", letterSpacing: kickSize * 0.14, fill: theme.colors.accent }));
  }
  for (const line of headLines) { out.push(textNode({ x: sa.left, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { out.push(textNode({ x: sa.left, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (t.footer) { y += Math.round(footSize * 0.6); out.push(textNode({ x: sa.left, y, text: t.footer, size: footSize, weight: "bold", fill: theme.colors.primary })); }

  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_scene_card(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const sa = safeArea(W, H);
  const sceneH = H * 0.48;
  const cardY = sceneH + H * 0.02;
  const cardH = H - cardY - sa.bottom;
  const cardPad = Math.round(cardH * 0.10);
  const boxW = W - sa.left - sa.right - cardPad * 2;
  const scale = typeScale(cardH, "compact");
  const headSize = scale.headline;
  const subSize = scale.sub;
  const bodySize = scale.body;
  const headLines = wrapToWidth(applyHeadlineCase(t.headline, theme.headlineCase), boxW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, boxW, subSize, "medium");
  const bodyLines = wrapToWidth(t.body, boxW, bodySize, "regular");
  const headLH = headSize * 1.08;
  const subLH = subSize * 1.36;
  const bodyLH = bodySize * 1.6;
  const blockH = headLines.length * headLH + (subLines.length ? subLines.length * subLH + subSize * 0.5 : 0) + (bodyLines.length ? bodyLines.length * bodyLH + bodySize * 0.7 : 0);
  let y = cardY + (cardH - blockH) / 2 + headSize * 0.85;

  const out = [];
  out.push(`<defs><clipPath id="sc-card-clip"><rect x="0" y="0" width="${W}" height="${sceneH.toFixed(1)}"/></clipPath></defs>`);
  out.push(`<g clip-path="url(#sc-card-clip)">${backgroundLayer(dims, theme, "scene-card")}</g>`);
  out.push(`<rect x="0" y="${cardY.toFixed(1)}" width="${W}" height="${(H - cardY).toFixed(1)}" fill="${escAttr(theme.variant === "light" ? "#ffffff" : "#0f0f12")}"/>`);
  out.push(`<rect x="0" y="${(cardY - 2).toFixed(1)}" width="${W}" height="2" fill="${escAttr(theme.colors.primary)}"/>`);

  const textX = sa.left + cardPad;
  for (const line of headLines) { out.push(textNode({ x: textX, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { out.push(textNode({ x: textX, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (bodyLines.length) { y += Math.round(bodySize * 0.7); for (const line of bodyLines) { out.push(textNode({ x: textX, y, text: line, size: bodySize, weight: "regular", fill: theme.colors.muted })); y += bodyLH; } }

  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

// ── NEW: browser-frame ───────────────────────────────────────
function tpl_browser_frame(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const sa = safeArea(W, H);
  const chromeH = Math.round(H * 0.075);
  const radius = Math.round(Math.min(W, H) * 0.022);
  const pad = Math.round(Math.min(W, H) * 0.04);
  const frameX = pad;
  const frameY = pad;
  const frameW = W - pad * 2;
  const frameH = H - pad * 2;
  const contentX = frameX + Math.round(frameW * 0.05);
  const contentY = frameY + chromeH + Math.round(frameH * 0.06);
  const contentW = frameW - Math.round(frameW * 0.10);

  const scale = typeScale(frameH, "compact");
  const headSize = scale.headline * 1.15;
  const subSize = scale.sub;
  const kickSize = scale.kicker * 0.9;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrapToWidth(headline, contentW, headSize, "black");
  const subLines = wrapToWidth(t.subheadline, contentW, subSize, "medium");
  const headLH = headSize * 1.05;
  const subLH = subSize * 1.4;

  const isLight = theme.variant === "light";
  const frameBg = isLight ? "#ffffff" : "#0f1118";
  const chromeBg = isLight ? "#f1f2f4" : "#191c24";
  const chromeBorder = isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.10)";
  const dotRed = "#ef4444";
  const dotYel = "#f59e0b";
  const dotGrn = "#10b981";
  const urlChipBg = isLight ? "#ffffff" : "#0a0c10";
  const urlChipBorder = isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.08)";

  const out = [backgroundLayer(dims, theme, "browser-frame")];

  // Frame shadow
  out.push(`<defs><filter id="bf-shadow" x="-5%" y="-5%" width="110%" height="110%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="${Math.round(W * 0.02)}"/>
    <feOffset dx="0" dy="${Math.round(W * 0.01)}"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter></defs>`);

  // Frame base
  out.push(`<g filter="url(#bf-shadow)">
    <rect x="${frameX}" y="${frameY}" width="${frameW}" height="${frameH}" rx="${radius}" fill="${frameBg}" stroke="${chromeBorder}" stroke-width="1.5"/>
  </g>`);

  // Chrome bar
  out.push(`<path d="M${frameX + radius},${frameY} h${frameW - radius * 2} a${radius},${radius} 0 0 1 ${radius},${radius} v${chromeH - radius} h${-frameW} v${-(chromeH - radius)} a${radius},${radius} 0 0 1 ${radius},${-radius} z" fill="${chromeBg}"/>`);
  out.push(`<line x1="${frameX}" y1="${frameY + chromeH}" x2="${frameX + frameW}" y2="${frameY + chromeH}" stroke="${chromeBorder}" stroke-width="1"/>`);

  // Traffic lights
  const dotR = Math.max(4, Math.round(chromeH * 0.14));
  const dotY = frameY + chromeH / 2;
  const dotStart = frameX + Math.round(frameW * 0.028);
  const dotGap = Math.round(dotR * 2.6);
  out.push(`<circle cx="${dotStart}" cy="${dotY}" r="${dotR}" fill="${dotRed}" opacity="0.85"/>`);
  out.push(`<circle cx="${dotStart + dotGap}" cy="${dotY}" r="${dotR}" fill="${dotYel}" opacity="0.85"/>`);
  out.push(`<circle cx="${dotStart + dotGap * 2}" cy="${dotY}" r="${dotR}" fill="${dotGrn}" opacity="0.85"/>`);

  // URL chip
  const urlX = dotStart + dotGap * 2 + Math.round(dotGap * 1.2);
  const urlW = frameW - (urlX - frameX) - Math.round(frameW * 0.028);
  const urlH = Math.round(chromeH * 0.60);
  const urlY = frameY + (chromeH - urlH) / 2;
  const urlR = Math.round(urlH * 0.28);
  out.push(`<rect x="${urlX}" y="${urlY}" width="${urlW}" height="${urlH}" rx="${urlR}" fill="${urlChipBg}" stroke="${urlChipBorder}" stroke-width="1"/>`);
  const urlText = t.kicker ? t.kicker.replace(/^https?:\/\//, "") : "your-project.folio.app";
  const urlFontSize = Math.round(urlH * 0.55);
  const lockX = urlX + Math.round(urlH * 0.5);
  const lockY = urlY + urlH / 2;
  const lockR = Math.round(urlH * 0.18);
  out.push(`<rect x="${lockX - lockR * 0.8}" y="${lockY - lockR * 0.2}" width="${lockR * 1.6}" height="${lockR * 1.3}" rx="${lockR * 0.25}" fill="${isLight ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.45)"}"/>`);
  out.push(textNode({
    x: lockX + lockR * 1.8,
    y: lockY + urlFontSize * 0.34,
    text: urlText,
    size: urlFontSize,
    weight: "medium",
    fill: isLight ? "rgba(15,15,18,0.55)" : "rgba(255,255,255,0.55)",
  }));

  // Icon (top of content)
  const iconSize = Math.round(frameH * 0.10);
  const primaryImage = data.images?.primary?.dataUri;
  if (primaryImage) {
    out.push(`<defs><clipPath id="bf-icon-clip"><rect x="${contentX}" y="${contentY}" width="${iconSize}" height="${iconSize}" rx="${Math.round(iconSize * 0.22)}"/></clipPath></defs>
      <image href="${escAttr(primaryImage)}" x="${contentX}" y="${contentY}" width="${iconSize}" height="${iconSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#bf-icon-clip)"/>
      <rect x="${contentX}" y="${contentY}" width="${iconSize}" height="${iconSize}" rx="${Math.round(iconSize * 0.22)}" fill="none" stroke="${escAttr(theme.colors.primary)}" stroke-width="1.5" opacity="0.5"/>`);
  } else {
    out.push(`<rect x="${contentX}" y="${contentY}" width="${iconSize}" height="${iconSize}" rx="${Math.round(iconSize * 0.22)}" fill="${escAttr(theme.colors.primary)}" opacity="0.85"/>`);
  }

  // Text block
  let y = contentY + iconSize + Math.round(frameH * 0.05) + headSize * 0.85;
  for (const line of headLines) {
    out.push(textNode({ x: contentX, y, text: line, size: headSize, weight: "black", fill: theme.colors.text }));
    y += headLH;
  }
  if (subLines.length) {
    y += Math.round(subSize * 0.6);
    for (const line of subLines) {
      out.push(textNode({ x: contentX, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted }));
      y += subLH;
    }
  }

  // CTA pill
  if (t.footer || t.body) {
    const ctaText = t.footer || (t.body.length > 40 ? t.body.slice(0, 40) + "…" : t.body);
    const ctaSize = Math.round(headSize * 0.42);
    const ctaPad = Math.round(ctaSize * 1.2);
    const ctaW = Math.min(contentW, measureText(ctaText, ctaSize, "bold") + ctaPad * 2);
    const ctaH = Math.round(ctaSize * 2.2);
    const ctaX = contentX;
    const ctaY = y + Math.round(subSize * 0.8);
    out.push(`<rect x="${ctaX}" y="${ctaY}" width="${ctaW}" height="${ctaH}" rx="${Math.round(ctaH / 2)}" fill="${escAttr(theme.colors.primary)}"/>`);
    out.push(textNode({
      x: ctaX + ctaW / 2,
      y: ctaY + ctaH / 2 + ctaSize * 0.34,
      text: ctaText,
      anchor: "middle",
      size: ctaSize,
      weight: "bold",
      fill: isLight ? "#0a0c10" : "#0a0c10",
    }));
  }

  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

const TEMPLATES = {
  default: tpl_default,
  "hero-short": tpl_hero_short,
  "poster-centered": tpl_poster_centered,
  "image-shadow-bottom": tpl_image_shadow_bottom,
  "image-blur-text": tpl_image_blur_text,
  "image-card-side-text": tpl_image_card_side_text,
  "newspaper-classic": tpl_newspaper_classic,
  "quote-card": tpl_quote_card,
  "random-lines-top": tpl_random_lines_top,
  "event-poster": tpl_event_poster,
  "split-image-side": tpl_split_image_side,
  "feature-image-top": tpl_feature_image_top,
  "image-badge-overlay": tpl_image_badge_overlay,
  "strip-bottom": tpl_strip_bottom,
  "stat-hero": tpl_stat_hero,
  "product-grid-2": tpl_product_grid_2,
  "scene-poster": tpl_scene_poster,
  "scene-card": tpl_scene_card,
  "browser-frame": tpl_browser_frame,
};

// ═══════════════════════════════════════════════════════════════════
//  OUTPUT SIZE + BUILDER
// ═══════════════════════════════════════════════════════════════════

function enforceOutputEdge(dims) {
  if (dims.w <= MAX_OUTPUT_EDGE && dims.h <= MAX_OUTPUT_EDGE) return dims;
  const scale = Math.min(MAX_OUTPUT_EDGE / dims.w, MAX_OUTPUT_EDGE / dims.h);
  return { w: Math.round(dims.w * scale), h: Math.round(dims.h * scale) };
}

async function buildSvg(body) {
  initFont();
  const sizeKey = body.size;
  const dims = enforceOutputEdge({ w: SIZES[sizeKey].w, h: SIZES[sizeKey].h });
  const text = resolveText(body.data);

  // Determine seed for palette + scene selection
  const seed = body.seed
    || text.headline
    || body.template
    || `t_${Date.now()}`;

  const theme = resolveTheme(body.data, seed);
  theme.seed = seed;
  theme.text = text;

  const warn = (msg) => { if (!body.warnings.includes(msg)) body.warnings.push(msg); };
  const imageBudget = { used: 0 };

  const [bgResult, primaryResult, secondaryResult, logoResult] = await Promise.all([
    body.data?.images?.background ? imageToDataUri(body.data.images.background, warn, imageBudget) : Promise.resolve({ dataUri: null }),
    body.data?.images?.primary ? imageToDataUri(body.data.images.primary, warn, imageBudget) : Promise.resolve({ dataUri: null }),
    body.data?.images?.secondary ? imageToDataUri(body.data.images.secondary, warn, imageBudget) : Promise.resolve({ dataUri: null }),
    body.data?.images?.logo ? imageToDataUri(body.data.images.logo, warn, imageBudget) : Promise.resolve({ dataUri: null }),
  ]);

  const imageReport = {
    background: summarizeImageResult(bgResult),
    primary: summarizeImageResult(primaryResult),
    secondary: summarizeImageResult(secondaryResult),
    logo: summarizeImageResult(logoResult),
  };

  if (bgResult.dataUri) {
    theme.background.type = "image";
    theme.background.dataUri = bgResult.dataUri;
    if (body.data.images.background?.overlay) theme.background.overlay = cleanColor(body.data.images.background.overlay, "rgba(0,0,0,0.55)");
    if (body.data.images.background?.blur != null) theme.background.blur = cleanNumber(body.data.images.background.blur, 0, 40, 0);
  }

  const data = {
    text,
    theme,
    images: {
      primary: { dataUri: primaryResult.dataUri },
      secondary: { dataUri: secondaryResult.dataUri },
      logo: { dataUri: logoResult.dataUri },
    },
  };

  if (body.type === "template") {
    const name = TEMPLATES[body.template] ? body.template : "default";
    if (name !== body.template) warn(`template '${body.template}' not found, used 'default'`);
    const svg = TEMPLATES[name](data, theme, dims);
    const chosenScene = theme.scene === "none" || theme.scene === false ? null
      : (theme.scene === "random" ? "random" : (theme.scene || pickScene(theme.seed, name, null)));
    return { svg, dims, template: name, scene: chosenScene, imageReport, seed };
  }
  if (body.type === "svg") {
    const clean = sanitizeSvg(body.svg);
    const $ = cheerio.load(clean, { xmlMode: true });
    $("svg").attr("viewBox", `0 0 ${dims.w} ${dims.h}`);
    $("svg").attr("width", String(dims.w));
    $("svg").attr("height", String(dims.h));
    let svg = $.xml();
    svg = svg.replace(/<\/svg>\s*$/i, `${watermark(dims, theme)}</svg>`);
    return { svg, dims, template: "svg", scene: null, imageReport, seed };
  }
  if (body.type === "html") {
    const html = String(body.html || "");
    if (html.length > MAX_HTML_CHARS) throw Object.assign(new Error("html too large"), { status: 413 });
    const bodySvg = htmlToSvgBody(html, dims, theme);
    const out = [backgroundLayer(dims, theme, "html"), bodySvg, watermark(dims, theme)];
    return { svg: svgWrap(dims, theme, out.join("\n")), dims, template: "html", scene: null, imageReport, seed };
  }
  throw Object.assign(new Error(`unknown type: ${body.type}`), { status: 400 });
}

function summarizeImageResult(r) {
  if (!r) return { ok: false, code: "NONE", message: "no image" };
  if (r.error) return { ok: false, code: r.error, message: r.message || r.error };
  if (!r.dataUri) return { ok: false, code: "EMPTY", message: "empty" };
  return { ok: true, bytes: r.bytes, mime: r.mime, ms: r.ms, cached: !!r.cached };
}

// ═══════════════════════════════════════════════════════════════════
//  HTML → SVG (fallback renderer)
// ═══════════════════════════════════════════════════════════════════

function parseInlineStyle(s) {
  const out = {};
  if (!s) return out;
  for (const part of String(s).split(";")) {
    const [k, ...rest] = part.split(":");
    if (!k || !rest.length) continue;
    const key = k.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (key && val && key.length < 40 && val.length < 200) out[key] = val;
  }
  return out;
}

function cssPx(v, base = 16, fallback = 0) {
  if (v == null) return fallback;
  const s = String(v).trim();
  const m = s.match(/^(-?\d*\.?\d+)(px|pt|em|rem|%)?$/);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const unit = m[2] || "px";
  if (unit === "px") return n;
  if (unit === "pt") return (n * 4) / 3;
  if (unit === "em" || unit === "rem") return n * base;
  if (unit === "%") return (n / 100) * base;
  return n;
}

function tagDefaults(tag) {
  switch (tag) {
    case "h1": return { size: 64, weight: "black" };
    case "h2": return { size: 48, weight: "bold" };
    case "h3": return { size: 32, weight: "bold" };
    case "h4": return { size: 24, weight: "bold" };
    case "h5": return { size: 20, weight: "medium" };
    case "h6": return { size: 16, weight: "medium" };
    case "p": return { size: 20, weight: "regular" };
    case "small": return { size: 14, weight: "regular" };
    default: return { size: 20, weight: "regular" };
  }
}

function htmlToSvgBody(html, dims, theme) {
  const { w: W, h: H } = dims;
  const $ = cheerio.load(html, { xmlMode: false });
  const out = [];
  const pad = Math.round(Math.min(W, H) * 0.08);
  let y = pad;

  const root = $("body").length ? $("body") : $.root();
  const blocks = root.children().toArray();

  if (!blocks.length) {
    const text = root.text().trim();
    const fontSize = 32;
    const weight = "bold";
    const lines = wrapToWidth(text, W - pad * 2, fontSize, weight);
    const lh = Math.round(fontSize * 1.25);
    for (const line of lines) {
      y += lh;
      out.push(textNode({ x: pad, y, text: line, size: fontSize, weight, fill: theme.colors.text }));
    }
    return out.join("\n");
  }

  for (const el of blocks) {
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "script" || tag === "style") continue;
    const $el = $(el);
    const inline = parseInlineStyle($el.attr("style") || "");
    const defaults = tagDefaults(tag);

    if (tag === "img") {
      const src = $el.attr("src") || "";
      const maxW = W - pad * 2;
      const maxH = Math.round(H * 0.5);
      const w = Math.min(cssPx(inline.width, 16, maxW), maxW);
      const h = Math.min(cssPx(inline.height, 16, maxH), maxH);
      if (src.startsWith("data:image/")) {
        out.push(`<image href="${escAttr(src)}" x="${(W - w) / 2}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`);
        y += h + 24;
      }
      continue;
    }

    const rawText = $el.text().trim();
    if (!rawText) continue;

    const fontSize = cssPx(inline["font-size"], 16, defaults.size);
    const fontWeight = inline["font-weight"] === "900" ? "black" : inline["font-weight"] === "700" ? "bold" : inline["font-weight"] === "600" ? "medium" : inline["font-weight"] === "500" ? "medium" : defaults.weight;
    const color = inline.color || theme.colors.text;
    const align = inline["text-align"] || theme.align;
    const boxW = W - pad * 2;
    const lines = wrapToWidth(rawText, boxW, fontSize, fontWeight);
    const lineHeight = Math.round(fontSize * 1.25);

    const bg = inline.background || inline["background-color"];
    if (bg && bg !== "transparent" && bg !== "none") {
      const blockH = lines.length * lineHeight + 24;
      out.push(`<rect x="${pad - 12}" y="${y - 12}" width="${boxW + 24}" height="${blockH}" rx="12" fill="${escAttr(cleanColor(bg, "transparent"))}"/>`);
    }

    const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
    const x = align === "center" ? W / 2 : align === "right" ? W - pad : pad;

    for (const line of lines) {
      y += lineHeight;
      out.push(textNode({ x, y, text: line, anchor, size: fontSize, weight: fontWeight, fill: cleanColor(color, theme.colors.text) }));
    }
    y += Math.round(fontSize * 0.6);
  }

  if (y > H - pad) theme.warnings?.push?.(`html content overflowed canvas (y=${y}, H=${H})`);
  return out.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
//  SVG SANITIZER
// ═══════════════════════════════════════════════════════════════════

const SVG_TAGS = new Set(["svg", "g", "defs", "symbol", "use", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "textPath", "image", "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "filter", "feGaussianBlur", "feColorMatrix", "feOffset", "feBlend", "feComposite", "feTurbulence", "feDisplacementMap", "feMerge", "feMergeNode", "feFlood", "title", "desc"]);
const SVG_TAGS_LOWER = new Set([...SVG_TAGS].map(t => t.toLowerCase()));
const SVG_ATTRS = new Set(["id", "class", "x", "y", "width", "height", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "transform", "viewbox", "preserveaspectratio", "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "word-spacing", "text-anchor", "dominant-baseline", "alignment-baseline", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "spreadmethod", "patternunits", "patterntransform", "patterncontentunits", "clippathunits", "maskunits", "maskcontentunits", "filterunits", "primitiveunits", "stddeviation", "in", "in2", "result", "mode", "operator", "type", "values", "basefrequency", "numoctaves", "scale", "xchannelselector", "ychannelselector", "href", "xlink:href", "xmlns", "xmlns:xlink", "version", "visibility", "display", "filter"]);

function sanitizeSvg(svg) {
  if (typeof svg !== "string" || !svg.trim()) throw Object.assign(new Error("empty svg"), { status: 400 });
  if (svg.length > MAX_SVG_CHARS) throw Object.assign(new Error("svg too large"), { status: 413 });

  const $ = cheerio.load(svg, { xmlMode: true, decodeEntities: false });
  if (!$("svg").length) throw Object.assign(new Error("no <svg> element"), { status: 400 });

  function walk(node) {
    if (node.type === "tag") {
      const raw = node.name || "";
      const lower = raw.toLowerCase();
      const isKnown = SVG_TAGS.has(raw) || SVG_TAGS_LOWER.has(lower);
      if (!isKnown) { $(node).remove(); return; }
      for (const [k, v] of Object.entries({ ...(node.attribs || {}) })) {
        const key = k.toLowerCase();
        if (key.startsWith("on")) { delete node.attribs[k]; continue; }
        if (/^\s*javascript:/i.test(String(v))) { delete node.attribs[k]; continue; }
        if (key === "href" || key === "xlink:href") {
          const sv = String(v);
          if (sv.startsWith("#") || /^data:image\//i.test(sv)) continue;
          if (!isSafeImageUrl(sv)) { delete node.attribs[k]; continue; }
          continue;
        }
        if (!SVG_ATTRS.has(key) && !SVG_ATTRS.has(k)) delete node.attribs[k];
      }
    }
    if (node.children) node.children.forEach(walk);
  }

  $.root().children().each((_, el) => walk(el));

  const $svg = $("svg").first();
  if (!$svg.attr("xmlns")) $svg.attr("xmlns", "http://www.w3.org/2000/svg");
  if (!$svg.attr("xmlns:xlink")) $svg.attr("xmlns:xlink", "http://www.w3.org/1999/xlink");

  return $.xml();
}

// ═══════════════════════════════════════════════════════════════════
//  RENDER + UPLOAD
// ═══════════════════════════════════════════════════════════════════

async function renderPng(svg, dims, reqId) {
  const opts = { fitTo: { mode: "original" }, background: "transparent" };
  if (fontBuffers && fontBuffers.length) opts.font = { fontBuffers, loadSystemFonts: false };
  const resvg = new Resvg(svg, opts);
  return resvg.render().asPng();
}

async function uploadPng(pngBuffer, name, reqId) {
  let res;
  try {
    res = await fetch(IMAGE_UPLOAD_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_API_KEY}`, "X-API-Key": ADMIN_API_KEY },
      body: JSON.stringify({ image: Buffer.from(pngBuffer).toString("base64"), name }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    log("upload.fetch_error", { reqId, message: e.message });
    throw Object.assign(new Error(`imageupload unreachable: ${e.message}`), { status: 502 });
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    log("upload.http_error", { reqId, status: res.status, body: txt.slice(0, 200) });
    throw Object.assign(new Error(`imageupload HTTP ${res.status}`), { status: 502 });
  }
  const json = await res.json();
  const data = json.data || {};
  if (!data.url && !data.display_url) throw Object.assign(new Error("imageupload returned no URL"), { status: 502 });
  return data;
}

// ═══════════════════════════════════════════════════════════════════
//  UPLOAD VALIDATION
// ═══════════════════════════════════════════════════════════════════

function validateUpload(dataUrl, kind) {
  if (!dataUrl || typeof dataUrl !== "string") return { ok: false, status: 400, error: "Missing dataUrl" };
  if (!dataUrl.startsWith("data:image/")) return { ok: false, status: 400, error: "dataUrl must be a base64 image" };
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return { ok: false, status: 400, error: "Malformed data URL" };

  const declared = dataUrl.slice(5, comma).split(";")[0].toLowerCase();
  const b64 = dataUrl.slice(comma + 1);
  if (!b64 || b64.length < 100) return { ok: false, status: 400, error: "dataUrl too small" };

  let buf;
  try { buf = Buffer.from(b64, "base64"); } catch { return { ok: false, status: 400, error: "Invalid base64" }; }
  if (buf.length === 0) return { ok: false, status: 400, error: "Empty image" };
  if (buf.length > UPLOAD_MAX_BYTES) return { ok: false, status: 413, error: `Image exceeds ${UPLOAD_MAX_BYTES / 1024} KB` };

  const sniffed = sniffMime(buf);
  if (!sniffed) return { ok: false, status: 400, error: "Not a valid image (magic bytes)" };

  const declaredSub = declared.split("/")[1] || "";
  const sniffedSub = sniffed.split("/")[1] || "";
  if (declaredSub && declaredSub !== "jpg" && declaredSub !== "svg+xml" && declaredSub !== sniffedSub) {
    return { ok: false, status: 400, error: "Declared MIME does not match image bytes" };
  }

  if (sniffed === "image/svg+xml") {
    if (!isSafeSvgText(buf.toString("utf8"))) {
      return { ok: false, status: 400, error: "SVG contains disallowed content" };
    }
  } else {
    const dims = getImageDimensions(buf, sniffed);
    if (dims && (dims.width > UPLOAD_MAX_EDGE || dims.height > UPLOAD_MAX_EDGE)) {
      return { ok: false, status: 413, error: `Image exceeds ${UPLOAD_MAX_EDGE}×${UPLOAD_MAX_EDGE}` };
    }
  }

  const finalUrl = `data:${sniffed};base64,${buf.toString("base64")}`;
  return { ok: true, buffer: buf, mime: sniffed, dataUrl: finalUrl };
}

function getImageDimensions(buf, mime) {
  try {
    if (mime === "image/png" && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === "image/gif" && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset < buf.length - 9) {
        if (buf[offset] !== 0xFF) { offset++; continue; }
        const marker = buf[offset + 1];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        const segLen = buf.readUInt16BE(offset + 2);
        offset += 2 + segLen;
      }
    }
    if (mime === "image/webp" && buf.length >= 30) {
      const type = buf.slice(12, 16).toString("ascii");
      if (type === "VP8X") {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width: w, height: h };
      }
    }
  } catch {}
  return null;
}

// ═══════════════════════════════════════════════════════════════════
//  HANDLER
// ═══════════════════════════════════════════════════════════════════

export const runtime = "nodejs";
export const config = { api: { bodyParser: { sizeLimit: "10mb" } }, maxDuration: 60 };

export default async function handler(req, res) {
  const reqId = newReqId();
  const t0 = Date.now();
  res.setHeader("X-Request-Id", reqId);

  if (req.method === "OPTIONS") {
    if (!applyCors(req, res)) return res.status(403).json({ error: "Origin not allowed" });
    return res.status(200).end();
  }
  if (!applyCors(req, res)) {
    log("cors.reject", { reqId, origin: req.headers.origin });
    return res.status(403).json({ error: "Origin not allowed" });
  }

  const action = String(req.query?.action || req.body?.action || "").trim();
  const identity = tryVerifyJwt(req);

  // ── AVATAR PREVIEW — 5 variants, seeded random palettes per variant ──
  if (action === "avatar/preview") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const rl = avatarRateLimit(`avatar:${ipHash(req)}`);
    setRateHeaders(res, rl, "preview", "ip");
    if (!rl.ok) return res.status(429).json({ error: "RATE_LIMITED", dimension: "ip", retryAfter: 3600 });

    const { username, displayName } = req.body || {};
    if (!username || typeof username !== "string") return res.status(400).json({ success: false, error: "Missing username" });
    if (username.length < 1 || username.length > 40) return res.status(400).json({ success: false, error: "Invalid username length" });

    const safeUsername = String(username).slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, "");
    const safeDisplayName = String(displayName || username).slice(0, 60).trim();
    const cacheHash = cacheKey({ safeUsername, safeDisplayName, v: 4 });
    const cached = avatarCacheGet(cacheHash);
    if (cached) {
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.status(200).json({ success: true, variants: cached, cached: true });
    }

    // Note: only templates/scenes are fixed per variant. Colors are seeded
    // random per (username, variantId) so every user gets a distinct palette.
    const AVATAR_VARIANTS = [
      { id: "v1", kind: "initials-solid",   label: "Initials",  template: "hero-short",            scene: "ribbon" },
      { id: "v2", kind: "initials-gradient",label: "Gradient",  template: "poster-centered",       scene: "grid_wave" },
      { id: "v3", kind: "username-dark",    label: "Username",  template: "poster-centered",       scene: "terminal" },
      { id: "v4", kind: "initials-pattern", label: "Patterned", template: "random-lines-top",      scene: "halftone" },
      { id: "v5", kind: "fullname-badge",   label: "Badge",     template: "image-badge-overlay",   scene: "vinyl" },
    ];

    function initialsFrom(displayName, username) {
      const src = (displayName || username || "?").trim();
      const parts = src.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return src.slice(0, 2).toUpperCase();
    }

    const initials = initialsFrom(safeDisplayName, safeUsername);

    const results = await Promise.allSettled(AVATAR_VARIANTS.map(async (variant) => {
      // Seed = username + variantId. This makes the palette deterministic per
      // user + variant, but different between variants (so the 5 avatars are
      // visually distinct beyond just template/scene).
      const seed = `${safeUsername}:${variant.id}`;
      const base = {
        mode: "preview",
        type: "template",
        template: variant.template,
        size: "512x512",
        seed,
        data: {
          text: {},
          style: {
            variant: "dark",
            scene: variant.scene,
            scenePalette: "auto",
            // Intentionally do NOT set colors or background —
            // resolveTheme() seeds them from `seed`.
          },
          images: {},
        },
      };
      switch (variant.id) {
        case "v1": base.data.text.headline = initials; break;
        case "v2": base.data.text.headline = initials; break;
        case "v3": base.data.text.headline = safeUsername ? `@${safeUsername}` : initials; break;
        case "v4": base.data.text.headline = initials; break;
        case "v5":
          base.data.text.headline = safeDisplayName || safeUsername || initials;
          base.data.text.kicker = initials;
          break;
      }
      const body = normalizeInput(base);
      const built = await buildSvg(body);
      const png = await renderPng(built.svg, built.dims, reqId);
      return {
        id: variant.id,
        kind: variant.kind,
        label: variant.label,
        dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        width: built.dims.w,
        height: built.dims.h,
        scene: built.scene,
      };
    }));

    const variants = results.filter(r => r.status === "fulfilled").map(r => r.value);
    if (variants.length === 0) return res.status(500).json({ success: false, error: "Could not generate avatars" });

    avatarCacheSet(cacheHash, variants);
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).json({ success: true, variants });
  }

  // ── AVATAR UPLOAD ──
  if (action === "avatar/upload") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const rl = avatarRateLimit(`avatar:${ipHash(req)}`);
    setRateHeaders(res, rl, "preview", "ip");
    if (!rl.ok) return res.status(429).json({ error: "RATE_LIMITED", dimension: "ip", retryAfter: 3600 });

    const { dataUrl, username } = req.body || {};
    const validation = validateUpload(dataUrl);
    if (!validation.ok) return res.status(validation.status || 400).json({ success: false, error: validation.error });

    const safeUsername = String(username || "user").slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, "") || "user";
    const uploadName = `avatar_${safeUsername}_${Date.now()}`;

    try {
      const uploaded = await uploadPng(validation.buffer, uploadName, reqId);
      const url = uploaded.url || uploaded.display_url;
      if (!url || !String(url).startsWith("https://")) return res.status(502).json({ success: false, error: "Upload returned no URL" });
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ success: true, url, width: uploaded.width || null, height: uploaded.height || null, bytes: validation.buffer.length });
    } catch (err) {
      log("avatar.upload.error", { reqId, message: err.message });
      return res.status(err.status || 500).json({ success: false, error: err.message || "Upload failed" });
    }
  }

  // ── AVATAR CUSTOM (legacy) ──
  if (action === "avatar/custom") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!identity.isAuth) return res.status(401).json({ success: false, error: "Authentication required" });

    const rl = avatarCustomRateLimit(identity.uid);
    setRateHeaders(res, rl, "custom", "uid");
    if (!rl.ok) {
      log("avatar.custom.rate_limit", { reqId, uid: identity.uid });
      return res.status(429).json({
        success: false, error: "Rate limit exceeded",
        retryAfter: Math.ceil((new Date(rl.resetAt).getTime() - Date.now()) / 1000),
      });
    }

    try {
      const raw = req.body || {};
      const body = normalizeInput(raw);
      const key = cacheKey({ ...body, __mode: "avatar-custom" });
      let png = cacheGet(key);
      let cached = false;
      let built;
      if (png) {
        cached = true;
        built = { dims: enforceOutputEdge({ w: SIZES[body.size].w, h: SIZES[body.size].h }), template: body.template, scene: null, imageReport: {}, seed: body.seed || null };
      } else {
        built = await buildSvg(body);
        png = await renderPng(built.svg, built.dims, reqId);
        if (png.length > MAX_OUTPUT_BYTES) return res.status(413).json({ success: false, error: "Rendered image exceeds 5 MB" });
        cacheSet(key, png);
      }

      if (body.mode === "upload") {
        const name = sanitizeUploadName(body.upload?.name || `avatar_${identity.uid.slice(0, 8)}_${Date.now()}`);
        const uploaded = await uploadPng(png, name, reqId);
        const url = uploaded.url || uploaded.display_url;
        return res.status(200).json({
          success: true, url,
          width: built.dims.w, height: built.dims.h, bytes: png.length,
          template: built.template, scene: built.scene, cached,
        });
      }

      return res.status(200).json({
        success: true,
        preview: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        width: built.dims.w, height: built.dims.h, bytes: png.length,
        template: built.template, scene: built.scene,
        imageReport: built.imageReport, cached,
      });
    } catch (err) {
      log("avatar.custom.error", { reqId, uid: identity.uid, message: err.message });
      return res.status(err.status || 500).json({ success: false, error: err.message || "Render failed" });
    }
  }

  // ── GENERATE ──
  if (action === "generate") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const mode = String(req.body?.mode || "preview");
    const isThumb = mode === "thumb";
    const isUpload = mode === "upload";

    if (isThumb) {
      const rl = thumbRateLimit(`thumb:${ipHash(req)}`);
      setRateHeaders(res, rl, "thumb", "ip");
      if (!rl.ok) return res.status(429).json({ error: "RATE_LIMITED", dimension: "ip", bucket: "thumb" });

      const thumbKey = cacheKey({ body: req.body || {}, __thumb: true });
      const cachedThumb = thumbCacheGet(thumbKey);
      if (cachedThumb) return res.status(200).json({ success: true, mode: "thumb", preview: cachedThumb, cached: true, remaining: rl.remaining });

      try {
        const body = normalizeInput({ ...req.body, mode: "preview", size: "512x512" });
        const built = await buildSvg(body);
        const png = await renderPng(built.svg, built.dims, reqId);
        const dataUri = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
        thumbCacheSet(thumbKey, dataUri);
        return res.status(200).json({
          success: true, mode: "thumb", preview: dataUri,
          width: built.dims.w, height: built.dims.h, bytes: png.length,
          template: built.template, scene: built.scene, imageReport: built.imageReport,
          remaining: rl.remaining,
        });
      } catch (err) {
        log("generate.thumb.error", { reqId, message: err.message });
        return res.status(err.status || 500).json({ success: false, error: err.message || "Render failed" });
      }
    }

    const quotaMap = identity.isAuth ? RL_GENERATE_UID : RL_GENERATE_IP;
    const quotaKey = identity.isAuth ? `gen:uid:${identity.uid}` : `gen:ip:${ipHash(req)}`;
    const quotaLimit = identity.isAuth ? GENERATE_DAILY_LIMIT_UID : GENERATE_DAILY_LIMIT_IP;
    const quota = checkDailyQuota(quotaMap, quotaKey, quotaLimit);
    setRateHeaders(res, { limit: quota.limit, remaining: quota.remaining, resetAt: quota.resetAt }, "generate", identity.isAuth ? "uid" : "ip");
    if (!quota.ok) {
      return res.status(429).json({
        success: false, error: "Daily limit reached",
        limit: quota.limit, scope: identity.isAuth ? "uid" : "ip", bucket: "generate",
        resetAt: quota.resetAt,
      });
    }

    try {
      const raw = req.body || {};
      const body = normalizeInput(raw);
      const key = cacheKey({ ...body, __mode: isUpload ? "generate-upload" : "generate" });
      let png = cacheGet(key);
      let cached = false;
      let built;

      if (png && !isUpload) {
        cached = true;
        built = {
          dims: enforceOutputEdge({ w: SIZES[body.size].w, h: SIZES[body.size].h }),
          template: body.template, scene: null, imageReport: {}, seed: body.seed || null,
        };
      } else {
        built = await buildSvg(body);
        png = await renderPng(built.svg, built.dims, reqId);
        if (png.length > MAX_OUTPUT_BYTES) {
          return res.status(413).json({ success: false, error: "Image exceeds 5 MB", limit: quota.limit, resetAt: quota.resetAt });
        }
        if (!isUpload) cacheSet(key, png);
      }

      if (isUpload) {
        const name = sanitizeUploadName(body.upload?.name || `flier_${(identity.uid || ipHash(req)).slice(0, 8)}_${Date.now()}`);
        const uploaded = await uploadPng(png, name, reqId);
        const url = uploaded.url || uploaded.display_url;
        return res.status(200).json({
          success: true, mode: "upload",
          url, display_url: uploaded.display_url || url, id: uploaded.id || null,
          width: built.dims.w, height: built.dims.h, bytes: png.length,
          template: built.template, scene: built.scene,
          imageReport: built.imageReport, cached,
          remaining: quota.remaining, limit: quota.limit, resetAt: quota.resetAt,
        });
      }

      return res.status(200).json({
        success: true, mode: "preview",
        preview: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        width: built.dims.w, height: built.dims.h, bytes: png.length,
        template: built.template, scene: built.scene,
        imageReport: built.imageReport, cached,
        remaining: quota.remaining, limit: quota.limit, resetAt: quota.resetAt,
      });
    } catch (err) {
      log("generate.error", { reqId, message: err.message, stack: err.stack?.slice(0, 300) });
      return res.status(err.status || 500).json({ success: false, error: err.message || "Render failed" });
    }
  }

  // ── UPLOAD ──
  if (action === "upload") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const quotaMap = identity.isAuth ? RL_UPLOAD_UID : RL_UPLOAD_IP;
    const quotaKey = identity.isAuth ? `up:uid:${identity.uid}` : `up:ip:${ipHash(req)}`;
    const quotaLimit = identity.isAuth ? UPLOAD_DAILY_LIMIT_UID : UPLOAD_DAILY_LIMIT_IP;
    const quota = checkDailyQuota(quotaMap, quotaKey, quotaLimit);
    setRateHeaders(res, { limit: quota.limit, remaining: quota.remaining, resetAt: quota.resetAt }, "upload", identity.isAuth ? "uid" : "ip");
    if (!quota.ok) {
      return res.status(429).json({
        success: false, error: "Daily upload limit reached",
        limit: quota.limit, scope: identity.isAuth ? "uid" : "ip", bucket: "upload", resetAt: quota.resetAt,
      });
    }

    const { dataUrl, kind } = req.body || {};
    const validation = validateUpload(dataUrl, kind);
    if (!validation.ok) {
      return res.status(validation.status || 400).json({
        success: false, error: validation.error,
        remaining: quota.remaining, limit: quota.limit, resetAt: quota.resetAt,
      });
    }

    const safeKind = kind === "icon" ? "icon" : "image";
    const name = sanitizeUploadName(`upload_${safeKind}_${(identity.uid || ipHash(req)).slice(0, 8)}_${Date.now()}`);

    try {
      const uploaded = await uploadPng(validation.buffer, name, reqId);
      const url = uploaded.url || uploaded.display_url;
      if (!url || !String(url).startsWith("https://")) {
        return res.status(502).json({ success: false, error: "Upload returned no URL", remaining: quota.remaining, limit: quota.limit });
      }
      return res.status(200).json({
        success: true, url, display_url: uploaded.display_url || url,
        bytes: validation.buffer.length, mime: validation.mime,
        width: uploaded.width || null, height: uploaded.height || null,
        remaining: quota.remaining, limit: quota.limit, resetAt: quota.resetAt,
      });
    } catch (err) {
      log("upload.error", { reqId, message: err.message });
      return res.status(err.status || 500).json({ success: false, error: err.message || "Upload failed", remaining: quota.remaining, limit: quota.limit });
    }
  }

  // ── SCENES (admin) ──
  if (action === "scenes") {
    if (!isAdmin(req)) return res.status(401).json({ success: false, error: "Admin credentials required" });
    const scenes = Object.entries(SCENE_META).map(([id, meta]) => ({ id, label: meta.label, group: meta.group, hasNight: meta.hasNight }));
    return res.status(200).json({
      success: true, scenes,
      palettes: Object.keys(PALETTES),
      paletteSeeds: PALETTE_SEEDS.length,
      templates: Object.keys(TEMPLATES),
      sizes: Object.keys(SIZES),
    });
  }

  // ── GET (admin) ──
  if (req.method === "GET") {
    if (!isAdmin(req)) return res.status(401).json({ success: false, error: "Admin credentials required" });

    const q = req.query || {};
    if (!q.text && !q.template && !q.headline && !q.html && !q.svg && !q.metric) {
      initFont();
      return res.status(200).json({
        success: true,
        version: "3.1.0-folio",
        sizes: Object.keys(SIZES),
        types: ["template", "svg", "html"],
        modes: ["preview", "upload", "thumb"],
        templates: Object.keys(TEMPLATES),
        scenes: Object.keys(SCENES),
        palettes: Object.keys(PALETTES),
        paletteSeeds: PALETTE_SEEDS.length,
        actions: {
          "generate": "POST — main workhorse (7/day anon, 70/day authed). mode: preview | upload | thumb",
          "upload": "POST { dataUrl, kind } → { url } (5/day anon, 30/day authed)",
          "scenes": "GET — scene catalog (admin only)",
          "avatar/preview": "POST — 5 icon variants with seeded random palettes (public, IP rate-limited)",
          "avatar/upload": "POST { dataUrl } → { url } (public, IP rate-limited)",
          "avatar/custom": "POST — legacy (authed, 60/hr per uid)",
        },
      });
    }

    const rl = rateLimit(`get:${ipHash(req)}`, RATE_LIMIT_IP);
    setRateHeaders(res, rl, "generate", "ip");
    if (!rl.ok) return res.status(429).json({ error: "RATE_LIMITED", dimension: "ip" });

    const raw = {
      mode: "preview",
      type: q.html ? "html" : q.svg ? "svg" : "template",
      template: q.template || "default",
      size: q.size, text: q.text, subtitle: q.subtitle, caption: q.caption,
      tag: q.tag, color: q.color, bg: q.bg, image: q.image, html: q.html, svg: q.svg,
      date: q.date, location: q.location, price: q.price, cta: q.cta,
      metric: q.metric, metricLabel: q.metricLabel,
      variant: q.variant, pattern: q.pattern, align: q.align, headlineCase: q.headlineCase, radius: q.radius,
      scene: q.scene, sceneNight: q.sceneNight, sceneOpacity: q.sceneOpacity,
      seed: q.seed || null,
      data: {},
    };
    if (q.blur) raw.data.images = { background: { blur: Number(q.blur) } };

    try {
      const body = normalizeInput(raw);
      const key = cacheKey(body);
      let png = cacheGet(key);
      let cached = false;
      if (png) cached = true;
      else {
        const built = await buildSvg(body);
        png = await renderPng(built.svg, built.dims, reqId);
        if (png.length > MAX_OUTPUT_BYTES) return res.status(413).json({ success: false, error: "Image exceeds 5 MB" });
        cacheSet(key, png);
      }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=60");
      if (cached) res.setHeader("X-Cache", "HIT");
      if (body.warnings.length) res.setHeader("X-Flier-Warnings", body.warnings.join("; ").slice(0, 240));
      return res.status(200).send(Buffer.from(png));
    } catch (e) {
      return res.status(e.status || 500).json({ success: false, error: e.message });
    }
  }

  // ── POST (admin) ──
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!isAdmin(req)) return res.status(401).json({ error: "Admin credentials required" });

  const rlIp = rateLimit(`ip:${ipHash(req)}`, RATE_LIMIT_IP);
  const rlKey = rateLimit(`key:${keyHash(req)}`, RATE_LIMIT_KEY);
  setRateHeaders(res, rlIp, "generate", "ip");
  if (!rlIp.ok) return res.status(429).json({ error: "RATE_LIMITED", dimension: "ip" });
  if (!rlKey.ok) return res.status(429).json({ error: "RATE_LIMITED", dimension: "key" });

  try {
    const raw = req.body || {};
    const body = normalizeInput(raw);
    const mode = body.mode;
    const built = await buildSvg(body);
    const key = cacheKey({ ...body, __mode: "render" });
    let png = cacheGet(key);
    let cached = false;
    if (png) cached = true;
    else {
      png = await renderPng(built.svg, built.dims, reqId);
      if (png.length > MAX_OUTPUT_BYTES) return res.status(413).json({ success: false, error: "Image exceeds 5 MB" });
      cacheSet(key, png);
    }

    if (mode === "preview") {
      return res.status(200).json({
        success: true, mode: "preview",
        preview: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        width: built.dims.w, height: built.dims.h, bytes: png.length,
        template: built.template, scene: built.scene,
        imageReport: built.imageReport, cached,
      });
    }

    const name = sanitizeUploadName(body.upload?.name || `flier_${Date.now()}`);
    const uploaded = await uploadPng(png, name, reqId);
    const response = {
      success: true, mode,
      id: uploaded.id || null,
      url: uploaded.url, display_url: uploaded.display_url || uploaded.url,
      width: built.dims.w, height: built.dims.h, bytes: png.length,
      template: built.template, scene: built.scene,
      imageReport: built.imageReport, cached,
    };
    if (mode === "both") response.preview = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    return res.status(200).json(response);
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, error: e.message || "Render failed" });
  }
}

export { buildSvg, renderPng, uploadPng };

// ═══════════════════════════════════════════════════════════════════
//  END OF FILE — v3.1.0-folio
// ═══════════════════════════════════════════════════════════════════