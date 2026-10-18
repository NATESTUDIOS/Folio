/* ============================================================
   Folio — install.js
   PWA install prompt manager.

   Usage:
     <script src="/install.js" defer></script>

     // Programmatic:
     FOLIO.install.show();      // open install dialog
     FOLIO.install.prompt();    // trigger native prompt directly
     FOLIO.install.hide();
     FOLIO.install.isInstalled();
     FOLIO.install.reset();     // for testing

   Auto-wires:  [data-folio-install-button]

   Config (set BEFORE this script loads):
     window.FOLIO_INSTALL_CONFIG = {
       cooldownMs: 5 * 60 * 60 * 1000,
       autoPromptDelayMs: 2000,
       showDialogOnFirstVisit: true,
     };
   ============================================================ */
(function () {
  'use strict';

  const CFG = Object.assign({
    cooldownMs: 5 * 60 * 60 * 1000,     // 5h between prompts
    autoPromptDelayMs: 2000,            // delay before first auto-prompt
    showDialogOnFirstVisit: true,
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
    listeners: {},
  };

  /* ── Environment ── */
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
    try { v ? localStorage.setItem(KEYS.installed, 'true')
           : localStorage.removeItem(KEYS.installed); } catch {}
  };

  const isCoolingDown = () => {
    try {
      const raw = localStorage.getItem(KEYS.dismissed);
      if (!raw) return false;
      const { t } = JSON.parse(raw);
      return (Date.now() - t) < CFG.cooldownMs;
    } catch { return false; }
  };

  const markDismissed = () => {
    try { localStorage.setItem(KEYS.dismissed, JSON.stringify({ t: Date.now() })); } catch {}
  };

  const clearDismissed = () => {
    try { localStorage.removeItem(KEYS.dismissed); } catch {}
  };

  /* ── Events ── */
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

  /* ── Toast bridge (uses editor's toast if available) ── */
  const toast = (msg) => {
    try {
      if (typeof window.toast === 'function') window.toast(msg, { type: 'info', duration: 2500 });
      else console.log('[Folio install]', msg);
    } catch {}
  };

  /* ── Update-manager cooperation ── */
  const pauseUpdates  = () => { try { window.__updateManager?.pause?.();  } catch {} };
  const resumeUpdates = () => { try { window.__updateManager?.resume?.(); } catch {} };

  /* ── CSS ── */
  function injectStyles() {
    if (S.stylesInjected || document.getElementById('folio-install-style')) {
      S.stylesInjected = true; return;
    }
    const css = `
      .folio-inst {
        position: fixed; inset: 0; z-index: 999990;
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
        background: rgba(10, 12, 16, 0.72);
        backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
        opacity: 0; pointer-events: none;
        transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
        font-family: var(--font-sans, "Inter", -apple-system, system-ui, sans-serif);
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
        transition: transform 260ms cubic-bezier(0.16, 1, 0.3, 1);
        position: relative;
      }
      .folio-inst.open .folio-inst-card { transform: scale(1) translateY(0); }
      .folio-inst-icon {
        width: 60px; height: 60px; margin: 0 auto 14px;
        border-radius: 16px;
        background: rgba(245, 158, 11, 0.14);
        border: 1px solid rgba(245, 158, 11, 0.30);
        display: flex; align-items: center; justify-content: center;
        color: #F59E0B;
      }
      .folio-inst-icon svg {
        width: 28px; height: 28px;
        stroke: currentColor; fill: none;
        stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
      }
      .folio-inst-title {
        font-size: 18px; font-weight: 700; letter-spacing: -0.3px;
        color: var(--text, #e8ecf1); margin: 0 0 6px; line-height: 1.25;
      }
      .folio-inst-sub {
        font-size: 13px; line-height: 1.55;
        color: var(--text-muted, #a8b0bc); margin: 0 0 18px;
      }
      .folio-inst-list {
        display: flex; flex-direction: column; gap: 8px;
        margin: 0 0 20px; padding: 12px 14px;
        background: var(--bg-input, #1a1f2a);
        border: 1px solid var(--border, #222831);
        border-radius: 12px; text-align: left;
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
      .folio-inst-actions { display: flex; flex-direction: column; gap: 8px; }
      .folio-inst-btn {
        font-family: inherit; font-size: 13.5px; font-weight: 600;
        padding: 12px 16px; border-radius: 12px;
        border: 1px solid transparent;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        gap: 6px; transition: all 120ms ease;
        touch-action: manipulation; user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      .folio-inst-btn.primary {
        background: #F59E0B; color: #0a0c10;
        box-shadow: 0 6px 20px rgba(245, 158, 11, 0.30);
      }
      .folio-inst-btn.primary:hover { background: #fbbf24; }
      .folio-inst-btn.ghost {
        background: transparent;
        color: var(--text-muted, #a8b0bc);
        border-color: var(--border, #222831);
      }
      .folio-inst-btn.ghost:hover { color: var(--text, #e8ecf1); background: var(--bg-input, #1a1f2a); }
      .folio-inst-btn:active { transform: scale(0.97); }
      .folio-inst-btn:focus-visible { outline: 2px solid #F59E0B; outline-offset: 2px; }
      .folio-inst-btn svg {
        width: 14px; height: 14px;
        stroke: currentColor; fill: none; stroke-width: 2.2;
        stroke-linecap: round; stroke-linejoin: round;
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
          content: ''; position: absolute; top: 8px; left: 50%;
          transform: translateX(-50%);
          width: 36px; height: 4px; border-radius: 4px;
          background: var(--border, #222831);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .folio-inst, .folio-inst-card, .folio-inst-btn { transition-duration: 0.01ms !important; }
      }
    `;
    const s = document.createElement('style');
    s.id = 'folio-install-style';
    s.textContent = css;
    document.head.appendChild(s);
    S.stylesInjected = true;
  }

  /* ── Dialog markup ── */
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

  function buildStandardHTML() {
    return `
      <div class="folio-inst-card" role="dialog" aria-modal="true" aria-labelledby="folio-inst-title">
        <div class="folio-inst-icon">${downloadIcon}</div>
        <h3 class="folio-inst-title" id="folio-inst-title">Install Folio</h3>
        <p class="folio-inst-sub">Code from your pocket — offline, fast, always with you.</p>
        <div class="folio-inst-list">
          ${checkRow('Works fully offline')}
          ${checkRow('Instant launch — no browser tab')}
          ${checkRow('Projects stored on your device')}
        </div>
        <div class="folio-inst-actions">
          <button class="folio-inst-btn primary" data-folio-action="install">
            ${downloadIcon}<span>Install</span>
          </button>
          <button class="folio-inst-btn ghost" data-folio-action="dismiss">Not now</button>
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
          <button class="folio-inst-btn ghost" data-folio-action="dismiss">Got it</button>
        </div>
      </div>`;
  }

  /* ── Inject overlay ── */
  function ensureOverlay() {
    let ov = document.getElementById('folio-install-overlay');
    if (ov) return ov;

    ov = document.createElement('div');
    ov.className = 'folio-inst';
    ov.id = 'folio-install-overlay';
    ov.innerHTML = (isiOS() && !isStandalone()) ? buildIOSHTML() : buildStandardHTML();
    document.body.appendChild(ov);

    ov.querySelectorAll('[data-folio-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const a = btn.dataset.folioAction;
        if (a === 'install') runInstall();
        else if (a === 'dismiss') dismissDialog();
      });
    });

    ov.addEventListener('click', (e) => { if (e.target === ov) dismissDialog(); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.open) dismissDialog();
    });

    return ov;
  }

  /* ── Show / hide / dismiss ── */
  function show() {
    if (isInstalled()) return false;
    injectStyles();
    const ov = ensureOverlay();
    document.body.style.overflow = 'hidden';
    void ov.offsetWidth;
    ov.classList.add('open');
    S.open = true;
    try { localStorage.setItem(KEYS.asked, 'true'); } catch {}
    emit('open');
    return true;
  }

  function hide() {
    const ov = document.getElementById('folio-install-overlay');
    if (!ov) return;
    ov.classList.remove('open');
    document.body.style.overflow = '';
    S.open = false;
    emit('close');
  }

  function dismissDialog() {
    haptic();
    hide();
    markDismissed();
    emit('dismissed');
    setTimeout(() => toast('You can install Folio anytime from Settings'), 220);
  }

  /* ── Install trigger ── */
  async function runInstall() {
    if (isInstalled()) { hide(); return; }

    if (isiOS() && !isStandalone()) {
      if (!S.open) show();  // already shows iOS instructions
      return;
    }

    if (!S.prompt) {
      if (!S.open) show();   // dialog explains browser fallback
      emit('unavailable');
      return;
    }

    if (S.installing) return;
    S.installing = true;
    haptic();
    pauseUpdates();

    try {
      S.prompt.prompt();
      emit('prompt-open');
      const { outcome } = await S.prompt.userChoice;
      emit('prompt-close', { outcome });

      if (outcome === 'accepted') {
        setInstalled(true);
        clearDismissed();
        hide();
        emit('installed');
        toast('Folio installed');
        updateAllButtons();
      } else {
        dismissDialog();
      }
    } catch (err) {
      console.warn('[Folio install] prompt error:', err);
      dismissDialog();
    } finally {
      S.prompt = null;
      S.installing = false;
      resumeUpdates();
    }
  }

  /* ── Button auto-wiring ── */
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
      if (isInstalled()) hideButton(btn);
      else showButton(btn);
    });
  }

  /* ── Wire browser events ── */
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
        !isInstalled()
      ) {
        S.autoShownThisSession = true;
        setTimeout(() => {
          if (!S.open && !isInstalled()) show();
        }, CFG.autoPromptDelayMs);
      }
    });

    window.addEventListener('appinstalled', () => {
      setInstalled(true);
      clearDismissed();
      hide();
      emit('installed');
      toast('Folio installed');
      updateAllButtons();
    });

    // Same-tab detection of install in another tab
    window.addEventListener('storage', (e) => {
      if (e.key === KEYS.installed && e.newValue === 'true') {
        hide();
        updateAllButtons();
      }
    });

    // Dynamically added buttons
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

  /* ── Public API ── */
  const API = {
    show, hide,
    prompt: runInstall,
    dismiss: dismissDialog,
    isInstalled,
    isStandalone,
    isiOS,
    reset() {
      clearDismissed();
      setInstalled(false);
      try { localStorage.removeItem(KEYS.asked); } catch {}
      S.autoShownThisSession = false;
      updateAllButtons();
    },
    on, off: (ev, fn) => {
      if (S.listeners[ev]) S.listeners[ev] = S.listeners[ev].filter(f => f !== fn);
    },
    _state: S, _config: CFG,
  };

  window.FOLIO = window.FOLIO || {};
  window.FOLIO.install = API;

  /* ── Boot ── */
  function boot() {
    wireBrowser();
    updateAllButtons();

    if (isiOS() && !isStandalone()) {
      emit('ready', { platform: 'ios' });
      if (
        CFG.showDialogOnFirstVisit &&
        !S.autoShownThisSession &&
        !isCoolingDown() &&
        !isInstalled()
      ) {
        S.autoShownThisSession = true;
        setTimeout(() => {
          if (!S.open && !isInstalled()) show();
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