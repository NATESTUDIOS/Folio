/* ============================================================
   Folio — update.js
   Service worker update prompt + apply.

   Behavior:
     • When a new SW is waiting, shows an animated dialog
     • A visible countdown auto-applies the update after N seconds
     • User can "Update now" to skip the countdown
     • User can "Later" to postpone (respects unsaved work)
     • Reload overlay with progress bar + spinner during apply

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

  // ═══════════════════════════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════════════════════════

  const CFG = {
    checkIntervalMs: 5 * 60 * 1000,      // poll every 5 min
    autoApplyMs: 30 * 1000,              // auto-apply after 30s
    reloadDelayMs: 700,                  // brief pause before reload
    controllerTimeoutMs: 4000,           // safety net for SKIP_WAITING
    waitingPollTimeoutMs: 5000,          // wait for a waiting worker
    countdownTickMs: 100,                // countdown update interval
  };

  const POSTPONE_KEY = 'folio.upd.postponed';

  const S = {
    reg: null,
    dialogEl: null,
    dialogVersion: null,
    autoApplyTimer: null,
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
  };

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
    return matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  function fmtSeconds(ms) {
    return Math.max(0, Math.ceil(ms / 1000));
  }

  /* Ask a specific service-worker instance for its CACHE_VERSION. */
  function getWorkerVersion(worker, timeoutMs = 1500) {
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
    try {
      sessionStorage.setItem(
        POSTPONE_KEY,
        JSON.stringify({ version, at: Date.now() })
      );
    } catch {}
  }

  function clearPostponed() {
    try { sessionStorage.removeItem(POSTPONE_KEY); } catch {}
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
        background: rgba(10, 12, 16, 0.72);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
        opacity: 0; pointer-events: none;
        transition: opacity 220ms cubic-bezier(0.16, 1, 0.3, 1);
        font-family: var(--font, "Inter", -apple-system, system-ui, sans-serif);
      }
      .folio-upd.open { opacity: 1; pointer-events: auto; }

      .folio-upd-card {
        width: 100%; max-width: 380px;
        background: var(--bg-card, #151922);
        border: 1px solid var(--border, #222831);
        border-radius: 20px;
        padding: 26px 22px 20px;
        text-align: center;
        transform: scale(0.94) translateY(14px);
        transition: transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
        position: relative;
        overflow: hidden;
      }
      .folio-upd.open .folio-upd-card { transform: scale(1) translateY(0); }

      /* Ambient glow at the top */
      .folio-upd-card::after {
        content: '';
        position: absolute;
        inset: -40% -40% auto -40%;
        height: 60%;
        background: radial-gradient(circle at 50% 0%, rgba(245, 158, 11, 0.14) 0%, transparent 60%);
        pointer-events: none;
        opacity: 0.9;
      }

      .folio-upd-icon {
        width: 64px; height: 64px; margin: 0 auto 16px;
        border-radius: 18px;
        background: linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(249, 115, 22, 0.10));
        border: 1px solid rgba(245, 158, 11, 0.32);
        display: flex; align-items: center; justify-content: center;
        color: #F59E0B;
        position: relative;
        z-index: 1;
      }
      .folio-upd-icon::after {
        content: '';
        position: absolute;
        inset: -6px;
        border-radius: 24px;
        border: 1px dashed rgba(245, 158, 11, 0.22);
        animation: folioUpdRing 2.6s ease-in-out infinite;
        pointer-events: none;
      }
      @keyframes folioUpdRing {
        0%, 100% { opacity: 0.35; transform: scale(1); }
        50% { opacity: 0.75; transform: scale(1.05); }
      }
      .folio-upd-icon svg {
        width: 28px; height: 28px;
        stroke: currentColor; fill: none;
        stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round;
      }

      /* Spinning icon when applying */
      .folio-upd-card.applying .folio-upd-icon svg {
        animation: folioUpdSpin 1.2s linear infinite;
      }
      .folio-upd-card.applying .folio-upd-icon::after {
        animation: none;
        border-color: rgba(245, 158, 11, 0.35);
      }
      @keyframes folioUpdSpin { to { transform: rotate(360deg); } }

      .folio-upd-title {
        font-size: 18px; font-weight: 700; letter-spacing: -0.3px;
        color: var(--text, #e8ecf1); margin: 0 0 6px;
        position: relative; z-index: 1;
      }
      .folio-upd-sub {
        font-size: 13px; line-height: 1.55;
        color: var(--text-muted, #a8b0bc); margin: 0 0 16px;
        position: relative; z-index: 1;
      }

      /* Countdown block */
      .folio-upd-countdown {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        background: var(--bg-input, #1a1f2a);
        border: 1px solid var(--border, #222831);
        border-radius: 12px;
        margin: 0 0 14px;
        position: relative;
        z-index: 1;
        overflow: hidden;
      }
      .folio-upd-countdown-ring {
        flex-shrink: 0;
        width: 32px; height: 32px;
        position: relative;
      }
      .folio-upd-countdown-ring svg {
        width: 32px; height: 32px;
        transform: rotate(-90deg);
      }
      .folio-upd-countdown-ring svg circle {
        fill: none;
        stroke-width: 2.6;
        stroke-linecap: round;
      }
      .folio-upd-countdown-ring .track {
        stroke: rgba(255,255,255,0.08);
      }
      [data-theme="light"] .folio-upd-countdown-ring .track {
        stroke: rgba(0,0,0,0.08);
      }
      .folio-upd-countdown-ring .progress {
        stroke: #F59E0B;
        transition: stroke-dashoffset 120ms linear;
      }
      .folio-upd-countdown-text {
        flex-shrink: 0;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 15px;
        font-weight: 800;
        color: #F59E0B;
        min-width: 28px;
        text-align: center;
        letter-spacing: -0.3px;
        font-variant-numeric: tabular-nums;
      }
      .folio-upd-countdown-info {
        flex: 1;
        min-width: 0;
        text-align: left;
      }
      .folio-upd-countdown-info-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--text, #e8ecf1);
        margin-bottom: 1px;
      }
      .folio-upd-countdown-info-desc {
        font-size: 10.5px;
        color: var(--text-muted, #a8b0bc);
        line-height: 1.35;
      }

      /* Progress bar (apply phase) */
      .folio-upd-progress {
        height: 4px; border-radius: 4px;
        background: var(--bg-input, #1a1f2a);
        overflow: hidden; margin: 0 0 16px;
        position: relative; z-index: 1;
      }
      .folio-upd-progress-fill {
        height: 100%; width: 0;
        background: linear-gradient(90deg, #F59E0B, #fbbf24);
        transition: width 220ms cubic-bezier(0.16,1,0.3,1);
        border-radius: 4px;
      }

      .folio-upd-actions {
        display: flex; gap: 8px;
        position: relative; z-index: 1;
      }
      .folio-upd-btn {
        flex: 1;
        font-family: inherit; font-size: 13.5px; font-weight: 600;
        padding: 12px 16px; border-radius: 12px;
        border: 1px solid transparent;
        cursor: pointer;
        transition: all 140ms ease;
        touch-action: manipulation; user-select: none;
      }
      .folio-upd-btn.primary {
        background: #F59E0B; color: #0a0c10;
        box-shadow: 0 6px 20px rgba(245, 158, 11, 0.30);
      }
      .folio-upd-btn.primary:hover:not(:disabled) {
        background: #fbbf24;
        transform: translateY(-1px);
        box-shadow: 0 10px 26px rgba(245, 158, 11, 0.38);
      }
      .folio-upd-btn.primary:active:not(:disabled) { transform: scale(0.98); }
      .folio-upd-btn.ghost {
        background: transparent;
        color: var(--text-muted, #a8b0bc);
        border-color: var(--border, #222831);
      }
      .folio-upd-btn.ghost:hover:not(:disabled) {
        color: var(--text, #e8ecf1);
        background: var(--bg-input, #1a1f2a);
      }
      .folio-upd-btn:active:not(:disabled) { transform: scale(0.97); }
      .folio-upd-btn:focus-visible { outline: 2px solid #F59E0B; outline-offset: 2px; }
      .folio-upd-btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }

      /* Full-screen reload overlay */
      .folio-reload {
        position: fixed; inset: 0; z-index: 999992;
        display: flex; align-items: center; justify-content: center;
        background: rgba(10, 12, 16, 0.85);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
        font-family: var(--font, "Inter", system-ui, sans-serif);
        color: var(--text, #e8ecf1);
        text-align: center;
        padding: 24px;
        opacity: 0;
        transition: opacity 200ms ease;
      }
      .folio-reload.open { opacity: 1; }
      .folio-reload-spinner {
        width: 44px; height: 44px; margin: 0 auto 18px;
        position: relative;
      }
      .folio-reload-spinner::before {
        content: '';
        position: absolute;
        inset: 0;
        border: 3px solid rgba(245, 158, 11, 0.18);
        border-radius: 50%;
      }
      .folio-reload-spinner::after {
        content: '';
        position: absolute;
        inset: 0;
        border: 3px solid transparent;
        border-top-color: #F59E0B;
        border-radius: 50%;
        animation: folioReloadSpin 0.9s linear infinite;
      }
      @keyframes folioReloadSpin { to { transform: rotate(360deg); } }
      .folio-reload-title {
        font-size: 16px; font-weight: 800;
        margin: 0 0 6px;
        letter-spacing: -0.2px;
      }
      .folio-reload-sub {
        font-size: 13px;
        color: var(--text-muted, #a8b0bc);
        margin: 0;
        line-height: 1.5;
      }

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
          content: '';
          position: absolute;
          top: 8px; left: 50%;
          transform: translateX(-50%);
          width: 36px; height: 4px; border-radius: 4px;
          background: var(--border, #222831);
          z-index: 1;
        }
        .folio-upd-countdown-ring { width: 28px; height: 28px; }
        .folio-upd-countdown-ring svg { width: 28px; height: 28px; }
        .folio-upd-countdown-text { font-size: 13px; }
      }

      @media (prefers-reduced-motion: reduce) {
        .folio-upd,
        .folio-upd-card,
        .folio-upd-icon::after,
        .folio-upd-btn,
        .folio-upd-progress-fill,
        .folio-upd-countdown-ring .progress,
        .folio-upd-countdown-ring svg,
        .folio-reload,
        .folio-reload-spinner::after {
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
        }
      }
      html[data-reduced-motion="true"] .folio-upd-icon::after,
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

  // Circle circumference for the countdown ring: 2π × 12 ≈ 75.4
  const RING_CIRCUMFERENCE = 2 * Math.PI * 12;

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

        <div class="folio-upd-countdown" id="folioUpdCountdown">
          <div class="folio-upd-countdown-ring" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <circle class="track" cx="16" cy="16" r="12"></circle>
              <circle class="progress" cx="16" cy="16" r="12"
                      stroke-dasharray="${RING_CIRCUMFERENCE}"
                      stroke-dashoffset="0"></circle>
            </svg>
          </div>
          <div class="folio-upd-countdown-text" id="folioUpdCountdownText">30</div>
          <div class="folio-upd-countdown-info">
            <div class="folio-upd-countdown-info-title">Auto-updating</div>
            <div class="folio-upd-countdown-info-desc">Tap Cancel to postpone</div>
          </div>
        </div>

        <div class="folio-upd-progress" hidden id="folioUpdProgress">
          <div class="folio-upd-progress-fill"></div>
        </div>

        <div class="folio-upd-actions">
          <button class="folio-upd-btn ghost" data-folio-upd="later" type="button">Cancel</button>
          <button class="folio-upd-btn primary" data-folio-upd="apply" type="button">Update now</button>
        </div>
      </div>
    `;
    document.body.appendChild(ov);

    ov.querySelector('[data-folio-upd="later"]').addEventListener('click', dismiss);
    ov.querySelector('[data-folio-upd="apply"]').addEventListener('click', applyNow);
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
        text.style.color = '#EF4444';
        ring.style.stroke = '#EF4444';
      } else {
        text.style.color = '#F59E0B';
        ring.style.stroke = '#F59E0B';
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

    // Suppress duplicate shows for a version the user already postponed.
    if (version && S.postponedVersion === version) return;

    const ov = buildDialog();
    S.dialogEl = ov;
    S.dialogVersion = version || null;
    document.body.style.overflow = 'hidden';
    void ov.offsetWidth;
    ov.classList.add('open');

    setTimeout(() => startCountdown(), 50);

    try { window.dispatchEvent(new CustomEvent('folio:update:available')); } catch {}
  }

  function dismiss() {
    stopCountdown();
    if (!S.dialogEl) return;

    // Remember the actual waiting worker's version so the same update
    // doesn't immediately re-open on the next checkNow().
    const waiting = S.reg?.waiting;
    if (waiting) {
      S.postponed = true;
      const fallbackVersion = S.dialogVersion || '';
      S.postponedVersion = fallbackVersion;
      // Refresh with the authoritative version string when available.
      getWorkerVersion(waiting).then((ver) => {
        if (ver) {
          S.postponedVersion = ver;
          writePostponed(ver);
        } else if (fallbackVersion) {
          writePostponed(fallbackVersion);
        }
      }).catch(() => {
        if (fallbackVersion) writePostponed(fallbackVersion);
      });
    }

    const ov = S.dialogEl;
    S.dialogEl = null;
    ov.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => ov.remove(), 280);

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
    if (wrap) wrap.hidden = false;
    if (fill) fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  function hideCountdown() {
    const cd = S.dialogEl?.querySelector('#folioUpdCountdown');
    if (cd) cd.style.display = 'none';
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
        <div class="folio-reload-spinner"></div>
        <div class="folio-reload-title">Updating Folio</div>
        <div class="folio-reload-sub">Reloading in a moment…</div>
      </div>
    `;
    document.body.appendChild(ov);
    void ov.offsetWidth;
    ov.classList.add('open');
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
          location.reload();
        }, CFG.controllerTimeoutMs);
      } else {
        setProgress(100);
        showReloadOverlay();
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

  async function checkNow() {
    if (S.paused || S.applying || S.dialogEl) return;
    try {
      const reg = S.reg || await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      S.reg = reg;

      // Only ask the server for a new SW if we're not already sitting on one.
      if (!reg.waiting && !reg.installing) {
        try { await reg.update(); } catch {}
      }

      if (!reg.waiting) return;

      // Ask the waiting worker what version it is so we can compare against
      // any prior postpone.
      const version = await getWorkerVersion(reg.waiting);

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

    try {
      S.reg = await navigator.serviceWorker.getRegistration();
      if (!S.reg) return;

      // Restore any postpone from this tab's earlier session.
      const postponed = readPostponed();
      if (postponed) {
        S.postponed = true;
        S.postponedVersion = postponed.version;
      }

      navigator.serviceWorker.addEventListener('message', (event) => {
        const d = event.data || {};
        if (d.type !== 'SW_UPDATE_AVAILABLE' && d.type !== 'UPDATE_AVAILABLE') return;

        const ver = String(d.version || d.builtAt || '');
        // Ignore if the user already postponed this exact version.
        if (ver && S.postponedVersion === ver) return;

        S.postponed = false;
        S.postponedVersion = null;
        show(ver || null);
      });

      if (S.checkTimer) clearInterval(S.checkTimer);
      S.checkTimer = setInterval(checkNow, CFG.checkIntervalMs);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkNow();
      });
      window.addEventListener('online', checkNow);

      // checkNow handles waiting-worker detection + version comparison.
      await checkNow();
    } catch (err) {
      console.warn('[Folio update] init error:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  window.FOLIO = window.FOLIO || {};
  window.FOLIO.update = {
    check: checkNow,
    applyNow: () => applyNow(false),
    pause() {
      S.paused = true;
      if (S.checkTimer) { clearInterval(S.checkTimer); S.checkTimer = null; }
      stopCountdown();
    },
    resume() {
      S.paused = false;
      if (S.applying) return;
      setTimeout(checkNow, 800);
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