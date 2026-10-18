// api/flier.js
// ═══════════════════════════════════════════════════════════════════
//  FLIER — universal image generator  (v2.2.0-folio)
//  ────────────────────────────────────────────────────────────────
//
//  Folio changes:
//    • ALLOWED_DOMAINS → Folio origins
//    • log/newReqId imported from ../utils/log.js
//    • IMAGE_UPLOAD_API env-overridable
//    • buildSvg / renderPng / uploadPng exported
//    • avatar/preview — 5 base64 variants (public, IP rate-limited)
//    • avatar/upload  — uploads ONE avatar, returns URL (public, IP rate-limited)
//    • avatar/custom  — AUTHENTICATED render with full customization
//                       (JWT required, rate-limited per user 60/hr)
//    • Version string → "2.2.0-folio"
// ═══════════════════════════════════════════════════════════════════

import { Resvg } from "@resvg/resvg-js";
import * as cheerio from "cheerio";
import crypto from "crypto";
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
  price: 20, cta: 40, metric: 12, metricLabel: 60,
};

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_SVG_CHARS = 300_000;
const MAX_HTML_CHARS = 200_000;
const FETCH_TIMEOUT_MS = 8000;

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_EDGE = 2048;

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_IP = 40;
const RATE_LIMIT_KEY = 200;

// Avatar preview + upload: 20 per hour per IP
const AVATAR_RATE_WINDOW_MS = 60 * 60 * 1000;
const AVATAR_RATE_LIMIT_IP = 20;

// Avatar custom: 60 per hour per authenticated user
const AVATAR_CUSTOM_RATE_WINDOW_MS = 60 * 60 * 1000;
const AVATAR_CUSTOM_RATE_LIMIT_UID = 60;

const PREVIEW_CACHE_MAX = 200;
const PREVIEW_CACHE_TTL = 5 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════
//  STROKE FONT — glyph table (unchanged, kept complete)
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

const GLYPH_SET = Object.keys(GLYPHS).sort().join("");

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

// ═══════════════════════════════════════════════════════════════════
//  RATE LIMIT
// ═══════════════════════════════════════════════════════════════════

const RL = new Map();
const AVATAR_RL = new Map();
const AVATAR_CUSTOM_RL = new Map();

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
    reset: new Date(resetAt).toISOString(),
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

function setRateHeaders(res, rl) {
  if (!rl) return;
  res.setHeader("X-RateLimit-Limit", String(rl.limit));
  res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  if (rl.reset) res.setHeader("X-RateLimit-Reset", rl.reset);
}

// ═══════════════════════════════════════════════════════════════════
//  PREVIEW CACHE
// ═══════════════════════════════════════════════════════════════════

const previewCache = new Map();

function canonicalize(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
  return out;
}

function cacheKey(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(obj))).digest("hex");
}

function cacheGet(key) {
  const entry = previewCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > PREVIEW_CACHE_TTL) { previewCache.delete(key); return null; }
  previewCache.delete(key);
  previewCache.set(key, entry);
  return entry.v;
}

function cacheSet(key, value) {
  if (previewCache.size >= PREVIEW_CACHE_MAX) {
    const first = previewCache.keys().next().value;
    if (first) previewCache.delete(first);
  }
  previewCache.set(key, { v: value, t: Date.now() });
}

// ═══════════════════════════════════════════════════════════════════
//  SANITIZE HELPERS
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

function isSafeImageUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "0.0.0.0"].includes(h)) return false;
    if (h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^10\./.test(h)) return false;
    if (/^192\.168\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (/^169\.254\./.test(h)) return false;
    if (/^\[?::1\]?$/.test(h)) return false;
    if (/^\[?f[cd][0-9a-f]{2}:/i.test(h)) return false;
    return true;
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════
//  INPUT NORMALIZER
// ═══════════════════════════════════════════════════════════════════

const warnings = [];
function warn(msg) { if (!warnings.includes(msg)) warnings.push(msg); }

function nearestSize(w, h) {
  let best = "1080x1080"; let bestDist = Infinity;
  for (const [key, dims] of Object.entries(SIZES)) {
    const dist = Math.abs(dims.w - w) + Math.abs(dims.h - h);
    if (dist < bestDist) { bestDist = dist; best = key; }
  }
  return best;
}

function normalizeInput(raw) {
  warnings.length = 0;
  const out = {
    mode: raw.mode || "preview",
    type: raw.type || "template",
    template: raw.template || "default",
    size: raw.size || "1080x1080",
    svg: raw.svg || null,
    html: raw.html || null,
    data: { text: {}, style: {}, images: {} },
    upload: raw.upload || {},
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
    if (!hasText) throw Object.assign(new Error("at least one of text/headline/subheadline/body/metric is required"), { status: 400, code: "NO_TEXT" });
  }
  if (out.type === "svg" && !out.svg) throw Object.assign(new Error("svg required when type=svg"), { status: 400 });
  if (out.type === "html" && !out.html) throw Object.assign(new Error("html required when type=html"), { status: 400 });

  out.size = cleanSize(out.size);
  return out;
}

// ═══════════════════════════════════════════════════════════════════
//  IMAGE FETCH
// ═══════════════════════════════════════════════════════════════════

async function imageToDataUri(spec) {
  if (!spec) return null;
  if (typeof spec === "string") {
    if (spec.startsWith("data:image/")) {
      if (spec.length > MAX_IMAGE_BYTES * 1.4) throw Object.assign(new Error("image base64 too large"), { status: 413 });
      return spec;
    }
    if (isSafeImageUrl(spec)) return fetchImageAsDataUri(spec);
    warn("image url rejected (unsafe)");
    return null;
  }
  if (spec.base64?.startsWith("data:image/")) {
    if (spec.base64.length > MAX_IMAGE_BYTES * 1.4) throw Object.assign(new Error("image base64 too large"), { status: 413 });
    return spec.base64;
  }
  if (spec.url && isSafeImageUrl(spec.url)) return fetchImageAsDataUri(spec.url);
  if (spec.url) warn("image url rejected (unsafe)");
  return null;
}

async function fetchImageAsDataUri(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);
  } catch (e) {
    clearTimeout(timer);
    warn(`image fetch failed: ${e.message}`);
    return null;
  }
  if (!res.ok) { warn(`image fetch HTTP ${res.status}`); return null; }
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!ct.startsWith("image/")) { warn(`not an image (${ct})`); return null; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) { warn("image too large"); return null; }
  return `data:${ct};base64,${buf.toString("base64")}`;
}

// ═══════════════════════════════════════════════════════════════════
//  ESCAPING + HELPERS
// ═══════════════════════════════════════════════════════════════════

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function escAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

function wrap(text, maxChars) {
  if (!text) return [];
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (w.length > maxChars) {
      if (line) { lines.push(line); line = ""; }
      for (let i = 0; i < w.length; i += maxChars) {
        const chunk = w.slice(i, i + maxChars);
        if (chunk.length === maxChars) lines.push(chunk);
        else line = chunk;
      }
      continue;
    }
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length > maxChars && line) { lines.push(line); line = w; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function charsFor(width, fontSize, weight = "regular") {
  const ratio = weight === "black" ? 0.56 : weight === "bold" ? 0.54 : weight === "medium" ? 0.52 : 0.50;
  return Math.max(6, Math.floor(width / (fontSize * ratio)));
}

function seededRandom(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) | 0;
  return () => { s = (s * 1664525 + 1013904223) | 0; return (s >>> 0) / 4294967296; };
}

function applyHeadlineCase(text, mode) {
  if (!text) return text;
  switch (mode) {
    case "upper": return text.toUpperCase();
    case "title": return text.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    case "sentence": return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    default: return text;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  TEXT RENDERING
// ═══════════════════════════════════════════════════════════════════

const WEIGHT_NUM = { regular: 400, medium: 500, bold: 700, black: 900 };

function textNode({ x, y, text, anchor = "start", size, weight = "regular", fill, letterSpacing = null, opacity = null, style = null, family = null, fillOpacity = null }) {
  const str = String(text ?? "");
  if (!str) return "";
  const op = opacity != null ? ` opacity="${opacity}"` : "";
  const italic = style === "italic" ? ` font-style="italic"` : "";
  const fillOp = fillOpacity != null ? ` fill-opacity="${fillOpacity}"` : "";

  if (fontFamily) {
    const fw = WEIGHT_NUM[weight] || 400;
    const tracking = letterSpacing != null ? Number(letterSpacing) : weight === "black" ? -size * 0.022 : weight === "bold" ? -size * 0.012 : size * 0.005;
    const lsAttr = tracking !== 0 ? ` letter-spacing="${tracking.toFixed(2)}"` : "";
    return `<text x="${x}" y="${y}" font-family="${escAttr(family || fontFamily)}" font-size="${size}" font-weight="${fw}"${italic}${lsAttr} text-anchor="${anchor}" fill="${escAttr(fill)}"${fillOp}${op}>${esc(str)}</text>`;
  }

  const tracking = letterSpacing != null ? Number(letterSpacing) : weight === "black" ? -size * 0.022 : weight === "bold" ? -size * 0.012 : size * 0.005;

  let totalWidth = 0;
  for (const ch of str) totalWidth += glyphFor(ch).w * size + tracking;
  if (str.length > 0) totalWidth -= tracking;

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

function measureText(str, size, weight = "regular", letterSpacing = null) {
  const s = String(str ?? "");
  if (!s) return 0;
  const tracking = letterSpacing != null ? Number(letterSpacing) : weight === "black" ? -size * 0.022 : weight === "bold" ? -size * 0.012 : size * 0.005;
  if (fontFamily) {
    const ratio = weight === "black" ? 0.56 : weight === "bold" ? 0.54 : weight === "medium" ? 0.52 : 0.50;
    return s.length * size * ratio + (s.length - 1) * tracking;
  }
  let w = 0;
  for (const ch of s) w += glyphFor(ch).w * size + tracking;
  return Math.max(0, w - tracking);
}

// ═══════════════════════════════════════════════════════════════════
//  HTML → SVG
// ═══════════════════════════════════════════════════════════════════

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
    const lines = wrap(text, charsFor(W - pad * 2, fontSize, weight));
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
    const maxChars = charsFor(boxW, fontSize, fontWeight);
    const lines = wrap(rawText, maxChars);
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

  if (y > H - pad) warn(`html content overflowed canvas (y=${y}, H=${H})`);
  return out.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
//  SVG SANITIZER
// ═══════════════════════════════════════════════════════════════════

const SVG_TAGS = new Set(["svg", "g", "defs", "symbol", "use", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "textPath", "image", "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "filter", "feGaussianBlur", "feColorMatrix", "feOffset", "feBlend", "feComposite", "feTurbulence", "feDisplacementMap", "feMerge", "feMergeNode", "feFlood", "title", "desc"]);
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
      const isKnown = SVG_TAGS.has(raw) || [...SVG_TAGS].some((t) => t.toLowerCase() === lower);
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
//  LAYOUT PRIMITIVES
// ═══════════════════════════════════════════════════════════════════

function accentBar(theme, x, y, w = 64, h = 6, color = null) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${escAttr(color || theme.colors.primary)}"/>`;
}

function accentCorner(dims, theme) {
  const pos = theme.accentPosition;
  const { w: W, h: H } = dims;
  const sz = Math.round(Math.min(W, H) * 0.035);
  const pad = Math.round(Math.min(W, H) * 0.045);
  const t = Math.max(4, Math.round(sz * 0.12));
  const horizX = pos.includes("right") ? W - pad - sz : pad;
  const vertX = pos.includes("right") ? W - pad - t : pad;
  const horizY = pos.includes("bottom") ? H - pad - t : pad;
  const vertY = pos.includes("bottom") ? H - pad - sz : pad;
  return `
    <rect x="${horizX}" y="${horizY}" width="${sz}" height="${t}" rx="${t / 2}" fill="${escAttr(theme.colors.primary)}"/>
    <rect x="${vertX}" y="${vertY}" width="${t}" height="${sz}" rx="${t / 2}" fill="${escAttr(theme.colors.primary)}"/>
  `;
}

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
    const rng = seededRandom(`noise-${W}-${H}`);
    const dots = [];
    const N = Math.floor((W * H) / 5200);
    for (let i = 0; i < N; i++) {
      const x = rng() * W; const y = rng() * H; const r = 0.6 + rng() * 1.4; const o = (0.4 + rng() * 0.6).toFixed(2);
      dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${escAttr(c)}" opacity="${o}"/>`);
    }
    return `<g opacity="${op}">${dots.join("")}</g>`;
  }
  return "";
}

function watermark(dims, theme) {
  if (theme.watermark === false) return "";
  const { w: W, h: H } = dims;
  const pad = Math.round(Math.min(W, H) * 0.035);
  const size = Math.round(Math.min(W, H) * 0.018);
  const text = theme.watermarkText || "FOLIO";
  const y = H - pad;
  const labelW = Math.max(size * 4.5, measureText(text, size, "black", size * 0.12) + size * 1.2);
  const labelH = Math.round(size * 1.7);
  const labelX = W - pad - labelW;
  return `<g opacity="0.72"><rect x="${labelX}" y="${y - labelH + size * 0.5}" width="${labelW}" height="${labelH}" rx="${labelH / 2}" fill="rgba(0,0,0,0.42)"/>${textNode({ x: labelX + labelW / 2, y: y - labelH / 2 + size * 0.5, text, anchor: "middle", size, weight: "black", letterSpacing: size * 0.12, fill: "white" })}</g>`;
}

function backgroundLayer(dims, theme) {
  const { w: W, h: H } = dims;
  const bg = theme.background;
  if (bg.type === "image" && bg.dataUri) {
    const blur = bg.blur > 0 ? `<filter id="bg-blur" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${bg.blur}"/></filter>` : "";
    const filterAttr = bg.blur > 0 ? ' filter="url(#bg-blur)"' : "";
    return `<defs><clipPath id="clip-frame"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>${blur}</defs><g clip-path="url(#clip-frame)"><image href="${escAttr(bg.dataUri)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"${filterAttr}/></g><rect x="0" y="0" width="${W}" height="${H}" fill="${escAttr(bg.overlay || "rgba(0,0,0,0.4)")}"/>${patternLayer(dims, theme)}`;
  }
  if (bg.type === "gradient") {
    const rad = (bg.angle * Math.PI) / 180;
    const x1 = 0.5 - Math.cos(rad) * 0.5;
    const y1 = 0.5 - Math.sin(rad) * 0.5;
    const x2 = 0.5 + Math.cos(rad) * 0.5;
    const y2 = 0.5 + Math.sin(rad) * 0.5;
    return `<defs><linearGradient id="bg-grad" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${escAttr(bg.from)}"/><stop offset="1" stop-color="${escAttr(bg.to)}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#bg-grad)"/>${patternLayer(dims, theme)}`;
  }
  return `<rect width="${W}" height="${H}" fill="${escAttr(bg.color)}"/>${patternLayer(dims, theme)}`;
}

function svgWrap(dims, theme, body) {
  const { w: W, h: H } = dims;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
}

// ═══════════════════════════════════════════════════════════════════
//  THEME + TEXT RESOLVERS
// ═══════════════════════════════════════════════════════════════════

const LIGHT_PALETTE = { text: "#0f0f12", muted: "rgba(15,15,18,0.68)", surface: "rgba(0,0,0,0.06)" };
const DARK_PALETTE = { text: "#ffffff", muted: "rgba(255,255,255,0.72)", surface: "rgba(255,255,255,0.08)" };

function resolveTheme(data) {
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
  return {
    variant: effectiveVariant,
    colors: {
      primary: cleanColor(colors.primary, "#F59E0B"),
      text: cleanColor(colors.text, palette.text),
      accent: cleanColor(colors.accent, "#fbbf24"),
      muted: cleanColor(colors.muted, palette.muted),
      surface: cleanColor(colors.surface, palette.surface),
    },
    font: cleanFont(),
    align: cleanAlign(style.align || "center"),
    watermark: cleanBool(style.watermark, true),
    watermarkText: cleanText(style.watermarkText || "FOLIO", 40),
    pattern: cleanPattern(style.pattern || "none"),
    radius: cleanNumber(style.radius, 0, 80, 24),
    accentPosition: cleanAccentPosition(style.accentPosition || "top-left"),
    headlineCase: cleanHeadlineCase(style.headlineCase || "auto"),
    background: {
      type: ["solid", "gradient", "image"].includes(bg.type) ? bg.type : "gradient",
      color: cleanColor(bg.color, "#0a0a0d"),
      from: cleanColor(bg.from, "#F59E0B"),
      to: cleanColor(bg.to, "#f97316"),
      angle: cleanNumber(bg.angle, 0, 360, 135),
      overlay: cleanColor(bg.overlay, "rgba(0,0,0,0.55)"),
      blur: cleanNumber(bg.blur, 0, 40, 0),
      dataUri: null,
    },
  };
}

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
//  TEMPLATES (16, unchanged)
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
  const pad = Math.round(W * 0.08);
  const boxW = W - pad * 2;
  const headSize = Math.round(H * 0.30);
  const lines = wrap(applyHeadlineCase(t.headline, theme.headlineCase), charsFor(boxW, headSize, "black"));
  const lh = Math.round(headSize * 1.02);
  let y = (H - lines.length * lh) / 2 + headSize * 0.85;
  const out = [backgroundLayer(dims, theme)];
  for (const line of lines) {
    out.push(textNode({ x: W / 2, y, text: line, anchor: "middle", size: headSize, weight: "black", fill: theme.colors.text }));
    y += lh;
  }
  if (t.footer) out.push(textNode({ x: W / 2, y: H - pad, text: t.footer, anchor: "middle", size: Math.round(H * 0.024), weight: "bold", fill: theme.colors.primary }));
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_poster_centered(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.09);
  const boxW = W - pad * 2;
  const headSize = Math.round(H * 0.078);
  const subSize = Math.round(H * 0.028);
  const bodySize = Math.round(H * 0.021);
  const footSize = Math.round(H * 0.022);
  const kickSize = Math.round(H * 0.020);
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrap(headline, charsFor(boxW, headSize, "black"));
  const subLines = wrap(t.subheadline, charsFor(boxW, subSize, "medium"));
  const bodyLines = wrap(t.body, charsFor(boxW, bodySize, "regular"));
  const headLH = Math.round(headSize * 1.06);
  const subLH = Math.round(subSize * 1.35);
  const bodyLH = Math.round(bodySize * 1.6);
  const hasKicker = !!t.kicker;
  const kickerBlock = hasKicker ? Math.round(kickSize * 2.0) : 0;
  const footBlock = t.footer ? Math.round(footSize * 2.0) : 0;
  const blockH = kickerBlock + headLines.length * headLH + (subLines.length ? subLines.length * subLH + subSize * 0.4 : 0) + (bodyLines.length ? bodyLines.length * bodyLH + bodySize * 0.6 : 0) + footBlock;
  let y = (H - blockH) / 2 + headSize;
  const out = [backgroundLayer(dims, theme)];
  if (hasKicker) {
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
  const pad = Math.round(W * 0.09);
  const t = data.text;
  const align = theme.align;
  const anchor = align === "center" ? "middle" : align === "start" || align === "left" ? "start" : "end";
  const x = align === "center" ? W / 2 : align === "right" ? W - pad : pad;
  const boxW = W - pad * 2;
  const headSize = Math.round(H * 0.085);
  const subSize = Math.round(H * 0.030);
  const footSize = Math.round(H * 0.022);
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrap(headline, charsFor(boxW, headSize, "black"));
  const subLines = wrap(t.subheadline, charsFor(boxW, subSize, "medium"));
  const headLH = Math.round(headSize * 1.02);
  const subLH = Math.round(subSize * 1.3);
  const blockH = headLines.length * headLH + (subLines.length ? subLines.length * subLH + subSize * 0.4 : 0) + (t.footer ? footSize * 2 : 0) + Math.round(H * 0.06);
  const blockTop = H - blockH - pad;
  const out = [backgroundLayer(dims, theme)];
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
  const headSize = Math.round(H * 0.062);
  const subSize = Math.round(H * 0.026);
  const boxW = Math.round(W * 0.82);
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrap(headline, charsFor(boxW, headSize, "black"));
  const subLines = wrap(t.subheadline, charsFor(boxW, subSize, "medium"));
  const headLH = Math.round(headSize * 1.08);
  const subLH = Math.round(subSize * 1.35);
  const blockH = headLines.length * headLH + subLines.length * subLH + 40;
  let y = (H - blockH) / 2 + headSize;
  const out = [backgroundLayer(dims, theme)];
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
  const headLines = wrap(headline, charsFor(boxW - innerPad * 2, headSize, "black"));
  const deckLines = wrap(t.subheadline, charsFor(boxW - innerPad * 2, deckSize, "medium"));
  const bodyLines = wrap(t.body, charsFor(boxW - innerPad * 2, bodySize, "regular"));
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
  const quoteSize = Math.round(H * 0.052);
  const attrSize = Math.round(H * 0.022);
  const quoteText = t.headline || t.body || "";
  const attribution = t.subheadline || t.attribution || "";
  const lines = wrap(quoteText, charsFor(boxW, quoteSize, "bold"));
  const lh = Math.round(quoteSize * 1.32);
  const blockH = lines.length * lh;
  let y = (H - blockH) / 2 + quoteSize * 0.85;
  const out = [backgroundLayer(dims, theme)];
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
  const headSize = Math.round(H * 0.30);
  const subSize = Math.round(H * 0.030);
  const rng = seededRandom(t.headline || t.body || "lines");
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrap(headline, charsFor(boxW, headSize, "black"));
  const subLines = wrap(t.subheadline, charsFor(boxW, subSize, "medium"));
  const headLH = Math.round(headSize * 1.05);
  const subLH = Math.round(subSize * 1.35);
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
  const out = [backgroundLayer(dims, theme), ...lines];
  if (t.kicker) out.push(textNode({ x: pad, y: pad + H * 0.025, text: t.kicker.toUpperCase(), size: Math.round(H * 0.020), weight: "black", letterSpacing: H * 0.003, fill: theme.colors.accent }));
  for (const line of headLines) { out.push(textNode({ x: pad, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { out.push(textNode({ x: pad, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  out.push(accentBar(theme, pad, H - Math.round(H * 0.10), 80, 6));
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
  const headSize = Math.round(H * 0.055);
  const subSize = Math.round(H * 0.024);
  const bodySize = Math.round(H * 0.019);
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrap(headline, charsFor(textW, headSize, "black"));
  const subLines = wrap(t.subheadline, charsFor(textW, subSize, "medium"));
  const bodyLines = wrap(t.body, charsFor(textW, bodySize, "regular"));
  const headLH = Math.round(headSize * 1.08);
  const subLH = Math.round(subSize * 1.4);
  const bodyLH = Math.round(bodySize * 1.62);
  const blockH = headLines.length * headLH + (subLines.length ? subLines.length * subLH + subSize * 0.5 : 0) + (bodyLines.length ? bodyLines.length * bodyLH + bodySize * 0.7 : 0);
  let y = isWide ? (H - blockH) / 2 + headSize : textTop + headSize;
  const out = [backgroundLayer(dims, theme)];
  const radius = theme.radius;
  const bgImage = theme.background.dataUri;
  const cardImage = data.images?.primary?.dataUri || bgImage;
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
  const kickSize = Math.round(H * 0.022);
  const headSize = Math.round(H * 0.100);
  const subSize = Math.round(H * 0.034);
  const metaSize = Math.round(H * 0.024);
  const headline = applyHeadlineCase(t.headline, theme.headlineCase || "upper");
  const headLines = wrap(headline, charsFor(boxW, headSize, "black"));
  const subLines = wrap(t.subheadline, charsFor(boxW, subSize, "medium"));
  const out = [backgroundLayer(dims, theme)];
  let y = pad + kickSize * 1.4;
  if (t.kicker) out.push(textNode({ x: pad, y, text: t.kicker.toUpperCase(), size: kickSize, weight: "black", letterSpacing: kickSize * 0.15, fill: theme.colors.accent }));
  y += Math.round(headSize * 0.75);
  for (const line of headLines) { out.push(textNode({ x: pad, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += Math.round(headSize * 1.04); }
  y += Math.round(subSize * 0.2);
  out.push(accentBar(theme, pad, y, 80, 6));
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
  const headSize = Math.round(panelH * 0.085);
  const subSize = Math.round(panelH * 0.036);
  const bodySize = Math.round(panelH * 0.024);
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrap(headline, charsFor(textW, headSize, "black"));
  const subLines = wrap(t.subheadline, charsFor(textW, subSize, "medium"));
  const bodyLines = wrap(t.body, charsFor(textW, bodySize, "regular"));
  const headLH = Math.round(headSize * 1.06);
  const subLH = Math.round(subSize * 1.36);
  const bodyLH = Math.round(bodySize * 1.6);
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
  const headSize = Math.round(H * 0.058);
  const subSize = Math.round(H * 0.026);
  const bodySize = Math.round(H * 0.020);
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrap(headline, charsFor(textW, headSize, "black"));
  const subLines = wrap(t.subheadline, charsFor(textW, subSize, "medium"));
  const bodyLines = wrap(t.body, charsFor(textW, bodySize, "regular"));
  const headLH = Math.round(headSize * 1.08);
  const subLH = Math.round(subSize * 1.4);
  const bodyLH = Math.round(bodySize * 1.62);
  let y = textTop + headSize * 0.85;
  const out = [backgroundLayer(dims, theme)];
  const imageData = data.images?.primary?.dataUri || theme.background.dataUri;
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
  const headSize = Math.round(H * 0.080);
  const subSize = Math.round(H * 0.030);
  const bodySize = Math.round(H * 0.022);
  const textW = W - pad * 2;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrap(headline, charsFor(textW, headSize, "black"));
  const subLines = wrap(t.subheadline, charsFor(textW, subSize, "medium"));
  const bodyLines = wrap(t.body, charsFor(textW, bodySize, "regular"));
  const headLH = Math.round(headSize * 1.06);
  const subLH = Math.round(subSize * 1.36);
  const bodyLH = Math.round(bodySize * 1.62);
  const textTop = badgeY + badgeSize + Math.round(H * 0.06);
  let y = textTop + headSize * 0.85;
  const out = [backgroundLayer(dims, theme)];
  out.push(`<defs><linearGradient id="badge-scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(0,0,0,0)"/><stop offset="0.5" stop-color="rgba(0,0,0,0.35)"/><stop offset="1" stop-color="rgba(0,0,0,0.72)"/></linearGradient></defs><rect x="0" y="${H * 0.30}" width="${W}" height="${H * 0.70}" fill="url(#badge-scrim)"/>`);
  const imageData = data.images?.primary?.dataUri || theme.background.dataUri;
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
  const headSize = Math.round(textZoneH * 0.22);
  const subSize = Math.round(textZoneH * 0.09);
  const bodySize = Math.round(textZoneH * 0.060);
  const textW = W - pad * 2;
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrap(headline, charsFor(textW, headSize, "black"));
  const subLines = wrap(t.subheadline, charsFor(textW, subSize, "medium"));
  const bodyLines = wrap(t.body, charsFor(textW, bodySize, "regular"));
  const headLH = Math.round(headSize * 1.06);
  const subLH = Math.round(subSize * 1.4);
  const bodyLH = Math.round(bodySize * 1.62);
  const blockH = headLines.length * headLH + (subLines.length ? subLines.length * subLH + subSize * 0.5 : 0) + (bodyLines.length ? bodyLines.length * bodyLH + bodySize * 0.7 : 0);
  let y = (stripY - blockH) / 2 + headSize * 0.85;
  const out = [backgroundLayer(dims, theme)];
  if (t.kicker) out.push(textNode({ x: pad, y: y - headSize * 1.2, text: t.kicker.toUpperCase(), size: Math.round(headSize * 0.28), weight: "black", letterSpacing: headSize * 0.05, fill: theme.colors.accent }));
  for (const line of headLines) { out.push(textNode({ x: pad, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { out.push(textNode({ x: pad, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (bodyLines.length) { y += Math.round(bodySize * 0.7); for (const line of bodyLines) { out.push(textNode({ x: pad, y, text: line, size: bodySize, weight: "regular", fill: theme.colors.muted })); y += bodyLH; } }
  const imageData = data.images?.primary?.dataUri;
  if (imageData) {
    out.push(`<defs><clipPath id="strip-clip"><rect x="0" y="${stripY}" width="${W}" height="${stripH}"/></clipPath></defs><image href="${escAttr(imageData)}" x="0" y="${stripY}" width="${W}" height="${stripH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#strip-clip)"/><rect x="0" y="${stripY}" width="${W}" height="${stripH}" fill="${escAttr(theme.colors.primary)}" opacity="0.18"/>`);
  } else {
    out.push(`<rect x="0" y="${stripY}" width="${W}" height="${stripH}" fill="${escAttr(theme.colors.primary)}" opacity="0.14"/>`);
    out.push(`<g opacity="0.7">${Array.from({ length: 12 }, (_, i) => {
      const x = (i / 11) * W; const w = Math.max(2, W * 0.004);
      return `<rect x="${x.toFixed(1)}" y="${stripY}" width="${w.toFixed(1)}" height="${stripH}" fill="${escAttr(theme.colors.primary)}" opacity="${(0.06 + i * 0.02).toFixed(3)}"/>`;
    }).join("")}</g>`);
  }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

function tpl_stat_hero(data, theme, dims) {
  const { w: W, h: H } = dims;
  const t = data.text;
  const pad = Math.round(W * 0.10);
  const textW = W - pad * 2;
  const metric = t.metric || t.headline;
  const metricSize = Math.round(H * 0.26);
  const labelSize = Math.round(H * 0.038);
  const subSize = Math.round(H * 0.022);
  let fitSize = metricSize;
  const measured = measureText(metric, fitSize, "black");
  if (measured > textW) fitSize = Math.round((fitSize * textW) / measured);
  const label = applyHeadlineCase(t.metricLabel || t.subheadline, theme.headlineCase);
  const labelLines = wrap(label, charsFor(textW, labelSize, "medium"));
  const subLines = wrap(t.body, charsFor(textW, subSize, "regular"));
  const labelLH = Math.round(labelSize * 1.3);
  const subLH = Math.round(subSize * 1.6);
  const blockH = fitSize * 1.0 + labelLines.length * labelLH + (subLines.length ? subLines.length * subLH + subSize * 0.5 : 0);
  let y = (H - blockH) / 2 + fitSize * 0.78;
  const out = [backgroundLayer(dims, theme)];
  out.push(textNode({ x: W / 2, y, text: metric, anchor: "middle", size: fitSize, weight: "black", fill: theme.colors.primary }));
  y += Math.round(fitSize * 0.15);
  out.push(textNode({ x: W / 2, y: y + labelLH * 0.9, text: labelLines[0] || "", anchor: "middle", size: labelSize, weight: "medium", fill: theme.colors.text }));
  y += labelLH;
  for (let i = 1; i < labelLines.length; i++) { out.push(textNode({ x: W / 2, y: y + labelLH * 0.9, text: labelLines[i], anchor: "middle", size: labelSize, weight: "medium", fill: theme.colors.text })); y += labelLH; }
  if (subLines.length) { y += Math.round(subSize * 0.6); for (const line of subLines) { out.push(textNode({ x: W / 2, y: y + subLH * 0.85, text: line, anchor: "middle", size: subSize, weight: "regular", fill: theme.colors.muted })); y += subLH; } }
  out.push(accentCorner(dims, theme));
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
  const headSize = Math.round(H * 0.056);
  const subSize = Math.round(H * 0.024);
  const bodySize = Math.round(H * 0.019);
  const headline = applyHeadlineCase(t.headline, theme.headlineCase);
  const headLines = wrap(headline, charsFor(textW, headSize, "black"));
  const subLines = wrap(t.subheadline, charsFor(textW, subSize, "medium"));
  const bodyLines = wrap(t.body, charsFor(textW, bodySize, "regular"));
  const headLH = Math.round(headSize * 1.08);
  const subLH = Math.round(subSize * 1.4);
  const bodyLH = Math.round(bodySize * 1.62);
  let y = textTop + headSize * 0.85;
  const out = [backgroundLayer(dims, theme)];
  const slotA = data.images?.primary?.dataUri;
  const slotB = data.images?.secondary?.dataUri;
  const drawCell = (dataUri, x, y) => {
    if (dataUri) {
      out.push(`<defs><clipPath id="cell-clip-${x}"><rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="${radius}"/></clipPath></defs><image href="${escAttr(dataUri)}" x="${x}" y="${y}" width="${cellW}" height="${cellH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cell-clip-${x})"/>`);
    } else {
      out.push(`<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="${radius}" fill="${escAttr(theme.colors.surface)}"/>`);
      out.push(`<rect x="${x + 12}" y="${y + 12}" width="${cellW - 24}" height="${cellH - 24}" rx="${radius}" fill="none" stroke="${escAttr(theme.colors.primary)}" stroke-width="2" stroke-dasharray="6 6" opacity="0.35"/>`);
    }
  };
  drawCell(slotA, pad, pad);
  drawCell(slotB, pad + cellW + gap, pad);
  if (t.kicker) out.push(textNode({ x: pad, y: textTop - headSize * 0.35, text: t.kicker.toUpperCase(), size: Math.round(headSize * 0.32), weight: "black", letterSpacing: headSize * 0.06, fill: theme.colors.accent }));
  for (const line of headLines) { out.push(textNode({ x: pad, y, text: line, size: headSize, weight: "black", fill: theme.colors.text })); y += headLH; }
  if (subLines.length) { y += Math.round(subSize * 0.5); for (const line of subLines) { out.push(textNode({ x: pad, y, text: line, size: subSize, weight: "medium", fill: theme.colors.muted })); y += subLH; } }
  if (bodyLines.length) { y += Math.round(bodySize * 0.7); for (const line of bodyLines) { out.push(textNode({ x: pad, y, text: line, size: bodySize, weight: "regular", fill: theme.colors.muted })); y += bodyLH; } }
  out.push(watermark(dims, theme));
  return svgWrap(dims, theme, out.join("\n"));
}

// ═══════════════════════════════════════════════════════════════════
//  REGISTRY
// ═══════════════════════════════════════════════════════════════════

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
  const theme = resolveTheme(body.data);
  const bgSpec = body.data?.images?.background;
  const primarySpec = body.data?.images?.primary;
  const secondarySpec = body.data?.images?.secondary;
  const logSpec = body.data?.images?.logo;
  const [bgUri, primaryUri, secondaryUri, logoUri] = await Promise.all([
    bgSpec ? imageToDataUri(bgSpec) : null,
    primarySpec ? imageToDataUri(primarySpec) : null,
    secondarySpec ? imageToDataUri(secondarySpec) : null,
    logSpec ? imageToDataUri(logSpec) : null,
  ]);
  if (bgUri) {
    theme.background.type = "image";
    theme.background.dataUri = bgUri;
    if (bgSpec?.overlay) theme.background.overlay = cleanColor(bgSpec.overlay, "rgba(0,0,0,0.55)");
    if (bgSpec?.blur != null) theme.background.blur = cleanNumber(bgSpec.blur, 0, 40, 0);
  }
  const data = {
    text,
    theme,
    images: {
      primary: { dataUri: primaryUri },
      secondary: { dataUri: secondaryUri },
      logo: { dataUri: logoUri },
    },
  };
  if (body.type === "template") {
    const name = TEMPLATES[body.template] ? body.template : "default";
    if (name !== body.template) warn(`template '${body.template}' not found, used 'default'`);
    const svg = TEMPLATES[name](data, theme, dims);
    return { svg, dims, template: name };
  }
  if (body.type === "svg") {
    const clean = sanitizeSvg(body.svg);
    const $ = cheerio.load(clean, { xmlMode: true });
    $("svg").attr("viewBox", `0 0 ${dims.w} ${dims.h}`);
    $("svg").attr("width", String(dims.w));
    $("svg").attr("height", String(dims.h));
    let svg = $.xml();
    svg = svg.replace(/<\/svg>\s*$/i, `${watermark(dims, theme)}</svg>`);
    return { svg, dims, template: "svg" };
  }
  if (body.type === "html") {
    const html = String(body.html || "");
    if (html.length > MAX_HTML_CHARS) throw Object.assign(new Error("html too large"), { status: 413 });
    const bodySvg = htmlToSvgBody(html, dims, theme);
    const out = [backgroundLayer(dims, theme), bodySvg, watermark(dims, theme)];
    return { svg: svgWrap(dims, theme, out.join("\n")), dims, template: "html" };
  }
  throw Object.assign(new Error(`unknown type: ${body.type}`), { status: 400 });
}

// ═══════════════════════════════════════════════════════════════════
//  RENDER + UPLOAD
// ═══════════════════════════════════════════════════════════════════

async function renderPng(svg, dims, reqId) {
  const opts = { fitTo: { mode: "width", value: dims.w }, background: "transparent" };
  if (fontBuffers && fontBuffers.length) opts.font = { fontBuffers, loadSystemFonts: false };
  const resvg = new Resvg(svg, opts);
  return resvg.render().asPng();
}

async function uploadPng(pngBuffer, name, reqId) {
  let res;
  try {
    res = await fetch(IMAGE_UPLOAD_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_API_KEY}`,
        "X-API-Key": ADMIN_API_KEY,
      },
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

export { buildSvg, renderPng, uploadPng };

// ═══════════════════════════════════════════════════════════════════
//  HANDLER
// ═══════════════════════════════════════════════════════════════════

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
  maxDuration: 60,
};

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

  // ══════════════════ AVATAR PREVIEW (public, IP rate-limited) ══════════════════
  if (action === "avatar/preview") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const rl = avatarRateLimit(`avatar:${ipHash(req)}`);
    setRateHeaders(res, rl);
    if (!rl.ok) return res.status(429).json({ error: "RATE_LIMITED", dimension: "ip" });

    const { username, displayName } = req.body || {};
    if (!username || typeof username !== "string") {
      return res.status(400).json({ success: false, error: "Missing username" });
    }
    if (username.length < 1 || username.length > 40) {
      return res.status(400).json({ success: false, error: "Invalid username length" });
    }

    const safeUsername = String(username).slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, "");
    const safeDisplayName = String(displayName || username).slice(0, 60).trim();

    try {
      // Import the 5-variant generator from the same file
      const AVATAR_VARIANTS = [
        { id: "v1", kind: "initials-solid", label: "Initials", template: "hero-short", style: { variant: "dark", pattern: "none" } },
        { id: "v2", kind: "initials-gradient", label: "Gradient", template: "hero-short", style: { variant: "dark", pattern: "none" }, colors: { primary: "#F59E0B", accent: "#f97316" } },
        { id: "v3", kind: "username-dark", label: "Username", template: "poster-centered", style: { variant: "light", pattern: "none", align: "center" } },
        { id: "v4", kind: "initials-pattern", label: "Patterned", template: "random-lines-top", style: { variant: "dark", pattern: "dots" } },
        { id: "v5", kind: "fullname-badge", label: "Badge", template: "image-badge-overlay", style: { variant: "dark", pattern: "none", align: "center" } },
      ];

      function initialsFrom(displayName, username) {
        const src = (displayName || username || "?").trim();
        const parts = src.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return src.slice(0, 2).toUpperCase();
      }

      const initials = initialsFrom(safeDisplayName, safeUsername);
      const variants = [];

      for (const variant of AVATAR_VARIANTS) {
        try {
          const base = {
            mode: "preview",
            type: "template",
            template: variant.template,
            size: "512x512",
            data: { text: {}, style: { ...(variant.style || {}) }, images: {} },
          };
          if (variant.colors) base.data.style.colors = { ...variant.colors };

          switch (variant.id) {
            case "v1": base.data.text.headline = initials; base.data.style.colors = { primary: "#F59E0B", accent: "#fbbf24" }; break;
            case "v2": base.data.text.headline = initials; base.data.style.colors = { primary: "#F59E0B", accent: "#f97316" }; break;
            case "v3": base.data.text.headline = safeUsername ? `@${safeUsername}` : initials; base.data.style.colors = { primary: "#1a1f2a", accent: "#F59E0B" }; break;
            case "v4": base.data.text.headline = initials; base.data.style.pattern = "dots"; base.data.style.colors = { primary: "#F59E0B", accent: "#fbbf24" }; break;
            case "v5": base.data.text.headline = safeDisplayName || safeUsername || initials; base.data.text.kicker = initials; base.data.style.colors = { primary: "#F59E0B", accent: "#fbbf24" }; break;
          }

          const body = normalizeInput(base);
          const { svg, dims } = await buildSvg(body);
          const png = await renderPng(svg, dims, reqId);
          variants.push({
            id: variant.id,
            kind: variant.kind,
            label: variant.label,
            dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
            width: dims.w,
            height: dims.h,
          });
        } catch (err) {
          log("avatar.variant_failed", { reqId, id: variant.id, message: err.message });
        }
      }

      if (variants.length === 0) return res.status(500).json({ success: false, error: "Could not generate avatars" });

      res.setHeader("Cache-Control", "private, max-age=300");
      return res.status(200).json({ success: true, variants });
    } catch (err) {
      log("avatar.preview.error", { reqId, message: err.message });
      return res.status(500).json({ success: false, error: "Avatar generation failed" });
    }
  }

  // ══════════════════ AVATAR UPLOAD (public, IP rate-limited) ══════════════════
  if (action === "avatar/upload") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const rl = avatarRateLimit(`avatar:${ipHash(req)}`);
    setRateHeaders(res, rl);
    if (!rl.ok) return res.status(429).json({ error: "RATE_LIMITED", dimension: "ip" });

    const { dataUrl, username } = req.body || {};
    if (!dataUrl || typeof dataUrl !== "string") {
      return res.status(400).json({ success: false, error: "Missing dataUrl" });
    }
    if (!dataUrl.startsWith("data:image/")) {
      return res.status(400).json({ success: false, error: "dataUrl must be a base64 image" });
    }
    if (dataUrl.length > 500 * 1024 * 1.4) {
      return res.status(413).json({ success: false, error: "Avatar too large (max 500 KB)" });
    }

    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx < 0) return res.status(400).json({ success: false, error: "Malformed data URL" });
    const base64 = dataUrl.slice(commaIdx + 1);
    if (!base64 || base64.length < 100) return res.status(400).json({ success: false, error: "dataUrl too small" });

    const safeUsername = String(username || "user").slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, "") || "user";
    const uploadName = `avatar_${safeUsername}_${Date.now()}`;

    try {
      const pngBuffer = Buffer.from(base64, "base64");
      if (pngBuffer.length > 500 * 1024) return res.status(413).json({ success: false, error: "Avatar too large" });
      const uploaded = await uploadPng(pngBuffer, uploadName, reqId);
      const url = uploaded.url || uploaded.display_url;
      if (!url || !String(url).startsWith("https://")) return res.status(502).json({ success: false, error: "Upload returned no URL" });
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ success: true, url, width: uploaded.width || null, height: uploaded.height || null, bytes: pngBuffer.length });
    } catch (err) {
      log("avatar.upload.error", { reqId, message: err.message });
      return res.status(err.status || 500).json({ success: false, error: err.message || "Upload failed" });
    }
  }

  // ══════════════════ AVATAR CUSTOM (AUTHENTICATED, per-user rate-limited) ══════════════════
  if (action === "avatar/custom") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // Verify JWT
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }
    const decoded = verifySession(authHeader.slice(7).trim());
    if (!decoded || !decoded.uid) {
      return res.status(401).json({ success: false, error: "Invalid or expired session" });
    }

    // Per-user rate limit
    const rl = avatarCustomRateLimit(decoded.uid);
    setRateHeaders(res, rl);
    if (!rl.ok) {
      log("avatar.custom.rate_limit", { reqId, uid: decoded.uid });
      return res.status(429).json({
        success: false,
        error: "Rate limit exceeded",
        retryAfter: Math.ceil((new Date(rl.reset).getTime() - Date.now()) / 1000),
      });
    }

    try {
      const raw = req.body || {};
      const body = normalizeInput(raw);

      const key = cacheKey({ ...body, __mode: "avatar-custom" });
      let png = cacheGet(key);
      if (!png) {
        const { svg, dims } = await buildSvg(body);
        png = await renderPng(svg, dims, reqId);
        if (png.length > MAX_OUTPUT_BYTES) {
          return res.status(413).json({ success: false, error: "Rendered image exceeds 5 MB" });
        }
        cacheSet(key, png);
      }

      const dims = enforceOutputEdge({ w: SIZES[body.size].w, h: SIZES[body.size].h });

      if (body.mode === "upload") {
        const name = cleanText(body.upload?.name, 60) || `avatar_${decoded.uid.slice(0, 8)}_${Date.now()}`;
        const uploaded = await uploadPng(png, name, reqId);
        const url = uploaded.url || uploaded.display_url;
        return res.status(200).json({
          success: true,
          url,
          width: dims.w,
          height: dims.h,
          bytes: png.length,
        });
      }

      // Default: preview
      return res.status(200).json({
        success: true,
        preview: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        width: dims.w,
        height: dims.h,
        bytes: png.length,
      });
    } catch (err) {
      log("avatar.custom.error", { reqId, uid: decoded.uid, message: err.message });
      return res.status(err.status || 500).json({ success: false, error: err.message || "Render failed" });
    }
  }

  // ══════════════════ GET (admin) ══════════════════
  if (req.method === "GET") {
    if (!isAdmin(req)) return res.status(401).json({ success: false, error: "Admin credentials required" });

    const q = req.query || {};
    if (!q.text && !q.template && !q.headline && !q.html && !q.svg && !q.metric) {
      initFont();
      return res.status(200).json({
        success: true,
        version: "2.2.0-folio",
        sizes: Object.keys(SIZES),
        types: ["template", "svg", "html"],
        modes: ["preview", "upload", "both"],
        templates: Object.keys(TEMPLATES),
        actions: {
          "avatar/preview": "POST — 5 avatar variants (public, IP rate-limited)",
          "avatar/upload": "POST { dataUrl } → { url } (public, IP rate-limited)",
          "avatar/custom": "POST — auth required (JWT), 60/hr per user. Accepts template, style, size, mode. Returns { preview } or { url }",
        },
      });
    }

    const rl = rateLimit(`get:${ipHash(req)}`, RATE_LIMIT_IP);
    setRateHeaders(res, rl);
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
        const { svg, dims } = await buildSvg(body);
        png = await renderPng(svg, dims, reqId);
        if (png.length > MAX_OUTPUT_BYTES) return res.status(413).json({ success: false, error: "Image exceeds 5 MB" });
        cacheSet(key, png);
      }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=60");
      if (cached) res.setHeader("X-Cache", "HIT");
      if (warnings.length) res.setHeader("X-Flier-Warnings", warnings.join("; ").slice(0, 240));
      return res.status(200).send(Buffer.from(png));
    } catch (e) {
      return res.status(e.status || 500).json({ success: false, error: e.message });
    }
  }

  // ══════════════════ POST (admin) ══════════════════
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!isAdmin(req)) return res.status(401).json({ error: "Admin credentials required" });

  const rlIp = rateLimit(`ip:${ipHash(req)}`, RATE_LIMIT_IP);
  const rlKey = rateLimit(`key:${keyHash(req)}`, RATE_LIMIT_KEY);
  setRateHeaders(res, rlIp);
  if (!rlIp.ok) return res.status(429).json({ error: "RATE_LIMITED", dimension: "ip" });
  if (!rlKey.ok) return res.status(429).json({ error: "RATE_LIMITED", dimension: "key" });

  try {
    const raw = req.body || {};
    const body = normalizeInput(raw);
    const mode = body.mode;
    const { svg, dims, template } = await buildSvg(body);
    const key = cacheKey({ ...body, __mode: "render" });
    let png = cacheGet(key);
    let cached = false;
    if (png) cached = true;
    else {
      png = await renderPng(svg, dims, reqId);
      if (png.length > MAX_OUTPUT_BYTES) return res.status(413).json({ success: false, error: "Image exceeds 5 MB" });
      cacheSet(key, png);
    }

    if (mode === "preview") {
      return res.status(200).json({
        success: true, mode: "preview",
        preview: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        width: dims.w, height: dims.h, bytes: png.length, template, cached,
      });
    }

    const name = cleanText(body.upload?.name, 60) || `flier_${Date.now()}`;
    const uploaded = await uploadPng(png, name, reqId);
    const response = {
      success: true, mode, id: uploaded.id || null,
      url: uploaded.url, display_url: uploaded.display_url || uploaded.url,
      width: dims.w, height: dims.h, bytes: png.length, template, cached,
    };
    if (mode === "both") response.preview = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    return res.status(200).json(response);
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, error: e.message || "Render failed" });
  }
}