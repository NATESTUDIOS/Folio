// public/js/boot.js
// ═══════════════════════════════════════════════════════════════════════
//  FOLIO — Boot (entry point for every page)
// ═══════════════════════════════════════════════════════════════════════

import {
  $, $$,
  toast, openSheet, closeSheet, wireOverlays,
  STORAGE_KEYS,
} from "./shared.js";

import { db, settings, requestPersistentStorage } from "./db.js";

import { install } from "./install.js";


/* ── Theme ── */

const theme = {
  current: "dark",

  init () {
    let pref = "dark";
    try { pref = localStorage.getItem(STORAGE_KEYS.theme) || "dark"; } catch {}
    this.set(pref, { silent: true });
  },

  set (mode, { silent = false } = {}) {
    let resolved = mode;
    if (mode === "auto") {
      resolved = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    if (resolved === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    this.current = mode;
    try { localStorage.setItem(STORAGE_KEYS.theme, mode); } catch {}
    const meta = $("metaThemeColor");
    if (meta) meta.setAttribute("content", resolved === "light" ? "#f7f8fa" : "#0a0c10");
    $$(".theme-option").forEach(opt => {
      opt.classList.toggle("active", opt.dataset.themeValue === mode);
    });
    if (!silent) {
      const label = mode === "auto" ? "Auto" : mode === "light" ? "Light" : "Dark";
      toast(`Theme: ${label}`, { type: "info", duration: 1500 });
    }
  },
};

window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
  if (theme.current === "auto") theme.set("auto", { silent: true });
});

window.__folioTheme = theme;
window.__folioInstall = install;


/* ── Header nav (mobile hamburger) ── */

function wireHeaderNav () {
  const menuBtn = $("menuBtn");
  if (menuBtn) {
    menuBtn.addEventListener("click", () => {
      const body = document.createElement("div");
      body.className = "panel";

      const list = document.createElement("div");
      list.className = "flex flex-col gap-2";

      const items = [
        { href: "/projects",     icon: "folder",     label: "Projects" },
        { href: "/app",          icon: "code",       label: "Editor" },
        { href: "/tools",        icon: "settings",   label: "Tools" },
        { href: "/analytics",    icon: "bar-chart",  label: "Analytics" },
        { href: "/profile",      icon: "users",      label: "Profile" },
        { href: "/notifications", icon: "bell",      label: "Notifications" },
        { href: "/settings",     icon: "settings",   label: "Settings" },
      ];

      for (const item of items) {
        const a = document.createElement("a");
        a.href = item.href;
        a.className = "btn btn-secondary btn-block";
        a.style.textDecoration = "none";
        a.style.justifyContent = "flex-start";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "16");
        svg.setAttribute("height", "16");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", `#icon-${item.icon}`);
        svg.appendChild(use);
        a.appendChild(svg);
        a.appendChild(document.createTextNode(" " + item.label));
        list.appendChild(a);
      }

      body.appendChild(list);
      openSheet({ title: "Menu", body });
    });
  }

  // Mark active rail item
  const path = window.location.pathname;
  $$(".rail-item").forEach(item => {
    const href = item.getAttribute("href");
    if (!href) return;
    const isActive = path === href || path.startsWith(href + "/");
    item.classList.toggle("active", isActive);
  });
}


/* ── Responsive shell ── */

function applyResponsiveShell () {
  const shell = $("appShell");
  if (!shell) return;
  const sync = () => {
    if (window.innerWidth >= 640) shell.classList.add("app-shell--with-rail");
    else shell.classList.remove("app-shell--with-rail");
  };
  sync();
  window.addEventListener("resize", sync);
}


/* ── Page router ── */

function getPageFromUrl () {
  const path = window.location.pathname;
  if (path === "/app" || path === "/" || path === "/index.html") return "editor";
  if (path === "/projects" || path === "/projects.html") return "projects";
  if (path === "/project" || path === "/project.html") return "project";
  if (path === "/settings" || path === "/settings.html") return "settings";
  if (path === "/tools" || path === "/tools.html") return "tools";
  if (path === "/profile" || path === "/profile.html") return "profile";
  if (path === "/analytics" || path === "/analytics.html") return "analytics";
  if (path === "/notifications" || path === "/notifications.html") return "notifications";
  if (path === "/dashboard" || path === "/dashboard.html") return "dashboard";
  if (path === "/register" || path === "/register.html") return "register";
  if (path === "/offline" || path === "/offline.html") return "offline";
  return "unknown";
}


/* ── Editor boot ── */

async function bootEditorPage () {
  console.log("[Boot] Loading editor modules…");

  let editorMod, panelsMod, pickerMod;
  try {
    [editorMod, panelsMod, pickerMod] = await Promise.all([
      import("./editor.js"),
      import("./panels.js"),
      import("./project-picker.js"),
    ]);
  } catch (err) {
    console.error("[Boot] Editor module load failed:", err);
    toast("Editor modules failed to load. Check console.", { type: "error", duration: 8000 });
    return;
  }

  const { workspace, cm } = editorMod;
  const { localPanels } = panelsMod;
  const { renderProjectPicker, wireEmptyState } = pickerMod;

  console.log("[Boot] Editor modules loaded");

  const panelRouter = { ...localPanels };

  async function openPanel (name) {
    const fn = panelRouter[name];
    if (!fn) {
      toast(`Panel not found: ${name}`, { type: "error" });
      return;
    }
    try {
      await fn();
    } catch (err) {
      console.error(`[Panel] ${name} failed:`, err);
      toast("Couldn't open that panel", { type: "error" });
    }
  }

  // Rail wiring — panel buttons
  const railPanels = $$(".rail-item[data-panel]");
  railPanels.forEach(btn => {
    btn.addEventListener("click", () => {
      const panel = btn.dataset.panel;
      if (panel) openPanel(panel);
    });
  });
  console.log("[Boot] Rail panel buttons wired:", railPanels.length);

  // Header save button
  $("saveBtn")?.addEventListener("click", () => workspace.saveActiveFile());

  // Save button dirty state
  const saveBtn = $("saveBtn");
  const dirtyDot = $("dirtyDot");
  if (saveBtn && dirtyDot) {
    const observer = new MutationObserver(() => {
      saveBtn.classList.toggle("has-unsaved", dirtyDot.classList.contains("visible"));
    });
    observer.observe(dirtyDot, { attributes: true, attributeFilter: ["class"] });
  }

  // Toolbar wiring — CRITICAL
  const toolbarBindings = [
    ["tbSave", () => workspace.saveActiveFile()],
    ["tbUndo", () => {
      if (!cm.view) { toast("Open a file first", { type: "info", duration: 2000 }); return; }
      cm.undo();
    }],
    ["tbRedo", () => {
      if (!cm.view) { toast("Open a file first", { type: "info", duration: 2000 }); return; }
      cm.redo();
    }],
    ["tbCtrl", (e) => {
      e.currentTarget.classList.toggle("ctrl-latched");
      if (e.currentTarget.classList.contains("ctrl-latched")) {
        toast("Ctrl latched — press a key to combine", { type: "info", duration: 2000 });
      }
    }],
    ["tbSelect", () => {
      if (!cm.view) { toast("Open a file first", { type: "info", duration: 2000 }); return; }
      cm.selectAll();
    }],
    ["tbSearch", () => {
      if (!cm.view) { toast("Open a file first", { type: "info", duration: 2000 }); return; }
      cm.openSearch();
    }],
    ["tbFormat", () => {
      if (!cm.view) { toast("Open a file first", { type: "info", duration: 2000 }); return; }
      if (cm.currentLang === "json") cm.formatJSON();
      else toast("Format available for JSON in this version", { type: "info", duration: 2000 });
    }],
    ["tbMore", () => {
      $("toolbarRow2")?.classList.toggle("visible");
    }],
    ["tbCommit", () => openPanel("changes")],
    ["tbNotepad", () => openPanel("notepad")],
    ["tbJsonTree", () => openPanel("jsontree")],
    ["tbSymbols", () => openPanel("symbols")],
    ["tbPreview", () => openPanel("preview")],
  ];

  let toolbarWired = 0;
  for (const [id, handler] of toolbarBindings) {
    const el = $(id);
    if (!el) {
      console.warn(`[Boot] Toolbar button missing: #${id}`);
      continue;
    }
    el.addEventListener("click", handler);
    toolbarWired++;
  }
  console.log("[Boot] Toolbar buttons wired:", toolbarWired, "of", toolbarBindings.length);

  // Empty state
  wireEmptyState();

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "s") {
      e.preventDefault();
      workspace.saveActiveFile();
      return;
    }
    if (mod && e.key === "k") {
      e.preventDefault();
      renderProjectPicker({
        onSelect: async (project) => workspace.openProject(project),
      });
      return;
    }
    if (mod && e.key === "p") {
      e.preventDefault();
      renderProjectPicker({
        onSelect: async (project) => workspace.openProject(project),
      });
      return;
    }
  });

  // beforeunload
  window.addEventListener("beforeunload", (e) => {
    if (workspace.dirty) {
      e.preventDefault();
      e.returnValue = "";
      return "";
    }
  });

  // Load last project
  try {
    const project = await workspace.loadLastProject();
    if (!project) {
      $("editorEmpty")?.classList.add("visible");
    } else {
      $("editorEmpty")?.classList.remove("visible");
    }
  } catch (err) {
    console.error("[Boot] Load project failed:", err);
    workspace.showEmptyEditor();
  }

  // URL panel hint
  try {
    const url = new URL(window.location.href);
    const panel = url.searchParams.get("panel");
    if (panel && panelRouter[panel]) {
      setTimeout(() => openPanel(panel), 500);
    }
  } catch {}

  window.__folio = { workspace, cm, localPanels, openPanel };
  console.log("[Boot] Editor boot complete");
}


/* ── Non-editor page boot ── */

async function bootPagesPage (page) {
  console.log("[Boot] Loading pages module for:", page);
  const root = $("page-root");
  if (!root) {
    console.error("[Boot] Missing #page-root on page:", page);
    return;
  }

  let pagesMod;
  try {
    pagesMod = await import("./pages.js");
  } catch (err) {
    console.error("[Boot] Pages module load failed:", err);
    toast("Page failed to load. Check console.", { type: "error", duration: 8000 });
    return;
  }

  try {
    await pagesMod.renderPage(page, root);
  } catch (err) {
    console.error(`[Boot] renderPage(${page}) failed:`, err);
    toast("Page failed to render. Check console.", { type: "error" });
  }
}


/* ── Splash ── */

function hideSplash () {
  const splash = $("splash");
  if (!splash) return;
  splash.classList.add("hide");
  setTimeout(() => splash.remove(), 350);
}

setTimeout(() => { if ($("splash")) hideSplash(); }, 5000);


/* ── Boot ── */

async function boot () {
  console.log("[Boot] Starting, path:", window.location.pathname);

  settings.load();
  theme.init();

  try {
    await db.open();
    console.log("[Boot] IndexedDB opened");
  } catch (err) {
    console.error("[Boot] DB failed:", err);
    toast("Storage initialization failed. Reload the page.", { type: "error", duration: 8000 });
    hideSplash();
    return;
  }

  requestPersistentStorage().catch(() => {});
  wireOverlays();
  applyResponsiveShell();
  wireHeaderNav();
  install.init();

  const page = getPageFromUrl();
  console.log("[Boot] Page detected:", page);

  if (page === "editor") {
    try {
      await bootEditorPage();
    } catch (err) {
      console.error("[Boot] Editor boot failed:", err);
      toast("Couldn't load editor. Try reloading.", { type: "error", duration: 8000 });
    }
  } else if (page === "dashboard") {
    window.location.replace("/projects");
    return;
  } else if (page === "projects" || page === "project" || page === "settings" ||
             page === "tools" || page === "profile" || page === "analytics" ||
             page === "notifications") {
    await bootPagesPage(page);
  } else if (page === "register" || page === "offline") {
    console.log("[Boot] Static page, no boot logic needed");
  } else {
    if (document.getElementById("page-root")) {
      await bootPagesPage("projects");
    }
  }

  hideSplash();
  document.documentElement.setAttribute("data-ready", "true");
  console.log("[Boot] Complete");
}


if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
