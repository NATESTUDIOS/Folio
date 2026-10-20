/* ============================================================
   Folio — update.js
   Service worker update prompt + apply.
   DESIGN: flat glass / translucent, no shadows, hairline borders.

   Usage:
     <script src="/update.js" defer></script>

   API:
     FOLIO.update.check()
     FOLIO.update.applyNow()
     FOLIO.update.pause()
     FOLIO.update.resume()
     FOLIO.update.isPaused()

   Events:
     folio:update:available
     folio:update:applied
   ============================================================ */
(function () {
  'use strict';

  const CFG = {
    checkIntervalMs: 5 * 60 * 1000,
    minCheckGapMs: 30 * 1000,
    autoApplyMs: 30 * 1000,
    reloadDelayMs: 700,
    controllerTimeoutMs: 4000,
    waitingPollTimeoutMs: 5000,
    versionProbeMs: 2500,
  };

  const POSTPONE_KEY = 'folio.upd.postponed';

  const S = {
    reg: null,
    dialogEl: null,
    dialogVersion: null,
    countdownRaf: null,
    countdownStartAt: 0,
    applying: false,
    paused: false,
    postponed: false,
    postponedVersion: null,
    stylesInjected: false,
    initialized: false,
    checkTimer: null,
    safetyTimer: null,
    onCtrlHandler: null,
    reducedMotion: false,
    lastCheckedAt: 0,
    pageVersion: '',
  };

  let postponedMemory = null;

  // ── utils ────────────────────────────────────────────────
  const toast = (msg, type = 'info', duration = 3000) => {
    try {
      if (typeof window.toast === 'function') window.toast(msg, type, duration);
      else console.log('[Folio update]', msg);
    } catch {}
  };

  function hasReducedMotion() {
    try {
      if (localStorage.getItem('folio.reducedMotion') === 'true') return true;
    } catch {}
    try {
      if (document.documentElement.getAttribute('data-reduced-motion') === 'true') return true;
    } catch {}
    return matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
  }

  function fmtSeconds(ms) { return Math.max(0, Math.ceil(ms / 1000)); }

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
    try {
      const all = document.querySelectorAll('script[data-version]');
      for (const s of all) {
        if ((s.src || '').includes('update.js')) return String(s.dataset.version || '');
      }
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
    try { sessionStorage.removeItem(POSTPONE_KEY); } catch {}
  }

  function hasPostponed() {
    if (postponedMemory) return true;
    return !!readPostponed();
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
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // STYLES — flat glass, no shadows, hairline borders
  // ═══════════════════════════════════════════════════════════
  function injectStyles() {
    if (S.stylesInjected || document.getElementById('folio-update-style')) {
      S.stylesInjected = true;
      return;
    }

    const css = `
      /* ─── Overlay ─────────────────────────────────────── */
      .folio-upd {
        position: fixed; inset: 0; z-index: 999991;
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
        background: rgba(6, 8, 12, 0.35);
        backdrop-filter: blur(24px) saturate(120%);
        -webkit-backdrop-filter: blur(24px) saturate(120%);
        opacity: 0; pointer-events: none;
        transition: opacity 200ms ease;
        font-family: var(--font, "Inter", -apple-system, system-ui, sans-serif);
      }
      .folio-upd.open { opacity: 1; pointer-events: auto; }

      /* ─── Card: frosted translucent panel ─────────────── */
      .folio-upd-card {
        width: 100%; max-width: 380px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 20px;
        padding: 24px 20px 18px;
        text-align: center;
        position: relative;
        overflow: hidden;
        backdrop-filter: blur(20px) saturate(140%);
        -webkit-backdrop-filter: blur(20px) saturate(140%);
        transform: translateY(10px) scale(0.98);
        opacity: 0;
        transition:
          transform 260ms cubic-bezier(0.16, 1, 0.3, 1),
          opacity 260ms ease;
      }
      .folio-upd.open .folio-upd-card {
        transform: translateY(0) scale(1);
        opacity: 1;
      }

      /* Thin accent line at top of card — the only "decoration" */
      .folio-upd-card::before {
        content: '';
        position: absolute;
        top: 0; left: 50%;
        transform: translateX(-50%);
        width: 44px; height: 2px;
        background: rgba(245, 158, 11, 0.55);
        border-radius: 0 0 2px 2px;
      }

      /* ─── Icon: flat outlined circle ──────────────────── */
      .folio-upd-icon {
        width: 48px; height: 48px;
        margin: 6px auto 16px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.04);
        display: flex; align-items: center; justify-content: center;
        color: rgba(245, 158, 11, 0.9);
        position: relative;
      }
      .folio-upd-icon svg {
        width: 22px; height: 22px;
        stroke: currentColor; fill: none;
        stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
      }

      /* Applying: slow rotate, no glow */
      .folio-upd-card.applying .folio-upd-icon svg {
        animation: folioSpin 1.6s linear infinite;
      }
      @keyframes folioSpin { to { transform: rotate(360deg); } }

      /* ─── Typography ──────────────────────────────────── */
      .folio-upd-title {
        font-size: 17px; font-weight: 650; letter-spacing: -0.2px;
        color: #f1f5f9; margin: 0 0 6px;
      }
      .folio-upd-sub {
        font-size: 12.5px; line-height: 1.55;
        color: rgba(241, 245, 249, 0.55);
        margin: 0 0 20px;
        max-width: 300px; margin-left: auto; margin-right: auto;
      }

      /* ─── Countdown strip ─────────────────────────────── */
      .folio-upd-countdown {
        display: flex; align-items: center; gap: 12px;
        padding: 11px 12px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        margin: 0 0 16px;
        text-align: left;
        transition: opacity 200ms ease, transform 200ms ease;
      }
      .folio-upd-countdown-ring {
        flex-shrink: 0;
        width: 34px; height: 34px;
        position: relative;
      }
      .folio-upd-countdown-ring svg {
        width: 34px; height: 34px;
        transform: rotate(-90deg);
        overflow: visible;
      }
      .folio-upd-countdown-ring circle {
        fill: none;
        stroke-width: 1.5;
        stroke-linecap: round;
      }
      .folio-upd-countdown-ring .track {
        stroke: rgba(255, 255, 255, 0.08);
      }
      .folio-upd-countdown-ring .progress {
        stroke: rgba(245, 158, 11, 0.85);
        transition: stroke-dashoffset 100ms linear, stroke 300ms ease;
      }
      .folio-upd-countdown-text {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 11px; font-weight: 600;
        color: rgba(245, 158, 11, 0.95);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.3px;
        transition: color 250ms ease;
      }
      .folio-upd-countdown-info {
        flex: 1; min-width: 0;
      }
      .folio-upd-countdown-info-title {
        font-size: 12px; font-weight: 600;
        color: rgba(241, 245, 249, 0.9);
        margin-bottom: 1px;
      }
      .folio-upd-countdown-info-desc {
        font-size: 10.5px;
        color: rgba(241, 245, 249, 0.45);
        line-height: 1.4;
      }

      /* ─── Progress bar (apply phase) ──────────────────── */
      .folio-upd-progress {
        height: 2px; border-radius: 2px;
        background: rgba(255, 255, 255, 0.06);
        overflow: hidden;
        margin: 0 0 16px;
        display: none;
      }
      .folio-upd-progress.visible { display: block; }
      .folio-upd-progress-fill {
        height: 100%; width: 0;
        background: rgba(245, 158, 11, 0.85);
        transition: width 280ms cubic-bezier(0.16, 1, 0.3, 1);
      }

      /* ─── Buttons: flat, ghosted, hairline ────────────── */
      .folio-upd-actions {
        display: flex; gap: 8px;
      }
      .folio-upd-btn {
        flex: 1;
        font-family: inherit;
        font-size: 13px; font-weight: 600;
        padding: 11px 14px;
        border-radius: 11px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.03);
        color: rgba(241, 245, 249, 0.85);
        cursor: pointer;
        transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
        touch-action: manipulation;
        user-select: none;
      }
      .folio-upd-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.07);
        border-color: rgba(255, 255, 255, 0.18);
        color: #f1f5f9;
      }
      .folio-upd-btn:active:not(:disabled) {
        background: rgba(255, 255, 255, 0.10);
      }
      .folio-upd-btn:focus-visible {
        outline: 1.5px solid rgba(245, 158, 11, 0.6);
        outline-offset: 2px;
      }
      .folio-upd-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      /* Primary = filled accent, no shadow */
      .folio-upd-btn.primary {
        background: rgba(245, 158, 11, 0.9);
        border-color: rgba(245, 158, 11, 0.9);
        color: #0a0c10;
      }
      .folio-upd-btn.primary:hover:not(:disabled) {
        background: rgba(251, 191, 36, 0.95);
        border-color: rgba(251, 191, 36, 0.95);
        color: #0a0c10;
      }
      .folio-upd-btn.primary:active:not(:disabled) {
        background: rgba(245, 158, 11, 1);
      }

      /* ─── Reload overlay: same glass language ─────────── */
      .folio-reload {
        position: fixed; inset: 0; z-index: 999992;
        display: flex; align-items: center; justify-content: center;
        background: rgba(6, 8, 12, 0.55);
        backdrop-filter: blur(28px) saturate(120%);
        -webkit-backdrop-filter: blur(28px) saturate(120%);
        font-family: var(--font, "Inter", system-ui, sans-serif);
        color: #f1f5f9;
        text-align: center;
        padding: 24px;
        opacity: 0;
        transition: opacity 220ms ease;
      }
      .folio-reload.open { opacity: 1; }
      .folio-reload-inner {
        padding: 32px 28px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.10);
        border-radius: 18px;
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
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
        border: 1.5px solid rgba(255, 255, 255, 0.10);
        border-radius: 50%;
      }
      .folio-reload-spinner::after {
        content: '';
        position: absolute; inset: 0;
        border: 1.5px solid transparent;
        border-top-color: rgba(245, 158, 11, 0.9);
        border-radius: 50%;
        animation: folioReloadSpin 0.95s linear infinite;
      }
      @keyframes folioReloadSpin { to { transform: rotate(360deg); } }

      .folio-reload-title {
        font-size: 15px; font-weight: 600;
        letter-spacing: -0.2px;
        margin: 0 0 4px;
        color: #f1f5f9;
      }
      .folio-reload-sub {
        font-size: 12px;
        color: rgba(241, 245, 249, 0.5);
        margin: 0 0 20px;
        line-height: 1.5;
      }
      .folio-reload-bar {
        width: 100%; height: 2px;
        background: rgba(255, 255, 255, 0.06);
        border-radius: 2px;
        overflow: hidden;
      }
      .folio-reload-bar-fill {
        height: 100%; width: 0;
        background: rgba(245, 158, 11, 0.85);
        border-radius: 2px;
        transition: width 300ms ease;
      }

      /* ─── Mobile: bottom sheet ────────────────────────── */
      @media (max-width: 480px) {
        .folio-upd { align-items: flex-end; padding: 0; }
        .folio-upd-card {
          max-width: 100%;
          border-radius: 20px 20px 0 0;
          border-bottom: none;
          padding: 22px 18px calc(18px + env(safe-area-inset-bottom, 0px));
          transform: translateY(100%);
        }
        .folio-upd.open .folio-upd-card {
          transform: translateY(0);
        }
        .folio-upd-card::before {
          width: 36px; height: 3px;
          top: 8px;
          background: rgba(255, 255, 255, 0.18);
          border-radius: 3px;
        }
        .folio-upd-card::after {
          content: none;
        }
      }

      /* ─── Reduced motion ──────────────────────────────── */
      @media (prefers-reduced-motion: reduce) {
        .folio-upd,
        .folio-upd-card,
        .folio-upd-countdown,
        .folio-upd-countdown-ring .progress,
        .folio-upd-btn,
        .folio-upd-progress-fill,
        .folio-upd-card.applying .folio-upd-icon svg,
        .folio-reload,
        .folio-reload-spinner::after,
        .folio-reload-bar-fill {
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
        }
      }
      html[data-reduced-motion="true"] .folio-upd-card.applying .folio-upd-icon svg,
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
  const RING_R = 15.5;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

  function buildDialog() {
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'folio-upd';
    ov.id = 'folio-update-overlay';
    ov.innerHTML = `
      <div class="folio-upd-card" role="dialog" aria-modal="true" aria-labelledby="folio-upd-title">
        <div class="folio-upd-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </div>
        <h3 class="folio-upd-title" id="folio-upd-title">Update available</h3>
        <p class="folio-upd-sub">A new version of Folio is ready. Reload to apply it.</p>

        <div class="folio-upd-countdown" id="folioUpdCountdown">
          <div class="folio-upd-countdown-ring" aria-hidden="true">
            <svg viewBox="0 0 40 40">
              <circle class="track" cx="20" cy="20" r="${RING_R}"></circle>
              <circle class="progress" cx="20" cy="20" r="${RING_R}"
                      stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(2)}"
                      stroke-dashoffset="0"></circle>
            </svg>
            <div class="folio-upd-countdown-text" id="folioUpdCountdownText">30</div>
          </div>
          <div class="folio-upd-countdown-info">
            <div class="folio-upd-countdown-info-title">Auto-reloading</div>
            <div class="folio-upd-countdown-info-desc">Cancel to stay on this version</div>
          </div>
        </div>

        <div class="folio-upd-progress" id="folioUpdProgress">
          <div class="folio-upd-progress-fill"></div>
        </div>

        <div class="folio-upd-actions">
          <button class="folio-upd-btn" data-folio-upd="later" type="button">Later</button>
          <button class="folio-upd-btn primary" data-folio-upd="apply" type="button">Reload now</button>
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
  // COUNTDOWN
  // ═══════════════════════════════════════════════════════════
  function startCountdown() {
    const text = S.dialogEl?.querySelector('#folioUpdCountdownText');
    const ring = S.dialogEl?.querySelector('.folio-upd-countdown-ring .progress');
    if (!text || !ring) return;

    S.countdownStartAt = Date.now();

    const tick = () => {
      if (!S.dialogEl || S.applying) return;
      const elapsed = Date.now() - S.countdownStartAt;
      const remaining = Math.max(0, CFG.autoApplyMs - elapsed);
      const remainingSec = Math.ceil(remaining / 1000);

      text.textContent = String(remainingSec);

      const pct = Math.min(1, elapsed / CFG.autoApplyMs);
      ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * pct);

      if (remainingSec <= 5 && remainingSec > 0) {
        text.style.color = 'rgba(248, 113, 113, 0.95)';
        ring.style.stroke = 'rgba(248, 113, 113, 0.85)';
      } else {
        text.style.color = 'rgba(245, 158, 11, 0.95)';
        ring.style.stroke = 'rgba(245, 158, 11, 0.85)';
      }

      if (remaining <= 0) { applyNow(true); return; }
      S.countdownRaf = requestAnimationFrame(tick);
    };

    text.textContent = String(fmtSeconds(CFG.autoApplyMs));
    ring.style.strokeDashoffset = '0';
    S.countdownRaf = requestAnimationFrame(tick);
  }

  function stopCountdown() {
    if (S.countdownRaf) {
      cancelAnimationFrame(S.countdownRaf);
      S.countdownRaf = null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SHOW / DISMISS
  // ═══════════════════════════════════════════════════════════
  function show(version) {
    if (S.applying || S.dialogEl) return;
    if (version && S.postponedVersion === version) return;
    if (hasPostponed()) return;

    const ov = buildDialog();
    S.dialogEl = ov;
    S.dialogVersion = version || null;
    document.body.style.overflow = 'hidden';
    void ov.offsetWidth;
    ov.classList.add('open');

    setTimeout(() => startCountdown(), 60);
    try { window.dispatchEvent(new CustomEvent('folio:update:available')); } catch {}
  }

  function dismiss() {
    stopCountdown();
    if (!S.dialogEl) return;

    const waiting = S.reg?.waiting;
    const fallbackVersion = S.dialogVersion || '';

    if (waiting) {
      S.postponed = true;
      S.postponedVersion = fallbackVersion || 'pending';
      writePostponed(S.postponedVersion);
    }

    const ov = S.dialogEl;
    S.dialogEl = null;
    ov.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => ov.remove(), 260);

    if (waiting) {
      getWorkerVersion(waiting).then((ver) => {
        if (ver && ver !== S.postponedVersion) {
          S.postponedVersion = ver;
          writePostponed(ver);
        }
      }).catch(() => {});
    }

    if (typeof window.toast === 'function') {
      toast('Update postponed — you can update from Settings', 'info', 3000);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PROGRESS
  // ═══════════════════════════════════════════════════════════
  function setProgress(pct) {
    const wrap = S.dialogEl?.querySelector('#folioUpdProgress');
    const fill = S.dialogEl?.querySelector('.folio-upd-progress-fill');
    if (wrap) wrap.classList.add('visible');
    if (fill) fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  function hideCountdown() {
    const cd = S.dialogEl?.querySelector('#folioUpdCountdown');
    if (cd) {
      cd.style.opacity = '0';
      cd.style.transform = 'translateY(-4px)';
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
  async function applyNow(fromCountdown = false) {
    if (S.applying) return;
    S.applying = true;
    stopCountdown();

    if (hasUnsavedWork() && !fromCountdown) {
      const ok = await confirmDiscard();
      if (!ok) {
        S.applying = false;
        const card = S.dialogEl?.querySelector('.folio-upd-card');
        if (card) card.classList.remove('applying');
        startCountdown();
        return;
      }
    }
    if (hasUnsavedWork() && fromCountdown) {
      S.applying = false;
      dismiss();
      return;
    }

    const card = S.dialogEl?.querySelector('.folio-upd-card');
    if (card) card.classList.add('applying');
    hideCountdown();

    const applyBtn = S.dialogEl?.querySelector('[data-folio-upd="apply"]');
    const laterBtn = S.dialogEl?.querySelector('[data-folio-upd="later"]');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Reloading…'; }
    if (laterBtn) laterBtn.disabled = true;

    setProgress(10);

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

        S.onCtrlHandler = () => {
          if (S.safetyTimer) { clearTimeout(S.safetyTimer); S.safetyTimer = null; }
          navigator.serviceWorker.removeEventListener('controllerchange', S.onCtrlHandler);
          S.onCtrlHandler = null;
          setProgress(100);
          showReloadOverlay();
          try { window.dispatchEvent(new CustomEvent('folio:update:applied')); } catch {}
          clearPostponed();
          setTimeout(() => location.reload(), CFG.reloadDelayMs);
        };
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
        setProgress(100);
        showReloadOverlay();
        clearPostponed();
        setTimeout(() => location.reload(), CFG.reloadDelayMs);
      }
    } catch (err) {
      console.warn('[Folio update] apply failed:', err);
      S.applying = false;
      if (card) card.classList.remove('applying');
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Reload now'; }
      if (laterBtn) laterBtn.disabled = false;
      setProgress(0);
      toast('Update failed — try again later', 'error', 4000);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CHECKS
  // ═══════════════════════════════════════════════════════════
  async function checkNow(force = false) {
    if (S.paused || S.applying || S.dialogEl) return;
    if (hasPostponed()) return;
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

      if (hasPostponed()) {
        const waitingVer = version || S.postponedVersion;
        if (!waitingVer || !S.postponedVersion || waitingVer === S.postponedVersion) {
          return;
        }
      }
      if (version && S.postponedVersion === version) return;

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
    S.reducedMotion = hasReducedMotion();
    S.pageVersion = readPageVersion();

    try {
      S.reg = await navigator.serviceWorker.getRegistration();
      if (!S.reg) return;

      const postponed = readPostponed();
      if (postponed) {
        S.postponed = true;
        S.postponedVersion = postponed.version;
      }

      navigator.serviceWorker.addEventListener('message', async (event) => {
        const d = event.data || {};
        if (d.type !== 'SW_UPDATE_AVAILABLE' && d.type !== 'UPDATE_AVAILABLE') return;
        if (hasPostponed()) return;

        const reg = await navigator.serviceWorker.getRegistration();
        if (!(await isRealUpdate(reg))) return;

        const ver = String(d.version || d.builtAt || '');
        if (ver && S.postponedVersion === ver) return;

        show(ver || null);
      });

      if (S.checkTimer) clearInterval(S.checkTimer);
      S.checkTimer = setInterval(() => checkNow(), CFG.checkIntervalMs);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkNow();
      });
      window.addEventListener('online', () => checkNow());

      await checkNow(true);
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
      stopCountdown();
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