/* ============================================================
   Folio — install.js
   PWA install prompt manager.

   Usage:
     <script src="/install.js" defer></script>

     FOLIO.install.show();
     FOLIO.install.prompt();
     FOLIO.install.hide();
     FOLIO.install.isInstalled();
     FOLIO.install.reset();

   Auto-wires: [data-folio-install-button]

   Config (set BEFORE this script loads):
     window.FOLIO_INSTALL_CONFIG = {
       dismissCountdownMs: 5000,
       cooldowns: [5h, 24h, 7d, Infinity],
       autoPromptDelayMs: 2000,
       showDialogOnFirstVisit: true,
     };
   ============================================================ */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════════════════════════

  const CFG = Object.assign({
    dismissCountdownMs: 5000,
    cooldowns: [
      5 * 60 * 60 * 1000,        // 1st dismiss → 5h
      24 * 60 * 60 * 1000,       // 2nd dismiss → 24h
      7 * 24 * 60 * 60 * 1000,   // 3rd dismiss → 7d
      Infinity,                   // 4th dismiss → never
    ],
    autoPromptDelayMs: 2000,
    showDialogOnFirstVisit: true,
  }, window.FOLIO_INSTALL_CONFIG || {});

  const KEYS = {
    dismissed: 'folio.install.dismissed',   // JSON { t, count }
    installed: 'folio.install.installed',
    asked:     'folio.install.asked',
  };

  const S = {
    prompt: null,
    installing: false,
    open: false,
    stylesInjected: false,
    wired: false,
    autoShownThisSession: false,
    dismissCountdownTimer: null,
    listeners: {},
    overlayEl: null,
    escListener: null,
  };

  // ═══════════════════════════════════════════════════════════
  // ENVIRONMENT
  // ═══════════════════════════════════════════════════════════

  const isStandalone = () =>
    matchMedia?.('(display-mode: standalone)').matches ||
    navigator.standalone === true ||
    document.referrer?.startsWith('android-app://');

  const isiOS = () =>
    /iPad|iPhone|iPod/.test(navigator.userAgent || '') &&
    !window.MSStream ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const isInstalled = () => {
    if (isStandalone()) return true;
    try { return localStorage.getItem(KEYS.installed) === 'true'; }
    catch { return false; }
  };

  const setInstalled = (v = true) => {
    try {
      v ? localStorage.setItem(KEYS.installed, 'true')
        : localStorage.removeItem(KEYS.installed);
    } catch {}
  };

  const hasReducedMotion = () => {
    try {
      if (localStorage.getItem('folio.reducedMotion') === 'true') return true;
    } catch {}
    return matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  };

  // ═══════════════════════════════════════════════════════════
  // DISMISS STATE
  // ═══════════════════════════════════════════════════════════

  function readDismissState() {
    try {
      const raw = localStorage.getItem(KEYS.dismissed);
      if (!raw) return { t: 0, count: 0 };
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'number') return { t: parsed, count: 1 };
      return { t: parsed?.t || 0, count: Math.max(0, parseInt(parsed?.count || 0, 10) || 0) };
    } catch { return { t: 0, count: 0 }; }
  }

  function markDismissed() {
    const state = readDismissState();
    const next = { t: Date.now(), count: state.count + 1 };
    try { localStorage.setItem(KEYS.dismissed, JSON.stringify(next)); } catch {}
    return next.count;
  }

  function clearDismissed() {
    try { localStorage.removeItem(KEYS.dismissed); } catch {}
  }

  function currentCooldownMs() {
    const { count } = readDismissState();
    const arr = CFG.cooldowns || [];
    if (arr.length === 0) return 0;
    return arr[Math.min(count, arr.length - 1)];
  }

  function isCoolingDown() {
    const cooldown = currentCooldownMs();
    if (cooldown === Infinity) return true;
    if (cooldown === 0) return false;
    const { t } = readDismissState();
    if (!t) return false;
    return (Date.now() - t) < cooldown;
  }

  // ═══════════════════════════════════════════════════════════
  // EVENTS
  // ═══════════════════════════════════════════════════════════

  function emit(event, detail) {
    (S.listeners[event] || []).forEach(fn => { try { fn(detail); } catch (e) { console.error(e); } });
    try { window.dispatchEvent(new CustomEvent('folio:install:' + event, { detail })); } catch {}
  }

  function on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    (S.listeners[event] ||= []).push(fn);
    return () => { S.listeners[event] = S.listeners[event].filter(f => f !== fn); };
  }

  const haptic = () => { try { navigator.vibrate?.(8); } catch {} };

  /* Toast bridge — positional args to match editor */
  const toast = (msg, type = 'info', duration = 2500) => {
    try {
      if (typeof window.toast === 'function') window.toast(msg, type, duration);
      else console.log('[Folio install]', msg);
    } catch {}
  };

  /* Update-manager cooperation */
  const pauseUpdates  = () => { try { window.__updateManager?.pause?.();  } catch {} };
  const resumeUpdates = () => { try { window.__updateManager?.resume?.(); } catch {} };

  // ═══════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════

  function injectStyles() {
    if (S.stylesInjected || document.getElementById('folio-install-style')) {
      S.stylesInjected = true;
      return;
    }

    const css = `
      .folio-inst {
        position: fixed; inset: 0; z-index: 999990;
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
        background: rgba(10, 12, 16, 0.72);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
        opacity: 0; pointer-events: none;
        transition: opacity 220ms cubic-bezier(0.16, 1, 0.3, 1);
        font-family: var(--font, "Inter", -apple-system, system-ui, sans-serif);
      }
      .folio-inst.open { opacity: 1; pointer-events: auto; }

      .folio-inst-card {
        width: 100%; max-width: 360px;
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
      .folio-inst.open .folio-inst-card { transform: scale(1) translateY(0); }

      /* Ambient amber glow at the top */
      .folio-inst-card::after {
        content: '';
        position: absolute;
        inset: -40% -40% auto -40%;
        height: 60%;
        background: radial-gradient(circle at 50% 0%, rgba(245, 158, 11, 0.14) 0%, transparent 60%);
        pointer-events: none;
        opacity: 0.9;
      }

      .folio-inst-icon {
        width: 64px; height: 64px; margin: 0 auto 16px;
        border-radius: 18px;
        background: linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(249, 115, 22, 0.10));
        border: 1px solid rgba(245, 158, 11, 0.32);
        display: flex; align-items: center; justify-content: center;
        color: #F59E0B;
        position: relative;
        z-index: 1;
      }
      .folio-inst-icon::after {
        content: '';
        position: absolute;
        inset: -6px;
        border-radius: 24px;
        border: 1px dashed rgba(245, 158, 11, 0.22);
        animation: folioInstRing 2.6s ease-in-out infinite;
        pointer-events: none;
      }
      @keyframes folioInstRing {
        0%, 100% { opacity: 0.35; transform: scale(1); }
        50% { opacity: 0.75; transform: scale(1.05); }
      }
      .folio-inst-icon svg {
        width: 28px; height: 28px;
        stroke: currentColor; fill: none;
        stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
      }

      .folio-inst-title {
        font-size: 18px; font-weight: 700; letter-spacing: -0.3px;
        color: var(--text, #e8ecf1); margin: 0 0 6px; line-height: 1.25;
        position: relative; z-index: 1;
      }
      .folio-inst-sub {
        font-size: 13px; line-height: 1.55;
        color: var(--text-muted, #a8b0bc); margin: 0 0 18px;
        position: relative; z-index: 1;
      }

      .folio-inst-list {
        display: flex; flex-direction: column; gap: 8px;
        margin: 0 0 20px; padding: 12px 14px;
        background: var(--bg-input, #1a1f2a);
        border: 1px solid var(--border, #222831);
        border-radius: 12px; text-align: left;
        position: relative; z-index: 1;
      }
      .folio-inst-row {
        display: flex; align-items: center; gap: 10px;
        font-size: 12.5px; color: var(--text-muted, #a8b0bc); line-height: 1.35;
      }
      .folio-inst-row svg {
        width: 14px; height: 14px; flex-shrink: 0;
        stroke: #F59E0B; fill: none; stroke-width: 2.5;
        stroke-linecap: round; stroke-linejoin: round;
      }

      .folio-inst-steps {
        display: flex; flex-direction: column; gap: 10px;
        margin: 0 0 18px; padding: 14px 16px;
        background: var(--bg-input, #1a1f2a);
        border: 1px solid var(--border, #222831);
        border-radius: 12px; text-align: left;
        position: relative; z-index: 1;
      }
      .folio-inst-step {
        display: flex; gap: 10px; align-items: flex-start;
        font-size: 12.5px; line-height: 1.5;
        color: var(--text-muted, #a8b0bc);
      }
      .folio-inst-step b { color: var(--text, #e8ecf1); font-weight: 600; }
      .folio-inst-num {
        flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%;
        background: #F59E0B; color: #0a0c10;
        font-size: 11px; font-weight: 700;
        display: flex; align-items: center; justify-content: center;
        margin-top: 1px;
      }

      .folio-inst-actions {
        display: flex; flex-direction: column; gap: 8px;
        position: relative; z-index: 1;
      }
      .folio-inst-btn {
        font-family: inherit; font-size: 13.5px; font-weight: 600;
        padding: 12px 16px; border-radius: 12px;
        border: 1px solid transparent;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        gap: 6px; transition: all 140ms ease;
        touch-action: manipulation; user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      .folio-inst-btn.primary {
        background: #F59E0B; color: #0a0c10;
        box-shadow: 0 6px 20px rgba(245, 158, 11, 0.30);
      }
      .folio-inst-btn.primary:hover:not(:disabled) { background: #fbbf24; transform: translateY(-1px); box-shadow: 0 10px 26px rgba(245, 158, 11, 0.38); }
      .folio-inst-btn.primary:active:not(:disabled) { transform: scale(0.98); }

      .folio-inst-btn.ghost {
        background: transparent;
        color: var(--text-muted, #a8b0bc);
        border-color: var(--border, #222831);
      }
      .folio-inst-btn.ghost:hover:not(:disabled) {
        color: var(--text, #e8ecf1);
        background: var(--bg-input, #1a1f2a);
      }
      .folio-inst-btn.ghost:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .folio-inst-btn:active:not(:disabled) { transform: scale(0.97); }
      .folio-inst-btn:focus-visible { outline: 2px solid #F59E0B; outline-offset: 2px; }
      .folio-inst-btn svg {
        width: 14px; height: 14px;
        stroke: currentColor; fill: none; stroke-width: 2.2;
        stroke-linecap: round; stroke-linejoin: round;
      }

      .folio-inst-btn.primary.loading {
        pointer-events: none;
        opacity: 0.85;
      }
      .folio-inst-btn.primary.loading svg {
        animation: folioInstSpin 0.9s linear infinite;
      }
      @keyframes folioInstSpin { to { transform: rotate(360deg); } }

      /* Success state — green check + hide actions */
      .folio-inst-card.success .folio-inst-icon {
        background: linear-gradient(135deg, rgba(16, 185, 129, 0.22), rgba(5, 150, 105, 0.12));
        border-color: rgba(16, 185, 129, 0.4);
        color: #10B981;
      }
      .folio-inst-card.success .folio-inst-icon::after {
        border-color: rgba(16, 185, 129, 0.25);
        animation: none;
      }

      @media (max-width: 480px) {
        .folio-inst { align-items: flex-end; padding: 0; }
        .folio-inst-card {
          max-width: 100%;
          border-radius: 20px 20px 0 0;
          padding: 22px 20px calc(18px + env(safe-area-inset-bottom, 0px));
          transform: translateY(100%);
        }
        .folio-inst.open .folio-inst-card { transform: translateY(0); }
        .folio-inst-card::before {
          content: '';
          position: absolute;
          top: 8px; left: 50%;
          transform: translateX(-50%);
          width: 36px; height: 4px; border-radius: 4px;
          background: var(--border, #222831);
          z-index: 1;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .folio-inst,
        .folio-inst-card,
        .folio-inst-icon::after,
        .folio-inst-btn { transition-duration: 0.01ms !important; animation: none !important; }
      }
      html[data-reduced-motion="true"] .folio-inst-icon::after,
      html[data-reduced-motion="true"] .folio-inst-btn.primary.loading svg {
        animation: none !important;
      }
    `;
    const s = document.createElement('style');
    s.id = 'folio-install-style';
    s.textContent = css;
    document.head.appendChild(s);
    S.stylesInjected = true;
  }

  // ═══════════════════════════════════════════════════════════
  // DIALOG MARKUP
  // ═══════════════════════════════════════════════════════════

  const checkRow = (text) => `
    <div class="folio-inst-row">
      <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
      <span>${text}</span>
    </div>`;

  const downloadIcon = `
    <svg viewBox="0 0 24 24">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>`;

  const checkIcon = `
    <svg viewBox="0 0 24 24">
      <polyline points="20 6 9 17 4 12"/>
    </svg>`;

  const spinnerIcon = `
    <svg viewBox="0 0 24 24">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>`;

  function buildStandardHTML() {
    return `
      <div class="folio-inst-card" role="dialog" aria-modal="true" aria-labelledby="folio-inst-title">
        <div class="folio-inst-icon" id="folioInstIcon">${downloadIcon}</div>
        <h3 class="folio-inst-title" id="folio-inst-title">Install Folio</h3>
        <p class="folio-inst-sub">Code from your pocket — offline, fast, always with you.</p>
        <div class="folio-inst-list">
          ${checkRow('Works fully offline')}
          ${checkRow('Instant launch — no browser tab')}
          ${checkRow('Projects stored on your device')}
        </div>
        <div class="folio-inst-actions">
          <button class="folio-inst-btn primary" data-folio-action="install" id="folioInstInstallBtn">
            <span id="folioInstInstallIcon">${downloadIcon}</span>
            <span>Install</span>
          </button>
          <button class="folio-inst-btn ghost" data-folio-action="dismiss" id="folioInstDismissBtn" disabled>
            Not now (5s)
          </button>
        </div>
      </div>`;
  }

  function buildIOSHTML() {
    return `
      <div class="folio-inst-card" role="dialog" aria-modal="true" aria-labelledby="folio-inst-title">
        <div class="folio-inst-icon">${downloadIcon}</div>
        <h3 class="folio-inst-title" id="folio-inst-title">Install Folio</h3>
        <p class="folio-inst-sub">Add Folio to your home screen in two steps.</p>
        <div class="folio-inst-steps">
          <div class="folio-inst-step">
            <div class="folio-inst-num">1</div>
            <div>Tap the <b>Share</b> button in Safari's toolbar.</div>
          </div>
          <div class="folio-inst-step">
            <div class="folio-inst-num">2</div>
            <div>Scroll and tap <b>Add to Home Screen</b>, then <b>Add</b>.</div>
          </div>
        </div>
        <div class="folio-inst-actions">
          <button class="folio-inst-btn ghost" data-folio-action="dismiss" id="folioInstDismissBtn" disabled>
            Got it (5s)
          </button>
        </div>
      </div>`;
  }

  // ═══════════════════════════════════════════════════════════
  // OVERLAY
  // ═══════════════════════════════════════════════════════════

  function ensureOverlay() {
    if (S.overlayEl && document.body.contains(S.overlayEl)) return S.overlayEl;

    const ov = document.createElement('div');
    ov.className = 'folio-inst';
    ov.id = 'folio-install-overlay';
    ov.innerHTML = (isiOS() && !isStandalone()) ? buildIOSHTML() : buildStandardHTML();
    document.body.appendChild(ov);
    S.overlayEl = ov;

    ov.querySelectorAll('[data-folio-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const a = btn.dataset.folioAction;
        if (a === 'install') runInstall();
        else if (a === 'dismiss') tryDismiss();
      });
    });

    ov.addEventListener('click', (e) => { if (e.target === ov) tryDismiss(); });

    S.escListener = (e) => {
      if (e.key === 'Escape' && S.open) {
        e.preventDefault();
        tryDismiss();
      }
    };
    document.addEventListener('keydown', S.escListener);

    return ov;
  }

  // ═══════════════════════════════════════════════════════════
  // COUNTDOWN
  // ═══════════════════════════════════════════════════════════

  function startDismissCountdown() {
    const btn = document.getElementById('folioInstDismissBtn');
    if (!btn) return;

    const isiOSPrompt = isiOS() && !isStandalone();
    const baseLabel = isiOSPrompt ? 'Got it' : 'Not now';
    const total = Math.max(0, parseInt(CFG.dismissCountdownMs, 10) || 0);

    if (S.dismissCountdownTimer) {
      clearInterval(S.dismissCountdownTimer);
      S.dismissCountdownTimer = null;
    }

    if (total <= 0) {
      btn.disabled = false;
      btn.textContent = baseLabel;
      return;
    }

    btn.disabled = true;
    const start = Date.now();

    const update = () => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, Math.ceil((total - elapsed) / 1000));
      if (remaining > 0) {
        btn.textContent = `${baseLabel} (${remaining}s)`;
      } else {
        btn.textContent = baseLabel;
        btn.disabled = false;
        if (S.dismissCountdownTimer) {
          clearInterval(S.dismissCountdownTimer);
          S.dismissCountdownTimer = null;
        }
      }
    };

    update();
    S.dismissCountdownTimer = setInterval(update, 250);
  }

  // ═══════════════════════════════════════════════════════════
  // SHOW / HIDE / DISMISS
  // ═══════════════════════════════════════════════════════════

  function show() {
    if (isInstalled()) return false;
    if (!navigator.onLine) {
      toast('Connect to the internet to install Folio', 'warning', 3000);
      return false;
    }
    injectStyles();
    const ov = ensureOverlay();
    document.body.style.overflow = 'hidden';
    void ov.offsetWidth;
    ov.classList.add('open');
    S.open = true;
    try { localStorage.setItem(KEYS.asked, 'true'); } catch {}
    startDismissCountdown();
    emit('open');
    return true;
  }

  function hide() {
    const ov = S.overlayEl || document.getElementById('folio-install-overlay');
    if (!ov) return;
    ov.classList.remove('open');
    document.body.style.overflow = '';
    S.open = false;

    if (S.dismissCountdownTimer) {
      clearInterval(S.dismissCountdownTimer);
      S.dismissCountdownTimer = null;
    }

    emit('close');
  }

  function tryDismiss() {
    const btn = document.getElementById('folioInstDismissBtn');
    if (btn && btn.disabled) return; // still locked
    haptic();
    hide();
    const count = markDismissed();
    emit('dismissed', { count });
    setTimeout(() => toast('You can install Folio anytime from Settings', 'info', 3000), 220);
  }

  // ═══════════════════════════════════════════════════════════
  // INSTALL
  // ═══════════════════════════════════════════════════════════

  async function runInstall() {
    if (isInstalled()) { hide(); return; }

    if (isiOS() && !isStandalone()) {
      if (!S.open) show();
      return;
    }

    if (!S.prompt) {
      if (!S.open) show();
      emit('unavailable');
      return;
    }

    if (S.installing) return;
    S.installing = true;
    haptic();
    pauseUpdates();

    const installBtn = document.getElementById('folioInstInstallBtn');
    const installIcon = document.getElementById('folioInstInstallIcon');
    const dismissBtn = document.getElementById('folioInstDismissBtn');

    if (installBtn) installBtn.classList.add('loading');
    if (installIcon) installIcon.innerHTML = spinnerIcon;
    if (dismissBtn) dismissBtn.disabled = true;

    try {
      S.prompt.prompt();
      emit('prompt-open');
      const { outcome } = await S.prompt.userChoice;
      emit('prompt-close', { outcome });

      if (outcome === 'accepted') {
        setInstalled(true);
        clearDismissed();
        showSuccess();
        emit('installed');
        toast('Folio installed', 'success', 2500);
        updateAllButtons();
        setTimeout(() => hide(), 1400);
      } else {
        hide();
        const count = markDismissed();
        emit('dismissed', { count });
      }
    } catch (err) {
      console.warn('[Folio install] prompt error:', err);
      hide();
      markDismissed();
      emit('dismissed');
    } finally {
      S.prompt = null;
      S.installing = false;
      if (installBtn) installBtn.classList.remove('loading');
      if (installIcon) installIcon.innerHTML = downloadIcon;
      resumeUpdates();
    }
  }

  function showSuccess() {
    const ov = S.overlayEl || document.getElementById('folio-install-overlay');
    if (!ov) return;

    const card = ov.querySelector('.folio-inst-card');
    if (!card) return;
    card.classList.add('success');

    const iconEl = document.getElementById('folioInstIcon');
    if (iconEl) iconEl.innerHTML = checkIcon;

    const titleEl = card.querySelector('.folio-inst-title');
    if (titleEl) titleEl.textContent = 'Installed';

    const subEl = card.querySelector('.folio-inst-sub');
    if (subEl) subEl.textContent = 'Folio is now on your home screen.';

    const actions = card.querySelector('.folio-inst-actions');
    if (actions) actions.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════════
  // AUTO-WIRE BUTTONS
  // ═══════════════════════════════════════════════════════════

  const DATA = 'data-folio-install-button';

  function showButton(btn) {
    if (!btn) return;
    btn.style.removeProperty('display');
    btn.removeAttribute('hidden');
  }

  function hideButton(btn) {
    if (!btn) return;
    btn.style.display = 'none';
  }

  function wireButton(btn) {
    if (!btn || btn.__folioWired) return;
    btn.__folioWired = true;

    if (!btn.hasChildNodes() || btn.innerHTML.trim() === '') {
      btn.innerHTML = `<span>Install Folio</span>`;
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (isInstalled()) { hideButton(btn); return; }
      if (S.prompt) runInstall();
      else show();
    });
  }

  function updateAllButtons() {
    document.querySelectorAll(`[${DATA}]`).forEach(btn => {
      wireButton(btn);
      if (isInstalled() || !navigator.onLine) hideButton(btn);
      else showButton(btn);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // BROWSER EVENTS
  // ═══════════════════════════════════════════════════════════

  function wireBrowser() {
    if (S.wired) return;
    S.wired = true;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      S.prompt = e;
      emit('ready', { platform: 'chromium' });
      updateAllButtons();

      if (
        CFG.showDialogOnFirstVisit &&
        !S.autoShownThisSession &&
        !isCoolingDown() &&
        !isInstalled() &&
        navigator.onLine
      ) {
        S.autoShownThisSession = true;
        setTimeout(() => {
          if (!S.open && !isInstalled() && navigator.onLine) show();
        }, CFG.autoPromptDelayMs);
      }
    });

    window.addEventListener('appinstalled', () => {
      setInstalled(true);
      clearDismissed();
      if (S.open) showSuccess();
      setTimeout(() => hide(), 1200);
      emit('installed');
      toast('Folio installed', 'success', 2500);
      updateAllButtons();
    });

    window.addEventListener('storage', (e) => {
      if (e.key === KEYS.installed && e.newValue === 'true') {
        hide();
        updateAllButtons();
      }
    });

    window.addEventListener('online', updateAllButtons);
    window.addEventListener('offline', updateAllButtons);

    new MutationObserver((muts) => {
      const added = muts.some(m => {
        for (const n of m.addedNodes || []) {
          if (n.nodeType === 1) {
            if (n.matches?.(`[${DATA}]`)) return true;
            if (n.querySelector?.(`[${DATA}]`)) return true;
          }
        }
        return false;
      });
      if (added) updateAllButtons();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  const API = {
    show,
    hide,
    prompt: runInstall,
    dismiss: tryDismiss,
    isInstalled,
    isStandalone,
    isiOS,
    reset() {
      clearDismissed();
      setInstalled(false);
      try { localStorage.removeItem(KEYS.asked); } catch {}
      S.autoShownThisSession = false;
      if (S.open) hide();
      try { S.overlayEl?.remove(); } catch {}
      S.overlayEl = null;
      if (S.escListener) {
        try { document.removeEventListener('keydown', S.escListener); } catch {}
        S.escListener = null;
      }
      updateAllButtons();
    },
    on,
    off: (ev, fn) => {
      if (S.listeners[ev]) S.listeners[ev] = S.listeners[ev].filter(f => f !== fn);
    },
    _state: S,
    _config: CFG,
  };

  window.FOLIO = window.FOLIO || {};
  window.FOLIO.install = API;

  // ═══════════════════════════════════════════════════════════
  // BOOT
  // ═══════════════════════════════════════════════════════════

  function boot() {
    wireBrowser();
    updateAllButtons();

    if (isiOS() && !isStandalone()) {
      emit('ready', { platform: 'ios' });
      if (
        CFG.showDialogOnFirstVisit &&
        !S.autoShownThisSession &&
        !isCoolingDown() &&
        !isInstalled() &&
        navigator.onLine
      ) {
        S.autoShownThisSession = true;
        setTimeout(() => {
          if (!S.open && !isInstalled() && navigator.onLine) show();
        }, CFG.autoPromptDelayMs + 500);
      }
    }

    if (isInstalled()) emit('installed');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();