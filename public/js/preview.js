// js/preview.js
// ═══════════════════════════════════════════════════════════════════
//  Folio Preview Tools — v3.0.0
//  ─────────────────────────────────────────────────────────────────
//  A self-contained preview module with:
//
//  • Full-screen overlay preview (project files OR external URL)
//  • Sizing: Fit / Phone / Tablet / Laptop / Custom (with 20+ device
//    presets, DPR, orientation, edge-to-edge fullscreen, rotate)
//  • Command palette (⌘K) — every action reachable
//  • Dialogs: Settings, Devices, Snippets, Layouts, History,
//    Network detail, Screenshot annotator, Share
//  • Sections: Console, Network, Assets & deps, Responsive,
//    Performance, Files, Storage, DOM, A11y, Dev tools,
//    Editor console, Search, Recording
//  • Live Dev Editor (multi-file split, live patch, push-to-project)
//  • Screenshot (frame-free) + annotation + clipboard/download
//  • Non-HTML renderers: MD, JSON, CSV, SVG, TXT, PDF, images
//  • Dependency graph (visual tree), static + runtime analysis
//  • Snapshot history with revert and side-by-side diff
//  • Breakpoint ruler, tap-heatmap, CSS var inspector
//
//  Public API:  window.__folioPreview  (see bottom)
// ═══════════════════════════════════════════════════════════════════

const PREVIEW_VERSION = "3.1.0";
const PREVIEW_BUILD = "2026.11.22";

// ─────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────
const DEVICE_PRESETS = {
  // phones
  "iphone-15-pro":   { w: 393,  h: 852,  label: "iPhone 15 Pro",  dpr: 3, category: "Phone" },
  "iphone-15-pm":    { w: 430,  h: 932,  label: "iPhone 15 Pro Max", dpr: 3, category: "Phone" },
  "iphone-se":       { w: 375,  h: 667,  label: "iPhone SE",      dpr: 2, category: "Phone" },
  "pixel-8":         { w: 412,  h: 915,  label: "Pixel 8",        dpr: 2.6, category: "Phone" },
  "galaxy-s24":      { w: 360,  h: 780,  label: "Galaxy S24",     dpr: 3, category: "Phone" },
  // tablets
  "ipad-mini":       { w: 744,  h: 1133, label: "iPad mini",      dpr: 2, category: "Tablet" },
  "ipad-pro-11":     { w: 834,  h: 1194, label: "iPad Pro 11\"",  dpr: 2, category: "Tablet" },
  "ipad-pro-13":     { w: 1024, h: 1366, label: "iPad Pro 13\"",  dpr: 2, category: "Tablet" },
  // laptops
  "macbook-air-13":  { w: 1440, h: 900,  label: "MacBook Air 13\"", dpr: 2, category: "Laptop" },
  "macbook-pro-14":  { w: 1512, h: 982,  label: "MacBook Pro 14\"", dpr: 2, category: "Laptop" },
  "macbook-pro-16":  { w: 1728, h: 1117, label: "MacBook Pro 16\"", dpr: 2, category: "Laptop" },
  "surface-pro":     { w: 1440, h: 960,  label: "Surface Pro",    dpr: 2, category: "Laptop" },
  // desktops
  "fhd":             { w: 1920, h: 1080, label: "1920 × 1080",    dpr: 1, category: "Desktop" },
  "qhd":             { w: 2560, h: 1440, label: "2560 × 1440",    dpr: 1, category: "Desktop" },
  "4k":              { w: 3840, h: 2160, label: "3840 × 2160",    dpr: 1, category: "Desktop" },
  // quick presets
  "phone":           { w: 393,  h: 852,  label: "Phone",          dpr: 3, category: "Quick", chrome: 16, notch: true },
  "tablet":          { w: 820,  h: 1180, label: "Tablet",         dpr: 2, category: "Quick", chrome: 16 },
  "laptop":          { w: 1440, h: 900,  label: "Laptop",         dpr: 2, category: "Quick", chrome: 16 },
};

const SIZE_QUICK = ["fit", "phone", "tablet", "laptop", "custom"];
const CUSTOM_MIN = { w: 200, h: 200 };
const CUSTOM_MAX = { w: 3840, h: 2160 };

const MSG = {
  READY: "folio:ready",
  CONSOLE: "folio:console",
  ERROR: "folio:error",
  NETWORK: "folio:network",
  STORAGE_WRITE: "folio:storage-write",
  STORAGE_SNAPSHOT_RESULT: "folio:storage-snapshot-result",
  VITALS: "folio:vitals",
  RESOURCE: "folio:resource",
  LAYOUT_SHIFT: "folio:layout-shift",
  DOM_SNAPSHOT: "folio:dom-snapshot",
  INSPECT_RESULT: "folio:inspect-result",
  A11Y_RESULT: "folio:a11y-result",
  RESPONSIVE_RESULT: "folio:responsive-result",
  EVAL_RESULT: "folio:eval-result",
  ASSETS_RESULT: "folio:assets-result",
  SCREENSHOT_DATA: "folio:screenshot-data",
  HEATMAP_DATA: "folio:heatmap-data",
  CSS_VARS: "folio:css-vars",
  ELEMENT_STYLE: "folio:element-style",
};

const REQ = {
  STORAGE_SNAPSHOT: "folio:storage-snapshot",
  CLEAR_STORAGE: "folio:clear-storage",
  DOM_SNAPSHOT: "folio:dom-snapshot-request",
  INSPECT_START: "folio:inspect-start",
  INSPECT_STOP: "folio:inspect-stop",
  HIGHLIGHT: "folio:highlight-element",
  A11Y_SCAN: "folio:a11y-scan",
  RESPONSIVE_SCAN: "folio:responsive-scan",
  EVAL: "folio:eval",
  SET_PREFERS: "folio:set-prefers",
  SIMULATE_NETWORK: "folio:simulate-network",
  RELOAD: "folio:reload",
  PATCH: "folio:patch",
  ASSETS_SCAN: "folio:assets-scan",
  SCREENSHOT: "folio:screenshot",
  START_HEATMAP: "folio:start-heatmap",
  STOP_HEATMAP: "folio:stop-heatmap",
  GET_CSS_VARS: "folio:get-css-vars",
  SET_CSS_VAR: "folio:set-css-var",
  GET_ELEMENT_STYLE: "folio:get-element-style",
};

const LS = {
  size: (pid) => `folio.preview.size.${pid}`,
  device: (pid) => `folio.preview.device.${pid}`,
  rotated: (pid) => `folio.preview.rotated.${pid}`,
  openSec: "folio.preview.openSection",
  openSecs: "folio.preview.openSections",
  fullscreen: "folio.preview.fullscreen",
  settings: "folio.preview.settings",
  layouts: "folio.preview.layouts",
  history: (pid) => `folio.preview.history.${pid}`,
  pinned: "folio.pinnedProjects",
  snippets: "folio.snippets",
  recordMode: "folio.preview.recording",
};

const DEFAULT_SETTINGS = {
  theme: "auto",              // "dark" | "light" | "auto"
  reducedMotion: "system",    // "true" | "false" | "system"
  animationSpeed: 1,          // multiplier
  dockPosition: "bottom",     // "bottom" | "right"
  autoRefresh: false,
  autoRefreshDelay: 800,
  autoRefreshOnSave: true,
  showBreakpointRuler: true,
  showTouchHeatmap: false,
  screenshotFormat: "png",    // "png" | "jpeg" | "webp"
  screenshotQuality: 0.92,
  screenshotDownload: true,
  screenshotCopy: false,
  screenshotAnnotate: true,
  consoleAutoScroll: true,
  consoleMaxEntries: 500,
  networkMaxEntries: 500,
  networkPreserveLog: true,
  throttlePreset: "none",     // "none" | "3g" | "4g" | "slow-3g"
  evalMode: "safe",           // "safe" | "allow-eval"
  devEditorFontSize: 13,
  devEditorAutoApply: true,
  devEditorAutoApplyDelay: 300,
  liveCssVars: true,
  liveElementPicker: true,
  recordMode: false,
  saveHistory: true,
  historyLimit: 10,
};

const THROTTLE_PRESETS = {
  none:    { latencyMs: 0,   downloadKbps: 0,     uploadKbps: 0,     failureRate: 0 },
  "4g":    { latencyMs: 20,  downloadKbps: 4000,  uploadKbps: 3000,  failureRate: 0 },
  "3g":    { latencyMs: 100, downloadKbps: 1600,  uploadKbps: 750,   failureRate: 0 },
  "slow-3g": { latencyMs: 400, downloadKbps: 400, uploadKbps: 400,   failureRate: 0.02 },
};

const LIMITS = {
  consoleEntries: 500,
  networkEntries: 500,
  a11yIssues: 50,
  responsiveIssues: 30,
  domNodes: 500,
  domDepth: 8,
  editorHistory: 100,
  historySnapshots: 10,
  heatmapPoints: 500,
};

// ─────────────────────────────────────────────────────────────────
//  TEMPLATES
// ─────────────────────────────────────────────────────────────────
const TEMPLATES = {
  html: {
    label: "HTML5 page",
    ext: ".html",
    content: `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Page Title</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Hello</h1>\n  <script src="app.js"><\/script>\n</body>\n</html>\n`,
  },
  css: {
    label: "CSS reset + base",
    ext: ".css",
    content: `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\nhtml { -webkit-text-size-adjust: 100%; }\nbody { font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; color: #111; background: #fff; }\nimg, picture, svg { max-width: 100%; display: block; }\nbutton, input, select, textarea { font: inherit; }\n`,
  },
  js: {
    label: "JS module",
    ext: ".js",
    content: `"use strict";\n\nexport function main() {\n  console.log("ready");\n}\n\ndocument.addEventListener("DOMContentLoaded", main);\n`,
  },
  md: {
    label: "Markdown doc",
    ext: ".md",
    content: `# Title\n\nShort description.\n\n## Section\n\n- Point one\n- Point two\n`,
  },
  json: {
    label: "JSON file",
    ext: ".json",
    content: `{\n  "name": "example",\n  "version": "1.0.0",\n  "items": []\n}\n`,
  },
  react: {
    label: "React component",
    ext: ".jsx",
    content: `import { useState } from "react";\n\nexport default function Component() {\n  const [count, setCount] = useState(0);\n  return (\n    <div>\n      <p>Count: {count}</p>\n      <button onClick={() => setCount(count + 1)}>Increment</button>\n    </div>\n  );\n}\n`,
  },
};

// ─────────────────────────────────────────────────────────────────
//  STYLES  (single injected stylesheet — v3 expanded)
// ─────────────────────────────────────────────────────────────────
const PREVIEW_CSS = `
:root {
  --fp-ease: cubic-bezier(.16,1,.3,1);
  --fp-ease-spring: cubic-bezier(.34,1.56,.64,1);
  --fp-accent: #F59E0B;
  --fp-accent-hover: #fbbf24;
  --fp-accent-glow: rgba(245,158,11,.4);
  --fp-accent-soft: rgba(245,158,11,.14);
  --fp-bg: #0a0c10;
  --fp-surface: #0f1218;
  --fp-surface-2: #151922;
  --fp-surface-3: #1a1f2a;
  --fp-text: #e8ecf1;
  --fp-text-2: rgba(232,236,241,.72);
  --fp-text-3: rgba(232,236,241,.44);
  --fp-border: rgba(255,255,255,.08);
  --fp-border-strong: rgba(255,255,255,.14);
  --fp-success: #10B981;
  --fp-success-soft: rgba(16,185,129,.14);
  --fp-danger: #EF4444;
  --fp-danger-soft: rgba(239,68,68,.12);
  --fp-warning: #D97706;
  --fp-warning-soft: rgba(217,119,6,.14);
  --fp-info: #3B82F6;
  --fp-info-soft: rgba(59,130,246,.14);
  --fp-mono: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
  --fp-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --fp-r-sm: 6px;
  --fp-r-md: 10px;
  --fp-r-lg: 14px;
  --fp-dock-h: 38px;
  --fp-dock-h-expanded: min(55vh, 420px);
  --fp-z-base: 950;
  --fp-z-dialog: 960;
  --fp-z-palette: 970;
  --fp-z-toast: 980;
  --fp-speed: 1;
}
[data-theme="light"] {
  --fp-bg: #f4f6f9;
  --fp-surface: #ffffff;
  --fp-surface-2: #f0f2f5;
  --fp-surface-3: #e8ebef;
  --fp-text: #0f1115;
  --fp-text-2: rgba(15,17,21,.72);
  --fp-text-3: rgba(15,17,21,.45);
  --fp-border: rgba(0,0,0,.08);
  --fp-border-strong: rgba(0,0,0,.14);
  --fp-accent: #D97706;
  --fp-accent-hover: #b45309;
  --fp-accent-glow: rgba(217,119,6,.28);
  --fp-accent-soft: rgba(217,119,6,.12);
  --fp-success: #059669;
  --fp-success-soft: rgba(5,150,105,.12);
  --fp-danger: #DC2626;
  --fp-danger-soft: rgba(220,38,38,.1);
  --fp-warning: #D97706;
  --fp-warning-soft: rgba(217,119,6,.12);
  --fp-info: #2563EB;
  --fp-info-soft: rgba(37,99,235,.12);
}
[data-theme="light"] .fp-header {
  background: rgba(255,255,255,.88);
  backdrop-filter: blur(20px) saturate(1.2);
  -webkit-backdrop-filter: blur(20px) saturate(1.2);
}
[data-theme="light"] .fp-dock {
  background: rgba(255,255,255,.94);
  backdrop-filter: blur(28px) saturate(1.3);
  -webkit-backdrop-filter: blur(28px) saturate(1.3);
  box-shadow: 0 -8px 32px rgba(0,0,0,.08);
}
[data-theme="light"] .fp-source-bar,
[data-theme="light"] .fp-size-bar {
  background: rgba(0,0,0,.04);
}
[data-theme="light"] .fp-btn,
[data-theme="light"] .fp-chip {
  background: rgba(0,0,0,.04);
}
[data-theme="light"] .fp-btn:hover,
[data-theme="light"] .fp-chip:hover {
  background: rgba(0,0,0,.07);
}
[data-theme="light"] .fp-url-input,
[data-theme="light"] .fp-dims input,
[data-theme="light"] .fp-toolbar input,
[data-theme="light"] .fp-input,
[data-theme="light"] .fp-select,
[data-theme="light"] .fp-textarea,
[data-theme="light"] .fp-console-repl input,
[data-theme="light"] .fp-dom-search {
  background: rgba(0,0,0,.04);
  border-color: var(--fp-border);
}
[data-theme="light"] .fp-frame[data-device="true"] {
  border-color: #d1d5db;
  box-shadow: 0 24px 80px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06);
}
[data-theme="light"] .fp-frame[data-device="true"]::before {
  background: #e5e7eb;
}
[data-theme="light"] .fp-dialog {
  background: var(--fp-surface);
  box-shadow: 0 24px 80px rgba(0,0,0,.18);
}
[data-theme="light"] .fp-palette {
  background: var(--fp-surface);
  box-shadow: 0 24px 80px rgba(0,0,0,.2);
}
[data-theme="light"] .fp-toast {
  background: var(--fp-surface-3);
  box-shadow: 0 10px 40px rgba(0,0,0,.12);
}
[data-theme="light"] .fp-more-menu {
  background: var(--fp-surface);
  box-shadow: 0 16px 48px rgba(0,0,0,.15);
}
[data-theme="light"] .fp-stage-wrap {
  background: repeating-conic-gradient(rgba(0,0,0,.03) 0% 25%, transparent 0% 50%) 50%/20px 20px;
}
[data-theme="light"] .fp-console-entry[data-level="error"] {
  background: rgba(220,38,38,.06);
}
[data-theme="light"] .fp-console-entry[data-level="warn"] {
  background: rgba(217,119,6,.05);
}
[data-theme="light"] .fp-net-row:hover,
[data-theme="light"] .fp-asset-row:hover,
[data-theme="light"] .fp-files-row:hover,
[data-theme="light"] .fp-stor-row:hover {
  background: rgba(0,0,0,.03);
}
[data-theme="light"] .fp-list-item {
  background: rgba(0,0,0,.02);
}
[data-theme="light"] .fp-list-item:hover {
  background: rgba(0,0,0,.05);
}
[data-theme="light"] .fp-device-btn {
  background: rgba(0,0,0,.03);
}
[data-theme="light"] .fp-device-btn:hover {
  background: rgba(0,0,0,.06);
}
[data-theme="light"] .fp-devtools-btn {
  background: rgba(0,0,0,.03);
}
[data-theme="light"] .fp-devtools-btn:hover {
  background: rgba(0,0,0,.06);
}
[data-theme="light"] .fp-resp-stat,
[data-theme="light"] .fp-perf-vital {
  background: rgba(0,0,0,.03);
  border-color: rgba(0,0,0,.06);
}
[data-theme="light"] .fp-annotator {
  background: rgba(15,17,21,.82);
}
[data-theme="light"] .fp-annotator-head,
[data-theme="light"] .fp-annotator-actions {
  background: var(--fp-surface);
}

[data-reduced-motion="true"] *, [data-reduced-motion="true"] *::before, [data-reduced-motion="true"] *::after {
  animation-duration: .01ms !important;
  transition-duration: .01ms !important;
}

/* ─── OVERLAY ─── */
.fp-overlay{position:fixed;inset:0;z-index:var(--fp-z-base);background:var(--fp-bg);display:flex;flex-direction:column;opacity:0;pointer-events:none;transition:opacity calc(.2s/var(--fp-speed)) var(--fp-ease);font-family:var(--fp-sans);color:var(--fp-text)}
.fp-overlay[data-open="true"]{opacity:1;pointer-events:auto}
.fp-overlay[data-fullscreen="true"] .fp-header,
.fp-overlay[data-fullscreen="true"] .fp-dock{display:none!important}
.fp-overlay[data-fullscreen="true"] .fp-stage-wrap{position:fixed;inset:0;z-index:10;padding:0}
.fp-overlay[data-fullscreen="true"] .fp-stage{padding:0}
.fp-overlay[data-fullscreen="true"] .fp-frame{margin:0!important;border-radius:0!important;border:none!important;box-shadow:none!important}
.fp-overlay[data-fullscreen="true"] .fp-frame::before,
.fp-overlay[data-fullscreen="true"] .fp-frame::after{display:none!important}
.fp-overlay[data-fullscreen="true"] .fp-frame iframe{border-radius:0!important}
.fp-overlay[data-fullscreen="true"] .fp-ruler{display:none!important}
.fp-fs-exit{position:fixed;top:14px;right:14px;z-index:30;width:40px;height:40px;border-radius:10px;background:rgba(20,22,28,.88);backdrop-filter:blur(12px);border:1px solid var(--fp-border-strong);color:var(--fp-text);cursor:pointer;display:none;align-items:center;justify-content:center;box-shadow:0 8px 32px rgba(0,0,0,.4);transition:transform .15s,background .15s}
.fp-overlay[data-fullscreen="true"] .fp-fs-exit{display:flex}
.fp-fs-exit:hover{background:var(--fp-accent);color:#0a0c10;transform:scale(1.05)}
.fp-fs-exit svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2.2}
[data-theme="light"] .fp-fs-exit{background:rgba(255,255,255,.92);color:var(--fp-text);box-shadow:0 8px 32px rgba(0,0,0,.12)}
[data-theme="light"] .fp-fs-exit:hover{background:var(--fp-accent);color:#fff}
.fp-overlay[data-dock-right="true"]{flex-direction:row;flex-wrap:wrap;align-content:flex-start}
.fp-overlay[data-dock-right="true"] .fp-header{width:100%;order:0}
.fp-overlay[data-dock-right="true"] .fp-stage-wrap{flex:1 1 auto;width:calc(100% - 360px);min-width:0;order:1;height:calc(100% - 42px)}
.fp-overlay[data-dock-right="true"] .fp-dock{width:360px;max-width:40vw;height:calc(100% - 42px)!important;order:2;border-left:1px solid var(--fp-border);border-top:none;flex-direction:column;overflow:hidden}
.fp-overlay[data-dock-right="true"] .fp-dock[data-expanded="true"]{height:calc(100% - 42px)!important}
.fp-overlay[data-dock-right="true"] .fp-dock-bar{flex-shrink:0}
.fp-overlay[data-dock-right="true"] .fp-sections{flex:1;min-height:0;overflow:hidden}
.fp-overlay[data-dock-right="true"] .fp-toasts{right:380px;left:auto;transform:none;bottom:16px}
@media (max-width: 900px) {
  .fp-overlay[data-dock-right="true"]{flex-direction:column}
  .fp-overlay[data-dock-right="true"] .fp-stage-wrap{width:100%;height:auto;order:1}
  .fp-overlay[data-dock-right="true"] .fp-dock{width:100%;max-width:none;height:var(--fp-dock-h)!important;order:2;border-left:none;border-top:1px solid var(--fp-border)}
  .fp-overlay[data-dock-right="true"] .fp-dock[data-expanded="true"]{height:var(--fp-dock-h-expanded)!important}
  .fp-overlay[data-dock-right="true"] .fp-toasts{right:auto;left:50%;transform:translateX(-50%)}
}

/* ─── HEADER ─── */
.fp-header{display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(20,22,28,.85);backdrop-filter:blur(20px) saturate(1.2);-webkit-backdrop-filter:blur(20px) saturate(1.2);border-bottom:1px solid var(--fp-border);flex-shrink:0;min-height:42px;position:relative;z-index:20;flex-wrap:nowrap}
.fp-title{font-size:13px;font-weight:800;color:var(--fp-text);display:flex;align-items:center;gap:8px;flex-shrink:0}
.fp-title-main{display:flex;align-items:center;gap:6px}
.fp-title-main::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--fp-accent);box-shadow:0 0 12px var(--fp-accent-glow)}
.fp-hint{font-size:10px;font-weight:500;color:var(--fp-text-3)}
.fp-source-bar{display:flex;gap:2px;background:rgba(255,255,255,.04);padding:2px;border-radius:6px;flex-shrink:0}
.fp-source-tab{padding:4px 10px;border-radius:4px;background:transparent;border:none;color:var(--fp-text-3);font-size:10.5px;font-weight:700;cursor:pointer;font-family:inherit;transition:all calc(.15s/var(--fp-speed)) var(--fp-ease)}
.fp-source-tab:hover{color:var(--fp-text-2)}
.fp-source-tab.active{background:var(--fp-accent-soft);color:var(--fp-accent);box-shadow:inset 0 0 0 1px var(--fp-accent-glow)}
.fp-url-wrap{display:flex;align-items:center;gap:4px;flex:1;min-width:0;max-width:420px}
.fp-url-input{height:26px;padding:0 8px;border-radius:5px;background:rgba(255,255,255,.05);border:1px solid var(--fp-border);color:var(--fp-text);font-size:11px;font-family:var(--fp-mono);min-width:0;flex:1;outline:none;transition:border-color .15s}
.fp-url-input:focus{border-color:var(--fp-accent);background:var(--fp-accent-soft)}
.fp-size-bar{display:flex;gap:2px;align-items:center;overflow-x:auto;padding:2px;background:rgba(255,255,255,.04);border-radius:8px;border:1px solid var(--fp-border);flex-shrink:0;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.fp-size-bar::-webkit-scrollbar{display:none}
.fp-size-btn{padding:0;width:28px;height:28px;border-radius:6px;background:transparent;border:none;color:var(--fp-text-2);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:all calc(.12s/var(--fp-speed)) var(--fp-ease);font-family:inherit;flex-shrink:0}
.fp-size-btn:hover{background:rgba(255,255,255,.08);color:var(--fp-text)}.fp-size-btn svg{width:14px;height:14px;display:block;stroke:currentColor;fill:none;stroke-width:2}
.fp-size-btn.active{background:var(--fp-accent-soft);color:var(--fp-accent);box-shadow:inset 0 0 0 1px var(--fp-accent-glow)}
.fp-dims{display:flex;gap:3px;align-items:center;margin-left:4px;padding:0 4px;font-family:var(--fp-mono);font-size:10px;color:var(--fp-text-3)}
.fp-dims input{width:44px;height:22px;padding:0 4px;border-radius:4px;background:rgba(255,255,255,.06);border:1px solid var(--fp-border);color:var(--fp-text);font-family:inherit;font-size:10px;text-align:right;outline:none}
.fp-dims input:focus{border-color:var(--fp-accent);background:var(--fp-accent-soft)}
.fp-acts{display:flex;gap:4px;align-items:center;flex-shrink:0;margin-left:auto}
.fp-btn{padding:5px 8px;border-radius:6px;background:rgba(255,255,255,.06);border:1px solid var(--fp-border);color:var(--fp-text-2);font-size:11px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:all calc(.12s/var(--fp-speed)) var(--fp-ease);font-family:inherit}
.fp-btn:hover{background:rgba(255,255,255,.1);color:var(--fp-text);border-color:var(--fp-border-strong)}
.fp-btn:active{transform:scale(.96)}
.fp-btn.icon{padding:0;width:28px;height:28px;justify-content:center}
.fp-btn.active{background:var(--fp-accent-soft);color:var(--fp-accent);border-color:var(--fp-accent-glow)}
.fp-btn.danger{color:var(--fp-danger)}
.fp-btn.danger:hover{background:var(--fp-danger-soft);border-color:rgba(239,68,68,.3)}
.fp-btn svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;display:block}

/* ─── STAGE ─── */
.fp-stage-wrap{flex:1;position:relative;overflow:hidden;background:repeating-conic-gradient(rgba(255,255,255,.015) 0% 25%,transparent 0% 50%) 50%/20px 20px;min-height:0;transition:padding-bottom calc(.28s/var(--fp-speed)) var(--fp-ease)}
.fp-stage{position:absolute;inset:0;display:grid;place-items:center;padding:12px;overflow:auto;-webkit-overflow-scrolling:touch;box-sizing:border-box}
.fp-frame{position:relative;background:#0a0c10;transform-origin:center center;transition:width .25s var(--fp-ease),height .25s var(--fp-ease),border .25s,border-radius .25s,box-shadow .25s,margin .25s;flex-shrink:0;margin:0 auto;display:flex;overflow:hidden;max-width:100%;box-sizing:border-box}
.fp-frame iframe{display:block;width:100%;height:100%;border:none;background:#fff;flex:1;max-width:100%}
.fp-frame[data-rotated="true"]{transition:width .3s var(--fp-ease-spring),height .3s var(--fp-ease-spring),border-radius .3s}
.fp-frame--edge{border:none!important;border-radius:0!important;box-shadow:none!important;margin:0!important}

/* Loading overlay on stage */
.fp-loading{position:absolute;inset:0;z-index:8;display:none;align-items:center;justify-content:center;flex-direction:column;gap:12px;background:rgba(10,12,16,.55);backdrop-filter:blur(6px);pointer-events:none}
.fp-loading[data-show="true"]{display:flex}
.fp-loading-spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,.12);border-top-color:var(--fp-accent);border-radius:50%;animation:fpSpin .7s linear infinite}
.fp-loading-text{font-size:12px;font-weight:700;color:var(--fp-text-2);letter-spacing:.2px}
@keyframes fpSpin{to{transform:rotate(360deg)}}
[data-theme="light"] .fp-loading{background:rgba(247,248,250,.7)}
[data-theme="light"] .fp-loading-spinner{border-color:rgba(0,0,0,.1);border-top-color:var(--fp-accent)}

/* Phone frame */
.fp-frame[data-device="true"][data-category="Phone"]{border-radius:28px;border:8px solid #1a1a1a;box-shadow:0 16px 48px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.05);overflow:hidden}
.fp-frame[data-device="true"][data-category="Phone"]::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:min(100px,40%);height:18px;background:#0a0c10;border-radius:0 0 12px 12px;z-index:2;pointer-events:none}
.fp-frame[data-device="true"][data-category="Phone"] iframe{border-radius:20px}

/* Tablet frame */
.fp-frame[data-device="true"][data-category="Tablet"]{border-radius:14px;border:10px solid #222;box-shadow:0 16px 48px rgba(0,0,0,.45);overflow:hidden}
.fp-frame[data-device="true"][data-category="Tablet"]::before{content:'';position:absolute;top:50%;right:-6px;transform:translateY(-50%);width:3px;height:36px;background:#111;border-radius:2px;z-index:2;pointer-events:none}
.fp-frame[data-device="true"][data-category="Tablet"] iframe{border-radius:6px}

/* Laptop frame — contained chrome (no layout-breaking 140% pseudo) */
.fp-frame[data-device="true"][data-category="Laptop"]{border-radius:8px 8px 0 0;border:10px solid #1c1c1e;border-bottom-width:0;box-shadow:0 12px 40px rgba(0,0,0,.4);overflow:visible;margin-bottom:22px}
.fp-frame[data-device="true"][data-category="Laptop"]::before{content:'';position:absolute;bottom:-16px;left:0;right:0;height:16px;background:linear-gradient(to bottom,#2a2a2e,#1a1a1c);border-radius:0 0 8px 8px;z-index:1;pointer-events:none;box-shadow:0 6px 16px rgba(0,0,0,.3)}
.fp-frame[data-device="true"][data-category="Laptop"]::after{content:'';position:absolute;bottom:-9px;left:50%;transform:translateX(-50%);width:48px;height:3px;background:#0a0a0c;border-radius:2px;z-index:2;pointer-events:none}
.fp-frame[data-device="true"][data-category="Laptop"] iframe{border-radius:3px}
.fp-frame[data-device="true"][data-category="Laptop"][data-rotated="true"]{border-radius:0 8px 8px 0;border-width:10px 0 10px 10px;margin-bottom:0;margin-left:22px}
.fp-frame[data-device="true"][data-category="Laptop"][data-rotated="true"]::before{bottom:0;top:0;left:-16px;right:auto;width:16px;height:auto;border-radius:8px 0 0 8px}
.fp-frame[data-device="true"][data-category="Laptop"][data-rotated="true"]::after{bottom:auto;top:50%;left:-9px;transform:translateY(-50%);width:3px;height:48px}

/* Desktop / generic device */
.fp-frame[data-device="true"][data-category="Desktop"],
.fp-frame[data-device="true"][data-category="Quick"]{border-radius:8px;border:6px solid #1a1a1a;box-shadow:0 12px 40px rgba(0,0,0,.45);overflow:hidden}
.fp-frame[data-device="true"][data-category="Desktop"] iframe,
.fp-frame[data-device="true"][data-category="Quick"] iframe{border-radius:2px}
.fp-frame[data-device="true"][data-category="Quick"][data-notch="true"]::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:min(90px,36%);height:16px;background:#0a0c10;border-radius:0 0 10px 10px;z-index:2;pointer-events:none}

/* Small screens — tighter frames, less chrome, better fit */
@media (max-width: 640px) {
  .fp-stage{padding:8px}
  .fp-frame[data-device="true"][data-category="Phone"]{border-width:6px;border-radius:22px}
  .fp-frame[data-device="true"][data-category="Phone"]::before{height:14px;width:min(80px,36%)}
  .fp-frame[data-device="true"][data-category="Phone"] iframe{border-radius:16px}
  .fp-frame[data-device="true"][data-category="Tablet"]{border-width:6px;border-radius:10px}
  .fp-frame[data-device="true"][data-category="Laptop"]{border-width:6px;margin-bottom:14px}
  .fp-frame[data-device="true"][data-category="Laptop"]::before{bottom:-12px;height:12px}
  .fp-frame[data-device="true"][data-category="Laptop"]::after{bottom:-7px;width:36px;height:2px}
  .fp-frame[data-device="true"][data-category="Laptop"][data-rotated="true"]{margin-left:14px;margin-bottom:0}
  .fp-frame[data-device="true"][data-category="Desktop"],
  .fp-frame[data-device="true"][data-category="Quick"]{border-width:4px}
  .fp-readout{font-size:10px;bottom:-36px;padding:4px 8px}
}

.fp-resize{position:absolute;width:36px;height:36px;cursor:nwse-resize;z-index:3;touch-action:none;display:none;align-items:center;justify-content:center}
.fp-frame[data-mode="custom"] .fp-resize{display:flex}
.fp-resize[data-corner="br"]{bottom:-18px;right:-18px}
.fp-resize[data-corner="tl"]{top:-18px;left:-18px}
.fp-resize::after{content:'';width:12px;height:12px;border-radius:4px;background:var(--fp-accent);opacity:.55;box-shadow:0 0 0 2px rgba(10,12,16,.6);transition:opacity .12s,transform .15s var(--fp-ease-spring)}
.fp-resize:hover::after{opacity:1;transform:scale(1.15)}
.fp-readout{position:absolute;bottom:-46px;left:50%;transform:translateX(-50%);padding:5px 11px;border-radius:6px;background:rgba(20,22,28,.94);backdrop-filter:blur(12px);border:1px solid var(--fp-border);font-family:var(--fp-mono);font-size:11px;font-weight:700;color:var(--fp-accent);white-space:nowrap;pointer-events:none;display:none}
.fp-frame[data-mode="custom"] .fp-readout{display:block}

/* breakpoint ruler */
.fp-ruler{position:absolute;top:0;left:0;right:0;height:24px;display:none;align-items:flex-end;justify-content:center;gap:0;padding:0 16px;pointer-events:none;z-index:5;opacity:0;transition:opacity .2s}
.fp-overlay[data-ruler="true"] .fp-ruler{display:flex;opacity:1}
.fp-ruler-mark{position:absolute;bottom:0;transform:translateX(-50%);font-size:9px;font-family:var(--fp-mono);font-weight:700;color:var(--fp-text-3);padding:2px 6px;background:rgba(20,22,28,.85);border-radius:3px;border:1px solid var(--fp-border);pointer-events:auto;cursor:pointer;transition:color .12s,background .12s}
.fp-ruler-mark:hover{color:var(--fp-accent);background:var(--fp-accent-soft)}
.fp-ruler-mark::before{content:'';position:absolute;top:100%;left:50%;width:1px;height:2000px;background:linear-gradient(to bottom,rgba(245,158,11,.3),transparent 40%);transform:translateX(-50%);pointer-events:none}

/* ─── DOCK ─── */
.fp-dock{flex-shrink:0;background:rgba(20,22,28,.94);backdrop-filter:blur(28px) saturate(1.4);-webkit-backdrop-filter:blur(28px) saturate(1.4);border-top:1px solid var(--fp-border);box-shadow:0 -8px 32px rgba(0,0,0,.35);display:flex;flex-direction:column;transition:height calc(.28s/var(--fp-speed)) var(--fp-ease);height:var(--fp-dock-h);overflow:hidden;z-index:10;contain:layout paint}
.fp-dock[data-expanded="true"]{height:var(--fp-dock-h-expanded)}
.fp-dock-bar{display:flex;align-items:center;gap:4px;padding:4px 8px;min-height:var(--fp-dock-h);flex-shrink:0;border-bottom:1px solid transparent}
.fp-dock[data-expanded="true"] .fp-dock-bar{border-bottom-color:var(--fp-border)}
.fp-dock-tabs{display:flex;align-items:center;gap:2px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.fp-dock-tabs::-webkit-scrollbar{display:none}
.fp-dock-tab{width:30px;height:30px;padding:0;border:none;border-radius:7px;background:transparent;color:var(--fp-text-3);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .12s var(--fp-ease);position:relative}
.fp-dock-tab:hover{background:rgba(255,255,255,.06);color:var(--fp-text)}
.fp-dock-tab[data-active="true"]{background:var(--fp-accent-soft);color:var(--fp-accent)}
.fp-dock-tab svg{width:14px;height:14px;display:block;stroke:currentColor;fill:none;stroke-width:2.1}
.fp-dock-tab .fp-dock-tab-badge{position:absolute;top:3px;right:3px;min-width:12px;height:12px;padding:0 3px;border-radius:6px;background:var(--fp-danger);color:#fff;font-size:8px;font-weight:800;line-height:12px;text-align:center;font-family:var(--fp-mono);pointer-events:none}
.fp-dock-toggle{flex-shrink:0 !important;width:30px !important;height:30px !important;color:var(--fp-text-2)}
.fp-dock-toggle svg{transition:transform .22s var(--fp-ease-spring)}
.fp-dock[data-expanded="true"] .fp-dock-toggle svg{transform:rotate(180deg)}

.fp-sections{flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0}
.fp-dock[data-expanded="false"] .fp-sections{display:none}
.fp-sections::-webkit-scrollbar{width:6px}
.fp-sections::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:3px}

/* section search bar */
.fp-sec-search-wrap{display:none}

/* section */
.fp-sec{display:none;flex-direction:column;contain:layout paint;flex:1;min-height:0}
.fp-sec[data-open="true"]{display:flex}
.fp-sec[data-hidden="true"]{display:none !important}
.fp-sec[data-disabled="true"]{opacity:.35;pointer-events:none;filter:grayscale(.6)}
.fp-sec-head{display:none}
.fp-sec-body{display:block;overflow-y:auto;overflow-x:hidden;background:transparent;-webkit-overflow-scrolling:touch;flex:1;min-height:0}
.fp-sec-body-inner{padding:8px 12px;min-height:40px;font-size:11px;max-width:100%;overflow-x:hidden;box-sizing:border-box}
.fp-sec-meta{display:none}

/* toolbar / chips / empty */
.fp-toolbar{display:flex;gap:3px;align-items:center;padding:4px 0 6px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,.05);margin-bottom:6px}
.fp-toolbar input[type="search"],.fp-toolbar input[type="text"]{flex:1;min-width:80px;max-width:260px;height:26px;padding:0 8px;border-radius:5px;background:rgba(255,255,255,.05);border:1px solid var(--fp-border);color:var(--fp-text);font-size:10.5px;outline:none;font-family:inherit;transition:border-color .15s}
.fp-toolbar input:focus{border-color:var(--fp-accent);background:var(--fp-accent-soft)}
.fp-chip{padding:3px 8px;border-radius:8px;background:rgba(255,255,255,.05);border:1px solid var(--fp-border);color:var(--fp-text-2);font-size:10px;font-weight:700;cursor:pointer;transition:all calc(.12s/var(--fp-speed)) var(--fp-ease);white-space:nowrap;font-family:inherit;display:inline-flex;align-items:center;gap:3px}
.fp-chip:hover{background:rgba(255,255,255,.08);color:var(--fp-text)}
.fp-chip.active{background:var(--fp-accent-soft);color:var(--fp-accent);border-color:var(--fp-accent-glow)}
.fp-chip.danger{color:var(--fp-danger)}
.fp-chip.danger:hover{background:var(--fp-danger-soft);border-color:rgba(239,68,68,.3)}
.fp-chip svg{width:10px;height:10px}
.fp-chip-count{opacity:.65;margin-left:3px;font-weight:500}
.fp-empty{padding:24px 12px;text-align:center;color:var(--fp-text-3);font-size:11px;line-height:1.6}
.fp-empty strong{color:var(--fp-text-2);display:block;margin-bottom:4px;font-weight:700}
.fp-empty-icon{width:36px;height:36px;border-radius:10px;background:rgba(255,255,255,.04);display:inline-flex;align-items:center;justify-content:center;margin-bottom:8px;color:var(--fp-text-3)}
.fp-empty-icon svg{width:16px;height:16px}
.fp-skeleton{padding:12px 0}
.fp-skeleton-row{height:10px;background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.08),rgba(255,255,255,.04));background-size:200% 100%;animation:fpSkeleton 1.4s ease infinite;border-radius:3px;margin-bottom:6px}
.fp-skeleton-row:last-child{width:60%}
@keyframes fpSkeleton{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* console */
.fp-console-list{font-family:var(--fp-mono);font-size:11px;line-height:1.55}
.fp-console-entry{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);align-items:flex-start;transition:background .12s}
.fp-console-entry:hover{background:rgba(255,255,255,.02)}
.fp-console-entry:last-child{border-bottom:none}
.fp-console-entry[data-level="error"]{background:rgba(239,68,68,.04);padding-left:6px;border-left:2px solid rgba(239,68,68,.4)}
.fp-console-entry[data-level="warn"]{background:rgba(245,158,11,.03);padding-left:6px;border-left:2px solid rgba(245,158,11,.3)}
.fp-console-icon{width:12px;flex-shrink:0;margin-top:2px;color:var(--fp-text-3)}
.fp-console-entry[data-level="error"] .fp-console-icon{color:var(--fp-danger)}
.fp-console-entry[data-level="warn"] .fp-console-icon{color:var(--fp-accent)}
.fp-console-icon svg{width:100%;height:100%;stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.fp-console-meta{font-size:9.5px;color:var(--fp-text-3);white-space:nowrap;flex-shrink:0;line-height:1.5;padding-top:1px;font-family:var(--fp-mono)}
.fp-console-meta .fp-file{color:rgba(245,158,11,.7);cursor:pointer;text-decoration:underline;text-decoration-color:transparent;transition:text-decoration-color .12s}
.fp-console-meta .fp-file:hover{text-decoration-color:currentColor}
.fp-console-args{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--fp-text)}
.fp-console-arg{display:inline;margin-right:6px}
.fp-console-arg[data-kind="string"]{color:#10B981}
.fp-console-arg[data-kind="number"]{color:#3B82F6}
.fp-console-arg[data-kind="boolean"]{color:#a855f7}
.fp-console-arg[data-kind="null"],.fp-console-arg[data-kind="undefined"]{color:var(--fp-text-3);font-style:italic}
.fp-console-arg[data-kind="error"]{color:var(--fp-danger)}
.fp-console-arg[data-kind="function"],.fp-console-arg[data-kind="symbol"]{color:#06b6d4;font-style:italic}
.fp-console-arg[data-kind="object"],.fp-console-arg[data-kind="array"]{cursor:pointer;color:var(--fp-text-2)}
.fp-console-arg[data-kind="object"]:hover,.fp-console-arg[data-kind="array"]:hover{color:var(--fp-accent)}
.fp-console-nested{padding-left:14px;border-left:1px solid rgba(255,255,255,.08);margin:3px 0 3px 6px;display:none}
.fp-console-nested[data-expanded="true"]{display:block}
.fp-console-nested-row{display:flex;gap:4px;padding:1px 0;font-size:10.5px}
.fp-console-nested-row .fp-nk{color:#06b6d4;flex-shrink:0}
.fp-console-nested-row .fp-nk::after{content:':';color:var(--fp-text-3);margin-right:3px}
.fp-console-repl{display:flex;gap:6px;align-items:center;padding:6px 0 0;border-top:1px solid rgba(255,255,255,.06);margin-top:6px;position:relative}
.fp-console-repl-prompt{color:var(--fp-accent);font-weight:800;font-family:var(--fp-mono);font-size:11px;padding-left:2px;flex-shrink:0}
.fp-console-repl input{flex:1;height:26px;padding:0 8px;border-radius:5px;background:rgba(255,255,255,.05);border:1px solid var(--fp-border);color:var(--fp-text);font-family:var(--fp-mono);font-size:11px;outline:none;transition:border-color .15s}
.fp-console-repl input:focus{border-color:var(--fp-accent)}
.fp-console-repl-result{margin-top:4px;padding:4px 8px;border-radius:4px;background:rgba(255,255,255,.03);font-family:var(--fp-mono);font-size:10.5px;color:var(--fp-text-2);border-left:2px solid rgba(255,255,255,.1);white-space:pre-wrap;overflow-wrap:anywhere}
.fp-console-repl-result[data-ok="false"]{color:var(--fp-danger);border-left-color:var(--fp-danger)}

/* network */
.fp-net-list{font-family:var(--fp-mono);font-size:10.5px}
.fp-net-row{display:grid;grid-template-columns:44px 52px 1fr 62px;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);align-items:center;cursor:pointer;transition:background .1s}
.fp-net-row:hover{background:rgba(255,255,255,.03)}
.fp-net-method{font-weight:800;color:var(--fp-text-2);font-size:10px}
.fp-net-status{font-weight:800;padding:1px 5px;border-radius:3px;text-align:center;font-size:9.5px}
.fp-net-status[data-family="2"]{color:#10B981;background:rgba(16,185,129,.1)}
.fp-net-status[data-family="3"]{color:#3B82F6;background:rgba(59,130,246,.1)}
.fp-net-status[data-family="4"]{color:#F59E0B;background:rgba(245,158,11,.1)}
.fp-net-status[data-family="5"]{color:#EF4444;background:rgba(239,68,68,.1)}
.fp-net-status[data-family="error"]{color:#EF4444;background:rgba(239,68,68,.14)}
.fp-net-url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fp-text)}
.fp-net-dur{text-align:right;color:var(--fp-text-3);font-size:9.5px}
.fp-net-detail{padding:8px 12px;background:rgba(255,255,255,.02);border-left:2px solid rgba(245,158,11,.3);margin:2px 0 4px;display:none}
.fp-net-detail[data-open="true"]{display:block}
.fp-net-detail-row{display:grid;grid-template-columns:90px 1fr;gap:6px;font-size:10px;padding:2px 0}
.fp-net-detail-row .fk{color:var(--fp-text-3);font-weight:600}
.fp-net-detail-row .fv{color:var(--fp-text-2);overflow-wrap:anywhere;font-family:var(--fp-mono)}
.fp-net-actions{display:flex;gap:4px;margin-top:6px;padding-top:6px;border-top:1px solid var(--fp-border)}
.fp-net-waterfall{padding:10px 0}
.fp-net-waterfall-title{font-size:10px;font-weight:800;color:var(--fp-text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.fp-net-waterfall-row{display:grid;grid-template-columns:1fr 180px 50px;gap:8px;align-items:center;padding:3px 0;font-size:10px}
.fp-net-waterfall-row .fw-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fp-text);font-family:var(--fp-mono)}
.fp-net-waterfall-row .fw-bar{position:relative;height:8px;background:rgba(255,255,255,.03);border-radius:2px;overflow:hidden}
.fp-net-waterfall-row .fw-bar-fill{position:absolute;top:0;bottom:0;background:linear-gradient(90deg,var(--fp-accent),#fbbf24);border-radius:2px;min-width:2px}
.fp-net-waterfall-row .fw-dur{text-align:right;color:var(--fp-text-3);font-size:9.5px}

/* assets */
.fp-asset-group{margin-bottom:10px}
.fp-asset-group-title{font-size:10px;font-weight:800;color:var(--fp-text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;display:flex;align-items:center;gap:6px}
.fp-asset-row{display:flex;gap:8px;padding:4px 6px;border-radius:4px;font-size:10.5px;align-items:center;font-family:var(--fp-mono);transition:background .1s}
.fp-asset-row:hover{background:rgba(255,255,255,.03)}
.fp-asset-row[data-clickable="true"]{cursor:pointer}
.fp-asset-status{width:14px;text-align:center;font-weight:800;color:var(--fp-text-3)}
.fp-asset-status[data-known="true"]{color:var(--fp-success)}
.fp-asset-path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fp-text)}
.fp-asset-kind{font-size:9px;color:var(--fp-text-3);padding:1px 5px;border-radius:8px;background:rgba(255,255,255,.06)}
.fp-asset-size{font-size:9.5px;color:var(--fp-text-3)}
.fp-asset-hint{font-size:10px;color:var(--fp-text-3);margin-left:auto}

/* graph */
.fp-graph{position:relative;padding:8px 0;font-family:var(--fp-mono);font-size:10.5px}
.fp-graph-node{padding:3px 0;position:relative;display:flex;align-items:center;gap:6px}
.fp-graph-node[data-depth="1"]{padding-left:16px}
.fp-graph-node[data-depth="2"]{padding-left:32px}
.fp-graph-node[data-depth="3"]{padding-left:48px}
.fp-graph-node::before{content:'';position:absolute;left:calc(var(--depth,0)*16px + 6px);top:0;bottom:0;width:1px;background:rgba(255,255,255,.06)}
.fp-graph-node[data-depth="0"]::before{display:none}
.fp-graph-icon{width:12px;height:12px;flex-shrink:0;color:var(--fp-text-3)}
.fp-graph-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* responsive / a11y / performance shared */
.fp-resp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:12px}
.fp-resp-stat{padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05)}
.fp-resp-stat-label{font-size:9.5px;font-weight:700;color:var(--fp-text-3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px}
.fp-resp-stat-value{font-size:14px;font-weight:800;color:var(--fp-text);font-family:var(--fp-mono)}
.fp-resp-stat-value[data-warn="true"]{color:var(--fp-accent)}
.fp-resp-stat-value[data-error="true"]{color:var(--fp-danger)}
.fp-resp-group,.fp-a11y-group,.fp-perf-payload{margin-bottom:12px}
.fp-resp-group-title,.fp-a11y-group-title{font-size:10px;font-weight:800;color:var(--fp-text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.fp-resp-group-title .fp-count,.fp-a11y-group-title .fp-count{padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.06);color:var(--fp-text-2);font-size:9px}
.fp-resp-issue,.fp-a11y-issue{padding:5px 8px;border-radius:4px;background:rgba(255,255,255,.02);margin-bottom:3px;border-left:2px solid rgba(245,158,11,.4);font-size:10.5px;cursor:pointer;transition:background .1s,transform .12s}
.fp-resp-issue:hover,.fp-a11y-issue:hover{background:rgba(255,255,255,.05);transform:translateX(2px)}
.fp-resp-issue[data-severity="error"],.fp-a11y-issue[data-severity="error"]{border-left-color:var(--fp-danger)}
.fp-issue-path{font-family:var(--fp-mono);color:var(--fp-accent);font-size:10px}
.fp-issue-detail{color:var(--fp-text-2);font-size:10px;margin-top:2px}
.fp-a11y-issue-title{color:var(--fp-text);font-weight:600;margin-bottom:2px}
.fp-a11y-issue-detail{color:var(--fp-text-3);font-size:10px;font-family:var(--fp-mono);overflow-wrap:anywhere}
.fp-a11y-actions{display:flex;gap:4px;margin-top:4px}

/* performance */
.fp-perf-vitals{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:12px}
.fp-perf-vital{padding:10px;border-radius:6px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05)}
.fp-perf-vital-label{font-size:9.5px;font-weight:700;color:var(--fp-text-3);text-transform:uppercase;letter-spacing:.4px}
.fp-perf-vital-value{font-size:16px;font-weight:800;color:var(--fp-text);margin:2px 0;font-family:var(--fp-mono)}
.fp-perf-vital[data-rating="good"] .fp-perf-vital-value{color:var(--fp-success)}
.fp-perf-vital[data-rating="warn"] .fp-perf-vital-value{color:var(--fp-accent)}
.fp-perf-vital[data-rating="bad"] .fp-perf-vital-value{color:var(--fp-danger)}
.fp-perf-vital-target{font-size:9.5px;color:var(--fp-text-3)}
.fp-perf-payload-row{display:grid;grid-template-columns:1fr 68px;gap:8px;align-items:center;padding:3px 0;font-size:10.5px}
.fp-perf-payload-row .fp-payload-label{color:var(--fp-text-2)}
.fp-perf-payload-row .fp-payload-val{text-align:right;font-family:var(--fp-mono);color:var(--fp-text);font-weight:700}
.fp-perf-payload-row[data-warn="true"] .fp-payload-val{color:var(--fp-accent)}
.fp-perf-budget{height:4px;background:rgba(255,255,255,.04);border-radius:2px;overflow:hidden;margin:4px 0 8px}
.fp-perf-budget-fill{height:100%;background:var(--fp-accent);transition:width .4s var(--fp-ease)}
.fp-perf-budget[data-level="good"] .fp-perf-budget-fill{background:var(--fp-success)}
.fp-perf-budget[data-level="warn"] .fp-perf-budget-fill{background:var(--fp-accent)}
.fp-perf-budget[data-level="bad"] .fp-perf-budget-fill{background:var(--fp-danger)}

/* files */
.fp-files-group{margin-bottom:12px}
.fp-files-group-title{font-size:10px;font-weight:800;color:var(--fp-text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.fp-files-row{display:flex;gap:8px;padding:4px 6px;border-radius:4px;font-size:10.5px;align-items:center;transition:background .1s}
.fp-files-row:hover{background:rgba(255,255,255,.03)}
.fp-files-row[data-clickable="true"]{cursor:pointer}
.fp-files-status{width:14px;flex-shrink:0;text-align:center;font-weight:800}
.fp-files-row[data-loaded="true"] .fp-files-status{color:var(--fp-success)}
.fp-files-row[data-loaded="false"] .fp-files-status{color:var(--fp-danger)}
.fp-files-path{font-family:var(--fp-mono);color:var(--fp-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-files-size{color:var(--fp-text-3);font-family:var(--fp-mono);font-size:9.5px}
.fp-files-reason{color:var(--fp-text-3);font-size:9.5px;font-style:italic}

/* storage */
.fp-stor-group{margin-bottom:12px}
.fp-stor-group-title{font-size:10px;font-weight:800;color:var(--fp-text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.fp-stor-row{display:grid;grid-template-columns:minmax(80px,1fr) minmax(80px,2fr) 52px;gap:6px;padding:4px 6px;border-radius:4px;font-size:10px;font-family:var(--fp-mono);align-items:center;transition:background .1s}
.fp-stor-row:hover{background:rgba(255,255,255,.03)}
.fp-stor-key{color:var(--fp-accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-stor-val{color:var(--fp-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-stor-act{display:flex;gap:2px}
.fp-stor-act button{padding:2px 5px;border-radius:3px;background:rgba(255,255,255,.05);border:none;color:var(--fp-text-3);cursor:pointer;font-size:9px;font-family:inherit;transition:all .12s}
.fp-stor-act button:hover{background:rgba(239,68,68,.15);color:var(--fp-danger)}

/* dom */
.fp-dom-toolbar{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
.fp-dom-search{flex:1;height:26px;padding:0 8px;border-radius:5px;background:rgba(255,255,255,.05);border:1px solid var(--fp-border);color:var(--fp-text);font-size:10.5px;outline:none;font-family:var(--fp-mono)}
.fp-dom-search:focus{border-color:var(--fp-accent)}
.fp-dom-breadcrumb{display:flex;gap:2px;align-items:center;padding:4px 0;font-family:var(--fp-mono);font-size:10px;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--fp-border);margin-bottom:6px;min-height:22px}
.fp-dom-breadcrumb::-webkit-scrollbar{display:none}
.fp-dom-crumb{padding:1px 4px;border-radius:3px;color:var(--fp-accent);cursor:pointer;transition:background .12s;flex-shrink:0}
.fp-dom-crumb:hover{background:var(--fp-accent-soft)}
.fp-dom-crumb-sep{color:var(--fp-text-3);flex-shrink:0}
.fp-dom-tree{font-family:var(--fp-mono);font-size:10.5px;line-height:1.5}
.fp-dom-node{padding:1px 0}
.fp-dom-toggle{display:inline-flex;width:12px;justify-content:center;color:var(--fp-text-3);cursor:pointer;user-select:none;margin-right:2px}
.fp-dom-node[data-has-children="true"] .fp-dom-toggle:hover{color:var(--fp-text)}
.fp-dom-tag{color:#a855f7;cursor:pointer;transition:background .1s;padding:0 2px;border-radius:2px}
.fp-dom-tag:hover{background:rgba(168,85,247,.15)}
.fp-dom-tag[data-inspect="true"]{background:var(--fp-accent-soft);color:var(--fp-accent)}
.fp-dom-id{color:var(--fp-accent)}
.fp-dom-class{color:#10B981}
.fp-dom-children{padding-left:14px;border-left:1px solid rgba(255,255,255,.06);margin-left:5px}
.fp-dom-children[data-collapsed="true"]{display:none}

/* devtools */
.fp-devtools-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px}
.fp-devtools-btn{padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);color:var(--fp-text-2);font-size:10.5px;font-weight:600;cursor:pointer;text-align:left;display:flex;align-items:center;gap:6px;transition:all calc(.12s/var(--fp-speed)) var(--fp-ease);font-family:inherit;min-height:34px}
.fp-devtools-btn:hover{background:rgba(255,255,255,.08);color:var(--fp-text);border-color:rgba(245,158,11,.3);transform:translateY(-1px)}
.fp-devtools-btn:active{transform:translateY(0) scale(.98)}
.fp-devtools-btn svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.fp-devtools-btn[data-danger="true"]:hover{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);color:var(--fp-danger)}

/* search */
.fp-search-options{display:flex;gap:4px;padding:4px 0 6px}
.fp-search-toggle{padding:3px 8px;border-radius:5px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);color:var(--fp-text-3);font-size:10.5px;font-weight:700;font-family:var(--fp-mono);cursor:pointer;transition:all .12s}
.fp-search-toggle:hover{background:rgba(255,255,255,.08);color:var(--fp-text)}
.fp-search-toggle.active{background:var(--fp-accent-soft);color:var(--fp-accent);border-color:var(--fp-accent-glow)}
.fp-search-result-group{margin-bottom:10px}
.fp-search-result-header{display:flex;align-items:center;gap:6px;padding:4px 6px;font-size:10.5px;color:var(--fp-text-2);cursor:pointer;border-radius:4px;transition:background .1s}
.fp-search-result-header:hover{background:rgba(255,255,255,.03)}
.fp-search-result-path{flex:1;font-family:var(--fp-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-search-result-count{font-size:9px;padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.06);color:var(--fp-text-2)}
.fp-search-match{display:flex;gap:6px;padding:3px 8px 3px 20px;font-size:10.5px;cursor:pointer;border-radius:3px;transition:background .1s;font-family:var(--fp-mono)}
.fp-search-match:hover{background:rgba(245,158,11,.08)}
.fp-search-match-line{color:var(--fp-text-3);flex-shrink:0;min-width:32px;text-align:right}
.fp-search-match-body{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fp-text)}
.fp-search-match-hit{background:rgba(245,158,11,.3);color:#FBBF24;padding:0 1px;border-radius:2px}

/* ─── DIALOGS ─── */
.fp-dialog-backdrop{position:fixed;inset:0;z-index:var(--fp-z-dialog);background:rgba(5,7,10,.72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;pointer-events:none;transition:opacity calc(.2s/var(--fp-speed)) var(--fp-ease)}
.fp-dialog-backdrop[data-open="true"]{opacity:1;pointer-events:auto}
.fp-dialog{width:100%;max-width:540px;max-height:min(85vh,720px);background:var(--fp-surface-2);border:1px solid var(--fp-border-strong);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;transform:scale(.94) translateY(8px);transition:transform calc(.28s/var(--fp-speed)) var(--fp-ease-spring);font-family:var(--fp-sans);color:var(--fp-text)}
.fp-dialog-backdrop[data-open="true"] .fp-dialog{transform:scale(1) translateY(0)}
.fp-dialog.wide{max-width:720px}
.fp-dialog.narrow{max-width:420px}
.fp-dialog-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--fp-border);flex-shrink:0}
.fp-dialog-title{font-size:14px;font-weight:800;color:var(--fp-text);flex:1;letter-spacing:-.2px}
.fp-dialog-subtitle{font-size:10.5px;color:var(--fp-text-3);margin-top:2px;font-weight:500}
.fp-dialog-close{width:28px;height:28px;border-radius:6px;background:transparent;border:none;color:var(--fp-text-3);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
.fp-dialog-close:hover{background:rgba(255,255,255,.06);color:var(--fp-text)}
.fp-dialog-close svg{width:14px;height:14px}
.fp-dialog-body{padding:16px;overflow-y:auto;flex:1;min-height:0}
.fp-dialog-foot{padding:12px 16px;border-top:1px solid var(--fp-border);display:flex;gap:8px;justify-content:flex-end;flex-shrink:0}
.fp-dialog-btn{padding:7px 14px;border-radius:7px;background:rgba(255,255,255,.06);border:1px solid var(--fp-border);color:var(--fp-text-2);font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;transition:all calc(.12s/var(--fp-speed)) var(--fp-ease);display:inline-flex;align-items:center;gap:5px}
.fp-dialog-btn:hover{background:rgba(255,255,255,.1);color:var(--fp-text);border-color:var(--fp-border-strong)}
.fp-dialog-btn.primary{background:var(--fp-accent);color:#0a0c10;border-color:var(--fp-accent)}
.fp-dialog-btn.primary:hover{background:var(--fp-accent-hover);border-color:var(--fp-accent-hover)}
.fp-dialog-btn.danger{background:var(--fp-danger);color:#fff;border-color:var(--fp-danger)}
.fp-dialog-btn.danger:hover{background:#dc2626;border-color:#dc2626}
.fp-dialog-btn svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2.2}

/* dialog lists */
.fp-list{display:flex;flex-direction:column;gap:4px}
.fp-list-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid var(--fp-border);color:var(--fp-text);cursor:pointer;transition:all calc(.12s/var(--fp-speed)) var(--fp-ease);text-align:left;font-family:inherit;font-size:12px;width:100%}
.fp-list-item:hover{background:rgba(255,255,255,.06);border-color:var(--fp-border-strong);transform:translateY(-1px)}
.fp-list-item:active{transform:translateY(0) scale(.995)}
.fp-list-item.active{background:var(--fp-accent-soft);border-color:var(--fp-accent-glow)}
.fp-list-item-icon{width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,.04);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--fp-accent)}
.fp-list-item-icon svg{width:14px;height:14px}
.fp-list-item-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.fp-list-item-title{font-size:12px;font-weight:700;color:var(--fp-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.3}
.fp-list-item-desc{font-size:10.5px;color:var(--fp-text-3);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-list-item-meta{font-size:10px;color:var(--fp-text-3);font-family:var(--fp-mono);flex-shrink:0;text-align:right}

/* form controls */
.fp-field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.fp-field:last-child{margin-bottom:0}
.fp-field-label{font-size:10.5px;font-weight:700;color:var(--fp-text-3);text-transform:uppercase;letter-spacing:.4px}
.fp-field-hint{font-size:10px;color:var(--fp-text-3);line-height:1.4;margin-top:2px}
.fp-input,.fp-select,.fp-textarea{width:100%;height:32px;padding:0 10px;background:rgba(255,255,255,.04);border:1px solid var(--fp-border);border-radius:6px;color:var(--fp-text);font-size:12px;font-family:inherit;outline:none;transition:border-color .15s}
.fp-input:focus,.fp-select:focus,.fp-textarea:focus{border-color:var(--fp-accent);background:var(--fp-accent-soft)}
.fp-textarea{height:auto;min-height:80px;padding:8px 10px;resize:vertical;line-height:1.5;font-family:var(--fp-mono);font-size:11px}
.fp-input[type="number"]{font-family:var(--fp-mono)}
.fp-select{cursor:pointer;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a919c' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");background-repeat:no-repeat;background-position:right 8px center;background-size:12px;padding-right:28px}
.fp-toggle{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid var(--fp-border);margin-bottom:6px;cursor:pointer;transition:background .12s}
.fp-toggle:hover{background:rgba(255,255,255,.05)}
.fp-toggle-label{font-size:11.5px;color:var(--fp-text);font-weight:600}
.fp-toggle-desc{font-size:10px;color:var(--fp-text-3);margin-top:1px;line-height:1.35}
.fp-toggle-switch{width:32px;height:18px;border-radius:9px;background:rgba(255,255,255,.1);border:1px solid var(--fp-border);position:relative;transition:background .2s,border-color .2s;flex-shrink:0;cursor:pointer}
.fp-toggle-switch::after{content:'';position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;background:var(--fp-text-2);transition:transform calc(.2s/var(--fp-speed)) var(--fp-ease-spring),background .15s}
.fp-toggle input{display:none}
.fp-toggle input:checked + .fp-toggle-switch{background:var(--fp-accent);border-color:var(--fp-accent)}
.fp-toggle input:checked + .fp-toggle-switch::after{transform:translateX(14px);background:#0a0c10}
.fp-slider{width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,.1);appearance:none;-webkit-appearance:none;outline:none;margin:8px 0}
.fp-slider::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--fp-accent);cursor:pointer;border:2px solid var(--fp-surface-2);transition:transform .12s var(--fp-ease-spring)}
.fp-slider::-webkit-slider-thumb:hover{transform:scale(1.15)}
.fp-slider::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--fp-accent);cursor:pointer;border:2px solid var(--fp-surface-2)}
.fp-slider-row{display:flex;align-items:center;gap:10px}
.fp-slider-value{font-family:var(--fp-mono);font-size:11px;color:var(--fp-accent);font-weight:700;min-width:44px;text-align:right}
.fp-tabs{display:flex;gap:2px;padding:3px;background:rgba(255,255,255,.03);border:1px solid var(--fp-border);border-radius:6px;margin-bottom:12px}
.fp-tab{flex:1;padding:5px 8px;border-radius:4px;background:transparent;border:none;color:var(--fp-text-3);font-size:10.5px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s}
.fp-tab:hover{color:var(--fp-text-2)}
.fp-tab.active{background:var(--fp-accent-soft);color:var(--fp-accent)}
.fp-tab-content{display:none}
.fp-tab-content.active{display:block}

/* device dialog grid */
.fp-device-cat{margin-bottom:14px}
.fp-device-cat-title{font-size:10px;font-weight:800;color:var(--fp-text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.fp-device-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px}
.fp-device-btn{padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid var(--fp-border);color:var(--fp-text);cursor:pointer;text-align:left;font-family:inherit;font-size:11px;transition:all .12s;display:flex;flex-direction:column;gap:2px}
.fp-device-btn:hover{background:rgba(255,255,255,.06);border-color:var(--fp-border-strong);transform:translateY(-1px)}
.fp-device-btn.active{background:var(--fp-accent-soft);border-color:var(--fp-accent-glow);color:var(--fp-accent)}
.fp-device-btn-name{font-weight:700;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-device-btn-dims{font-size:10px;color:var(--fp-text-3);font-family:var(--fp-mono);font-weight:600}
.fp-device-btn.active .fp-device-btn-dims{color:rgba(245,158,11,.7)}

/* command palette */
.fp-palette-backdrop{position:fixed;inset:0;z-index:var(--fp-z-palette);background:rgba(5,7,10,.72);backdrop-filter:blur(8px);display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;opacity:0;pointer-events:none;transition:opacity .18s var(--fp-ease)}
.fp-palette-backdrop[data-open="true"]{opacity:1;pointer-events:auto}
.fp-palette{width:100%;max-width:560px;background:var(--fp-surface-2);border:1px solid var(--fp-border-strong);border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden;transform:scale(.96) translateY(-8px);transition:transform .22s var(--fp-ease-spring);font-family:var(--fp-sans);color:var(--fp-text)}
.fp-palette-backdrop[data-open="true"] .fp-palette{transform:scale(1) translateY(0)}
.fp-palette-input-wrap{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--fp-border)}
.fp-palette-input-wrap svg{width:14px;height:14px;color:var(--fp-text-3);flex-shrink:0}
.fp-palette-input{flex:1;background:transparent;border:none;outline:none;color:var(--fp-text);font-size:14px;font-family:inherit;font-weight:500}
.fp-palette-input::placeholder{color:var(--fp-text-3)}
.fp-palette-hint{padding:3px 8px;border-radius:4px;background:rgba(255,255,255,.06);border:1px solid var(--fp-border);color:var(--fp-text-3);font-size:9.5px;font-weight:700;font-family:var(--fp-mono)}
.fp-palette-results{max-height:min(60vh,420px);overflow-y:auto;padding:6px}
.fp-palette-group-label{padding:8px 10px 4px;font-size:9.5px;font-weight:800;color:var(--fp-text-3);text-transform:uppercase;letter-spacing:.6px}
.fp-palette-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;transition:background .1s;font-size:12px}
.fp-palette-item[data-active="true"]{background:var(--fp-accent-soft)}
.fp-palette-item-icon{width:24px;height:24px;border-radius:5px;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--fp-text-2)}
.fp-palette-item[data-active="true"] .fp-palette-item-icon{background:var(--fp-accent-soft);color:var(--fp-accent)}
.fp-palette-item-icon svg{width:12px;height:12px}
.fp-palette-item-label{flex:1;font-weight:600;color:var(--fp-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-palette-item-desc{font-size:10px;color:var(--fp-text-3);margin-top:1px}
.fp-palette-item-kbd{font-family:var(--fp-mono);font-size:9.5px;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,.06);color:var(--fp-text-3);flex-shrink:0}

/* screenshot annotator */
.fp-annotator{position:fixed;inset:0;z-index:var(--fp-z-dialog);background:rgba(5,7,10,.88);display:flex;flex-direction:column;opacity:0;pointer-events:none;transition:opacity .2s}
.fp-annotator[data-open="true"]{opacity:1;pointer-events:auto}
.fp-annotator-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--fp-border);flex-shrink:0;background:var(--fp-surface)}
.fp-annotator-title{font-size:13px;font-weight:800;color:var(--fp-text);flex:1}
.fp-annotator-tools{display:flex;gap:2px;padding:3px;background:rgba(255,255,255,.04);border-radius:6px}
.fp-annotator-tool{width:30px;height:30px;border-radius:4px;background:transparent;border:none;color:var(--fp-text-3);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .12s}
.fp-annotator-tool:hover{color:var(--fp-text);background:rgba(255,255,255,.06)}
.fp-annotator-tool.active{color:var(--fp-accent);background:var(--fp-accent-soft)}
.fp-annotator-tool svg{width:14px;height:14px}
.fp-annotator-canvas-wrap{flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:20px;min-height:0}
.fp-annotator-canvas{position:relative;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.5);line-height:0}
.fp-annotator-canvas img{display:block;max-width:100%;max-height:100%;user-select:none;pointer-events:none}
.fp-annotator-layer{position:absolute;inset:0;cursor:crosshair}
.fp-annotator-actions{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--fp-border);justify-content:flex-end;flex-shrink:0;background:var(--fp-surface)}

/* toasts */
.fp-toasts{position:fixed;bottom:calc(var(--fp-dock-h) + 12px);left:50%;transform:translateX(-50%);z-index:var(--fp-z-toast);width:calc(100% - 24px);max-width:380px;display:flex;flex-direction:column;gap:6px;pointer-events:none}
.fp-toast{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--fp-surface-3);border:1px solid var(--fp-border-strong);border-radius:10px;font-size:12px;color:var(--fp-text);box-shadow:0 10px 40px rgba(0,0,0,.5);transform:translateY(20px);opacity:0;transition:all .3s var(--fp-ease-spring);pointer-events:auto;font-family:var(--fp-sans)}
.fp-toast.show{transform:translateY(0);opacity:1}
.fp-toast-icon{width:16px;height:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.fp-toast-icon svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2.2}
.fp-toast.success .fp-toast-icon{color:var(--fp-success)}
.fp-toast.error .fp-toast-icon{color:var(--fp-danger)}
.fp-toast.warning .fp-toast-icon{color:var(--fp-accent)}
.fp-toast.info .fp-toast-icon{color:var(--fp-info)}
.fp-toast-msg{flex:1;line-height:1.35}
.fp-toast-action{padding:3px 8px;border-radius:5px;background:var(--fp-accent-soft);color:var(--fp-accent);font-size:10.5px;font-weight:800;border:none;cursor:pointer;flex-shrink:0;font-family:inherit;transition:all .15s}
.fp-toast-action:hover{background:var(--fp-accent);color:#0a0c10}

/* heatmap overlay */
.fp-heatmap{position:absolute;inset:0;pointer-events:none;z-index:2;overflow:hidden}
.fp-heatmap-dot{position:absolute;width:40px;height:40px;border-radius:50%;background:radial-gradient(circle,rgba(239,68,68,.6) 0%,rgba(239,68,68,.3) 40%,transparent 70%);transform:translate(-50%,-50%);pointer-events:none;animation:fpHeat 1s var(--fp-ease-spring)}

/* more menu */
.fp-more-wrap{position:relative;display:inline-flex}
.fp-more-menu{position:absolute;top:calc(100% + 6px);right:0;min-width:200px;max-width:min(260px,calc(100vw - 16px));background:var(--fp-surface-2);border:1px solid var(--fp-border-strong);border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.55);padding:4px;z-index:40;opacity:0;pointer-events:none;transform:translateY(-4px) scale(.98);transition:opacity .15s var(--fp-ease),transform .15s var(--fp-ease-spring)}
.fp-more-menu[data-open="true"]{opacity:1;pointer-events:auto;transform:translateY(0) scale(1)}
.fp-more-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:none;border-radius:7px;background:transparent;color:var(--fp-text);font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;text-align:left;transition:background .12s}
.fp-more-item:hover{background:rgba(255,255,255,.07)}
.fp-more-item svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2.1;flex-shrink:0;color:var(--fp-text-2);display:block}
.fp-more-item span{flex:1;min-width:0}
.fp-more-sep{height:1px;background:var(--fp-border);margin:3px 6px}
.fp-acts-spacer{width:6px;flex-shrink:0;display:inline-block}

/* reduced motion */
@media (prefers-reduced-motion: reduce) {
  .fp-overlay, .fp-dialog, .fp-palette, .fp-toast, .fp-dock, .fp-frame, .fp-more-menu { transition-duration: .01ms !important; animation-duration: .01ms !important; }
}

/* tablet */
@media (max-width: 980px) {
  .fp-header{gap:6px;padding:5px 8px}
  .fp-dock[data-expanded="true"]{height:min(50vh,380px)}
  .fp-dialog.wide{max-width:min(720px,calc(100vw - 20px))}
}

/* mobile */
@media (max-width: 640px) {
  .fp-header{padding:5px 8px;gap:6px;min-height:40px}
  .fp-size-btn{width:26px;height:26px}
  .fp-size-btn svg{width:13px;height:13px}
  .fp-dims{display:none !important}
  .fp-btn.icon{width:28px;height:28px}
  .fp-dock-tab{width:28px;height:28px}
  .fp-dock-toggle{width:28px !important;height:28px !important}
  .fp-dock[data-expanded="true"]{height:min(60vh,440px)}
  .fp-net-row{grid-template-columns:36px 42px 1fr 48px;gap:4px}
  .fp-stor-row{grid-template-columns:1fr 1fr 40px;font-size:9.5px}
  .fp-resp-grid,.fp-perf-vitals{grid-template-columns:repeat(2,1fr)}
  .fp-devtools-grid{grid-template-columns:1fr 1fr}
  .fp-dialog{max-height:92vh;border-radius:12px;width:calc(100% - 12px)}
  .fp-dialog.wide,.fp-dialog.narrow{max-width:calc(100vw - 12px)}
  .fp-dialog-foot{flex-wrap:wrap}
  .fp-palette-backdrop{padding:6vh 8px 8px}
  .fp-toolbar{gap:3px}
  .fp-chip{padding:3px 7px;font-size:9.5px}
}

@media (max-width: 400px) {
  .fp-size-bar .fp-size-btn[data-size="laptop"]{display:none}
  .fp-header{padding:4px 6px}
  .fp-btn.icon{width:26px;height:26px}
}
`;

// ─────────────────────────────────────────────────────────────────
//  BRIDGE (injected into sandbox iframe)
// ─────────────────────────────────────────────────────────────────
const BRIDGE_SCRIPT = `
(function(){
  if (window.__folioBridge) return;
  window.__folioBridge = true;

  var PARENT = window.parent;
  function post(type, payload) {
    try { PARENT.postMessage(Object.assign({ __folio: true, type: type }, payload || {}), "*"); }
    catch (e) {}
  }

  var memLocal = {}, memSession = {};
  function makeStorage(store, kind) {
    return {
      getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? String(store[k]) : null; },
      setItem: function(k, v) { store[k] = String(v); post("folio:storage-write", { kind: kind, op: "set", key: String(k), value: String(v) }); },
      removeItem: function(k) { delete store[k]; post("folio:storage-write", { kind: kind, op: "remove", key: String(k) }); },
      clear: function() { Object.keys(store).forEach(function(k) { delete store[k]; }); post("folio:storage-write", { kind: kind, op: "clear" }); },
      key: function(i) { var keys = Object.keys(store); return keys[i] || null; },
      get length() { return Object.keys(store).length; }
    };
  }
  try { Object.defineProperty(window, "localStorage", { value: makeStorage(memLocal, "local"), configurable: true }); } catch (e) {}
  try { Object.defineProperty(window, "sessionStorage", { value: makeStorage(memSession, "session"), configurable: true }); } catch (e) {}

  function serialize(v, depth) {
    depth = depth || 0;
    if (v === null) return { kind: "null" };
    if (v === undefined) return { kind: "undefined" };
    var t = typeof v;
    if (t === "string") return { kind: "string", value: v };
    if (t === "number") return { kind: "number", value: v };
    if (t === "boolean") return { kind: "boolean", value: v };
    if (t === "function") return { kind: "function", value: v.name || "anonymous" };
    if (t === "symbol") return { kind: "symbol", value: String(v) };
    if (v instanceof Error) return { kind: "error", name: v.name, message: v.message, stack: (v.stack || "").slice(0, 2000) };
    if (depth > 3) return { kind: "object", preview: "[deep]", collapsed: true };
    if (Array.isArray(v)) return { kind: "array", length: v.length, items: v.slice(0, 100).map(function(x) { return serialize(x, depth + 1); }) };
    if (v instanceof Date) return { kind: "date", value: v.toISOString() };
    if (v instanceof RegExp) return { kind: "regexp", value: String(v) };
    if (typeof Element !== "undefined" && v instanceof Element) {
      var cls = typeof v.className === "string" && v.className ? "." + v.className.split(/\\s+/).filter(Boolean).join(".") : "";
      return { kind: "element", preview: v.tagName.toLowerCase() + (v.id ? "#" + v.id : "") + cls };
    }
    if (typeof Node !== "undefined" && v instanceof Node) return { kind: "node", preview: v.nodeName };
    var keys = Object.keys(v).slice(0, 100);
    return { kind: "object", constructor: (v.constructor && v.constructor.name) || "Object", keys: keys, entries: keys.map(function(k) { return { key: k, value: serialize(v[k], depth + 1) }; }) };
  }

  function callSiteOf() {
    var stack = (new Error()).stack || "";
    var lines = stack.split("\\n").slice(1);
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/\\/([^\\/\\s]+):(\\d+):(\\d+)/);
      if (m && m[1] !== "preview.js" && m[1].indexOf("__sandbox") === -1) return { file: "/" + m[1], line: parseInt(m[2], 10) };
    }
    return null;
  }

  var nativeConsole = {};
  ["log", "info", "warn", "error", "debug"].forEach(function(level) {
    nativeConsole[level] = window.console[level] ? window.console[level].bind(window.console) : function() {};
    window.console[level] = function() {
      try {
        var args = Array.prototype.slice.call(arguments).map(function(a) { return serialize(a); });
        var site = callSiteOf();
        post("folio:console", { level: level, args: args, ts: Date.now(), file: site ? site.file : null, line: site ? site.line : null });
      } catch (e) {}
      nativeConsole[level].apply(window.console, arguments);
    };
  });

  window.addEventListener("error", function(e) {
    try { post("folio:error", { source: "error", message: e.message || "Unknown error", stack: (e.error && e.error.stack || "").slice(0, 2000), file: e.filename || null, line: e.lineno || null }); } catch (err) {}
  });
  window.addEventListener("unhandledrejection", function(e) {
    try { var r = e.reason; post("folio:error", { source: "rejection", message: r && r.message ? r.message : String(r), stack: (r && r.stack || "").slice(0, 2000), file: null, line: null }); } catch (err) {}
  });

  var _netConfig = { latencyMs: 0, failureRate: 0 };
  function simulateDelay() { return _netConfig.latencyMs > 0 ? new Promise(function(r) { setTimeout(r, _netConfig.latencyMs); }) : Promise.resolve(); }
  function maybeFail() { return (_netConfig.failureRate > 0 && Math.random() < _netConfig.failureRate) ? Promise.reject(new TypeError("Failed to fetch (simulated)")) : null; }

  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function(input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (init && init.method) || (input && input.method) || "GET";
      var start = Date.now();
      var failed = maybeFail();
      if (failed) {
        post("folio:network", { method: String(method).toUpperCase(), url: String(url), status: 0, durationMs: 0, error: "Simulated failure" });
        return failed;
      }
      return simulateDelay().then(function() { return nativeFetch.apply(window, arguments); }).then(function(res) {
        try { post("folio:network", { method: String(method).toUpperCase(), url: String(url), status: res.status, durationMs: Date.now() - start, error: null }); } catch (e) {}
        return res;
      }).catch(function(err) {
        try { post("folio:network", { method: String(method).toUpperCase(), url: String(url), status: 0, durationMs: Date.now() - start, error: String(err && err.message || err) }); } catch (e) {}
        throw err;
      });
    };
  }

  var NativeXHR = window.XMLHttpRequest;
  if (NativeXHR) {
    var _open = NativeXHR.prototype.open, _send = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function(method, url) { this.__folioMethod = method; this.__folioUrl = url; return _open.apply(this, arguments); };
    NativeXHR.prototype.send = function() {
      var xhr = this; var start = Date.now();
      xhr.addEventListener("loadend", function() {
        try { post("folio:network", { method: String(xhr.__folioMethod || "GET").toUpperCase(), url: String(xhr.__folioUrl || ""), status: xhr.status || 0, durationMs: Date.now() - start, error: xhr.status === 0 ? "Network error" : null }); } catch (e) {}
      });
      return _send.apply(this, arguments);
    };
  }

  try { new PerformanceObserver(function(list) { var entries = list.getEntries(); var last = entries[entries.length - 1]; if (last) post("folio:vitals", { lcp: last.startTime }); }).observe({ type: "largest-contentful-paint", buffered: true }); } catch (e) {}
  try { new PerformanceObserver(function(list) { list.getEntries().forEach(function(e) { if (e.name === "first-contentful-paint") post("folio:vitals", { fcp: e.startTime }); }); }).observe({ type: "paint", buffered: true }); } catch (e) {}
  try {
    var _cls = 0;
    new PerformanceObserver(function(list) {
      list.getEntries().forEach(function(e) {
        if (!e.hadRecentInput) { _cls += e.value; post("folio:layout-shift", { value: e.value, sources: (e.sources || []).map(function(s) { var n = s.node; if (!n) return null; return n.tagName ? n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") : null; }).filter(Boolean) }); }
      });
      post("folio:vitals", { cls: _cls });
    }).observe({ type: "layout-shift", buffered: true });
  } catch (e) {}
  try { new PerformanceObserver(function(list) { list.getEntries().forEach(function(e) { post("folio:resource", { name: e.name, initiatorType: e.initiatorType || "other", duration: e.duration, transferSize: e.transferSize || 0 }); }); }).observe({ type: "resource", buffered: true }); } catch (e) {}

  function pathOf(el) {
    if (!el || !el.tagName) return "";
    var parts = []; var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      var part = node.tagName.toLowerCase();
      if (node.id) { part += "#" + node.id; parts.unshift(part); break; }
      var cls = typeof node.className === "string" ? node.className.trim().split(/\\s+/).filter(Boolean)[0] : "";
      if (cls) part += "." + cls;
      var parent = node.parentElement;
      if (parent) { var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === node.tagName; }); if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")"; }
      parts.unshift(part); node = parent;
    }
    return parts.join(" > ");
  }

  function serializeDOM(node, depth, maxDepth, budget) {
    if (depth > maxDepth || budget.count >= 500) return null;
    if (!node) return null;
    budget.count++;
    var out = {};
    if (node.nodeType === 1) {
      out.tag = node.tagName.toLowerCase();
      if (node.id) out.id = node.id;
      if (typeof node.className === "string" && node.className) out.className = node.className;
      var kids = Array.from(node.children);
      if (kids.length) { out.children = []; for (var i = 0; i < kids.length; i++) { var c = serializeDOM(kids[i], depth + 1, maxDepth, budget); if (c) out.children.push(c); } }
    } else if (node.nodeType === 3) { var t = node.textContent.trim(); if (!t) return null; out.tag = "#text"; out.text = t.slice(0, 80); } else return null;
    return out;
  }

  var _inspectActive = false;
  var _overlay = null;
  function ensureOverlay() {
    if (_overlay) return _overlay;
    _overlay = document.createElement("div");
    _overlay.setAttribute("data-folio", "inspect-overlay");
    _overlay.style.cssText = "position:fixed;pointer-events:none;background:rgba(245,158,11,.22);border:2px solid #F59E0B;z-index:2147483647;border-radius:2px;transition:all .08s ease;display:none";
    document.documentElement.appendChild(_overlay);
    return _overlay;
  }
  function drawOverlay(el) {
    var ov = ensureOverlay();
    if (!el || el === document.documentElement || el === document.body) { ov.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    ov.style.display = "block"; ov.style.left = r.left + "px"; ov.style.top = r.top + "px"; ov.style.width = r.width + "px"; ov.style.height = r.height + "px";
  }
  function hideOverlay() { if (_overlay) _overlay.style.display = "none"; }
  document.addEventListener("mouseover", function(e) { if (_inspectActive) drawOverlay(e.target); }, true);
  document.addEventListener("mouseout", function() { if (_inspectActive) hideOverlay(); }, true);
  document.addEventListener("click", function(e) {
    if (!_inspectActive) return;
    e.preventDefault(); e.stopPropagation();
    var el = e.target; var r = el.getBoundingClientRect();
    post("folio:inspect-result", { elementPath: pathOf(el), tag: el.tagName ? el.tagName.toLowerCase() : "?", id: el.id || "", className: typeof el.className === "string" ? el.className : "", rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
  }, true);
  function highlightElement(path) { try { var el = document.querySelector(path); if (el) { drawOverlay(el); el.scrollIntoView({ behavior: "smooth", block: "center" }); setTimeout(hideOverlay, 2000); } } catch (e) {} }

  function parseRGB(str) { var m = str.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/); if (!m) return null; return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 }; }
  function relLum(c) { var ch = [c.r, c.g, c.b].map(function(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]; }
  function contrastRatio(a, b) { var l1 = relLum(a), l2 = relLum(b); if (l1 < l2) { var t = l1; l1 = l2; l2 = t; } return (l1 + 0.05) / (l2 + 0.05); }

  function runA11yScan() {
    var issues = [];
    document.querySelectorAll("img:not([alt])").forEach(function(img) { if (issues.length >= 50) return; issues.push({ type: "missing-alt", severity: "error", title: "Image missing alt attribute", detail: pathOf(img), fix: "Add alt='description' or alt='' if decorative" }); });
    document.querySelectorAll("button, [role=button]").forEach(function(btn) { if (issues.length >= 50) return; var text = (btn.textContent || "").trim(); var aria = btn.getAttribute("aria-label"); var hasImg = btn.querySelector("img[alt]"); if (!text && !aria && !hasImg) issues.push({ type: "empty-button", severity: "error", title: "Button has no accessible name", detail: pathOf(btn), fix: "Add aria-label or text content" }); });
    if (!document.documentElement.hasAttribute("lang")) issues.push({ type: "missing-lang", severity: "warn", title: "Document missing lang attribute", detail: "<html>", fix: "Add lang='en' to <html>" });
    if (!document.title) issues.push({ type: "missing-title", severity: "error", title: "Document missing title", detail: "<head>", fix: "Add <title>Your page</title>" });
    var idMap = {};
    document.querySelectorAll("[id]").forEach(function(el) { idMap[el.id] = (idMap[el.id] || 0) + 1; });
    Object.keys(idMap).forEach(function(id) { if (idMap[id] > 1 && issues.length < 50) issues.push({ type: "duplicate-id", severity: "error", title: "Duplicate id: " + id, detail: idMap[id] + " elements", fix: "IDs must be unique" }); });
    document.querySelectorAll("p, span, a, h1, h2, h3, h4, h5, h6, li, td, th").forEach(function(el) {
      if (issues.length >= 50 || !el.textContent || !el.textContent.trim()) return;
      var style = getComputedStyle(el); var fg = parseRGB(style.color); var bg = parseRGB(style.backgroundColor);
      if (!fg) return;
      var bgEl = el;
      while (bg && bg.a === 0 && bgEl && bgEl !== document.documentElement) { bgEl = bgEl.parentElement; if (bgEl) bg = parseRGB(getComputedStyle(bgEl).backgroundColor); }
      if (!bg || bg.a === 0) return;
      var ratio = contrastRatio(fg, bg);
      if (ratio < 4.5) issues.push({ type: "low-contrast", severity: "error", title: "Low contrast (" + ratio.toFixed(2) + ":1)", detail: pathOf(el), fix: "Increase contrast ratio to 4.5:1" });
    });
    var prevLevel = 0;
    document.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach(function(h) { if (issues.length >= 50) return; var level = parseInt(h.tagName[1], 10); if (prevLevel > 0 && level > prevLevel + 1) issues.push({ type: "heading-skip", severity: "warn", title: "Heading skips from h" + prevLevel + " to h" + level, detail: pathOf(h), fix: "Use sequential heading levels" }); prevLevel = level; });
    post("folio:a11y-result", { issues: issues });
  }

  function runResponsiveScan() {
    var vw = window.innerWidth;
    var overflow = [], touchTargets = [], smallText = [];
    document.querySelectorAll("*").forEach(function(el) {
      if (el === document.documentElement || el === document.body) return;
      try {
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (overflow.length < 30 && (rect.right > vw + 1 || el.scrollWidth > el.clientWidth + 1)) overflow.push({ path: pathOf(el), tag: el.tagName.toLowerCase(), right: Math.round(rect.right), viewportWidth: vw });
        if (touchTargets.length < 30 && /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) { if (rect.width < 44 || rect.height < 44) touchTargets.push({ path: pathOf(el), width: Math.round(rect.width), height: Math.round(rect.height) }); }
        if (smallText.length < 30) { var fs = parseFloat(getComputedStyle(el).fontSize); if (fs > 0 && fs < 12 && el.textContent && el.textContent.trim()) smallText.push({ path: pathOf(el), fontSize: fs }); }
      } catch (e) {}
    });
    post("folio:responsive-result", { viewportWidth: vw, overflow: overflow, touchTargets: touchTargets, smallText: smallText });
  }

  function runEval(code) {
    try { var result = (0, eval)(code); post("folio:eval-result", { ok: true, value: serialize(result) }); }
    catch (e) { post("folio:eval-result", { ok: false, error: String(e && e.message || e), stack: (e && e.stack || "").slice(0, 1000) }); }
  }

  function runAssetsScan() {
    var out = { html: [], css: [], js: [], json: [], images: [], external: [] };
    function push(url, cat) {
      if (!url) return;
      var clean = String(url).replace(/^\\.?\\//, "").split("?")[0].split("#")[0];
      if (!clean) return;
      var isExt = /^https?:\\/\\//i.test(url) || /^\\/\\//.test(url);
      var entry = { url: clean, known: !isExt, kind: cat };
      if (isExt) out.external.push(entry);
      else (out[cat] || out.html).push(entry);
    }
    document.querySelectorAll("link[href]").forEach(function(n) {
      var h = n.getAttribute("href");
      if (/\\.css(\\?|#|$)/i.test(h)) push(h, "css");
      else if (/\\.(png|jpe?g|gif|webp|svg|ico|avif)(\\?|#|$)/i.test(h)) push(h, "images");
    });
    document.querySelectorAll("script[src]").forEach(function(n) {
      var s = n.getAttribute("src");
      if (/\\.js(\\?|#|$)/i.test(s)) push(s, "js");
    });
    document.querySelectorAll("img[src]").forEach(function(n) { push(n.getAttribute("src"), "images"); });
    document.querySelectorAll("style").forEach(function(st) {
      var text = st.textContent || "";
      text.replace(/url\\(\\s*["']?([^"')\\s]+)["']?\\s*\\)/gi, function(_, u) { push(u, "images"); return _; });
      text.replace(/@import\\s+(?:url\\()?["']([^"']+)["']/gi, function(_, u) { push(u, "css"); return _; });
    });
    post("folio:assets-result", out);
  }

  function getCssVars() {
    var style = getComputedStyle(document.documentElement);
    var vars = {};
    for (var i = 0; i < style.length; i++) {
      var prop = style[i];
      if (prop.startsWith("--")) vars[prop] = style.getPropertyValue(prop).trim();
    }
    post("folio:css-vars", { vars: vars });
  }
  function setCssVar(name, value) {
    document.documentElement.style.setProperty(name, value);
  }
  function getElementStyle(path) {
    try {
      var el = document.querySelector(path);
      if (!el) return post("folio:element-style", { error: "not found" });
      var cs = getComputedStyle(el);
      var props = {};
      ["color", "background-color", "font-size", "font-family", "font-weight", "line-height", "padding", "margin", "border", "border-radius", "display", "position", "width", "height", "opacity", "transform"].forEach(function(p) { props[p] = cs.getPropertyValue(p); });
      post("folio:element-style", { path: path, style: props });
    } catch (e) { post("folio:element-style", { error: String(e) }); }
  }

  // Heatmap tracking
  var _heatPoints = [];
  var _heatActive = false;
  document.addEventListener("click", function(e) {
    if (!_heatActive) return;
    _heatPoints.push({ x: e.clientX, y: e.clientY, t: Date.now() });
    if (_heatPoints.length >= 500) _heatPoints.shift();
    post("folio:heatmap-data", { points: _heatPoints });
  }, true);

  // Patch handler
  function applyPatch(path, content, kind) {
    if (kind === "css") {
      var styles = document.querySelectorAll("style");
      var target = null;
      for (var i = 0; i < styles.length; i++) {
        if (styles[i].getAttribute("data-folio-path") === path) { target = styles[i]; break; }
      }
      if (!target) { target = document.createElement("style"); target.setAttribute("data-folio-path", path); document.head.appendChild(target); }
      target.textContent = content;
    } else if (kind === "js") {
      try { (0, eval)(content); } catch (err) { post("folio:console", { level: "error", args: [{ kind: "string", value: "Patch eval error: " + err.message }], ts: Date.now() }); }
    } else if (kind === "html" || kind === "htm") {
      var parser = new DOMParser();
      var doc = parser.parseFromString(content, "text/html");
      document.body.innerHTML = doc.body.innerHTML;
    }
  }

  window.addEventListener("message", function(e) {
    if (!e.data || e.data.__folio !== true) return;
    var t = e.data.type;
    if (t === "folio:storage-snapshot") post("folio:storage-snapshot-result", { local: memLocal, session: memSession });
    else if (t === "folio:clear-storage") { Object.keys(memLocal).forEach(function(k) { delete memLocal[k]; }); Object.keys(memSession).forEach(function(k) { delete memSession[k]; }); post("folio:storage-snapshot-result", { local: memLocal, session: memSession }); }
    else if (t === "folio:dom-snapshot-request") { var budget = { count: 0 }; post("folio:dom-snapshot", { tree: serializeDOM(document.documentElement, 0, 8, budget) }); }
    else if (t === "folio:inspect-start") { _inspectActive = true; document.documentElement.style.cursor = "crosshair"; }
    else if (t === "folio:inspect-stop") { _inspectActive = false; document.documentElement.style.cursor = ""; hideOverlay(); }
    else if (t === "folio:highlight-element") highlightElement(e.data.path);
    else if (t === "folio:a11y-scan") runA11yScan();
    else if (t === "folio:responsive-scan") runResponsiveScan();
    else if (t === "folio:eval") runEval(e.data.code);
    else if (t === "folio:simulate-network") { _netConfig.latencyMs = Number(e.data.latencyMs) || 0; _netConfig.failureRate = Number(e.data.failureRate) || 0; }
    else if (t === "folio:reload") window.location.reload();
    else if (t === "folio:patch") applyPatch(e.data.path || "", e.data.content || "", e.data.kind || "");
    else if (t === "folio:assets-scan") runAssetsScan();
    else if (t === "folio:get-css-vars") getCssVars();
    else if (t === "folio:set-css-var") setCssVar(e.data.name, e.data.value);
    else if (t === "folio:get-element-style") getElementStyle(e.data.path);
    else if (t === "folio:start-heatmap") _heatActive = true;
    else if (t === "folio:stop-heatmap") { _heatActive = false; post("folio:heatmap-data", { points: [] }); _heatPoints = []; }
    else if (t === "folio:screenshot") {
      try {
        var html = document.documentElement.outerHTML;
        var w = e.data.width || window.innerWidth;
        var h = e.data.height || window.innerHeight;
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:' + w + 'px;height:' + h + 'px">' + html + '</div></foreignObject></svg>';
        var blob = new Blob([svg], { type: "image/svg+xml" });
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function() {
          var c = document.createElement("canvas"); c.width = w; c.height = h;
          var ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          post("folio:screenshot-data", { dataUrl: c.toDataURL("image/png") });
        };
        img.onerror = function() { post("folio:screenshot-data", { dataUrl: null }); };
        img.src = url;
      } catch (err) { post("folio:screenshot-data", { dataUrl: null }); }
    }
  });

  post("folio:ready", {});
})();
`;

// ─────────────────────────────────────────────────────────────────
//  RENDERERS (for non-HTML preview targets)
// ─────────────────────────────────────────────────────────────────
function renderMarkdownPreview(content) {
  // Minimal but functional markdown renderer
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let html = content;
  html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^\- (.*)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\n\n/g, '</p><p>');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:24px auto;padding:0 20px;color:#1a1a1a;background:#fff;line-height:1.65}
    h1,h2,h3{color:#111;margin-top:1.4em;margin-bottom:.5em;line-height:1.25}
    h1{font-size:2em;border-bottom:1px solid #eee;padding-bottom:.3em}
    h2{font-size:1.5em;border-bottom:1px solid #eee;padding-bottom:.3em}
    h3{font-size:1.2em}
    code{background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:ui-monospace,Menlo,monospace;font-size:.9em}
    pre{background:#18181b;color:#e4e4e7;padding:14px;border-radius:6px;overflow-x:auto}
    pre code{background:transparent;color:inherit;padding:0}
    ul{padding-left:1.5em}
    a{color:#0066cc}
    blockquote{border-left:3px solid #ddd;padding-left:1em;color:#666;margin:1em 0}
    table{border-collapse:collapse;width:100%;margin:1em 0}
    th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
    th{background:#f4f4f5}
    img{max-width:100%;height:auto}
  </style></head><body><p>${html}</p></body></html>`;
}

function renderJsonPreview(content) {
  let formatted;
  try { formatted = JSON.stringify(JSON.parse(content), null, 2); } catch { formatted = content; }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:13px;background:#0d1117;color:#c9d1d9;padding:20px;line-height:1.6;margin:0}
    pre{margin:0;white-space:pre-wrap;word-break:break-word}
    .k{color:#79c0ff}.s{color:#a5d6ff}.n{color:#79c0ff}.b{color:#d2a8ff}.z{color:#8b949e;font-style:italic}
  </style></head><body><pre id="root"></pre><script>
    var data = ${JSON.stringify(formatted)};
    function hl(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/"([^"\\\\]|\\\\.)*"(?=\\s*:)/g, function(m){ return '<span class="k">'+m+'</span>'; })
        .replace(/"([^"\\\\]|\\\\.)*"/g, function(m){ return '<span class="s">'+m+'</span>'; })
        .replace(/\\b(true|false)\\b/g, '<span class="b">$1</span>')
        .replace(/\\bnull\\b/g, '<span class="z">null</span>')
        .replace(/:\\s*(-?\\d+\\.?\\d*)/g, ': <span class="n">$1</span>');
    }
    document.getElementById('root').innerHTML = hl(data);
  <\/script></body></html>`;
}

function renderCsvPreview(content) {
  const rows = content.split('\n').filter(r => r.trim()).map(r => r.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
  const header = rows[0] || [];
  const body = rows.slice(1);
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{font-family:system-ui,sans-serif;background:#fff;color:#1a1a1a;padding:16px;font-size:13px;margin:0}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #e5e7eb;padding:6px 10px;text-align:left;font-size:12px}
    th{background:#f9fafb;font-weight:700;position:sticky;top:0}
    tr:nth-child(even) td{background:#fafafa}
  </style></head><body><table><thead><tr>${header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
}

function renderSvgPreview(content) {
  return `<!DOCTYPE html><html><head><style>body{margin:0;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}</style></head><body>${content}</body></html>`;
}

function renderTextPreview(content) {
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:13px;background:#fafafa;color:#1a1a1a;padding:16px;line-height:1.5;margin:0}
    pre{white-space:pre-wrap;word-break:break-word;margin:0}
  </style></head><body><pre>${esc(content)}</pre></body></html>`;
}

function renderPdfPreview(content) {
  return `<!DOCTYPE html><html><head><style>body{margin:0;height:100vh;overflow:hidden}embed{width:100%;height:100%;border:none}</style></head><body><embed src="${content}" type="application/pdf"></body></html>`;
}

function renderImagePreview(content) {
  return `<!DOCTYPE html><html><head><style>body{margin:0;background:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:100vh}img{max-width:100%;max-height:100vh;object-fit:contain}</style></head><body><img src="${content}"></body></html>`;
}

function pickRenderer(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = { md: renderMarkdownPreview, markdown: renderMarkdownPreview, json: renderJsonPreview, csv: renderCsvPreview, svg: renderSvgPreview, txt: renderTextPreview, log: renderTextPreview, pdf: renderPdfPreview, png: renderImagePreview, jpg: renderImagePreview, jpeg: renderImagePreview, gif: renderImagePreview, webp: renderImagePreview };
  return map[ext] || null;
}

// ─────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────
const ST = {
  options: null,
  hooks: {},
  rootEl: null,
  overlayEl: null,
  iframeEl: null,
  stageEl: null,
  frameEl: null,
  dockEl: null,
  sectionsEl: null,
  bridgeReady: false,
  isCrossOrigin: false,
  openSections: new Set(),
  pinnedSections: new Set(),
  fullscreen: false,
  source: { kind: "project", file: null, url: null },
  sizer: { mode: "fit", device: "phone", custom: { w: 768, h: 1024 }, rotated: false, scale: 1, pid: null },
  pid: null,
  projectName: null,
  activeFile: null,
  fileOptions: [],
  console: { entries: [], filter: "all", query: "", expanded: new Set(), nextId: 1 },
  network: { entries: [], filter: "all", expanded: new Set(), nextId: 1, waterfallExpanded: false },
  vitals: { lcp: null, fcp: null, cls: null },
  resources: [],
  layoutShifts: [],
  a11y: { issues: null, scanning: false },
  responsive: { result: null, scanning: false },
  dom: { tree: null, expanded: new Set(), loading: false, inspectActive: false, selectedPath: null, selectedElement: null, search: "" },
  storage: { local: {}, session: {}, loaded: false },
  files: { loaded: [], skipped: [] },
  assets: { html: [], css: [], js: [], json: [], images: [], external: [], scanning: false },
  devtools: { latencyMs: 0, failureRate: 0, throttlePreset: "none" },
  editorConsole: { history: [] },
  search: { query: "", useRegex: false, caseSensitive: false, results: [], matches: [] },
  cssVars: {},
  heatmap: { active: false, points: [] },
  settings: { ...DEFAULT_SETTINGS },
  layouts: [],
  history: [],
  recording: { active: false, startedAt: 0, events: [] },
  palette: { open: false, query: "", activeIndex: 0 },
  devEditor: { open: false, overlay: null, view: null, activeFile: null, dirty: false, autoApply: true, splitFiles: [] },
  dialog: { el: null, backdropEl: null, open: false },
  annotator: { el: null, canvas: null, ctx: null, img: null, tool: "box", color: "#F59E0B", drawing: false, startX: 0, startY: 0, annotations: [] },
  _events: new Map(),
};

// ─────────────────────────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset" && typeof v === "object") Object.assign(node.dataset, v);
    else if (k === "html") node.innerHTML = v;
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return node;
}

function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function throttle(fn, ms) { let last = 0; return (...a) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...a); } }; }

function svgIcon(name) {
  const icons = {
    warn: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    ruler: '<path d="M21.3 8.7l-12-12a1 1 0 0 0-1.4 0L2.7 4.9a1 1 0 0 0 0 1.4l12 12a1 1 0 0 0 1.4 0l5.2-5.2a1 1 0 0 0 0-1.4z"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    chevronDown: '<polyline points="6 9 12 15 18 9"/>',
    chevronRight: '<polyline points="9 18 15 12 9 6"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    crosshair: '<circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    wifiOff: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>',
    expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    collapse: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
    bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    filePlus: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
    rotate: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    devices: '<rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
    snippets: '<path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><polyline points="8 8 12 12 8 16"/><line x1="12" y1="16" x2="16" y2="16"/>',
    layouts: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="12" y1="12" x2="15" y2="15"/>',
    record: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
    arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
    blur: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
    externalLink: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    diff: '<line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 9 4 13 8 17"/><polyline points="16 9 20 13 16 17"/>',
    lightning: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    palette2: '<circle cx="12" cy="12" r="10"/>',
    more: '<circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/><circle cx="5" cy="12" r="1.5" fill="currentColor"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
    tablet: '<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
    laptop: '<rect x="3" y="4" width="18" height="12" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/><line x1="8" y1="20" x2="16" y2="20"/>',
    customSize: '<path d="M21 3H3v18h18V3z"/><path d="M21 12H3"/><path d="M12 3v18"/>',
    chevronUp: '<polyline points="18 15 12 9 6 15"/>',
    panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>',
  };
  const body = icons[name] || icons.info;
  return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style="display:block">${body}</svg>`;
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(2) + "s";
}
function fmtBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"]; let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + " " + u[i];
}
function fmtTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, "0")).join(":");
}

function toast(msg, type = "info", duration) {
  const d = duration ?? (type === "error" || type === "warning" ? 4500 : 3000);
  const container = ensureToastContainer();
  const iconName = type === "success" ? "check" : type === "error" ? "alert" : type === "warning" ? "alert" : "info";
  const node = el("div", { class: `fp-toast ${type}` },
    el("span", { class: "fp-toast-icon", html: svgIcon(iconName) }),
    el("span", { class: "fp-toast-msg" }, msg)
  );
  container.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(() => { node.classList.remove("show"); setTimeout(() => node.remove(), 300); }, d);
}

function ensureToastContainer() {
  let c = document.getElementById("fpToasts");
  if (!c) { c = el("div", { class: "fp-toasts", id: "fpToasts" }); document.body.appendChild(c); }
  return c;
}

async function copyToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
  } catch { return false; }
}

function postToChild(type, payload = {}) {
  if (!ST.iframeEl?.contentWindow) return;
  try { ST.iframeEl.contentWindow.postMessage(Object.assign({ __folio: true, type }, payload), "*"); } catch {}
}

function emit(event, detail) {
  const set = ST._events.get(event);
  if (set) for (const cb of set) { try { cb(detail); } catch {} }
}
function on(event, cb) { if (!ST._events.has(event)) ST._events.set(event, new Set()); ST._events.get(event).add(cb); return () => off(event, cb); }
function off(event, cb) { ST._events.get(event)?.delete(cb); }

// ─────────────────────────────────────────────────────────────────
//  STYLES INJECTION
// ─────────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById("folio-preview-styles")) return;
  const style = document.createElement("style");
  style.id = "folio-preview-styles";
  style.textContent = PREVIEW_CSS;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────────────
//  SETTINGS LOAD/SAVE
// ─────────────────────────────────────────────────────────────────
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS.settings);
    if (raw) Object.assign(ST.settings, JSON.parse(raw));
  } catch {}
  applySettings();
}
function saveSettings() {
  try { localStorage.setItem(LS.settings, JSON.stringify(ST.settings)); } catch {}
  applySettings();
}
function applySettings() {
  const s = ST.settings;
  document.documentElement.style.setProperty("--fp-speed", String(s.animationSpeed || 1));
  if (s.reducedMotion === "true") document.documentElement.setAttribute("data-reduced-motion", "true");
  else if (s.reducedMotion === "false") document.documentElement.removeAttribute("data-reduced-motion");
  else document.documentElement.removeAttribute("data-reduced-motion");

  // Theme
  let theme = s.theme || "auto";
  if (theme === "auto") {
    theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);
  ST.overlayEl?.setAttribute("data-theme", theme);

  // Dock position
  const isRight = s.dockPosition === "right";
  ST.overlayEl?.setAttribute("data-dock-right", isRight ? "true" : "false");
  if (ST.dockEl) {
    ST.dockEl.style.height = isRight ? "auto" : "";
  }

  ST.overlayEl?.setAttribute("data-ruler", s.showBreakpointRuler ? "true" : "false");
  if (ST.devtools) ST.devtools.throttlePreset = s.throttlePreset;

  // Apply throttle if bridge ready
  if (ST.bridgeReady && s.throttlePreset && THROTTLE_PRESETS[s.throttlePreset]) {
    postToChild(REQ.SIMULATE_NETWORK, THROTTLE_PRESETS[s.throttlePreset]);
  }
}

// ─────────────────────────────────────────────────────────────────
//  OVERLAY BUILD
// ─────────────────────────────────────────────────────────────────
function buildOverlay(rootEl) {
  rootEl.innerHTML = "";
  const overlay = el("div", { class: "fp-overlay", "data-open": "false", id: "fpOverlay" });

  // Header
  const header = el("div", { class: "fp-header" });
  const sizeIconMap = { fit: "fit", phone: "phone", tablet: "tablet", laptop: "laptop", custom: "customSize" };
  const sizeTitleMap = { fit: "Fit", phone: "Phone", tablet: "Tablet", laptop: "Laptop", custom: "Custom" };
  header.innerHTML = `
    <div class="fp-size-bar" id="fpSizeBar">
      ${SIZE_QUICK.map(s => `<button class="fp-size-btn${s === "fit" ? " active" : ""}" data-size="${s}" type="button" title="${sizeTitleMap[s]}" aria-label="${sizeTitleMap[s]}">${svgIcon(sizeIconMap[s])}</button>`).join("")}
    </div>
    <div class="fp-dims" id="fpDims" hidden>
      <input type="number" id="fpDimsW" min="${CUSTOM_MIN.w}" max="${CUSTOM_MAX.w}" aria-label="Width">
      <span>×</span>
      <input type="number" id="fpDimsH" min="${CUSTOM_MIN.h}" max="${CUSTOM_MAX.h}" aria-label="Height">
    </div>
    <div class="fp-acts">
      <div class="fp-more-wrap" id="fpMoreWrap">
        <button class="fp-btn icon" id="fpBtnMore" type="button" title="More actions" aria-label="More actions" aria-haspopup="true" aria-expanded="false">${svgIcon("more")}</button>
        <div class="fp-more-menu" id="fpMoreMenu" data-open="false" role="menu">
          <button class="fp-more-item" data-more-action="source" type="button" role="menuitem">${svgIcon("globe")}<span>Source</span></button>
          <button class="fp-more-item" data-more-action="devices" type="button" role="menuitem">${svgIcon("devices")}<span>Devices</span></button>
          <button class="fp-more-item" data-more-action="rotate" type="button" role="menuitem">${svgIcon("rotate")}<span>Rotate</span></button>
          <button class="fp-more-item" data-more-action="screenshot" type="button" role="menuitem">${svgIcon("camera")}<span>Screenshot</span></button>
          <button class="fp-more-item" data-more-action="refresh" type="button" role="menuitem">${svgIcon("refresh")}<span>Refresh</span></button>
          <div class="fp-more-sep"></div>
          <button class="fp-more-item" data-more-action="deveditor" type="button" role="menuitem">${svgIcon("code")}<span>Live editor</span></button>
          <button class="fp-more-item" data-more-action="history" type="button" role="menuitem">${svgIcon("history")}<span>History</span></button>
          <button class="fp-more-item" data-more-action="settings" type="button" role="menuitem">${svgIcon("settings")}<span>Settings</span></button>
          <button class="fp-more-item" data-more-action="palette" type="button" role="menuitem">${svgIcon("search")}<span>Commands</span></button>
        </div>
      </div>
      <span class="fp-acts-spacer" aria-hidden="true"></span>
      <button class="fp-btn icon" id="fpBtnFullscreen" type="button" title="Fullscreen (F)" aria-label="Fullscreen">${svgIcon("expand")}</button>
      <button class="fp-btn icon" id="fpBtnClose" type="button" title="Close (Esc)" aria-label="Close">${svgIcon("x")}</button>
    </div>
  `;
  overlay.appendChild(header);

  // Stage
  const stageWrap = el("div", { class: "fp-stage-wrap", id: "fpStageWrap" });
  const ruler = el("div", { class: "fp-ruler", id: "fpRuler" });
  const stage = el("div", { class: "fp-stage", id: "fpStage" });
  const frame = el("div", { class: "fp-frame", "data-device": "false", "data-mode": "fit", "data-rotated": "false", id: "fpFrame" });
  const iframe = el("iframe", { id: "fpIframe", sandbox: "allow-scripts allow-forms allow-modals allow-popups allow-same-origin" });
  const heatmap = el("div", { class: "fp-heatmap", id: "fpHeatmap" });
  frame.appendChild(iframe);
  frame.appendChild(heatmap);
  frame.appendChild(el("div", { class: "fp-resize", "data-corner": "br", id: "fpResizeBR", tabindex: "0", role: "slider", "aria-label": "Resize" }));
  frame.appendChild(el("div", { class: "fp-resize", "data-corner": "tl", id: "fpResizeTL", tabindex: "0", role: "slider", "aria-label": "Resize" }));
  frame.appendChild(el("div", { class: "fp-readout", id: "fpReadout" }));
  stage.appendChild(frame);
  const loading = el("div", { class: "fp-loading", id: "fpLoading", "data-show": "false", "aria-hidden": "true" });
  loading.innerHTML = `<div class="fp-loading-spinner"></div><div class="fp-loading-text">Loading preview…</div>`;
  stageWrap.appendChild(ruler);
  stageWrap.appendChild(stage);
  stageWrap.appendChild(loading);
  overlay.appendChild(stageWrap);

  // Fullscreen exit button (visible only in focus/fullscreen mode)
  const fsExit = el("button", { class: "fp-fs-exit", id: "fpFsExit", type: "button", title: "Exit focus view (F or Esc)", "aria-label": "Exit focus view" });
  fsExit.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>`;
  overlay.appendChild(fsExit);

  // Dock
  const dock = el("div", { class: "fp-dock", "data-expanded": "false", id: "fpDock" });
  dock.innerHTML = `
    <div class="fp-dock-bar" id="fpDockBar">
      <div class="fp-dock-tabs" id="fpDockTabs" role="tablist" aria-label="Inspector sections"></div>
      <button class="fp-btn icon fp-dock-toggle" id="fpDockToggle" type="button" title="Expand panel" aria-label="Expand panel" aria-expanded="false">${svgIcon("chevronUp")}</button>
    </div>
    <div class="fp-sections" id="fpSections"></div>
  `;
  overlay.appendChild(dock);

  rootEl.appendChild(overlay);
  ST.overlayEl = overlay;
  ST.iframeEl = iframe;
  ST.stageEl = stage;
  ST.frameEl = frame;
  ST.dockEl = dock;
  ST.sectionsEl = $("#fpSections", overlay);
}

// ─────────────────────────────────────────────────────────────────
//  SECTIONS REGISTRY
// ─────────────────────────────────────────────────────────────────
const SECTIONS = [
  { id: "console",     icon: "warn",     title: "Console",         shortcut: "1" },
  { id: "network",     icon: "globe",    title: "Network",         shortcut: "2" },
  { id: "assets",      icon: "file",     title: "Assets & deps",   shortcut: "3" },
  { id: "responsive",  icon: "ruler",    title: "Responsive",      shortcut: "4" },
  { id: "performance", icon: "zap",      title: "Performance",     shortcut: "5" },
  { id: "files",       icon: "folder",   title: "Files",           shortcut: "6" },
  { id: "storage",     icon: "database", title: "Storage",         shortcut: "7" },
  { id: "inspector",   icon: "crosshair", title: "Inspector",      shortcut: "i" },
  { id: "dom",         icon: "code",     title: "DOM",             shortcut: "8" },
  { id: "a11y",        icon: "shield",   title: "Accessibility",   shortcut: "9" },
  { id: "devtools",    icon: "tool",     title: "Dev tools",       shortcut: "0" },
  { id: "editor",      icon: "terminal", title: "Editor console" },
  { id: "search",      icon: "search",   title: "Search" },
];

function buildSections() {
  const wrap = ST.sectionsEl;
  const tabs = $("#fpDockTabs");
  wrap.innerHTML = "";
  if (tabs) tabs.innerHTML = "";

  for (const sec of SECTIONS) {
    // horizontal tab
    if (tabs) {
      const tab = el("button", {
        class: "fp-dock-tab",
        type: "button",
        role: "tab",
        title: sec.title,
        "aria-label": sec.title,
        "data-section-tab": sec.id,
        "data-active": "false",
      });
      tab.innerHTML = svgIcon(sec.icon);
      tab.addEventListener("click", () => {
        const wasOpen = ST.openSections.has(sec.id) && ST.dockEl.getAttribute("data-expanded") === "true";
        if (wasOpen) {
          closeSection(sec.id);
          setDockExpanded(false);
        } else {
          // single-active section
          [...ST.openSections].forEach(id => closeSection(id));
          setDockExpanded(true);
          openSection(sec.id);
        }
        syncDockTabs();
      });
      tabs.appendChild(tab);
    }

    const section = el("section", { class: "fp-sec", "data-section": sec.id, "data-open": "false" });
    section.innerHTML = `
      <div class="fp-sec-body"><div class="fp-sec-body-inner" data-body="${sec.id}"></div></div>
    `;
    wrap.appendChild(section);
  }

  const toggle = $("#fpDockToggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const expanded = ST.dockEl.getAttribute("data-expanded") === "true";
      if (expanded) {
        [...ST.openSections].forEach(id => closeSection(id));
        setDockExpanded(false);
      } else {
        setDockExpanded(true);
        const first = SECTIONS[0]?.id;
        if (first && ST.openSections.size === 0) openSection(first);
      }
      syncDockTabs();
    });
  }

  // restore open sections
  try {
    const raw = localStorage.getItem(LS.openSecs);
    if (raw) {
      const ids = JSON.parse(raw);
      if (ids.length) {
        setDockExpanded(true);
        openSection(ids[0], true);
      }
    }
  } catch {}
  syncDockTabs();
}

function setDockExpanded(on) {
  ST.dockEl.setAttribute("data-expanded", on ? "true" : "false");
  const toggle = $("#fpDockToggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", on ? "true" : "false");
    toggle.title = on ? "Collapse panel" : "Expand panel";
    toggle.setAttribute("aria-label", on ? "Collapse panel" : "Expand panel");
  }
}

function syncDockTabs() {
  const expanded = ST.dockEl?.getAttribute("data-expanded") === "true";
  $$("[data-section-tab]").forEach(tab => {
    const id = tab.dataset.sectionTab;
    tab.setAttribute("data-active", expanded && ST.openSections.has(id) ? "true" : "false");
  });
}

function toggleSection(id) {
  if (ST.openSections.has(id) && !ST.pinnedSections.has(id)) closeSection(id);
  else openSection(id);
}

function openSection(id, silent = false) {
  // only one section at a time in tab mode
  for (const other of [...ST.openSections]) {
    if (other !== id) {
      ST.openSections.delete(other);
      const sec = ST.sectionsEl.querySelector(`[data-section="${other}"]`);
      if (sec) sec.setAttribute("data-open", "false");
    }
  }
  if (!ST.openSections.has(id)) ST.openSections.add(id);
  setDockExpanded(true);
  const sec = ST.sectionsEl.querySelector(`[data-section="${id}"]`);
  if (sec) sec.setAttribute("data-open", "true");
  renderSection(id);
  updateSectionMeta();
  syncDockTabs();
  if (!silent) {
    try { localStorage.setItem(LS.openSecs, JSON.stringify([...ST.openSections])); } catch {}
    emit("section", id);
  }
}

function closeSection(id) {
  ST.openSections.delete(id);
  const sec = ST.sectionsEl.querySelector(`[data-section="${id}"]`);
  if (sec) sec.setAttribute("data-open", "false");
  if (ST.openSections.size === 0) setDockExpanded(false);
  syncDockTabs();
  try { localStorage.setItem(LS.openSecs, JSON.stringify([...ST.openSections])); } catch {}
}

function togglePinSection(id) {
  if (ST.pinnedSections.has(id)) ST.pinnedSections.delete(id);
  else ST.pinnedSections.add(id);
  const btn = ST.sectionsEl.querySelector(`[data-pin-section="${id}"]`);
  if (btn) btn.setAttribute("data-pinned", ST.pinnedSections.has(id) ? "true" : "false");
  if (ST.pinnedSections.has(id)) openSection(id);
}

function renderSection(id) {
  const body = ST.sectionsEl.querySelector(`[data-body="${id}"]`);
  if (!body) return;
  switch (id) {
    case "console":     renderConsole(body); break;
    case "network":     renderNetwork(body); break;
    case "assets":      renderAssets(body); break;
    case "responsive":  renderResponsive(body); break;
    case "performance": renderPerformance(body); break;
    case "files":       renderFiles(body); break;
    case "storage":     renderStorage(body); break;
    case "inspector":   renderInspector(body); break;
    case "dom":         renderDOM(body); break;
    case "a11y":        renderA11y(body); break;
    case "devtools":    renderDevTools(body); break;
    case "editor":      renderEditorConsole(body); break;
    case "search":      renderSearchSection(body); break;
  }
  updateSectionMeta();
}

function updateSectionMeta() {
  const setMeta = (id, html) => { const m = ST.sectionsEl.querySelector(`[data-meta="${id}"]`); if (m) m.innerHTML = html; };

  const c = ST.console;
  const cErr = c.entries.filter(e => e.level === "error").length;
  const cWarn = c.entries.filter(e => e.level === "warn").length;
  if (c.entries.length === 0) setMeta("console", "No messages");
  else {
    const parts = [];
    if (cErr) parts.push(`<span class="err">${cErr} err</span>`);
    if (cWarn) parts.push(`<span class="warn">${cWarn} warn</span>`);
    if (!parts.length) parts.push(`${c.entries.length} msg`);
    setMeta("console", parts.join(" · "));
  }

  const n = ST.network;
  const nFail = n.entries.filter(e => e.error || e.status >= 400).length;
  if (n.entries.length === 0) setMeta("network", "");
  else { const parts = [`${n.entries.length} req`]; if (nFail) parts.push(`<span class="err">${nFail} fail</span>`); setMeta("network", parts.join(" · ")); }

  const a = ST.assets;
  const aCount = (a.html?.length || 0) + (a.css?.length || 0) + (a.js?.length || 0) + (a.json?.length || 0) + (a.images?.length || 0) + (a.external?.length || 0);
  setMeta("assets", aCount > 0 ? `${aCount} dep` : "");

  const r = ST.responsive.result;
  const rTotal = r ? (r.overflow?.length || 0) + (r.touchTargets?.length || 0) + (r.smallText?.length || 0) : 0;
  setMeta("responsive", r ? (rTotal > 0 ? `<span class="warn">${rTotal} issue</span>` : "OK") : "Not scanned");

  const v = ST.vitals;
  if (v.lcp != null || v.fcp != null) {
    const parts = [];
    if (v.lcp != null) parts.push(`LCP ${fmtDuration(v.lcp)}`);
    if (v.fcp != null) parts.push(`FCP ${fmtDuration(v.fcp)}`);
    setMeta("performance", parts.join(" · "));
  } else setMeta("performance", "Measuring…");

  const loaded = ST.files.loaded.length;
  const skipped = ST.files.skipped.length;
  if (loaded > 0) { const parts = [`${loaded} loaded`]; if (skipped) parts.push(`${skipped} skipped`); setMeta("files", parts.join(" · ")); }
  else setMeta("files", "");

  const storCount = Object.keys(ST.storage.local || {}).length + Object.keys(ST.storage.session || {}).length;
  setMeta("storage", storCount > 0 ? `${storCount} key` : "");

  setMeta("dom", ST.dom.inspectActive ? "Inspect active" : "");

  const a11yIssues = ST.a11y.issues ? ST.a11y.issues.length : null;
  setMeta("a11y", a11yIssues != null ? (a11yIssues > 0 ? `<span class="warn">${a11yIssues} issue</span>` : "OK") : "Not scanned");

  setMeta("devtools", ST.devtools.throttlePreset !== "none" ? ST.devtools.throttlePreset : "");

  const ecCount = ST.editorConsole.history.filter(x => x.kind === "input").length;
  setMeta("editor", ecCount > 0 ? `${ecCount} cmd` : "");

  setMeta("search", ST.search.matches.length ? `${ST.search.matches.length} hits` : "");

  // badge dock tabs
  const badge = (id, n) => {
    const tab = document.querySelector(`[data-section-tab="${id}"]`);
    if (!tab) return;
    let b = tab.querySelector(".fp-dock-tab-badge");
    if (!n) { b?.remove(); return; }
    if (!b) { b = document.createElement("span"); b.className = "fp-dock-tab-badge"; tab.appendChild(b); }
    b.textContent = n > 9 ? "9+" : String(n);
  };
  badge("console", ST.console.entries.filter(e => e.level === "error").length);
  badge("network", ST.network.entries.filter(e => e.error || (e.status >= 400)).length);
  badge("a11y", (ST.a11y.issues || []).filter(x => x.severity === "error").length);

}

// ─────────────────────────────────────────────────────────────────
//  SECTION: CONSOLE
// ─────────────────────────────────────────────────────────────────
function renderConsole(body) {
  const c = ST.console;
  const filtered = filterConsoleEntries();
  body.innerHTML = `
    <div class="fp-toolbar">
      <input type="search" id="fpConsoleSearch" placeholder="Filter…" value="${escapeHtml(c.query)}">
      <button class="fp-chip ${c.filter === "all" ? "active" : ""}" data-filter="all" type="button">All</button>
      <button class="fp-chip ${c.filter === "error" ? "active" : ""}" data-filter="error" type="button">Errors</button>
      <button class="fp-chip ${c.filter === "warn" ? "active" : ""}" data-filter="warn" type="button">Warns</button>
      <button class="fp-chip ${c.filter === "log" ? "active" : ""}" data-filter="log" type="button">Logs</button>
      <button class="fp-chip danger" id="fpConsoleClear" type="button">${svgIcon("trash")} Clear</button>
      <button class="fp-chip" id="fpConsoleExport" type="button">${svgIcon("download")}</button>
    </div>
    <div class="fp-console-list" id="fpConsoleList"></div>
    <div class="fp-console-repl">
      <span class="fp-console-repl-prompt">&gt;</span>
      <input type="text" id="fpConsoleRepl" placeholder="Run JavaScript in the preview…" autocomplete="off" spellcheck="false">
    </div>
    <div id="fpConsoleReplResult"></div>
  `;
  const listEl = $("#fpConsoleList", body);
  renderConsoleEntries(listEl, filtered);
  const search = $("#fpConsoleSearch", body);
  search.addEventListener("input", debounce(() => { c.query = search.value; renderConsoleEntries(listEl, filterConsoleEntries()); }, 120));
  body.querySelectorAll("[data-filter]").forEach(chip => chip.addEventListener("click", () => {
    c.filter = chip.dataset.filter;
    body.querySelectorAll("[data-filter]").forEach(ch => ch.classList.toggle("active", ch === chip));
    renderConsoleEntries(listEl, filterConsoleEntries());
  }));
  $("#fpConsoleClear", body).addEventListener("click", () => { c.entries = []; c.expanded.clear(); renderConsoleEntries(listEl, []); updateSectionMeta(); });
  $("#fpConsoleExport", body).addEventListener("click", async () => {
    const data = c.entries.map(e => ({ level: e.level, time: fmtTime(e.ts), file: e.file, line: e.line, args: e.args })).map(e => JSON.stringify(e)).join('\n');
    if (await copyToClipboard(data)) toast("Console exported", "success"); else toast("Copy failed", "error");
  });
  const repl = $("#fpConsoleRepl", body);
  const replResult = $("#fpConsoleReplResult", body);
  repl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !repl.value.trim()) return;
    const code = repl.value.trim();
    repl.value = "";
    if (!ST.bridgeReady) { replResult.innerHTML = `<div class="fp-console-repl-result" data-ok="false">Bridge not ready</div>`; return; }
    c.entries.push({ id: c.nextId++, level: "log", args: [{ kind: "string", value: "> " + code }], ts: Date.now(), file: null, line: null });
    renderConsoleEntries(listEl, filterConsoleEntries());
    postToChild(REQ.EVAL, { code });
  });
}

function filterConsoleEntries() {
  const c = ST.console;
  let list = c.entries;
  if (c.filter !== "all") list = list.filter(e => e.level === c.filter);
  if (c.query) { const q = c.query.toLowerCase(); list = list.filter(e => { try { return JSON.stringify(e.args).toLowerCase().includes(q); } catch { return false; } }); }
  return list;
}

function renderConsoleEntries(container, entries) {
  container.innerHTML = "";
  if (!entries.length) { container.innerHTML = `<div class="fp-empty"><div class="fp-empty-icon">${svgIcon("info")}</div><strong>No console output</strong>Logs, warnings, and errors appear here.</div>`; return; }
  for (const entry of entries) container.appendChild(renderConsoleEntry(entry));
  if (ST.settings.consoleAutoScroll) { const wrap = container.closest(".fp-sec-body"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
}

function renderConsoleEntry(entry) {
  const row = el("div", { class: "fp-console-entry", "data-level": entry.level });
  const iconSvg = entry.level === "error" ? svgIcon("alert") : entry.level === "warn" ? svgIcon("warn") : svgIcon("info");
  row.appendChild(el("span", { class: "fp-console-icon", html: iconSvg }));
  const meta = el("span", { class: "fp-console-meta" });
  meta.appendChild(document.createTextNode(fmtTime(entry.ts) + " "));
  if (entry.file) {
    const fileSpan = el("span", { class: "fp-file" });
    fileSpan.textContent = entry.file + (entry.line ? ":" + entry.line : "");
    fileSpan.addEventListener("click", () => { if (typeof ST.hooks.onOpenFile === "function") ST.hooks.onOpenFile(entry.file.replace(/^\//, ""), entry.line || null); });
    meta.appendChild(fileSpan);
    meta.appendChild(document.createTextNode(" "));
  }
  row.appendChild(meta);
  const args = el("div", { class: "fp-console-args" });
  for (const arg of entry.args || []) args.appendChild(renderConsoleArg(arg, entry.id));
  row.appendChild(args);
  return row;
}

function renderConsoleArg(arg, entryId, keyPath = "") {
  const span = el("span", { class: "fp-console-arg", "data-kind": arg.kind || "object" });
  const id = `${entryId}:${keyPath || Math.random()}`;
  if (arg.kind === "string") { span.textContent = `"${arg.value}"`; return span; }
  if (arg.kind === "number" || arg.kind === "boolean") { span.textContent = String(arg.value); return span; }
  if (arg.kind === "null") { span.textContent = "null"; return span; }
  if (arg.kind === "undefined") { span.textContent = "undefined"; return span; }
  if (arg.kind === "function") { span.textContent = "ƒ " + (arg.value || ""); return span; }
  if (arg.kind === "symbol") { span.textContent = arg.value; return span; }
  if (arg.kind === "date" || arg.kind === "regexp") { span.textContent = arg.value; return span; }
  if (arg.kind === "element" || arg.kind === "node") { span.textContent = "<" + arg.preview + ">"; return span; }
  if (arg.kind === "error") { span.textContent = arg.name + ": " + arg.message; if (arg.stack) span.title = arg.stack; return span; }
  if (arg.kind === "array") {
    const isExpanded = ST.console.expanded.has(id);
    span.textContent = isExpanded ? `Array(${arg.length}) [` : `Array(${arg.length}) [ … ]`;
    span.addEventListener("click", (e) => { e.stopPropagation(); if (isExpanded) ST.console.expanded.delete(id); else ST.console.expanded.add(id); const body = ST.sectionsEl.querySelector(`[data-body="console"]`); if (body) renderConsole(body); });
    if (isExpanded) {
      const nested = el("div", { class: "fp-console-nested", "data-expanded": "true" });
      (arg.items || []).forEach((item, i) => { const row = el("div", { class: "fp-console-nested-row" }); row.appendChild(el("span", { class: "fp-nk", style: "color:#8a919c" }, String(i))); row.appendChild(renderConsoleArg(item, entryId, keyPath + "." + i)); nested.appendChild(row); });
      const wrap = el("span"); wrap.appendChild(span); wrap.appendChild(nested); return wrap;
    }
    return span;
  }
  if (arg.kind === "object") {
    const isExpanded = ST.console.expanded.has(id);
    const label = arg.constructor && arg.constructor !== "Object" ? arg.constructor : "{…}";
    span.textContent = isExpanded ? label + " {" : label + " { … }";
    span.addEventListener("click", (e) => { e.stopPropagation(); if (isExpanded) ST.console.expanded.delete(id); else ST.console.expanded.add(id); const body = ST.sectionsEl.querySelector(`[data-body="console"]`); if (body) renderConsole(body); });
    if (isExpanded && arg.entries) {
      const nested = el("div", { class: "fp-console-nested", "data-expanded": "true" });
      for (const entry of arg.entries) { const row = el("div", { class: "fp-console-nested-row" }); row.appendChild(el("span", { class: "fp-nk" }, entry.key)); row.appendChild(renderConsoleArg(entry.value, entryId, keyPath + "." + entry.key)); nested.appendChild(row); }
      const wrap = el("span"); wrap.appendChild(span); wrap.appendChild(nested); return wrap;
    }
    return span;
  }
  span.textContent = String(arg.value ?? arg.preview ?? "");
  return span;
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: NETWORK
// ─────────────────────────────────────────────────────────────────
function renderNetwork(body) {
  const n = ST.network;
  let filtered = n.entries;
  if (n.filter === "2xx") filtered = filtered.filter(e => e.status >= 200 && e.status < 300);
  else if (n.filter === "4xx") filtered = filtered.filter(e => e.status >= 400 && e.status < 500);
  else if (n.filter === "5xx") filtered = filtered.filter(e => e.status >= 500);
  else if (n.filter === "error") filtered = filtered.filter(e => e.error);

  body.innerHTML = `
    <div class="fp-toolbar">
      <button class="fp-chip ${n.filter === "all" ? "active" : ""}" data-net-filter="all" type="button">All</button>
      <button class="fp-chip ${n.filter === "2xx" ? "active" : ""}" data-net-filter="2xx" type="button">2xx</button>
      <button class="fp-chip ${n.filter === "4xx" ? "active" : ""}" data-net-filter="4xx" type="button">4xx</button>
      <button class="fp-chip ${n.filter === "5xx" ? "active" : ""}" data-net-filter="5xx" type="button">5xx</button>
      <button class="fp-chip ${n.filter === "error" ? "active" : ""}" data-net-filter="error" type="button">Failed</button>
      <button class="fp-chip" id="fpNetWaterfall" type="button">${n.waterfallExpanded ? "Hide" : "Show"} waterfall</button>
      <button class="fp-chip danger" id="fpNetClear" type="button">${svgIcon("trash")}</button>
    </div>
    <div class="fp-net-list" id="fpNetList"></div>
    <div id="fpNetWaterfallWrap"></div>
  `;
  const listEl = $("#fpNetList", body);
  if (!filtered.length) listEl.innerHTML = `<div class="fp-empty"><div class="fp-empty-icon">${svgIcon("globe")}</div><strong>No requests</strong>fetch and XMLHttpRequest calls appear here.</div>`;
  else for (const entry of filtered) listEl.appendChild(renderNetworkRow(entry));
  body.querySelectorAll("[data-net-filter]").forEach(chip => chip.addEventListener("click", () => { n.filter = chip.dataset.netFilter; renderNetwork(body); }));
  $("#fpNetClear", body)?.addEventListener("click", () => { n.entries = []; n.expanded.clear(); renderNetwork(body); updateSectionMeta(); });
  $("#fpNetWaterfall", body)?.addEventListener("click", () => { n.waterfallExpanded = !n.waterfallExpanded; renderNetwork(body); });
  if (n.waterfallExpanded && filtered.length > 0) $("#fpNetWaterfallWrap", body).appendChild(renderWaterfall(filtered));
}

function renderNetworkRow(entry) {
  const row = el("div", { class: "fp-net-row", "data-id": entry.id });
  const statusFamily = entry.error ? "error" : Math.floor(entry.status / 100);
  row.appendChild(el("span", { class: "fp-net-method" }, entry.method));
  row.appendChild(el("span", { class: "fp-net-status", "data-family": statusFamily }, entry.error ? "ERR" : String(entry.status || "—")));
  row.appendChild(el("span", { class: "fp-net-url", title: entry.url }, entry.url));
  row.appendChild(el("span", { class: "fp-net-dur" }, fmtDuration(entry.durationMs)));
  const wrap = el("div");
  wrap.appendChild(row);
  row.addEventListener("click", () => openNetworkDetail(entry));
  return wrap;
}

function renderWaterfall(entries) {
  const wrap = el("div", { class: "fp-net-waterfall" });
  wrap.appendChild(el("div", { class: "fp-net-waterfall-title" }, "Timeline"));
  const max = Math.max(...entries.map(e => e.durationMs || 0), 1);
  for (const entry of entries) {
    const row = el("div", { class: "fp-net-waterfall-row" });
    row.appendChild(el("span", { class: "fw-label", title: entry.url }, entry.url));
    const bar = el("div", { class: "fw-bar" });
    bar.appendChild(el("div", { class: "fw-bar-fill", style: { width: Math.max(2, Math.min(100, ((entry.durationMs || 0) / max) * 100)) + "%" } }));
    row.appendChild(bar);
    row.appendChild(el("span", { class: "fw-dur" }, fmtDuration(entry.durationMs)));
    wrap.appendChild(row);
  }
  return wrap;
}

function openNetworkDetail(entry) {
  const body = el("div");
  body.innerHTML = `
    <div class="fp-net-detail-row"><span class="fk">URL</span><span class="fv">${escapeHtml(entry.url)}</span></div>
    <div class="fp-net-detail-row"><span class="fk">Method</span><span class="fv">${escapeHtml(entry.method)}</span></div>
    <div class="fp-net-detail-row"><span class="fk">Status</span><span class="fv">${entry.error ? "Error: " + escapeHtml(entry.error) : String(entry.status)}</span></div>
    <div class="fp-net-detail-row"><span class="fk">Duration</span><span class="fv">${fmtDuration(entry.durationMs)}</span></div>
    <div class="fp-net-actions">
      <button class="fp-chip" id="fpNetCopyUrl" type="button">${svgIcon("copy")} Copy URL</button>
      <button class="fp-chip" id="fpNetCopyCurl" type="button">${svgIcon("terminal")} Copy as cURL</button>
    </div>
  `;
  const dlg = showDialog({ title: "Request detail", body, size: "narrow" });
  $("#fpNetCopyUrl", dlg)?.addEventListener("click", async () => {
    if (await copyToClipboard(entry.url)) toast("URL copied", "success"); else toast("Copy failed", "error");
  });
  $("#fpNetCopyCurl", dlg)?.addEventListener("click", async () => {
    const curl = `curl -X ${entry.method} '${entry.url}'`;
    if (await copyToClipboard(curl)) toast("cURL copied", "success"); else toast("Copy failed", "error");
  });
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: ASSETS & DEPENDENCIES
// ─────────────────────────────────────────────────────────────────
function renderAssets(body) {
  body.innerHTML = `
    <div class="fp-toolbar">
      <button class="fp-chip" id="fpAssetsScan" type="button">${svgIcon("refresh")} Scan</button>
      <button class="fp-chip" id="fpAssetsGraph" type="button">${svgIcon("code")} Graph view</button>
    </div>
    <div id="fpAssetsContent"></div>
  `;
  $("#fpAssetsScan", body).addEventListener("click", () => {
    ST.assets.scanning = true;
    const c = $("#fpAssetsContent", body);
    if (c) c.innerHTML = `<div class="fp-skeleton"><div class="fp-skeleton-row"></div><div class="fp-skeleton-row"></div><div class="fp-skeleton-row"></div></div>`;
    if (ST.bridgeReady) postToChild(REQ.ASSETS_SCAN);
    else analyzeAssetsFromSource();
  });
  $("#fpAssetsGraph", body).addEventListener("click", showDependencyGraph);

  const c = $("#fpAssetsContent", body);
  if (ST.assets.scanning) return;
  if (!hasAssetData()) {
    c.innerHTML = `<div class="fp-empty"><div class="fp-empty-icon">${svgIcon("file")}</div><strong>No data yet</strong>Click "Scan" to detect dependencies.</div>`;
    return;
  }
  c.innerHTML = "";
  const groups = [
    ["HTML", ST.assets.html],
    ["CSS", ST.assets.css],
    ["JavaScript", ST.assets.js],
    ["JSON", ST.assets.json],
    ["Images", ST.assets.images],
    ["External", ST.assets.external],
  ];
  for (const [label, list] of groups) {
    if (!list || !list.length) continue;
    const g = el("div", { class: "fp-asset-group" });
    g.appendChild(el("div", { class: "fp-asset-group-title" }, label, el("span", { class: "fp-count" }, String(list.length))));
    for (const a of list) {
      const row = el("div", { class: "fp-asset-row", "data-clickable": a.known ? "true" : "false" });
      row.appendChild(el("span", { class: "fp-asset-status", "data-known": a.known ? "true" : "false" }, a.known ? "✓" : "↗"));
      row.appendChild(el("span", { class: "fp-asset-path", title: a.url }, a.url));
      if (a.kind) row.appendChild(el("span", { class: "fp-asset-kind" }, a.kind));
      if (a.known && typeof ST.hooks.onOpenFile === "function") row.addEventListener("click", () => ST.hooks.onOpenFile(a.url, null));
      g.appendChild(row);
    }
    c.appendChild(g);
  }
}

function hasAssetData() {
  const a = ST.assets;
  return (a.html?.length || a.css?.length || a.js?.length || a.json?.length || a.images?.length || a.external?.length);
}

function analyzeAssetsFromSource() {
  if (typeof ST.hooks.getProjectFiles !== "function") { ST.assets.scanning = false; return; }
  Promise.resolve(ST.hooks.getProjectFiles()).then(files => {
    const active = (files || []).find(f => f.path === ST.source.file);
    if (!active) { ST.assets.scanning = false; renderSection("assets"); return; }
    const parsed = parseHtmlDeps(active.content, files || []);
    Object.assign(ST.assets, parsed);
    ST.assets.scanning = false;
    renderSection("assets");
  }).catch(() => { ST.assets.scanning = false; renderSection("assets"); });
}

function parseHtmlDeps(html, files) {
  const known = new Set((files || []).map(f => f.path));
  const out = { html: [], css: [], js: [], json: [], images: [], external: [] };
  const pushDep = (url, category) => {
    if (!url) return;
    const clean = url.replace(/^\.?\//, "").split("?")[0].split("#")[0];
    if (!clean) return;
    const isExternal = /^https?:\/\//i.test(url) || url.startsWith("//");
    const entry = { url: clean, known: !isExternal && known.has(clean), kind: category };
    if (isExternal) out.external.push(entry);
    else out[category]?.push(entry);
  };
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
    const href = m[1];
    if (/\.css(\?|#|$)/i.test(href)) pushDep(href, "css");
    else if (/\.(png|jpe?g|gif|webp|svg|ico|avif)(\?|#|$)/i.test(href)) pushDep(href, "images");
  }
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const src = m[1];
    if (/\.js(\?|#|$)/i.test(src)) pushDep(src, "js");
  }
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) pushDep(m[1], "images");
  for (const m of html.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) {
    const u = m[1];
    if (/\.(png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf)(\?|#|$)/i.test(u)) pushDep(u, "images");
  }
  for (const m of html.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/gi)) pushDep(m[1], "css");
  for (const m of html.matchAll(/(?:import|from)\s+["']([^"']+)["']/g)) {
    const u = m[1];
    if (/\.js(\?|#|$)/i.test(u)) pushDep(u, "js");
    else if (/\.json(\?|#|$)/i.test(u)) pushDep(u, "json");
  }
  return out;
}

function showDependencyGraph() {
  const body = el("div");
  const a = ST.assets;
  const rootFile = ST.source.file || "index.html";
  const renderNode = (label, depth, icon = "file") => el("div", { class: "fp-graph-node", "data-depth": String(depth) },
    el("span", { class: "fp-graph-icon", html: svgIcon(icon) }),
    el("span", { class: "fp-graph-label" }, label)
  );
  const graph = el("div", { class: "fp-graph" });
  graph.appendChild(renderNode(rootFile, 0, "code"));
  const all = [
    ...(a.html || []).map(x => ({ ...x, cat: "HTML" })),
    ...(a.css || []).map(x => ({ ...x, cat: "CSS" })),
    ...(a.js || []).map(x => ({ ...x, cat: "JS" })),
    ...(a.json || []).map(x => ({ ...x, cat: "JSON" })),
    ...(a.images || []).map(x => ({ ...x, cat: "IMG" })),
    ...(a.external || []).map(x => ({ ...x, cat: "EXT" })),
  ];
  for (const item of all) {
    graph.appendChild(renderNode(`${item.cat}: ${item.url}`, 1, item.known ? "file" : "externalLink"));
  }
  if (!all.length) graph.appendChild(el("div", { class: "fp-empty" }, "No dependencies detected"));
  body.appendChild(graph);
  showDialog({ title: "Dependency graph", subtitle: rootFile, body, size: "wide" });
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: RESPONSIVE
// ─────────────────────────────────────────────────────────────────
function renderResponsive(body) {
  body.innerHTML = `<div class="fp-toolbar"><button class="fp-chip" id="fpRespScan" type="button">${svgIcon("ruler")} Scan now</button></div><div id="fpRespContent"></div>`;
  $("#fpRespScan", body).addEventListener("click", () => {
    ST.responsive.scanning = true;
    postToChild(REQ.RESPONSIVE_SCAN);
    const c = $("#fpRespContent", body);
    if (c) c.innerHTML = `<div class="fp-skeleton"><div class="fp-skeleton-row"></div><div class="fp-skeleton-row"></div></div>`;
  });
  const content = $("#fpRespContent", body);
  if (!ST.responsive.result) { content.innerHTML = `<div class="fp-empty"><div class="fp-empty-icon">${svgIcon("ruler")}</div><strong>Not scanned yet</strong>Click "Scan now" to check layout issues.</div>`; return; }
  content.innerHTML = "";
  const stats = el("div", { class: "fp-resp-grid" });
  stats.appendChild(el("div", { class: "fp-resp-stat" }, el("div", { class: "fp-resp-stat-label" }, "Viewport"), el("div", { class: "fp-resp-stat-value" }, (ST.responsive.result.viewportWidth || 0) + " px")));
  stats.appendChild(el("div", { class: "fp-resp-stat" }, el("div", { class: "fp-resp-stat-label" }, "Overflow"), el("div", { class: "fp-resp-stat-value", "data-warn": (ST.responsive.result.overflow?.length || 0) > 0 ? "true" : "false" }, String(ST.responsive.result.overflow?.length || 0))));
  stats.appendChild(el("div", { class: "fp-resp-stat" }, el("div", { class: "fp-resp-stat-label" }, "Touch targets"), el("div", { class: "fp-resp-stat-value", "data-warn": (ST.responsive.result.touchTargets?.length || 0) > 0 ? "true" : "false" }, String(ST.responsive.result.touchTargets?.length || 0))));
  stats.appendChild(el("div", { class: "fp-resp-stat" }, el("div", { class: "fp-resp-stat-label" }, "Small text"), el("div", { class: "fp-resp-stat-value", "data-warn": (ST.responsive.result.smallText?.length || 0) > 0 ? "true" : "false" }, String(ST.responsive.result.smallText?.length || 0))));
  content.appendChild(stats);
  if (ST.responsive.result.overflow?.length) content.appendChild(renderIssueGroup("Overflow", "error", ST.responsive.result.overflow.map(o => ({ path: o.path, detail: `Right: ${o.right}px (viewport ${o.viewportWidth}px)` }))));
  if (ST.responsive.result.touchTargets?.length) content.appendChild(renderIssueGroup("Touch targets under 44px", "warn", ST.responsive.result.touchTargets.map(t => ({ path: t.path, detail: `${t.width}×${t.height}px` }))));
  if (ST.responsive.result.smallText?.length) content.appendChild(renderIssueGroup("Small text under 12px", "warn", ST.responsive.result.smallText.map(t => ({ path: t.path, detail: `${t.fontSize}px` }))));
}

function renderIssueGroup(title, severity, issues) {
  const group = el("div", { class: "fp-resp-group" });
  group.appendChild(el("div", { class: "fp-resp-group-title" }, title, el("span", { class: "fp-count" }, String(issues.length))));
  for (const issue of issues) {
    const row = el("div", { class: "fp-resp-issue", "data-severity": severity });
    row.appendChild(el("div", { class: "fp-issue-path" }, issue.path));
    row.appendChild(el("div", { class: "fp-issue-detail" }, issue.detail));
    row.addEventListener("click", () => { if (ST.bridgeReady) postToChild(REQ.HIGHLIGHT, { path: issue.path }); });
    group.appendChild(row);
  }
  return group;
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: PERFORMANCE
// ─────────────────────────────────────────────────────────────────
function renderPerformance(body) {
  body.innerHTML = "";
  const v = ST.vitals;
  const vitalsGrid = el("div", { class: "fp-perf-vitals" });
  const addVital = (label, value, target, ratingFn) => {
    const rating = value == null ? null : ratingFn(value);
    const tile = el("div", { class: "fp-perf-vital", "data-rating": rating || "" });
    tile.appendChild(el("div", { class: "fp-perf-vital-label" }, label));
    tile.appendChild(el("div", { class: "fp-perf-vital-value" }, value == null ? "—" : fmtDuration(value)));
    tile.appendChild(el("div", { class: "fp-perf-vital-target" }, target));
    vitalsGrid.appendChild(tile);
  };
  addVital("FCP", v.fcp, "target <1.8s", (x) => x < 1800 ? "good" : x < 3000 ? "warn" : "bad");
  addVital("LCP", v.lcp, "target <2.5s", (x) => x < 2500 ? "good" : x < 4000 ? "warn" : "bad");
  addVital("CLS", v.cls, "target <0.1", (x) => x < 0.1 ? "good" : x < 0.25 ? "warn" : "bad");
  body.appendChild(vitalsGrid);

  const loaded = ST.files.loaded;
  let jsBytes = 0, cssBytes = 0, imgBytes = 0;
  for (const f of loaded) {
    if (/\.(js|mjs)$/i.test(f.path)) jsBytes += f.size || 0;
    else if (/\.css$/i.test(f.path)) cssBytes += f.size || 0;
    else if (/\.(png|jpe?g|gif|webp|svg|ico|avif)$/i.test(f.path)) imgBytes += f.size || 0;
  }
  const payload = el("div", { class: "fp-perf-payload" });
  payload.appendChild(el("div", { class: "fp-net-waterfall-title" }, "Payload"));
  const addPayloadRow = (label, bytes, warnAbove) => {
    const row = el("div", { class: "fp-perf-payload-row", "data-warn": warnAbove && bytes > warnAbove ? "true" : "false" });
    row.appendChild(el("span", { class: "fp-payload-label" }, label));
    row.appendChild(el("span", { class: "fp-payload-val" }, fmtBytes(bytes)));
    payload.appendChild(row);
    const budget = el("div", { class: "fp-perf-budget", "data-level": !warnAbove ? "good" : bytes > warnAbove * 1.5 ? "bad" : bytes > warnAbove ? "warn" : "good" });
    budget.appendChild(el("div", { class: "fp-perf-budget-fill", style: { width: Math.min(100, (bytes / Math.max(warnAbove, 1)) * 100) + "%" } }));
    payload.appendChild(budget);
  };
  addPayloadRow("JavaScript", jsBytes, 100 * 1024);
  addPayloadRow("CSS", cssBytes, 50 * 1024);
  addPayloadRow("Images", imgBytes, 500 * 1024);
  addPayloadRow("Total", jsBytes + cssBytes + imgBytes, 800 * 1024);
  body.appendChild(payload);

  if (ST.resources.length) {
    const waterfall = el("div", { class: "fp-net-waterfall" });
    waterfall.appendChild(el("div", { class: "fp-net-waterfall-title" }, "Resources (" + ST.resources.length + ")"));
    const maxDur = Math.max(...ST.resources.map(r => r.duration || 0), 1);
    for (const res of ST.resources.slice(0, 30)) {
      const row = el("div", { class: "fp-net-waterfall-row" });
      row.appendChild(el("span", { class: "fw-label", title: res.name }, res.name.split("/").pop() || res.name));
      const bar = el("div", { class: "fw-bar" });
      bar.appendChild(el("div", { class: "fw-bar-fill", style: { width: Math.max(2, Math.min(100, (res.duration / maxDur) * 100)) + "%" } }));
      row.appendChild(bar);
      row.appendChild(el("span", { class: "fw-dur" }, fmtDuration(res.duration)));
      waterfall.appendChild(row);
    }
    body.appendChild(waterfall);
  }
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: FILES
// ─────────────────────────────────────────────────────────────────
function renderFiles(body) {
  body.innerHTML = "";
  const loaded = ST.files.loaded;
  const skipped = ST.files.skipped;
  if (!loaded.length && !skipped.length) { body.innerHTML = `<div class="fp-empty"><div class="fp-empty-icon">${svgIcon("folder")}</div><strong>No files</strong>File information appears once the preview loads.</div>`; return; }
  if (loaded.length) {
    const group = el("div", { class: "fp-files-group" });
    group.appendChild(el("div", { class: "fp-files-group-title" }, "Loaded", el("span", { class: "fp-count" }, String(loaded.length))));
    for (const f of loaded) {
      const row = el("div", { class: "fp-files-row", "data-loaded": "true", "data-clickable": "true" });
      row.appendChild(el("span", { class: "fp-files-status" }, "✓"));
      row.appendChild(el("span", { class: "fp-files-path" }, f.path));
      row.appendChild(el("span", { class: "fp-files-size" }, fmtBytes(f.size || 0)));
      row.addEventListener("click", () => { if (typeof ST.hooks.onOpenFile === "function") ST.hooks.onOpenFile(f.path, null); });
      group.appendChild(row);
    }
    body.appendChild(group);
  }
  if (skipped.length) {
    const group = el("div", { class: "fp-files-group" });
    group.appendChild(el("div", { class: "fp-files-group-title" }, "Skipped", el("span", { class: "fp-count" }, String(skipped.length))));
    for (const f of skipped) {
      const row = el("div", { class: "fp-files-row", "data-loaded": "false" });
      row.appendChild(el("span", { class: "fp-files-status" }, "✕"));
      row.appendChild(el("span", { class: "fp-files-path" }, f.path));
      row.appendChild(el("span", { class: "fp-files-reason" }, f.skippedReason || "not previewable"));
      group.appendChild(row);
    }
    body.appendChild(group);
  }
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: STORAGE
// ─────────────────────────────────────────────────────────────────
function renderStorage(body) {
  body.innerHTML = `<div class="fp-toolbar"><button class="fp-chip" id="fpStorReload" type="button">${svgIcon("refresh")} Reload</button><button class="fp-chip danger" id="fpStorClear" type="button">${svgIcon("trash")} Clear all</button></div><div id="fpStorContent"></div>`;
  const render = () => {
    const content = $("#fpStorContent", body);
    if (!content) return;
    content.innerHTML = "";
    const localKeys = Object.keys(ST.storage.local || {});
    const sessionKeys = Object.keys(ST.storage.session || {});
    if (!localKeys.length && !sessionKeys.length) { content.innerHTML = `<div class="fp-empty"><div class="fp-empty-icon">${svgIcon("database")}</div><strong>Nothing stored</strong>localStorage and sessionStorage appear here.</div>`; return; }
    const addGroup = (title, store, kind) => {
      const keys = Object.keys(store);
      if (!keys.length) return;
      const group = el("div", { class: "fp-stor-group" });
      group.appendChild(el("div", { class: "fp-stor-group-title" }, title, el("span", { class: "fp-count" }, String(keys.length))));
      for (const k of keys) {
        const row = el("div", { class: "fp-stor-row" });
        row.appendChild(el("span", { class: "fp-stor-key" }, k));
        row.appendChild(el("span", { class: "fp-stor-val", title: store[k] }, String(store[k]).slice(0, 200)));
        const acts = el("div", { class: "fp-stor-act" });
        const delBtn = el("button", { type: "button", title: "Delete" }, "✕");
        delBtn.addEventListener("click", () => { postToChild(REQ.CLEAR_STORAGE, { key: k, kind }); delete store[k]; render(); });
        acts.appendChild(delBtn);
        row.appendChild(acts);
        group.appendChild(row);
      }
      content.appendChild(group);
    };
    addGroup("localStorage", ST.storage.local || {}, "local");
    addGroup("sessionStorage", ST.storage.session || {}, "session");
  };
  render();
  $("#fpStorReload", body).addEventListener("click", () => postToChild(REQ.STORAGE_SNAPSHOT));
  $("#fpStorClear", body).addEventListener("click", () => postToChild(REQ.CLEAR_STORAGE));
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: INSPECTOR (pick element → details + CSS edit + tree)
// ─────────────────────────────────────────────────────────────────
function renderInspector(body) {
  const sel = ST.dom.selectedElement || null;
  body.innerHTML = `
    <div class="fp-toolbar">
      <button class="fp-chip ${ST.dom.inspectActive ? "active" : ""}" id="fpInspPick" type="button">${svgIcon("crosshair")} ${ST.dom.inspectActive ? "Picking… click element" : "Pick element"}</button>
      <button class="fp-chip" id="fpInspClear" type="button">${svgIcon("x")} Clear</button>
    </div>
    <div id="fpInspContent"></div>
  `;
  const content = $("#fpInspContent", body);

  $("#fpInspPick", body).addEventListener("click", () => {
    ST.dom.inspectActive = !ST.dom.inspectActive;
    if (ST.dom.inspectActive) {
      postToChild(REQ.INSPECT_START);
      toast("Click any element in the preview", "info");
    } else {
      postToChild(REQ.INSPECT_STOP);
    }
    renderInspector(body);
  });
  $("#fpInspClear", body).addEventListener("click", () => {
    ST.dom.selectedElement = null;
    ST.dom.selectedPath = null;
    ST.dom.inspectActive = false;
    postToChild(REQ.INSPECT_STOP);
    renderInspector(body);
  });

  if (!sel) {
    content.innerHTML = `<div class="fp-empty"><div class="fp-empty-icon">${svgIcon("crosshair")}</div><strong>No element selected</strong>Click “Pick element”, then click anything in the preview to inspect it.</div>`;
    return;
  }

  // Header info — constrained so long selectors never blow the panel
  const info = el("div", { class: "fp-resp-stat", style: "margin-bottom:10px;overflow:hidden;max-width:100%" });
  const labelParts = [];
  if (sel.tag) labelParts.push(sel.tag);
  if (sel.id) labelParts.push("#" + sel.id);
  if (sel.className) {
    const cls = String(sel.className).split(/\s+/).filter(Boolean).slice(0, 4).join(".");
    if (cls) labelParts.push("." + cls);
  }
  info.innerHTML = `
    <div class="fp-resp-stat-label">Selected</div>
    <div class="fp-resp-stat-value" style="font-size:13px;overflow-wrap:anywhere;word-break:break-word;max-width:100%">${escapeHtml(labelParts.join("") || "?")}</div>
    <div style="font-size:10px;color:var(--fp-text-3);margin-top:4px;font-family:var(--fp-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%" title="${escapeHtml(sel.elementPath || "")}">${escapeHtml(sel.elementPath || "")}</div>
  `;
  content.appendChild(info);

  // Hierarchy breadcrumb — scrollable, no horizontal page overflow
  if (sel.elementPath) {
    const crumbs = el("div", { class: "fp-dom-breadcrumb", style: "margin-bottom:10px;max-width:100%;overflow-x:auto;flex-wrap:nowrap" });
    const parts = sel.elementPath.split(" > ");
    parts.forEach((p, i) => {
      const crumb = el("span", { class: "fp-dom-crumb", style: "max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", title: p }, p);
      crumbs.appendChild(crumb);
      if (i < parts.length - 1) crumbs.appendChild(el("span", { class: "fp-dom-crumb-sep" }, "›"));
    });
    content.appendChild(crumbs);
  }

  // Rect
  if (sel.rect) {
    const rectRow = el("div", { style: "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:12px" });
    ["x", "y", "w", "h"].forEach(k => {
      const tile = el("div", { class: "fp-resp-stat", style: "min-width:0;overflow:hidden" });
      tile.innerHTML = `<div class="fp-resp-stat-label">${k.toUpperCase()}</div><div class="fp-resp-stat-value" style="font-size:12px;overflow:hidden;text-overflow:ellipsis">${Math.round(sel.rect[k] || 0)}</div>`;
      rectRow.appendChild(tile);
    });
    content.appendChild(rectRow);
  }

  // CSS editor
  const cssHead = el("div", { class: "fp-resp-group-title" }, "Computed styles");
  content.appendChild(cssHead);
  const styleBox = el("div", { id: "fpInspStyles", style: "margin-bottom:10px;max-width:100%;overflow:hidden" });
  styleBox.innerHTML = `<div class="fp-skeleton"><div class="fp-skeleton-row"></div><div class="fp-skeleton-row"></div></div>`;
  content.appendChild(styleBox);

  // Request styles
  if (ST.bridgeReady && sel.elementPath) {
    postToChild(REQ.GET_ELEMENT_STYLE, { path: sel.elementPath });
  }

  // Highlight button
  const acts = el("div", { class: "fp-toolbar", style: "border:none;padding-top:4px" });
  const hlBtn = el("button", { class: "fp-chip", type: "button" }, `${svgIcon("crosshair")} Highlight`);
  hlBtn.addEventListener("click", () => { if (sel.elementPath) postToChild(REQ.HIGHLIGHT, { path: sel.elementPath }); });
  acts.appendChild(hlBtn);
  content.appendChild(acts);
}

// Handle element style result for inspector
function renderInspectorStyles(style) {
  const box = document.getElementById("fpInspStyles");
  if (!box || !style) return;
  box.innerHTML = "";
  const keys = Object.keys(style);
  if (!keys.length) { box.innerHTML = `<div class="fp-empty">No styles</div>`; return; }
  for (const [prop, val] of Object.entries(style)) {
    const row = el("div", {
      class: "fp-stor-row",
      style: "grid-template-columns:minmax(72px,0.9fr) minmax(0,1.4fr);max-width:100%;overflow:hidden",
    });
    row.appendChild(el("span", {
      class: "fp-stor-key",
      style: "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
      title: prop,
    }, prop));
    const input = el("input", {
      class: "fp-input",
      value: val,
      style: "height:24px;font-size:10.5px;padding:0 6px;font-family:var(--fp-mono);min-width:0;width:100%;max-width:100%;box-sizing:border-box",
    });
    input.addEventListener("change", () => {
      if (ST.bridgeReady && ST.dom.selectedElement?.elementPath) {
        const path = ST.dom.selectedElement.elementPath;
        const code = `(function(){try{var el=document.querySelector(${JSON.stringify(path)});if(el)el.style.setProperty(${JSON.stringify(prop)},${JSON.stringify(input.value)});}catch(e){}})()`;
        postToChild(REQ.EVAL, { code });
      }
    });
    row.appendChild(input);
    box.appendChild(row);
  }
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: DOM
// ─────────────────────────────────────────────────────────────────
function renderDOM(body) {
  body.innerHTML = `
    <div class="fp-toolbar">
      <input type="text" class="fp-dom-search" id="fpDomSearch" placeholder="Filter DOM…" value="${escapeHtml(ST.dom.search)}">
      <button class="fp-chip" id="fpDomReload" type="button">${svgIcon("refresh")} Reload</button>
      <button class="fp-chip ${ST.dom.inspectActive ? "active" : ""}" id="fpDomInspect" type="button">${svgIcon("crosshair")} ${ST.dom.inspectActive ? "Stop" : "Inspect"}</button>
    </div>
    <div class="fp-dom-breadcrumb" id="fpDomBreadcrumb"></div>
    <div class="fp-dom-tree" id="fpDomTree"></div>
  `;
  const treeEl = $("#fpDomTree", body);
  if (!ST.dom.tree) treeEl.innerHTML = `<div class="fp-empty"><div class="fp-empty-icon">${svgIcon("code")}</div><strong>DOM tree not loaded</strong>Click "Reload" to load.</div>`;
  else { treeEl.innerHTML = ""; treeEl.appendChild(renderDOMNode(ST.dom.tree, "root", 0)); }

  $("#fpDomReload", body).addEventListener("click", () => { ST.dom.tree = null; postToChild(REQ.DOM_SNAPSHOT); });
  $("#fpDomInspect", body).addEventListener("click", () => {
    ST.dom.inspectActive = !ST.dom.inspectActive;
    if (ST.dom.inspectActive) postToChild(REQ.INSPECT_START); else postToChild(REQ.INSPECT_STOP);
    renderDOM(body);
  });
  $("#fpDomSearch", body).addEventListener("input", debounce((e) => { ST.dom.search = e.target.value; renderDOM(body); }, 180));
  if (ST.dom.selectedPath) {
    const crumbs = ST.dom.selectedPath.split(" > ");
    const crumb = $("#fpDomBreadcrumb", body);
    crumbs.forEach((c, i) => {
      crumb.appendChild(el("span", { class: "fp-dom-crumb" }, c));
      if (i < crumbs.length - 1) crumb.appendChild(el("span", { class: "fp-dom-crumb-sep" }, "›"));
    });
  }
}

function renderDOMNode(node, path, depth) {
  if (!node) return el("div");
  const id = path;
  if (ST.dom.search && node.tag && !node.tag.toLowerCase().includes(ST.dom.search.toLowerCase()) && !(node.id || "").includes(ST.dom.search) && !(node.className || "").includes(ST.dom.search)) {
    const hasMatchingChild = (node.children || []).some(c => nodeMatchesSearch(c, ST.dom.search));
    if (!hasMatchingChild) return el("div", { style: "display:none" });
  }
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = ST.dom.expanded.has(id) || depth < 2;
  const wrap = el("div", { class: "fp-dom-node", "data-has-children": hasChildren ? "true" : "false" });
  const row = el("div");
  if (hasChildren) {
    const toggle = el("span", { class: "fp-dom-toggle" }, isExpanded ? "▾" : "▸");
    toggle.addEventListener("click", () => { if (ST.dom.expanded.has(id)) ST.dom.expanded.delete(id); else ST.dom.expanded.add(id); renderDOM(ST.sectionsEl.querySelector(`[data-body="dom"]`)); });
    row.appendChild(toggle);
  } else row.appendChild(el("span", { class: "fp-dom-toggle" }, " "));
  if (node.tag === "#text") row.appendChild(el("span", { style: "color:#8a919c;font-style:italic" }, '"' + (node.text || "").slice(0, 60) + '"'));
  else {
    const tag = el("span", { class: "fp-dom-tag" }, node.tag);
    tag.addEventListener("click", () => { ST.dom.selectedPath = path; if (ST.bridgeReady) postToChild(REQ.HIGHLIGHT, { path }); renderDOM(ST.sectionsEl.querySelector(`[data-body="dom"]`)); });
    row.appendChild(tag);
    if (node.id) row.appendChild(el("span", { class: "fp-dom-id" }, "#" + node.id));
    if (node.className) for (const cls of node.className.split(/\s+/).filter(Boolean).slice(0, 3)) row.appendChild(el("span", { class: "fp-dom-class" }, "." + cls));
  }
  wrap.appendChild(row);
  if (hasChildren && isExpanded) {
    const children = el("div", { class: "fp-dom-children" });
    for (let i = 0; i < node.children.length; i++) children.appendChild(renderDOMNode(node.children[i], path + "." + i, depth + 1));
    wrap.appendChild(children);
  }
  return wrap;
}

function nodeMatchesSearch(node, q) {
  if (!node) return false;
  if (node.tag && node.tag.toLowerCase().includes(q)) return true;
  if (node.id && node.id.includes(q)) return true;
  if (node.className && node.className.includes(q)) return true;
  return (node.children || []).some(c => nodeMatchesSearch(c, q));
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: A11Y
// ─────────────────────────────────────────────────────────────────
function renderA11y(body) {
  body.innerHTML = `<div class="fp-toolbar"><button class="fp-chip" id="fpA11yScan" type="button">${svgIcon("shield")} Scan now</button></div><div id="fpA11yContent"></div>`;
  $("#fpA11yScan", body).addEventListener("click", () => {
    ST.a11y.scanning = true;
    postToChild(REQ.A11Y_SCAN);
    const c = $("#fpA11yContent", body);
    if (c) c.innerHTML = `<div class="fp-skeleton"><div class="fp-skeleton-row"></div><div class="fp-skeleton-row"></div></div>`;
  });
  const content = $("#fpA11yContent", body);
  if (!ST.a11y.issues) { content.innerHTML = `<div class="fp-empty"><div class="fp-empty-icon">${svgIcon("shield")}</div><strong>Not scanned yet</strong>Click "Scan now" to check accessibility.</div>`; return; }
  content.innerHTML = "";
  if (!ST.a11y.issues.length) { content.innerHTML = `<div class="fp-empty"><div class="fp-empty-icon">${svgIcon("check")}</div><strong>No issues found</strong>No obvious accessibility problems.</div>`; return; }
  const groups = {};
  for (const issue of ST.a11y.issues) { if (!groups[issue.type]) groups[issue.type] = []; groups[issue.type].push(issue); }
  for (const [type, issues] of Object.entries(groups)) {
    const group = el("div", { class: "fp-a11y-group" });
    group.appendChild(el("div", { class: "fp-a11y-group-title" }, type.replace(/-/g, " "), el("span", { class: "fp-count" }, String(issues.length))));
    for (const issue of issues) {
      const row = el("div", { class: "fp-a11y-issue", "data-severity": issue.severity });
      row.appendChild(el("div", { class: "fp-a11y-issue-title" }, issue.title));
      if (issue.detail) row.appendChild(el("div", { class: "fp-a11y-issue-detail" }, issue.detail));
      if (issue.fix) {
        const acts = el("div", { class: "fp-a11y-actions" });
        const fixBtn = el("button", { class: "fp-chip", type: "button" }, `${svgIcon("copy")} ${issue.fix}`);
        fixBtn.addEventListener("click", async () => { if (await copyToClipboard(issue.fix)) toast("Fix copied", "success"); });
        acts.appendChild(fixBtn);
        row.appendChild(acts);
      }
      group.appendChild(row);
    }
    content.appendChild(group);
  }
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: DEV TOOLS
// ─────────────────────────────────────────────────────────────────
function renderDevTools(body) {
  body.innerHTML = `
    <div class="fp-devtools-grid">
      <button class="fp-devtools-btn" id="fpDevCopyHtml" type="button">${svgIcon("copy")} Copy HTML</button>
      <button class="fp-devtools-btn" id="fpDevCopyTitle" type="button">${svgIcon("copy")} Copy title</button>
      <button class="fp-devtools-btn" id="fpDevReload" type="button">${svgIcon("refresh")} Hard reload</button>
      <button class="fp-devtools-btn" id="fpDevSlow" type="button">${svgIcon("wifi")} Slow network</button>
      <button class="fp-devtools-btn" id="fpDevOffline" type="button">${svgIcon("wifiOff")} Simulate offline</button>
      <button class="fp-devtools-btn" id="fpDevReset" type="button">${svgIcon("check")} Reset network</button>
      <button class="fp-devtools-btn" id="fpDevHeatmap" type="button">${svgIcon("crosshair")} Toggle heatmap</button>
      <button class="fp-devtools-btn" id="fpDevCssVars" type="button">${svgIcon("palette")} CSS variables</button>
      <button class="fp-devtools-btn" id="fpDevClearAll" type="button" data-danger="true">${svgIcon("trash")} Clear all state</button>
    </div>
    <div class="fp-empty" style="margin-top:10px;font-size:10px;padding:10px 4px;">
      <strong>Simulated network</strong>
      Slow adds ~1.5s latency. Offline fails fetch calls. Both are approximations.
    </div>
  `;
  $("#fpDevCopyHtml", body).addEventListener("click", async () => {
    const html = ST.dom.tree ? serializeDOMToHtml(ST.dom.tree) : null;
    if (html) { if (await copyToClipboard(html)) toast("HTML copied", "success"); else toast("Copy failed", "error"); }
    else toast("Reload DOM first", "warning");
  });
  $("#fpDevCopyTitle", body).addEventListener("click", async () => {
    try { const t = ST.iframeEl.contentDocument?.title; if (t) { if (await copyToClipboard(t)) toast("Title copied", "success"); } else toast("No title", "warning"); } catch { toast("Cross-origin", "warning"); }
  });
  $("#fpDevReload", body).addEventListener("click", () => postToChild(REQ.RELOAD));
  $("#fpDevSlow", body).addEventListener("click", () => { postToChild(REQ.SIMULATE_NETWORK, THROTTLE_PRESETS["3g"]); toast("Slow network applied", "info"); });
  $("#fpDevOffline", body).addEventListener("click", () => { postToChild(REQ.SIMULATE_NETWORK, { latencyMs: 0, failureRate: 1 }); toast("Offline mode", "info"); });
  $("#fpDevReset", body).addEventListener("click", () => { postToChild(REQ.SIMULATE_NETWORK, THROTTLE_PRESETS.none); toast("Network reset", "success"); });
  $("#fpDevHeatmap", body).addEventListener("click", () => {
    ST.heatmap.active = !ST.heatmap.active;
    if (ST.heatmap.active) postToChild(REQ.START_HEATMAP); else postToChild(REQ.STOP_HEATMAP);
    toast(ST.heatmap.active ? "Heatmap on" : "Heatmap off", "info");
  });
  $("#fpDevCssVars", body).addEventListener("click", () => { postToChild(REQ.GET_CSS_VARS); setTimeout(showCssVarsDialog, 200); });
  $("#fpDevClearAll", body).addEventListener("click", async () => {
    postToChild(REQ.CLEAR_STORAGE);
    ST.console.entries = [];
    ST.network.entries = [];
    ST.a11y.issues = null;
    ST.responsive.result = null;
    toast("All state cleared", "success");
    updateSectionMeta();
  });
}

function serializeDOMToHtml(node) {
  if (!node) return "";
  if (node.tag === "#text") return node.text || "";
  let attrs = "";
  if (node.id) attrs += ` id="${node.id}"`;
  if (node.className) attrs += ` class="${node.className}"`;
  const inner = (node.children || []).map(c => serializeDOMToHtml(c)).join("");
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

function showCssVarsDialog() {
  const vars = ST.cssVars.vars || {};
  const body = el("div");
  if (!Object.keys(vars).length) { body.innerHTML = `<div class="fp-empty">No CSS variables found</div>`; }
  else {
    for (const [k, v] of Object.entries(vars)) {
      const row = el("div", { class: "fp-stor-row" });
      row.appendChild(el("span", { class: "fp-stor-key" }, k));
      const input = el("input", { class: "fp-input", value: v, style: "height:24px;font-size:10.5px;padding:0 6px" });
      input.addEventListener("change", () => postToChild(REQ.SET_CSS_VAR, { name: k, value: input.value }));
      row.appendChild(input);
      body.appendChild(row);
    }
  }
  showDialog({ title: "CSS variables", subtitle: `${Object.keys(vars).length} found`, body, size: "wide" });
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: EDITOR CONSOLE
// ─────────────────────────────────────────────────────────────────
function renderEditorConsole(body) {
  body.innerHTML = `<div class="fp-console-list" id="fpEdConsoleList"></div>`;
  const list = $("#fpEdConsoleList", body);
  if (!ST.editorConsole.history.length) { list.innerHTML = `<div class="fp-empty"><div class="fp-empty-icon">${svgIcon("terminal")}</div><strong>No commands yet</strong>Run JS in the Console REPL to see history.</div>`; return; }
  for (const item of ST.editorConsole.history) {
    if (item.kind === "input") {
      list.appendChild(el("div", { class: "fp-console-entry" },
        el("span", { class: "fp-console-icon", html: svgIcon("terminal") }),
        el("span", { class: "fp-console-args", style: "color:#F59E0B;font-weight:700" }, "> " + item.code)
      ));
    }
  }
}

// ─────────────────────────────────────────────────────────────────
//  SECTION: SEARCH
// ─────────────────────────────────────────────────────────────────
function renderSearchSection(body) {
  body.innerHTML = `
    <div class="fp-toolbar">
      <input type="text" id="fpSearchInput" placeholder="Search project…" value="${escapeHtml(ST.search.query)}">
      <button class="fp-chip ${ST.search.caseSensitive ? "active" : ""}" id="fpSearchCase" type="button">Aa</button>
      <button class="fp-chip ${ST.search.useRegex ? "active" : ""}" id="fpSearchRegex" type="button">.*</button>
    </div>
    <div id="fpSearchResults"></div>
  `;
  const results = $("#fpSearchResults", body);
  const input = $("#fpSearchInput", body);
  const doSearch = debounce(async () => {
    ST.search.query = input.value.trim();
    if (!ST.search.query) { results.innerHTML = ""; return; }
    const files = await (ST.hooks.getProjectFiles?.() || Promise.resolve([]));
    const matches = [];
    for (const f of files) {
      if (typeof f.content !== "string") continue;
      let re;
      try {
        const flags = ST.search.caseSensitive ? "g" : "gi";
        re = ST.search.useRegex ? new RegExp(ST.search.query, flags) : new RegExp(ST.search.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      } catch { continue; }
      const lines = f.content.split('\n');
      lines.forEach((line, idx) => {
        if (re.test(line)) matches.push({ path: f.path, line: idx + 1, text: line.slice(0, 120) });
      });
    }
    ST.search.matches = matches;
    results.innerHTML = "";
    if (!matches.length) { results.innerHTML = `<div class="fp-empty">No results</div>`; return; }
    const byFile = {};
    for (const m of matches) { if (!byFile[m.path]) byFile[m.path] = []; byFile[m.path].push(m); }
    for (const [path, list] of Object.entries(byFile)) {
      const group = el("div", { class: "fp-search-result-group" });
      group.appendChild(el("div", { class: "fp-search-result-header" },
        el("span", { class: "fp-search-result-path" }, path),
        el("span", { class: "fp-search-result-count" }, String(list.length))
      ));
      for (const m of list) {
        const row = el("div", { class: "fp-search-match" });
        row.appendChild(el("span", { class: "fp-search-match-line" }, String(m.line)));
        row.appendChild(el("span", { class: "fp-search-match-body" }, m.text));
        row.addEventListener("click", () => { if (typeof ST.hooks.onOpenFile === "function") ST.hooks.onOpenFile(m.path, m.line); });
        group.appendChild(row);
      }
      results.appendChild(group);
    }
  }, 200);
  input.addEventListener("input", doSearch);
  $("#fpSearchCase", body).addEventListener("click", () => { ST.search.caseSensitive = !ST.search.caseSensitive; renderSearchSection(body); });
  $("#fpSearchRegex", body).addEventListener("click", () => { ST.search.useRegex = !ST.search.useRegex; renderSearchSection(body); });
}

// ─────────────────────────────────────────────────────────────────
//  MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────
function handleMessage(e) {
  if (!e.data || e.data.__folio !== true) return;
  switch (e.data.type) {
    case MSG.READY: ST.bridgeReady = true; emit("ready", {}); break;
    case MSG.CONSOLE: addConsoleEntry(e.data); break;
    case MSG.ERROR: addConsoleEntry({ level: "error", args: [{ kind: "string", value: e.data.message }], ts: Date.now(), file: e.data.file, line: e.data.line }); break;
    case MSG.NETWORK: addNetworkEntry(e.data); break;
    case MSG.VITALS: Object.assign(ST.vitals, e.data); break;
    case MSG.RESOURCE: ST.resources.push(e.data); break;
    case MSG.LAYOUT_SHIFT: ST.layoutShifts.push(e.data); break;
    case MSG.STORAGE_SNAPSHOT_RESULT: ST.storage.local = e.data.local || {}; ST.storage.session = e.data.session || {}; break;
    case MSG.DOM_SNAPSHOT: ST.dom.tree = e.data.tree; ST.dom.loading = false; break;
    case MSG.INSPECT_RESULT:
      ST.dom.selectedPath = e.data.elementPath;
      ST.dom.selectedElement = {
        elementPath: e.data.elementPath,
        tag: e.data.tag,
        id: e.data.id,
        className: e.data.className,
        rect: e.data.rect,
      };
      ST.dom.inspectActive = false;
      postToChild(REQ.INSPECT_STOP);
      // Auto-open inspector section
      if (!ST.openSections.has("inspector")) {
        [...ST.openSections].forEach(id => closeSection(id));
        setDockExpanded(true);
        openSection("inspector");
      } else {
        renderSection("inspector");
      }
      break;
    case MSG.A11Y_RESULT: ST.a11y.issues = e.data.issues || []; ST.a11y.scanning = false; break;
    case MSG.RESPONSIVE_RESULT: ST.responsive.result = e.data; ST.responsive.scanning = false; break;
    case MSG.EVAL_RESULT: {
      const body = ST.sectionsEl?.querySelector(`[data-body="console"]`);
      const res = body ? $("#fpConsoleReplResult", body) : null;
      if (res) {
        if (e.data.ok) { res.innerHTML = `<div class="fp-console-repl-result" data-ok="true">${escapeHtml(JSON.stringify(e.data.value, null, 2))}</div>`; ST.editorConsole.history.push({ kind: "input", code: "", value: e.data.value }); }
        else res.innerHTML = `<div class="fp-console-repl-result" data-ok="false">${escapeHtml(e.data.error)}</div>`;
      }
      break;
    }
    case MSG.ASSETS_RESULT: Object.assign(ST.assets, e.data, { scanning: false }); break;
    case MSG.CSS_VARS: ST.cssVars = { vars: e.data.vars || {} }; break;
    case MSG.ELEMENT_STYLE:
      if (e.data.style) renderInspectorStyles(e.data.style);
      break;
    case MSG.HEATMAP_DATA: renderHeatmap(e.data.points || []); break;
    case MSG.SCREENSHOT_DATA: break; // handled by promise
  }
  updateSectionMeta();
  if (ST.openSections.size) for (const id of ST.openSections) { const sec = ST.sectionsEl.querySelector(`[data-section="${id}"]`); if (sec?.getAttribute("data-open") === "true") renderSection(id); }
}

function addConsoleEntry(data) {
  if (ST.console.entries.length >= ST.settings.consoleMaxEntries) ST.console.entries.shift();
  ST.console.entries.push({ id: ST.console.nextId++, ...data });
  emit("console", data);
}
function addNetworkEntry(data) {
  if (ST.network.entries.length >= ST.settings.networkMaxEntries) ST.network.entries.shift();
  ST.network.entries.push({ id: ST.network.nextId++, ...data });
  emit("network", data);
}

function renderHeatmap(points) {
  const hm = $("#fpHeatmap");
  if (!hm) return;
  hm.innerHTML = "";
  for (const p of points) {
    const dot = el("div", { class: "fp-heatmap-dot", style: { left: p.x + "px", top: p.y + "px" } });
    hm.appendChild(dot);
  }
}

// ─────────────────────────────────────────────────────────────────
//  SIZING
// ─────────────────────────────────────────────────────────────────
function applySize(mode, custom) {
  const frame = ST.frameEl;
  const stage = ST.stageEl;
  if (!frame || !stage) return;
  const rotated = ST.sizer.rotated;
  frame.setAttribute("data-mode", mode);
  frame.setAttribute("data-rotated", rotated ? "true" : "false");

  // Reset margins that device chrome may set
  frame.style.marginBottom = "";
  frame.style.marginLeft = "";
  frame.style.marginRight = "";
  frame.style.marginTop = "";

  if (mode === "fit") {
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.maxWidth = "100%";
    frame.style.maxHeight = "100%";
    frame.setAttribute("data-device", "false");
    frame.removeAttribute("data-category");
    frame.removeAttribute("data-notch");
    const readout = $("#fpReadout");
    if (readout) readout.textContent = "";
    return;
  }

  let w, h, isDevice = mode !== "custom";
  let category = "Desktop";
  let notch = false;
  if (mode === "custom") {
    w = custom?.w || ST.sizer.custom.w;
    h = custom?.h || ST.sizer.custom.h;
    isDevice = false;
  } else if (ST.sizer.device && DEVICE_PRESETS[ST.sizer.device]) {
    const preset = DEVICE_PRESETS[ST.sizer.device];
    w = preset.w; h = preset.h;
    isDevice = true;
    category = preset.category || "Desktop";
    notch = !!preset.notch;
  } else if (DEVICE_PRESETS[mode]) {
    const p = DEVICE_PRESETS[mode];
    w = p.w; h = p.h;
    category = p.category || "Quick";
    notch = !!p.notch;
  } else {
    w = 393; h = 852;
    category = "Phone";
  }
  if (rotated) [w, h] = [h, w];

  // Account for stage padding + device chrome so frame stays centered on all screens
  const stagePad = window.innerWidth <= 640 ? 16 : 24;
  const chromeExtra = category === "Laptop" ? (rotated ? 24 : 28) : (category === "Phone" || category === "Tablet" ? 12 : 8);
  const availW = Math.max(100, (stage.clientWidth || stage.offsetWidth || 320) - stagePad - chromeExtra);
  const availH = Math.max(100, (stage.clientHeight || stage.offsetHeight || 480) - stagePad - chromeExtra);
  const scale = Math.min(1, availW / w, availH / h);
  ST.sizer.scale = scale;

  const fw = Math.max(80, Math.round(w * scale));
  const fh = Math.max(80, Math.round(h * scale));
  frame.style.width = fw + "px";
  frame.style.height = fh + "px";
  frame.style.maxWidth = "100%";
  frame.style.maxHeight = "none";
  frame.setAttribute("data-device", isDevice ? "true" : "false");
  frame.setAttribute("data-category", category);
  if (notch) frame.setAttribute("data-notch", "true");
  else frame.removeAttribute("data-notch");

  // Laptop base margin is handled by CSS; keep JS margin only as scale-aware tweak on large scales
  if (category === "Laptop" && !rotated && scale > 0.5) {
    frame.style.marginBottom = Math.round(16 * Math.min(1, scale)) + "px";
  } else if (category === "Laptop" && rotated && scale > 0.5) {
    frame.style.marginLeft = Math.round(16 * Math.min(1, scale)) + "px";
  }

  const readout = $("#fpReadout");
  if (readout) readout.textContent = `${w} × ${h}${scale < 0.99 ? " · " + Math.round(scale * 100) + "%" : ""}`;
  renderRuler();
  updateRotateMenuIcon();
}

function renderRuler() {
  const ruler = $("#fpRuler");
  if (!ruler) return;
  ruler.innerHTML = "";
  if (!ST.settings.showBreakpointRuler) return;
  const marks = [320, 375, 414, 768, 1024, 1280, 1440, 1920];
  const stageW = ST.stageEl.clientWidth;
  const frameW = ST.frameEl.offsetWidth;
  for (const m of marks) {
    if (m > frameW) continue;
    const pct = (m / frameW) * 100;
    const mark = el("div", { class: "fp-ruler-mark", style: { left: pct + "%" }, title: `${m}px` }, String(m));
    ruler.appendChild(mark);
  }
}

function rotate() {
  ST.sizer.rotated = !ST.sizer.rotated;
  try { localStorage.setItem(LS.rotated(ST.pid), ST.sizer.rotated ? "1" : "0"); } catch {}
  applySize(ST.sizer.mode, ST.sizer.custom);
  if (ST.fullscreen && ST.sizer.mode === "laptop" && ST.sizer.rotated) ST.frameEl.classList.add("fp-frame--edge");
  else ST.frameEl.classList.remove("fp-frame--edge");
  updateRotateMenuIcon();
}

function updateRotateMenuIcon() {
  const btn = document.querySelector('[data-more-action="rotate"]');
  if (!btn) return;
  const icon = ST.sizer.rotated
    ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M12 17v.01"/></svg>`
    : `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M17 12v.01"/></svg>`;
  const span = btn.querySelector("span");
  btn.innerHTML = icon + (span ? span.outerHTML : "<span>Rotate</span>");
  btn.title = ST.sizer.rotated ? "Currently portrait — click for landscape" : "Currently landscape — click for portrait";
}

// ─────────────────────────────────────────────────────────────────
//  SOURCE
// ─────────────────────────────────────────────────────────────────
function setSource(source) {
  ST.source = source;
  ST.isCrossOrigin = source.kind === "url";
  ST.bridgeReady = false;
  if (source.kind === "url" && source.url) loadUrl(source.url);
  else loadProjectFile();
}

function setPreviewLoading(show, message) {
  const el = $("#fpLoading");
  if (!el) return;
  el.setAttribute("data-show", show ? "true" : "false");
  el.setAttribute("aria-hidden", show ? "false" : "true");
  const text = el.querySelector(".fp-loading-text");
  if (text && message) text.textContent = message;
}

async function loadUrl(url) {
  const iframe = ST.iframeEl;
  setPreviewLoading(true, "Loading page…");
  iframe.removeAttribute("srcdoc");
  const onDone = () => {
    setPreviewLoading(false);
    try {
      const sameOrigin = iframe.contentDocument != null;
      if (!sameOrigin) disableBridgeSections("Cross-origin — inspect disabled");
    } catch { disableBridgeSections("Cross-origin — inspect disabled"); }
  };
  iframe.addEventListener("load", onDone, { once: true });
  iframe.addEventListener("error", () => {
    setPreviewLoading(false);
    toast("Failed to load URL", "error");
  }, { once: true });
  // Safety timeout so spinner never sticks
  const timeout = setTimeout(() => setPreviewLoading(false), 15000);
  iframe.addEventListener("load", () => clearTimeout(timeout), { once: true });
  iframe.src = url;
}

async function loadProjectFile() {
  if (typeof ST.hooks.getProjectFiles !== "function") return;
  setPreviewLoading(true, "Building preview…");
  try {
    const files = await ST.hooks.getProjectFiles();
    const active = (files || []).find(f => f.path === ST.source.file);
    if (!active) { setPreviewLoading(false); return; }
    const ext = (ST.source.file.split(".").pop() || "").toLowerCase();
    const renderer = pickRenderer(ST.source.file);
    if (renderer && !["html", "htm"].includes(ext)) {
      ST.iframeEl.srcdoc = renderer(active.content, active.path, files);
    } else {
      ST.iframeEl.srcdoc = inlineProject(active.content, files);
    }
  } finally {
    // iframe srcdoc loads sync-ish; hide after a short beat so spinner is visible
    setTimeout(() => setPreviewLoading(false), 180);
  }
}

function inlineProject(html, files) {
  const byPath = new Map((files || []).map(f => [f.path, f]));
  let out = html;
  out = out.replace(/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/gi, (m, href) => {
    const f = byPath.get(href.replace(/^\.?\//, ""));
    return f ? `<style>${f.content}</style>` : m;
  });
  out = out.replace(/<script[^>]+src=["']([^"']+\.js)["'][^>]*><\/script>/gi, (m, src) => {
    const f = byPath.get(src.replace(/^\.?\//, ""));
    return f ? `<script>${f.content}<\/script>` : m;
  });
  out = out.replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, (m, src) => {
    const f = byPath.get(src.replace(/^\.?\//, ""));
    if (!f) return m;
    if (/^data:/.test(f.content)) return m.replace(src, f.content);
    return m;
  });
  const bridgeTag = `<script>${BRIDGE_SCRIPT}<\/script>`;
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, bridgeTag + "</body>");
  else out += bridgeTag;
  return out;
}

function disableBridgeSections(reason) {
  for (const id of ["console", "network", "dom", "a11y", "responsive", "assets", "devtools", "editor"]) {
    const sec = ST.sectionsEl.querySelector(`[data-section="${id}"]`);
    if (sec) sec.setAttribute("data-disabled", "true");
  }
  toast(reason, "warning");
}

// ─────────────────────────────────────────────────────────────────
//  DIALOGS
// ─────────────────────────────────────────────────────────────────
function showDialog({ title, subtitle, body, size = "normal", footer, onClose, showCancel = true }) {
  closeDialog();
  const backdrop = el("div", { class: "fp-dialog-backdrop", "data-open": "false" });
  const dialog = el("div", { class: `fp-dialog${size === "wide" ? " wide" : size === "narrow" ? " narrow" : ""}` });
  const head = el("div", { class: "fp-dialog-head" });
  head.innerHTML = `
    <div style="flex:1;min-width:0">
      <div class="fp-dialog-title">${escapeHtml(title || "")}</div>
      ${subtitle ? `<div class="fp-dialog-subtitle">${escapeHtml(subtitle)}</div>` : ""}
    </div>
    <button class="fp-dialog-close" type="button" aria-label="Close">${svgIcon("x")}</button>
  `;
  head.querySelector(".fp-dialog-close").addEventListener("click", closeDialog);
  dialog.appendChild(head);
  const bodyEl = el("div", { class: "fp-dialog-body" });
  if (body instanceof Node) bodyEl.appendChild(body); else if (typeof body === "string") bodyEl.innerHTML = body;
  dialog.appendChild(bodyEl);
  const foot = el("div", { class: "fp-dialog-foot" });
  if (footer) {
    if (footer instanceof Node) foot.appendChild(footer);
    else if (Array.isArray(footer)) footer.forEach(n => foot.appendChild(n));
  }
  if (showCancel && !foot.querySelector("[data-dialog-cancel]")) {
    const cancelBtn = el("button", { class: "fp-dialog-btn", type: "button", "data-dialog-cancel": "true" }, "Cancel");
    cancelBtn.addEventListener("click", closeDialog);
    if (foot.firstChild) foot.insertBefore(cancelBtn, foot.firstChild);
    else foot.appendChild(cancelBtn);
  }
  if (foot.childNodes.length) dialog.appendChild(foot);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeDialog(); });
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  ST.dialog = { el: dialog, backdropEl: backdrop, open: true, onClose };
  requestAnimationFrame(() => backdrop.setAttribute("data-open", "true"));
  const trap = (e) => { if (e.key === "Escape") { e.preventDefault(); closeDialog(); } };
  document.addEventListener("keydown", trap);
  dialog._trap = trap;
  return dialog;
}

function closeDialog() {
  if (!ST.dialog.open) return;
  const { backdropEl, onClose, el: dialogEl } = ST.dialog;
  if (dialogEl?._trap) document.removeEventListener("keydown", dialogEl._trap);
  backdropEl.setAttribute("data-open", "false");
  setTimeout(() => backdropEl.remove(), 250);
  ST.dialog = { el: null, backdropEl: null, open: false };
  if (onClose) onClose();
}

function showSettings() {
  const s = ST.settings;
  const body = el("div");
  const tab = (label, key) => el("button", { class: "fp-tab", "data-tab": key, type: "button" }, label);

  body.appendChild(el("div", { class: "fp-tabs" },
    tab("General", "general"), tab("Screenshots", "screenshots"),
    tab("Console", "console"), tab("Dev editor", "deveditor"), tab("Advanced", "advanced")
  ));

  const content = el("div");
  body.appendChild(content);

  const tabContents = {
    general: el("div", { class: "fp-tab-content active", "data-tab-content": "general" }),
    screenshots: el("div", { class: "fp-tab-content", "data-tab-content": "screenshots" }),
    console: el("div", { class: "fp-tab-content", "data-tab-content": "console" }),
    deveditor: el("div", { class: "fp-tab-content", "data-tab-content": "deveditor" }),
    advanced: el("div", { class: "fp-tab-content", "data-tab-content": "advanced" }),
  };
  for (const tc of Object.values(tabContents)) content.appendChild(tc);

  // General
  const g = tabContents.general;
  g.appendChild(createSelect("Dock position", [{ v: "bottom", l: "Bottom" }, { v: "right", l: "Right" }], s.dockPosition, v => { s.dockPosition = v; saveSettings(); }));
  g.appendChild(createSelect("Theme", [{ v: "auto", l: "Auto" }, { v: "dark", l: "Dark" }, { v: "light", l: "Light" }], s.theme, v => { s.theme = v; saveSettings(); }));
  g.appendChild(createSelect("Reduced motion", [{ v: "system", l: "System" }, { v: "true", l: "On" }, { v: "false", l: "Off" }], s.reducedMotion, v => { s.reducedMotion = v; saveSettings(); }));
  g.appendChild(createSlider("Animation speed", 0.5, 2, 0.1, s.animationSpeed, v => { s.animationSpeed = v; saveSettings(); }));
  g.appendChild(createToggle("Show breakpoint ruler", s.showBreakpointRuler, v => { s.showBreakpointRuler = v; saveSettings(); }));
  g.appendChild(createToggle("Auto refresh on save", s.autoRefreshOnSave, v => { s.autoRefreshOnSave = v; saveSettings(); }));

  // Screenshots
  const sc = tabContents.screenshots;
  sc.appendChild(createSelect("Format", [{ v: "png", l: "PNG" }, { v: "jpeg", l: "JPEG" }, { v: "webp", l: "WebP" }], s.screenshotFormat, v => { s.screenshotFormat = v; saveSettings(); }));
  sc.appendChild(createSlider("Quality", 0.5, 1, 0.05, s.screenshotQuality, v => { s.screenshotQuality = v; saveSettings(); }));
  sc.appendChild(createToggle("Download after capture", s.screenshotDownload, v => { s.screenshotDownload = v; saveSettings(); }));
  sc.appendChild(createToggle("Copy to clipboard", s.screenshotCopy, v => { s.screenshotCopy = v; saveSettings(); }));
  sc.appendChild(createToggle("Open annotator", s.screenshotAnnotate, v => { s.screenshotAnnotate = v; saveSettings(); }));

  // Console
  const co = tabContents.console;
  co.appendChild(createToggle("Auto-scroll", s.consoleAutoScroll, v => { s.consoleAutoScroll = v; saveSettings(); }));
  co.appendChild(createSlider("Max entries", 100, 2000, 100, s.consoleMaxEntries, v => { s.consoleMaxEntries = v; saveSettings(); }));
  co.appendChild(createToggle("Preserve network log", s.networkPreserveLog, v => { s.networkPreserveLog = v; saveSettings(); }));
  co.appendChild(createSelect("Eval mode", [{ v: "safe", l: "Safe" }, { v: "allow-eval", l: "Allow eval" }], s.evalMode, v => { s.evalMode = v; saveSettings(); }));

  // Dev editor
  const de = tabContents.deveditor;
  de.appendChild(createSlider("Font size", 10, 20, 1, s.devEditorFontSize, v => { s.devEditorFontSize = v; saveSettings(); }));
  de.appendChild(createToggle("Auto-apply changes", s.devEditorAutoApply, v => { s.devEditorAutoApply = v; saveSettings(); }));
  de.appendChild(createSlider("Auto-apply delay (ms)", 100, 1000, 50, s.devEditorAutoApplyDelay, v => { s.devEditorAutoApplyDelay = v; saveSettings(); }));
  de.appendChild(createToggle("Live CSS variable editing", s.liveCssVars, v => { s.liveCssVars = v; saveSettings(); }));
  de.appendChild(createToggle("Element picker", s.liveElementPicker, v => { s.liveElementPicker = v; saveSettings(); }));

  // Advanced
  const ad = tabContents.advanced;
  ad.appendChild(createToggle("Record mode", s.recordMode, v => { s.recordMode = v; saveSettings(); }));
  ad.appendChild(createToggle("Save history", s.saveHistory, v => { s.saveHistory = v; saveSettings(); }));
  ad.appendChild(createSlider("History limit", 5, 50, 5, s.historyLimit, v => { s.historyLimit = v; saveSettings(); }));
  ad.appendChild(createSelect("Throttle preset", [
    { v: "none", l: "None" }, { v: "4g", l: "4G" }, { v: "3g", l: "3G" }, { v: "slow-3g", l: "Slow 3G" }
  ], s.throttlePreset, v => { s.throttlePreset = v; saveSettings(); postToChild(REQ.SIMULATE_NETWORK, THROTTLE_PRESETS[v] || THROTTLE_PRESETS.none); }));

  body.querySelectorAll("[data-tab]").forEach(t => t.addEventListener("click", () => {
    body.querySelectorAll("[data-tab]").forEach(x => x.classList.toggle("active", x === t));
    Object.values(tabContents).forEach(tc => tc.classList.toggle("active", tc.dataset.tabContent === t.dataset.tab));
  }));

  const footer = el("div", { style: "display:flex;gap:8px;width:100%" });
  const resetBtn = el("button", { class: "fp-dialog-btn", type: "button" }, "Reset all");
  resetBtn.addEventListener("click", () => { Object.assign(ST.settings, DEFAULT_SETTINGS); saveSettings(); closeDialog(); showSettings(); toast("Settings reset", "success"); });
  const doneBtn = el("button", { class: "fp-dialog-btn primary", type: "button" }, "Done");
  doneBtn.addEventListener("click", () => { closeDialog(); toast("Settings saved", "success"); });
  footer.appendChild(resetBtn);
  footer.appendChild(doneBtn);

  showDialog({ title: "Settings", subtitle: "Customize the preview experience", body, footer, size: "wide" });
}

function createToggle(label, checked, onChange) {
  const wrap = el("label", { class: "fp-toggle" });
  wrap.innerHTML = `
    <div style="flex:1;min-width:0">
      <div class="fp-toggle-label">${escapeHtml(label)}</div>
    </div>
    <input type="checkbox" ${checked ? "checked" : ""}>
    <span class="fp-toggle-switch"></span>
  `;
  wrap.querySelector("input").addEventListener("change", e => onChange(e.target.checked));
  return wrap;
}

function createSlider(label, min, max, step, value, onChange) {
  const wrap = el("div", { class: "fp-field" });
  const labelEl = el("div", { class: "fp-field-label" }, label);
  const row = el("div", { class: "fp-slider-row" });
  const input = el("input", { type: "range", class: "fp-slider", min, max, step, value });
  const valueEl = el("span", { class: "fp-slider-value" }, String(value));
  input.addEventListener("input", e => { valueEl.textContent = e.target.value; });
  input.addEventListener("change", e => onChange(parseFloat(e.target.value)));
  row.appendChild(input);
  row.appendChild(valueEl);
  wrap.appendChild(labelEl);
  wrap.appendChild(row);
  return wrap;
}

function createSelect(label, options, value, onChange) {
  const wrap = el("div", { class: "fp-field" });
  wrap.appendChild(el("div", { class: "fp-field-label" }, label));
  const select = el("select", { class: "fp-select" });
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.v;
    o.textContent = opt.l;
    if (opt.v === value) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", e => onChange(e.target.value));
  wrap.appendChild(select);
  return wrap;
}

function showSourceDialog() {
  const kind = ST.source?.kind || "project";
  const body = el("div");
  body.innerHTML = `
    <div class="fp-field">
      <div class="fp-field-label">Preview source</div>
      <div class="fp-tabs" style="margin-bottom:14px">
        <button class="fp-tab ${kind === "project" ? "active" : ""}" data-source-kind="project" type="button">Project</button>
        <button class="fp-tab ${kind === "url" ? "active" : ""}" data-source-kind="url" type="button">URL</button>
      </div>
    </div>
    <div class="fp-field" id="fpSourceUrlField" style="${kind === "url" ? "" : "display:none"}">
      <div class="fp-field-label">URL</div>
      <input class="fp-input" id="fpSourceUrlInput" type="url" placeholder="https://example.com" value="${escapeHtml(ST.source?.url || "")}">
    </div>
    <div class="fp-field" id="fpSourceProjectField" style="${kind === "project" ? "" : "display:none"}">
      <div class="fp-field-label">Project file</div>
      <div style="margin-top:6px;font-family:var(--fp-mono);font-size:11px;color:var(--fp-accent)">${escapeHtml(ST.source?.file || "—")}</div>
    </div>
  `;
  const tabs = body.querySelectorAll("[data-source-kind]");
  const urlField = body.querySelector("#fpSourceUrlField");
  const projField = body.querySelector("#fpSourceProjectField");
  let selected = kind;
  tabs.forEach(tab => tab.addEventListener("click", () => {
    selected = tab.dataset.sourceKind;
    tabs.forEach(t => t.classList.toggle("active", t === tab));
    if (urlField) urlField.style.display = selected === "url" ? "" : "none";
    if (projField) projField.style.display = selected === "project" ? "" : "none";
  }));
  const applyBtn = el("button", { class: "fp-dialog-btn primary", type: "button" }, "Apply");
  applyBtn.addEventListener("click", () => {
    if (selected === "url") {
      const url = (body.querySelector("#fpSourceUrlInput")?.value || "").trim();
      if (!url) { toast("Enter a URL", "warning"); return; }
      setSource({ kind: "url", url });
    } else setSource({ kind: "project", file: ST.source?.file });
    closeDialog();
  });
  showDialog({ title: "Source", body, footer: [applyBtn], size: "narrow" });
}

function showCustomSizeDialog() {
  const body = el("div");
  const cw = ST.sizer.custom.w || 768;
  const ch = ST.sizer.custom.h || 1024;
  body.innerHTML = `
    <div class="fp-field">
      <div class="fp-field-label">Width (px)</div>
      <input class="fp-input" id="fpCustomW" type="number" min="${CUSTOM_MIN.w}" max="${CUSTOM_MAX.w}" value="${cw}" style="font-family:var(--fp-mono)">
      <div class="fp-field-hint">Min ${CUSTOM_MIN.w} · Max ${CUSTOM_MAX.w}</div>
    </div>
    <div class="fp-field">
      <div class="fp-field-label">Height (px)</div>
      <input class="fp-input" id="fpCustomH" type="number" min="${CUSTOM_MIN.h}" max="${CUSTOM_MAX.h}" value="${ch}" style="font-family:var(--fp-mono)">
      <div class="fp-field-hint">Min ${CUSTOM_MIN.h} · Max ${CUSTOM_MAX.h}</div>
    </div>
    <div class="fp-field">
      <div class="fp-field-label">Quick presets</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
        <button class="fp-chip" type="button" data-cw="360" data-ch="640">360×640</button>
        <button class="fp-chip" type="button" data-cw="768" data-ch="1024">768×1024</button>
        <button class="fp-chip" type="button" data-cw="1280" data-ch="720">1280×720</button>
        <button class="fp-chip" type="button" data-cw="1440" data-ch="900">1440×900</button>
        <button class="fp-chip" type="button" data-cw="1920" data-ch="1080">1920×1080</button>
      </div>
    </div>
  `;
  body.querySelectorAll("[data-cw]").forEach(btn => {
    btn.addEventListener("click", () => {
      body.querySelector("#fpCustomW").value = btn.dataset.cw;
      body.querySelector("#fpCustomH").value = btn.dataset.ch;
    });
  });
  const applyBtn = el("button", { class: "fp-dialog-btn primary", type: "button" }, "Apply size");
  applyBtn.addEventListener("click", () => {
    const w = clamp(parseInt(body.querySelector("#fpCustomW").value, 10) || 768, CUSTOM_MIN.w, CUSTOM_MAX.w);
    const h = clamp(parseInt(body.querySelector("#fpCustomH").value, 10) || 1024, CUSTOM_MIN.h, CUSTOM_MAX.h);
    ST.sizer.custom = { w, h };
    ST.sizer.mode = "custom";
    ST.sizer.device = null;
    $$(".fp-size-btn").forEach(b => b.classList.toggle("active", b.dataset.size === "custom"));
    const dims = $("#fpDims");
    if (dims) {
      dims.hidden = false;
      const wEl = $("#fpDimsW"), hEl = $("#fpDimsH");
      if (wEl) wEl.value = w;
      if (hEl) hEl.value = h;
    }
    applySize("custom", ST.sizer.custom);
    try { localStorage.setItem(LS.size(ST.pid), "custom"); } catch {}
    closeDialog();
    toast(`${w} × ${h}`, "success");
  });
  showDialog({ title: "Custom size", subtitle: "Set exact viewport dimensions", body, footer: [applyBtn], size: "narrow" });
}

function showDevicesDialog() {
  const body = el("div");
  const categories = ["Phone", "Tablet", "Laptop", "Desktop", "Quick"];
  for (const cat of categories) {
    const catWrap = el("div", { class: "fp-device-cat" });
    catWrap.appendChild(el("div", { class: "fp-device-cat-title" }, cat));
    const grid = el("div", { class: "fp-device-grid" });
    for (const [key, preset] of Object.entries(DEVICE_PRESETS)) {
      if (preset.category !== cat) continue;
      const btn = el("button", {
        class: `fp-device-btn${ST.sizer.device === key ? " active" : ""}`,
        type: "button",
        onclick: () => {
          ST.sizer.device = key;
          ST.sizer.mode = "device";
          applySize("device");
          closeDialog();
          toast(`Switched to ${preset.label}`, "success");
        },
      });
      btn.appendChild(el("div", { class: "fp-device-btn-name" }, preset.label));
      btn.appendChild(el("div", { class: "fp-device-btn-dims" }, `${preset.w}×${preset.h} · ${preset.dpr}x`));
      grid.appendChild(btn);
    }
    catWrap.appendChild(grid);
    body.appendChild(catWrap);
  }
  showDialog({ title: "Devices", subtitle: "Pick a preset to resize", body, size: "wide" });
}

function showSnippetsDialog() {
  let snippets = [];
  try { snippets = JSON.parse(localStorage.getItem(LS.snippets) || "[]"); } catch {}
  const body = el("div");
  const list = el("div", { class: "fp-list" });
  if (!snippets.length) list.innerHTML = `<div class="fp-empty">No snippets saved yet</div>`;
  else for (const snip of snippets) {
    const item = el("div", { class: "fp-list-item" },
      el("span", { class: "fp-list-item-icon", html: svgIcon("snippets") }),
      el("div", { class: "fp-list-item-info" },
        el("div", { class: "fp-list-item-title" }, snip.name),
        el("div", { class: "fp-list-item-desc" }, snip.code.slice(0, 60))
      )
    );
    item.addEventListener("click", () => { if (typeof ST.hooks.onInsertSnippet === "function") ST.hooks.onInsertSnippet(snip.code); else toast("Snippet ready", "info"); closeDialog(); });
    list.appendChild(item);
  }
  body.appendChild(list);

  const addBtn = el("button", { class: "fp-dialog-btn", type: "button" }, "+ New snippet");
  addBtn.addEventListener("click", () => {
    const name = prompt("Snippet name");
    if (!name) return;
    const code = prompt("Snippet code");
    if (!code) return;
    snippets.push({ name, code });
    localStorage.setItem(LS.snippets, JSON.stringify(snippets));
    closeDialog(); showSnippetsDialog();
  });
  const clearBtn = el("button", { class: "fp-dialog-btn danger", type: "button" }, "Clear all");
  clearBtn.addEventListener("click", () => { snippets = []; localStorage.setItem(LS.snippets, "[]"); closeDialog(); showSnippetsDialog(); });

  showDialog({ title: "Snippets", subtitle: `${snippets.length} saved`, body, footer: [clearBtn, addBtn] });
}

function showHistoryDialog() {
  const body = el("div");
  let history = [];
  try { history = JSON.parse(localStorage.getItem(LS.history(ST.pid)) || "[]"); } catch {}
  if (!history.length) body.innerHTML = `<div class="fp-empty">No history yet — refresh to create a snapshot</div>`;
  else {
    const list = el("div", { class: "fp-list" });
    for (const snap of history.slice(0, 20)) {
      const item = el("div", { class: "fp-list-item" },
        el("span", { class: "fp-list-item-icon", html: svgIcon("history") }),
        el("div", { class: "fp-list-item-info" },
          el("div", { class: "fp-list-item-title" }, new Date(snap.ts).toLocaleString()),
          el("div", { class: "fp-list-item-desc" }, snap.label || "Snapshot")
        ),
        el("button", { class: "fp-chip", type: "button" }, "Restore")
      );
      item.querySelector(".fp-chip").addEventListener("click", async () => {
        if (snap.html) {
          ST.iframeEl.srcdoc = snap.html;
          toast("Snapshot restored", "success");
          closeDialog();
        }
      });
      list.appendChild(item);
    }
    body.appendChild(list);
  }
  showDialog({ title: "History", subtitle: `${history.length} snapshots`, body });
}

// ─────────────────────────────────────────────────────────────────
//  DEV EDITOR
// ─────────────────────────────────────────────────────────────────
async function openDevEditor() {
  if (ST.devEditor.open) return;
  const overlay = el("div", { class: "fp-deveditor" });
  overlay.innerHTML = `
    <div class="fp-deveditor-head">
      <div class="fp-deveditor-title">${svgIcon("code")} Live code</div>
      <select class="fp-deveditor-file" id="fpDevFileSelect" aria-label="File"></select>
      <label class="fp-deveditor-autoapply">
        <input type="checkbox" id="fpDevAutoApply" ${ST.settings.devEditorAutoApply ? "checked" : ""}> Auto-apply
      </label>
      <button class="fp-dialog-btn" id="fpDevApply" type="button">${svgIcon("refresh")} Apply</button>
      <button class="fp-dialog-btn primary" id="fpDevPush" type="button">${svgIcon("upload")} Push to project</button>
      <button class="fp-dialog-btn" id="fpDevClose" type="button">${svgIcon("x")}</button>
    </div>
    <div class="fp-deveditor-body" id="fpDevBody"></div>
  `;
  document.body.appendChild(overlay);
  ST.devEditor.overlay = overlay;

  const select = $("#fpDevFileSelect", overlay);
  const files = await loadEditableFiles();
  for (const f of files) {
    const opt = document.createElement("option");
    opt.value = f.path;
    opt.textContent = f.path;
    if (f.path === ST.source.file) opt.selected = true;
    select.appendChild(opt);
  }

  const body = $("#fpDevBody", overlay);
  const first = files.find(f => f.path === ST.source.file) || files[0];
  if (first) {
    ST.devEditor.activeFile = first.path;
    await mountDevEditor(body, first.content, first.path);
  } else body.innerHTML = `<div class="fp-empty">No editable files</div>`;

  select.addEventListener("change", async () => {
    const f = files.find(x => x.path === select.value);
    if (!f) return;
    ST.devEditor.activeFile = f.path;
    await mountDevEditor(body, f.content, f.path);
  });

  $("#fpDevClose", overlay).addEventListener("click", closeDevEditor);
  $("#fpDevApply", overlay).addEventListener("click", () => applyDevEdit());
  $("#fpDevPush", overlay).addEventListener("click", () => pushDevEdit());
  $("#fpDevAutoApply", overlay).addEventListener("change", e => { ST.devEditor.autoApply = e.target.checked; });
  ST.devEditor.open = true;
}

function closeDevEditor() {
  if (!ST.devEditor.open) return;
  try { ST.devEditor.view?.destroy?.(); } catch {}
  ST.devEditor.overlay?.remove();
  ST.devEditor.view = null;
  ST.devEditor.overlay = null;
  ST.devEditor.open = false;
  ST.devEditor.dirty = false;
}

async function mountDevEditor(container, content, path) {
  container.innerHTML = "";
  try {
    const mod = await import("codemirror/codemirror/dist/index.js");
    const theme = await import("codemirror/theme-one-dark/dist/index.js");
    const langMod = await langFor(path);
    const view = new mod.EditorView({
      doc: content || "",
      extensions: [
        mod.basicSetup,
        theme.oneDark,
        ...(langMod ? [langMod] : []),
        mod.EditorView.theme({ "&": { fontSize: (ST.settings.devEditorFontSize || 13) + "px" }, ".cm-content": { fontSize: (ST.settings.devEditorFontSize || 13) + "px" } }),
        mod.EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            ST.devEditor.dirty = true;
            if (ST.devEditor.autoApply) debounce(() => applyDevEdit(true), ST.settings.devEditorAutoApplyDelay)();
          }
        }),
      ],
      parent: container,
    });
    ST.devEditor.view = view;
  } catch (err) {
    container.innerHTML = `<div class="fp-empty">Editor failed: ${escapeHtml(err.message)}</div>`;
  }
}

async function langFor(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  try {
    if (ext === "html" || ext === "htm") return (await import("codemirror/lang-html/dist/index.js")).html();
    if (ext === "css") return (await import("codemirror/lang-css/dist/index.js")).css();
    if (["js", "mjs", "jsx", "ts", "tsx"].includes(ext)) return (await import("codemirror/lang-javascript/dist/index.js")).javascript();
    if (ext === "json") return (await import("codemirror/lang-json/dist/index.js")).json();
    if (["md", "markdown"].includes(ext)) return (await import("codemirror/lang-markdown/dist/index.js")).markdown();
  } catch {}
  return null;
}

async function loadEditableFiles() {
  if (typeof ST.hooks.getProjectFiles !== "function") return [];
  const files = await ST.hooks.getProjectFiles();
  return (files || []).filter(f => /\.(html?|css|js|mjs|jsx|tsx?|json|md|svg|txt)$/i.test(f.path));
}

function applyDevEdit(silent = false) {
  if (!ST.devEditor.view || !ST.devEditor.activeFile) return;
  const content = ST.devEditor.view.state.doc.toString();
  const path = ST.devEditor.activeFile;
  const kind = path.split(".").pop().toLowerCase();
  if (ST.bridgeReady && ST.source.kind === "project") {
    postToChild(REQ.PATCH, { path, content, kind });
    if (!silent) toast("Applied to preview", "success");
  } else if (ST.source.kind === "url") {
    if (!silent) toast("Live patch not available for cross-origin URLs", "warning");
  }
}

async function pushDevEdit() {
  if (!ST.devEditor.view || !ST.devEditor.activeFile) return;
  if (typeof ST.hooks.onPushFile !== "function") { toast("Push not wired by host", "error"); return; }
  const content = ST.devEditor.view.state.doc.toString();
  const path = ST.devEditor.activeFile;
  const ok = await ST.hooks.onPushFile(path, content);
  if (ok) { ST.devEditor.dirty = false; toast(`Pushed ${path}`, "success"); emit("patch", { path, content }); }
  else toast("Push failed", "error");
}

// ─────────────────────────────────────────────────────────────────
//  SCREENSHOT + ANNOTATOR
// ─────────────────────────────────────────────────────────────────
async function takeScreenshot({ download = ST.settings.screenshotDownload, toClipboard = ST.settings.screenshotCopy, annotate = ST.settings.screenshotAnnotate, filename } = {}) {
  try {
    const frame = ST.frameEl;
    const w = frame.offsetWidth;
    const h = frame.offsetHeight;
    let dataUrl = null;
    if (ST.source.kind === "project" && ST.bridgeReady) {
      dataUrl = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 6000);
        const handler = (e) => {
          if (!e.data || e.data.__folio !== true) return;
          if (e.data.type === MSG.SCREENSHOT_DATA) {
            clearTimeout(timeout);
            window.removeEventListener("message", handler);
            resolve(e.data.dataUrl);
          }
        };
        window.addEventListener("message", handler);
        postToChild(REQ.SCREENSHOT, { width: w, height: h });
      });
    }
    if (!dataUrl) {
      try { const canvas = await renderIframeToCanvas(ST.iframeEl, w, h); dataUrl = canvas.toDataURL("image/png"); } catch {}
    }
    if (!dataUrl) { toast("Screenshot failed", "error"); return; }
    if (annotate) openAnnotator(dataUrl, { download, toClipboard, filename });
    else await saveScreenshot(dataUrl, { download, toClipboard, filename });
  } catch (err) { toast("Screenshot failed: " + err.message, "error"); }
}

async function renderIframeToCanvas(iframe, w, h) {
  const doc = iframe.contentDocument;
  if (!doc) throw new Error("cross-origin");
  const html = doc.documentElement.outerHTML;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px">${html}</div></foreignObject></svg>`;
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);
  return canvas;
}

async function saveScreenshot(dataUrl, { download, toClipboard, filename }) {
  emit("screenshot", { dataUrl });
  if (toClipboard) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      toast("Screenshot copied", "success");
    } catch { toast("Copy failed", "error"); }
  }
  if (download) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename || `preview-${Date.now()}.png`;
    a.click();
    toast("Screenshot saved", "success");
  }
}

function openAnnotator(dataUrl, { download, toClipboard, filename }) {
  const overlay = el("div", { class: "fp-annotator", "data-open": "false" });
  overlay.innerHTML = `
    <div class="fp-annotator-head">
      <div class="fp-annotator-title">Annotate screenshot</div>
      <div class="fp-annotator-tools">
        <button class="fp-annotator-tool active" data-tool="box" type="button" title="Box">${svgIcon("box")}</button>
        <button class="fp-annotator-tool" data-tool="arrow" type="button" title="Arrow">${svgIcon("arrowRight")}</button>
        <button class="fp-annotator-tool" data-tool="blur" type="button" title="Blur">${svgIcon("blur")}</button>
      </div>
      <button class="fp-dialog-close" id="fpAnnClose" type="button">${svgIcon("x")}</button>
    </div>
    <div class="fp-annotator-canvas-wrap">
      <div class="fp-annotator-canvas" id="fpAnnCanvas">
        <img id="fpAnnImg" src="${dataUrl}">
        <canvas class="fp-annotator-layer" id="fpAnnLayer"></canvas>
      </div>
    </div>
    <div class="fp-annotator-actions">
      <button class="fp-dialog-btn" id="fpAnnCancel" type="button">Cancel</button>
      <button class="fp-dialog-btn primary" id="fpAnnSave" type="button">Save</button>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.setAttribute("data-open", "true"));

  const img = $("#fpAnnImg", overlay);
  const layer = $("#fpAnnLayer", overlay);
  const canvasWrap = $("#fpAnnCanvas", overlay);
  let ctx;
  img.onload = () => {
    layer.width = img.width;
    layer.height = img.height;
    ctx = layer.getContext("2d");
  };

  let tool = "box", drawing = false, startX = 0, startY = 0, curX = 0, curY = 0;
  const annotations = [];

  overlay.querySelectorAll("[data-tool]").forEach(btn => btn.addEventListener("click", () => {
    overlay.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("active", b === btn));
    tool = btn.dataset.tool;
  }));

  layer.addEventListener("pointerdown", (e) => {
    const r = layer.getBoundingClientRect();
    drawing = true;
    startX = (e.clientX - r.left) * (layer.width / r.width);
    startY = (e.clientY - r.top) * (layer.height / r.height);
    curX = startX; curY = startY;
  });
  layer.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const r = layer.getBoundingClientRect();
    curX = (e.clientX - r.left) * (layer.width / r.width);
    curY = (e.clientY - r.top) * (layer.height / r.height);
    drawAll();
  });
  layer.addEventListener("pointerup", () => {
    if (!drawing) return;
    drawing = false;
    annotations.push({ tool, x1: startX, y1: startY, x2: curX, y2: curY });
    drawAll();
  });

  function drawAll() {
    if (!ctx) return;
    ctx.clearRect(0, 0, layer.width, layer.height);
    for (const a of annotations) drawShape(a);
    if (drawing) drawShape({ tool, x1: startX, y1: startY, x2: curX, y2: curY });
  }

  function drawShape({ tool, x1, y1, x2, y2 }) {
    ctx.strokeStyle = "#F59E0B";
    ctx.fillStyle = "rgba(245,158,11,0.15)";
    ctx.lineWidth = 3;
    if (tool === "box") {
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    } else if (tool === "arrow") {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = 16;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    } else if (tool === "blur") {
      ctx.fillStyle = "rgba(80,80,80,0.85)";
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    }
  }

  function close() { overlay.setAttribute("data-open", "false"); setTimeout(() => overlay.remove(), 250); }
  $("#fpAnnClose", overlay).addEventListener("click", close);
  $("#fpAnnCancel", overlay).addEventListener("click", close);
  $("#fpAnnSave", overlay).addEventListener("click", async () => {
    const finalCanvas = document.createElement("canvas");
    finalCanvas.width = img.width; finalCanvas.height = img.height;
    const finalCtx = finalCanvas.getContext("2d");
    finalCtx.drawImage(img, 0, 0);
    finalCtx.drawImage(layer, 0, 0);
    const finalUrl = finalCanvas.toDataURL("image/png");
    await saveScreenshot(finalUrl, { download, toClipboard, filename });
    close();
  });
}

// ─────────────────────────────────────────────────────────────────
//  COMMAND PALETTE
// ─────────────────────────────────────────────────────────────────
function openPalette() {
  if (ST.palette.open) return;
  const backdrop = el("div", { class: "fp-palette-backdrop", "data-open": "false" });
  backdrop.innerHTML = `
    <div class="fp-palette">
      <div class="fp-palette-input-wrap">
        ${svgIcon("search")}
        <input class="fp-palette-input" id="fpPaletteInput" placeholder="Type a command…" autocomplete="off">
        <span class="fp-palette-hint">Esc</span>
      </div>
      <div class="fp-palette-results" id="fpPaletteResults"></div>
    </div>
  `;
  document.body.appendChild(backdrop);
  ST.palette.open = true;
  requestAnimationFrame(() => backdrop.setAttribute("data-open", "true"));

  const input = $("#fpPaletteInput", backdrop);
  const results = $("#fpPaletteResults", backdrop);
  let activeIndex = 0;

  const COMMANDS = [
    { group: "Layout", icon: "devices", label: "Open devices", desc: "Switch device preset", action: showDevicesDialog },
    { group: "Layout", icon: "rotate", label: "Rotate", desc: "Toggle orientation", action: rotate },
    { group: "Layout", icon: "expand", label: "Fullscreen", desc: "Toggle fullscreen", action: toggleFullscreen },
    { group: "Layout", icon: "history", label: "History", desc: "Restore a snapshot", action: showHistoryDialog },
    { group: "Panel", icon: "warn", label: "Open Console", desc: "Show console output", action: () => openSection("console") },
    { group: "Panel", icon: "globe", label: "Open Network", desc: "Show network requests", action: () => openSection("network") },
    { group: "Panel", icon: "file", label: "Open Assets", desc: "Dependency analysis", action: () => openSection("assets") },
    { group: "Panel", icon: "ruler", label: "Open Responsive", desc: "Layout scan", action: () => openSection("responsive") },
    { group: "Panel", icon: "zap", label: "Open Performance", desc: "Vitals + payload", action: () => openSection("performance") },
    { group: "Panel", icon: "code", label: "Open DOM", desc: "Inspect DOM tree", action: () => openSection("dom") },
    { group: "Panel", icon: "shield", label: "Open Accessibility", desc: "A11y scan", action: () => openSection("a11y") },
    { group: "Panel", icon: "database", label: "Open Storage", desc: "localStorage / sessionStorage", action: () => openSection("storage") },
    { group: "Panel", icon: "search", label: "Open Search", desc: "Search across files", action: () => openSection("search") },
    { group: "Panel", icon: "tool", label: "Open Dev Tools", desc: "Advanced actions", action: () => openSection("devtools") },
    { group: "Actions", icon: "camera", label: "Screenshot", desc: "Capture the frame", action: () => takeScreenshot() },
    { group: "Actions", icon: "code", label: "Live code editor", desc: "Edit and push changes", action: openDevEditor },
    { group: "Actions", icon: "snippets", label: "Snippets", desc: "Manage snippets", action: showSnippetsDialog },
    { group: "Actions", icon: "settings", label: "Settings", desc: "Preview preferences", action: showSettings },
    { group: "Actions", icon: "refresh", label: "Refresh", desc: "Reload preview", action: refresh },
    { group: "Actions", icon: "x", label: "Close", desc: "Close preview", action: () => close() },
  ];

  function renderResults(q) {
    const filtered = q ? COMMANDS.filter(c => (c.label + " " + c.desc).toLowerCase().includes(q.toLowerCase())) : COMMANDS;
    activeIndex = 0;
    results.innerHTML = "";
    let currentGroup = null;
    filtered.forEach((cmd, i) => {
      if (cmd.group !== currentGroup) { results.appendChild(el("div", { class: "fp-palette-group-label" }, cmd.group)); currentGroup = cmd.group; }
      const item = el("div", { class: "fp-palette-item", "data-active": i === activeIndex ? "true" : "false" });
      item.innerHTML = `
        <span class="fp-palette-item-icon">${svgIcon(cmd.icon)}</span>
        <div style="flex:1;min-width:0">
          <div class="fp-palette-item-label">${escapeHtml(cmd.label)}</div>
          <div class="fp-palette-item-desc">${escapeHtml(cmd.desc)}</div>
        </div>
      `;
      item.addEventListener("click", () => { closePalette(); cmd.action(); });
      results.appendChild(item);
    });
    if (!filtered.length) results.innerHTML = `<div class="fp-empty">No commands</div>`;
  }
  renderResults("");

  input.addEventListener("input", () => renderResults(input.value));
  input.addEventListener("keydown", (e) => {
    const items = results.querySelectorAll(".fp-palette-item");
    if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(items.length - 1, activeIndex + 1); updateActive(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(0, activeIndex - 1); updateActive(); }
    else if (e.key === "Enter") { e.preventDefault(); items[activeIndex]?.click(); }
    else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  });
  function updateActive() { items => {}; results.querySelectorAll(".fp-palette-item").forEach((it, i) => it.setAttribute("data-active", i === activeIndex ? "true" : "false")); }
  setTimeout(() => input.focus(), 50);

  function closePalette() { backdrop.setAttribute("data-open", "false"); setTimeout(() => backdrop.remove(), 250); ST.palette.open = false; }
  ST.palette.close = closePalette;
}

// ─────────────────────────────────────────────────────────────────
//  WIRING
// ─────────────────────────────────────────────────────────────────
function wireHeader() {
  const on = (id, fn) => { const n = $(id); if (n) n.addEventListener("click", fn); };
  on("#fpBtnClose", () => close());
  on("#fpBtnFullscreen", () => toggleFullscreen());
  on("#fpFsExit", () => { if (ST.fullscreen) toggleFullscreen(); });

  const moreWrap = $("#fpMoreWrap");
  const moreBtn = $("#fpBtnMore");
  const moreMenu = $("#fpMoreMenu");
  const closeMore = () => {
    if (!moreMenu || !moreBtn) return;
    moreMenu.setAttribute("data-open", "false");
    moreBtn.setAttribute("aria-expanded", "false");
  };
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = moreMenu.getAttribute("data-open") === "true";
      moreMenu.setAttribute("data-open", open ? "false" : "true");
      moreBtn.setAttribute("aria-expanded", open ? "false" : "true");
    });
    moreMenu.querySelectorAll("[data-more-action]").forEach(item => {
      item.addEventListener("click", () => {
        const a = item.dataset.moreAction;
        closeMore();
        if (a === "source") showSourceDialog();
        else if (a === "devices") showDevicesDialog();
        else if (a === "rotate") rotate();
        else if (a === "screenshot") takeScreenshot();
        else if (a === "refresh") { refresh(); toast("Refreshed", "info"); }
        else if (a === "deveditor") openDevEditor();
        else if (a === "history") showHistoryDialog();
        else if (a === "settings") showSettings();
        else if (a === "palette") openPalette();
      });
    });
    document.addEventListener("click", (e) => {
      if (moreMenu.getAttribute("data-open") === "true" && moreWrap && !moreWrap.contains(e.target)) closeMore();
    });
  }

  $$(".fp-size-btn").forEach(btn => btn.addEventListener("click", () => {
    const size = btn.dataset.size;
    if (size === "custom") {
      showCustomSizeDialog();
      return;
    }
    $$(".fp-size-btn").forEach(b => b.classList.toggle("active", b === btn));
    ST.sizer.mode = size;
    ST.sizer.device = null;
    const dims = $("#fpDims");
    if (dims) dims.hidden = true;
    applySize(ST.sizer.mode, ST.sizer.custom);
    try { localStorage.setItem(LS.size(ST.pid), size); } catch {}
  }));

  const dimsW = $("#fpDimsW"), dimsH = $("#fpDimsH");
  if (dimsW) dimsW.addEventListener("input", () => { ST.sizer.custom.w = clamp(+dimsW.value, CUSTOM_MIN.w, CUSTOM_MAX.w); applySize("custom", ST.sizer.custom); });
  if (dimsH) dimsH.addEventListener("input", () => { ST.sizer.custom.h = clamp(+dimsH.value, CUSTOM_MIN.h, CUSTOM_MAX.h); applySize("custom", ST.sizer.custom); });

  document.addEventListener("keydown", (e) => {
    if (!ST.overlayEl || ST.overlayEl.getAttribute("data-open") !== "true") return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
    if (e.key === "Escape" && !ST.palette.open && !ST.dialog.open) {
      if (moreMenu?.getAttribute("data-open") === "true") { closeMore(); return; }
      if (ST.fullscreen) { toggleFullscreen(); return; }
      close();
    }
    if (e.key === "f" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); toggleFullscreen(); }
    if (e.key === "r" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); rotate(); }
  });

  window.addEventListener("resize", debounce(() => {
    if (ST.overlayEl?.getAttribute("data-open") === "true") applySize(ST.sizer.mode, ST.sizer.custom);
  }, 100));
}

function toggleFullscreen() {
  ST.fullscreen = !ST.fullscreen;
  ST.overlayEl.setAttribute("data-fullscreen", ST.fullscreen ? "true" : "false");
  try { localStorage.setItem(LS.fullscreen, ST.fullscreen ? "1" : "0"); } catch {}
  // Update button icon
  const btn = $("#fpBtnFullscreen");
  if (btn) {
    btn.innerHTML = ST.fullscreen
      ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>`
      : svgIcon("expand");
    btn.title = ST.fullscreen ? "Exit focus view (F)" : "Focus view (F)";
  }
  requestAnimationFrame(() => applySize(ST.sizer.mode, ST.sizer.custom));
}

// ─────────────────────────────────────────────────────────────────
//  HISTORY (saved snapshots)
// ─────────────────────────────────────────────────────────────────
function saveSnapshot(label) {
  if (!ST.settings.saveHistory) return;
  try {
    const key = LS.history(ST.pid);
    let history = JSON.parse(localStorage.getItem(key) || "[]");
    const html = ST.iframeEl.srcdoc || null;
    if (!html) return;
    history.unshift({ ts: Date.now(), label: label || "Manual snapshot", html });
    if (history.length > ST.settings.historyLimit) history = history.slice(0, ST.settings.historyLimit);
    localStorage.setItem(key, JSON.stringify(history));
    ST.history = history;
  } catch {}
}

// ─────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────
async function open(opts = {}) {
  injectStyles();
  loadSettings();
  ST.options = opts;
  ST.hooks = opts.hooks || {};
  ST.pid = opts.pid || null;
  ST.source = opts.source || { kind: "project", file: opts.file || null };

  if (!ST.rootEl) ST.rootEl = document.getElementById("previewRoot") || (() => { const r = document.createElement("div"); r.id = "previewRoot"; document.body.appendChild(r); return r; })();

  buildOverlay(ST.rootEl);
  buildSections();
  wireHeader();

  // restore prefs
  try {
    const size = localStorage.getItem(LS.size(ST.pid));
    if (size) { ST.sizer.mode = size; $$(".fp-size-btn").forEach(b => b.classList.toggle("active", b.dataset.size === size)); }
    ST.sizer.rotated = localStorage.getItem(LS.rotated(ST.pid)) === "1";
    ST.fullscreen = localStorage.getItem(LS.fullscreen) === "1";
  } catch {}
  ST.overlayEl.setAttribute("data-fullscreen", ST.fullscreen ? "true" : "false");

  window.addEventListener("message", handleMessage);

  applySize(ST.sizer.mode, ST.sizer.custom);
  setSource(ST.source);
  updateRotateMenuIcon();
  applySettings();

  // save initial snapshot
  setTimeout(() => saveSnapshot("Initial"), 600);

  // react to system theme when auto
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (ST.settings.theme === "auto") applySettings();
    });
  }

  requestAnimationFrame(() => { ST.overlayEl.setAttribute("data-open", "true"); emit("ready", { source: ST.source }); });
}

function close() {
  if (!ST.overlayEl) return;
  ST.overlayEl.setAttribute("data-open", "false");
  setTimeout(() => { ST.overlayEl?.setAttribute("data-open", "false"); }, 200);
  closeDevEditor();
  closeDialog();
  if (ST.palette.close) ST.palette.close();
  ST.iframeEl.src = "about:blank";
  emit("close");
}

function isOpen() { return ST.overlayEl?.getAttribute("data-open") === "true"; }

function refresh() {
  saveSnapshot("Before refresh");
  if (ST.source.kind === "url") loadUrl(ST.source.url);
  else loadProjectFile();
  ST.console.entries = [];
  ST.network.entries = [];
  ST.resources = [];
  ST.layoutShifts = [];
  ST.vitals = { lcp: null, fcp: null, cls: null };
  ST.dom.tree = null;
  ST.a11y.issues = null;
  ST.responsive.result = null;
  ST.assets = { html: [], css: [], js: [], json: [], images: [], external: [], scanning: false };
  updateSectionMeta();
}

// ─────────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────────
const API = {
  open, close, isOpen, refresh,
  setSource, getSource: () => ({ ...ST.source }),
  setSize: (mode) => {
    $$(".fp-size-btn").forEach(b => b.classList.toggle("active", b.dataset.size === mode));
    ST.sizer.mode = mode;
    ST.sizer.device = null;
    applySize(mode, ST.sizer.custom);
  },
  setCustomSize: (w, h) => {
    ST.sizer.custom = { w: clamp(w, CUSTOM_MIN.w, CUSTOM_MAX.w), h: clamp(h, CUSTOM_MIN.h, CUSTOM_MAX.h) };
    const wEl = $("#fpDimsW"), hEl = $("#fpDimsH");
    if (wEl) wEl.value = ST.sizer.custom.w;
    if (hEl) hEl.value = ST.sizer.custom.h;
    applySize("custom", ST.sizer.custom);
  },
  setDevice: (key) => { ST.sizer.device = key; applySize("device"); },
  rotate,
  toggleFullscreen,
  openSection, closeSection,
  openDevEditor, closeDevEditor,
  screenshot: takeScreenshot,
  showSettings, showDevicesDialog, showSnippetsDialog, showHistoryDialog,
  openPalette,
  on, off,
  setHooks(hooks) { ST.hooks = { ...ST.hooks, ...hooks }; },
  version: PREVIEW_VERSION,
  build: PREVIEW_BUILD,
  state: ST,
  templates: TEMPLATES,
};

if (typeof window !== "undefined") {
  window.__folioPreview = API;
  window.openPreview = open;
  window.closePreview = close;
  window.isPreviewOpen = isOpen;
}

export {
  open as openPreview,
  close as closePreview,
  isOpen as isPreviewOpen,
  API as previewAPI,
};