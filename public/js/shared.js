// public/js/shared.js
// ═══════════════════════════════════════════════════════════════════════
//  FOLIO — Shared (foundation)
//  Every page imports from here. No imports of its own.
// ═══════════════════════════════════════════════════════════════════════

export const STORAGE_KEYS = {
  jwt: "folio.sessionToken",
  theme: "folio.theme",
  settings: "folio.settings",
  lastProject: "folio.lastProject",
  lastFile: "folio.lastFile",
  deviceId: "folio.deviceId",
  splashShown: "folio.splashShown",
};


/* ── DOM ── */

export function $ (id) {
  return document.getElementById(id);
}

export function $$ (sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

export function el (tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2), v);
    } else if (v === true) {
      node.setAttribute(k, "");
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(
      typeof child === "string" || typeof child === "number"
        ? document.createTextNode(String(child))
        : child
    );
  }
  return node;
}

export function icon (name, size = 16) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.appendChild(use);
  return svg;
}


/* ── Formatting ── */

export function esc (s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function formatBytes (n) {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function relativeTime (ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 0) return "Just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return "Just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}


/* ── Device ID ── */

export function getOrCreateDeviceId () {
  try {
    let id = localStorage.getItem(STORAGE_KEYS.deviceId);
    if (!id) {
      id = crypto.randomUUID?.() || `dev_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(STORAGE_KEYS.deviceId, id);
    }
    return id;
  } catch {
    return `dev_${Date.now()}`;
  }
}


/* ── Toast ── */

const toastQueue = [];
let toastActive = null;

export function toast (message, opts = {}) {
  const { type = "info", duration, action } = opts;
  const d = duration ?? (type === "error" || type === "warning" ? 5000 : 3000);
  toastQueue.push({ message, type, duration: d, action });
  if (!toastActive) drainToast();
}

function drainToast () {
  const next = toastQueue.shift();
  if (!next) { toastActive = null; return; }
  toastActive = next;

  const container = $("toastContainer");
  if (!container) { toastActive = null; return; }

  const node = el("div", { class: `toast toast-${next.type}`, role: "status" },
    el("span", { class: "toast-dot" }),
    el("span", { class: "toast-message" }, next.message),
    next.action
      ? el("button", {
          class: "toast-action",
          type: "button",
          onclick: () => {
            try { next.action.onClick?.(); } catch {}
            dismissToast(node);
          }
        }, next.action.label || "Action")
      : null
  );

  container.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));

  const timer = setTimeout(() => dismissToast(node), next.duration);
  node.addEventListener("mouseenter", () => clearTimeout(timer), { once: true });

  function dismissToast (n) {
    clearTimeout(timer);
    n.classList.remove("show");
    setTimeout(() => {
      n.remove();
      toastActive = null;
      drainToast();
    }, 250);
  }
}


/* ── Sheet ── */

export const sheetState = {
  open: false,
  onClose: null,
  previousFocus: null,
};

export function openSheet ({ title, body, footer, onClose }) {
  const sheet = $("sheet");
  const backdrop = $("backdrop");
  const titleEl = $("sheetTitle");
  const bodyEl = $("sheetBody");
  const footerEl = $("sheetFooter");

  if (!sheet || !bodyEl) return;

  sheetState.previousFocus = document.activeElement;
  sheetState.onClose = onClose || null;

  if (titleEl) titleEl.textContent = title || "Panel";

  bodyEl.innerHTML = "";
  if (body instanceof Node) bodyEl.appendChild(body);
  else if (typeof body === "string") bodyEl.innerHTML = body;

  if (footerEl) {
    footerEl.innerHTML = "";
    if (footer instanceof Node) {
      footerEl.appendChild(footer);
      footerEl.classList.remove("hidden");
    } else if (typeof footer === "string" && footer.trim()) {
      footerEl.innerHTML = footer;
      footerEl.classList.remove("hidden");
    } else if (Array.isArray(footer) && footer.length > 0) {
      footer.forEach(n => footerEl.appendChild(n));
      footerEl.classList.remove("hidden");
    } else {
      footerEl.classList.add("hidden");
    }
  }

  backdrop?.classList.add("visible");
  sheet.classList.add("open");
  sheetState.open = true;

  setTimeout(() => {
    const first = sheet.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    first?.focus();
  }, 50);

  trapFocus(sheet);
}

export function closeSheet () {
  if (!sheetState.open) return;
  const sheet = $("sheet");
  const backdrop = $("backdrop");
  if (!sheet) return;

  sheet.classList.remove("open");

  const confirmOpen = $("confirmDialog")?.classList.contains("open");
  if (!confirmOpen) backdrop?.classList.remove("visible");

  sheetState.open = false;

  const cb = sheetState.onClose;
  sheetState.onClose = null;

  setTimeout(() => {
    const bodyEl = $("sheetBody");
    const footerEl = $("sheetFooter");
    if (bodyEl) bodyEl.innerHTML = "";
    if (footerEl) footerEl.innerHTML = "";
    const prev = sheetState.previousFocus;
    if (prev && document.contains(prev)) {
      try { prev.focus(); } catch {}
    }
    sheetState.previousFocus = null;
    if (cb) try { cb(); } catch {}
  }, 250);
}

function trapFocus (container) {
  const focusable = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  function handler (e) {
    if (e.key !== "Tab") return;
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  container.addEventListener("keydown", handler);
  container._focusTrapHandler = handler;
}


/* ── Confirm ── */

let confirmResolve = null;
let confirmPreviousFocus = null;

export function confirm ({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  info = false,
}) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmPreviousFocus = document.activeElement;

    const dialog = $("confirmDialog");
    const backdrop = $("backdrop");
    const iconEl = $("confirmIcon");

    if (!dialog) { resolve(false); return; }

    $("confirmTitle").textContent = title || "Are you sure?";
    $("confirmMessage").textContent = message || "";
    $("confirmOk").textContent = confirmLabel;

    const cancelBtn = $("confirmCancel");
    if (cancelBtn) {
      if (cancelLabel === null) {
        cancelBtn.style.display = "none";
      } else {
        cancelBtn.style.display = "";
        cancelBtn.textContent = cancelLabel;
      }
    }

    if (danger) {
      $("confirmOk").className = "btn btn-danger";
      if (iconEl) iconEl.className = "confirm-icon";
    } else {
      $("confirmOk").className = "btn btn-primary";
      if (iconEl) iconEl.className = "confirm-icon info";
    }

    backdrop?.classList.add("visible");
    dialog.classList.add("open");

    setTimeout(() => $("confirmOk")?.focus(), 50);
  });
}

export function resolveConfirm (value) {
  const dialog = $("confirmDialog");
  const backdrop = $("backdrop");

  dialog?.classList.remove("open");

  if (!sheetState.open) {
    backdrop?.classList.remove("visible");
  }

  const prev = confirmPreviousFocus;
  if (prev && document.contains(prev)) {
    try { prev.focus(); } catch {}
  }
  confirmPreviousFocus = null;

  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(value);
}

export function alertDialog ({ title, message }) {
  return confirm({
    title,
    message,
    confirmLabel: "OK",
    cancelLabel: null,
    info: true,
  });
}

export function wireOverlays () {
  $("confirmOk")?.addEventListener("click", () => resolveConfirm(true));
  $("confirmCancel")?.addEventListener("click", () => resolveConfirm(false));
  $("confirmDialog")?.addEventListener("click", (e) => {
    if (e.target === $("confirmDialog")) resolveConfirm(false);
  });
  $("backdrop")?.addEventListener("click", () => {
    if ($("confirmDialog")?.classList.contains("open")) {
      resolveConfirm(false);
      return;
    }
    if (sheetState.open) closeSheet();
  });
  $("sheetClose")?.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("confirmDialog")?.classList.contains("open")) {
      resolveConfirm(false);
      e.preventDefault();
      return;
    }
    if (sheetState.open) {
      closeSheet();
      e.preventDefault();
    }
  });
}