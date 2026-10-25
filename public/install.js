/* ============================================================
   Folio — install.js
   Play Store–style install prompt. Theme-aware, self-contained CSS.

   API:
     FOLIO.install.show()
     FOLIO.install.prompt()
     FOLIO.install.hide()
     FOLIO.install.isInstalled()
     FOLIO.install.reset()

   Auto-wires: [data-folio-install-button]

   Config (set BEFORE this script loads):
     window.FOLIO_INSTALL_CONFIG = {
       dismissCountdownMs: 5000,
       cooldowns: [5h, 24h, 7d, Infinity],
       autoPromptDelayMs: 2000,
       showDialogOnFirstVisit: true,
       screenshots: [...],
       appName: 'Folio',
       developer: 'Folio Labs',
       description: '...',
       version: '2026.10.19',
       updated: 'Oct 19, 2026',
       size: '~2 MB',
       icon: '/icons/icon-192.png',
     };
   ============================================================ */
(function () {
  'use strict';

  const CFG = Object.assign({
    dismissCountdownMs: 5000,
    cooldowns: [
      5 * 60 * 60 * 1000,
      24 * 60 * 60 * 1000,
      7 * 24 * 60 * 60 * 1000,
      Infinity,
    ],
    autoPromptDelayMs: 2000,
    showDialogOnFirstVisit: true,
    screenshots: [
      '/screenshots/screenshot1.png',
      '/screenshots/screenshot2.png',
      '/screenshots/screenshot3.png',
      '/screenshots/screenshot4.png',
      '/screenshots/screenshot5.png',
      '/screenshots/screenshot6.png',
    ],
    appName: 'Folio',
    developer: 'Folio Labs',
    description: 'Code from your pocket. A fast, offline-first editor with your projects stored on-device — instant launch, no browser tab, no account required.',
    version: '2026.10.19',
    updated: 'Oct 19, 2026',
    size: '~2 MB',
    icon: '/icons/icon-192.png',
    features: ['Works offline', 'Instant launch', 'Local projects', 'No account'],
    rating: '4.8',
    downloads: '1K+',
  }, window.FOLIO_INSTALL_CONFIG || {});

  const KEYS = {
    dismissed: 'folio.install.dismissed',
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
    scrimEl: null,
    escListener: null,
    shotsBuilt: false,
    cachedDismissState: null,   // ← cache readDismissState per show()
  };

  // ═══════════════════════════════════════════════════════════
  // ENVIRONMENT
  // ═══════════════════════════════════════════════════════════

  const isStandalone = () =>
    matchMedia?.('(display-mode: standalone)').matches ||
    navigator.standalone === true ||
    document.referrer?.startsWith('android-app://');

  const isiOS = () =>
    (/iPad|iPhone|iPod/.test(navigator.userAgent || '') && !window.MSStream) ||
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
    try {
      if (document.documentElement.getAttribute('data-reduced-motion') === 'true') return true;
    } catch {}
    return matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
  };

  // ═══════════════════════════════════════════════════════════
  // DISMISS STATE (cached)
  // ═══════════════════════════════════════════════════════════

  function readDismissState() {
    if (S.cachedDismissState) return S.cachedDismissState;
    try {
      const raw = localStorage.getItem(KEYS.dismissed);
      if (!raw) {
        S.cachedDismissState = { t: 0, count: 0 };
        return S.cachedDismissState;
      }
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'number') {
        S.cachedDismissState = { t: parsed, count: 1 };
      } else {
        S.cachedDismissState = {
          t: parsed?.t || 0,
          count: Math.max(0, parseInt(parsed?.count || 0, 10) || 0),
        };
      }
    } catch {
      S.cachedDismissState = { t: 0, count: 0 };
    }
    return S.cachedDismissState;
  }

  function invalidateDismissCache() {
    S.cachedDismissState = null;
  }

  function markDismissed() {
    invalidateDismissCache();
    const state = readDismissState();
    const next = { t: Date.now(), count: state.count + 1 };
    try { localStorage.setItem(KEYS.dismissed, JSON.stringify(next)); } catch {}
    invalidateDismissCache();
    return next.count;
  }

  function clearDismissed() {
    invalidateDismissCache();
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

  const toast = (msg, type = 'info', duration = 2500) => {
    try {
      if (typeof window.toast === 'function') window.toast(msg, type, duration);
      else console.log('[Folio install]', msg);
    } catch {}
  };

  const pauseUpdates  = () => { try { window.FOLIO?.update?.pause?.(); } catch {} };
  const resumeUpdates = () => { try { window.FOLIO?.update?.resume?.(); } catch {} };

  // ═══════════════════════════════════════════════════════════
  // STYLES — theme-token aware, self-contained
  // ═══════════════════════════════════════════════════════════

  function injectStyles() {
    if (S.stylesInjected || document.getElementById('folio-install-style')) {
      S.stylesInjected = true;
      return;
    }

    const css = `
      /* ─── Theme tokens ─────────────────────────────────────── */
      :root {
        --folio-inst-accent: var(--theme-success, #34a853);
        --folio-inst-accent-hover: #46b960;
        --folio-inst-on-accent: #000000;
        --folio-inst-bg: var(--theme-surface, #000000);
        --folio-inst-surface-1: var(--theme-surface-card-solid, #131314);
        --folio-inst-surface-2: var(--theme-surface-elevated, #1f1f1f);
        --folio-inst-border: var(--theme-divider, #1e1e1e);
        --folio-inst-border-2: var(--theme-card-border, #2a2a2a);
        --folio-inst-border-3: var(--theme-glass-border, #3a3a3a);
        --folio-inst-text-1: var(--theme-text, #ffffff);
        --folio-inst-text-2: var(--theme-text-secondary, #e3e3e3);
        --folio-inst-text-3: var(--theme-text-tertiary, #9aa0a6);
        --folio-inst-text-4: rgba(154, 160, 166, 0.65);
        --folio-inst-scrim: rgba(0, 0, 0, 0.65);
        --folio-inst-font: var(--font, "Inter", -apple-system, "Roboto", "Segoe UI", system-ui, sans-serif);
      }
      [data-theme="light"] {
        --folio-inst-bg: var(--theme-surface, #ffffff);
        --folio-inst-surface-1: var(--theme-surface-card-solid, #f7f8fa);
        --folio-inst-surface-2: var(--theme-surface-elevated, #eef0f4);
        --folio-inst-border: var(--theme-divider, rgba(0,0,0,0.08));
        --folio-inst-border-2: var(--theme-card-border, rgba(0,0,0,0.10));
        --folio-inst-border-3: var(--theme-glass-border, rgba(0,0,0,0.14));
        --folio-inst-text-1: var(--theme-text, #121316);
        --folio-inst-text-2: var(--theme-text-secondary, rgba(18,19,22,0.72));
        --folio-inst-text-3: var(--theme-text-tertiary, rgba(18,19,22,0.48));
        --folio-inst-text-4: rgba(18, 19, 22, 0.40);
        --folio-inst-scrim: rgba(18, 19, 22, 0.45);
        --folio-inst-on-accent: #ffffff;
      }

      /* ─── Scrim ───────────────────────────────────────────── */
      .folio-inst-scrim {
        position: fixed; inset: 0; z-index: 999990;
        background: var(--folio-inst-scrim);
        opacity: 0; pointer-events: none;
        transition: opacity 220ms ease;
      }
      .folio-inst-scrim.open { opacity: 1; pointer-events: auto; }

      /* ─── Sheet ───────────────────────────────────────────── */
      .folio-inst {
        position: fixed;
        left: 0; right: 0; bottom: 0;
        z-index: 999991;
        background: var(--folio-inst-bg);
        border-top-left-radius: 28px;
        border-top-right-radius: 28px;
        max-width: 500px;
        margin: 0 auto;
        transform: translateY(100%);
        transition: transform 320ms cubic-bezier(0.16, 1, 0.3, 1);
        max-height: 90vh;
        display: flex; flex-direction: column;
        overflow: hidden;
        font-family: var(--folio-inst-font);
        font-feature-settings: "cv11", "ss01";
        -webkit-font-smoothing: antialiased;
        text-rendering: optimizeLegibility;
        color: var(--folio-inst-text-2);
        line-height: 1.45;
        border: 1px solid var(--folio-inst-border);
        border-bottom: none;
      }
      .folio-inst.open { transform: translateY(0); }

      /* ─── Handle ──────────────────────────────────────────── */
      .folio-inst-handle-wrap {
        display: flex; justify-content: center;
        padding: 10px 0 4px;
        flex-shrink: 0;
      }
      .folio-inst-handle {
        width: 32px; height: 4px;
        border-radius: 4px;
        background: var(--folio-inst-border-3);
      }

      /* ─── Header ──────────────────────────────────────────── */
      .folio-inst-head {
        display: flex; gap: 16px; align-items: flex-start;
        padding: 8px 20px 16px;
        flex-shrink: 0;
      }
      .folio-inst-icon {
        width: 72px; height: 72px;
        border-radius: 16px;
        flex-shrink: 0;
        background: var(--folio-inst-text-1);
        color: var(--folio-inst-bg);
        display: flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 34px;
        letter-spacing: -1.5px;
        position: relative;
        overflow: hidden;
        border: 1px solid var(--folio-inst-border);
      }
      .folio-inst-icon img {
        position: absolute; inset: 0;
        width: 100%; height: 100%;
        object-fit: cover;
        display: block;
        opacity: 0;
        transition: opacity 220ms ease;
      }
      .folio-inst-icon img.loaded { opacity: 1; }
      .folio-inst-icon .letter {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
      }
      .folio-inst-icon.has-logo .letter { display: none; }

      .folio-inst-meta { flex: 1; min-width: 0; padding-top: 2px; }
      .folio-inst-name {
        font-size: 22px; font-weight: 600;
        letter-spacing: -0.4px; line-height: 1.15;
        color: var(--folio-inst-text-1); margin: 0 0 4px;
      }
      .folio-inst-dev {
        font-size: 13px; color: var(--folio-inst-accent);
        font-weight: 500; margin: 0 0 8px;
        letter-spacing: 0.05px;
      }
      .folio-inst-stats {
        display: flex; align-items: center; gap: 12px;
        font-size: 12px; color: var(--folio-inst-text-3);
        font-weight: 400; letter-spacing: 0.05px;
      }
      .folio-inst-stats .stat { display: flex; align-items: center; gap: 4px; }
      .folio-inst-stats svg {
        width: 11px; height: 11px;
        fill: var(--folio-inst-text-3); stroke: none;
      }
      .folio-inst-stats .divider {
        width: 1px; height: 11px; background: var(--folio-inst-border-2);
      }

      /* ─── Install button ──────────────────────────────────── */
      .folio-inst-cta-row { padding: 0 20px 16px; flex-shrink: 0; }
      .folio-inst-cta {
        width: 100%;
        font-family: inherit;
        font-size: 14.5px; font-weight: 500;
        letter-spacing: 0.1px;
        padding: 13px 20px;
        background: var(--folio-inst-accent);
        color: var(--folio-inst-on-accent);
        border: none; border-radius: 100px;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        gap: 8px;
        transition: background 140ms ease, transform 120ms ease;
      }
      .folio-inst-cta:hover:not(:disabled) { background: var(--folio-inst-accent-hover); }
      .folio-inst-cta:active:not(:disabled) { transform: scale(0.99); }
      .folio-inst-cta:disabled { cursor: default; }
      .folio-inst-cta svg {
        width: 16px; height: 16px;
        stroke: currentColor; fill: none;
        stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round;
      }
      .folio-inst-cta.loading svg { animation: folioInstSpin 0.9s linear infinite; }
      @keyframes folioInstSpin { to { transform: rotate(360deg); } }

      /* ─── Body ────────────────────────────────────────────── */
      .folio-inst-body {
        overflow-y: auto; overflow-x: hidden;
        flex: 1; min-height: 0;
        scrollbar-width: none;
      }
      .folio-inst-body::-webkit-scrollbar { display: none; }

      /* ─── Screenshots ─────────────────────────────────────── */
      .folio-inst-shots-wrap { padding: 4px 0 20px; flex-shrink: 0; }
      .folio-inst-shots {
        display: flex; gap: 10px;
        overflow-x: auto;
        scroll-snap-type: x mandatory;
        scroll-padding-inline: 20px;
        padding: 0 0 0 20px;
        margin: 0;
        scrollbar-width: none;
      }
      .folio-inst-shots::-webkit-scrollbar { display: none; }
      .folio-inst-shots::after { content: ''; flex: 0 0 12px; }

      .folio-inst-shot {
        flex: 0 0 auto;
        width: 156px; height: 278px;
        border-radius: 12px;
        scroll-snap-align: start;
        border: 1px solid var(--folio-inst-border);
        overflow: hidden;
        background: var(--folio-inst-surface-1);
        position: relative;
      }
      .folio-inst-shot img {
        position: absolute; inset: 0;
        width: 100%; height: 100%;
        object-fit: cover;
        display: block;
        opacity: 0;
        transition: opacity 260ms ease;
      }
      .folio-inst-shot img.loaded { opacity: 1; }
      .folio-inst-shot-skel {
        position: absolute; inset: 0;
        background: linear-gradient(100deg,
          rgba(255,255,255,0.02) 30%,
          rgba(255,255,255,0.06) 50%,
          rgba(255,255,255,0.02) 70%);
        background-size: 200% 100%;
        animation: folioInstShimmer 1.6s linear infinite;
        transition: opacity 260ms ease;
      }
      [data-theme="light"] .folio-inst-shot-skel {
        background: linear-gradient(100deg,
          rgba(0,0,0,0.02) 30%,
          rgba(0,0,0,0.06) 50%,
          rgba(0,0,0,0.02) 70%);
        background-size: 200% 100%;
      }
      .folio-inst-shot.loaded .folio-inst-shot-skel { opacity: 0; pointer-events: none; }
      .folio-inst-shot.error .folio-inst-shot-skel {
        animation: none;
        background: var(--folio-inst-surface-2);
      }
      .folio-inst-shot.error::after {
        content: '';
        position: absolute; inset: 0;
        background: repeating-linear-gradient(45deg,
          transparent 0 7px,
          rgba(255,255,255,0.02) 7px 8px);
        pointer-events: none;
      }
      @keyframes folioInstShimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }

      /* ─── Sections ────────────────────────────────────────── */
      .folio-inst-section {
        padding: 16px 20px;
        border-top: 1px solid var(--folio-inst-border);
      }
      .folio-inst-section-title {
        font-size: 15.5px; font-weight: 600;
        letter-spacing: -0.1px;
        color: var(--folio-inst-text-1); margin: 0 0 10px;
      }
      .folio-inst-about {
        font-size: 13.5px; color: var(--folio-inst-text-2);
        line-height: 1.6; margin: 0;
        letter-spacing: 0.05px;
      }
      .folio-inst-chips {
        display: flex; flex-wrap: wrap; gap: 8px;
        margin-top: 2px;
      }
      .folio-inst-chip {
        display: inline-flex; align-items: center;
        padding: 8px 14px;
        background: transparent;
        border: 1px solid var(--folio-inst-border-2);
        border-radius: 100px;
        font-size: 12.5px; font-weight: 500;
        color: var(--folio-inst-text-2);
        letter-spacing: 0.05px;
      }
      .folio-inst-data {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px 24px;
        margin-top: 4px;
      }
      .folio-inst-data-cell .label {
        font-size: 11px; color: var(--folio-inst-text-4);
        font-weight: 500; margin-bottom: 3px;
        letter-spacing: 0.2px;
      }
      .folio-inst-data-cell .value {
        font-size: 13px; color: var(--folio-inst-text-2);
        font-weight: 400;
        letter-spacing: 0.05px;
      }

      /* ─── iOS steps ───────────────────────────────────────── */
      .folio-inst-steps {
        display: flex; flex-direction: column; gap: 12px;
        padding: 16px 20px;
        border-top: 1px solid var(--folio-inst-border);
      }
      .folio-inst-step {
        display: flex; gap: 12px; align-items: flex-start;
        font-size: 13.5px; line-height: 1.55;
        color: var(--folio-inst-text-2);
      }
      .folio-inst-step b { color: var(--folio-inst-text-1); font-weight: 600; }
      .folio-inst-num {
        flex-shrink: 0;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: var(--folio-inst-accent);
        color: var(--folio-inst-on-accent);
        font-size: 12px; font-weight: 700;
        display: flex; align-items: center; justify-content: center;
        margin-top: 1px;
      }

      /* ─── Footer ──────────────────────────────────────────── */
      .folio-inst-footer {
        padding: 10px 20px calc(14px + env(safe-area-inset-bottom, 0px));
        background: var(--folio-inst-bg);
        border-top: 1px solid var(--folio-inst-border);
        flex-shrink: 0;
      }
      .folio-inst-dismiss {
        width: 100%;
        font-family: inherit;
        font-size: 13px; font-weight: 500;
        letter-spacing: 0.1px;
        padding: 10px 16px;
        background: transparent;
        color: var(--folio-inst-text-3);
        border: 1px solid var(--folio-inst-border-2);
        border-radius: 100px;
        cursor: pointer;
        transition: color 160ms ease, background 160ms ease, border-color 160ms ease;
      }
      .folio-inst-dismiss:hover:not(:disabled) {
        color: var(--folio-inst-text-1);
        background: var(--folio-inst-surface-1);
        border-color: var(--folio-inst-border-3);
      }
      .folio-inst-dismiss:disabled { opacity: 0.45; cursor: not-allowed; }

      /* ─── Success state ───────────────────────────────────── */
      .folio-inst.success .folio-inst-cta {
        background: var(--folio-inst-accent);
        color: var(--folio-inst-on-accent);
        cursor: default;
      }

      /* ─── Mobile ──────────────────────────────────────────── */
      @media (max-width: 480px) {
        .folio-inst { max-width: 100%; border-radius: 24px 24px 0 0; }
        .folio-inst-head { padding: 6px 16px 14px; gap: 14px; }
        .folio-inst-icon { width: 64px; height: 64px; font-size: 30px; border-radius: 14px; }
        .folio-inst-name { font-size: 20px; }
        .folio-inst-cta-row { padding: 0 16px 14px; }
        .folio-inst-shots { scroll-padding-inline: 16px; padding-left: 16px; }
        .folio-inst-section, .folio-inst-steps { padding-left: 16px; padding-right: 16px; }
        .folio-inst-footer { padding: 8px 16px calc(12px + env(safe-area-inset-bottom, 0px)); }
        .folio-inst-shot { width: 144px; height: 260px; }
      }

      /* ─── Reduced motion ──────────────────────────────────── */
      @media (prefers-reduced-motion: reduce) {
        .folio-inst, .folio-inst-scrim,
        .folio-inst-cta, .folio-inst-dismiss,
        .folio-inst-shot img, .folio-inst-shot-skel,
        .folio-inst-icon img {
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
        }
      }
      html[data-reduced-motion="true"] .folio-inst-shot-skel,
      html[data-reduced-motion="true"] .folio-inst-cta.loading svg {
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
  // MARKUP
  // ═══════════════════════════════════════════════════════════

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

  const starIcon = `<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

  function buildStandardHTML() {
    const chips = (CFG.features || []).map(f => `<span class="folio-inst-chip">${f}</span>`).join('');
    return `
      <div class="folio-inst-handle-wrap"><div class="folio-inst-handle"></div></div>

      <div class="folio-inst-head">
        <div class="folio-inst-icon" id="folioInstIcon">
          <div class="letter">${(CFG.appName || 'F').charAt(0).toUpperCase()}</div>
          <img src="${CFG.icon}" alt="${CFG.appName}" decoding="async"
               onload="this.classList.add('loaded');this.parentElement.classList.add('has-logo')">
        </div>
        <div class="folio-inst-meta">
          <h2 class="folio-inst-name" id="folio-inst-title">${CFG.appName}</h2>
          <p class="folio-inst-dev">${CFG.developer}</p>
          <div class="folio-inst-stats">
            <span class="stat">${CFG.rating} ${starIcon}</span>
            <span class="divider"></span>
            <span class="stat">${CFG.downloads} downloads</span>
          </div>
        </div>
      </div>

      <div class="folio-inst-cta-row">
        <button class="folio-inst-cta" id="folioInstCta" data-folio-action="install">
          <span id="folioInstCtaIcon">${downloadIcon}</span>
          <span id="folioInstCtaLabel">Install</span>
        </button>
      </div>

      <div class="folio-inst-body" id="folioInstBody">
        <div class="folio-inst-shots-wrap">
          <div class="folio-inst-shots" id="folioInstShots"></div>
        </div>

        <div class="folio-inst-section">
          <h3 class="folio-inst-section-title">About this app</h3>
          <p class="folio-inst-about">${CFG.description}</p>
        </div>

        <div class="folio-inst-section">
          <h3 class="folio-inst-section-title">What's inside</h3>
          <div class="folio-inst-chips">${chips}</div>
        </div>

        <div class="folio-inst-section">
          <h3 class="folio-inst-section-title">App info</h3>
          <div class="folio-inst-data">
            <div class="folio-inst-data-cell">
              <div class="label">Updated on</div>
              <div class="value">${CFG.updated}</div>
            </div>
            <div class="folio-inst-data-cell">
              <div class="label">Size</div>
              <div class="value">${CFG.size}</div>
            </div>
            <div class="folio-inst-data-cell">
              <div class="label">Version</div>
              <div class="value">${CFG.version}</div>
            </div>
            <div class="folio-inst-data-cell">
              <div class="label">Works on</div>
              <div class="value">Any browser</div>
            </div>
          </div>
        </div>
      </div>

      <div class="folio-inst-footer">
        <button class="folio-inst-dismiss" id="folioInstDismissBtn" data-folio-action="dismiss" disabled>
          Not now
        </button>
      </div>
    `;
  }

  function buildIOSHTML() {
    return `
      <div class="folio-inst-handle-wrap"><div class="folio-inst-handle"></div></div>

      <div class="folio-inst-head">
        <div class="folio-inst-icon" id="folioInstIcon">
          <div class="letter">${(CFG.appName || 'F').charAt(0).toUpperCase()}</div>
          <img src="${CFG.icon}" alt="${CFG.appName}" decoding="async"
               onload="this.classList.add('loaded');this.parentElement.classList.add('has-logo')">
        </div>
        <div class="folio-inst-meta">
          <h2 class="folio-inst-name" id="folio-inst-title">${CFG.appName}</h2>
          <p class="folio-inst-dev">${CFG.developer}</p>
          <div class="folio-inst-stats">
            <span class="stat">${CFG.rating} ${starIcon}</span>
            <span class="divider"></span>
            <span class="stat">${CFG.downloads} downloads</span>
          </div>
        </div>
      </div>

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

      <div class="folio-inst-footer">
        <button class="folio-inst-dismiss" id="folioInstDismissBtn" data-folio-action="dismiss" disabled>
          Got it
        </button>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════
  // SCREENSHOT BUILDER
  // ═══════════════════════════════════════════════════════════

  function buildShots(container) {
    if (!container || S.shotsBuilt) return;
    S.shotsBuilt = true;
    container.innerHTML = '';

    (CFG.screenshots || []).forEach((src, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'folio-inst-shot';

      const skel = document.createElement('div');
      skel.className = 'folio-inst-shot-skel';
      wrap.appendChild(skel);

      const img = document.createElement('img');
      img.alt = `${CFG.appName} screenshot ${i + 1}`;
      img.decoding = 'async';
      img.loading = 'lazy';

      img.addEventListener('load', () => {
        img.classList.add('loaded');
        wrap.classList.add('loaded');
      });
      img.addEventListener('error', () => {
        wrap.classList.add('error');
      });

      wrap.appendChild(img);
      container.appendChild(wrap);
      img.src = src;
    });
  }

  // ═══════════════════════════════════════════════════════════
  // OVERLAY
  // ═══════════════════════════════════════════════════════════

  function ensureOverlay() {
    if (S.overlayEl && document.body.contains(S.overlayEl)) return S.overlayEl;

    injectStyles();

    const scrim = document.createElement('div');
    scrim.className = 'folio-inst-scrim';
    scrim.id = 'folio-install-scrim';
    document.body.appendChild(scrim);
    S.scrimEl = scrim;

    const ov = document.createElement('div');
    ov.className = 'folio-inst';
    ov.id = 'folio-install-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'folio-inst-title');
    ov.innerHTML = (isiOS() && !isStandalone()) ? buildIOSHTML() : buildStandardHTML();
    document.body.appendChild(ov);
    S.overlayEl = ov;

    const shotsEl = ov.querySelector('#folioInstShots');
    if (shotsEl) buildShots(shotsEl);

    ov.querySelectorAll('[data-folio-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const a = btn.dataset.folioAction;
        if (a === 'install') runInstall();
        else if (a === 'dismiss') tryDismiss();
      });
    });

    scrim.addEventListener('click', tryDismiss);

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

    // ✅ FIX: was silent `return false` on offline. Now toasts.
    if (!navigator.onLine) {
      toast('Connect to the internet to install', 'warning', 3000);
      return false;
    }

    injectStyles();
    const ov = ensureOverlay();
    document.body.style.overflow = 'hidden';
    if (S.scrimEl) S.scrimEl.classList.add('open');
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
    if (S.scrimEl) S.scrimEl.classList.remove('open');
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
    if (btn && btn.disabled) return;
    haptic();
    hide();
    const count = markDismissed();
    emit('dismissed', { count });
    setTimeout(() => toast('You can install anytime from Settings', 'info', 3000), 220);
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

    const cta = document.getElementById('folioInstCta');
    const ctaIcon = document.getElementById('folioInstCtaIcon');
    const ctaLabel = document.getElementById('folioInstCtaLabel');
    const dismissBtn = document.getElementById('folioInstDismissBtn');

    if (cta) cta.classList.add('loading');
    if (ctaIcon) ctaIcon.innerHTML = spinnerIcon;
    if (ctaLabel) ctaLabel.textContent = 'Installing…';
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
        toast('Installed', 'success', 2500);
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
      if (cta) cta.classList.remove('loading');
      if (ctaIcon) ctaIcon.innerHTML = downloadIcon;
      if (ctaLabel) ctaLabel.textContent = 'Install';
      resumeUpdates();
    }
  }

  function showSuccess() {
    const ov = S.overlayEl || document.getElementById('folio-install-overlay');
    if (!ov) return;

    ov.classList.add('success');

    const cta = document.getElementById('folioInstCta');
    const ctaIcon = document.getElementById('folioInstCtaIcon');
    const ctaLabel = document.getElementById('folioInstCtaLabel');
    if (cta) cta.disabled = true;
    if (ctaIcon) ctaIcon.innerHTML = checkIcon;
    if (ctaLabel) ctaLabel.textContent = 'Installed';

    const dismissBtn = document.getElementById('folioInstDismissBtn');
    if (dismissBtn) {
      dismissBtn.textContent = 'Close';
      dismissBtn.disabled = false;
    }
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
      btn.innerHTML = `<span>Install</span>`;
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
      toast('Installed', 'success', 2500);
      updateAllButtons();
    });

    window.addEventListener('storage', (e) => {
      if (e.key === KEYS.installed && e.newValue === 'true') {
        hide();
        updateAllButtons();
      }
      if (e.key === KEYS.dismissed) invalidateDismissCache();
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
      try { S.scrimEl?.remove(); } catch {}
      S.overlayEl = null;
      S.scrimEl = null;
      S.shotsBuilt = false;
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