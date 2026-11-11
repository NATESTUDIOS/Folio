// js/preview.js
// ═══════════════════════════════════════════════════════════════════
//  Folio Preview Tools
//  ────────────────────────────────────────────────────────────────
//  Self-contained preview module. Owns:
//    - Full-screen preview overlay
//    - Sizing modes (Fit / Phone / Tablet / Laptop / Custom)
//    - Console (structured logs, filter, search, clear, REPL)
//    - Network (fetch/XHR log, filter, waterfall, detail)
//    - Responsive (viewport, overflow, touch targets, small text)
//    - Performance (Web Vitals, resource waterfall, payload budget)
//    - Files (loaded vs skipped)
//    - Storage (in-memory shim inspector)
//    - DOM (tree, inspect mode, highlight)
//    - Accessibility (alt, labels, contrast, hierarchy)
//    - Dev tools (eval, copy, simulate, reload)
//
//  index.html provides only:
//    - A mount point (<div id="previewRoot"></div>)
//    - A buildHtml callback (returns the assembled HTML)
//    - A listFiles callback (returns file metadata)
//    - An onOpenFile callback (jump to source)
//
//  Everything else — markup, styling, bridge injection, sizing,
//  tool panels — lives here.
// ═══════════════════════════════════════════════════════════════════

const PREVIEW_VERSION = "1.0.0";

// ── Sizing presets ──────────────────────────────────────────────
const SIZE_PRESETS = {
  phone:  { w: 393,  h: 852,  label: "Phone · 393×852",  chrome: 16, notch: true },
  tablet: { w: 820,  h: 1180, label: "Tablet · 820×1180", chrome: 16, notch: false },
  laptop: { w: 1440, h: 900,  label: "Laptop · 1440×900", chrome: 16, notch: false },
};
const CUSTOM_MIN = { w: 200, h: 200 };
const CUSTOM_MAX = { w: 3840, h: 2160 };

// ── Message types ───────────────────────────────────────────────
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
};

// ── Parent → child request types ────────────────────────────────
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
};

// ── Persistence keys ────────────────────────────────────────────
const LS_MODE = (pid) => `folio.preview.mode.${pid}`;
const LS_SIZE = (pid) => `folio.preview.size.${pid}`;
const LS_DOCK = "folio.preview.dock";       // dock height (px) last used
const LS_OPEN_SECTION = "folio.preview.open"; // last open section id

// ── Limits ──────────────────────────────────────────────────────
const LIMITS = {
  consoleEntries: 500,
  networkEntries: 500,
  a11yIssues: 50,
  responsiveIssues: 30,
  domNodes: 500,
  domDepth: 8,
};

// ═══════════════════════════════════════════════════════════════════
//  STYLES — injected once into <head>
// ═══════════════════════════════════════════════════════════════════
const PREVIEW_CSS = `
/* ── Overlay ─────────────────────────────────────────────── */
.fp-overlay{position:fixed;inset:0;z-index:950;background:var(--theme-bg,#0a0c10);display:flex;flex-direction:column;opacity:0;pointer-events:none;transition:opacity .18s var(--ease,cubic-bezier(.16,1,.3,1))}
.fp-overlay[data-open="true"]{opacity:1;pointer-events:auto}
.fp-overlay[data-open="false"]{display:none}

/* ── Header ──────────────────────────────────────────────── */
.fp-header{display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(20,22,28,.72);backdrop-filter:blur(20px) saturate(1.2);-webkit-backdrop-filter:blur(20px) saturate(1.2);border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0;min-height:52px}
.fp-title{font-size:13px;font-weight:800;color:var(--theme-text,#e8ecf1);letter-spacing:-.2px;margin-right:auto;display:flex;align-items:center;gap:8px}
.fp-title .fp-hint{font-size:10px;font-weight:500;color:var(--theme-text-tertiary,#8a919c)}
.fp-size-bar{display:flex;gap:3px;align-items:center;overflow-x:auto;padding:2px 4px;background:rgba(255,255,255,.04);border-radius:8px;border:1px solid rgba(255,255,255,.06);flex-shrink:0}
.fp-size-btn{padding:5px 9px;border-radius:6px;background:transparent;border:none;color:var(--theme-text-secondary,#a0a7b3);font-size:10.5px;font-weight:700;cursor:pointer;white-space:nowrap;transition:all .12s ease}
.fp-size-btn:hover{background:rgba(255,255,255,.06);color:var(--theme-text,#e8ecf1)}
.fp-size-btn.active{background:rgba(245,158,11,.16);color:#F59E0B;box-shadow:inset 0 0 0 1px rgba(245,158,11,.32)}
.fp-dims{display:flex;gap:4px;align-items:center;margin-left:6px;padding:0 8px;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:10.5px;color:var(--theme-text-tertiary,#8a919c)}
.fp-dims input{width:52px;height:22px;padding:0 5px;border-radius:4px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);color:var(--theme-text,#e8ecf1);font-family:inherit;font-size:10.5px;text-align:right;outline:none}
.fp-dims input:focus{border-color:#F59E0B;background:rgba(245,158,11,.08)}
.fp-acts{display:flex;gap:4px;align-items:center;flex-shrink:0}
.fp-btn{padding:6px 10px;border-radius:6px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);color:var(--theme-text-secondary,#a0a7b3);font-size:11px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:all .12s ease}
.fp-btn:hover{background:rgba(255,255,255,.1);color:var(--theme-text,#e8ecf1)}
.fp-btn.icon{padding:6px;width:28px;height:28px;justify-content:center}
.fp-btn svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}

/* ── Stage ───────────────────────────────────────────────── */
.fp-stage-wrap{flex:1;position:relative;overflow:hidden;background:repeating-conic-gradient(rgba(255,255,255,.02) 0% 25%,transparent 0% 50%) 50%/20px 20px;min-height:0}
.fp-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;transition:bottom .18s ease}
.fp-stage-wrap[data-dock-open="true"] .fp-stage{padding-bottom:16px}
.fp-frame{position:relative;background:#0a0c10;transform-origin:center center;transition:transform .2s ease,width .2s ease,height .2s ease;flex-shrink:0;margin:auto}
.fp-frame[data-device="true"]{border-radius:32px;border:8px solid #1a1a1a;box-shadow:0 24px 80px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.04)}
.fp-frame[data-device="true"]::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:120px;height:22px;background:#0a0c10;border-radius:0 0 14px 14px;z-index:1;pointer-events:none}
.fp-frame iframe{display:block;width:100%;height:100%;border:none;background:#fff}
.fp-frame[data-device="true"] iframe{border-radius:24px}

/* ── Resize handles ──────────────────────────────────────── */
.fp-resize{position:absolute;width:36px;height:36px;cursor:nwse-resize;z-index:3;touch-action:none;display:none;align-items:center;justify-content:center}
.fp-frame[data-mode="custom"] .fp-resize{display:flex}
.fp-resize[data-corner="br"]{bottom:-18px;right:-18px}
.fp-resize[data-corner="tl"]{top:-18px;left:-18px}
.fp-resize::after{content:'';width:12px;height:12px;border-radius:4px;background:#F59E0B;opacity:.55;box-shadow:0 0 0 2px rgba(10,12,16,.6);transition:opacity .12s}
.fp-resize:hover::after,.fp-resize:focus::after{opacity:1;outline:none}
.fp-readout{position:absolute;bottom:-46px;left:50%;transform:translateX(-50%);padding:5px 11px;border-radius:6px;background:rgba(20,22,28,.94);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.1);font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11px;font-weight:700;color:#F59E0B;white-space:nowrap;pointer-events:none;display:none}
.fp-frame[data-mode="custom"] .fp-readout{display:block}

/* ── Dock ────────────────────────────────────────────────── */
.fp-dock{position:absolute;left:0;right:0;bottom:0;z-index:10;background:rgba(20,22,28,.78);backdrop-filter:blur(28px) saturate(1.4);-webkit-backdrop-filter:blur(28px) saturate(1.4);border-top:1px solid rgba(255,255,255,.1);box-shadow:0 -12px 40px rgba(0,0,0,.45);display:flex;flex-direction:column;transition:height .2s ease;height:40px;overflow:hidden}
.fp-dock[data-expanded="true"]{height:min(70vh,560px)}
.fp-dock-grip{height:6px;cursor:ns-resize;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:transparent;transition:background .12s}
.fp-dock-grip:hover{background:rgba(255,255,255,.04)}
.fp-dock-grip::before{content:'';width:38px;height:3px;border-radius:2px;background:rgba(255,255,255,.18)}
.fp-sections{flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;min-height:0}
.fp-sections::-webkit-scrollbar{width:6px}
.fp-sections::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:3px}

/* ── Section ─────────────────────────────────────────────── */
.fp-sec{display:flex;flex-direction:column;border-bottom:1px solid rgba(255,255,255,.05)}
.fp-sec[data-hidden="true"]{display:none}
.fp-sec-head{display:flex;align-items:center;gap:9px;padding:9px 14px;background:transparent;border:none;width:100%;text-align:left;cursor:pointer;color:var(--theme-text-secondary,#a0a7b3);font-size:11.5px;font-weight:700;transition:all .12s ease;min-height:36px;font-family:inherit}
.fp-sec-head:hover{background:rgba(255,255,255,.04);color:var(--theme-text,#e8ecf1)}
.fp-sec[data-open="true"] .fp-sec-head{background:rgba(245,158,11,.08);color:#F59E0B;position:sticky;top:0;z-index:1;backdrop-filter:blur(12px)}
.fp-sec-icon{width:14px;height:14px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.fp-sec-icon svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.fp-sec-title{flex-shrink:0}
.fp-sec-meta{font-size:10px;font-weight:500;color:var(--theme-text-tertiary,#8a919c);font-family:ui-monospace,'SF Mono',Menlo,monospace;flex:1;text-align:left;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:4px}
.fp-sec[data-open="true"] .fp-sec-meta{color:rgba(245,158,11,.7)}
.fp-sec-meta .err{color:#EF4444;font-weight:700}
.fp-sec-meta .warn{color:#F59E0B;font-weight:700}
.fp-sec-chevron{width:12px;height:12px;flex-shrink:0;transition:transform .18s ease;opacity:.5}
.fp-sec[data-open="true"] .fp-sec-chevron{transform:rotate(180deg);opacity:1}
.fp-sec-chevron svg{width:100%;height:100%;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.fp-sec-body{display:none;overflow-y:auto;background:rgba(10,12,16,.4);-webkit-overflow-scrolling:touch}
.fp-sec[data-open="true"] .fp-sec-body{display:block}
.fp-sec-body-inner{padding:10px 14px;min-height:60px;font-size:11.5px}

/* ── Shared tool chrome ──────────────────────────────────── */
.fp-toolbar{display:flex;gap:4px;align-items:center;padding:6px 0 8px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,.05);margin-bottom:8px}
.fp-toolbar input[type="search"],.fp-toolbar input[type="text"]{flex:1;min-width:80px;max-width:260px;height:26px;padding:0 8px;border-radius:5px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:var(--theme-text,#e8ecf1);font-size:10.5px;outline:none;font-family:inherit}
.fp-toolbar input:focus{border-color:#F59E0B;background:rgba(245,158,11,.06)}
.fp-chip{padding:3px 8px;border-radius:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);color:var(--theme-text-secondary,#a0a7b3);font-size:10px;font-weight:700;cursor:pointer;transition:all .12s;white-space:nowrap;font-family:inherit}
.fp-chip:hover{background:rgba(255,255,255,.08);color:var(--theme-text,#e8ecf1)}
.fp-chip.active{background:rgba(245,158,11,.16);color:#F59E0B;border-color:rgba(245,158,11,.32)}
.fp-chip .fp-chip-count{opacity:.65;margin-left:3px;font-weight:500}
.fp-empty{padding:20px 12px;text-align:center;color:var(--theme-text-tertiary,#8a919c);font-size:11px;line-height:1.6}
.fp-empty strong{color:var(--theme-text-secondary,#a0a7b3);display:block;margin-bottom:4px;font-weight:700}

/* ── Console ─────────────────────────────────────────────── */
.fp-console-list{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11px;line-height:1.55}
.fp-console-entry{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);align-items:flex-start}
.fp-console-entry:last-child{border-bottom:none}
.fp-console-entry[data-level="error"]{background:rgba(239,68,68,.04);padding-left:6px;border-left:2px solid rgba(239,68,68,.4)}
.fp-console-entry[data-level="warn"]{background:rgba(245,158,11,.03);padding-left:6px;border-left:2px solid rgba(245,158,11,.3)}
.fp-console-icon{width:12px;flex-shrink:0;margin-top:2px;color:var(--theme-text-tertiary,#8a919c)}
.fp-console-entry[data-level="error"] .fp-console-icon{color:#EF4444}
.fp-console-entry[data-level="warn"] .fp-console-icon{color:#F59E0B}
.fp-console-icon svg{width:100%;height:100%;stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.fp-console-meta{font-size:9.5px;color:var(--theme-text-tertiary,#8a919c);white-space:nowrap;flex-shrink:0;line-height:1.5;padding-top:1px}
.fp-console-meta .fp-file{color:rgba(245,158,11,.7);cursor:pointer;text-decoration:underline;text-decoration-color:transparent;transition:text-decoration-color .12s}
.fp-console-meta .fp-file:hover{text-decoration-color:currentColor}
.fp-console-args{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--theme-text,#e8ecf1)}
.fp-console-arg{display:inline;margin-right:6px}
.fp-console-arg[data-kind="string"]{color:#10B981}
.fp-console-arg[data-kind="number"]{color:#3B82F6}
.fp-console-arg[data-kind="boolean"]{color:#a855f7}
.fp-console-arg[data-kind="null"],.fp-console-arg[data-kind="undefined"]{color:var(--theme-text-tertiary,#8a919c);font-style:italic}
.fp-console-arg[data-kind="error"]{color:#EF4444}
.fp-console-arg[data-kind="function"],.fp-console-arg[data-kind="symbol"]{color:#06b6d4;font-style:italic}
.fp-console-arg[data-kind="object"],.fp-console-arg[data-kind="array"]{cursor:pointer;color:var(--theme-text-secondary,#a0a7b3)}
.fp-console-arg[data-kind="object"]:hover,.fp-console-arg[data-kind="array"]:hover{color:#F59E0B}
.fp-console-nested{padding-left:14px;border-left:1px solid rgba(255,255,255,.08);margin:3px 0 3px 6px;display:none}
.fp-console-nested[data-expanded="true"]{display:block}
.fp-console-nested-row{display:flex;gap:4px;padding:1px 0;font-size:10.5px}
.fp-console-nested-row .fp-nk{color:#06b6d4;flex-shrink:0}
.fp-console-nested-row .fp-nk::after{content:':';color:var(--theme-text-tertiary,#8a919c);margin-right:3px}
.fp-console-repl{display:flex;gap:6px;align-items:center;padding:6px 0 0;border-top:1px solid rgba(255,255,255,.06);margin-top:6px}
.fp-console-repl-prompt{color:#F59E0B;font-weight:800;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11px;padding-left:2px;flex-shrink:0}
.fp-console-repl input{flex:1;height:26px;padding:0 8px;border-radius:5px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:var(--theme-text,#e8ecf1);font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11px;outline:none}
.fp-console-repl input:focus{border-color:#F59E0B}
.fp-console-repl-result{margin-top:4px;padding:4px 8px;border-radius:4px;background:rgba(255,255,255,.03);font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:10.5px;color:var(--theme-text-secondary,#a0a7b3);border-left:2px solid rgba(255,255,255,.1);white-space:pre-wrap;overflow-wrap:anywhere}
.fp-console-repl-result[data-ok="false"]{color:#EF4444;border-left-color:#EF4444}

/* ── Network ─────────────────────────────────────────────── */
.fp-net-list{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:10.5px}
.fp-net-row{display:grid;grid-template-columns:44px 52px 1fr 62px;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);align-items:center;cursor:pointer;transition:background .1s}
.fp-net-row:hover{background:rgba(255,255,255,.03)}
.fp-net-method{font-weight:800;color:var(--theme-text-secondary,#a0a7b3);font-size:10px}
.fp-net-status{font-weight:800;padding:1px 5px;border-radius:3px;text-align:center;font-size:9.5px}
.fp-net-status[data-family="2"]{color:#10B981;background:rgba(16,185,129,.1)}
.fp-net-status[data-family="3"]{color:#3B82F6;background:rgba(59,130,246,.1)}
.fp-net-status[data-family="4"]{color:#F59E0B;background:rgba(245,158,11,.1)}
.fp-net-status[data-family="5"]{color:#EF4444;background:rgba(239,68,68,.1)}
.fp-net-status[data-family="error"]{color:#EF4444;background:rgba(239,68,68,.14)}
.fp-net-url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--theme-text,#e8ecf1)}
.fp-net-dur{text-align:right;color:var(--theme-text-tertiary,#8a919c);font-size:9.5px}
.fp-net-detail{padding:8px 12px;background:rgba(255,255,255,.02);border-left:2px solid rgba(245,158,11,.3);margin:2px 0 4px;display:none}
.fp-net-detail[data-open="true"]{display:block}
.fp-net-detail-row{display:grid;grid-template-columns:90px 1fr;gap:6px;font-size:10px;padding:2px 0}
.fp-net-detail-row .fk{color:var(--theme-text-tertiary,#8a919c);font-weight:600}
.fp-net-detail-row .fv{color:var(--theme-text-secondary,#a0a7b3);overflow-wrap:anywhere;font-family:ui-monospace,'SF Mono',Menlo,monospace}
.fp-net-waterfall{padding:10px 0}
.fp-net-waterfall-title{font-size:10px;font-weight:800;color:var(--theme-text-tertiary,#8a919c);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.fp-net-waterfall-row{display:grid;grid-template-columns:1fr 180px 50px;gap:8px;align-items:center;padding:3px 0;font-size:10px}
.fp-net-waterfall-row .fw-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--theme-text,#e8ecf1);font-family:ui-monospace,'SF Mono',Menlo,monospace}
.fp-net-waterfall-row .fw-bar{position:relative;height:8px;background:rgba(255,255,255,.03);border-radius:2px;overflow:hidden}
.fp-net-waterfall-row .fw-bar-fill{position:absolute;top:0;bottom:0;background:linear-gradient(90deg,#F59E0B,#fbbf24);border-radius:2px;min-width:2px}
.fp-net-waterfall-row .fw-dur{text-align:right;color:var(--theme-text-tertiary,#8a919c);font-size:9.5px}

/* ── Responsive ──────────────────────────────────────────── */
.fp-resp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:12px}
.fp-resp-stat{padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05)}
.fp-resp-stat-label{font-size:9.5px;font-weight:700;color:var(--theme-text-tertiary,#8a919c);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px}
.fp-resp-stat-value{font-size:14px;font-weight:800;color:var(--theme-text,#e8ecf1);font-family:ui-monospace,'SF Mono',Menlo,monospace}
.fp-resp-stat-value[data-warn="true"]{color:#F59E0B}
.fp-resp-stat-value[data-error="true"]{color:#EF4444}
.fp-resp-group{margin-bottom:12px}
.fp-resp-group-title{font-size:10px;font-weight:800;color:var(--theme-text-tertiary,#8a919c);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.fp-resp-group-title .fp-count{padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.06);color:var(--theme-text-secondary,#a0a7b3);font-size:9px}
.fp-resp-issue{padding:5px 8px;border-radius:4px;background:rgba(255,255,255,.02);margin-bottom:3px;border-left:2px solid rgba(245,158,11,.4);font-size:10.5px;cursor:pointer;transition:background .1s}
.fp-resp-issue:hover{background:rgba(255,255,255,.05)}
.fp-resp-issue[data-severity="error"]{border-left-color:#EF4444}
.fp-resp-issue .fp-issue-path{font-family:ui-monospace,'SF Mono',Menlo,monospace;color:#F59E0B;font-size:10px}
.fp-resp-issue .fp-issue-detail{color:var(--theme-text-secondary,#a0a7b3);font-size:10px;margin-top:2px}

/* ── Performance ─────────────────────────────────────────── */
.fp-perf-vitals{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:12px}
.fp-perf-vital{padding:10px;border-radius:6px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05)}
.fp-perf-vital-label{font-size:9.5px;font-weight:700;color:var(--theme-text-tertiary,#8a919c);text-transform:uppercase;letter-spacing:.4px}
.fp-perf-vital-value{font-size:16px;font-weight:800;color:var(--theme-text,#e8ecf1);margin:2px 0;font-family:ui-monospace,'SF Mono',Menlo,monospace}
.fp-perf-vital[data-rating="good"] .fp-perf-vital-value{color:#10B981}
.fp-perf-vital[data-rating="warn"] .fp-perf-vital-value{color:#F59E0B}
.fp-perf-vital[data-rating="bad"] .fp-perf-vital-value{color:#EF4444}
.fp-perf-vital-target{font-size:9.5px;color:var(--theme-text-tertiary,#8a919c)}
.fp-perf-payload{margin-bottom:12px}
.fp-perf-payload-row{display:grid;grid-template-columns:1fr 68px;gap:8px;align-items:center;padding:3px 0;font-size:10.5px}
.fp-perf-payload-row .fp-payload-label{color:var(--theme-text-secondary,#a0a7b3)}
.fp-perf-payload-row .fp-payload-val{text-align:right;font-family:ui-monospace,'SF Mono',Menlo,monospace;color:var(--theme-text,#e8ecf1);font-weight:700}
.fp-perf-payload-row[data-warn="true"] .fp-payload-val{color:#F59E0B}

/* ── Files ───────────────────────────────────────────────── */
.fp-files-group{margin-bottom:12px}
.fp-files-group:last-child{margin-bottom:0}
.fp-files-group-title{font-size:10px;font-weight:800;color:var(--theme-text-tertiary,#8a919c);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.fp-files-row{display:flex;gap:8px;padding:4px 6px;border-radius:4px;font-size:10.5px;align-items:center;transition:background .1s}
.fp-files-row:hover{background:rgba(255,255,255,.03)}
.fp-files-row[data-clickable="true"]{cursor:pointer}
.fp-files-status{width:14px;flex-shrink:0;text-align:center;font-weight:800}
.fp-files-row[data-loaded="true"] .fp-files-status{color:#10B981}
.fp-files-row[data-loaded="false"] .fp-files-status{color:#EF4444}
.fp-files-path{font-family:ui-monospace,'SF Mono',Menlo,monospace;color:var(--theme-text,#e8ecf1);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-files-size{color:var(--theme-text-tertiary,#8a919c);font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:9.5px}
.fp-files-reason{color:var(--theme-text-tertiary,#8a919c);font-size:9.5px;font-style:italic}

/* ── Storage ─────────────────────────────────────────────── */
.fp-stor-group{margin-bottom:12px}
.fp-stor-group-title{font-size:10px;font-weight:800;color:var(--theme-text-tertiary,#8a919c);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.fp-stor-row{display:grid;grid-template-columns:minmax(80px,1fr) minmax(80px,2fr) 52px;gap:6px;padding:4px 6px;border-radius:4px;font-size:10px;font-family:ui-monospace,'SF Mono',Menlo,monospace;align-items:center}
.fp-stor-row:hover{background:rgba(255,255,255,.03)}
.fp-stor-key{color:#F59E0B;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-stor-val{color:var(--theme-text-secondary,#a0a7b3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-stor-act{display:flex;gap:2px}
.fp-stor-act button{padding:2px 5px;border-radius:3px;background:rgba(255,255,255,.05);border:none;color:var(--theme-text-tertiary,#8a919c);cursor:pointer;font-size:9px;font-family:inherit}
.fp-stor-act button:hover{background:rgba(239,68,68,.15);color:#EF4444}

/* ── DOM tree ────────────────────────────────────────────── */
.fp-dom-toolbar{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
.fp-dom-tree{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:10.5px;line-height:1.5}
.fp-dom-node{padding:1px 0}
.fp-dom-toggle{display:inline-flex;width:12px;justify-content:center;color:var(--theme-text-tertiary,#8a919c);cursor:pointer;user-select:none;margin-right:2px}
.fp-dom-node[data-has-children="true"] .fp-dom-toggle:hover{color:var(--theme-text,#e8ecf1)}
.fp-dom-tag{color:#a855f7;cursor:pointer;transition:background .1s;padding:0 2px;border-radius:2px}
.fp-dom-tag:hover{background:rgba(168,85,247,.15)}
.fp-dom-tag[data-inspect="true"]{background:rgba(245,158,11,.2);color:#F59E0B}
.fp-dom-id{color:#F59E0B}
.fp-dom-class{color:#10B981}
.fp-dom-children{padding-left:14px;border-left:1px solid rgba(255,255,255,.06);margin-left:5px}
.fp-dom-children[data-collapsed="true"]{display:none}

/* ── A11y ────────────────────────────────────────────────── */
.fp-a11y-group{margin-bottom:12px}
.fp-a11y-group-title{font-size:10px;font-weight:800;color:var(--theme-text-tertiary,#8a919c);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.fp-a11y-issue{padding:5px 8px;border-radius:4px;background:rgba(255,255,255,.02);margin-bottom:3px;border-left:2px solid #F59E0B;font-size:10.5px}
.fp-a11y-issue[data-severity="error"]{border-left-color:#EF4444}
.fp-a11y-issue-title{color:var(--theme-text,#e8ecf1);font-weight:600;margin-bottom:2px}
.fp-a11y-issue-detail{color:var(--theme-text-tertiary,#8a919c);font-size:10px;font-family:ui-monospace,'SF Mono',Menlo,monospace;overflow-wrap:anywhere}

/* ── Dev tools ───────────────────────────────────────────── */
.fp-devtools-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px}
.fp-devtools-btn{padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);color:var(--theme-text-secondary,#a0a7b3);font-size:10.5px;font-weight:600;cursor:pointer;text-align:left;display:flex;align-items:center;gap:6px;transition:all .12s;font-family:inherit;min-height:34px}
.fp-devtools-btn:hover{background:rgba(255,255,255,.08);color:var(--theme-text,#e8ecf1);border-color:rgba(245,158,11,.3)}
.fp-devtools-btn svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.fp-devtools-btn[data-danger="true"]:hover{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);color:#EF4444}

/* ── Highlight overlay ───────────────────────────────────── */
.fp-highlight{position:fixed;pointer-events:none;background:rgba(245,158,11,.22);border:2px solid #F59E0B;z-index:999999;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.4);transition:all .08s ease}
.fp-highlight-label{position:absolute;top:-22px;left:-2px;background:#F59E0B;color:#0a0c10;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:10px;font-weight:800;padding:2px 6px;border-radius:3px;white-space:nowrap;pointer-events:none}

/* ── Responsive ──────────────────────────────────────────── */
@media (max-width:640px){
  .fp-header{padding:6px 8px;gap:6px;min-height:auto;flex-wrap:wrap}
  .fp-title{font-size:12px;width:100%;margin-bottom:2px}
  .fp-size-bar{flex:1;min-width:0}
  .fp-size-btn{padding:4px 7px;font-size:10px}
  .fp-dims{display:none}
  .fp-dock[data-expanded="true"]{height:72vh}
  .fp-net-row{grid-template-columns:38px 44px 1fr 48px;gap:6px}
  .fp-stor-row{grid-template-columns:1fr 1fr 48px;font-size:9.5px}
  .fp-resp-grid,.fp-perf-vitals{grid-template-columns:repeat(2,1fr)}
  .fp-net-waterfall-row{grid-template-columns:1fr 100px 40px}
}
`;

// ═══════════════════════════════════════════════════════════════════
//  BRIDGE SCRIPT — injected into the preview iframe
// ═══════════════════════════════════════════════════════════════════
const BRIDGE_SCRIPT = `
(function(){
  if (window.__folioBridge) return;
  window.__folioBridge = true;

  var PARENT = window.parent;
  function post(type, payload) {
    try {
      PARENT.postMessage(Object.assign({ __folio: true, type: type }, payload || {}), "*");
    } catch (e) {}
  }

  // ── Storage shim ─────────────────────────────────────────
  var memLocal = {}, memSession = {};
  function makeStorage(store, kind) {
    return {
      getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? String(store[k]) : null; },
      setItem: function(k, v) {
        store[k] = String(v);
        post("folio:storage-write", { kind: kind, op: "set", key: String(k), value: String(v) });
      },
      removeItem: function(k) {
        delete store[k];
        post("folio:storage-write", { kind: kind, op: "remove", key: String(k) });
      },
      clear: function() {
        Object.keys(store).forEach(function(k) { delete store[k]; });
        post("folio:storage-write", { kind: kind, op: "clear" });
      },
      key: function(i) { var keys = Object.keys(store); return keys[i] || null; },
      get length() { return Object.keys(store).length; }
    };
  }
  try { Object.defineProperty(window, "localStorage", { value: makeStorage(memLocal, "local"), configurable: true }); } catch (e) {}
  try { Object.defineProperty(window, "sessionStorage", { value: makeStorage(memSession, "session"), configurable: true }); } catch (e) {}

  // ── Serialize ────────────────────────────────────────────
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
    if (v instanceof Error) {
      return { kind: "error", name: v.name, message: v.message, stack: (v.stack || "").slice(0, 2000) };
    }
    if (depth > 3) return { kind: "object", preview: "[deep]", collapsed: true };
    if (Array.isArray(v)) {
      return { kind: "array", length: v.length, items: v.slice(0, 100).map(function(x) { return serialize(x, depth + 1); }) };
    }
    if (v instanceof Date) return { kind: "date", value: v.toISOString() };
    if (v instanceof RegExp) return { kind: "regexp", value: String(v) };
    if (typeof Element !== "undefined" && v instanceof Element) {
      var cls = typeof v.className === "string" && v.className ? "." + v.className.split(/\\s+/).filter(Boolean).join(".") : "";
      return { kind: "element", preview: v.tagName.toLowerCase() + (v.id ? "#" + v.id : "") + cls };
    }
    if (typeof Node !== "undefined" && v instanceof Node) {
      return { kind: "node", preview: v.nodeName };
    }
    var keys = Object.keys(v).slice(0, 100);
    return {
      kind: "object",
      constructor: (v.constructor && v.constructor.name) || "Object",
      keys: keys,
      entries: keys.map(function(k) {
        return { key: k, value: serialize(v[k], depth + 1) };
      })
    };
  }

  function callSiteOf() {
    var stack = (new Error()).stack || "";
    var lines = stack.split("\\n").slice(1);
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/\\/([^\\/\\s]+):(\\d+):(\\d+)/);
      if (m && m[1] !== "preview.js" && m[1].indexOf("__sandbox") === -1) {
        return { file: "/" + m[1], line: parseInt(m[2], 10) };
      }
    }
    return null;
  }

  // ── Console patch ────────────────────────────────────────
  var nativeConsole = {};
  ["log", "info", "warn", "error", "debug"].forEach(function(level) {
    nativeConsole[level] = window.console[level] ? window.console[level].bind(window.console) : function() {};
    window.console[level] = function() {
      try {
        var args = Array.prototype.slice.call(arguments).map(function(a) { return serialize(a); });
        var site = callSiteOf();
        post("folio:console", {
          level: level,
          args: args,
          ts: Date.now(),
          file: site ? site.file : null,
          line: site ? site.line : null
        });
      } catch (e) {}
      nativeConsole[level].apply(window.console, arguments);
    };
  });

  // ── Error handling ───────────────────────────────────────
  window.addEventListener("error", function(e) {
    try {
      post("folio:error", {
        source: "error",
        message: e.message || "Unknown error",
        stack: (e.error && e.error.stack || "").slice(0, 2000),
        file: e.filename || null,
        line: e.lineno || null
      });
    } catch (err) {}
  });

  window.addEventListener("unhandledrejection", function(e) {
    try {
      var r = e.reason;
      post("folio:error", {
        source: "rejection",
        message: r && r.message ? r.message : String(r),
        stack: (r && r.stack || "").slice(0, 2000),
        file: null,
        line: null
      });
    } catch (err) {}
  });

  // ── Network wrap ─────────────────────────────────────────
  var _netConfig = { latencyMs: 0, failureRate: 0 };

  function simulateDelay() {
    if (_netConfig.latencyMs > 0) {
      return new Promise(function(r) { setTimeout(r, _netConfig.latencyMs); });
    }
    return Promise.resolve();
  }

  function maybeFail() {
    if (_netConfig.failureRate > 0 && Math.random() < _netConfig.failureRate) {
      return Promise.reject(new TypeError("Failed to fetch (simulated)"));
    }
    return null;
  }

  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function(input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (init && init.method) || (input && input.method) || "GET";
      var start = Date.now();
      var failed = maybeFail();
      if (failed) {
        post("folio:network", {
          method: String(method).toUpperCase(),
          url: String(url),
          status: 0,
          durationMs: 0,
          error: "Simulated failure"
        });
        return failed;
      }
      return simulateDelay().then(function() {
        return nativeFetch.apply(window, arguments);
      }).then(function(res) {
        try {
          post("folio:network", {
            method: String(method).toUpperCase(),
            url: String(url),
            status: res.status,
            durationMs: Date.now() - start,
            error: null
          });
        } catch (e) {}
        return res;
      }).catch(function(err) {
        try {
          post("folio:network", {
            method: String(method).toUpperCase(),
            url: String(url),
            status: 0,
            durationMs: Date.now() - start,
            error: String(err && err.message || err)
          });
        } catch (e) {}
        throw err;
      });
    };
  }

  var NativeXHR = window.XMLHttpRequest;
  if (NativeXHR) {
    var _open = NativeXHR.prototype.open;
    var _send = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function(method, url) {
      this.__folioMethod = method;
      this.__folioUrl = url;
      return _open.apply(this, arguments);
    };
    NativeXHR.prototype.send = function() {
      var xhr = this;
      var start = Date.now();
      xhr.addEventListener("loadend", function() {
        try {
          post("folio:network", {
            method: String(xhr.__folioMethod || "GET").toUpperCase(),
            url: String(xhr.__folioUrl || ""),
            status: xhr.status || 0,
            durationMs: Date.now() - start,
            error: xhr.status === 0 ? "Network error" : null
          });
        } catch (e) {}
      });
      return _send.apply(this, arguments);
    };
  }

  // ── Web Vitals ───────────────────────────────────────────
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      var last = entries[entries.length - 1];
      if (last) post("folio:vitals", { lcp: last.startTime });
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) {}

  try {
    new PerformanceObserver(function(list) {
      list.getEntries().forEach(function(e) {
        if (e.name === "first-contentful-paint") post("folio:vitals", { fcp: e.startTime });
      });
    }).observe({ type: "paint", buffered: true });
  } catch (e) {}

  try {
    var _cls = 0;
    new PerformanceObserver(function(list) {
      list.getEntries().forEach(function(e) {
        if (!e.hadRecentInput) {
          _cls += e.value;
          post("folio:layout-shift", {
            value: e.value,
            sources: (e.sources || []).map(function(s) {
              var n = s.node;
              if (!n) return null;
              return n.tagName ? n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") : null;
            }).filter(Boolean)
          });
        }
      });
      post("folio:vitals", { cls: _cls });
    }).observe({ type: "layout-shift", buffered: true });
  } catch (e) {}

  try {
    new PerformanceObserver(function(list) {
      list.getEntries().forEach(function(e) {
        post("folio:resource", {
          name: e.name,
          initiatorType: e.initiatorType || "other",
          duration: e.duration,
          transferSize: e.transferSize || 0,
          dns: (e.domainLookupEnd || 0) - (e.domainLookupStart || 0),
          tcp: (e.connectEnd || 0) - (e.connectStart || 0),
          ttfb: (e.responseStart || 0) - (e.requestStart || 0),
          download: (e.responseEnd || 0) - (e.responseStart || 0)
        });
      });
    }).observe({ type: "resource", buffered: true });
  } catch (e) {}

  // ── Path helper ──────────────────────────────────────────
  function pathOf(el) {
    if (!el || !el.tagName) return "";
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      var part = node.tagName.toLowerCase();
      if (node.id) { part += "#" + node.id; parts.unshift(part); break; }
      var cls = typeof node.className === "string" ? node.className.trim().split(/\\s+/).filter(Boolean)[0] : "";
      if (cls) part += "." + cls;
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === node.tagName; });
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  // ── DOM snapshot ─────────────────────────────────────────
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
      if (kids.length) {
        out.children = [];
        for (var i = 0; i < kids.length; i++) {
          var c = serializeDOM(kids[i], depth + 1, maxDepth, budget);
          if (c) out.children.push(c);
        }
      }
    } else if (node.nodeType === 3) {
      var t = node.textContent.trim();
      if (!t) return null;
      out.tag = "#text";
      out.text = t.slice(0, 80);
    } else {
      return null;
    }
    return out;
  }

  // ── Inspect mode ─────────────────────────────────────────
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
    if (!el || el === document.documentElement || el === document.body) {
      ov.style.display = "none";
      return;
    }
    var r = el.getBoundingClientRect();
    ov.style.display = "block";
    ov.style.left = r.left + "px";
    ov.style.top = r.top + "px";
    ov.style.width = r.width + "px";
    ov.style.height = r.height + "px";
  }
  function hideOverlay() {
    if (_overlay) _overlay.style.display = "none";
  }

  document.addEventListener("mouseover", function(e) {
    if (!_inspectActive) return;
    drawOverlay(e.target);
  }, true);

  document.addEventListener("mouseout", function() {
    if (_inspectActive) hideOverlay();
  }, true);

  document.addEventListener("click", function(e) {
    if (!_inspectActive) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    var r = el.getBoundingClientRect();
    post("folio:inspect-result", {
      elementPath: pathOf(el),
      tag: el.tagName ? el.tagName.toLowerCase() : "?",
      id: el.id || "",
      className: typeof el.className === "string" ? el.className : "",
      rect: { x: r.x, y: r.y, w: r.width, h: r.height }
    });
  }, true);

  function highlightElement(path) {
    try {
      var el = document.querySelector(path);
      if (el) {
        drawOverlay(el);
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(hideOverlay, 2000);
      }
    } catch (e) {}
  }

  // ── A11y scan ────────────────────────────────────────────
  function parseRGB(str) {
    var m = str.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
  }
  function relLum(c) {
    var ch = [c.r, c.g, c.b].map(function(v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function contrastRatio(a, b) {
    var l1 = relLum(a), l2 = relLum(b);
    if (l1 < l2) { var t = l1; l1 = l2; l2 = t; }
    return (l1 + 0.05) / (l2 + 0.05);
  }

  function runA11yScan() {
    var issues = [];
    // Missing alt
    document.querySelectorAll("img:not([alt])").forEach(function(img) {
      if (issues.length >= 50) return;
      issues.push({ type: "missing-alt", severity: "error", title: "Image missing alt attribute", detail: pathOf(img) });
    });
    // Empty buttons
    document.querySelectorAll("button, [role=button]").forEach(function(btn) {
      if (issues.length >= 50) return;
      var text = (btn.textContent || "").trim();
      var aria = btn.getAttribute("aria-label");
      var hasImg = btn.querySelector("img[alt]");
      if (!text && !aria && !hasImg) {
        issues.push({ type: "empty-button", severity: "error", title: "Button has no accessible name", detail: pathOf(btn) });
      }
    });
    // Missing lang
    if (!document.documentElement.hasAttribute("lang")) {
      issues.push({ type: "missing-lang", severity: "warn", title: "Document missing lang attribute", detail: "<html>" });
    }
    // Missing title
    if (!document.title) {
      issues.push({ type: "missing-title", severity: "error", title: "Document missing title", detail: "<head>" });
    }
    // Duplicate IDs
    var idMap = {};
    document.querySelectorAll("[id]").forEach(function(el) {
      idMap[el.id] = (idMap[el.id] || 0) + 1;
    });
    Object.keys(idMap).forEach(function(id) {
      if (idMap[id] > 1 && issues.length < 50) {
        issues.push({ type: "duplicate-id", severity: "error", title: "Duplicate id: " + id, detail: idMap[id] + " elements" });
      }
    });
    // Low contrast
    document.querySelectorAll("p, span, a, h1, h2, h3, h4, h5, h6, li, td, th").forEach(function(el) {
      if (issues.length >= 50) return;
      if (!el.textContent || !el.textContent.trim()) return;
      var style = getComputedStyle(el);
      var fg = parseRGB(style.color);
      var bg = parseRGB(style.backgroundColor);
      if (!fg) return;
      // If bg is transparent, walk up to find an ancestor with a bg color
      var bgEl = el;
      while (bg && bg.a === 0 && bgEl && bgEl !== document.documentElement) {
        bgEl = bgEl.parentElement;
        if (bgEl) bg = parseRGB(getComputedStyle(bgEl).backgroundColor);
      }
      if (!bg || bg.a === 0) return; // couldn't determine
      var ratio = contrastRatio(fg, bg);
      if (ratio < 4.5) {
        issues.push({ type: "low-contrast", severity: "error", title: "Low contrast (" + ratio.toFixed(2) + ":1)", detail: pathOf(el) });
      }
    });
    // Heading hierarchy
    var prevLevel = 0;
    document.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach(function(h) {
      if (issues.length >= 50) return;
      var level = parseInt(h.tagName[1], 10);
      if (prevLevel > 0 && level > prevLevel + 1) {
        issues.push({ type: "heading-skip", severity: "warn", title: "Heading skips from h" + prevLevel + " to h" + level, detail: pathOf(h) });
      }
      prevLevel = level;
    });
    post("folio:a11y-result", { issues: issues });
  }

  // ── Responsive scan ──────────────────────────────────────
  function runResponsiveScan() {
    var vw = window.innerWidth;
    var overflow = [];
    var touchTargets = [];
    var smallText = [];

    document.querySelectorAll("*").forEach(function(el) {
      if (el === document.documentElement || el === document.body) return;
      if (overflow.length >= 30 && touchTargets.length >= 30 && smallText.length >= 30) return;
      try {
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (overflow.length < 30 && (rect.right > vw + 1 || el.scrollWidth > el.clientWidth + 1)) {
          overflow.push({
            path: pathOf(el),
            tag: el.tagName.toLowerCase(),
            right: Math.round(rect.right),
            viewportWidth: vw
          });
        }
        if (touchTargets.length < 30 && /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
          if (rect.width < 44 || rect.height < 44) {
            touchTargets.push({
              path: pathOf(el),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            });
          }
        }
        if (smallText.length < 30) {
          var fs = parseFloat(getComputedStyle(el).fontSize);
          if (fs > 0 && fs < 12 && el.textContent && el.textContent.trim()) {
            smallText.push({ path: pathOf(el), fontSize: fs });
          }
        }
      } catch (e) {}
    });

    post("folio:responsive-result", {
      viewportWidth: vw,
      overflow: overflow,
      touchTargets: touchTargets,
      smallText: smallText
    });
  }

  // ── Eval ─────────────────────────────────────────────────
  function runEval(code) {
    try {
      // eslint-disable-next-line no-eval
      var result = (0, eval)(code);
      var serialized = serialize(result);
      post("folio:eval-result", { ok: true, value: serialized });
    } catch (e) {
      post("folio:eval-result", {
        ok: false,
        error: String(e && e.message || e),
        stack: (e && e.stack || "").slice(0, 1000)
      });
    }
  }

  // ── Message handling (parent → child) ────────────────────
  window.addEventListener("message", function(e) {
    if (!e.data || e.data.__folio !== true) return;
    var t = e.data.type;
    if (t === "folio:storage-snapshot") {
      post("folio:storage-snapshot-result", { local: memLocal, session: memSession });
    } else if (t === "folio:clear-storage") {
      Object.keys(memLocal).forEach(function(k) { delete memLocal[k]; });
      Object.keys(memSession).forEach(function(k) { delete memSession[k]; });
      post("folio:storage-snapshot-result", { local: memLocal, session: memSession });
    } else if (t === "folio:dom-snapshot-request") {
      var budget = { count: 0 };
      post("folio:dom-snapshot", { tree: serializeDOM(document.documentElement, 0, 8, budget) });
    } else if (t === "folio:inspect-start") {
      _inspectActive = true;
      document.documentElement.style.cursor = "crosshair";
    } else if (t === "folio:inspect-stop") {
      _inspectActive = false;
      document.documentElement.style.cursor = "";
      hideOverlay();
    } else if (t === "folio:highlight-element") {
      highlightElement(e.data.path);
    } else if (t === "folio:a11y-scan") {
      runA11yScan();
    } else if (t === "folio:responsive-scan") {
      runResponsiveScan();
    } else if (t === "folio:eval") {
      runEval(e.data.code);
    } else if (t === "folio:simulate-network") {
      _netConfig.latencyMs = Number(e.data.latencyMs) || 0;
      _netConfig.failureRate = Number(e.data.failureRate) || 0;
    } else if (t === "folio:set-prefers") {
      // Can't truly override prefers-color-scheme, but we can dispatch a fake
      // matchMedia — too invasive; skip for v1
    } else if (t === "folio:reload") {
      window.location.reload();
    }
  });

  post("folio:ready", {});
})();
`;

// ═══════════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════════
const ST = {
  options: null,
  rootEl: null,
  overlayEl: null,
  iframeEl: null,
  stageEl: null,
  frameEl: null,
  dockEl: null,
  sectionsEl: null,
  highlightEl: null,
  bridgeReady: false,
  openSection: null,
  dockHeight: 40,

  // Sizing
  sizer: {
    mode: "fit",
    custom: { w: 768, h: 1024 },
    drag: null,
    scale: 1,
    pid: null,
  },

  // Project
  pid: null,
  projectName: null,
  activeFile: null,
  fileOptions: [],

  // Data
  console: { entries: [], filter: "all", query: "", expanded: new Set(), autoScroll: true, nextId: 1 },
  network: { entries: [], filter: "all", expanded: new Set(), nextId: 1, waterfallExpanded: false },
  vitals: { lcp: null, fcp: null, cls: null, tbt: null, inp: null },
  resources: [],
  layoutShifts: [],
  a11y: { issues: null, scanning: false },
  responsive: { result: null, scanning: false },
  dom: { tree: null, expanded: new Set(), loading: false, inspectActive: false, selectedPath: null },
  storage: { local: {}, session: {}, loaded: false },
  files: { loaded: [], skipped: [] },
  devtools: { latencyMs: 0, failureRate: 0 },
};

// ═══════════════════════════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════════════════════════
const $ = (sel, ctx = document) => ctx.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset" && typeof v === "object") Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return node;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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
    wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    wifiOff: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>',
  };
  const body = icons[name] || icons.info;
  return `<svg viewBox="0 0 24 24">${body}</svg>`;
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return Math.round(ms) + "ms";
  return (ms / 1000).toFixed(2) + "s";
}

function fmtBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + " " + u[i];
}

function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function toast(msg, type = "info") {
  if (typeof ST.options?.onToast === "function") {
    ST.options.onToast(msg, type);
    return;
  }
  try {
    if (typeof window.toast === "function") window.toast(msg, type);
  } catch {}
}

async function copyToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

function postToChild(type, payload = {}) {
  if (!ST.iframeEl?.contentWindow) return;
  try {
    ST.iframeEl.contentWindow.postMessage(Object.assign({ __folio: true, type }, payload), "*");
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════
//  STYLES INJECTION
// ═══════════════════════════════════════════════════════════════════
function injectStyles() {
  if (document.getElementById("folio-preview-styles")) return;
  const style = document.createElement("style");
  style.id = "folio-preview-styles";
  style.textContent = PREVIEW_CSS;
  document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════════
//  DOM BUILD
// ═══════════════════════════════════════════════════════════════════
function buildOverlay(rootEl) {
  rootEl.innerHTML = "";
  const overlay = el("div", { class: "fp-overlay", "data-open": "false", id: "fpOverlay" });

  const header = el("div", { class: "fp-header" });
  header.innerHTML = `
    <div class="fp-title">
      Preview
      <span class="fp-hint">Esc to exit</span>
    </div>
    <div class="fp-size-bar" id="fpSizeBar">
      <button class="fp-size-btn active" data-size="fit" type="button">Fit</button>
      <button class="fp-size-btn" data-size="phone" type="button">Phone</button>
      <button class="fp-size-btn" data-size="tablet" type="button">Tablet</button>
      <button class="fp-size-btn" data-size="laptop" type="button">Laptop</button>
      <button class="fp-size-btn" data-size="custom" type="button">Custom</button>
    </div>
    <div class="fp-dims" id="fpDims" hidden>
      <input type="number" id="fpDimsW" min="${CUSTOM_MIN.w}" max="${CUSTOM_MAX.w}" aria-label="Width in pixels">
      <span>×</span>
      <input type="number" id="fpDimsH" min="${CUSTOM_MIN.h}" max="${CUSTOM_MAX.h}" aria-label="Height in pixels">
    </div>
    <div class="fp-acts">
      <button class="fp-btn icon" id="fpBtnRefresh" type="button" title="Refresh preview" aria-label="Refresh preview">${svgIcon("refresh")}</button>
      <button class="fp-btn icon" id="fpBtnClose" type="button" title="Close" aria-label="Close preview">${svgIcon("x")}</button>
    </div>
  `;
  overlay.appendChild(header);

  const stageWrap = el("div", { class: "fp-stage-wrap", "data-dock-open": "false", id: "fpStageWrap" });
  const stage = el("div", { class: "fp-stage", id: "fpStage" });
  const frame = el("div", { class: "fp-frame", "data-device": "false", "data-mode": "fit", id: "fpFrame" });
  const iframe = el("iframe", { id: "fpIframe", sandbox: "allow-scripts allow-forms allow-modals allow-popups" });
  frame.appendChild(iframe);
  frame.appendChild(el("div", { class: "fp-resize", "data-corner": "br", id: "fpResizeBR", tabindex: "0", role: "slider", "aria-label": "Resize preview" }));
  frame.appendChild(el("div", { class: "fp-resize", "data-corner": "tl", id: "fpResizeTL", tabindex: "0", role: "slider", "aria-label": "Resize preview from top-left" }));
  frame.appendChild(el("div", { class: "fp-readout", id: "fpReadout" }));
  stage.appendChild(frame);
  stageWrap.appendChild(stage);
  overlay.appendChild(stageWrap);

  const dock = el("div", { class: "fp-dock", "data-expanded": "false", id: "fpDock" });
  dock.innerHTML = `
    <div class="fp-dock-grip" id="fpDockGrip"></div>
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

// ═══════════════════════════════════════════════════════════════════
//  SECTIONS
// ═══════════════════════════════════════════════════════════════════
const SECTIONS = [
  { id: "console",      icon: "warn",      title: "Console",      defaultVisible: true },
  { id: "network",      icon: "globe",     title: "Network",      defaultVisible: false },
  { id: "responsive",   icon: "ruler",     title: "Responsive",   defaultVisible: false },
  { id: "performance",  icon: "zap",       title: "Performance",  defaultVisible: false },
  { id: "files",        icon: "folder",    title: "Files",        defaultVisible: false },
  { id: "storage",      icon: "database",  title: "Storage",      defaultVisible: false },
  { id: "dom",          icon: "code",      title: "DOM",          defaultVisible: false },
  { id: "a11y",         icon: "shield",    title: "Accessibility", defaultVisible: false },
  { id: "devtools",     icon: "tool",      title: "Dev tools",    defaultVisible: false },
];

function buildSections() {
  const wrap = ST.sectionsEl;
  wrap.innerHTML = "";
  for (const sec of SECTIONS) {
    const section = el("section", { class: "fp-sec", "data-section": sec.id, "data-open": "false", "data-hidden": sec.defaultVisible ? "false" : "true" });
    section.innerHTML = `
      <button class="fp-sec-head" type="button" aria-expanded="false" data-toggle-section="${sec.id}">
        <span class="fp-sec-icon">${svgIcon(sec.icon)}</span>
        <span class="fp-sec-title">${escapeHtml(sec.title)}</span>
        <span class="fp-sec-meta" data-meta="${sec.id}"></span>
        <span class="fp-sec-chevron">${svgIcon("chevronDown")}</span>
      </button>
      <div class="fp-sec-body">
        <div class="fp-sec-body-inner" data-body="${sec.id}"></div>
      </div>
    `;
    wrap.appendChild(section);
  }

  wrap.querySelectorAll("[data-toggle-section]").forEach(btn => {
    btn.addEventListener("click", () => toggleSection(btn.dataset.toggleSection));
  });

  // Restore last open section
  try {
    const last = localStorage.getItem(LS_OPEN_SECTION);
    if (last && SECTIONS.some(s => s.id === last)) {
      setTimeout(() => openSection(last), 100);
    }
  } catch {}
}

function toggleSection(id) {
  if (ST.openSection === id) closeSection();
  else openSection(id);
}

function openSection(id) {
  ST.openSection = id;
  ST.dockEl.setAttribute("data-expanded", "true");
  ST.overlayEl.querySelector(".fp-stage-wrap").setAttribute("data-dock-open", "true");
  try { localStorage.setItem(LS_OPEN_SECTION, id); } catch {}

  ST.sectionsEl.querySelectorAll(".fp-sec").forEach(sec => {
    const isTarget = sec.getAttribute("data-section") === id;
    sec.setAttribute("data-open", isTarget ? "true" : "false");
    const head = sec.querySelector(".fp-sec-head");
    if (head) head.setAttribute("aria-expanded", isTarget ? "true" : "false");
  });

  // Render the section content
  renderSection(id);

  // Scroll into view
  const section = ST.sectionsEl.querySelector(`[data-section="${id}"]`);
  if (section) section.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function closeSection() {
  ST.openSection = null;
  ST.dockEl.setAttribute("data-expanded", "false");
  ST.overlayEl.querySelector(".fp-stage-wrap").setAttribute("data-dock-open", "false");
  ST.sectionsEl.querySelectorAll(".fp-sec").forEach(sec => {
    sec.setAttribute("data-open", "false");
    const head = sec.querySelector(".fp-sec-head");
    if (head) head.setAttribute("aria-expanded", "false");
  });
}

function renderSection(id) {
  const body = ST.sectionsEl.querySelector(`[data-body="${id}"]`);
  if (!body) return;
  switch (id) {
    case "console":     renderConsole(body); break;
    case "network":     renderNetwork(body); break;
    case "responsive":  renderResponsive(body); break;
    case "performance": renderPerformance(body); break;
    case "files":       renderFiles(body); break;
    case "storage":     renderStorage(body); break;
    case "dom":         renderDOM(body); break;
    case "a11y":        renderA11y(body); break;
    case "devtools":    renderDevTools(body); break;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION META (badges in headers)
// ═══════════════════════════════════════════════════════════════════
function updateSectionMeta() {
  const setMeta = (id, html) => {
    const metaEl = ST.sectionsEl.querySelector(`[data-meta="${id}"]`);
    if (metaEl) metaEl.innerHTML = html;
  };
  const setVisible = (id, visible) => {
    const sec = ST.sectionsEl.querySelector(`[data-section="${id}"]`);
    if (sec) sec.setAttribute("data-hidden", visible ? "false" : "true");
  };

  // Console
  const consoleErrors = ST.console.entries.filter(e => e.level === "error").length;
  const consoleWarns = ST.console.entries.filter(e => e.level === "warn").length;
  const consoleTotal = ST.console.entries.length;
  if (consoleTotal > 0) {
    const parts = [];
    if (consoleErrors) parts.push(`<span class="err">${consoleErrors} error${consoleErrors === 1 ? "" : "s"}</span>`);
    if (consoleWarns) parts.push(`<span class="warn">${consoleWarns} warn${consoleWarns === 1 ? "" : "s"}</span>`);
    if (!parts.length) parts.push(`${consoleTotal} message${consoleTotal === 1 ? "" : "s"}`);
    setMeta("console", parts.join(" · "));
    setVisible("console", true);
  } else {
    setMeta("console", "No messages");
    setVisible("console", true); // always visible
  }

  // Network
  const netTotal = ST.network.entries.length;
  const netFailed = ST.network.entries.filter(e => e.error || e.status >= 400).length;
  setVisible("network", netTotal > 0);
  if (netTotal > 0) {
    const parts = [`${netTotal} req${netTotal === 1 ? "" : "s"}`];
    if (netFailed) parts.push(`<span class="err">${netFailed} failed</span>`);
    setMeta("network", parts.join(" · "));
  }

  // Responsive
  const resp = ST.responsive.result;
  const respTotal = resp ? (resp.overflow?.length || 0) + (resp.touchTargets?.length || 0) + (resp.smallText?.length || 0) : 0;
  setVisible("responsive", !!resp);
  if (resp) {
    setMeta("responsive", respTotal > 0 ? `<span class="warn">${respTotal} issue${respTotal === 1 ? "" : "s"}</span>` : "No issues");
  } else {
    setMeta("responsive", "Not scanned");
    setVisible("responsive", true);
  }

  // Performance
  const vitals = ST.vitals;
  const hasVitals = vitals.lcp != null || vitals.fcp != null;
  setVisible("performance", hasVitals || ST.resources.length > 0);
  if (hasVitals) {
    const parts = [];
    if (vitals.lcp != null) parts.push(`LCP ${fmtDuration(vitals.lcp)}`);
    if (vitals.fcp != null) parts.push(`FCP ${fmtDuration(vitals.fcp)}`);
    setMeta("performance", parts.join(" · "));
  } else {
    setMeta("performance", "Measuring…");
    setVisible("performance", true);
  }

  // Files
  const loaded = ST.files.loaded.length;
  const skipped = ST.files.skipped.length;
  setVisible("files", loaded > 0);
  if (loaded > 0) {
    const parts = [`${loaded} loaded`];
    if (skipped) parts.push(`${skipped} skipped`);
    setMeta("files", parts.join(" · "));
  }

  // Storage
  const storCount = Object.keys(ST.storage.local || {}).length + Object.keys(ST.storage.session || {}).length;
  setVisible("storage", storCount > 0);
  if (storCount > 0) setMeta("storage", `${storCount} key${storCount === 1 ? "" : "s"}`);
  else setMeta("storage", "");

  // DOM
  setVisible("dom", true);
  setMeta("dom", ST.dom.inspectActive ? "Inspect active" : "Click to inspect");

  // A11y
  const a11yIssues = ST.a11y.issues ? ST.a11y.issues.length : null;
  setVisible("a11y", a11yIssues == null || a11yIssues > 0);
  if (a11yIssues != null) {
    setMeta("a11y", a11yIssues > 0 ? `<span class="warn">${a11yIssues} issue${a11yIssues === 1 ? "" : "s"}</span>` : "No issues");
  } else {
    setMeta("a11y", "Not scanned");
  }

  // Dev tools
  setVisible("devtools", true);
  setMeta("devtools", "");
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION: CONSOLE
// ═══════════════════════════════════════════════════════════════════
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
      <button class="fp-chip" id="fpConsoleClear" type="button" title="Clear">Clear</button>
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

  // Search
  const search = $("#fpConsoleSearch", body);
  search.addEventListener("input", debounce(() => {
    c.query = search.value;
    renderConsoleEntries(listEl, filterConsoleEntries());
  }, 120));

  // Filter chips
  body.querySelectorAll("[data-filter]").forEach(chip => {
    chip.addEventListener("click", () => {
      c.filter = chip.dataset.filter;
      body.querySelectorAll("[data-filter]").forEach(ch => ch.classList.toggle("active", ch === chip));
      renderConsoleEntries(listEl, filterConsoleEntries());
    });
  });

  // Clear
  $("#fpConsoleClear", body).addEventListener("click", () => {
    c.entries = [];
    c.expanded.clear();
    renderConsoleEntries(listEl, []);
    updateSectionMeta();
  });

  // REPL
  const repl = $("#fpConsoleRepl", body);
  const replResult = $("#fpConsoleReplResult", body);
  repl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && repl.value.trim()) {
      const code = repl.value.trim();
      repl.value = "";
      if (!ST.bridgeReady) {
        replResult.innerHTML = `<div class="fp-console-repl-result" data-ok="false">Bridge not ready</div>`;
        return;
      }
      ST.console.entries.push({
        id: ST.console.nextId++,
        level: "log",
        args: [{ kind: "string", value: "> " + code }],
        ts: Date.now(),
        file: null,
        line: null,
      });
      renderConsoleEntries(listEl, filterConsoleEntries());
      postToChild(REQ.EVAL, { code });
    }
  });

  // If bridge ever returns an eval result, we need to handle it outside
  // the message handler for console — the handler will append a synthetic
  // "result" console entry.
}

function filterConsoleEntries() {
  const c = ST.console;
  let list = c.entries;
  if (c.filter !== "all") list = list.filter(e => e.level === c.filter);
  if (c.query) {
    const q = c.query.toLowerCase();
    list = list.filter(e => {
      try {
        return JSON.stringify(e.args).toLowerCase().includes(q);
      } catch { return false; }
    });
  }
  return list;
}

function renderConsoleEntries(container, entries) {
  container.innerHTML = "";
  if (!entries.length) {
    container.innerHTML = `<div class="fp-empty"><strong>No console output</strong>Logs, warnings, and errors from your project appear here.</div>`;
    return;
  }
  for (const entry of entries) {
    container.appendChild(renderConsoleEntry(entry));
  }
  // Auto-scroll
  if (ST.console.autoScroll) {
    const wrap = container.closest(".fp-sec-body");
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }
}

function renderConsoleEntry(entry) {
  const row = el("div", { class: "fp-console-entry", "data-level": entry.level });
  const iconSvg = entry.level === "error" ? svgIcon("alert") : entry.level === "warn" ? svgIcon("warn") : svgIcon("info");
  row.appendChild(el("span", { class: "fp-console-icon", html: iconSvg }));

  // Meta
  const meta = el("span", { class: "fp-console-meta" });
  meta.appendChild(document.createTextNode(fmtTime(entry.ts) + " "));
  if (entry.file) {
    const fileSpan = el("span", { class: "fp-file" });
    fileSpan.textContent = entry.file + (entry.line ? ":" + entry.line : "");
    fileSpan.addEventListener("click", () => {
      if (typeof ST.options?.onOpenFile === "function") {
        ST.options.onOpenFile(entry.file.replace(/^\//, ""), entry.line || null);
      }
    });
    meta.appendChild(fileSpan);
    meta.appendChild(document.createTextNode(" "));
  }
  row.appendChild(meta);

  // Args
  const args = el("div", { class: "fp-console-args" });
  for (const arg of entry.args || []) {
    args.appendChild(renderConsoleArg(arg, entry.id));
  }
  row.appendChild(args);

  return row;
}

function renderConsoleArg(arg, entryId, keyPath = "") {
  const span = el("span", { class: "fp-console-arg", "data-kind": arg.kind || "object" });
  const id = `${entryId}:${keyPath || Math.random()}`;

  if (arg.kind === "string") {
    span.textContent = `"${arg.value}"`;
    return span;
  }
  if (arg.kind === "number" || arg.kind === "boolean") {
    span.textContent = String(arg.value);
    return span;
  }
  if (arg.kind === "null") { span.textContent = "null"; return span; }
  if (arg.kind === "undefined") { span.textContent = "undefined"; return span; }
  if (arg.kind === "function") { span.textContent = "ƒ " + (arg.value || ""); return span; }
  if (arg.kind === "symbol") { span.textContent = arg.value; return span; }
  if (arg.kind === "date") { span.textContent = arg.value; return span; }
  if (arg.kind === "regexp") { span.textContent = arg.value; return span; }
  if (arg.kind === "element" || arg.kind === "node") {
    span.textContent = "<" + arg.preview + ">";
    return span;
  }
  if (arg.kind === "error") {
    span.textContent = arg.name + ": " + arg.message;
    if (arg.stack) span.title = arg.stack;
    return span;
  }
  if (arg.kind === "array") {
    const isExpanded = ST.console.expanded.has(id);
    span.textContent = isExpanded ? `Array(${arg.length}) [` : `Array(${arg.length}) [ … ]`;
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isExpanded) ST.console.expanded.delete(id);
      else ST.console.expanded.add(id);
      const body = ST.sectionsEl.querySelector(`[data-body="console"]`);
      if (body) renderConsole(body);
    });
    if (isExpanded) {
      const nested = el("div", { class: "fp-console-nested", "data-expanded": "true" });
      (arg.items || []).forEach((item, i) => {
        const row = el("div", { class: "fp-console-nested-row" });
        row.appendChild(el("span", { class: "fp-nk", style: "color:#8a919c" }, String(i)));
        row.appendChild(renderConsoleArg(item, entryId, keyPath + "." + i));
        nested.appendChild(row);
      });
      const wrap = el("span");
      wrap.appendChild(span);
      wrap.appendChild(nested);
      return wrap;
    }
    return span;
  }
  if (arg.kind === "object") {
    const isExpanded = ST.console.expanded.has(id);
    const label = arg.constructor && arg.constructor !== "Object" ? arg.constructor : "{…}";
    span.textContent = isExpanded ? label + " {" : label + " { … }";
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isExpanded) ST.console.expanded.delete(id);
      else ST.console.expanded.add(id);
      const body = ST.sectionsEl.querySelector(`[data-body="console"]`);
      if (body) renderConsole(body);
    });
    if (isExpanded && arg.entries) {
      const nested = el("div", { class: "fp-console-nested", "data-expanded": "true" });
      for (const entry of arg.entries) {
        const row = el("div", { class: "fp-console-nested-row" });
        row.appendChild(el("span", { class: "fp-nk" }, entry.key));
        row.appendChild(renderConsoleArg(entry.value, entryId, keyPath + "." + entry.key));
        nested.appendChild(row);
      }
      const wrap = el("span");
      wrap.appendChild(span);
      wrap.appendChild(nested);
      return wrap;
    }
    return span;
  }
  span.textContent = String(arg.value ?? arg.preview ?? "");
  return span;
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION: NETWORK
// ═══════════════════════════════════════════════════════════════════
function renderNetwork(body) {
  const n = ST.network;
  let filtered = n.entries;
  if (n.filter === "2xx") filtered = filtered.filter(e => e.status >= 200 && e.status < 300);
  else if (n.filter === "3xx") filtered = filtered.filter(e => e.status >= 300 && e.status < 400);
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
      <button class="fp-chip" id="fpNetClear" type="button">Clear</button>
      <button class="fp-chip" id="fpNetWaterfall" type="button">${n.waterfallExpanded ? "Hide" : "Show"} waterfall</button>
    </div>
    <div class="fp-net-list" id="fpNetList"></div>
    <div id="fpNetWaterfallWrap"></div>
  `;

  const listEl = $("#fpNetList", body);
  if (!filtered.length) {
    listEl.innerHTML = `<div class="fp-empty"><strong>No requests</strong>fetch and XMLHttpRequest calls from your project appear here.</div>`;
  } else {
    for (const entry of filtered) {
      listEl.appendChild(renderNetworkRow(entry));
    }
  }

  // Filters
  body.querySelectorAll("[data-net-filter]").forEach(chip => {
    chip.addEventListener("click", () => {
      n.filter = chip.dataset.netFilter;
      renderNetwork(body);
    });
  });

  $("#fpNetClear", body)?.addEventListener("click", () => {
    n.entries = [];
    n.expanded.clear();
    renderNetwork(body);
    updateSectionMeta();
  });

  $("#fpNetWaterfall", body)?.addEventListener("click", () => {
    n.waterfallExpanded = !n.waterfallExpanded;
    renderNetwork(body);
  });

  // Waterfall
  if (n.waterfallExpanded && filtered.length > 0) {
    const wrap = $("#fpNetWaterfallWrap", body);
    wrap.appendChild(renderWaterfall(filtered));
  }
}

function renderNetworkRow(entry) {
  const row = el("div", { class: "fp-net-row", "data-id": entry.id });
  const statusFamily = entry.error ? "error" : Math.floor(entry.status / 100);
  row.appendChild(el("span", { class: "fp-net-method" }, entry.method));
  row.appendChild(el("span", { class: "fp-net-status", "data-family": statusFamily }, entry.error ? "ERR" : String(entry.status || "—")));
  row.appendChild(el("span", { class: "fp-net-url", title: entry.url }, entry.url));
  row.appendChild(el("span", { class: "fp-net-dur" }, fmtDuration(entry.durationMs)));

  const isExpanded = ST.network.expanded.has(entry.id);
  const detail = el("div", { class: "fp-net-detail", "data-open": isExpanded ? "true" : "false" });
  detail.innerHTML = `
    <div class="fp-net-detail-row"><span class="fk">URL</span><span class="fv">${escapeHtml(entry.url)}</span></div>
    <div class="fp-net-detail-row"><span class="fk">Method</span><span class="fv">${escapeHtml(entry.method)}</span></div>
    <div class="fp-net-detail-row"><span class="fk">Status</span><span class="fv">${entry.error ? "Error: " + escapeHtml(entry.error) : String(entry.status)}</span></div>
    <div class="fp-net-detail-row"><span class="fk">Duration</span><span class="fv">${fmtDuration(entry.durationMs)}</span></div>
  `;

  row.addEventListener("click", () => {
    if (isExpanded) ST.network.expanded.delete(entry.id);
    else ST.network.expanded.add(entry.id);
    const body = ST.sectionsEl.querySelector(`[data-body="network"]`);
    if (body) renderNetwork(body);
  });

  const wrap = el("div");
  wrap.appendChild(row);
  wrap.appendChild(detail);
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
    const pct = Math.max(2, Math.min(100, ((entry.durationMs || 0) / max) * 100));
    bar.appendChild(el("div", { class: "fw-bar-fill", style: { width: pct + "%" } }));
    row.appendChild(bar);
    row.appendChild(el("span", { class: "fw-dur" }, fmtDuration(entry.durationMs)));
    wrap.appendChild(row);
  }
  return wrap;
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION: RESPONSIVE
// ═══════════════════════════════════════════════════════════════════
function renderResponsive(body) {
  const r = ST.responsive;

  body.innerHTML = `
    <div class="fp-toolbar">
      <button class="fp-chip" id="fpRespScan" type="button">${svgIcon("ruler")} Scan now</button>
    </div>
    <div id="fpRespContent"></div>
  `;

  $("#fpRespScan", body).addEventListener("click", () => {
    ST.responsive.scanning = true;
    postToChild(REQ.RESPONSIVE_SCAN);
    const content = $("#fpRespContent", body);
    if (content) content.innerHTML = `<div class="fp-empty">Scanning…</div>`;
  });

  const content = $("#fpRespContent", body);
  if (!r.result) {
    content.innerHTML = `<div class="fp-empty"><strong>Not scanned yet</strong>Click "Scan now" to check for overflow, touch targets, and small text.</div>`;
    return;
  }

  content.innerHTML = "";

  // Stats
  const stats = el("div", { class: "fp-resp-grid" });
  stats.appendChild(el("div", { class: "fp-resp-stat" },
    el("div", { class: "fp-resp-stat-label" }, "Viewport"),
    el("div", { class: "fp-resp-stat-value" }, (r.result.viewportWidth || 0) + " px"),
  ));
  stats.appendChild(el("div", { class: "fp-resp-stat" },
    el("div", { class: "fp-resp-stat-label" }, "Overflow"),
    el("div", { class: "fp-resp-stat-value", "data-warn": (r.result.overflow?.length || 0) > 0 ? "true" : "false" }, String(r.result.overflow?.length || 0)),
  ));
  stats.appendChild(el("div", { class: "fp-resp-stat" },
    el("div", { class: "fp-resp-stat-label" }, "Touch targets"),
    el("div", { class: "fp-resp-stat-value", "data-warn": (r.result.touchTargets?.length || 0) > 0 ? "true" : "false" }, String(r.result.touchTargets?.length || 0)),
  ));
  stats.appendChild(el("div", { class: "fp-resp-stat" },
    el("div", { class: "fp-resp-stat-label" }, "Small text"),
    el("div", { class: "fp-resp-stat-value", "data-warn": (r.result.smallText?.length || 0) > 0 ? "true" : "false" }, String(r.result.smallText?.length || 0)),
  ));
  content.appendChild(stats);

  // Overflow
  if (r.result.overflow?.length) {
    content.appendChild(renderIssueGroup("Overflow", "error", r.result.overflow.map(o => ({
      path: o.path,
      detail: `Right: ${o.right}px (viewport ${o.viewportWidth}px)`,
    }))));
  }

  // Touch targets
  if (r.result.touchTargets?.length) {
    content.appendChild(renderIssueGroup("Touch targets under 44px", "warn", r.result.touchTargets.map(t => ({
      path: t.path,
      detail: `${t.width}×${t.height}px`,
    }))));
  }

  // Small text
  if (r.result.smallText?.length) {
    content.appendChild(renderIssueGroup("Small text under 12px", "warn", r.result.smallText.map(t => ({
      path: t.path,
      detail: `${t.fontSize}px`,
    }))));
  }
}

function renderIssueGroup(title, severity, issues) {
  const group = el("div", { class: "fp-resp-group" });
  group.appendChild(el("div", { class: "fp-resp-group-title" }, title, el("span", { class: "fp-count" }, String(issues.length))));
  for (const issue of issues) {
    const row = el("div", { class: "fp-resp-issue", "data-severity": severity });
    row.appendChild(el("div", { class: "fp-issue-path" }, issue.path));
    row.appendChild(el("div", { class: "fp-issue-detail" }, issue.detail));
    row.addEventListener("click", () => {
      if (ST.bridgeReady) postToChild(REQ.HIGHLIGHT, { path: issue.path });
    });
    group.appendChild(row);
  }
  return group;
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION: PERFORMANCE
// ═══════════════════════════════════════════════════════════════════
function renderPerformance(body) {
  body.innerHTML = "";
  const v = ST.vitals;

  // Vitals grid
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

  // Payload
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
  };
  addPayloadRow("JavaScript", jsBytes, 100 * 1024);
  addPayloadRow("CSS", cssBytes, 50 * 1024);
  addPayloadRow("Images", imgBytes, 500 * 1024);
  addPayloadRow("Total", jsBytes + cssBytes + imgBytes, 800 * 1024);
  body.appendChild(payload);

  // Resource waterfall
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

  // Layout shifts
  if (ST.layoutShifts.length) {
    body.appendChild(el("div", { class: "fp-net-waterfall-title", style: "margin-top:12px" }, "Layout shifts (" + ST.layoutShifts.length + ")"));
    const list = el("div");
    for (const shift of ST.layoutShifts.slice(0, 10)) {
      const row = el("div", { class: "fp-resp-issue", "data-severity": shift.value > 0.1 ? "error" : "warn" });
      row.appendChild(el("div", { class: "fp-issue-path" }, "Score: " + shift.value.toFixed(3)));
      row.appendChild(el("div", { class: "fp-issue-detail" }, shift.sources?.join(", ") || "unknown source"));
      list.appendChild(row);
    }
    body.appendChild(list);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION: FILES
// ═══════════════════════════════════════════════════════════════════
function renderFiles(body) {
  body.innerHTML = "";
  const loaded = ST.files.loaded;
  const skipped = ST.files.skipped;

  if (!loaded.length && !skipped.length) {
    body.innerHTML = `<div class="fp-empty"><strong>No files</strong>File information appears once the preview has loaded.</div>`;
    return;
  }

  if (loaded.length) {
    const group = el("div", { class: "fp-files-group" });
    group.appendChild(el("div", { class: "fp-files-group-title" }, "Loaded", el("span", { class: "fp-count" }, String(loaded.length))));
    for (const f of loaded) {
      const row = el("div", { class: "fp-files-row", "data-loaded": "true", "data-clickable": "true" });
      row.appendChild(el("span", { class: "fp-files-status" }, "✓"));
      row.appendChild(el("span", { class: "fp-files-path" }, f.path));
      row.appendChild(el("span", { class: "fp-files-size" }, fmtBytes(f.size || 0)));
      row.addEventListener("click", () => {
        if (typeof ST.options?.onOpenFile === "function") {
          ST.options.onOpenFile(f.path, null);
        }
      });
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

// ═══════════════════════════════════════════════════════════════════
//  SECTION: STORAGE
// ═══════════════════════════════════════════════════════════════════
function renderStorage(body) {
  body.innerHTML = `
    <div class="fp-toolbar">
      <button class="fp-chip" id="fpStorReload" type="button">${svgIcon("refresh")} Reload</button>
      <button class="fp-chip" id="fpStorClear" type="button">${svgIcon("trash")} Clear all</button>
    </div>
    <div id="fpStorContent"></div>
  `;

  const render = () => {
    const content = $("#fpStorContent", body);
    if (!content) return;
    content.innerHTML = "";
    const localKeys = Object.keys(ST.storage.local || {});
    const sessionKeys = Object.keys(ST.storage.session || {});

    if (!localKeys.length && !sessionKeys.length) {
      content.innerHTML = `<div class="fp-empty"><strong>Nothing stored</strong>Your project's localStorage and sessionStorage appear here. Cleared on refresh.</div>`;
      return;
    }

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
        delBtn.addEventListener("click", () => {
          postToChild(REQ.CLEAR_STORAGE, { key: k, kind });
          delete store[k];
          render();
        });
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

  $("#fpStorReload", body).addEventListener("click", () => {
    postToChild(REQ.STORAGE_SNAPSHOT);
  });

  $("#fpStorClear", body).addEventListener("click", () => {
    postToChild(REQ.CLEAR_STORAGE);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION: DOM
// ═══════════════════════════════════════════════════════════════════
function renderDOM(body) {
  body.innerHTML = `
    <div class="fp-toolbar">
      <button class="fp-chip" id="fpDomReload" type="button">${svgIcon("refresh")} Reload tree</button>
      <button class="fp-chip ${ST.dom.inspectActive ? "active" : ""}" id="fpDomInspect" type="button">${svgIcon("crosshair")} ${ST.dom.inspectActive ? "Stop inspecting" : "Inspect"}</button>
    </div>
    <div class="fp-dom-tree" id="fpDomTree"></div>
  `;

  const treeEl = $("#fpDomTree", body);

  if (!ST.dom.tree) {
    treeEl.innerHTML = `<div class="fp-empty"><strong>DOM tree not loaded</strong>Click "Reload tree" to load the current document structure.</div>`;
  } else {
    treeEl.innerHTML = "";
    treeEl.appendChild(renderDOMNode(ST.dom.tree, "root", 0));
  }

  $("#fpDomReload", body).addEventListener("click", () => {
    ST.dom.tree = null;
    postToChild(REQ.DOM_SNAPSHOT);
  });

  $("#fpDomInspect", body).addEventListener("click", () => {
    ST.dom.inspectActive = !ST.dom.inspectActive;
    if (ST.dom.inspectActive) postToChild(REQ.INSPECT_START);
    else postToChild(REQ.INSPECT_STOP);
    renderDOM(body);
    updateSectionMeta();
  });
}

function renderDOMNode(node, path, depth) {
  if (!node) return el("div");
  const id = path;
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = ST.dom.expanded.has(id) || depth < 2;

  const wrap = el("div", { class: "fp-dom-node", "data-has-children": hasChildren ? "true" : "false" });

  const row = el("div");
  if (hasChildren) {
    const toggle = el("span", { class: "fp-dom-toggle" }, isExpanded ? "▾" : "▸");
    toggle.addEventListener("click", () => {
      if (ST.dom.expanded.has(id)) ST.dom.expanded.delete(id);
      else ST.dom.expanded.add(id);
      const body = ST.sectionsEl.querySelector(`[data-body="dom"]`);
      if (body) renderDOM(body);
    });
    row.appendChild(toggle);
  } else {
    row.appendChild(el("span", { class: "fp-dom-toggle" }, " "));
  }

  if (node.tag === "#text") {
    row.appendChild(el("span", { style: "color:#8a919c;font-style:italic" }, '"' + (node.text || "").slice(0, 60) + '"'));
  } else {
    const tag = el("span", { class: "fp-dom-tag" }, node.tag);
    tag.addEventListener("click", () => {
      ST.dom.selectedPath = node.tag + (node.id ? "#" + node.id : "");
      if (ST.bridgeReady) postToChild(REQ.HIGHLIGHT, { path: path });
    });
    row.appendChild(tag);
    if (node.id) row.appendChild(el("span", { class: "fp-dom-id" }, "#" + node.id));
    if (node.className) {
      for (const cls of node.className.split(/\s+/).filter(Boolean).slice(0, 3)) {
        row.appendChild(el("span", { class: "fp-dom-class" }, "." + cls));
      }
    }
  }

  wrap.appendChild(row);

  if (hasChildren && isExpanded) {
    const children = el("div", { class: "fp-dom-children" });
    for (let i = 0; i < node.children.length; i++) {
      children.appendChild(renderDOMNode(node.children[i], path + "." + i, depth + 1));
    }
    wrap.appendChild(children);
  }

  return wrap;
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION: ACCESSIBILITY
// ═══════════════════════════════════════════════════════════════════
function renderA11y(body) {
  body.innerHTML = `
    <div class="fp-toolbar">
      <button class="fp-chip" id="fpA11yScan" type="button">${svgIcon("shield")} Scan now</button>
    </div>
    <div id="fpA11yContent"></div>
  `;

  $("#fpA11yScan", body).addEventListener("click", () => {
    ST.a11y.scanning = true;
    postToChild(REQ.A11Y_SCAN);
    const content = $("#fpA11yContent", body);
    if (content) content.innerHTML = `<div class="fp-empty">Scanning…</div>`;
  });

  const content = $("#fpA11yContent", body);
  if (!ST.a11y.issues) {
    content.innerHTML = `<div class="fp-empty"><strong>Not scanned yet</strong>Click "Scan now" to check for accessibility issues.</div>`;
    return;
  }

  content.innerHTML = "";
  if (!ST.a11y.issues.length) {
    content.innerHTML = `<div class="fp-empty"><strong>No issues found</strong>No obvious accessibility problems detected.</div>`;
    return;
  }

  // Group by type
  const groups = {};
  for (const issue of ST.a11y.issues) {
    if (!groups[issue.type]) groups[issue.type] = [];
    groups[issue.type].push(issue);
  }

  for (const [type, issues] of Object.entries(groups)) {
    const group = el("div", { class: "fp-a11y-group" });
    group.appendChild(el("div", { class: "fp-a11y-group-title" }, type.replace(/-/g, " "), el("span", { class: "fp-count" }, String(issues.length))));
    for (const issue of issues) {
      const row = el("div", { class: "fp-a11y-issue", "data-severity": issue.severity });
      row.appendChild(el("div", { class: "fp-a11y-issue-title" }, issue.title));
      if (issue.detail) row.appendChild(el("div", { class: "fp-a11y-issue-detail" }, issue.detail));
      group.appendChild(row);
    }
    content.appendChild(group);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION: DEV TOOLS
// ═══════════════════════════════════════════════════════════════════
function renderDevTools(body) {
  body.innerHTML = `
    <div class="fp-devtools-grid">
      <button class="fp-devtools-btn" id="fpDevCopyHtml" type="button">${svgIcon("copy")} Copy HTML</button>
      <button class="fp-devtools-btn" id="fpDevCopyTitle" type="button">${svgIcon("copy")} Copy title</button>
      <button class="fp-devtools-btn" id="fpDevReload" type="button">${svgIcon("refresh")} Hard reload</button>
      <button class="fp-devtools-btn" id="fpDevSlow" type="button">${svgIcon("wifi")} Simulate slow network</button>
      <button class="fp-devtools-btn" id="fpDevOffline" type="button">${svgIcon("wifiOff")} Simulate offline</button>
      <button class="fp-devtools-btn" id="fpDevReset" type="button">${svgIcon("check")} Reset network</button>
      <button class="fp-devtools-btn" id="fpDevClearAll" type="button" data-danger="true">${svgIcon("trash")} Clear all state</button>
    </div>
    <div class="fp-empty" style="margin-top:10px;font-size:10px;padding:10px 4px;">
      <strong>Simulated network</strong>
      Slow adds ~1.5s latency to fetch calls. Offline fails them. Both are approximations — not real throttling.
    </div>
  `;

  $("#fpDevCopyHtml", body).addEventListener("click", async () => {
    if (ST.dom.tree) {
      const html = serializeDOMToHtml(ST.dom.tree);
      const ok = await copyToClipboard(html);
      if (ok) toast("HTML copied", "success");
      else toast("Copy failed", "error");
    } else {
      postToChild(REQ.DOM_SNAPSHOT);
      setTimeout(async () => {
        if (ST.dom.tree) {
          const html = serializeDOMToHtml(ST.dom.tree);
          const ok = await copyToClipboard(html);
          if (ok) toast("HTML copied", "success");
        }
      }, 300);
    }
  });

  $("#fpDevCopyTitle", body).addEventListener("click", async () => {
    if (ST.iframeEl?.contentWindow) {
      try {
        const title = ST.iframeEl.contentDocument?.title;
        if (title) {
          const ok = await copyToClipboard(title);
          if (ok) toast("Title copied", "success");
        }
      } catch {}
    }
  });

  $("#fpDevReload", body).addEventListener("click", () => {
    postToChild(REQ.RELOAD);
  });

  $("#fpDevSlow", body).addEventListener("click", () => {
    ST.devtools.latencyMs = 1500;
    postToChild(REQ.SIMULATE_NETWORK, { latencyMs: 1500, failureRate: 0 });
    toast("Slow network simulated", "info");
  });

  $("#fpDevOffline", body).addEventListener("click", () => {
    ST.devtools.failureRate = 1;
    postToChild(REQ.SIMULATE_NETWORK, { latencyMs: 0, failureRate: 1 });
    toast("Offline simulated", "info");
  });

  $("#fpDevReset", body).addEventListener("click", () => {
    ST.devtools.latencyMs = 0;
    ST.devtools.failureRate = 0;
    postToChild(REQ.SIMULATE_NETWORK, { latencyMs: 0, failureRate: 0 });
    toast("Network reset", "info");
  });

  $("#fpDevClearAll", body).addEventListener("click", () => {
    ST.console.entries = [];
    ST.network.entries = [];
    ST.a11y.issues = null;
    ST.responsive.result = null;
    ST.storage.local = {};
    ST.storage.session = {};
    ST.dom.tree = null;
    postToChild(REQ.CLEAR_STORAGE);
    renderSection("console");
    renderSection("network");
    updateSectionMeta();
    toast("State cleared", "success");
  });
}

function serializeDOMToHtml(node) {
  if (!node) return "";
  if (node.tag === "#text") return escapeHtml(node.text || "");
  let html = "<" + node.tag;
  if (node.id) html += ' id="' + escapeHtml(node.id) + '"';
  if (node.className) html += ' class="' + escapeHtml(node.className) + '"';
  html += ">";
  if (node.children) {
    for (const child of node.children) html += serializeDOMToHtml(child);
  }
  html += "</" + node.tag + ">";
  return html;
}

// ═══════════════════════════════════════════════════════════════════
//  SIZING
// ═══════════════════════════════════════════════════════════════════
function applySizing() {
  const s = ST.sizer;
  const mode = s.mode;
  const frame = ST.frameEl;
  if (!frame) return;

  frame.setAttribute("data-mode", mode);

  if (mode === "fit") {
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.maxWidth = "";
    frame.style.maxHeight = "";
    frame.style.transform = "";
    frame.setAttribute("data-device", "false");
    s.scale = 1;
    return;
  }

  let dims;
  let isDevice = true;
  if (mode === "custom") {
    dims = s.custom;
    isDevice = false;
  } else {
    dims = SIZE_PRESETS[mode];
  }

  frame.setAttribute("data-device", isDevice ? "true" : "false");
  frame.style.width = dims.w + "px";
  frame.style.height = dims.h + "px";

  // Compute scale
  const stageW = ST.stageEl.clientWidth - 32;
  const stageH = ST.stageEl.clientHeight - 32;
  const frameW = dims.w + (isDevice ? 16 : 0);
  const frameH = dims.h + (isDevice ? 16 : 0);
  const scale = Math.min(1, stageW / frameW, stageH / frameH);
  s.scale = scale;
  frame.style.transform = scale < 1 ? `scale(${scale})` : "";

  // Update readout
  const readout = ST.overlayEl.querySelector("#fpReadout");
  if (readout) readout.textContent = dims.w + " × " + dims.h;

  // Update dims inputs
  const dimsEl = ST.overlayEl.querySelector("#fpDims");
  const dimsW = ST.overlayEl.querySelector("#fpDimsW");
  const dimsH = ST.overlayEl.querySelector("#fpDimsH");
  if (dimsEl) dimsEl.hidden = mode !== "custom";
  if (dimsW) dimsW.value = dims.w;
  if (dimsH) dimsH.value = dims.h;

  // Update size bar active state
  ST.overlayEl.querySelectorAll(".fp-size-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.size === mode);
  });

  // Persist
  if (s.pid) {
    try {
      localStorage.setItem(LS_MODE(s.pid), mode);
      localStorage.setItem(LS_SIZE(s.pid), `${s.custom.w}x${s.custom.h}`);
    } catch {}
  }
}

function startDrag(evt, corner) {
  if (ST.sizer.mode !== "custom") return;
  evt.preventDefault();
  const s = ST.sizer;
  s.drag = {
    corner,
    startX: evt.clientX,
    startY: evt.clientY,
    startW: s.custom.w,
    startH: s.custom.h,
    scale: s.scale || 1,
  };
  window.addEventListener("pointermove", onDrag);
  window.addEventListener("pointerup", endDrag, { once: true });
}

function onDrag(evt) {
  const s = ST.sizer;
  if (!s.drag) return;
  const dx = (evt.clientX - s.drag.startX) / s.drag.scale;
  const dy = (evt.clientY - s.drag.startY) / s.drag.scale;
  const signX = s.drag.corner === "br" ? 1 : -1;
  const signY = s.drag.corner === "br" ? 1 : -1;
  const newW = Math.max(CUSTOM_MIN.w, Math.min(CUSTOM_MAX.w, Math.round(s.drag.startW + dx * signX)));
  const newH = Math.max(CUSTOM_MIN.h, Math.min(CUSTOM_MAX.h, Math.round(s.drag.startH + dy * signY)));
  s.custom.w = newW;
  s.custom.h = newH;
  ST.frameEl.style.width = newW + "px";
  ST.frameEl.style.height = newH + "px";
  const stageW = ST.stageEl.clientWidth - 32;
  const stageH = ST.stageEl.clientHeight - 32;
  const scale = Math.min(1, stageW / newW, stageH / newH);
  s.scale = scale;
  ST.frameEl.style.transform = scale < 1 ? `scale(${scale})` : "";
  const readout = ST.overlayEl.querySelector("#fpReadout");
  if (readout) readout.textContent = newW + " × " + newH;
  const dimsW = ST.overlayEl.querySelector("#fpDimsW");
  const dimsH = ST.overlayEl.querySelector("#fpDimsH");
  if (dimsW) dimsW.value = newW;
  if (dimsH) dimsH.value = newH;
}

function endDrag() {
  window.removeEventListener("pointermove", onDrag);
  ST.sizer.drag = null;
  applySizing();
}

// ═══════════════════════════════════════════════════════════════════
//  BRIDGE INJECTION
// ═══════════════════════════════════════════════════════════════════
function injectBridge(html) {
  const bridge = `<script>${BRIDGE_SCRIPT}<\/script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + "\n" + bridge + "\n");
  }
  return bridge + html;
}

// ═══════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════
function handleMessage(e) {
  if (!e.data || e.data.__folio !== true) return;
  if (e.source !== ST.iframeEl?.contentWindow) return;

  const { type } = e.data;

  switch (type) {
    case MSG.READY:
      ST.bridgeReady = true;
      break;

    case MSG.CONSOLE:
      addConsoleEntry(e.data);
      break;

    case MSG.ERROR:
      addErrorEntry(e.data);
      break;

    case MSG.NETWORK:
      addNetworkEntry(e.data);
      break;

    case MSG.STORAGE_WRITE:
      handleStorageWrite(e.data);
      break;

    case MSG.STORAGE_SNAPSHOT_RESULT:
      ST.storage.local = e.data.local || {};
      ST.storage.session = e.data.session || {};
      ST.storage.loaded = true;
      if (ST.openSection === "storage") {
        const body = ST.sectionsEl.querySelector(`[data-body="storage"]`);
        if (body) renderStorage(body);
      }
      updateSectionMeta();
      break;

    case MSG.VITALS:
      mergeVitals(e.data);
      break;

    case MSG.RESOURCE:
      addResource(e.data);
      break;

    case MSG.LAYOUT_SHIFT:
      addLayoutShift(e.data);
      break;

    case MSG.DOM_SNAPSHOT:
      ST.dom.tree = e.data.tree;
      ST.dom.loading = false;
      if (ST.openSection === "dom") {
        const body = ST.sectionsEl.querySelector(`[data-body="dom"]`);
        if (body) renderDOM(body);
      }
      break;

    case MSG.INSPECT_RESULT:
      handleInspectResult(e.data);
      break;

    case MSG.A11Y_RESULT:
      ST.a11y.issues = e.data.issues || [];
      ST.a11y.scanning = false;
      if (ST.openSection === "a11y") {
        const body = ST.sectionsEl.querySelector(`[data-body="a11y"]`);
        if (body) renderA11y(body);
      }
      updateSectionMeta();
      break;

    case MSG.RESPONSIVE_RESULT:
      ST.responsive.result = e.data;
      ST.responsive.scanning = false;
      if (ST.openSection === "responsive") {
        const body = ST.sectionsEl.querySelector(`[data-body="responsive"]`);
        if (body) renderResponsive(body);
      }
      updateSectionMeta();
      break;

    case MSG.EVAL_RESULT:
      handleEvalResult(e.data);
      break;
  }
}

function addConsoleEntry(data) {
  const entry = {
    id: ST.console.nextId++,
    level: data.level,
    args: data.args || [],
    ts: data.ts || Date.now(),
    file: data.file,
    line: data.line,
  };
  ST.console.entries.push(entry);
  if (ST.console.entries.length > LIMITS.consoleEntries) {
    ST.console.entries = ST.console.entries.slice(-LIMITS.consoleEntries);
  }
  if (ST.openSection === "console") {
    const body = ST.sectionsEl.querySelector(`[data-body="console"]`);
    const listEl = body && $("#fpConsoleList", body);
    if (listEl) {
      const filtered = filterConsoleEntries();
      renderConsoleEntries(listEl, filtered);
    }
  } else if (entry.level === "error") {
    // Auto-open console on first error
    if (!ST.openSection) openSection("console");
  }
  updateSectionMeta();
}

function addErrorEntry(data) {
  addConsoleEntry({
    level: "error",
    args: [{ kind: "error", name: "Uncaught", message: data.message, stack: data.stack }],
    ts: Date.now(),
    file: data.file,
    line: data.line,
  });
}

function addNetworkEntry(data) {
  ST.network.entries.push({
    id: ST.network.nextId++,
    method: data.method,
    url: data.url,
    status: data.status,
    durationMs: data.durationMs,
    error: data.error,
  });
  if (ST.network.entries.length > LIMITS.networkEntries) {
    ST.network.entries = ST.network.entries.slice(-LIMITS.networkEntries);
  }
  if (ST.openSection === "network") {
    const body = ST.sectionsEl.querySelector(`[data-body="network"]`);
    if (body) renderNetwork(body);
  }
  updateSectionMeta();
}

function handleStorageWrite(data) {
  const store = data.kind === "local" ? ST.storage.local : ST.storage.session;
  if (data.op === "set") store[data.key] = data.value;
  else if (data.op === "remove") delete store[data.key];
  else if (data.op === "clear") {
    for (const k of Object.keys(store)) delete store[k];
  }
  if (ST.openSection === "storage") {
    const body = ST.sectionsEl.querySelector(`[data-body="storage"]`);
    if (body) renderStorage(body);
  }
  updateSectionMeta();
}

function mergeVitals(data) {
  Object.assign(ST.vitals, data);
  if (ST.openSection === "performance") {
    const body = ST.sectionsEl.querySelector(`[data-body="performance"]`);
    if (body) renderPerformance(body);
  }
  updateSectionMeta();
}

function addResource(data) {
  ST.resources.push(data);
  if (ST.openSection === "performance") {
    const body = ST.sectionsEl.querySelector(`[data-body="performance"]`);
    if (body) renderPerformance(body);
  }
}

function addLayoutShift(data) {
  ST.layoutShifts.push(data);
  if (ST.openSection === "performance") {
    const body = ST.sectionsEl.querySelector(`[data-body="performance"]`);
    if (body) renderPerformance(body);
  }
}

function handleInspectResult(data) {
  // Highlight in DOM tree
  ST.dom.selectedPath = data.elementPath;
  if (ST.openSection === "dom") {
    const body = ST.sectionsEl.querySelector(`[data-body="dom"]`);
    if (body) renderDOM(body);
  }
  ST.dom.inspectActive = false;
  updateSectionMeta();
}

function handleEvalResult(data) {
  const body = ST.sectionsEl.querySelector(`[data-body="console"]`);
  const resultEl = body && $("#fpConsoleReplResult", body);
  if (!resultEl) return;
  if (data.ok) {
    resultEl.innerHTML = `<div class="fp-console-repl-result" data-ok="true">${escapeHtml(serializeConsoleValue(data.value))}</div>`;
  } else {
    resultEl.innerHTML = `<div class="fp-console-repl-result" data-ok="false">${escapeHtml(data.error || "Error")}</div>`;
  }
}

function serializeConsoleValue(v) {
  if (!v) return "undefined";
  if (v.kind === "string") return `"${v.value}"`;
  if (v.kind === "number" || v.kind === "boolean") return String(v.value);
  if (v.kind === "null") return "null";
  if (v.kind === "undefined") return "undefined";
  if (v.kind === "array") return `Array(${v.length}) [${(v.items || []).map(serializeConsoleValue).join(", ")}]`;
  if (v.kind === "object") return `{ ${(v.entries || []).map(e => e.key + ": " + serializeConsoleValue(e.value)).join(", ")} }`;
  if (v.kind === "error") return `${v.name}: ${v.message}`;
  return v.preview || String(v.value ?? "");
}

// ═══════════════════════════════════════════════════════════════════
//  HEADER / CONTROLS WIRING
// ═══════════════════════════════════════════════════════════════════
function wireControls() {
  const overlay = ST.overlayEl;

  // Size buttons
  overlay.querySelectorAll("[data-size]").forEach(btn => {
    btn.addEventListener("click", () => {
      ST.sizer.mode = btn.dataset.size;
      applySizing();
    });
  });

  // Dimension inputs
  const dimsW = overlay.querySelector("#fpDimsW");
  const dimsH = overlay.querySelector("#fpDimsH");
  const onDimChange = () => {
    const w = Math.max(CUSTOM_MIN.w, Math.min(CUSTOM_MAX.w, parseInt(dimsW.value, 10) || ST.sizer.custom.w));
    const h = Math.max(CUSTOM_MIN.h, Math.min(CUSTOM_MAX.h, parseInt(dimsH.value, 10) || ST.sizer.custom.h));
    ST.sizer.custom.w = w;
    ST.sizer.custom.h = h;
    applySizing();
  };
  dimsW?.addEventListener("input", debounce(onDimChange, 300));
  dimsH?.addEventListener("input", debounce(onDimChange, 300));

  // Refresh / close
  overlay.querySelector("#fpBtnRefresh")?.addEventListener("click", () => {
    if (typeof ST.options?.onRefresh === "function") {
      ST.options.onRefresh();
    } else {
      postToChild(REQ.RELOAD);
    }
  });

  overlay.querySelector("#fpBtnClose")?.addEventListener("click", () => {
    if (typeof ST.options?.onClose === "function") {
      ST.options.onClose();
    } else {
      closePreview();
    }
  });

  // Resize handles
  overlay.querySelector("#fpResizeBR")?.addEventListener("pointerdown", (e) => startDrag(e, "br"));
  overlay.querySelector("#fpResizeTL")?.addEventListener("pointerdown", (e) => startDrag(e, "tl"));

  // Dock grip
  const grip = overlay.querySelector("#fpDockGrip");
  let dockDragStart = 0;
  let dockStartHeight = 0;
  grip?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dockDragStart = e.clientY;
    dockStartHeight = ST.dockEl.offsetHeight;
    const onMove = (ev) => {
      const dy = dockDragStart - ev.clientY;
      const newH = Math.max(40, Math.min(window.innerHeight * 0.85, dockStartHeight + dy));
      ST.dockEl.style.height = newH + "px";
      ST.dockEl.setAttribute("data-expanded", newH > 60 ? "true" : "false");
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  // Resize observation for stage scaling
  const ro = new ResizeObserver(() => {
    if (ST.sizer.mode !== "fit") applySizing();
  });
  ro.observe(ST.stageEl);
}

// ═══════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════════
export function initPreview(options) {
  ST.options = options || {};
  if (!options?.rootEl) {
    console.warn("[preview] initPreview requires options.rootEl");
    return;
  }
  ST.rootEl = options.rootEl;

  injectStyles();
  buildOverlay(options.rootEl);
  buildSections();
  wireControls();

  window.addEventListener("message", handleMessage);

  // Escape to close
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (ST.overlayEl.getAttribute("data-open") !== "true") return;
    if (ST.openSection) {
      closeSection();
      return;
    }
    closePreview();
    if (typeof options?.onClose === "function") options.onClose();
  });
}

export async function openPreview({ html, files, projectName, pid, activeFile, fileOptions }) {
  if (!ST.overlayEl) {
    console.warn("[preview] openPreview called before initPreview");
    return;
  }

  ST.projectName = projectName || "";
  ST.pid = pid || null;
  ST.activeFile = activeFile || null;
  ST.fileOptions = fileOptions || [];

  // Bind sizer to this pid
  ST.sizer.pid = pid;
  let savedMode = "fit";
  let savedSize = { w: 768, h: 1024 };
  try {
    savedMode = localStorage.getItem(LS_MODE(pid)) || "fit";
    const parts = (localStorage.getItem(LS_SIZE(pid)) || "768x1024").split("x").map(Number);
    if (parts[0] && parts[1]) savedSize = { w: parts[0], h: parts[1] };
  } catch {}
  ST.sizer.mode = ["fit", "phone", "tablet", "laptop", "custom"].includes(savedMode) ? savedMode : "fit";
  ST.sizer.custom = savedSize;

  // Split files
  const loaded = [];
  const skipped = [];
  for (const f of files || []) {
    if (f.skippedReason) skipped.push(f);
    else loaded.push(f);
  }
  ST.files.loaded = loaded;
  ST.files.skipped = skipped;

  // Reset per-preview data (but keep size prefs)
  ST.console.entries = [];
  ST.console.expanded.clear();
  ST.network.entries = [];
  ST.network.expanded.clear();
  ST.vitals = { lcp: null, fcp: null, cls: null, tbt: null, inp: null };
  ST.resources = [];
  ST.layoutShifts = [];
  ST.a11y.issues = null;
  ST.a11y.scanning = false;
  ST.responsive.result = null;
  ST.storage = { local: {}, session: {}, loaded: false };
  ST.dom.tree = null;
  ST.dom.expanded.clear();
  ST.dom.inspectActive = false;
  ST.bridgeReady = false;

  // Inject bridge + set html
  ST.iframeEl.srcdoc = injectBridge(html || "");

  // Show overlay
  ST.overlayEl.setAttribute("data-open", "true");

  // Apply sizing
  requestAnimationFrame(() => {
    applySizing();
    updateSectionMeta();
  });

  // Reset dock state — keep it collapsed by default
  ST.dockEl.setAttribute("data-expanded", "false");
  ST.openSection = null;
  ST.sectionsEl.querySelectorAll(".fp-sec").forEach(sec => {
    sec.setAttribute("data-open", "false");
  });
}

export function closePreview() {
  if (!ST.overlayEl) return;
  ST.overlayEl.setAttribute("data-open", "false");
  ST.bridgeReady = false;
  ST.iframeEl.srcdoc = "";
  closeSection();
}

export function setPreviewProject({ pid, activeFile, fileOptions }) {
  ST.pid = pid || ST.pid;
  ST.activeFile = activeFile || ST.activeFile;
  ST.fileOptions = fileOptions || ST.fileOptions;
  ST.sizer.pid = pid;
}

export function isPreviewOpen() {
  return ST.overlayEl && ST.overlayEl.getAttribute("data-open") === "true";
}

// Export internals for testing / advanced integration
export const __internal = {
  state: ST,
  applySizing,
  openSection,
  closeSection,
};