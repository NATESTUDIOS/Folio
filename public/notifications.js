/* ============================================================
   Folio — notifications.js
   Injects:
     • header bell button + unread dot
     • "Enable notifications" prompt dialog (5s dismiss lock, escalating cooldown)
     • notification panel (dropdown desktop / bottom sheet mobile)
     • unread polling + cross-tab sync

   Requires:
     • /fcm-client.js loaded first  (FOLIO.fcm API)
     • /firebase-messaging-sw.js registered (in index.html)
     • user signed in (folio.session in localStorage)

   Usage:
     FOLIO.notifications.open()
     FOLIO.notifications.close()
     FOLIO.notifications.refresh()
     FOLIO.notifications.isEnabled()
     FOLIO.notifications.getUnreadCount()
     FOLIO.notifications.on('change', fn)
   ============================================================ */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════════════════════════

  const CFG = Object.assign({
    promptCooldownMs: 6 * 60 * 60 * 1000,       // 6h after 1st dismiss
    escalatingCooldowns: [                       // then 24h, then 7d, then never
      6 * 60 * 60 * 1000,
      24 * 60 * 60 * 1000,
      7 * 24 * 60 * 60 * 1000,
      Infinity,
    ],
    dismissCountdownMs: 5000,                    // "Not now" disabled for 5s
    pollIntervalMs: 60 * 1000,                   // unread badge poll
    panelRefreshOnOpen: true,
    hideWhenGuest: true,
    autoCheckPermissionMs: 60 * 60 * 1000,       // hourly permission re-check
    listLimit: 20,
  }, window.FOLIO_NOTIFICATIONS_CONFIG || {});

  const API_BASE = 'https://foliostudios.vercel.app/api/notify';
  const STORAGE_SESSION = 'folio.session';
  const LS_KEYS = {
    dismissCount: 'folio.notifPrompt.dismissCount',
    dismissAt:    'folio.notifPrompt.dismissedAt',
    enabledAt:    'folio.notifPrompt.enabledAt',
    panelOpen:    'folio.notifPanel.open',
  };

  const TYPE_LABELS = {
    all: 'All',
    unread: 'Unread',
    project: 'Projects',
    invite: 'Invites',
    system: 'System',
    storage: 'Storage',
    db: 'Database',
    analytics: 'Analytics',
  };

  const TYPE_ICONS = {
    system: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    invite: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    storage: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    analytics: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
  };

  const S = {
    bellEl: null,
    dotEl: null,
    panelEl: null,
    promptEl: null,
    backdropEl: null,
    session: null,
    isGuest: true,
    panelOpen: false,
    promptOpen: false,
    dismissCountdownTimer: null,
    pollTimer: null,
    permissionTimer: null,
    unreadCount: 0,
    stats: null,
    items: [],
    filter: 'all',
    offset: 0,
    limit: CFG.listLimit,
    hasMore: false,
    loading: false,
    fcmSubscribed: false,
    stylesInjected: false,
    listeners: {},
    wired: false,
    bc: null,
    longPressTimer: null,
  };

  // ═══════════════════════════════════════════════════════════
  // UTILS
  // ═══════════════════════════════════════════════════════════

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function svgWrap(body, size = 16, sw = 2.2) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  }

  function relTime(ts) {
    if (!ts) return '—';
    const d = Date.now() - ts;
    if (d < 60_000) return 'just now';
    const m = Math.floor(d / 60_000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    const dd = Math.floor(h / 24);
    if (dd < 7) return dd + 'd';
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function emit(event, detail) {
    (S.listeners[event] || []).forEach(fn => { try { fn(detail); } catch (e) { console.error(e); } });
    try { window.dispatchEvent(new CustomEvent('folio:notifications:' + event, { detail })); } catch {}
  }

  function on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    (S.listeners[event] ||= []).push(fn);
    return () => { S.listeners[event] = S.listeners[event].filter(f => f !== fn); };
  }

  function getSession() {
    try { return localStorage.getItem(STORAGE_SESSION) || null; } catch { return null; }
  }

  function readInt(key, fallback = 0) {
    try {
      const v = localStorage.getItem(key);
      if (v === null) return fallback;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : fallback;
    } catch { return fallback; }
  }

  function writeVal(key, value) {
    try { localStorage.setItem(key, String(value)); } catch {}
  }

  function removeVal(key) {
    try { localStorage.removeItem(key); } catch {}
  }

  function hasReducedMotion() {
    try {
      if (localStorage.getItem('folio.reducedMotion') === 'true') return true;
    } catch {}
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // ═══════════════════════════════════════════════════════════
  // API
  // ═══════════════════════════════════════════════════════════

  async function api(path, opts = {}) {
    const session = getSession();
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (session) headers['Authorization'] = `Bearer ${session}`;
    try {
      const res = await fetch(API_BASE + path, { ...opts, headers });
      let data = {};
      try { data = await res.json(); } catch {}
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: 'NETWORK_ERROR' } };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════

  function injectStyles() {
    if (S.stylesInjected || document.getElementById('folio-notifications-style')) {
      S.stylesInjected = true;
      return;
    }

    const css = `
      /* ── Bell button ─────────────────────────────────────── */
      .folio-notif-bell {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px; height: 28px;
        border-radius: 7px;
        color: var(--theme-text-secondary, #a8b0bc);
        background: var(--theme-glass-bg, rgba(255,255,255,0.05));
        border: 1px solid var(--theme-card-border, rgba(255,255,255,0.08));
        cursor: pointer;
        transition: all 0.15s ease;
        flex-shrink: 0;
      }
      .folio-notif-bell:hover { color: var(--theme-text, #e8ecf1); border-color: var(--theme-primary-glow, rgba(245,158,11,0.4)); }
      .folio-notif-bell:active { transform: scale(0.94); }
      .folio-notif-bell svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }

      .folio-notif-dot {
        position: absolute;
        top: 4px; right: 4px;
        min-width: 8px; height: 8px;
        border-radius: 999px;
        background: #F59E0B;
        box-shadow: 0 0 0 2px var(--theme-surface, #0f1218);
        transform: scale(0);
        transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
        pointer-events: none;
      }
      .folio-notif-dot.visible { transform: scale(1); }
      .folio-notif-dot.count {
        min-width: 16px; height: 16px;
        padding: 0 4px;
        top: -3px; right: -4px;
        color: #0a0c10;
        font-family: var(--font, 'Inter', sans-serif);
        font-size: 9px;
        font-weight: 800;
        line-height: 16px;
        text-align: center;
      }
      .folio-notif-dot.pulse {
        animation: folioNotifDotPulse 1.4s ease-in-out infinite;
      }
      @keyframes folioNotifDotPulse {
        0%, 100% { box-shadow: 0 0 0 2px var(--theme-surface, #0f1218), 0 0 0 0 rgba(245,158,11,0.5); }
        50% { box-shadow: 0 0 0 2px var(--theme-surface, #0f1218), 0 0 0 6px rgba(245,158,11,0); }
      }

      /* ── Panel ───────────────────────────────────────────── */
      .folio-notif-panel {
        position: fixed;
        z-index: 850;
        background: var(--theme-surface-card-solid, #151922);
        border: 1px solid var(--theme-glass-border, rgba(255,255,255,0.09));
        border-radius: 14px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.45);
        display: flex;
        flex-direction: column;
        opacity: 0;
        pointer-events: none;
        transform: translateY(-8px) scale(0.98);
        transition: opacity 0.2s cubic-bezier(0.16,1,0.3,1), transform 0.2s cubic-bezier(0.16,1,0.3,1);
        overflow: hidden;
        max-height: 70vh;
        font-family: var(--font, 'Inter', -apple-system, system-ui, sans-serif);
        color: var(--theme-text, #e8ecf1);
      }
      .folio-notif-panel.open {
        opacity: 1;
        pointer-events: all;
        transform: translateY(0) scale(1);
      }

      .folio-notif-panel-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--theme-divider, rgba(255,255,255,0.08));
        flex-shrink: 0;
      }
      .folio-notif-panel-title {
        font-size: 13.5px;
        font-weight: 800;
        letter-spacing: -0.2px;
        flex: 1;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .folio-notif-panel-title .badge {
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--theme-primary-soft, rgba(245,158,11,0.14));
        color: var(--theme-primary, #F59E0B);
        font-size: 9.5px;
        font-weight: 800;
      }
      .folio-notif-panel-btn {
        width: 26px; height: 26px;
        border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
        cursor: pointer;
        transition: all 0.15s ease;
        flex-shrink: 0;
      }
      .folio-notif-panel-btn:hover { color: var(--theme-text, #e8ecf1); background: var(--theme-glass-bg, rgba(255,255,255,0.05)); }
      .folio-notif-panel-btn svg { width: 13px; height: 13px; stroke: currentColor; fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }

      .folio-notif-tabs {
        display: flex;
        gap: 2px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--theme-divider, rgba(255,255,255,0.08));
        overflow-x: auto;
        scrollbar-width: none;
        flex-shrink: 0;
      }
      .folio-notif-tabs::-webkit-scrollbar { display: none; }
      .folio-notif-tab {
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 10.5px;
        font-weight: 700;
        color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
        background: transparent;
        border: none;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
        transition: all 0.15s ease;
      }
      .folio-notif-tab:hover { color: var(--theme-text, #e8ecf1); background: var(--theme-glass-bg, rgba(255,255,255,0.05)); }
      .folio-notif-tab.active { color: var(--theme-primary, #F59E0B); background: var(--theme-primary-soft, rgba(245,158,11,0.14)); }

      .folio-notif-list {
        flex: 1;
        overflow-y: auto;
        scrollbar-width: thin;
        padding: 6px;
        min-height: 120px;
      }
      .folio-notif-list::-webkit-scrollbar { width: 5px; }
      .folio-notif-list::-webkit-scrollbar-thumb { background: var(--theme-divider, rgba(255,255,255,0.08)); border-radius: 3px; }

      .folio-notif-item {
        display: flex;
        gap: 10px;
        padding: 9px 10px;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.15s ease;
        position: relative;
        text-align: left;
        width: 100%;
        border: none;
        background: transparent;
        color: inherit;
        font-family: inherit;
      }
      .folio-notif-item:hover { background: var(--theme-glass-bg, rgba(255,255,255,0.05)); }
      .folio-notif-item.unread::before {
        content: '';
        position: absolute;
        left: 2px; top: 50%;
        transform: translateY(-50%);
        width: 3px; height: 18px;
        border-radius: 3px;
        background: var(--theme-primary, #F59E0B);
      }
      .folio-notif-item-icon {
        width: 28px; height: 28px;
        border-radius: 8px;
        background: var(--theme-primary-soft, rgba(245,158,11,0.14));
        color: var(--theme-primary, #F59E0B);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .folio-notif-item-icon svg { width: 13px; height: 13px; stroke: currentColor; fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
      .folio-notif-item-icon.invite { background: rgba(16,185,129,0.14); color: #10B981; }
      .folio-notif-item-icon.storage { background: rgba(217,119,6,0.14); color: #D97706; }
      .folio-notif-item-icon.system { background: rgba(59,130,246,0.14); color: #3B82F6; }
      .folio-notif-item-icon.db { background: rgba(59,130,246,0.14); color: #3B82F6; }
      .folio-notif-item-icon.analytics { background: rgba(16,185,129,0.14); color: #10B981; }

      .folio-notif-item-body { flex: 1; min-width: 0; }
      .folio-notif-item-title {
        font-size: 11.5px;
        font-weight: 700;
        margin-bottom: 1px;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;
      }
      .folio-notif-item-text {
        font-size: 10.5px;
        color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .folio-notif-item-time {
        font-size: 9.5px;
        color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
        margin-top: 2px;
      }

      .folio-notif-empty {
        padding: 32px 16px;
        text-align: center;
        color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
      }
      .folio-notif-empty-icon {
        width: 40px; height: 40px;
        border-radius: 12px;
        background: var(--theme-glass-bg, rgba(255,255,255,0.05));
        color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
        display: flex; align-items: center; justify-content: center;
        margin: 0 auto 8px;
      }
      .folio-notif-empty-icon svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 2; }
      .folio-notif-empty-title { font-size: 12px; font-weight: 700; color: var(--theme-text, #e8ecf1); margin-bottom: 2px; }
      .folio-notif-empty-desc { font-size: 10.5px; line-height: 1.4; max-width: 240px; margin: 0 auto; }

      .folio-notif-footer {
        display: flex;
        gap: 6px;
        padding: 10px 12px;
        border-top: 1px solid var(--theme-divider, rgba(255,255,255,0.08));
        flex-shrink: 0;
      }
      .folio-notif-footer a {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 7px 10px;
        border-radius: 7px;
        background: var(--theme-primary, #F59E0B);
        color: #0a0c10;
        font-size: 11.5px;
        font-weight: 700;
        text-decoration: none;
        transition: background 0.15s ease;
      }
      [data-theme="light"] .folio-notif-footer a { color: #ffffff; }
      .folio-notif-footer a:hover { background: var(--theme-primary-hover, #fbbf24); }
      .folio-notif-footer a svg { width: 11px; height: 11px; stroke: currentColor; fill: none; stroke-width: 2.4; }

      /* Mobile: bottom sheet */
      @media (max-width: 639px) {
        .folio-notif-panel {
          left: 0; right: 0; bottom: 0; top: auto !important;
          border-radius: 20px 20px 0 0;
          max-height: 80vh;
          transform: translateY(100%);
        }
        .folio-notif-panel.open { transform: translateY(0); }
        .folio-notif-panel::before {
          content: '';
          display: block;
          width: 36px; height: 4px;
          border-radius: 2px;
          background: var(--theme-glass-border, rgba(255,255,255,0.09));
          margin: 8px auto 0;
          flex-shrink: 0;
        }
      }

      /* ── Backdrop ────────────────────────────────────────── */
      .folio-notif-backdrop {
        position: fixed;
        inset: 0;
        z-index: 849;
        background: rgba(10,12,16,0.55);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }
      .folio-notif-backdrop.open { opacity: 1; pointer-events: all; }

      /* ── Prompt dialog ───────────────────────────────────── */
      .folio-notif-prompt {
        position: fixed;
        inset: 0;
        z-index: 999990;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: rgba(10, 12, 16, 0.72);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        opacity: 0;
        pointer-events: none;
        transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
        font-family: var(--font, 'Inter', -apple-system, system-ui, sans-serif);
      }
      .folio-notif-prompt.open { opacity: 1; pointer-events: auto; }

      .folio-notif-prompt-card {
        width: 100%;
        max-width: 360px;
        background: var(--bg-card, #151922);
        border: 1px solid var(--border, #222831);
        border-radius: 20px;
        padding: 26px 22px 20px;
        text-align: center;
        transform: scale(0.94) translateY(14px);
        transition: transform 260ms cubic-bezier(0.16, 1, 0.3, 1);
        position: relative;
      }
      .folio-notif-prompt.open .folio-notif-prompt-card { transform: scale(1) translateY(0); }

      .folio-notif-prompt-icon {
        width: 60px; height: 60px;
        margin: 0 auto 14px;
        border-radius: 16px;
        background: rgba(245, 158, 11, 0.14);
        border: 1px solid rgba(245, 158, 11, 0.30);
        display: flex; align-items: center; justify-content: center;
        color: #F59E0B;
        position: relative;
      }
      .folio-notif-prompt-icon svg { width: 26px; height: 26px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .folio-notif-prompt-icon::after {
        content: '';
        position: absolute;
        inset: -6px;
        border-radius: 22px;
        border: 1px dashed rgba(245, 158, 11, 0.2);
        animation: folioNotifRing 2.4s ease-in-out infinite;
      }
      @keyframes folioNotifRing {
        0%, 100% { opacity: 0.3; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(1.04); }
      }

      .folio-notif-prompt-title {
        font-size: 18px; font-weight: 700; letter-spacing: -0.3px;
        color: var(--text, #e8ecf1); margin: 0 0 6px; line-height: 1.25;
      }
      .folio-notif-prompt-sub {
        font-size: 13px; line-height: 1.55;
        color: var(--text-muted, #a8b0bc); margin: 0 0 18px;
      }
      .folio-notif-prompt-list {
        display: flex; flex-direction: column; gap: 8px;
        margin: 0 0 20px; padding: 12px 14px;
        background: var(--bg-input, #1a1f2a);
        border: 1px solid var(--border, #222831);
        border-radius: 12px; text-align: left;
      }
      .folio-notif-prompt-row {
        display: flex; align-items: center; gap: 10px;
        font-size: 12.5px; color: var(--text-muted, #a8b0bc); line-height: 1.35;
      }
      .folio-notif-prompt-row svg {
        width: 14px; height: 14px; flex-shrink: 0;
        stroke: #F59E0B; fill: none; stroke-width: 2.5;
        stroke-linecap: round; stroke-linejoin: round;
      }
      .folio-notif-prompt-actions { display: flex; flex-direction: column; gap: 8px; }

      .folio-notif-prompt-btn {
        font-family: inherit; font-size: 13.5px; font-weight: 600;
        padding: 12px 16px; border-radius: 12px;
        border: 1px solid transparent;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        gap: 6px; transition: all 120ms ease;
        touch-action: manipulation; user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      .folio-notif-prompt-btn.primary {
        background: #F59E0B; color: #0a0c10;
        box-shadow: 0 6px 20px rgba(245, 158, 11, 0.30);
      }
      .folio-notif-prompt-btn.primary:hover { background: #fbbf24; }
      .folio-notif-prompt-btn.ghost {
        background: transparent;
        color: var(--text-muted, #a8b0bc);
        border-color: var(--border, #222831);
      }
      .folio-notif-prompt-btn.ghost:hover:not(:disabled) { color: var(--text, #e8ecf1); background: var(--bg-input, #1a1f2a); }
      .folio-notif-prompt-btn:active { transform: scale(0.97); }
      .folio-notif-prompt-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
      .folio-notif-prompt-btn svg {
        width: 14px; height: 14px;
        stroke: currentColor; fill: none; stroke-width: 2.2;
        stroke-linecap: round; stroke-linejoin: round;
      }

      @media (max-width: 480px) {
        .folio-notif-prompt { align-items: flex-end; padding: 0; }
        .folio-notif-prompt-card {
          max-width: 100%;
          border-radius: 20px 20px 0 0;
          padding: 22px 20px calc(18px + env(safe-area-inset-bottom, 0px));
          transform: translateY(100%);
        }
        .folio-notif-prompt.open .folio-notif-prompt-card { transform: translateY(0); }
        .folio-notif-prompt-card::before {
          content: '';
          position: absolute;
          top: 8px; left: 50%;
          transform: translateX(-50%);
          width: 36px; height: 4px;
          border-radius: 4px;
          background: var(--border, #222831);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .folio-notif-prompt,
        .folio-notif-prompt-card,
        .folio-notif-prompt-icon::after,
        .folio-notif-dot.pulse,
        .folio-notif-panel { animation: none !important; transition: none !important; }
      }
      html[data-reduced-motion="true"] .folio-notif-prompt-icon::after,
      html[data-reduced-motion="true"] .folio-notif-dot.pulse {
        animation: none !important;
      }
    `;
    const s = document.createElement('style');
    s.id = 'folio-notifications-style';
    s.textContent = css;
    document.head.appendChild(s);
    S.stylesInjected = true;
  }

  // ═══════════════════════════════════════════════════════════
  // BELL BUTTON
  // ═══════════════════════════════════════════════════════════

  function mountBell() {
    if (S.bellEl) return;

    const headerRight = document.querySelector('.header-right');
    if (!headerRight) { setTimeout(mountBell, 200); return; }

    const btn = document.createElement('button');
    btn.className = 'folio-notif-bell';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Notifications');
    btn.setAttribute('title', 'Notifications');
    btn.innerHTML = svgWrap('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>', 14, 2.2);

    const dot = document.createElement('span');
    dot.className = 'folio-notif-dot';
    dot.setAttribute('aria-hidden', 'true');
    btn.appendChild(dot);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      togglePanel();
    });

    // Long-press → mark all read
    btn.addEventListener('pointerdown', () => {
      clearTimeout(S.longPressTimer);
      S.longPressTimer = setTimeout(() => {
        S.longPressTimer = null;
        markAllRead().catch(() => {});
      }, 650);
    });
    const cancelLongPress = () => { clearTimeout(S.longPressTimer); S.longPressTimer = null; };
    btn.addEventListener('pointerup', cancelLongPress);
    btn.addEventListener('pointerleave', cancelLongPress);
    btn.addEventListener('pointercancel', cancelLongPress);

    // Insert before #setupHeaderBtn (or at end of header-right)
    const setupBtn = document.getElementById('setupHeaderBtn');
    if (setupBtn && setupBtn.parentNode === headerRight) {
      headerRight.insertBefore(btn, setupBtn);
    } else {
      headerRight.appendChild(btn);
    }

    S.bellEl = btn;
    S.dotEl = dot;

    applyGuestVisibility();
  }

  function applyGuestVisibility() {
    if (!S.bellEl) return;
    if (CFG.hideWhenGuest && S.isGuest) {
      S.bellEl.style.display = 'none';
    } else {
      S.bellEl.style.display = '';
    }
  }

  // ═══════════════════════════════════════════════════════════
  // UNREAD DOT
  // ═══════════════════════════════════════════════════════════

  function renderDot() {
    if (!S.dotEl) return;
    const count = S.unreadCount;
    if (count <= 0) {
      S.dotEl.className = 'folio-notif-dot';
      S.dotEl.textContent = '';
      return;
    }
    S.dotEl.className = 'folio-notif-dot visible' + (count > 0 ? ' count' : '') + (hasReducedMotion() ? '' : ' pulse');
    S.dotEl.textContent = count > 9 ? '9+' : String(count);
  }

  function updateBellTitle() {
    if (!S.bellEl) return;
    const n = S.unreadCount;
    S.bellEl.title = n > 0 ? `${n} unread notification${n === 1 ? '' : 's'}` : 'Notifications';
  }

  // ═══════════════════════════════════════════════════════════
  // PANEL
  // ═══════════════════════════════════════════════════════════

  function buildPanel() {
    if (S.panelEl) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'folio-notif-backdrop';
    backdrop.addEventListener('click', () => closePanel());
    document.body.appendChild(backdrop);
    S.backdropEl = backdrop;

    const panel = document.createElement('div');
    panel.className = 'folio-notif-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Notifications');

    panel.innerHTML = `
      <div class="folio-notif-panel-header">
        <div class="folio-notif-panel-title">
          <span>Notifications</span>
          <span class="badge" id="folioNotifPanelBadge" style="display:none;">0</span>
        </div>
        <button class="folio-notif-panel-btn" id="folioNotifMarkAll" aria-label="Mark all read" title="Mark all read">
          ${svgWrap('<polyline points="20 6 9 17 4 12"/>', 13, 2.2)}
        </button>
        <button class="folio-notif-panel-btn" id="folioNotifRefresh" aria-label="Refresh" title="Refresh">
          ${svgWrap('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>', 13, 2.2)}
        </button>
        <button class="folio-notif-panel-btn" id="folioNotifClose" aria-label="Close" title="Close">
          ${svgWrap('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 13, 2.4)}
        </button>
      </div>
      <div class="folio-notif-tabs" id="folioNotifTabs"></div>
      <div class="folio-notif-list" id="folioNotifList">
        <div class="folio-notif-empty">
          <div class="folio-notif-empty-icon">${svgWrap(TYPE_ICONS.system, 18, 2)}</div>
          <div class="folio-notif-empty-title">Loading…</div>
        </div>
      </div>
      <div class="folio-notif-footer">
        <a href="/notifications" id="folioNotifViewAll">
          View all
          ${svgWrap('<polyline points="9 18 15 12 9 6"/>', 11, 2.4)}
        </a>
      </div>
    `;

    document.body.appendChild(panel);
    S.panelEl = panel;

    // Wire
    $('folioNotifClose').addEventListener('click', closePanel);
    $('folioNotifRefresh').addEventListener('click', () => refreshAll(true));
    $('folioNotifMarkAll').addEventListener('click', () => markAllRead().catch(() => {}));

    renderTabs();
  }

  function positionPanel() {
    if (!S.panelEl || !S.bellEl) return;
    if (window.matchMedia('(max-width: 639px)').matches) {
      // Mobile: bottom sheet — CSS handles it
      S.panelEl.style.top = '';
      S.panelEl.style.right = '';
      S.panelEl.style.left = '';
      S.panelEl.style.width = '';
      return;
    }
    // Desktop: dropdown from the bell
    const rect = S.bellEl.getBoundingClientRect();
    const W = 380;
    const margin = 8;
    let right = Math.max(margin, window.innerWidth - rect.right);
    if (right + W > window.innerWidth - margin) right = margin;
    S.panelEl.style.top = (rect.bottom + 6) + 'px';
    S.panelEl.style.right = right + 'px';
    S.panelEl.style.left = 'auto';
    S.panelEl.style.width = W + 'px';
  }

  function renderTabs() {
    const wrap = $('folioNotifTabs');
    if (!wrap) return;
    const tabs = ['all', 'unread', 'project', 'invite', 'system'];
    wrap.innerHTML = tabs.map(k => `
      <button class="folio-notif-tab ${S.filter === k ? 'active' : ''}" data-filter="${k}" type="button">${esc(TYPE_LABELS[k] || k)}</button>
    `).join('');
    wrap.querySelectorAll('[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        S.filter = btn.dataset.filter;
        S.offset = 0;
        S.items = [];
        renderTabs();
        loadNotifications(true);
      });
    });
  }

  function renderList() {
    const list = $('folioNotifList');
    if (!list) return;

    if (S.loading && S.items.length === 0) {
      list.innerHTML = `
        <div class="folio-notif-empty">
          <div class="folio-notif-empty-icon">${svgWrap('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', 18, 2)}</div>
          <div class="folio-notif-empty-title">Loading…</div>
        </div>`;
      return;
    }

    if (S.items.length === 0) {
      list.innerHTML = `
        <div class="folio-notif-empty">
          <div class="folio-notif-empty-icon">${svgWrap('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>', 18, 2)}</div>
          <div class="folio-notif-empty-title">No notifications</div>
          <div class="folio-notif-empty-desc">You're all caught up.</div>
        </div>`;
      return;
    }

    list.innerHTML = S.items.map(n => {
      const type = n.type || 'system';
      return `
        <button class="folio-notif-item${n.read ? '' : ' unread'}" data-id="${esc(n.id)}" type="button">
          <div class="folio-notif-item-icon ${esc(type)}">${svgWrap(TYPE_ICONS[type] || TYPE_ICONS.system, 13, 2.2)}</div>
          <div class="folio-notif-item-body">
            <div class="folio-notif-item-title">${esc(n.title || 'Notification')}</div>
            ${n.body ? `<div class="folio-notif-item-text">${esc(n.body)}</div>` : ''}
            <div class="folio-notif-item-time">${relTime(n.createdAt)}</div>
          </div>
        </button>`;
    }).join('');

    list.querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', () => {
        const n = S.items.find(x => x.id === el.dataset.id);
        if (n) openNotification(n);
      });
    });

    if (S.hasMore) {
      const loadMore = document.createElement('button');
      loadMore.className = 'folio-notif-item';
      loadMore.style.justifyContent = 'center';
      loadMore.style.fontWeight = '700';
      loadMore.style.fontSize = '11px';
      loadMore.style.color = 'var(--theme-primary, #F59E0B)';
      loadMore.textContent = 'Load more';
      loadMore.addEventListener('click', () => loadNotifications(false));
      list.appendChild(loadMore);
    }

    const badge = $('folioNotifPanelBadge');
    if (badge) {
      if (S.unreadCount > 0) {
        badge.textContent = S.unreadCount > 99 ? '99+' : String(S.unreadCount);
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
  }

  async function openPanel() {
    if (!S.panelEl) buildPanel();
    positionPanel();
    S.panelOpen = true;
    S.panelEl.classList.add('open');
    S.backdropEl?.classList.add('open');
    emit('open');

    if (CFG.panelRefreshOnOpen) {
      await refreshAll(false);
    }

    setTimeout(() => {
      $('folioNotifList')?.focus?.();
    }, 50);
  }

  function closePanel() {
    if (!S.panelEl) return;
    S.panelOpen = false;
    S.panelEl.classList.remove('open');
    S.backdropEl?.classList.remove('open');
    emit('close');
  }

  function togglePanel() {
    if (S.panelOpen) closePanel();
    else openPanel();
  }

  // ═══════════════════════════════════════════════════════════
  // PROMPT DIALOG
  // ═══════════════════════════════════════════════════════════

  function getDismissCount() {
    return readInt(LS_KEYS.dismissCount, 0);
  }

  function getDismissAt() {
    return readInt(LS_KEYS.dismissAt, 0);
  }

  function getEnabledAt() {
    return readInt(LS_KEYS.enabledAt, 0);
  }

  function getNextCooldown() {
    const count = getDismissCount();
    const arr = CFG.escalatingCooldowns;
    return arr[Math.min(count, arr.length - 1)];
  }

  function canPromptNow() {
    if (S.isGuest) return false;
    if (!('Notification' in window)) return false;
    if (Notification.permission !== 'default') return false;
    if (getEnabledAt() > 0) return false;

    const cooldown = getNextCooldown();
    if (cooldown === Infinity) return false;
    if (cooldown === 0) return true;

    const dismissedAt = getDismissAt();
    if (!dismissedAt) return true;
    return (Date.now() - dismissedAt) >= cooldown;
  }

  function buildPrompt() {
    if (S.promptEl) return;

    const el = document.createElement('div');
    el.className = 'folio-notif-prompt';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'folioNotifPromptTitle');

    el.innerHTML = `
      <div class="folio-notif-prompt-card">
        <div class="folio-notif-prompt-icon">
          ${svgWrap('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>', 26, 2)}
        </div>
        <h3 class="folio-notif-prompt-title" id="folioNotifPromptTitle">Enable notifications</h3>
        <p class="folio-notif-prompt-sub">Get alerts for deploys, invites, storage limits, and project activity — even when this tab is closed.</p>
        <div class="folio-notif-prompt-list">
          <div class="folio-notif-prompt-row">
            ${svgWrap('<polyline points="20 6 9 17 4 12"/>', 14, 2.5)}
            <span>Know the moment your project deploys</span>
          </div>
          <div class="folio-notif-prompt-row">
            ${svgWrap('<polyline points="20 6 9 17 4 12"/>', 14, 2.5)}
            <span>See collaborator invites instantly</span>
          </div>
          <div class="folio-notif-prompt-row">
            ${svgWrap('<polyline points="20 6 9 17 4 12"/>', 14, 2.5)}
            <span>Alerts for storage limits and DB writes</span>
          </div>
        </div>
        <div class="folio-notif-prompt-actions">
          <button class="folio-notif-prompt-btn primary" id="folioNotifPromptEnable" type="button">
            ${svgWrap('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>', 14, 2.2)}
            <span>Enable notifications</span>
          </button>
          <button class="folio-notif-prompt-btn ghost" id="folioNotifPromptDismiss" type="button" disabled>
            Not now (5s)
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(el);
    S.promptEl = el;

    el.addEventListener('click', (e) => {
      if (e.target === el) tryDismissPrompt();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.promptOpen) {
        e.preventDefault();
        tryDismissPrompt();
      }
    });

    $('folioNotifPromptEnable').addEventListener('click', enableNotifications);
    $('folioNotifPromptDismiss').addEventListener('click', tryDismissPrompt);
  }

  function showPrompt() {
    if (!canPromptNow()) return false;
    buildPrompt();

    document.body.style.overflow = 'hidden';
    void S.promptEl.offsetWidth;
    S.promptEl.classList.add('open');
    S.promptOpen = true;
    emit('prompt-open');

    // 5s dismiss lock with visible countdown
    const btn = $('folioNotifPromptDismiss');
    const start = Date.now();
    btn.disabled = true;

    if (S.dismissCountdownTimer) clearInterval(S.dismissCountdownTimer);
    S.dismissCountdownTimer = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, Math.ceil((CFG.dismissCountdownMs - elapsed) / 1000));
      if (remaining > 0) {
        btn.textContent = `Not now (${remaining}s)`;
      } else {
        btn.textContent = 'Not now';
        btn.disabled = false;
        clearInterval(S.dismissCountdownTimer);
        S.dismissCountdownTimer = null;
      }
    }, 250);

    return true;
  }

  function hidePrompt() {
    if (!S.promptEl) return;
    S.promptEl.classList.remove('open');
    S.promptOpen = false;
    document.body.style.overflow = '';
    if (S.dismissCountdownTimer) {
      clearInterval(S.dismissCountdownTimer);
      S.dismissCountdownTimer = null;
    }
    emit('prompt-close');
    setTimeout(() => {
      if (S.promptEl) S.promptEl.remove();
      S.promptEl = null;
    }, 320);
  }

  function tryDismissPrompt() {
    const btn = $('folioNotifPromptDismiss');
    if (btn && btn.disabled) return;

    // Escalate dismiss count
    const count = getDismissCount();
    writeVal(LS_KEYS.dismissCount, count + 1);
    writeVal(LS_KEYS.dismissAt, Date.now());
    hidePrompt();
  }

  async function enableNotifications() {
    const enableBtn = $('folioNotifPromptEnable');
    const dismissBtn = $('folioNotifPromptDismiss');
    if (enableBtn) enableBtn.disabled = true;
    if (dismissBtn) dismissBtn.disabled = true;

    try {
      if (!window.FOLIO?.fcm?.subscribe) {
        throw new Error('Notifications not available on this device');
      }
      await window.FOLIO.fcm.subscribe();
      writeVal(LS_KEYS.enabledAt, Date.now());
      S.fcmSubscribed = true;
      hidePrompt();
      await refreshAll(true);
    } catch (err) {
      console.warn('[Folio notif] enable failed:', err);
      if (enableBtn) enableBtn.disabled = false;
      if (dismissBtn) dismissBtn.disabled = false;
      // Show an inline error
      const card = S.promptEl?.querySelector('.folio-notif-prompt-card');
      if (card && !card.querySelector('.folio-notif-prompt-error')) {
        const err = document.createElement('div');
        err.className = 'folio-notif-prompt-error';
        err.style.cssText = 'margin-top:10px;padding:8px 10px;border-radius:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#EF4444;font-size:11.5px;line-height:1.4;text-align:center;';
        err.textContent = err.message || 'Could not enable notifications';
        card.appendChild(err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // LIST / STATS
  // ═══════════════════════════════════════════════════════════

  async function loadNotifications(reset = false) {
    if (S.loading) return;
    if (!getSession()) return;

    if (reset) {
      S.offset = 0;
      S.items = [];
      S.hasMore = false;
    }

    S.loading = true;
    if (S.panelEl) renderList();

    const params = new URLSearchParams();
    params.set('action', 'list');
    if (S.filter !== 'all') params.set('type', S.filter);
    params.set('limit', String(S.limit));
    params.set('offset', String(S.offset));
    params.set('sort', 'desc');

    const res = await api('?' + params.toString());
    S.loading = false;

    if (!res.ok || !res.data?.success) {
      if (S.panelEl) {
        $('folioNotifList').innerHTML = `
          <div class="folio-notif-empty">
            <div class="folio-notif-empty-icon">${svgWrap(TYPE_ICONS.system, 18, 2)}</div>
            <div class="folio-notif-empty-title">Couldn't load</div>
            <div class="folio-notif-empty-desc">${esc(res.data?.error || 'Try again.')}</div>
          </div>`;
      }
      return;
    }

    const list = res.data.notifications || [];
    S.items = S.items.concat(list);
    S.hasMore = !!res.data.hasMore;
    S.offset += list.length;

    if (S.panelEl) renderList();
  }

  async function loadStats() {
    if (!getSession()) return;
    const res = await api('?action=stats');
    if (res.ok && res.data?.success) {
      S.stats = res.data.stats;
      const newCount = res.data.stats?.unread || 0;
      if (newCount !== S.unreadCount) {
        S.unreadCount = newCount;
        renderDot();
        updateBellTitle();
        emit('change', { unread: newCount });
      }
    }
  }

  async function refreshAll(force = false) {
    if (!getSession()) return;
    if (force) S.offset = 0;
    await Promise.all([loadNotifications(force), loadStats()]);
  }

  async function markAllRead() {
    if (!getSession()) return;
    const res = await api('?action=mark_all_read', { method: 'POST', body: '{}' });
    if (res.ok && res.data?.success) {
      S.items.forEach(n => { n.read = true; });
      if (S.panelEl) renderList();
      await loadStats();
      broadcastSync({ type: 'mark-all-read' });
    }
  }

  async function markRead(id) {
    const res = await api('?action=mark_read', {
      method: 'POST',
      body: JSON.stringify({ notificationId: id }),
    });
    if (res.ok && res.data?.success) {
      const item = S.items.find(n => n.id === id);
      if (item) item.read = true;
      if (S.panelEl) renderList();
      await loadStats();
    }
  }

  async function dismiss(id) {
    const res = await api('?action=dismiss', {
      method: 'POST',
      body: JSON.stringify({ notificationId: id }),
    });
    if (res.ok && res.data?.success) {
      S.items = S.items.filter(n => n.id !== id);
      if (S.panelEl) renderList();
      await loadStats();
    }
  }

  async function openNotification(n) {
    if (!n.read) markRead(n.id);
    const link = n.link || n.action?.url || '/notifications';
    closePanel();
    if (/^https?:\/\//i.test(link) && !link.startsWith(location.origin)) {
      window.open(link, '_blank', 'noopener');
    } else {
      window.location.href = link;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // POLLING / PERMISSION
  // ═══════════════════════════════════════════════════════════

  function startPolling() {
    stopPolling();
    if (!getSession()) return;
    S.pollTimer = setInterval(() => {
      if (document.hidden) return;
      loadStats().catch(() => {});
    }, CFG.pollIntervalMs);
  }

  function stopPolling() {
    if (S.pollTimer) {
      clearInterval(S.pollTimer);
      S.pollTimer = null;
    }
  }

  function startPermissionCheck() {
    if (S.permissionTimer) clearInterval(S.permissionTimer);
    S.permissionTimer = setInterval(() => {
      if (!getSession()) return;
      if (!('Notification' in window)) return;

      // If permission silently became granted (user enabled in browser settings),
      // auto-subscribe without prompting.
      if (Notification.permission === 'granted' && !S.fcmSubscribed) {
        enableNotifications().catch(() => {});
      }
    }, CFG.autoCheckPermissionMs);
  }

  // ═══════════════════════════════════════════════════════════
  // CROSS-TAB
  // ═══════════════════════════════════════════════════════════

  function initBroadcast() {
    try {
      if (!('BroadcastChannel' in window)) return;
      S.bc = new BroadcastChannel('folio-notifications');
      S.bc.addEventListener('message', (e) => {
        const d = e.data || {};
        if (d.type === 'mark-all-read' || d.type === 'mark-read' || d.type === 'dismiss') {
          loadStats().catch(() => {});
          if (S.panelOpen) loadNotifications(true).catch(() => {});
        }
        if (d.type === 'unread-update' && typeof d.unread === 'number') {
          S.unreadCount = d.unread;
          renderDot();
          updateBellTitle();
        }
      });
    } catch {}
  }

  function broadcastSync(payload) {
    try { S.bc?.postMessage(payload); } catch {}
  }

  // ═══════════════════════════════════════════════════════════
  // SW MESSAGES
  // ═══════════════════════════════════════════════════════════

  function initSWListener() {
    if (!navigator.serviceWorker) return;
    navigator.serviceWorker.addEventListener('message', (event) => {
      const d = event.data || {};
      if (d.type === 'PUSH_RECEIVED') {
        loadStats().catch(() => {});
        if (S.panelOpen) loadNotifications(true).catch(() => {});
      }
      if (d.type === 'NOTIFICATION_CLICKED') {
        loadStats().catch(() => {});
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // GLOBAL EVENTS
  // ═══════════════════════════════════════════════════════════

  function initGlobalListeners() {
    window.addEventListener('resize', () => {
      if (S.panelOpen) positionPanel();
    });

    window.addEventListener('visibilitychange', () => {
      if (!document.hidden && getSession()) {
        loadStats().catch(() => {});
      }
    });

    window.addEventListener('scroll', () => {
      if (!S.panelOpen) return;
      if (window.matchMedia('(min-width: 640px)').matches) positionPanel();
    }, { passive: true });

    // Re-check session — if user signed in on another tab, remount
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_SESSION) {
        syncSessionState();
      }
      if (e.key === LS_KEYS.panelOpen) {
        // Another tab opened/closed — ignore to avoid fighting
      }
    });
  }

  function syncSessionState() {
    const session = getSession();
    const wasGuest = S.isGuest;
    S.session = session;
    S.isGuest = !session;
    applyGuestVisibility();
    if (wasGuest && !S.isGuest) {
      // Just signed in
      startPolling();
      refreshAll(true).catch(() => {});
      setTimeout(() => showPrompt(), 800);
    } else if (!wasGuest && S.isGuest) {
      // Just signed out
      stopPolling();
      S.unreadCount = 0;
      renderDot();
      closePanel();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // BOOT
  // ═══════════════════════════════════════════════════════════

  function boot() {
    injectStyles();
    S.session = getSession();
    S.isGuest = !S.session;

    // Wait for header to exist
    const tryMount = () => {
      if (document.querySelector('.header-right')) {
        mountBell();
        buildPanel();
        initBroadcast();
        initSWListener();
        initGlobalListeners();
        renderDot();

        if (!S.isGuest) {
          refreshAll(true).catch(() => {});
          startPolling();
          startPermissionCheck();

          if (window.FOLIO?.fcm?.isSubscribed) {
            window.FOLIO.fcm.isSubscribed().then(v => { S.fcmSubscribed = !!v; }).catch(() => {});
          }

          // Show prompt after a short delay if conditions met
          setTimeout(() => { try { showPrompt(); } catch {} }, 2000);
        }
      } else {
        setTimeout(tryMount, 100);
      }
    };
    tryMount();
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  window.FOLIO = window.FOLIO || {};
  window.FOLIO.notifications = {
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    refresh: () => refreshAll(true),
    isEnabled: () => {
      if (!('Notification' in window)) return false;
      return Notification.permission === 'granted' && S.fcmSubscribed;
    },
    getUnreadCount: () => S.unreadCount,
    markAllRead,
    on, off: (ev, fn) => {
      if (S.listeners[ev]) S.listeners[ev] = S.listeners[ev].filter(f => f !== fn);
    },
    _state: S,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();