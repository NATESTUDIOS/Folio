/* ============================================================
   Folio — update.js
   KOFA X–style update prompt. Theme-aware, self-contained CSS.

   API:
     FOLIO.update.check()
     FOLIO.update.applyNow()
     FOLIO.update.pause() / resume() / isPaused()

   Events:
     folio:update:available
     folio:update:applied
   ============================================================ */
(function () {
  'use strict';

  const CFG = {
    checkIntervalMs: 5 * 60 * 1000,
    minCheckGapMs: 30 * 1000,
    autoDismissMs: 30 * 1000,           // ← KOFA X behaviour: dismiss, not apply
    reloadDelayMs: 700,
    controllerTimeoutMs: 4000,
    waitingPollTimeoutMs: 5000,
    versionProbeMs: 2500,
    autoShowDelayMs: 800,
  };

  const POSTPONE_KEY = 'folio.upd.postponed';
  const FIRST_ACTIVATE_KEY = 'folio.sw.firstActivate';

  const S = {
    reg: null,
    dialogEl: null,
    dialogVersion: null,
    autoDismissTimer: null,
    applying: false,
    paused: false,
    postponedVersion: null,
    stylesInjected: false,
    initialized: false,
    checkTimer: null,
    safetyTimer: null,
    onCtrlHandler: null,
    lastCheckedAt: 0,
    pageVersion: '',
    swActivatedHandled: false,
  };

  let postponedMemory = null;

  // ── utils ────────────────────────────────────────────────
  const toast = (msg, type = 'info', duration = 3000) => {
    try {
      if (typeof window.toast === 'function') window.toast(msg, type, duration);
      else console.log('[Folio update]', msg);
    } catch {}
  };

  const haptic = () => { try { navigator.vibrate?.(8); } catch {} };

  function hasReducedMotion() {
    try {
      if (localStorage.getItem('folio.reducedMotion') === 'true') return true;
    } catch {}
    try {
      if (document.documentElement.getAttribute('data-reduced-motion') === 'true') return true;
    } catch {}
    return matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
  }

  function getWorkerVersion(worker, timeoutMs = CFG.versionProbeMs) {
    return new Promise((resolve) => {
      if (!worker) { resolve(''); return; }
      try {
        const mc = new MessageChannel();
        const timer = setTimeout(() => resolve(''), timeoutMs);
        mc.port1.onmessage = (e) => {
          clearTimeout(timer);
          resolve(String(e.data?.version || ''));
        };
        worker.postMessage({ type: 'GET_VERSION' }, [mc.port2]);
      } catch { resolve(''); }
    });
  }

  function readPageVersion() {
    try {
      const m = document.querySelector('meta[name="folio-sw-version"]');
      if (m?.content) return String(m.content);
    } catch {}
    try {
      const cs = document.currentScript;
      if (cs?.dataset?.version) return String(cs.dataset.version);
    } catch {}
    return '';
  }

  function readPostponed() {
    try {
      const raw = sessionStorage.getItem(POSTPONE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version) return parsed;
    } catch {}
    return null;
  }

  function writePostponed(version) {
    if (!version) return;
    postponedMemory = { version, at: Date.now() };
    try { sessionStorage.setItem(POSTPONE_KEY, JSON.stringify(postponedMemory)); } catch {}
  }

  function clearPostponed() {
    postponedMemory = null;
    S.postponedVersion = null;
    try { sessionStorage.removeItem(POSTPONE_KEY); } catch {}
  }

  function hasUnsavedWork() {
    try {
      const ws = window.workspace;
      if (!ws) return false;
      if (ws.dirtyFiles instanceof Set) return ws.dirtyFiles.size > 0;
      return !!ws.dirty;
    } catch { return false; }
  }

  async function confirmDiscard() {
    const opts = {
      title: 'Reload anyway?',
      message: 'You have unsaved changes. Reloading will lose them.',
      confirmLabel: 'Reload',
      danger: true,
    };
    try {
      if (typeof window.confirm === 'function') {
        const r = window.confirm(opts);
        if (r && typeof r.then === 'function') return !!(await r);
        if (typeof r === 'boolean') return r;
      }
    } catch {}
    try { return !!window.confirm(opts.message); } catch { return false; }
  }

  async function isRealUpdate(reg) {
    if (!reg?.waiting) return false;
    if (!navigator.serviceWorker.controller) return false;
    if (reg.waiting === reg.active) return false;

    const [activeVer, waitingVer] = await Promise.all([
      getWorkerVersion(reg.active),
      getWorkerVersion(reg.waiting),
    ]);

    if (activeVer && waitingVer) return activeVer !== waitingVer;
    if (waitingVer && S.pageVersion) return waitingVer !== S.pageVersion;
    // If only the waiting worker responds, treat as real. This unblocks
    // cases where the active worker's message port is stale.
    if (waitingVer && !activeVer) return true;
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // STYLES — KOFA X–style, theme-token aware
  // ═══════════════════════════════════════════════════════════
  function injectStyles() {
    if (S.stylesInjected || document.getElementById('folio-update-style')) {
      S.stylesInjected = true;
      return;
    }

    const css = `
      /* ─── Theme tokens ─────────────────────────────────────── */
      :root {
        --folio-upd-accent: var(--theme-primary, #F59E0B);
        --folio-upd-accent-soft: var(--theme-primary-soft, rgba(245,158,11,0.14));
        --folio-upd-accent-glow: var(--theme-primary-glow, rgba(245,158,11,0.40));
        --folio-upd-accent-hover: var(--theme-primary-hover, #fbbf24);
        --folio-upd-surface: var(--theme-surface, #0f1218);
        --folio-upd-surface-raised: var(--theme-surface-elevated, #1a1f2a);
        --folio-upd-border: var(--theme-glass-border, rgba(255,255,255,0.09));
        --folio-upd-divider: var(--theme-divider, rgba(255,255,255,0.08));
        --folio-upd-text-1: var(--theme-text, #e8ecf1);
        --folio-upd-text-2: var(--theme-text-secondary, rgba(232,236,241,0.72));
        --folio-upd-text-3: var(--theme-text-tertiary, rgba(232,236,241,0.44));
        --folio-upd-on-accent: #0a0c10;
        --folio-upd-overlay: rgba(10, 12, 16, 0.72);
        --folio-upd-font: var(--font, "Inter", -apple-system, system-ui, sans-serif);
        --folio-upd-mono: var(--font-mono, "SF Mono", Consolas, monospace);
      }
      [data-theme="light"] {
        --folio-upd-surface: var(--theme-surface, #ffffff);
        --folio-upd-surface-raised: var(--theme-surface-elevated, #ffffff);
        --folio-upd-border: var(--theme-glass-border, rgba(0,0,0,0.08));
        --folio-upd-divider: var(--theme-divider, rgba(0,0,0,0.06));
        --folio-upd-text-1: var(--theme-text, #121316);
        --folio-upd-text-2: var(--theme-text-secondary, rgba(18,19,22,0.72));
        --folio-upd-text-3: var(--theme-text-tertiary, rgba(18,19,22,0.48));
        --folio-upd-on-accent: #ffffff;
        --folio-upd-overlay: rgba(18, 19, 22, 0.55);
      }

      /* ─── Overlay ──────────────────────────────────────────── */
      .folio-upd {
        position: fixed; inset: 0; z-index: 999991;
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
        background: var(--folio-upd-overlay);
        backdrop-filter: blur(12px) saturate(140%);
        -webkit-backdrop-filter: blur(12px) saturate(140%);
        opacity: 0; pointer-events: none;
        transition: opacity 320ms cubic-bezier(0.16, 1, 0.3, 1);
        font-family: var(--folio-upd-font);
      }
      .folio-upd.open { opacity: 1; pointer-events: auto; }

      /* ─── Card ─────────────────────────────────────────────── */
      .folio-upd-card {
        width: 100%; max-width: 400px;
        background: var(--folio-upd-surface);
        border: 1px solid var(--folio-upd-border);
        border-radius: 28px;
        padding: 32px 28px 28px;
        text-align: center;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
        transform: scale(0.9) translateY(20px);
        transition: transform 500ms cubic-bezier(0.16, 1, 0.3, 1);
        position: relative;
        overflow: hidden;
      }
      .folio-upd.open .folio-upd-card {
        transform: scale(1) translateY(0);
      }

      /* ─── Spinning icon + version badge ────────────────────── */
      .folio-upd-icon {
        position: relative;
        width: 80px; height: 80px;
        margin: 0 auto 16px;
      }
      .folio-upd-spinner {
        width: 100%; height: 100%;
        animation: folioUpdSpin 2s linear infinite;
      }
      .folio-upd-spinner .ring {
        fill: none;
        stroke: var(--folio-upd-accent);
        stroke-width: 2;
        stroke-dasharray: 60 140;
        stroke-linecap: round;
      }
      .folio-upd-spinner .dots {
        fill: none;
        stroke: var(--folio-upd-accent);
        stroke-width: 2.5;
        stroke-linecap: round;
        stroke-dasharray: 6 30;
      }
      @keyframes folioUpdSpin { to { transform: rotate(360deg); } }

      .folio-upd-card.applying .folio-upd-spinner {
        animation-duration: 900ms;
      }

      .folio-upd-badge {
        position: absolute;
        bottom: 0; right: 0;
        background: var(--folio-upd-accent);
        color: var(--folio-upd-on-accent);
        font-family: var(--folio-upd-mono);
        font-size: 9px; font-weight: 800;
        padding: 3px 10px;
        border-radius: 20px;
        border: 2px solid var(--folio-upd-surface);
        letter-spacing: 0.3px;
        max-width: 90%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        line-height: 1.5;
      }

      /* ─── Text ─────────────────────────────────────────────── */
      .folio-upd-title {
        font-size: 20px; font-weight: 800;
        letter-spacing: -0.3px;
        color: var(--folio-upd-text-1);
        margin: 0 0 6px;
        line-height: 1.2;
      }
      .folio-upd-sub {
        font-size: 13px; font-weight: 400;
        color: var(--folio-upd-text-2);
        line-height: 1.5;
        margin: 0 0 22px;
      }

      /* ─── Progress (hidden until apply) ────────────────────── */
      .folio-upd-progress {
        margin: 0 0 20px;
        display: none;
      }
      .folio-upd-progress.visible { display: block; }
      .folio-upd-progress-track {
        width: 100%; height: 4px;
        border-radius: 4px;
        background: var(--folio-upd-divider);
        overflow: hidden;
        margin-bottom: 8px;
      }
      .folio-upd-progress-fill {
        height: 100%; width: 0%;
        background: linear-gradient(90deg,
          var(--folio-upd-accent),
          var(--folio-upd-accent-glow));
        border-radius: 4px;
        transition: width 300ms ease;
      }
      .folio-upd-progress-text {
        font-size: 11px;
        color: var(--folio-upd-text-3);
        font-weight: 600;
        font-family: var(--folio-upd-mono);
      }

      /* ─── Buttons ──────────────────────────────────────────── */
      .folio-upd-actions {
        display: flex;
        gap: 10px;
      }
      .folio-upd-btn {
        flex: 1;
        font-family: inherit;
        font-size: 13px; font-weight: 700;
        padding: 12px 20px;
        border-radius: 14px;
        border: 1px solid var(--folio-upd-border);
        background: var(--folio-upd-surface-raised);
        color: var(--folio-upd-text-2);
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        gap: 6px;
        transition: all 0.2s ease;
        touch-action: manipulation;
        user-select: none;
      }
      .folio-upd-btn:hover:not(:disabled) {
        border-color: var(--folio-upd-accent-glow);
        color: var(--folio-upd-text-1);
      }
      .folio-upd-btn:active:not(:disabled) { transform: scale(0.96); }
      .folio-upd-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .folio-upd-btn:focus-visible {
        outline: 2px solid var(--folio-upd-accent);
        outline-offset: 2px;
      }
      .folio-upd-btn.primary {
        background: var(--folio-upd-accent);
        border-color: var(--folio-upd-accent);
        color: var(--folio-upd-on-accent);
        box-shadow: 0 4px 20px var(--folio-upd-accent-glow);
      }
      .folio-upd-btn.primary:hover:not(:disabled) {
        background: var(--folio-upd-accent-hover);
        border-color: var(--folio-upd-accent-hover);
      }
      .folio-upd-btn svg {
        width: 14px; height: 14px;
        stroke: currentColor; fill: none;
        stroke-width: 2.4;
        stroke-linecap: round; stroke-linejoin: round;
      }

      /* ─── Mobile bottom sheet ──────────────────────────────── */
      @media (max-width: 480px) {
        .folio-upd { align-items: flex-end; padding: 0; }
        .folio-upd-card {
          max-width: 100%;
          border-radius: 28px 28px 0 0;
          border-bottom: none;
          padding: 28px 22px calc(24px + env(safe-area-inset-bottom, 0px));
          transform: translateY(100%);
        }
        .folio-upd.open .folio-upd-card { transform: translateY(0); }
      }

      /* ─── Reload overlay (shown during apply) ──────────────── */
      .folio-reload {
        position: fixed; inset: 0; z-index: 999992;
        display: flex; align-items: center; justify-content: center;
        background: var(--folio-upd-overlay);
        backdrop-filter: blur(28px) saturate(120%);
        -webkit-backdrop-filter: blur(28px) saturate(120%);
        font-family: var(--folio-upd-font);
        color: var(--folio-upd-text-1);
        text-align: center;
        padding: 24px;
        opacity: 0;
        transition: opacity 220ms ease;
      }
      .folio-reload.open { opacity: 1; }
      .folio-reload-inner {
        padding: 32px 28px;
        background: var(--folio-upd-surface);
        border: 1px solid var(--folio-upd-border);
        border-radius: 18px;
        max-width: 300px;
        width: 100%;
      }
      .folio-reload-spinner {
        width: 40px; height: 40px;
        margin: 0 auto 20px;
        position: relative;
      }
      .folio-reload-spinner::before {
        content: '';
        position: absolute; inset: 0;
        border: 1.5px solid var(--folio-upd-divider);
        border-radius: 50%;
      }
      .folio-reload-spinner::after {
        content: '';
        position: absolute; inset: 0;
        border: 1.5px solid transparent;
        border-top-color: var(--folio-upd-accent);
        border-radius: 50%;
        animation: folioReloadSpin 0.95s linear infinite;
      }
      @keyframes folioReloadSpin { to { transform: rotate(360deg); } }
      .folio-reload-title {
        font-size: 15px; font-weight: 600;
        letter-spacing: -0.2px;
        margin: 0 0 4px;
        color: var(--folio-upd-text-1);
      }
      .folio-reload-sub {
        font-size: 12px;
        color: var(--folio-upd-text-2);
        margin: 0 0 20px;
        line-height: 1.5;
      }
      .folio-reload-bar {
        width: 100%; height: 2px;
        background: var(--folio-upd-divider);
        border-radius: 2px;
        overflow: hidden;
      }
      .folio-reload-bar-fill {
        height: 100%; width: 0;
        background: var(--folio-upd-accent);
        border-radius: 2px;
        transition: width 300ms ease;
      }

      /* ─── Reduced motion ───────────────────────────────────── */
      @media (prefers-reduced-motion: reduce) {
        .folio-upd, .folio-upd-card, .folio-upd-btn,
        .folio-upd-progress-fill, .folio-upd-spinner,
        .folio-reload, .folio-reload-spinner::after,
        .folio-reload-bar-fill {
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
        }
        .folio-upd-spinner { animation: none; }
      }
      html[data-reduced-motion="true"] .folio-upd-spinner,
      html[data-reduced-motion="true"] .folio-reload-spinner::after {
        animation: none !important;
      }
    `;
    const s = document.createElement('style');
    s.id = 'folio-update-style';
    s.textContent = css;
    document.head.appendChild(s);
    S.stylesInjected = true;
  }

  // ═══════════════════════════════════════════════════════════
  // DIALOG
  // ═══════════════════════════════════════════════════════════
  function buildDialog() {
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'folio-upd';
    ov.id = 'folio-update-overlay';
    ov.innerHTML = `
      <div class="folio-upd-card" role="dialog" aria-modal="true" aria-labelledby="folio-upd-title">
        <div class="folio-upd-icon" aria-hidden="true">
          <svg class="folio-upd-spinner" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" class="ring"/>
            <path d="M12 2v4M12 22v-4M4.93 4.93l2.83 2.83M19.07 19.07l-2.83-2.83M2 12h4M22 12h-4M4.93 19.07l2.83-2.83M19.07 4.93l-2.83 2.83" class="dots"/>
          </svg>
          <div class="folio-upd-badge" id="folioUpdBadge">new</div>
        </div>

        <h3 class="folio-upd-title" id="folio-upd-title">New version available</h3>
        <p class="folio-upd-sub">A fresh update is ready. Reload to apply it.</p>

        <div class="folio-upd-progress" id="folioUpdProgress">
          <div class="folio-upd-progress-track">
            <div class="folio-upd-progress-fill"></div>
          </div>
          <span class="folio-upd-progress-text">Updating…</span>
        </div>

        <div class="folio-upd-actions">
          <button class="folio-upd-btn" data-folio-upd="later" type="button">Later</button>
          <button class="folio-upd-btn primary" data-folio-upd="apply" type="button">
            <span>Update Now</span>
            <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(ov);

    ov.querySelector('[data-folio-upd="later"]').addEventListener('click', dismiss);
    ov.querySelector('[data-folio-upd="apply"]').addEventListener('click', () => applyNow(false));
    ov.addEventListener('click', (e) => { if (e.target === ov) dismiss(); });

    return ov;
  }

  // ═══════════════════════════════════════════════════════════
  // SHOW / DISMISS
  // ═══════════════════════════════════════════════════════════
  function show(version) {
    if (S.applying || S.dialogEl) return;

    // Same-version-only suppression (was: block all)
    if (version && S.postponedVersion && version === S.postponedVersion) return;

    const ov = buildDialog();
    S.dialogEl = ov;
    S.dialogVersion = version || null;

    // Version badge — short form (last -N segment)
    const badge = ov.querySelector('#folioUpdBadge');
    if (badge) {
      const short = version ? String(version).split('-').pop() : 'new';
      badge.textContent = short.slice(0, 6);
      badge.title = String(version || 'Latest');
    }

    document.body.style.overflow = 'hidden';
    void ov.offsetWidth;
    ov.classList.add('open');

    // KOFA X behaviour: auto-DISMISS (not auto-apply)
    if (S.autoDismissTimer) clearTimeout(S.autoDismissTimer);
    S.autoDismissTimer = setTimeout(() => {
      if (!S.applying) dismiss();
    }, CFG.autoDismissMs);

    try { window.dispatchEvent(new CustomEvent('folio:update:available')); } catch {}
  }

  function dismiss() {
    if (S.autoDismissTimer) {
      clearTimeout(S.autoDismissTimer);
      S.autoDismissTimer = null;
    }
    if (!S.dialogEl) return;

    const waiting = S.reg?.waiting;
    const fallbackVersion = S.dialogVersion || '';

    if (waiting) {
      S.postponedVersion = fallbackVersion || 'pending';
      writePostponed(S.postponedVersion);
    }

    const ov = S.dialogEl;
    S.dialogEl = null;
    ov.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => ov.remove(), 320);

    if (waiting) {
      getWorkerVersion(waiting).then((ver) => {
        if (ver && ver !== S.postponedVersion) {
          S.postponedVersion = ver;
          writePostponed(ver);
        }
      }).catch(() => {});
    }

    if (typeof window.toast === 'function') {
      toast('Update postponed — you\'ll be prompted again when a newer version is ready', 'info', 3200);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PROGRESS
  // ═══════════════════════════════════════════════════════════
  function setProgress(pct) {
    const wrap = S.dialogEl?.querySelector('#folioUpdProgress');
    const fill = S.dialogEl?.querySelector('.folio-upd-progress-fill');
    const text = S.dialogEl?.querySelector('.folio-upd-progress-text');
    if (wrap) wrap.classList.add('visible');
    if (fill) fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
    if (text) {
      text.textContent = pct >= 100 ? '✓ Complete!' : `Updating… ${Math.round(pct)}%`;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // RELOAD OVERLAY
  // ═══════════════════════════════════════════════════════════
  function showReloadOverlay() {
    injectStyles();
    if (document.getElementById('folio-reload-overlay')) return;
    const ov = document.createElement('div');
    ov.id = 'folio-reload-overlay';
    ov.className = 'folio-reload';
    ov.innerHTML = `
      <div class="folio-reload-inner">
        <div class="folio-reload-spinner"></div>
        <div class="folio-reload-title">Applying update</div>
        <div class="folio-reload-sub">Reloading with the new version…</div>
        <div class="folio-reload-bar">
          <div class="folio-reload-bar-fill" id="folioReloadBar"></div>
        </div>
      </div>
    `;
    document.body.appendChild(ov);
    void ov.offsetWidth;
    ov.classList.add('open');

    const bar = ov.querySelector('#folioReloadBar');
    if (bar) {
      let p = 0;
      const iv = setInterval(() => {
        p = Math.min(90, p + Math.random() * 12);
        bar.style.width = p + '%';
        if (p >= 90) clearInterval(iv);
      }, 200);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // APPLY
  // ═══════════════════════════════════════════════════════════
  async function applyNow(fromTimer = false) {
    if (S.applying) return;
    S.applying = true;

    if (S.autoDismissTimer) {
      clearTimeout(S.autoDismissTimer);
      S.autoDismissTimer = null;
    }

    if (hasUnsavedWork()) {
      const ok = await confirmDiscard();
      if (!ok) {
        S.applying = false;
        if (!fromTimer) {
          // Restart the auto-dismiss window
          if (S.autoDismissTimer) clearTimeout(S.autoDismissTimer);
          S.autoDismissTimer = setTimeout(() => {
            if (!S.applying) dismiss();
          }, CFG.autoDismissMs);
        }
        return;
      }
    }

    const card = S.dialogEl?.querySelector('.folio-upd-card');
    if (card) card.classList.add('applying');

    const applyBtn = S.dialogEl?.querySelector('[data-folio-upd="apply"]');
    const laterBtn = S.dialogEl?.querySelector('[data-folio-upd="later"]');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Reloading…'; }
    if (laterBtn) laterBtn.disabled = true;

    setProgress(10);
    haptic();

    const fail = (msg) => {
      S.applying = false;
      if (card) card.classList.remove('applying');
      if (applyBtn) {
        applyBtn.disabled = false;
        applyBtn.innerHTML = '<span>Update Now</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
      }
      if (laterBtn) laterBtn.disabled = false;
      setProgress(0);
      if (msg) toast(msg, 'error', 4200);
    };

    try {
      const reg = S.reg || await navigator.serviceWorker.getRegistration();
      if (!reg) throw new Error('No service worker registration');
      S.reg = reg;

      if (!reg.waiting) {
        await reg.update();
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
        if (S.safetyTimer) { clearTimeout(S.safetyTimer); S.safetyTimer = null; }
        if (S.onCtrlHandler) {
          navigator.serviceWorker.removeEventListener('controllerchange', S.onCtrlHandler);
          S.onCtrlHandler = null;
        }

        // ✅ FIX: guard against `controllerchange` from *other* tabs.
        // Without this, `clients.claim()` in activate fires the event in
        // every open tab → all tabs reload → nothing updates.
        S.onCtrlHandler = () => {
          if (!S.applying) return;
          if (S.safetyTimer) { clearTimeout(S.safetyTimer); S.safetyTimer = null; }
          navigator.serviceWorker.removeEventListener('controllerchange', S.onCtrlHandler);
          S.onCtrlHandler = null;
          setProgress(100);
          showReloadOverlay();
          try { window.dispatchEvent(new CustomEvent('folio:update:applied')); } catch {}
          clearPostponed();
          setTimeout(() => location.reload(), CFG.reloadDelayMs);
        };

        // ✅ FIX: listener attached BEFORE postMessage.
        navigator.serviceWorker.addEventListener('controllerchange', S.onCtrlHandler);

        setProgress(75);
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });

        S.safetyTimer = setTimeout(() => {
          S.safetyTimer = null;
          setProgress(100);
          showReloadOverlay();
          try { window.dispatchEvent(new CustomEvent('folio:update:applied')); } catch {}
          clearPostponed();
          location.reload();
        }, CFG.controllerTimeoutMs);
      } else {
        S.applying = false;
        if (card) card.classList.remove('applying');
        if (applyBtn) {
          applyBtn.disabled = false;
          applyBtn.textContent = 'Check again';
        }
        if (laterBtn) laterBtn.disabled = false;
        setProgress(0);
        toast('You\'re already on the latest version', 'info', 3000);
      }
    } catch (err) {
      console.warn('[Folio update] apply failed:', err);
      fail('Update failed — try again later');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CHECKS
  // ═══════════════════════════════════════════════════════════
  async function checkNow(force = false) {
    if (S.paused || S.applying || S.dialogEl) return;
    if (!force && Date.now() - S.lastCheckedAt < CFG.minCheckGapMs) return;
    S.lastCheckedAt = Date.now();

    try {
      const reg = S.reg || await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      S.reg = reg;

      if (!reg.waiting && !reg.installing) {
        try { await reg.update(); } catch {}
      }

      if (!reg.waiting) return;
      if (!(await isRealUpdate(reg))) return;

      let version = await getWorkerVersion(reg.waiting);
      if (!version) version = S.postponedVersion || '';

      // Only suppress the exact postponed version
      if (version && S.postponedVersion && version === S.postponedVersion) return;

      show(version || null);
    } catch (err) {
      console.warn('[Folio update] check failed:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════
  async function init() {
    if (S.initialized || !('serviceWorker' in navigator)) return;
    S.initialized = true;
    S.pageVersion = readPageVersion();

    try {
      S.reg = await navigator.serviceWorker.getRegistration();
      if (!S.reg) return;

      const postponed = readPostponed();
      if (postponed) S.postponedVersion = postponed.version;

      // ✅ Moved here from index.html/settings.html: reload once on the
      // very first SW activation so the controller takes over and the
      // current page gets cached on the *first* visit (not the second).
      navigator.serviceWorker.addEventListener('message', (event) => {
        const d = event.data || {};
        if (d.type === 'SW_ACTIVATED') {
          if (S.swActivatedHandled) return;
          S.swActivatedHandled = true;
          if (S.applying) return;
          if (navigator.serviceWorker.controller) return;
          let shown = false;
          try { shown = sessionStorage.getItem(FIRST_ACTIVATE_KEY) === '1'; } catch {}
          if (shown) return;
          try { sessionStorage.setItem(FIRST_ACTIVATE_KEY, '1'); } catch {}
          // Defer so any other load work finishes first
          setTimeout(() => {
            if (!hasUnsavedWork()) location.reload();
          }, 600);
        }
        if (d.type === 'SW_UPDATE_AVAILABLE' || d.type === 'UPDATE_AVAILABLE') {
          (async () => {
            const reg = await navigator.serviceWorker.getRegistration();
            if (!(await isRealUpdate(reg))) return;
            const ver = String(d.version || '');
            if (ver && S.postponedVersion && ver === S.postponedVersion) return;
            show(ver || null);
          })().catch(() => {});
        }
      });

      if (S.checkTimer) clearInterval(S.checkTimer);
      S.checkTimer = setInterval(() => checkNow(), CFG.checkIntervalMs);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkNow();
      });
      window.addEventListener('online', () => checkNow());

      setTimeout(() => checkNow(true), CFG.autoShowDelayMs);
    } catch (err) {
      console.warn('[Folio update] init error:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════
  window.FOLIO = window.FOLIO || {};
  window.FOLIO.update = {
    check: () => checkNow(true),
    applyNow: () => applyNow(false),
    pause() {
      S.paused = true;
      if (S.checkTimer) { clearInterval(S.checkTimer); S.checkTimer = null; }
      if (S.autoDismissTimer) { clearTimeout(S.autoDismissTimer); S.autoDismissTimer = null; }
    },
    resume() {
      S.paused = false;
      if (S.applying) return;
      setTimeout(() => checkNow(true), 800);
    },
    isPaused: () => S.paused,
    _state: S,
    _config: CFG,
  };

  window.__updateManager = window.FOLIO.update;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();