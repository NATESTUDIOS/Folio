/* ============================================================
   Folio — update.js
   Service worker update prompt + apply.

   Behavior:
     • When a new SW is waiting AND its version differs from the
       active worker (or the page's baked-in version), shows a
       beautifully animated dialog.
     • A visible countdown auto-applies the update after N seconds.
     • User can "Update now" to skip the countdown.
     • User can "Later" to postpone (respects unsaved work).
     • Reload overlay with progress bar + shimmer during apply.

   Usage:
     <script src="/update.js" data-version="2026-10-19-5" defer></script>
     <!-- OR bake it into the page: -->
     <meta name="folio-sw-version" content="2026-10-19-5">

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

  // ═══════════════════════════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════════════════════════

  const CFG = {
    checkIntervalMs: 5 * 60 * 1000,      // poll every 5 min
    minCheckGapMs: 30 * 1000,            // don't re-check within 30s
    autoApplyMs: 30 * 1000,              // auto-apply after 30s
    reloadDelayMs: 700,                  // brief pause before reload
    controllerTimeoutMs: 4000,           // safety net for SKIP_WAITING
    waitingPollTimeoutMs: 5000,          // wait for a waiting worker
    versionProbeMs: 2500,                // GET_VERSION timeout
    countdownTickMs: 100,                // countdown update interval
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

  // In-memory postpone survives storage failures (private mode, iframes, etc.)
  let postponedMemory = null;

  // ═══════════════════════════════════════════════════════════
  // UTILS
  // ═══════════════════════════════════════════════════════════

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

  function fmtSeconds(ms) {
    return Math.max(0, Math.ceil(ms / 1000));
  }

  /* Ask a specific service-worker instance for its CACHE_VERSION. */
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
      } catch {
        resolve('');
      }
    });
  }

  /* Read the page's baked-in SW version (meta tag or script attribute). */
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

  /* Persist postpone across page reloads within the same tab session. */
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
    try {
      sessionStorage.setItem(
        POSTPONE_KEY,
        JSON.stringify(postponedMemory)
      );
    } catch {}
  }

  function clearPostponed() {
    postponedMemory = null;
    try { sessionStorage.removeItem(POSTPONE_KEY); } catch {}
  }

  /* Synchronous postpone gate — survives storage failure via memory. */
  function hasPostponed() {
    if (postponedMemory) return true;
    return !!readPostponed();
  }

  /* Unsaved-work guard */
  function hasUnsavedWork() {
    try {
      const ws = window.workspace;
      if (!ws) return false;
      if (ws.dirtyFiles instanceof Set) return ws.dirtyFiles.size > 0;
      return !!ws.dirty;
    } catch { return false; }
  }

  /* Confirm wrapper — handles both editor's Promise confirm + native */
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
    try {
      return !!window.confirm(opts.message);
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // REAL-UPDATE DETECTION
  // ═══════════════════════════════════════════════════════════

  async function isRealUpdate(reg) {
    if (!reg?.waiting) return false;
    if (!navigator.serviceWorker.controller) return false;
    if (reg.waiting === reg.active) return false;

    const [activeVer, waitingVer] = await Promise.all([
      getWorkerVersion(reg.active),
      getWorkerVersion(reg.waiting),
    ]);

    if (activeVer && waitingVer) {
      return activeVer !== waitingVer;
    }

    if (waitingVer && S.pageVersion) {
      return waitingVer !== S.pageVersion;
    }

    // Unverifiable — trust the fact that there's a controller and a
    // distinct waiting worker, but only if we've never postponed this run.
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════

  function injectStyles() {
    if (S.stylesInjected || document.getElementById('folio-update-style')) {
      S.stylesInjected = true;
      return;
    }

    const css = `
      .folio-upd {
        position: fixed; inset: 0; z-index: 999991;
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
        background:
          radial-gradient(ellipse at 50% 0%, rgba(245,158,11,0.08), transparent 55%),
          radial-gradient(ellipse at 80% 100%, rgba(139,92,246,0.07), transparent 55%),
          rgba(6, 8, 12, 0.72);
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        opacity: 0; pointer-events: none;
        transition: opacity 260ms cubic-bezier(0.16, 1, 0.3, 1);
        font-family: var(--font, "Inter", -apple-system, system-ui, sans-serif);
      }
      .folio-upd.open { opacity: 1; pointer-events: auto; }

      .folio-upd-card {
        width: 100%; max-width: 400px;
        background:
          linear-gradient(180deg,
            rgba(28, 33, 45, 0.98) 0%,
            rgba(18, 22, 30, 0.98) 100%);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 24px;
        padding: 28px 22px 20px;
        text-align: center;
        transform: scale(0.92) translateY(18px);
        transition:
          transform 340ms cubic-bezier(0.16, 1, 0.3, 1),
          box-shadow 340ms ease;
        position: relative;
        overflow: hidden;
        box-shadow:
          0 0 0 1px rgba(255,255,255,0.04),
          0 24px 60px -12px rgba(0,0,0,0.7),
          0 0 80px -20px rgba(245,158,11,0.18);
      }
      .folio-upd.open .folio-upd-card {
        transform: scale(1) translateY(0);
      }

      /* Aurora wash at the top of the card */
      .folio-upd-aurora {
        position: absolute;
        inset: -50% -30% auto -30%;
        height: 220px;
        background:
          radial-gradient(closest-side at 30% 50%, rgba(245,158,11,0.35), transparent 70%),
          radial-gradient(closest-side at 70% 50%, rgba(139,92,246,0.28), transparent 70%),
          radial-gradient(closest-side at 50% 100%, rgba(56,189,248,0.20), transparent 70%);
        filter: blur(24px);
        opacity: 0.85;
        pointer-events: none;
        animation: folioAurora 8s ease-in-out infinite alternate;
      }
      @keyframes folioAurora {
        0%   { transform: translateX(-8%) scale(1);   opacity: 0.7; }
        100% { transform: translateX(8%) scale(1.06); opacity: 0.95; }
      }

      /* Fine grid texture overlay */
      .folio-upd-grid {
        position: absolute; inset: 0;
        background-image:
          linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
        background-size: 22px 22px;
        mask-image: radial-gradient(ellipse at 50% 0%, black, transparent 70%);
        -webkit-mask-image: radial-gradient(ellipse at 50% 0%, black, transparent 70%);
        pointer-events: none;
        opacity: 0.5;
      }

      .folio-upd-icon-wrap {
        position: relative;
        width: 76px; height: 76px;
        margin: 0 auto 18px;
        z-index: 1;
      }
      .folio-upd-icon-glow {
        position: absolute; inset: -14px;
        background: radial-gradient(circle, rgba(245,158,11,0.35), transparent 65%);
        filter: blur(8px);
        animation: folioPulse 3.4s ease-in-out infinite;
        pointer-events: none;
      }
      @keyframes folioPulse {
        0%, 100% { opacity: 0.55; transform: scale(0.95); }
        50%      { opacity: 1;    transform: scale(1.08); }
      }
      .folio-upd-icon {
        position: relative;
        width: 76px; height: 76px;
        border-radius: 22px;
        background:
          linear-gradient(145deg, rgba(245,158,11,0.24), rgba(249,115,22,0.12));
        border: 1px solid rgba(245,158,11,0.38);
        display: flex; align-items: center; justify-content: center;
        color: #FBBF24;
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.1),
          0 8px 24px -8px rgba(245,158,11,0.4);
      }
      .folio-upd-icon::after {
        content: '';
        position: absolute;
        inset: -8px;
        border-radius: 30px;
        border: 1px dashed rgba(245,158,11,0.28);
        animation: folioOrbit 12s linear infinite;
        pointer-events: none;
      }
      .folio-upd-icon::before {
        content: '';
        position: absolute;
        inset: -16px;
        border-radius: 38px;
        border: 1px solid rgba(245,158,11,0.10);
        animation: folioOrbit 20s linear infinite reverse;
        pointer-events: none;
      }
      @keyframes folioOrbit {
        to { transform: rotate(360deg); }
      }

      .folio-upd-icon svg {
        width: 32px; height: 32px;
        stroke: currentColor; fill: none;
        stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round;
        filter: drop-shadow(0 0 8px rgba(245,158,11,0.5));
      }

      .folio-upd-card.applying .folio-upd-icon svg {
        animation: folioSpin 1.4s cubic-bezier(0.5, 0.1, 0.5, 0.9) infinite;
      }
      .folio-upd-card.applying .folio-upd-icon::after,
      .folio-upd-card.applying .folio-upd-icon::before {
        animation-duration: 2s;
        border-color: rgba(245,158,11,0.5);
      }
      @keyframes folioSpin { to { transform: rotate(360deg); } }

      .folio-upd-title {
        font-size: 19px; font-weight: 800; letter-spacing: -0.4px;
        color: #f1f5f9; margin: 0 0 6px;
        position: relative; z-index: 1;
      }
      .folio-upd-title span {
        background: linear-gradient(90deg, #fbbf24, #f59e0b, #fbbf24);
        background-size: 200% 100%;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        animation: folioShine 3s ease-in-out infinite;
      }
      @keyframes folioShine {
        0%, 100% { background-position: 0% 50%; }
        50%      { background-position: 100% 50%; }
      }
      .folio-upd-sub {
        font-size: 13px; line-height: 1.55;
        color: #94a3b8; margin: 0 0 18px;
        position: relative; z-index: 1;
      }

      /* Countdown block */
      .folio-upd-countdown {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 14px;
        margin: 0 0 16px;
        position: relative;
        z-index: 1;
        overflow: hidden;
        transition: opacity 220ms ease, transform 220ms ease;
      }
      .folio-upd-countdown::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg,
          transparent,
          rgba(245,158,11,0.08),
          transparent);
        transform: translateX(-100%);
        animation: folioSweep 3s ease-in-out infinite;
        pointer-events: none;
      }
      @keyframes folioSweep {
        0%   { transform: translateX(-100%); }
        100% { transform: translateX(100%); }
      }
      .folio-upd-countdown-ring {
        flex-shrink: 0;
        width: 40px; height: 40px;
        position: relative;
      }
      .folio-upd-countdown-ring svg {
        width: 40px; height: 40px;
        transform: rotate(-90deg);
      }
      .folio-upd-countdown-ring svg circle {
        fill: none;
        stroke-width: 3;
        stroke-linecap: round;
      }
      .folio-upd-countdown-ring .track {
        stroke: rgba(255,255,255,0.08);
      }
      .folio-upd-countdown-ring .progress {
        stroke: #FBBF24;
        transition: stroke-dashoffset 100ms linear, stroke 300ms ease;
        filter: drop-shadow(0 0 4px rgba(251,191,36,0.6));
      }
      .folio-upd-countdown-text {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
        font-size: 13px;
        font-weight: 800;
        color: #FBBF24;
        letter-spacing: -0.5px;
        font-variant-numeric: tabular-nums;
        transition: color 200ms ease;
      }
      .folio-upd-countdown-info {
        flex: 1;
        min-width: 0;
        text-align: left;
      }
      .folio-upd-countdown-info-title {
        font-size: 12.5px;
        font-weight: 700;
        color: #e2e8f0;
        margin-bottom: 1px;
      }
      .folio-upd-countdown-info-desc {
        font-size: 11px;
        color: #94a3b8;
        line-height: 1.35;
      }

      /* Progress bar (apply phase) */
      .folio-upd-progress {
        height: 5px; border-radius: 5px;
        background: rgba(255,255,255,0.06);
        overflow: hidden; margin: 0 0 16px;
        position: relative; z-index: 1;
        display: none;
      }
      .folio-upd-progress.visible { display: block; }
      .folio-upd-progress-fill {
        height: 100%; width: 0;
        background: linear-gradient(90deg, #F59E0B, #FBBF24, #FDE68A);
        background-size: 200% 100%;
        transition: width 280ms cubic-bezier(0.16,1,0.3,1);
        border-radius: 5px;
        position: relative;
        animation: folioShineBar 1.6s linear infinite;
        box-shadow: 0 0 10px rgba(245,158,11,0.5);
      }
      @keyframes folioShineBar {
        0%   { background-position: 0% 50%; }
        100% { background-position: 200% 50%; }
      }

      .folio-upd-actions {
        display: flex; gap: 10px;
        position: relative; z-index: 1;
      }
      .folio-upd-btn {
        flex: 1;
        font-family: inherit; font-size: 13.5px; font-weight: 700;
        padding: 13px 16px; border-radius: 14px;
        border: 1px solid transparent;
        cursor: pointer;
        transition: all 180ms cubic-bezier(0.16,1,0.3,1);
        touch-action: manipulation; user-select: none;
        position: relative;
        overflow: hidden;
        letter-spacing: 0.1px;
      }
      .folio-upd-btn.primary {
        background: linear-gradient(135deg, #F59E0B, #EA580C);
        color: #0a0c10;
        box-shadow:
          0 6px 20px -6px rgba(245, 158, 11, 0.6),
          inset 0 1px 0 rgba(255,255,255,0.25);
      }
      .folio-upd-btn.primary::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, transparent, rgba(255,255,255,0.25), transparent);
        transform: translateX(-100%);
        transition: transform 500ms ease;
      }
      .folio-upd-btn.primary:hover:not(:disabled)::before {
        transform: translateX(100%);
      }
      .folio-upd-btn.primary:hover:not(:disabled) {
        transform: translateY(-1.5px);
        box-shadow:
          0 10px 28px -8px rgba(245, 158, 11, 0.75),
          inset 0 1px 0 rgba(255,255,255,0.3);
      }
      .folio-upd-btn.primary:active:not(:disabled) { transform: scale(0.98); }
      .folio-upd-btn.ghost {
        background: rgba(255,255,255,0.04);
        color: #94a3b8;
        border-color: rgba(255,255,255,0.08);
      }
      .folio-upd-btn.ghost:hover:not(:disabled) {
        color: #e2e8f0;
        background: rgba(255,255,255,0.07);
        border-color: rgba(255,255,255,0.14);
      }
      .folio-upd-btn:active:not(:disabled) { transform: scale(0.97); }
      .folio-upd-btn:focus-visible { outline: 2px solid #FBBF24; outline-offset: 2px; }
      .folio-upd-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

      /* Full-screen reload overlay */
      .folio-reload {
        position: fixed; inset: 0; z-index: 999992;
        display: flex; align-items: center; justify-content: center;
        background:
          radial-gradient(circle at 50% 40%, rgba(245,158,11,0.10), transparent 50%),
          rgba(6, 8, 12, 0.92);
        backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        font-family: var(--font, "Inter", system-ui, sans-serif);
        color: #f1f5f9;
        text-align: center;
        padding: 24px;
        opacity: 0;
        transition: opacity 240ms ease;
      }
      .folio-reload.open { opacity: 1; }
      .folio-reload-spinner {
        width: 64px; height: 64px; margin: 0 auto 22px;
        position: relative;
      }
      .folio-reload-spinner::before {
        content: '';
        position: absolute;
        inset: 0;
        border: 3px solid rgba(245, 158, 11, 0.15);
        border-radius: 50%;
      }
      .folio-reload-spinner::after {
        content: '';
        position: absolute;
        inset: 0;
        border: 3px solid transparent;
        border-top-color: #FBBF24;
        border-right-color: #F59E0B;
        border-radius: 50%;
        animation: folioReloadSpin 0.9s cubic-bezier(0.5,0.1,0.5,0.9) infinite;
        box-shadow: 0 0 16px rgba(245,158,11,0.4);
      }
      .folio-reload-spinner span {
        position: absolute;
        inset: 0;
        display: flex; align-items: center; justify-content: center;
        color: #FBBF24;
      }
      .folio-reload-spinner span svg {
        width: 24px; height: 24px;
        stroke: currentColor; fill: none;
        stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round;
      }
      @keyframes folioReloadSpin { to { transform: rotate(360deg); } }
      .folio-reload-title {
        font-size: 17px; font-weight: 800;
        margin: 0 0 6px;
        letter-spacing: -0.3px;
        background: linear-gradient(90deg, #fbbf24, #f59e0b, #fbbf24);
        background-size: 200% 100%;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        animation: folioShine 2.5s ease-in-out infinite;
      }
      .folio-reload-sub {
        font-size: 13px;
        color: #94a3b8;
        margin: 0;
        line-height: 1.5;
      }
      .folio-reload-bar {
        width: 220px; height: 3px;
        margin: 18px auto 0;
        background: rgba(255,255,255,0.06);
        border-radius: 3px;
        overflow: hidden;
      }
      .folio-reload-bar-fill {
        height: 100%; width: 0;
        background: linear-gradient(90deg, #F59E0B, #FDE68A, #F59E0B);
        background-size: 200% 100%;
        animation: folioShineBar 1.2s linear infinite;
        border-radius: 3px;
        transition: width 300ms ease;
      }

      @media (max-width: 480px) {
        .folio-upd { align-items: flex-end; padding: 0; }
        .folio-upd-card {
          max-width: 100%;
          border-radius: 24px 24px 0 0;
          padding: 24px 20px calc(20px + env(safe-area-inset-bottom, 0px));
          transform: translateY(100%) scale(1);
        }
        .folio-upd.open .folio-upd-card { transform: translateY(0) scale(1); }
        .folio-upd-card::before {
          content: '';
          position: absolute;
          top: 10px; left: 50%;
          transform: translateX(-50%);
          width: 38px; height: 4px; border-radius: 4px;
          background: rgba(255,255,255,0.14);
          z-index: 2;
        }
        .folio-upd-countdown-ring { width: 36px; height: 36px; }
        .folio-upd-countdown-ring svg { width: 36px; height: 36px; }
        .folio-upd-countdown-text { font-size: 12px; }
      }

      @media (prefers-reduced-motion: reduce) {
        .folio-upd,
        .folio-upd-card,
        .folio-upd-aurora,
        .folio-upd-icon::after,
        .folio-upd-icon::before,
        .folio-upd-icon-glow,
        .folio-upd-btn,
        .folio-upd-btn.primary::before,
        .folio-upd-progress-fill,
        .folio-upd-countdown::before,
        .folio-upd-countdown-ring .progress,
        .folio-reload,
        .folio-reload-spinner::after,
        .folio-reload-title,
        .folio-reload-bar-fill,
        .folio-upd-title span {
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
        }
      }
      html[data-reduced-motion="true"] .folio-upd-aurora,
      html[data-reduced-motion="true"] .folio-upd-icon::after,
      html[data-reduced-motion="true"] .folio-upd-icon::before,
      html[data-reduced-motion="true"] .folio-upd-icon-glow,
      html[data-reduced-motion="true"] .folio-upd-card.applying .folio-upd-icon svg,
      html[data-reduced-motion="true"] .folio-reload-spinner::after,
      html[data-reduced-motion="true"] .folio-upd-countdown::before {
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

  // Circle circumference for the countdown ring: 2π × 14 ≈ 87.96
  const RING_R = 14;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

  function buildDialog() {
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'folio-upd';
    ov.id = 'folio-update-overlay';
    ov.innerHTML = `
      <div class="folio-upd-card" role="dialog" aria-modal="true" aria-labelledby="folio-upd-title">
        <div class="folio-upd-aurora"></div>
        <div class="folio-upd-grid"></div>

        <div class="folio-upd-icon-wrap">
          <div class="folio-upd-icon-glow"></div>
          <div class="folio-upd-icon">
            <svg viewBox="0 0 24 24">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </div>
        </div>

        <h3 class="folio-upd-title" id="folio-upd-title">
          <span>Update ready</span>
        </h3>
        <p class="folio-upd-sub">A fresh version of Folio is ready to install.</p>

        <div class="folio-upd-countdown" id="folioUpdCountdown">
          <div class="folio-upd-countdown-ring" aria-hidden="true">
            <svg viewBox="0 0 36 36">
              <circle class="track" cx="18" cy="18" r="${RING_R}"></circle>
              <circle class="progress" cx="18" cy="18" r="${RING_R}"
                      stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(2)}"
                      stroke-dashoffset="0"></circle>
            </svg>
            <div class="folio-upd-countdown-text" id="folioUpdCountdownText">30</div>
          </div>
          <div class="folio-upd-countdown-info">
            <div class="folio-upd-countdown-info-title">Auto-updating soon</div>
            <div class="folio-upd-countdown-info-desc">Cancel to postpone</div>
          </div>
        </div>

        <div class="folio-upd-progress" id="folioUpdProgress">
          <div class="folio-upd-progress-fill"></div>
        </div>

        <div class="folio-upd-actions">
          <button class="folio-upd-btn ghost" data-folio-upd="later" type="button">Later</button>
          <button class="folio-upd-btn primary" data-folio-upd="apply" type="button">Update now</button>
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
    const card = S.dialogEl?.querySelector('.folio-upd-card');
    const text = S.dialogEl?.querySelector('#folioUpdCountdownText');
    const ring = S.dialogEl?.querySelector('.folio-upd-countdown-ring .progress');
    if (!card || !text || !ring) return;

    S.countdownStartAt = Date.now();

    const tick = () => {
      if (!S.dialogEl || S.applying) return;
      const elapsed = Date.now() - S.countdownStartAt;
      const remaining = Math.max(0, CFG.autoApplyMs - elapsed);
      const remainingSec = Math.ceil(remaining / 1000);

      text.textContent = String(remainingSec);

      const pct = Math.min(1, elapsed / CFG.autoApplyMs);
      const offset = RING_CIRCUMFERENCE * pct;
      ring.style.strokeDashoffset = String(offset);

      if (remainingSec <= 5 && remainingSec > 0) {
        text.style.color = '#F87171';
        ring.style.stroke = '#F87171';
        ring.style.filter = 'drop-shadow(0 0 6px rgba(248,113,113,0.7))';
      } else {
        text.style.color = '#FBBF24';
        ring.style.stroke = '#FBBF24';
        ring.style.filter = 'drop-shadow(0 0 4px rgba(251,191,36,0.6))';
      }

      if (remaining <= 0) {
        applyNow(true);
        return;
      }

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

    // Synchronous postpone FIRST so no racing handler can re-open.
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
    setTimeout(() => ov.remove(), 300);

    // Async refine: overwrite with the authoritative version if we can read it.
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
      <div>
        <div class="folio-reload-spinner">
          <span>
            <svg viewBox="0 0 24 24">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </span>
        </div>
        <div class="folio-reload-title">Updating Folio</div>
        <div class="folio-reload-sub">Applying changes and reloading…</div>
        <div class="folio-reload-bar">
          <div class="folio-reload-bar-fill" id="folioReloadBar"></div>
        </div>
      </div>
    `;
    document.body.appendChild(ov);
    void ov.offsetWidth;
    ov.classList.add('open');

    // Animate the bar up to 90% while we wait
    const bar = ov.querySelector('#folioReloadBar');
    if (bar) {
      let p = 0;
      const iv = setInterval(() => {
        p = Math.min(90, p + Math.random() * 12);
        bar.style.width = p + '%';
        if (p >= 90) clearInterval(iv);
      }, 180);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // APPLY
  // ═══════════════════════════════════════════════════════════

  async function applyNow(fromCountdown = false) {
    if (S.applying) return;
    S.applying = true;
    stopCountdown();

    // Respect unsaved work (only if user clicked, not from auto-countdown)
    if (hasUnsavedWork() && !fromCountdown) {
      const ok = await confirmDiscard();
      if (!ok) {
        S.applying = false;
        if (S.dialogEl) {
          const card = S.dialogEl.querySelector('.folio-upd-card');
          if (card) card.classList.remove('applying');
          startCountdown();
        }
        return;
      }
    }
    // If auto-countdown fires but there's unsaved work, treat it as "later"
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
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Updating…'; }
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
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Update now'; }
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

    // Synchronous postpone gate — before any network.
    if (hasPostponed()) return;

    // Throttle unless forced.
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

      // ── THE FIX ── only show for a *real* update
      const real = await isRealUpdate(reg);
      if (!real) return;

      let version = await getWorkerVersion(reg.waiting);
      if (!version) version = S.postponedVersion || '';

      // Honour postpone — including the "we couldn't read a version" case.
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

        // Only react if there's actually a real waiting update.
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