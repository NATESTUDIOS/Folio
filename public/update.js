/* ============================================================
   Folio — update.js
   Service worker update prompt + apply.

   Usage:
     <script src="/update.js" defer></script>

   API:
     FOLIO.update.check()
     FOLIO.update.applyNow()
     FOLIO.update.pause()      // install.js uses this
     FOLIO.update.resume()
     FOLIO.update.isPaused()

   Event:
     folio:update:available
     folio:update:applied
   ============================================================ */
(function () {
  'use strict';

  const CFG = {
    checkIntervalMs: 5 * 60 * 1000,     // poll every 5 min
    autoDismissMs: 30 * 1000,           // auto-dismiss dialog after 30s
    reloadDelayMs: 700,                 // brief pause before reload
    controllerTimeoutMs: 4000,          // safety net for SKIP_WAITING
    waitingPollTimeoutMs: 5000,         // wait for a waiting worker
  };

  const S = {
    reg: null,
    dialogEl: null,
    dialogTimer: null,
    applying: false,
    paused: false,
    postponed: false,         // [FIX] "Later" this session → don't re-show
    postponedVersion: null,   // [FIX] version the user postponed
    stylesInjected: false,
    initialized: false,
    checkTimer: null,
    safetyTimer: null,
    onCtrlHandler: null,
  };

  /* ── Toast bridge ──
     Editor defines: toast(message, type = 'info', duration = 2500)
     → positional args, NOT an options object.            [FIX] */
  const toast = (msg, type = 'info', duration = 3000) => {
    try {
      if (typeof window.toast === 'function') window.toast(msg, type, duration);
      else console.log('[Folio update]', msg);
    } catch {}
  };

  /* ── Unsaved-work guard ── */
  function hasUnsavedWork() {
    try {
      const ws = window.workspace;
      if (!ws) return false;
      if (ws.dirtyFiles instanceof Set) return ws.dirtyFiles.size > 0;
      return !!ws.dirty;
    } catch { return false; }
  }

  /* ── Confirm wrapper ──
     Handles both:
       • Editor's Promise-returning confirm({ ... })  (index.html)
       • Native window.confirm('string') → boolean    (fallback)
                                                                [FIX] */
  async function confirmDiscard() {
    const opts = {
      title: 'Reload anyway?',
      message: 'You have unsaved changes. Reloading will lose them.',
      confirmLabel: 'Reload',
      danger: true,
    };

    // If the editor overrode window.confirm with a Promise-returning
    // helper, use it. Otherwise fall back to the native boolean confirm.
    try {
      if (typeof window.confirm === 'function') {
        const r = window.confirm(opts);
        if (r && typeof r.then === 'function') return !!(await r);
        // If it returned a boolean, that's the native confirm — but we
        // passed an object, so the browser stringified it. Fall through
        // to a clean native call.
      }
    } catch {}

    try {
      return !!window.confirm(opts.message);
    } catch {
      return false;
    }
  }

  /* ── CSS ── */
  function injectStyles() {
    if (S.stylesInjected || document.getElementById('folio-update-style')) {
      S.stylesInjected = true; return;
    }
    const css = `
      .folio-upd {
        position: fixed; inset: 0; z-index: 999991;
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
        background: rgba(10, 12, 16, 0.72);
        backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
        opacity: 0; pointer-events: none;
        transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
        font-family: var(--font-sans, "Inter", -apple-system, system-ui, sans-serif);
      }
      .folio-upd.open { opacity: 1; pointer-events: auto; }
      .folio-upd-card {
        width: 100%; max-width: 360px;
        background: var(--bg-card, #151922);
        border: 1px solid var(--border, #222831);
        border-radius: 20px;
        padding: 26px 22px 20px;
        text-align: center;
        transform: scale(0.94) translateY(14px);
        transition: transform 260ms cubic-bezier(0.16, 1, 0.3, 1);
        position: relative;
      }
      .folio-upd.open .folio-upd-card { transform: scale(1) translateY(0); }
      .folio-upd-icon {
        width: 56px; height: 56px; margin: 0 auto 14px;
        border-radius: 16px;
        background: rgba(245, 158, 11, 0.14);
        border: 1px solid rgba(245, 158, 11, 0.30);
        display: flex; align-items: center; justify-content: center;
        color: #F59E0B;
      }
      .folio-upd-icon svg {
        width: 26px; height: 26px;
        stroke: currentColor; fill: none;
        stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round;
      }
      .folio-upd-title {
        font-size: 18px; font-weight: 700; letter-spacing: -0.3px;
        color: var(--text, #e8ecf1); margin: 0 0 6px;
      }
      .folio-upd-sub {
        font-size: 13px; line-height: 1.55;
        color: var(--text-muted, #a8b0bc); margin: 0 0 18px;
      }
      .folio-upd-progress {
        height: 4px; border-radius: 4px;
        background: var(--bg-input, #1a1f2a);
        overflow: hidden; margin: 0 0 18px;
      }
      .folio-upd-progress-fill {
        height: 100%; width: 0;
        background: linear-gradient(90deg, #F59E0B, #fbbf24);
        transition: width 200ms ease;
      }
      .folio-upd-actions { display: flex; gap: 8px; }
      .folio-upd-btn {
        flex: 1;
        font-family: inherit; font-size: 13.5px; font-weight: 600;
        padding: 12px 16px; border-radius: 12px;
        border: 1px solid transparent;
        cursor: pointer;
        transition: all 120ms ease;
        touch-action: manipulation; user-select: none;
      }
      .folio-upd-btn.primary {
        background: #F59E0B; color: #0a0c10;
        box-shadow: 0 6px 20px rgba(245, 158, 11, 0.30);
      }
      .folio-upd-btn.primary:hover { background: #fbbf24; }
      .folio-upd-btn.ghost {
        background: transparent;
        color: var(--text-muted, #a8b0bc);
        border-color: var(--border, #222831);
      }
      .folio-upd-btn.ghost:hover { color: var(--text, #e8ecf1); background: var(--bg-input, #1a1f2a); }
      .folio-upd-btn:active { transform: scale(0.97); }
      .folio-upd-btn:focus-visible { outline: 2px solid #F59E0B; outline-offset: 2px; }
      .folio-upd-btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }

      /* Full-screen reload overlay */
      .folio-reload {
        position: fixed; inset: 0; z-index: 999992;
        display: flex; align-items: center; justify-content: center;
        background: rgba(10, 12, 16, 0.85);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
        font-family: var(--font-sans, "Inter", system-ui, sans-serif);
        color: var(--text, #e8ecf1);
        text-align: center;
        padding: 24px;
      }
      .folio-reload-spinner {
        width: 40px; height: 40px; margin: 0 auto 18px;
        border: 3px solid rgba(245, 158, 11, 0.20);
        border-top-color: #F59E0B;
        border-radius: 50%;
        animation: folio-reload-spin 0.9s linear infinite;
      }
      @keyframes folio-reload-spin { to { transform: rotate(360deg); } }
      .folio-reload-title { font-size: 16px; font-weight: 700; margin: 0 0 6px; }
      .folio-reload-sub { font-size: 13px; color: var(--text-muted, #a8b0bc); margin: 0; }

      @media (max-width: 480px) {
        .folio-upd { align-items: flex-end; padding: 0; }
        .folio-upd-card {
          max-width: 100%;
          border-radius: 20px 20px 0 0;
          padding: 22px 20px calc(18px + env(safe-area-inset-bottom, 0px));
          transform: translateY(100%);
        }
        .folio-upd.open .folio-upd-card { transform: translateY(0); }
        .folio-upd-card::before {
          content: ''; position: absolute;
          top: 8px; left: 50%; transform: translateX(-50%);
          width: 36px; height: 4px; border-radius: 4px;
          background: var(--border, #222831);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .folio-upd, .folio-upd-card, .folio-upd-btn,
        .folio-upd-progress-fill, .folio-reload-spinner {
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
        }
      }
    `;
    const s = document.createElement('style');
    s.id = 'folio-update-style';
    s.textContent = css;
    document.head.appendChild(s);
    S.stylesInjected = true;
  }

  /* ── Dialog ── */
  function buildDialog() {
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'folio-upd';
    ov.id = 'folio-update-overlay';
    ov.innerHTML = `
      <div class="folio-upd-card" role="dialog" aria-modal="true" aria-labelledby="folio-upd-title">
        <div class="folio-upd-icon">
          <svg viewBox="0 0 24 24">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </div>
        <h3 class="folio-upd-title" id="folio-upd-title">Update available</h3>
        <p class="folio-upd-sub">A new version of Folio is ready.</p>
        <div class="folio-upd-progress" hidden>
          <div class="folio-upd-progress-fill"></div>
        </div>
        <div class="folio-upd-actions">
          <button class="folio-upd-btn ghost" data-folio-upd="later">Later</button>
          <button class="folio-upd-btn primary" data-folio-upd="apply">Update</button>
        </div>
      </div>
    `;
    document.body.appendChild(ov);

    ov.querySelector('[data-folio-upd="later"]').addEventListener('click', dismiss);
    ov.querySelector('[data-folio-upd="apply"]').addEventListener('click', applyNow);

    // Click backdrop to dismiss
    ov.addEventListener('click', (e) => {
      if (e.target === ov) dismiss();
    });

    return ov;
  }

  function show() {
    if (S.applying || S.dialogEl) return;

    // Respect a "Later" click for the current waiting version    [FIX]
    const waitingVer = S.reg?.waiting ? S.reg.waiting.scriptURL : null;
    if (S.postponed && waitingVer && waitingVer === S.postponedVersion) return;

    const ov = buildDialog();
    S.dialogEl = ov;
    document.body.style.overflow = 'hidden';
    void ov.offsetWidth;
    ov.classList.add('open');

    // Auto-dismiss
    S.dialogTimer = setTimeout(() => {
      if (!S.applying) dismiss();
    }, CFG.autoDismissMs);

    try { window.dispatchEvent(new CustomEvent('folio:update:available')); } catch {}
  }

  function dismiss() {
    if (S.dialogTimer) { clearTimeout(S.dialogTimer); S.dialogTimer = null; }
    if (!S.dialogEl) return;

    // Mark this waiting version as postponed for the session       [FIX]
    if (S.reg?.waiting) {
      S.postponed = true;
      S.postponedVersion = S.reg.waiting.scriptURL;
    }

    const ov = S.dialogEl;
    S.dialogEl = null;
    ov.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => ov.remove(), 260);
  }

  /* ── Progress bar ── */
  function setProgress(pct) {
    const fill = S.dialogEl?.querySelector('.folio-upd-progress-fill');
    const wrap = S.dialogEl?.querySelector('.folio-upd-progress');
    if (wrap) wrap.hidden = false;
    if (fill) fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  /* ── Show reload overlay ── */
  function showReloadOverlay() {
    injectStyles();
    if (document.getElementById('folio-reload-overlay')) return;
    const ov = document.createElement('div');
    ov.id = 'folio-reload-overlay';
    ov.className = 'folio-reload';
    ov.innerHTML = `
      <div>
        <div class="folio-reload-spinner"></div>
        <div class="folio-reload-title">Updating Folio</div>
        <div class="folio-reload-sub">Reloading in a moment…</div>
      </div>
    `;
    document.body.appendChild(ov);
  }

  /* ── Apply update ── */
  async function applyNow() {
    if (S.applying) return;
    S.applying = true;

    // Respect unsaved work
    if (hasUnsavedWork()) {
      const ok = await confirmDiscard();
      if (!ok) {
        S.applying = false;
        return;
      }
    }

    // Disable action buttons
    const applyBtn = S.dialogEl?.querySelector('[data-folio-upd="apply"]');
    const laterBtn = S.dialogEl?.querySelector('[data-folio-upd="later"]');
    if (applyBtn) applyBtn.disabled = true;
    if (laterBtn) laterBtn.disabled = true;

    setProgress(10);
    if (S.dialogTimer) { clearTimeout(S.dialogTimer); S.dialogTimer = null; }

    try {
      const reg = S.reg || await navigator.serviceWorker.getRegistration();
      if (!reg) throw new Error('No service worker registration');
      S.reg = reg;

      // Prefer waiting worker
      if (!reg.waiting) {
        await reg.update();
        // Wait up to CFG.waitingPollTimeoutMs for a waiting worker to appear
        await new Promise((resolve) => {
          const start = Date.now();
          const iv = setInterval(() => {
            if (reg.waiting || Date.now() - start > CFG.waitingPollTimeoutMs) {
              clearInterval(iv); resolve();
            }
          }, 100);
        });
      }

      setProgress(45);

      if (reg.waiting) {
        // Clear any pending fallback from a previous attempt       [FIX]
        if (S.safetyTimer) { clearTimeout(S.safetyTimer); S.safetyTimer = null; }
        if (S.onCtrlHandler) {
          navigator.serviceWorker.removeEventListener('controllerchange', S.onCtrlHandler);
          S.onCtrlHandler = null;
        }

        // Listen for controller change → reload
        S.onCtrlHandler = () => {
          if (S.safetyTimer) { clearTimeout(S.safetyTimer); S.safetyTimer = null; } // [FIX]
          navigator.serviceWorker.removeEventListener('controllerchange', S.onCtrlHandler);
          S.onCtrlHandler = null;
          setProgress(100);
          showReloadOverlay();
          try { window.dispatchEvent(new CustomEvent('folio:update:applied')); } catch {}
          setTimeout(() => location.reload(), CFG.reloadDelayMs);
        };
        navigator.serviceWorker.addEventListener('controllerchange', S.onCtrlHandler);

        setProgress(75);
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });

        // Safety: if no controllerchange after timeout, force reload
        S.safetyTimer = setTimeout(() => {
          S.safetyTimer = null;
          setProgress(100);
          showReloadOverlay();
          try { window.dispatchEvent(new CustomEvent('folio:update:applied')); } catch {}
          location.reload();
        }, CFG.controllerTimeoutMs);
      } else {
        // Nothing waiting — reload anyway to pick up new HTTP cache
        setProgress(100);
        showReloadOverlay();
        setTimeout(() => location.reload(), CFG.reloadDelayMs);
      }
    } catch (err) {
      console.warn('[Folio update] apply failed:', err);
      S.applying = false;
      if (applyBtn) applyBtn.disabled = false;
      if (laterBtn) laterBtn.disabled = false;
      setProgress(0);
      toast('Update failed — try again later', 'error', 4000);   // [FIX] positional
    }
  }

  /* ── Update checks ── */
  async function checkNow() {
    if (S.paused || S.applying) return;
    if (S.dialogEl) return;        // don't stack dialogs               [FIX]
    try {
      const reg = S.reg || await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      S.reg = reg;
      await reg.update();

      // New SW arrived → clear the "postponed" flag for this new one  [FIX]
      if (reg.waiting && S.postponedVersion !== reg.waiting.scriptURL) {
        S.postponed = false;
        S.postponedVersion = null;
      }

      if (reg.waiting) show();
    } catch (err) {
      console.warn('[Folio update] check failed:', err);
    }
  }

  /* ── Init ── */
  async function init() {
    if (S.initialized || !('serviceWorker' in navigator)) return;
    S.initialized = true;

    try {
      S.reg = await navigator.serviceWorker.getRegistration();
      if (!S.reg) return;

      // SW tells us it has an update ready
      navigator.serviceWorker.addEventListener('message', (event) => {
        const d = event.data || {};
        if (d.type === 'SW_UPDATE_AVAILABLE' || d.type === 'UPDATE_AVAILABLE') {
          // A new version supersedes any postponed one                [FIX]
          S.postponed = false;
          S.postponedVersion = null;
          show();
        }
      });

      // SW took control — do nothing unless applyNow initiated it
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // No-op: reload is triggered by applyNow's onCtrlHandler.
        // We intentionally do NOT reload here so a silent first-install
        // doesn't yank the page out from under the user.
      });

      // Recurring + trigger-based checks
      if (S.checkTimer) clearInterval(S.checkTimer);
      S.checkTimer = setInterval(checkNow, CFG.checkIntervalMs);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkNow();
      });
      window.addEventListener('online', checkNow);

      await checkNow();

      // If a waiting worker exists at boot, surface it
      if (S.reg.waiting) show();
    } catch (err) {
      console.warn('[Folio update] init error:', err);
    }
  }

  /* ── Public API ── */
  window.FOLIO = window.FOLIO || {};
  window.FOLIO.update = {
    check: checkNow,
    applyNow,
    pause() {
      S.paused = true;
      if (S.checkTimer) { clearInterval(S.checkTimer); S.checkTimer = null; }
    },
    resume() {
      S.paused = false;
      if (S.applying) return;              // [FIX] don't check mid-reload
      setTimeout(checkNow, 800);
    },
    isPaused: () => S.paused,
    _state: S,
  };

  // Bridge used by install.js
  window.__updateManager = window.FOLIO.update;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();