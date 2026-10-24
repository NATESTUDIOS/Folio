// js/ai.js
// ═══════════════════════════════════════════════════════════════════
//  Folio AI — complete client module
//  ────────────────────────────────────────────────────────────────
//  One file. Everything the AI needs on the client.
//
//  Offline-first:
//    • All rendering (markdown, mermaid, katex, diff, artifacts) works
//      offline once the lazy assets are cached by the SW.
//    • Pending proposals persist in sessionStorage keyed on pid.
//    • The panel queues every unapplied proposal; apply when online.
//    • If Mermaid or KaTeX can't be fetched, we render a clear fallback
//      <pre> block — no blank boxes, no silent failures.
//
//  Safety invariant:
//    This module NEVER calls /api/host?action=deploy or project/sync-back.
//    It prefills the existing dialogs. Those dialogs already have role
//    checks and file maps. AI drafts text only.
//
//  Exports:
//    createAIPanel({ mount, deps })         → { unmount, open, close }
//    runTask({ task, pid, payload, signal }) → Promise<{ ok, status, data }>
//    applyPatch({ artifact, pid, deps })    → Promise<{ ok, path }>
//    applyFiles({ artifact, pid, deps })    → Promise<{ ok, results }>
//    renderMarkdown(text)                    → string
//    hydrateMarkdown(root, opts)             → Promise<void>
//    renderArtifacts(root, artifacts, opts)  → void
//    openContextMenu({ x, y, context, onRun, deps }) → { close }
//    prefillCommit({ artifact })             → { message, changed }
//    prefillDeploy({ artifact })             → { summary, changed, sinceDeploymentId }
//    isTaskAvailable(task, { online, guest }) → boolean
// ═══════════════════════════════════════════════════════════════════

"use strict";

// ─────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────

const API_BASE = (typeof window !== "undefined" && window.FOLIO_API_BASE)
  || "https://foliostudios.vercel.app/api";
const API_AI = API_BASE + "/ai";

// Lazy assets. If the SW has cached them, these resolve offline too.
const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js";
const KATEX_CSS = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css";
const KATEX_JS = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js";

// Cache sizes
const RESULT_CACHE_MAX = 40;
const RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_STORAGE_PREFIX = "folio.ai.pending.";

// Guest + task gating
const GUEST_TASKS = new Set(["explain", "logExplain", "metatags", "brainstorm", "diagram"]);
const HOST_TASKS = new Set(["readProject", "commitDraft", "deployDraft"]);
const APPLY_TASKS = new Set([
  "debug", "codefix", "optimize", "suggest", "docstrings", "audit",
  "scaffold", "translate", "findFn",
]);

// Task metadata (labels, groups, offline behaviour)
const TASK_META = {
  explain:       { label: "Explain",         group: "Understand", offline: false },
  debug:         { label: "Debug",           group: "Fix",        offline: false },
  codefix:       { label: "Fix",             group: "Fix",        offline: false },
  optimize:      { label: "Optimize",        group: "Improve",    offline: false },
  suggest:       { label: "Suggest",         group: "Complete",   offline: false },
  brainstorm:    { label: "Brainstorm",      group: "Design",     offline: false },
  metatags:      { label: "Meta tags",       group: "Content",    offline: false },
  scaffold:      { label: "Scaffold",        group: "Build",      offline: false },
  docs:          { label: "Docs",            group: "Document",   offline: false },
  findFn:        { label: "Find fn",         group: "Refactor",   offline: false },
  commitMsg:     { label: "Commit msg",      group: "Meta",       offline: false },
  logExplain:    { label: "Explain log",     group: "Debug",      offline: false },
  diagram:       { label: "Diagram",         group: "Understand", offline: false },
  simulate:      { label: "Simulate",        group: "Understand", offline: false },
  designExplain: { label: "Architecture",    group: "Understand", offline: false },
  translate:     { label: "Translate",       group: "Convert",    offline: false },
  docstrings:    { label: "Docstrings",      group: "Document",   offline: false },
  struggle:      { label: "Struggle",        group: "Diagnose",   offline: false },
  audit:         { label: "Audit",           group: "Secure",     offline: false },
  readProject:   { label: "Project summary", group: "Host",       offline: false, requiresPid: true, requiresAuth: true },
  commitDraft:   { label: "Commit draft",    group: "Host",       offline: false, requiresPid: true, requiresAuth: true },
  deployDraft:   { label: "Deploy draft",    group: "Host",       offline: false, requiresPid: true, requiresAuth: true },
};

// ─────────────────────────────────────────────────────────────────────
// TINY UTILS
// ─────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function nowMs() { return Date.now(); }
function uid(prefix = "a") {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}
function estimateSize(v) {
  if (typeof v === "string") return v.length;
  try { return JSON.stringify(v).length; } catch { return 0; }
}
function isOnline() {
  try { return navigator.onLine !== false; } catch { return true; }
}

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
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" || typeof c === "number"
      ? document.createTextNode(String(c)) : c);
  }
  return node;
}

function svgIcon(name, size = 14, sw = 2.2) {
  const paths = {
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    wifiOff: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>',
    sparkles: '<path d="M12 3l1.9 5.7L19.7 10l-5.8 1.3L12 17l-1.9-5.7L4.3 10l5.8-1.3z"/>',
    chevronDown: '<polyline points="6 9 12 15 18 9"/>',
    chevronRight: '<polyline points="9 18 15 12 9 6"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    gitCommit: '<circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/>',
    rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>',
    chart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ""}</svg>`;
}

// ─────────────────────────────────────────────────────────────────────
// LAZY ASSET LOADERS — with graceful offline fallback
// ─────────────────────────────────────────────────────────────────────

let _mermaidPromise = null;
let _mermaidReady = false;

function ensureMermaid() {
  if (_mermaidReady) return Promise.resolve(window.mermaid || null);
  if (_mermaidPromise) return _mermaidPromise;
  _mermaidPromise = import(/* @vite-ignore */ MERMAID_URL)
    .then((mod) => {
      const m = mod.default || mod;
      if (typeof m.initialize === "function") {
        try {
          m.initialize({
            startOnLoad: false,
            theme: document.documentElement.hasAttribute("data-theme") ? "default" : "dark",
            themeVariables: { fontFamily: "Inter, system-ui, sans-serif" },
            securityLevel: "strict",
            flowchart: { htmlLabels: true, curve: "basis" },
          });
        } catch {}
      }
      window.mermaid = m;
      _mermaidReady = true;
      return m;
    })
    .catch((err) => {
      _mermaidPromise = null;
      console.warn("[ai] mermaid load failed:", err?.message);
      return null;
    });
  return _mermaidPromise;
}

let _katexPromise = null;
let _katexReady = false;

function ensureKaTeX() {
  if (_katexReady) return Promise.resolve(window.katex || null);
  if (_katexPromise) return _katexPromise;
  _katexPromise = (async () => {
    if (!document.querySelector(`link[href="${KATEX_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = KATEX_CSS;
      link.onerror = () => {};
      document.head.appendChild(link);
    }
    return import(/* @vite-ignore */ KATEX_JS).then((mod) => {
      const k = mod.default || mod;
      window.katex = k;
      _katexReady = true;
      return k;
    });
  })().catch((err) => {
    _katexPromise = null;
    console.warn("[ai] katex load failed:", err?.message);
    return null;
  });
  return _katexPromise;
}

// ─────────────────────────────────────────────────────────────────────
// MARKDOWN RENDERER — the one canonical renderer
// ─────────────────────────────────────────────────────────────────────

/**
 * Renders markdown to HTML with support for:
 *   • Headings, bold, italic, strike, inline code
 *   • Links, images
 *   • Fenced code blocks (```lang)
 *   • Mermaid fences (```mermaid, ```mindmap) → placeholder divs
 *   • Math fences (```math, $$…$$) → placeholder divs
 *   • Flowtable fences (```flowtable) → placeholder divs
 *   • Tables (GFM, alignment)
 *   • Task lists (- [ ] / - [x])
 *   • Blockquotes, HR
 *   • Ordered / unordered lists
 *
 * Placeholder divs get hydrated by hydrateMarkdown(root) — lazy-loading
 * Mermaid, KaTeX, or the flowtable renderer only when they're needed.
 */
export function renderMarkdown(text) {
  let src = String(text ?? "");

  // 1. Extract fenced code blocks first so inline rules can't touch them
  const fences = [];
  src = src.replace(/```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g, (m, lang, body) => {
    const idx = fences.length;
    fences.push({ lang: (lang || "").toLowerCase(), body });
    return `\u0000FENCE${idx}\u0000`;
  });

  // 2. Escape HTML
  src = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  // 3. Inline formatting (applied per-line)
  const inline = (s) => s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  // 4. Line-by-line pass
  const lines = src.split("\n");
  const out = [];
  let inUl = false;
  let inOl = false;
  let inBq = false;
  let inTable = false;
  let tableAligns = [];
  let tableHeaderHtml = "";

  const closeUl = () => { if (inUl) { out.push("</ul>"); inUl = false; } };
  const closeOl = () => { if (inOl) { out.push("</ol>"); inOl = false; } };
  const closeBq = () => { if (inBq) { out.push("</blockquote>"); inBq = false; } };
  const closeTable = () => {
    if (inTable) { out.push("</tbody></table>"); inTable = false; tableAligns = []; tableHeaderHtml = ""; }
  };
  const closeAll = () => { closeUl(); closeOl(); closeBq(); closeTable(); };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Fence placeholder
    const fenceMatch = raw.match(/^\s*\u0000FENCE(\d+)\u0000\s*$/);
    if (fenceMatch) {
      closeAll();
      const f = fences[+fenceMatch[1]];
      const lang = f.lang;
      if (lang === "mermaid" || lang === "mindmap") {
        out.push(`<div class="ai-diagram" data-diagram="mermaid" data-source="${escapeHtml(f.body)}"><pre>${escapeHtml(f.body)}</pre></div>`);
      } else if (lang === "flowtable") {
        out.push(`<div class="ai-flowtable" data-flowtable="${escapeHtml(f.body)}"><pre>${escapeHtml(f.body)}</pre></div>`);
      } else if (lang === "math") {
        out.push(`<div class="ai-math" data-math="${escapeHtml(f.body)}" data-display="1"><pre>${escapeHtml(f.body)}</pre></div>`);
      } else {
        out.push(`<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(f.body)}</code></pre>`);
      }
      continue;
    }

    // Inline math $$…$$
    const displayMath = raw.match(/^\s*\$\$([\s\S]+?)\$\$\s*$/);
    if (displayMath) {
      closeAll();
      out.push(`<div class="ai-math" data-math="${escapeHtml(displayMath[1])}" data-display="1"><pre>${escapeHtml(displayMath[1])}</pre></div>`);
      continue;
    }

    // Blank line
    if (/^\s*$/.test(raw)) { closeAll(); continue; }

    // HR
    if (/^\s*[-*_]{3,}\s*$/.test(raw)) { closeAll(); out.push("<hr>"); continue; }

    // Headings
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeAll();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }

    // Blockquote
    const bq = raw.match(/^>\s?(.*)$/);
    if (bq) {
      closeUl(); closeOl(); closeTable();
      if (!inBq) { out.push("<blockquote>"); inBq = true; }
      out.push(`<p>${inline(bq[1])}</p>`);
      continue;
    } else { closeBq(); }

    // Task list (- [ ] / - [x])
    const task = raw.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      closeOl(); closeTable();
      if (!inUl) { out.push('<ul class="task-list">'); inUl = true; }
      const checked = task[1].toLowerCase() === "x";
      out.push(`<li class="task-item${checked ? " done" : ""}"><span class="task-box" aria-hidden="true">${checked ? "✓" : ""}</span>${inline(task[2])}</li>`);
      continue;
    } else if (inUl && !/^\s*[-*]\s+/.test(raw)) {
      closeUl();
    }

    // Unordered list
    const ul = raw.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      closeOl(); closeTable();
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    // Ordered list
    const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      closeUl(); closeTable();
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    } else if (inOl && !/^\s*\d+\.\s+/.test(raw)) {
      closeOl();
    }

    // Table: header row + separator
    if (/^\s*\|.*\|\s*$/.test(raw) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeAll();
      const headers = raw.split("|").slice(1, -1).map((c) => c.trim());
      tableAligns = lines[i + 1].split("|").slice(1, -1).map((c) => {
        const t = c.trim();
        if (t.startsWith(":") && t.endsWith(":")) return "center";
        if (t.endsWith(":")) return "right";
        return "left";
      });
      tableHeaderHtml = `<thead><tr>${headers.map((h, idx) => `<th style="text-align:${tableAligns[idx] || "left"}">${inline(h)}</th>`).join("")}</tr></thead>`;
      out.push(`<table class="ai-table">${tableHeaderHtml}<tbody>`);
      inTable = true;
      i++;
      continue;
    }

    if (inTable) {
      if (/^\s*\|.*\|\s*$/.test(raw)) {
        const cells = raw.split("|").slice(1, -1).map((c) => c.trim());
        out.push(`<tr>${cells.map((c, idx) => `<td style="text-align:${tableAligns[idx] || "left"}">${inline(c)}</td>`).join("")}</tr>`);
        continue;
      } else {
        closeTable();
      }
    }

    // Paragraph
    out.push(`<p>${inline(raw)}</p>`);
  }

  closeAll();
  return out.join("\n");
}

/**
 * Replaces placeholder divs with real rendered content.
 * Lazy-loads Mermaid / KaTeX / flowtable only when a placeholder exists.
 * Offline-safe: if a loader fails, the fallback <pre> stays visible.
 */
export async function hydrateMarkdown(root, opts = {}) {
  if (!root) return;

  const diagrams = root.querySelectorAll('[data-diagram="mermaid"]:not([data-hydrated])');
  if (diagrams.length) {
    const m = await ensureMermaid();
    if (m) {
      let idx = 0;
      for (const node of diagrams) {
        const src = node.getAttribute("data-source") || "";
        node.setAttribute("data-hydrated", "1");
        if (!src.trim()) { node.classList.add("ai-diagram-error"); continue; }
        try {
          const id = `ai-mmd-${nowMs()}-${idx++}`;
          const { svg } = await m.render(id, src);
          node.innerHTML = svg;
          node.classList.add("ai-diagram-rendered");
          // Let external code hook post-render (e.g. click-to-fullscreen)
          if (typeof opts.onDiagramRendered === "function") {
            try { opts.onDiagramRendered(node, src); } catch {}
          }
        } catch (err) {
          node.classList.add("ai-diagram-error");
          node.setAttribute("title", String(err?.message || err));
        }
      }
    } else {
      // Mermaid unavailable (offline without cache). Leave the <pre> as-is.
      for (const node of diagrams) {
        node.classList.add("ai-diagram-offline");
      }
    }
  }

  const maths = root.querySelectorAll('[data-math]:not([data-hydrated])');
  if (maths.length) {
    const k = await ensureKaTeX();
    if (k) {
      for (const node of maths) {
        const src = node.getAttribute("data-math") || "";
        const display = node.getAttribute("data-display") === "1";
        node.setAttribute("data-hydrated", "1");
        try {
          k.render(src, node, { displayMode: display, throwOnError: false });
          node.classList.add("ai-math-rendered");
        } catch (err) {
          node.classList.add("ai-math-error");
        }
      }
    } else {
      for (const node of maths) node.classList.add("ai-math-offline");
    }
  }

  const flowtables = root.querySelectorAll('[data-flowtable]:not([data-hydrated])');
  if (flowtables.length) {
    for (const node of flowtables) {
      node.setAttribute("data-hydrated", "1");
      try {
        const spec = JSON.parse(node.getAttribute("data-flowtable") || "{}");
        node.innerHTML = renderFlowtable(spec);
        node.classList.add("ai-flowtable-rendered");
      } catch (err) {
        node.classList.add("ai-flowtable-error");
      }
    }
  }
}

function renderFlowtable(spec) {
  if (!spec || !Array.isArray(spec.rows)) {
    return '<div class="ai-flowtable-empty">Invalid flowtable</div>';
  }
  const cols = Array.isArray(spec.columns) && spec.columns.length
    ? spec.columns
    : ["Step", "Condition", "Action", "Next"];
  const head = `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
  const rows = spec.rows.map((r, i) => {
    const cells = Array.isArray(r) ? r : [];
    return `<tr class="ft-row ft-row-${i % 2 ? "alt" : "base"}">${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="ai-flowtable-wrap"><table class="ai-flowtable">${head}<tbody>${rows}</tbody></table></div>`;
}

// ─────────────────────────────────────────────────────────────────────
// RESULT CACHE (per-page, memory only)
// ─────────────────────────────────────────────────────────────────────

const RESULT_CACHE = new Map();

function cacheKey(pid, task, hash) {
  return `${pid || "none"}::${task}::${hash || ""}`;
}

function cacheGet(key) {
  const e = RESULT_CACHE.get(key);
  if (!e) return null;
  if (nowMs() - e.at > RESULT_CACHE_TTL_MS) { RESULT_CACHE.delete(key); return null; }
  return e.value;
}

function cacheSet(key, value) {
  if (RESULT_CACHE.size >= RESULT_CACHE_MAX) {
    const first = RESULT_CACHE.keys().next().value;
    if (first) RESULT_CACHE.delete(first);
  }
  RESULT_CACHE.set(key, { value, at: nowMs() });
}

// ─────────────────────────────────────────────────────────────────────
// PENDING STORAGE (sessionStorage, TTL'd)
// ─────────────────────────────────────────────────────────────────────

function pendingKey(pid) { return PENDING_STORAGE_PREFIX + (pid || "none"); }

function pendingLoad(pid) {
  try {
    const raw = sessionStorage.getItem(pendingKey(pid));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const cutoff = nowMs() - PENDING_TTL_MS;
    return arr.filter((p) => p && typeof p === "object" && (p.createdAt || 0) > cutoff);
  } catch { return []; }
}

function pendingSave(pid, list) {
  try { sessionStorage.setItem(pendingKey(pid), JSON.stringify(list)); } catch {}
}

function pendingAdd(pid, entry) {
  const list = pendingLoad(pid);
  list.push(entry);
  pendingSave(pid, list);
  return list;
}

function pendingRemove(pid, id) {
  const list = pendingLoad(pid).filter((p) => p.id !== id);
  pendingSave(pid, list);
  return list;
}

function pendingClear(pid) {
  try { sessionStorage.removeItem(pendingKey(pid)); } catch {}
}

// ─────────────────────────────────────────────────────────────────────
// TASK DISPATCHER
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/ai. Returns { ok, status, data, headers }.
 * data = { success, task, text, artifacts, usage, guest, cached, rateLimit }
 */
export async function runTask({ task, pid = null, payload = {}, signal = null, deps = {} } = {}) {
  if (!task) return { ok: false, status: 0, data: { success: false, error: "Missing task" }, headers: null };
  const meta = TASK_META[task];
  if (!meta) return { ok: false, status: 0, data: { success: false, error: `Unknown task: ${task}` }, headers: null };
  if (meta.requiresPid && !pid) {
    return { ok: false, status: 0, data: { success: false, error: `Task "${task}" requires a project` }, headers: null };
  }
  if (!isOnline()) {
    return { ok: false, status: 0, data: { success: false, error: "Offline — AI tasks need a connection" }, headers: null };
  }
  const fetchImpl = deps.apiFetch
    || (typeof window.apiFetch === "function" ? window.apiFetch : null)
    || defaultApiFetch;
  try {
    return await fetchImpl(API_AI, {
      method: "POST",
      body: JSON.stringify({ task, pid: pid || null, payload }),
      signal: signal || undefined,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, status: 0, data: { success: false, error: "Cancelled" }, headers: null };
    }
    return { ok: false, status: 0, data: { success: false, error: String(err?.message || "Network error") }, headers: null };
  }
}

async function defaultApiFetch(url, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  try {
    const session = localStorage.getItem("folio.session");
    if (session) headers["Authorization"] = `Bearer ${session}`;
  } catch {}
  try {
    const res = await fetch(url, { ...opts, headers });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data, headers: res.headers };
  } catch (err) {
    return { ok: false, status: 0, data: { success: false, error: String(err?.message || "Network error") }, headers: null };
  }
}

export function isTaskAvailable(task, { online = isOnline(), guest = true } = {}) {
  const meta = TASK_META[task];
  if (!meta) return false;
  if (!online) return false;
  if (guest && !GUEST_TASKS.has(task)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// APPLY PATCH
// ─────────────────────────────────────────────────────────────────────

async function readFileImpl(pid, path, idb) {
  if (idb && typeof idb.getFile === "function") {
    try {
      const f = await idb.getFile(pid, path);
      if (!f) return null;
      return typeof f === "string" ? f : (f.content || "");
    } catch {}
  }
  return null;
}

async function writeFileImpl(pid, path, content, idb) {
  if (idb && typeof idb.putFile === "function") {
    try { await idb.putFile(pid, path, content); return true; } catch {}
  }
  return false;
}

/**
 * Applies a `diff` artifact to IDB.
 * Verifies `old` is still in the file before writing — stale patches rejected.
 */
export async function applyPatch({ artifact, pid, deps = {} } = {}) {
  if (!artifact || artifact.type !== "diff") return { ok: false, error: "Not a diff artifact" };
  if (!pid) return { ok: false, error: "Missing pid" };

  const current = await readFileImpl(pid, artifact.file, deps.idb);
  if (current == null) return { ok: false, error: `File not found: ${artifact.file}` };

  if (!artifact.old) {
    if (deps.replaceAll === true) {
      const written = await writeFileImpl(pid, artifact.file, artifact.new || "", deps.idb);
      if (!written) return { ok: false, error: "Write failed" };
      return { ok: true, path: artifact.file, replaced: true };
    }
    return { ok: false, error: "Empty <old> — pass replaceAll to whole-file replace" };
  }

  if (!current.includes(artifact.old)) {
    return { ok: false, error: "Patch is stale — the file changed since the AI ran" };
  }

  const updated = current.replace(artifact.old, artifact.new || "");
  const written = await writeFileImpl(pid, artifact.file, updated, deps.idb);
  if (!written) return { ok: false, error: "Write failed" };
  return { ok: true, path: artifact.file, replaced: false };
}

export async function applyFiles({ artifact, pid, deps = {} } = {}) {
  if (!artifact || artifact.type !== "files") return { ok: false, error: "Not a files artifact" };
  if (!pid) return { ok: false, error: "Missing pid" };
  if (!Array.isArray(artifact.files)) return { ok: false, error: "Invalid files artifact" };

  const results = [];
  for (const f of artifact.files) {
    if (!f?.path || typeof f.content !== "string") {
      results.push({ path: f?.path || "(unknown)", ok: false, error: "Invalid entry" });
      continue;
    }
    const written = await writeFileImpl(pid, f.path, f.content, deps.idb);
    results.push({ path: f.path, ok: written, error: written ? null : "Write failed" });
  }
  const ok = results.some((r) => r.ok);
  return { ok, results, okCount: results.filter((r) => r.ok).length, total: results.length };
}

// ─────────────────────────────────────────────────────────────────────
// HOST PREFILL HELPERS
// ─────────────────────────────────────────────────────────────────────

export function prefillCommit({ artifact } = {}) {
  if (!artifact || artifact.type !== "commitDraft") return null;
  const parts = [artifact.message];
  if (artifact.body) parts.push("", artifact.body);
  return {
    message: parts.join("\n").trim(),
    changed: Array.isArray(artifact.changed) ? artifact.changed : [],
  };
}

export function prefillDeploy({ artifact } = {}) {
  if (!artifact || artifact.type !== "deployDraft") return null;
  return {
    summary: artifact.summary || "Deploy",
    changed: Array.isArray(artifact.changed) ? artifact.changed : [],
    sinceDeploymentId: artifact.sinceDeploymentId || null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// ARTIFACT RENDERERS
// ─────────────────────────────────────────────────────────────────────

function severityMeta(sev) {
  switch ((sev || "").toLowerCase()) {
    case "error": return { icon: "alert", cls: "error", label: "ERROR" };
    case "warning": return { icon: "alert", cls: "warning", label: "WARN" };
    default: return { icon: "info", cls: "info", label: "INFO" };
  }
}

function renderFindings(root, artifact) {
  const wrap = el("div", { class: "ai-findings" });
  const items = Array.isArray(artifact.findings) ? artifact.findings : [];
  if (!items.length) {
    wrap.appendChild(el("div", { class: "ai-empty" }, "No findings."));
    return wrap;
  }
  for (const f of items) {
    const m = severityMeta(f.severity);
    wrap.appendChild(el("div", { class: `finding finding-${m.cls}` },
      el("div", { class: "finding-head" },
        el("span", { class: "finding-sev" }, m.label),
        f.file ? el("span", { class: "finding-loc" }, f.file + (f.line ? ":" + f.line : "")) : null,
      ),
      el("div", { class: "finding-title" }, f.title || ""),
      f.detail ? el("div", { class: "finding-detail" }, f.detail) : null,
    ));
  }
  return wrap;
}

function renderDiff(root, artifact, opts) {
  const wrap = el("div", { class: "ai-diff", dataset: { file: artifact.file || "" } });
  wrap.appendChild(el("div", { class: "diff-head" },
    el("span", { class: "diff-file" }, artifact.file || "diff"),
    el("span", { class: "diff-hint" }, "old → new"),
  ));

  const oldLines = String(artifact.old || "").split("\n");
  const newLines = String(artifact.new || "").split("\n");
  const body = el("pre", { class: "diff-body" });
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      body.appendChild(el("div", { class: "diff-row diff-eq" },
        el("span", { class: "diff-sign" }, " "),
        el("span", { class: "diff-line" }, o ?? ""),
      ));
    } else {
      if (o !== undefined && o !== "") {
        body.appendChild(el("div", { class: "diff-row diff-del" },
          el("span", { class: "diff-sign" }, "−"),
          el("span", { class: "diff-line" }, o),
        ));
      }
      if (n !== undefined && n !== "") {
        body.appendChild(el("div", { class: "diff-row diff-add" },
          el("span", { class: "diff-sign" }, "+"),
          el("span", { class: "diff-line" }, n),
        ));
      }
    }
  }
  wrap.appendChild(body);

  const actions = el("div", { class: "diff-actions" });
  const acceptBtn = el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => {
    if (typeof opts.onAccept === "function") opts.onAccept(artifact);
  } }, "Accept patch");
  const rejectBtn = el("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => {
    if (typeof opts.onReject === "function") opts.onReject(artifact);
  } }, "Reject");
  actions.appendChild(acceptBtn);
  actions.appendChild(rejectBtn);
  wrap.appendChild(actions);

  return wrap;
}

function renderFiles(root, artifact, opts) {
  const wrap = el("div", { class: "ai-files" });
  const files = Array.isArray(artifact.files) ? artifact.files : [];
  if (!files.length) {
    wrap.appendChild(el("div", { class: "ai-empty" }, "No files in this artifact."));
    return wrap;
  }

  const head = el("div", { class: "files-head" },
    el("span", null, `${files.length} file${files.length === 1 ? "" : "s"}`),
  );
  wrap.appendChild(head);

  const list = el("div", { class: "files-list" });
  for (const f of files) {
    const preview = String(f.content || "").slice(0, 200);
    list.appendChild(el("div", { class: "file-row" },
      el("div", { class: "file-row-head" },
        el("code", { class: "file-path" }, f.path || ""),
        el("span", { class: "file-bytes" }, `${estimateSize(f.content || "")} chars`),
      ),
      el("pre", { class: "file-preview" }, preview + (String(f.content || "").length > 200 ? "\n…" : "")),
    ));
  }
  wrap.appendChild(list);

  const actions = el("div", { class: "diff-actions" });
  actions.appendChild(el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => {
    if (typeof opts.onAccept === "function") opts.onAccept(artifact);
  } }, `Accept all ${files.length} files`));
  actions.appendChild(el("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => {
    if (typeof opts.onReject === "function") opts.onReject(artifact);
  } }, "Reject"));
  wrap.appendChild(actions);

  return wrap;
}

function renderMentions(root, artifact) {
  const wrap = el("div", { class: "ai-mentions" });
  const items = Array.isArray(artifact.mentions) ? artifact.mentions : [];
  if (!items.length) { wrap.appendChild(el("div", { class: "ai-empty" }, "No mentions.")); return wrap; }
  for (const m of items) {
    wrap.appendChild(el("button", {
      class: "mention",
      type: "button",
      dataset: { file: m.file || "", line: String(m.line || 0) },
    },
      el("span", { class: "mention-file" }, m.file || ""),
      el("span", { class: "mention-line" }, ":" + (m.line || "?")),
      el("span", { class: "mention-kind" }, m.kind || ""),
      el("span", { class: "mention-context" }, m.context || ""),
    ));
  }
  return wrap;
}

function renderConcepts(root, artifact) {
  const wrap = el("div", { class: "ai-concepts" });
  const items = Array.isArray(artifact.concepts) ? artifact.concepts : [];
  if (!items.length) { wrap.appendChild(el("div", { class: "ai-empty" }, "No concepts.")); return wrap; }
  for (const c of items) {
    wrap.appendChild(el("div", { class: "concept" },
      el("div", { class: "concept-kind" }, c.kind || ""),
      el("div", { class: "concept-title" }, c.title || ""),
      el("div", { class: "concept-detail" }, c.detail || ""),
    ));
  }
  return wrap;
}

function renderSteps(root, artifact, opts) {
  const wrap = el("div", { class: "ai-steps" });
  const steps = Array.isArray(artifact.steps) ? artifact.steps : [];
  if (!steps.length) { wrap.appendChild(el("div", { class: "ai-empty" }, "No steps.")); return wrap; }
  for (const s of steps) {
    const row = el("div", { class: "step-row" });
    row.appendChild(el("span", { class: "step-num" }, String(s.n || "?")));
    row.appendChild(el("span", { class: "step-line" }, "L" + (s.line || "?")));
    const body = el("div", { class: "step-body" });
    if (s.note) body.appendChild(el("div", { class: "step-note" }, s.note));
    if (s.state) body.appendChild(el("pre", { class: "step-state" }, JSON.stringify(s.state, null, 2)));
    if (s.return !== undefined) body.appendChild(el("div", { class: "step-return" }, "returns " + JSON.stringify(s.return)));
    row.appendChild(body);
    wrap.appendChild(row);
  }
  return wrap;
}

function renderTree(root, artifact) {
  const wrap = el("div", { class: "ai-tree" });
  if (!artifact.root) { wrap.appendChild(el("div", { class: "ai-empty" }, "No tree data.")); return wrap; }
  const build = (node, depth) => {
    const li = el("li", { class: `tree-node-${depth}` });
    li.appendChild(el("span", { class: "tree-label" }, node.label || ""));
    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length) {
      const ul = el("ul");
      for (const c of children) ul.appendChild(build(c, depth + 1));
      li.appendChild(ul);
    }
    return li;
  };
  const ul = el("ul", { class: "tree-root" });
  ul.appendChild(build(artifact.root, 0));
  wrap.appendChild(ul);
  return wrap;
}

function renderJson(root, artifact, opts) {
  const wrap = el("div", { class: "ai-json" });
  wrap.appendChild(el("pre", { class: "json-body" }, JSON.stringify(artifact.data, null, 2)));
  if (opts?.task) {
    wrap.setAttribute("data-task", opts.task);
  }
  return wrap;
}

function renderCommitDraft(root, artifact, opts) {
  const wrap = el("div", { class: "ai-commit-draft" });
  wrap.appendChild(el("div", { class: "draft-icon" }, svgIcon("gitCommit", 18, 2.2)));
  wrap.appendChild(el("div", { class: "draft-message" }, artifact.message || ""));
  if (artifact.body) wrap.appendChild(el("pre", { class: "draft-body" }, artifact.body));
  if (Array.isArray(artifact.changed) && artifact.changed.length) {
    wrap.appendChild(el("div", { class: "draft-changed" },
      el("span", { class: "draft-changed-label" }, "Files:"),
      ...artifact.changed.map((p) => el("code", { class: "draft-changed-file" }, p)),
    ));
  }
  wrap.appendChild(el("button", {
    class: "btn btn-sm btn-primary",
    type: "button",
    onclick: () => {
      if (typeof opts.onPrefillCommit === "function") opts.onPrefillCommit(prefillCommit({ artifact }));
    },
  }, "Use this message"));
  return wrap;
}

function renderDeployDraft(root, artifact, opts) {
  const wrap = el("div", { class: "ai-deploy-draft" });
  wrap.appendChild(el("div", { class: "draft-icon" }, svgIcon("rocket", 18, 2.2)));
  wrap.appendChild(el("div", { class: "draft-summary" }, artifact.summary || "Deploy"));
  if (Array.isArray(artifact.changed) && artifact.changed.length) {
    wrap.appendChild(el("div", { class: "draft-changed" },
      el("span", { class: "draft-changed-label" }, "Changed:"),
      ...artifact.changed.map((p) => el("code", { class: "draft-changed-file" }, p)),
    ));
  }
  wrap.appendChild(el("button", {
    class: "btn btn-sm btn-primary",
    type: "button",
    onclick: () => {
      if (typeof opts.onPrefillDeploy === "function") opts.onPrefillDeploy(prefillDeploy({ artifact }));
    },
  }, "Use this summary"));
  return wrap;
}

function renderProjectSummary(root, artifact) {
  const wrap = el("div", { class: "ai-project-summary" });
  const insights = Array.isArray(artifact.insights) ? artifact.insights : [];
  if (insights.length) {
    wrap.appendChild(el("div", { class: "summary-section-title" }, "Insights"));
    const ul = el("ul", { class: "summary-insights" });
    for (const line of insights) ul.appendChild(el("li", null, line));
    wrap.appendChild(ul);
  }
  if (artifact.architectureSummary) {
    wrap.appendChild(el("div", { class: "summary-section-title" }, "Architecture"));
    wrap.appendChild(el("p", { class: "summary-arch" }, artifact.architectureSummary));
  }
  return wrap;
}

/**
 * Public renderer. Walks the artifacts array and appends each to `root`.
 * `opts` carries task name + action callbacks (onAccept, onReject, onPrefill*).
 */
export function renderArtifacts(root, artifacts, opts = {}) {
  if (!root) return;
  const list = Array.isArray(artifacts) ? artifacts : [];
  for (const a of list) {
    if (!a || !a.type) continue;
    let node = null;
    switch (a.type) {
      case "findings":      node = renderFindings(root, a); break;
      case "diff":          node = renderDiff(root, a, opts); break;
      case "files":         node = renderFiles(root, a, opts); break;
      case "mentions":      node = renderMentions(root, a); break;
      case "concepts":      node = renderConcepts(root, a); break;
      case "steps":         node = renderSteps(root, a, opts); break;
      case "tree":          node = renderTree(root, a); break;
      case "json":          node = renderJson(root, a, { ...opts, task: a.task || opts.task }); break;
      case "commitDraft":   node = renderCommitDraft(root, a, opts); break;
      case "deployDraft":   node = renderDeployDraft(root, a, opts); break;
      case "projectSummary": node = renderProjectSummary(root, a); break;
      case "mermaid":
        node = el("div", { class: "ai-diagram", dataset: { diagram: "mermaid", source: a.source || "" } },
          el("pre", null, a.source || ""),
        );
        break;
      case "mindmap":
        node = el("div", { class: "ai-diagram", dataset: { diagram: "mermaid", source: a.source || "" } },
          el("pre", null, a.source || ""),
        );
        break;
      case "flowtable":
        node = el("div", { class: "ai-flowtable", dataset: { flowtable: JSON.stringify(a) } },
          el("pre", null, JSON.stringify(a, null, 2)),
        );
        break;
      default:
        // Unknown artifact type — surface a compact fallback
        node = el("div", { class: "ai-unknown" },
          el("div", { class: "ai-empty" }, `Unknown artifact: ${a.type}`),
          el("pre", null, JSON.stringify(a, null, 2)),
        );
    }
    if (node) root.appendChild(node);
  }

  // Hydrate diagrams / math / flowtables in this root (async, non-blocking)
  Promise.resolve().then(() => hydrateMarkdown(root, opts)).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────
// INLINE CONTEXT MENU
// ─────────────────────────────────────────────────────────────────────

const CONTEXT_MENU_ITEMS = [
  { id: "explain",  label: "Explain selection" },
  { id: "codefix",  label: "Fix selection" },
  { id: "optimize", label: "Optimize selection" },
  { id: "docstrings", label: "Add docstrings" },
  { id: "audit",    label: "Audit for issues" },
  { id: "diagram",  label: "Diagram this" },
  { id: "simulate", label: "Simulate with inputs…" },
];

export function openContextMenu({ x = 0, y = 0, context = {}, onRun, deps = {} } = {}) {
  // Tear down any existing menu
  document.querySelectorAll(".ai-context-menu").forEach((m) => m.remove());

  const menu = el("div", { class: "ai-context-menu", role: "menu" });
  const guest = !isOnline() ? true : !hasSession();

  for (const item of CONTEXT_MENU_ITEMS) {
    const meta = TASK_META[item.id];
    const available = meta && isTaskAvailable(item.id, { online: isOnline(), guest });
    const row = el("button", {
      class: `ai-context-item${available ? "" : " disabled"}`,
      type: "button",
      role: "menuitem",
      title: available ? item.label : "Requires sign-in or connection",
      onclick: () => {
        if (!available) return;
        close();
        if (typeof onRun === "function") onRun(item.id, context);
      },
    },
      svgIcon(item.id === "diagram" ? "layers" : item.id === "simulate" ? "play" : "sparkles", 14, 2.2),
      el("span", null, item.label),
    );
    menu.appendChild(row);
  }

  // Position
  menu.style.position = "fixed";
  menu.style.top = Math.max(0, y) + "px";
  menu.style.left = Math.max(0, x) + "px";
  menu.style.zIndex = "9999";
  menu.style.minWidth = "200px";
  document.body.appendChild(menu);

  // Clamp into viewport
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) {
      menu.style.left = Math.max(8, window.innerWidth - r.width - 8) + "px";
    }
    if (r.bottom > window.innerHeight - 8) {
      menu.style.top = Math.max(8, window.innerHeight - r.height - 8) + "px";
    }
  });

  const onDocClick = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    try { menu.remove(); } catch {}
    document.removeEventListener("mousedown", onDocClick, true);
    document.removeEventListener("keydown", onKey);
  }

  setTimeout(() => {
    document.addEventListener("mousedown", onDocClick, true);
    document.addEventListener("keydown", onKey);
  }, 0);

  return { close };
}

function hasSession() {
  try { return !!localStorage.getItem("folio.session"); } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────
// AI PANEL
// ─────────────────────────────────────────────────────────────────────

const STATE = {
  mounted: null,
  root: null,
  activeTask: "explain",
  scope: "file",
  running: false,
  abort: null,
  lastResult: null,
  pending: [],
  pendingBadgeRefresh: null,
};

/**
 * Mounts the AI panel into `mount`. Idempotent — calling twice reuses the
 * existing DOM and just updates the context. Call `panel.unmount()` when done.
 *
 * deps = {
 *   apiFetch, idb, toast, openCommitDialog, deployNow,
 *   context: () => ({ pid, activeFile, selection, content, files }),
 *   onPrefillCommit: ({message, changed}) => void,
 *   onPrefillDeploy: ({summary, changed, sinceDeploymentId}) => void,
 *   onOpenFile: (path) => void,
 * }
 */
export function createAIPanel({ mount, deps = {} } = {}) {
  if (!mount) throw new Error("createAIPanel: mount is required");

  // Reuse the existing panel if the same mount is used
  if (STATE.mounted && STATE.mounted === mount && STATE.root && mount.contains(STATE.root)) {
    STATE.deps = deps;
    refreshContext(deps);
    renderPendingBadge();
    return {
      unmount: () => doUnmount(),
      open: () => ensureVisible(true),
      close: () => ensureVisible(false),
    };
  }

  if (STATE.mounted && STATE.mounted !== mount) {
    doUnmount();
  }

  STATE.mounted = mount;
  STATE.deps = deps;
  STATE.activeTask = "explain";
  STATE.scope = "file";
  STATE.running = false;
  STATE.abort = null;
  STATE.lastResult = null;

  const root = el("div", { class: "ai-panel" });
  mount.appendChild(root);
  STATE.root = root;

  root.innerHTML = `
    <div class="ai-panel-head">
      <div class="ai-panel-title">
        <span class="ai-panel-icon">${svgIcon("sparkles", 14, 2.2)}</span>
        <span>Lens</span>
        <span class="ai-pending-badge" hidden>0</span>
      </div>
      <div class="ai-panel-actions">
        <button type="button" class="ai-panel-btn" data-ai-action="pending" title="Pending proposals">
          ${svgIcon("clock", 13, 2.2)}
        </button>
        <button type="button" class="ai-panel-btn" data-ai-action="clear" title="Clear result">
          ${svgIcon("trash", 13, 2.2)}
        </button>
      </div>
    </div>
    <div class="ai-panel-body">
      <div class="ai-task-row">
        <label class="ai-label">Task</label>
        <select class="ai-task-select" data-ai-select="task"></select>
      </div>
      <div class="ai-scope-row">
        <label class="ai-label">Scope</label>
        <div class="ai-radio-group">
          <label class="ai-radio"><input type="radio" name="ai-scope" value="file" checked><span>File</span></label>
          <label class="ai-radio"><input type="radio" name="ai-scope" value="selection"><span>Selection</span></label>
        </div>
      </div>
      <div class="ai-hint" data-ai-hint hidden></div>
      <div class="ai-run-row">
        <button type="button" class="ai-run-btn" data-ai-action="run">
          ${svgIcon("play", 13, 2.4)}
          <span>Run</span>
        </button>
      </div>
      <div class="ai-result" data-ai-result hidden></div>
      <div class="ai-pending" data-ai-pending hidden></div>
    </div>
  `;

  populateTaskSelect(root);
  wirePanel(root, deps);
  refreshContext(deps);
  renderPendingBadge();

  function ensureVisible(visible) {
    if (!root.isConnected) return;
    root.style.display = visible ? "" : "none";
  }

  function doUnmount() {
    try { STATE.abort?.abort?.(); } catch {}
    try { root.remove(); } catch {}
    if (STATE.mounted === mount) {
      STATE.mounted = null;
      STATE.root = null;
    }
  }

  return {
    unmount: doUnmount,
    open: () => ensureVisible(true),
    close: () => ensureVisible(false),
  };
}

function populateTaskSelect(root) {
  const sel = root.querySelector('[data-ai-select="task"]');
  if (!sel) return;
  const groups = {};
  for (const [id, meta] of Object.entries(TASK_META)) {
    if (!groups[meta.group]) groups[meta.group] = [];
    groups[meta.group].push({ id, meta });
  }
  sel.innerHTML = "";
  const online = isOnline();
  const guest = !hasSession();
  for (const [groupName, items] of Object.entries(groups)) {
    const og = document.createElement("optgroup");
    og.label = groupName;
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.id;
      const available = isTaskAvailable(item.id, { online, guest });
      opt.textContent = item.meta.label + (available ? "" : " (unavailable)");
      if (!available) opt.disabled = true;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.value = STATE.activeTask;
  // If the current selection is now unavailable, pick the first available
  const selected = sel.querySelector(`option[value="${STATE.activeTask}"]`);
  if (selected?.disabled) {
    const firstAvailable = Array.from(sel.options).find((o) => !o.disabled);
    if (firstAvailable) { sel.value = firstAvailable.value; STATE.activeTask = firstAvailable.value; }
  }
}

function wirePanel(root, deps) {
  const sel = root.querySelector('[data-ai-select="task"]');
  if (sel) {
    sel.addEventListener("change", () => {
      STATE.activeTask = sel.value;
      updateScopeVisibility();
      updateHint();
    });
  }

  root.querySelectorAll('input[name="ai-scope"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) STATE.scope = r.value;
      updateHint();
    });
  });

  root.querySelector('[data-ai-action="run"]')?.addEventListener("click", () => runCurrent(deps));
  root.querySelector('[data-ai-action="clear"]')?.addEventListener("click", () => clearResult());
  root.querySelector('[data-ai-action="pending"]')?.addEventListener("click", () => togglePendingView());

  updateScopeVisibility();
  updateHint();
}

function updateScopeVisibility() {
  if (!STATE.root) return;
  const scopeRow = STATE.root.querySelector(".ai-scope-row");
  const meta = TASK_META[STATE.activeTask];
  const pidOnly = meta?.requiresPid;
  if (scopeRow) scopeRow.style.display = pidOnly ? "none" : "";
}

function updateHint() {
  if (!STATE.root) return;
  const hint = STATE.root.querySelector("[data-ai-hint]");
  if (!hint) return;
  const online = isOnline();
  const guest = !hasSession();
  const task = STATE.activeTask;

  hint.hidden = true;
  hint.className = "ai-hint";

  if (!online) {
    hint.hidden = false;
    hint.classList.add("ai-hint-offline");
    hint.innerHTML = `${svgIcon("wifiOff", 12, 2.2)} <span>Offline — AI tasks need a connection. Staged proposals remain available below.</span>`;
    return;
  }

  if (guest && !GUEST_TASKS.has(task)) {
    hint.hidden = false;
    hint.classList.add("ai-hint-guest");
    hint.innerHTML = `${svgIcon("lock", 12, 2.2)} <span>Guest — sign in to unlock this task.</span>`;
    return;
  }

  if (STATE.scope === "selection" && !getCurrentSelection(deps)) {
    hint.hidden = false;
    hint.classList.add("ai-hint-info");
    hint.innerHTML = `<span>Select text in the editor first to scope to selection.</span>`;
    return;
  }
}

function getCurrentSelection(deps) {
  try {
    const ctx = deps?.context?.() || {};
    return ctx.selection || "";
  } catch { return ""; }
}

function refreshContext(deps) {
  STATE.deps = deps;
  updateHint();
}

async function runCurrent(deps) {
  if (STATE.running) return;

  const online = isOnline();
  const guest = !hasSession();
  const task = STATE.activeTask;

  if (!online) {
    showResultError("Offline — AI tasks need a connection.");
    return;
  }
  if (guest && !GUEST_TASKS.has(task)) {
    showResultError("Sign in to unlock this task.");
    return;
  }

  let ctx;
  try { ctx = deps?.context?.() || {}; }
  catch (err) { showResultError("Could not read editor context."); return; }

  const pid = ctx.pid || null;
  const meta = TASK_META[task];

  if (meta.requiresPid && !pid) {
    showResultError("Open a project first.");
    return;
  }

  // Build the payload from context
  const payload = {};
  if (task === "explain" || task === "debug" || task === "codefix" ||
      task === "optimize" || task === "suggest" || task === "docstrings" ||
      task === "audit" || task === "diagram" || task === "simulate") {
    if (!ctx.activeFile) { showResultError("No file open."); return; }
    payload.file = ctx.activeFile;
    if (STATE.scope === "selection" && ctx.selection) {
      payload.selection = ctx.selection;
      payload.content = ctx.content || "";
    } else {
      payload.content = ctx.content || "";
    }
  } else if (task === "brainstorm") {
    payload.name = ctx.projectName || "";
    payload.description = ctx.projectDescription || "";
    payload.fileList = Array.isArray(ctx.files) ? ctx.files.map((f) => f.path) : [];
  } else if (task === "metatags") {
    payload.name = ctx.projectName || "";
    payload.description = ctx.projectDescription || "";
    payload.indexExcerpt = extractHtmlExcerpt(ctx);
  } else if (task === "scaffold") {
    payload.name = ctx.projectName || "Untitled";
    payload.description = ctx.projectDescription || "";
    payload.concept = "";
    payload.stack = "html+css+js";
  } else if (task === "docs") {
    payload.name = ctx.projectName || "Untitled";
    payload.description = ctx.projectDescription || "";
    payload.files = filesToMap(ctx.files);
  } else if (task === "findFn") {
    const fnName = await promptFnName();
    if (!fnName) return;
    payload.fnName = fnName;
    payload.files = filesToMap(ctx.files);
  } else if (task === "commitMsg") {
    payload.diff = ctx.diff || "";
  } else if (task === "logExplain") {
    payload.log = ctx.log || "";
  } else if (task === "designExplain") {
    payload.files = filesToMap(ctx.files);
    payload.focus = ctx.focus || "";
  } else if (task === "translate") {
    if (!ctx.selection && !ctx.content) { showResultError("No code to translate."); return; }
    payload.code = ctx.selection || ctx.content || "";
    payload.from = ctx.activeFile ? (ctx.activeFile.split(".").pop() || "unknown") : "unknown";
    payload.to = await promptTargetLanguage();
    if (!payload.to) return;
  } else if (task === "struggle") {
    payload.files = filesToMap(ctx.files);
  } else if (task === "readProject" || task === "commitDraft" || task === "deployDraft") {
    // pid-only
  }

  STATE.running = true;
  const abort = new AbortController();
  STATE.abort = abort;
  setRunningUI(true);
  showResultLoading(task);

  try {
    const res = await runTask({
      task, pid, payload,
      signal: abort.signal,
      deps,
    });
    if (!res.ok || !res.data?.success) {
      const errMsg = res.data?.error || `AI error (${res.status || "network"})`;
      showResultError(errMsg);
      return;
    }
    STATE.lastResult = res.data;
    showResult(task, res.data);
    // Staging: if this task produces applyable artifacts, add them to pending
    if (APPLY_TASKS.has(task)) {
      stageArtifacts(pid, task, res.data.artifacts || []);
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      showResultError("Cancelled.");
    } else {
      showResultError(err?.message || "AI call failed.");
    }
  } finally {
    STATE.running = false;
    STATE.abort = null;
    setRunningUI(false);
  }
}

function filesToMap(files) {
  if (!Array.isArray(files)) return {};
  const out = {};
  for (const f of files) {
    if (f && f.path && typeof f.content === "string") out[f.path] = f.content;
  }
  return out;
}

function extractHtmlExcerpt(ctx) {
  const files = Array.isArray(ctx.files) ? ctx.files : [];
  const index = files.find((f) => /(^|\/)index\.html?$/i.test(f.path || ""));
  if (index) return String(index.content || "").slice(0, 4000);
  const first = files.find((f) => /\.html?$/i.test(f.path || ""));
  return first ? String(first.content || "").slice(0, 4000) : "";
}

function promptFnName() {
  return new Promise((resolve) => {
    const name = window.prompt("Function name to find?");
    resolve(name ? name.trim() : null);
  });
}

function promptTargetLanguage() {
  return new Promise((resolve) => {
    const target = window.prompt("Target language? (e.g. python, rust, go)", "python");
    resolve(target ? target.trim().toLowerCase() : null);
  });
}

// ─────────────────────────────────────────────────────────────────────
// RESULT UI
// ─────────────────────────────────────────────────────────────────────

function setRunningUI(running) {
  if (!STATE.root) return;
  const btn = STATE.root.querySelector('[data-ai-action="run"]');
  if (!btn) return;
  btn.disabled = running;
  btn.classList.toggle("running", running);
  btn.querySelector("span").textContent = running ? "Running…" : "Run";
}

function showResultLoading(task) {
  if (!STATE.root) return;
  const box = STATE.root.querySelector("[data-ai-result]");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<div class="ai-loading">
    <div class="ai-spinner"></div>
    <div class="ai-loading-text">Running ${escapeHtml(TASK_META[task]?.label || task)}…</div>
  </div>`;
}

function showResultError(message) {
  if (!STATE.root) return;
  const box = STATE.root.querySelector("[data-ai-result]");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<div class="ai-error">
    ${svgIcon("alert", 14, 2.4)}
    <div>${escapeHtml(message)}</div>
  </div>`;
}

function showResult(task, data) {
  if (!STATE.root) return;
  const box = STATE.root.querySelector("[data-ai-result]");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = "";

  // Markdown text
  if (data.text) {
    const md = el("div", { class: "ai-markdown" });
    md.innerHTML = renderMarkdown(data.text);
    box.appendChild(md);
    hydrateMarkdown(md);
  }

  // Artifacts
  if (Array.isArray(data.artifacts) && data.artifacts.length) {
    const artifactsBox = el("div", { class: "ai-artifacts" });
    renderArtifacts(artifactsBox, data.artifacts, {
      onAccept: (artifact) => handleArtifactAccept(task, artifact, data),
      onReject: (artifact) => handleArtifactReject(task, artifact),
      onPrefillCommit: (prefill) => {
        if (typeof STATE.deps?.onPrefillCommit === "function") STATE.deps.onPrefillCommit(prefill);
        else if (typeof STATE.deps?.openCommitDialog === "function") STATE.deps.openCommitDialog(prefill);
      },
      onPrefillDeploy: (prefill) => {
        if (typeof STATE.deps?.onPrefillDeploy === "function") STATE.deps.onPrefillDeploy(prefill);
        else if (typeof STATE.deps?.deployNow === "function") STATE.deps.deployNow(prefill);
      },
    });
    box.appendChild(artifactsBox);
  }

  // Usage footer
  if (data.usage) {
    const footer = el("div", { class: "ai-usage" },
      el("span", null, `Model: ${data.usage.model || "groq"}`),
      el("span", null, `${data.usage.promptTokens || 0} in / ${data.usage.completionTokens || 0} out`),
    );
    if (data.rateLimit) {
      footer.appendChild(el("span", null, `Rate: ${data.rateLimit.remaining ?? "?"}/${data.rateLimit.limit ?? "?"}`));
    }
    box.appendChild(footer);
  }
}

function clearResult() {
  if (!STATE.root) return;
  const box = STATE.root.querySelector("[data-ai-result]");
  if (!box) return;
  box.hidden = true;
  box.innerHTML = "";
  STATE.lastResult = null;
}

// ─────────────────────────────────────────────────────────────────────
// PENDING STAGING
// ─────────────────────────────────────────────────────────────────────

function stageArtifacts(pid, task, artifacts) {
  if (!pid) return;
  const entries = [];
  for (const a of artifacts) {
    if (!a || !a.type) continue;
    if (["diff", "files"].includes(a.type)) {
      entries.push({
        id: uid("p"),
        kind: a.type,
        task,
        artifact: a,
        createdAt: nowMs(),
      });
    }
  }
  if (!entries.length) return;
  let list = pendingLoad(pid);
  list = list.concat(entries);
  pendingSave(pid, list);
  STATE.pending = list;
  renderPendingBadge();
}

async function handleArtifactAccept(task, artifact, data) {
  const deps = STATE.deps;
  const ctx = (() => { try { return deps?.context?.() || {}; } catch { return {}; } })();
  const pid = ctx.pid;
  if (!pid) { toastInDeps("Open a project first", "warning"); return; }
  if (!deps?.idb) { toastInDeps("Local storage unavailable — cannot apply", "error"); return; }

  if (artifact.type === "diff") {
    const result = await applyPatch({ artifact, pid, deps });
    if (!result.ok) {
      toastInDeps(result.error || "Patch failed", "error");
      return;
    }
    toastInDeps(`Applied ${artifact.file}`, "success");
    if (typeof deps?.onOpenFile === "function") deps.onOpenFile(artifact.file);
    // Mark applied in pending
    prunePendingByArtifact(pid, artifact);
  } else if (artifact.type === "files") {
    const result = await applyFiles({ artifact, pid, deps });
    if (!result.ok) { toastInDeps("Some files failed to write", "error"); return; }
    toastInDeps(`Wrote ${result.okCount}/${result.total} files`, "success");
    prunePendingByArtifact(pid, artifact);
  }
}

function handleArtifactReject(task, artifact) {
  const deps = STATE.deps;
  const ctx = (() => { try { return deps?.context?.() || {}; } catch { return {}; } })();
  const pid = ctx.pid;
  if (pid) prunePendingByArtifact(pid, artifact);
  toastInDeps("Rejected", "info");
}

function prunePendingByArtifact(pid, artifact) {
  if (!pid) return;
  const list = pendingLoad(pid).filter((p) => {
    if (!p || p.kind !== artifact.type) return true;
    if (p.artifact?.file !== artifact.file) return true;
    if (p.artifact?.old !== artifact.old) return true;
    return false;
  });
  pendingSave(pid, list);
  STATE.pending = list;
  renderPendingBadge();
}

function renderPendingBadge() {
  if (!STATE.root) return;
  const badge = STATE.root.querySelector(".ai-pending-badge");
  if (!badge) return;
  const deps = STATE.deps;
  const ctx = (() => { try { return deps?.context?.() || {}; } catch { return {}; } })();
  const pid = ctx.pid;
  const count = pid ? pendingLoad(pid).length : 0;
  STATE.pending = pid ? pendingLoad(pid) : [];
  if (count > 0) {
    badge.hidden = false;
    badge.textContent = String(count);
  } else {
    badge.hidden = true;
  }
}

function togglePendingView() {
  if (!STATE.root) return;
  const box = STATE.root.querySelector("[data-ai-pending]");
  if (!box) return;
  if (box.hidden) {
    renderPendingView(box);
    box.hidden = false;
  } else {
    box.hidden = true;
    box.innerHTML = "";
  }
}

function renderPendingView(box) {
  box.innerHTML = "";
  const deps = STATE.deps;
  const ctx = (() => { try { return deps?.context?.() || {}; } catch { return {}; } })();
  const pid = ctx.pid;
  if (!pid) {
    box.appendChild(el("div", { class: "ai-empty" }, "Open a project to see staged proposals."));
    return;
  }
  const list = pendingLoad(pid);
  if (!list.length) {
    box.appendChild(el("div", { class: "ai-empty" }, "No staged proposals."));
    return;
  }
  const header = el("div", { class: "pending-head" },
    el("span", null, `${list.length} staged`),
    el("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => {
      pendingClear(pid);
      STATE.pending = [];
      renderPendingBadge();
      renderPendingView(box);
    } }, "Clear all"),
  );
  box.appendChild(header);

  for (const entry of list) {
    const row = el("div", { class: "pending-row" },
      el("div", { class: "pending-meta" },
        el("span", { class: "pending-task" }, TASK_META[entry.task]?.label || entry.task),
        el("span", { class: "pending-kind" }, entry.kind),
        el("span", { class: "pending-file" }, entry.artifact?.file || `${(entry.artifact?.files || []).length} files`),
      ),
      el("div", { class: "pending-actions" },
        el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: async () => {
          await handleArtifactAccept(entry.task, entry.artifact, STATE.lastResult);
          renderPendingView(box);
        } }, "Accept"),
        el("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => {
          pendingRemove(pid, entry.id);
          STATE.pending = pendingLoad(pid);
          renderPendingBadge();
          renderPendingView(box);
        } }, "Discard"),
      ),
    );
    box.appendChild(row);
  }
}

// ─────────────────────────────────────────────────────────────────────
// TOAST ADAPTER
// ─────────────────────────────────────────────────────────────────────

function toastInDeps(msg, type = "info") {
  try {
    if (typeof STATE.deps?.toast === "function") { STATE.deps.toast(msg, type); return; }
    if (typeof window.toast === "function") { window.toast(msg, type); return; }
    console.log(`[ai:${type}]`, msg);
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────
// OFFLINE / ONLINE EVENTS
// ─────────────────────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    if (STATE.root) {
      populateTaskSelect(STATE.root);
      updateHint();
    }
  });
  window.addEventListener("offline", () => {
    if (STATE.root) updateHint();
  });
}

// ─────────────────────────────────────────────────────────────────────
// STYLES — injected once, scoped under .ai-* / .ai-panel-*
// ─────────────────────────────────────────────────────────────────────

const STYLE_ID = "folio-ai-styles";

function injectStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;

  const css = `
/* ── Panel ───────────────────────────────────────────── */
.ai-panel {
  display: flex; flex-direction: column;
  font-family: var(--font, 'Inter', system-ui, sans-serif);
  color: var(--theme-text, #e8ecf1);
  min-height: 0; min-width: 0;
  height: 100%;
}
.ai-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--theme-divider, rgba(255,255,255,0.08));
  flex-shrink: 0;
}
.ai-panel-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 800;
  letter-spacing: 0.3px; text-transform: uppercase;
  color: var(--theme-text, #e8ecf1);
}
.ai-panel-icon { color: var(--theme-primary, #F59E0B); display: inline-flex; }
.ai-pending-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 16px; padding: 0 5px;
  border-radius: 8px;
  background: var(--theme-primary, #F59E0B);
  color: #0a0c10;
  font-size: 9.5px; font-weight: 800;
  letter-spacing: 0;
}
.ai-panel-actions { display: flex; gap: 2px; }
.ai-panel-btn {
  width: 26px; height: 26px; border-radius: 6px;
  background: transparent;
  color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
  display: flex; align-items: center; justify-content: center;
  border: none; cursor: pointer;
  transition: all 0.15s ease;
}
.ai-panel-btn:hover { color: var(--theme-text, #e8ecf1); background: var(--theme-glass-bg, rgba(255,255,255,0.05)); }
.ai-panel-body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 10px;
}
.ai-label {
  font-size: 10px; font-weight: 700;
  color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
  text-transform: uppercase; letter-spacing: 0.4px;
  margin-bottom: 3px;
  display: block;
}
.ai-task-row { display: flex; flex-direction: column; }
.ai-task-select {
  width: 100%; padding: 6px 8px;
  background: var(--input-bg, rgba(26,31,42,0.88));
  border: 1px solid var(--theme-card-border, rgba(255,255,255,0.08));
  border-radius: 6px;
  color: var(--theme-text, #e8ecf1);
  font-size: 12px; font-family: inherit;
  outline: none;
}
.ai-task-select:focus { border-color: var(--theme-primary, #F59E0B); }

.ai-scope-row { display: flex; flex-direction: column; }
.ai-radio-group { display: flex; gap: 4px; }
.ai-radio {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 8px; border-radius: 5px;
  background: var(--theme-glass-bg, rgba(255,255,255,0.05));
  border: 1px solid var(--theme-card-border, rgba(255,255,255,0.08));
  font-size: 11px; font-weight: 600;
  color: var(--theme-text-secondary, rgba(232,236,241,0.72));
  cursor: pointer;
}
.ai-radio input { accent-color: var(--theme-primary, #F59E0B); margin: 0; }
.ai-radio:has(input:checked) {
  background: var(--theme-primary-soft, rgba(245,158,11,0.14));
  color: var(--theme-primary, #F59E0B);
  border-color: var(--theme-primary, #F59E0B);
}

.ai-hint {
  display: flex; align-items: flex-start; gap: 6px;
  padding: 7px 9px; border-radius: 6px;
  font-size: 11px; line-height: 1.4;
  border: 1px solid transparent;
}
.ai-hint svg { flex-shrink: 0; margin-top: 1px; }
.ai-hint-offline { background: var(--theme-warning-soft, rgba(217,119,6,0.14)); color: var(--theme-warning, #D97706); border-color: rgba(217,119,6,0.3); }
.ai-hint-guest { background: var(--theme-primary-soft, rgba(245,158,11,0.14)); color: var(--theme-primary, #F59E0B); border-color: rgba(245,158,11,0.3); }
.ai-hint-info { background: var(--theme-glass-bg, rgba(255,255,255,0.05)); color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); }

.ai-run-row { display: flex; }
.ai-run-btn {
  flex: 1; padding: 8px 12px;
  border-radius: 7px;
  background: var(--theme-primary, #F59E0B);
  color: #0a0c10;
  font-size: 12px; font-weight: 800;
  letter-spacing: 0.2px;
  border: none; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  transition: all 0.15s ease;
}
.ai-run-btn:hover:not(:disabled) { background: var(--theme-primary-hover, #fbbf24); }
.ai-run-btn:disabled { opacity: 0.6; cursor: progress; }
.ai-run-btn.running svg { animation: ai-spin 0.9s linear infinite; }
@keyframes ai-spin { to { transform: rotate(360deg); } }

.ai-result { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.ai-loading {
  display: flex; align-items: center; gap: 8px;
  padding: 12px; border-radius: 7px;
  background: var(--theme-glass-bg, rgba(255,255,255,0.05));
  font-size: 11.5px;
  color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
}
.ai-spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(245,158,11,0.3);
  border-top-color: var(--theme-primary, #F59E0B);
  animation: ai-spin 0.8s linear infinite;
  flex-shrink: 0;
}
.ai-error {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px; border-radius: 7px;
  background: var(--theme-danger-soft, rgba(239,68,68,0.12));
  color: var(--theme-danger, #EF4444);
  font-size: 12px; line-height: 1.4;
}
.ai-error svg { flex-shrink: 0; margin-top: 1px; }

/* ── Markdown output ─────────────────────────────────── */
.ai-markdown {
  font-size: 12.5px; line-height: 1.6;
  color: var(--theme-text-secondary, rgba(232,236,241,0.72));
  word-wrap: break-word; overflow-wrap: anywhere;
}
.ai-markdown h1, .ai-markdown h2, .ai-markdown h3,
.ai-markdown h4, .ai-markdown h5, .ai-markdown h6 {
  color: var(--theme-text, #e8ecf1);
  font-weight: 800; letter-spacing: -0.2px;
  margin: 10px 0 4px;
}
.ai-markdown h1 { font-size: 16px; }
.ai-markdown h2 { font-size: 14px; }
.ai-markdown h3 { font-size: 13px; }
.ai-markdown p { margin: 4px 0; }
.ai-markdown ul, .ai-markdown ol { margin: 4px 0; padding-left: 18px; }
.ai-markdown li { margin: 2px 0; }
.ai-markdown code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  padding: 1px 4px; border-radius: 3px;
  background: var(--theme-glass-bg, rgba(255,255,255,0.05));
}
.ai-markdown pre {
  padding: 10px; border-radius: 6px;
  background: var(--theme-glass-bg, rgba(255,255,255,0.05));
  overflow-x: auto;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px; line-height: 1.5;
}
.ai-markdown pre code { padding: 0; background: none; }
.ai-markdown a { color: var(--theme-primary, #F59E0B); text-decoration: underline; }
.ai-markdown strong { color: var(--theme-text, #e8ecf1); font-weight: 700; }
.ai-markdown hr { border: 0; border-top: 1px solid var(--theme-divider, rgba(255,255,255,0.08)); margin: 10px 0; }
.ai-markdown blockquote {
  border-left: 3px solid var(--theme-primary, #F59E0B);
  padding-left: 10px; margin: 6px 0;
  color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
}
.ai-markdown table.ai-table {
  width: 100%; border-collapse: collapse;
  margin: 6px 0; font-size: 11.5px;
}
.ai-markdown table.ai-table th,
.ai-markdown table.ai-table td {
  border: 1px solid var(--theme-card-border, rgba(255,255,255,0.08));
  padding: 4px 8px;
}
.ai-markdown table.ai-table th { background: var(--theme-glass-bg, rgba(255,255,255,0.05)); font-weight: 700; }
.ai-markdown .task-list { list-style: none; padding-left: 0; }
.ai-markdown .task-item { display: flex; gap: 6px; align-items: flex-start; }
.ai-markdown .task-item .task-box {
  flex-shrink: 0; width: 13px; height: 13px; margin-top: 3px;
  border-radius: 3px; border: 1.5px solid var(--theme-card-border, rgba(255,255,255,0.08));
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 800;
}
.ai-markdown .task-item.done .task-box {
  background: var(--theme-primary, #F59E0B); color: #0a0c10;
  border-color: var(--theme-primary, #F59E0B);
}

/* ── Diagrams / Math / Flowtable ─────────────────────── */
.ai-diagram, .ai-math, .ai-flowtable {
  margin: 8px 0; padding: 8px;
  border-radius: 6px;
  background: var(--theme-glass-bg, rgba(255,255,255,0.05));
  overflow: auto;
}
.ai-diagram pre, .ai-math pre, .ai-flowtable pre {
  margin: 0; padding: 0; background: none;
  font-size: 10.5px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
}
.ai-diagram-rendered svg { max-width: 100%; height: auto; display: block; }
.ai-diagram-error::after {
  content: "Diagram could not be rendered";
  display: block; font-size: 10.5px; color: var(--theme-danger, #EF4444); margin-top: 4px;
}
.ai-diagram-offline::after {
  content: "Diagram requires connection (first load)";
  display: block; font-size: 10.5px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); margin-top: 4px;
}
.ai-math-rendered .katex { font-size: 13px; }
.ai-flowtable-wrap { overflow-x: auto; }
.ai-flowtable {
  width: 100%; border-collapse: collapse;
  font-size: 11px; background: transparent;
}
.ai-flowtable th, .ai-flowtable td {
  padding: 5px 8px;
  border: 1px solid var(--theme-card-border, rgba(255,255,255,0.08));
  text-align: left;
}
.ai-flowtable th { background: var(--theme-glass-bg, rgba(255,255,255,0.05)); font-weight: 700; }
.ai-flowtable .ft-row-alt td { background: rgba(255,255,255,0.02); }

/* ── Artifact cards ──────────────────────────────────── */
.ai-artifacts { display: flex; flex-direction: column; gap: 8px; }
.ai-findings, .ai-files, .ai-mentions, .ai-concepts, .ai-steps, .ai-tree, .ai-json, .ai-diff,
.ai-commit-draft, .ai-deploy-draft, .ai-project-summary, .ai-unknown {
  padding: 8px; border-radius: 7px;
  background: var(--theme-glass-bg, rgba(255,255,255,0.05));
  border: 1px solid var(--theme-card-border, rgba(255,255,255,0.08));
  font-size: 11.5px;
}
.ai-empty { font-size: 11px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); font-style: italic; }

.finding { padding: 6px 0; border-bottom: 1px solid var(--theme-divider, rgba(255,255,255,0.08)); }
.finding:last-child { border-bottom: none; }
.finding-head { display: flex; gap: 6px; align-items: center; font-size: 10px; font-weight: 800; }
.finding-sev { padding: 1px 5px; border-radius: 3px; letter-spacing: 0.4px; }
.finding-error .finding-sev { background: var(--theme-danger-soft, rgba(239,68,68,0.12)); color: var(--theme-danger, #EF4444); }
.finding-warning .finding-sev { background: var(--theme-warning-soft, rgba(217,119,6,0.14)); color: var(--theme-warning, #D97706); }
.finding-info .finding-sev { background: var(--theme-primary-soft, rgba(245,158,11,0.14)); color: var(--theme-primary, #F59E0B); }
.finding-loc { font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); }
.finding-title { font-size: 12px; font-weight: 700; margin-top: 3px; color: var(--theme-text, #e8ecf1); }
.finding-detail { font-size: 11px; line-height: 1.5; color: var(--theme-text-secondary, rgba(232,236,241,0.72)); margin-top: 2px; }

.diff-head { display: flex; justify-content: space-between; align-items: center; padding-bottom: 4px; border-bottom: 1px solid var(--theme-divider, rgba(255,255,255,0.08)); margin-bottom: 4px; }
.diff-file { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; font-weight: 700; }
.diff-hint { font-size: 9.5px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); }
.diff-body { padding: 4px 0; margin: 0; background: transparent; font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px; line-height: 1.4; overflow-x: auto; }
.diff-row { display: flex; gap: 4px; padding: 0 2px; }
.diff-sign { flex-shrink: 0; width: 12px; font-weight: 800; }
.diff-eq .diff-sign { color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); }
.diff-del { background: rgba(239,68,68,0.1); color: #ef9a9a; }
.diff-del .diff-sign { color: var(--theme-danger, #EF4444); }
.diff-add { background: rgba(16,185,129,0.1); color: #a7f3d0; }
.diff-add .diff-sign { color: var(--theme-success, #10B981); }
.diff-actions { display: flex; gap: 6px; margin-top: 6px; }

.files-head { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); margin-bottom: 4px; }
.files-list { display: flex; flex-direction: column; gap: 6px; }
.file-row { padding: 6px 0; border-bottom: 1px solid var(--theme-divider, rgba(255,255,255,0.08)); }
.file-row:last-child { border-bottom: none; }
.file-row-head { display: flex; justify-content: space-between; gap: 6px; margin-bottom: 2px; }
.file-path { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; font-weight: 700; color: var(--theme-primary, #F59E0B); }
.file-bytes { font-size: 10px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); }
.file-preview { padding: 5px 6px; margin: 0; background: rgba(0,0,0,0.2); border-radius: 4px; font-size: 10.5px; font-family: var(--font-mono, ui-monospace, monospace); line-height: 1.4; max-height: 120px; overflow-y: auto; white-space: pre-wrap; }

.mention {
  display: block; width: 100%; text-align: left;
  padding: 6px 8px; border-radius: 5px;
  background: transparent; border: 1px solid var(--theme-card-border, rgba(255,255,255,0.08));
  color: inherit; font-family: inherit; font-size: 11px;
  margin-bottom: 4px; cursor: pointer;
  transition: background 0.15s ease;
}
.mention:hover { background: var(--theme-glass-bg, rgba(255,255,255,0.05)); }
.mention-file { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 700; color: var(--theme-primary, #F59E0B); }
.mention-line { color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); font-family: var(--font-mono, ui-monospace, monospace); }
.mention-kind { margin-left: 4px; font-size: 9px; padding: 1px 5px; border-radius: 3px; background: var(--theme-glass-bg, rgba(255,255,255,0.05)); color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); }
.mention-context { display: block; margin-top: 2px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.concept { padding: 6px 0; border-bottom: 1px solid var(--theme-divider, rgba(255,255,255,0.08)); }
.concept:last-child { border-bottom: none; }
.concept-kind { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--theme-primary, #F59E0B); font-weight: 800; }
.concept-title { font-size: 12.5px; font-weight: 700; margin: 2px 0; }
.concept-detail { font-size: 11px; line-height: 1.5; color: var(--theme-text-secondary, rgba(232,236,241,0.72)); }

.step-row { display: grid; grid-template-columns: 20px 40px 1fr; gap: 6px; padding: 5px 0; border-bottom: 1px solid var(--theme-divider, rgba(255,255,255,0.08)); }
.step-row:last-child { border-bottom: none; }
.step-num { width: 20px; height: 20px; border-radius: 50%; background: var(--theme-primary-soft, rgba(245,158,11,0.14)); color: var(--theme-primary, #F59E0B); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800; }
.step-line { font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); padding-top: 4px; }
.step-body { min-width: 0; }
.step-note { font-size: 11px; color: var(--theme-text, #e8ecf1); }
.step-state { margin: 2px 0 0; padding: 4px 6px; border-radius: 4px; background: rgba(0,0,0,0.2); font-size: 10px; font-family: var(--font-mono, ui-monospace, monospace); line-height: 1.4; max-height: 120px; overflow: auto; }
.step-return { font-size: 10.5px; color: var(--theme-success, #10B981); font-family: var(--font-mono, ui-monospace, monospace); margin-top: 2px; }

.tree-root { list-style: none; padding-left: 0; margin: 0; }
.tree-root ul { list-style: none; padding-left: 14px; border-left: 1px dashed var(--theme-divider, rgba(255,255,255,0.08)); margin-left: 4px; }
.tree-label { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; color: var(--theme-text, #e8ecf1); }
.tree-node-0 > .tree-label { color: var(--theme-primary, #F59E0B); font-weight: 700; }

.json-body { margin: 0; padding: 4px; background: rgba(0,0,0,0.2); border-radius: 4px; font-size: 10.5px; font-family: var(--font-mono, ui-monospace, monospace); line-height: 1.4; max-height: 200px; overflow: auto; }

.ai-commit-draft, .ai-deploy-draft { display: flex; flex-direction: column; gap: 6px; }
.draft-icon { color: var(--theme-primary, #F59E0B); }
.draft-message { font-size: 12px; font-weight: 700; color: var(--theme-text, #e8ecf1); }
.draft-summary { font-size: 12px; color: var(--theme-text, #e8ecf1); }
.draft-body { margin: 0; padding: 6px; border-radius: 4px; background: rgba(0,0,0,0.2); font-size: 11px; font-family: var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; max-height: 160px; overflow: auto; }
.draft-changed { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.draft-changed-label { font-size: 10px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); text-transform: uppercase; letter-spacing: 0.3px; }
.draft-changed-file { font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; padding: 1px 5px; border-radius: 3px; background: var(--theme-glass-bg, rgba(255,255,255,0.05)); }

.ai-project-summary { display: flex; flex-direction: column; gap: 6px; }
.summary-section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--theme-primary, #F59E0B); font-weight: 800; }
.summary-insights { margin: 0; padding-left: 16px; font-size: 11.5px; line-height: 1.5; }
.summary-arch { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--theme-text-secondary, rgba(232,236,241,0.72)); }

.ai-usage { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 6px; border-top: 1px solid var(--theme-divider, rgba(255,255,255,0.08)); font-size: 10px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); font-family: var(--font-mono, ui-monospace, monospace); }

/* ── Pending ─────────────────────────────────────────── */
.ai-pending { margin-top: 6px; padding: 8px; border-radius: 7px; background: var(--theme-glass-bg, rgba(255,255,255,0.05)); border: 1px solid var(--theme-card-border, rgba(255,255,255,0.08)); }
.pending-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 11px; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); }
.pending-row { display: flex; justify-content: space-between; gap: 6px; align-items: center; padding: 5px 0; border-bottom: 1px solid var(--theme-divider, rgba(255,255,255,0.08)); }
.pending-row:last-child { border-bottom: none; }
.pending-meta { display: flex; gap: 4px; flex-wrap: wrap; font-size: 10.5px; align-items: center; }
.pending-task { padding: 1px 5px; border-radius: 3px; background: var(--theme-primary-soft, rgba(245,158,11,0.14)); color: var(--theme-primary, #F59E0B); font-weight: 700; }
.pending-kind { color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); }
.pending-file { font-family: var(--font-mono, ui-monospace, monospace); color: var(--theme-text-secondary, rgba(232,236,241,0.72)); font-size: 10px; }
.pending-actions { display: flex; gap: 3px; }

/* ── Context menu ────────────────────────────────────── */
.ai-context-menu {
  background: var(--theme-surface-card-solid, #151922);
  border: 1px solid var(--theme-glass-border, rgba(255,255,255,0.09));
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  font-family: var(--font, 'Inter', system-ui, sans-serif);
  font-size: 12px;
}
.ai-context-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 7px 10px;
  border-radius: 5px;
  background: transparent; border: none;
  color: var(--theme-text, #e8ecf1);
  font-family: inherit; font-size: 12px; font-weight: 600;
  text-align: left; cursor: pointer;
  transition: background 0.1s ease;
}
.ai-context-item:hover:not(.disabled) { background: var(--theme-primary-soft, rgba(245,158,11,0.14)); color: var(--theme-primary, #F59E0B); }
.ai-context-item.disabled { opacity: 0.45; cursor: not-allowed; }
.ai-context-item svg { flex-shrink: 0; }

/* ── Small-button base ───────────────────────────────── */
.ai-panel .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  padding: 5px 9px; border-radius: 6px;
  font-size: 11px; font-weight: 700;
  border: 1px solid transparent; cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
}
.ai-panel .btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ai-panel .btn-primary { background: var(--theme-primary, #F59E0B); color: #0a0c10; }
.ai-panel .btn-primary:hover:not(:disabled) { background: var(--theme-primary-hover, #fbbf24); }
.ai-panel .btn-ghost { background: transparent; color: var(--theme-text-tertiary, rgba(232,236,241,0.44)); }
.ai-panel .btn-ghost:hover:not(:disabled) { color: var(--theme-text, #e8ecf1); background: var(--theme-glass-bg, rgba(255,255,255,0.05)); }
.ai-panel .btn-sm { padding: 4px 8px; font-size: 10.5px; }
.ai-panel .btn svg { width: 11px; height: 11px; flex-shrink: 0; }
  `;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectStyles);
  } else {
    injectStyles();
  }
}