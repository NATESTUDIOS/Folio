// ═══════════════════════════════════════════════════════════
// CREATE PROJECT — full flow as a standalone module
//   import { createNewProject } from '/js/create-project.js';
//
//   Depends on a small set of host functions passed in at init:
//     initCreateProject({ apiFetch, db, toast, workspace, setPidInUrl,
//                         getAvatarColor, getInitials, renderSidebar,
//                         renderEmptyRecent, DEFAULT_PROJECT_STORAGE_LIMIT,
//                         API_HOST,
//                         isGuest: () => S.isGuest,
//                         isOnline: () => S.online,
//                         getUsername: () => S.user?.profile?.username || null,
//                         getSession: () => S.session,
//                         // optional — fallbacks provided:
//                         API_FLIER: '…/api/flier',
//                         getUid: () => S.user?.uid || null })
// ═══════════════════════════════════════════════════════════

let deps = null;

export function initCreateProject(hostDeps) {
  deps = hostDeps;
}

function $(id) { return document.getElementById(id); }

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child)) : child);
  }
  return node;
}

// ─── Runtime CSS injection (one-shot) ──────────────────────

let cssInjected = false;

function ensureMiniToolCSS() {
  if (cssInjected) return;
  if (document.getElementById('folio-create-project-css')) { cssInjected = true; return; }
  const style = document.createElement('style');
  style.id = 'folio-create-project-css';
  style.textContent = `
    .folio-cp-tool-card {
      display: flex; flex-direction: column; gap: 12px;
      background: var(--theme-surface-card-solid, #151922);
      border: 1px solid var(--theme-glass-border, rgba(255,255,255,0.09));
      border-radius: 16px;
      padding: 20px;
      width: 100%;
      max-width: 520px;
      max-height: 92vh;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0,0,0,0.45);
      padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
      box-sizing: border-box;
    }
    @media (max-width: 639px) {
      .folio-cp-tool-card {
        border-radius: 22px 22px 0 0;
        max-width: 100%;
      }
    }
    .folio-cp-tool-header {
      display: flex; align-items: center; gap: 8px;
    }
    .folio-cp-tool-back {
      width: 30px; height: 30px; border-radius: 7px;
      display: flex; align-items: center; justify-content: center;
      color: var(--theme-text-secondary, rgba(232,236,241,0.72));
      background: transparent; border: none; cursor: pointer; flex-shrink: 0;
      transition: background 0.15s, color 0.15s;
    }
    .folio-cp-tool-back:hover {
      background: var(--theme-glass-bg, rgba(255,255,255,0.05));
      color: var(--theme-text, #e8ecf1);
    }
    .folio-cp-tool-title {
      flex: 1; font-size: 15px; font-weight: 800;
      color: var(--theme-text, #e8ecf1);
    }
    .folio-cp-tool-desc {
      font-size: 11px;
      color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
      line-height: 1.5;
    }
    .folio-cp-tool-tabs {
      display: flex; gap: 3px; padding: 3px;
      background: var(--theme-glass-bg, rgba(255,255,255,0.05));
      border-radius: 8px;
    }
    .folio-cp-tool-tab {
      flex: 1; padding: 7px; border-radius: 6px;
      font-size: 11px; font-weight: 700;
      color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
      font-family: inherit; border: none; cursor: pointer; background: transparent;
      transition: background 0.15s, color 0.15s;
    }
    .folio-cp-tool-tab.active {
      background: var(--theme-surface-elevated, #1a1f2a);
      color: var(--theme-text, #e8ecf1);
    }
    .folio-cp-preview {
      aspect-ratio: 1; border-radius: 12px; overflow: hidden;
      border: 1px solid var(--theme-card-border, rgba(255,255,255,0.08));
      background: var(--theme-glass-bg, rgba(255,255,255,0.05));
      position: relative;
    }
    .folio-cp-preview.is-cover { aspect-ratio: 1200 / 630; }
    .folio-cp-preview img {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .folio-cp-preview-placeholder {
      display: flex; align-items: center; justify-content: center;
      height: 100%;
      color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
      font-size: 11px; text-align: center; padding: 14px;
    }
    .folio-cp-preview-spinner {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.35);
      backdrop-filter: blur(2px);
    }
    .folio-cp-preview-spinner::after {
      content: '';
      width: 22px; height: 22px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.25);
      border-top-color: var(--theme-primary, #F59E0B);
      animation: folio-cp-spin 0.8s linear infinite;
    }
    @keyframes folio-cp-spin { to { transform: rotate(360deg); } }
    .folio-cp-presets-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    }
    @media (max-width: 480px) {
      .folio-cp-presets-grid { grid-template-columns: repeat(2, 1fr); }
    }
    .folio-cp-preset {
      aspect-ratio: 1; border-radius: 9px; overflow: hidden;
      border: 2px solid transparent;
      background: var(--theme-surface-elevated, #1a1f2a);
      cursor: pointer; padding: 0; position: relative;
      transition: transform 0.12s, border-color 0.15s, box-shadow 0.15s;
    }
    .folio-cp-preset:hover { transform: scale(1.03); }
    .folio-cp-preset.selected {
      border-color: var(--theme-primary, #F59E0B);
      box-shadow: 0 0 0 2px var(--theme-primary-soft, rgba(245,158,11,0.14));
    }
    .folio-cp-preset img {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .folio-cp-tool-footer {
      display: flex; gap: 6px; padding-top: 12px;
      border-top: 1px solid var(--theme-divider, rgba(255,255,255,0.08));
    }
    .folio-cp-tool-footer .btn { flex: 1; }
    .folio-cp-color-swatch {
      width: 28px; height: 28px; border-radius: 6px;
      border: 1px solid var(--theme-card-border, rgba(255,255,255,0.08));
      cursor: pointer; padding: 0; overflow: hidden;
      position: relative; flex-shrink: 0;
    }
    .folio-cp-color-swatch input[type="color"] {
      position: absolute; inset: -4px;
      width: calc(100% + 8px); height: calc(100% + 8px);
      padding: 0; border: none; cursor: pointer;
    }
    .folio-cp-slider {
      width: 100%; accent-color: var(--theme-primary, #F59E0B);
    }
    .folio-cp-field {
      display: flex; flex-direction: column; gap: 5px;
    }
    .folio-cp-field-label {
      font-size: 10px; font-weight: 700;
      color: var(--theme-text-tertiary, rgba(232,236,241,0.44));
      text-transform: uppercase; letter-spacing: 0.4px;
    }
    .folio-cp-row {
      display: flex; align-items: center; gap: 6px;
    }
    .folio-cp-pills {
      display: flex; flex-wrap: wrap; gap: 4px;
    }
    .folio-cp-pills .filter-pill {
      padding: 5px 10px; font-size: 10.5px;
    }
  `;
  document.head.appendChild(style);
  cssInjected = true;
}

// ─── Palette helpers ────────────────────────────────────────

const PALETTE_SEEDS = [
  { primary: '#F59E0B', accent: '#fbbf24', from: '#F59E0B', to: '#f97316' },
  { primary: '#3B82F6', accent: '#60a5fa', from: '#3B82F6', to: '#6366f1' },
  { primary: '#a855f7', accent: '#c084fc', from: '#a855f7', to: '#6d28d9' },
  { primary: '#10B981', accent: '#34d399', from: '#10B981', to: '#059669' },
  { primary: '#ec4899', accent: '#f472b6', from: '#ec4899', to: '#be185d' },
  { primary: '#06b6d4', accent: '#22d3ee', from: '#06b6d4', to: '#0891b2' },
  { primary: '#6366f1', accent: '#818cf8', from: '#6366f1', to: '#4f46e5' },
  { primary: '#14b8a6', accent: '#2dd4bf', from: '#14b8a6', to: '#0d9488' },
  { primary: '#f97316', accent: '#fb923c', from: '#f97316', to: '#ea580c' },
  { primary: '#84cc16', accent: '#a3e635', from: '#84cc16', to: '#65a30d' },
  { primary: '#d946ef', accent: '#e879f9', from: '#d946ef', to: '#a21caf' },
  { primary: '#64748b', accent: '#94a3b8', from: '#64748b', to: '#475569' },
];

function pickDefaultPalette(seed) {
  const s = String(seed || 'x');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return PALETTE_SEEDS[Math.abs(h) % PALETTE_SEEDS.length];
}

function clampHex(v) {
  const s = String(v || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return '#' + s.slice(1).split('').map(c => c + c).join('');
  return null;
}

// ─── Flier helpers ──────────────────────────────────────────

function flierBase() {
  if (!deps) return '/api/flier';
  if (deps.API_FLIER) return deps.API_FLIER;
  if (deps.API_HOST) return String(deps.API_HOST).replace(/\/host\/?$/, '/flier');
  return '/api/flier';
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const session = deps?.getSession ? deps.getSession() : null;
    if (session) headers['Authorization'] = `Bearer ${session}`;
  } catch {}
  return headers;
}

async function flierFetch(action, payload) {
  try {
    const res = await fetch(flierBase() + '?action=' + action, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 429) {
      return { error: 'RATE_LIMITED', retryAfter: data.retryAfter || 3600, scope: data.scope };
    }
    if (res.status === 401) return { error: 'AUTH_REQUIRED' };
    if (!res.ok || !data.success) return { error: data.error || `HTTP ${res.status}` };
    return { data };
  } catch (err) {
    return { error: err.message || 'Network error' };
  }
}

async function flierAvatarPreview({ username, displayName }) {
  const r = await flierFetch('avatar/preview', { username, displayName });
  if (r.error) return r;
  if (!Array.isArray(r.data.variants)) return { error: 'No variants' };
  return { variants: r.data.variants };
}

async function flierCustomPreview(payload) {
  const r = await flierFetch('avatar/custom', { ...payload, mode: 'preview' });
  if (r.error) return r;
  if (!r.data.preview) return { error: 'No preview' };
  return { preview: r.data.preview };
}

async function flierGenerateUpload(payload) {
  const r = await flierFetch('generate', { ...payload, mode: 'upload' });
  if (r.error) return r;
  const url = r.data.url || r.data.display_url;
  if (!url) return { error: 'No URL in response' };
  return { url };
}

async function flierUploadDataUrl(dataUrl, username, kind = 'icon') {
  const r = await flierFetch('upload', { dataUrl, kind, username });
  if (r.error) return r;
  const url = r.data.url || r.data.display_url;
  if (!url) return { error: 'No URL in response' };
  return { url };
}

// Debounced, in-flight-safe preview generator.
function makePreviewScheduler(fn, { debounceMs = 500, minGapMs = 900 } = {}) {
  let timer = null;
  let lastFireAt = 0;
  let inflight = null;
  return function schedule(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (inflight) { try { await inflight; } catch {} }
      const wait = Math.max(0, minGapMs - (Date.now() - lastFireAt));
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastFireAt = Date.now();
      inflight = Promise.resolve(fn(...args)).catch(() => {});
      try { await inflight; } finally { inflight = null; }
    }, debounceMs);
  };
}

// ─── Public API ────────────────────────────────────────────

export async function createNewProject() {
  if (!deps) throw new Error('initCreateProject() not called');
  const { isGuest, isOnline, toast } = deps;

  if (!isGuest() && !isOnline()) {
    toast('Requires internet to create cloud project', 'warning');
    return;
  }

  const result = await newProjectForm();
  if (!result) return;

  const { name, description, iconUrl, coverUrl } = result;
  const cleaned = name.trim();
  if (!cleaned) return;

  const {
    apiFetch, db, workspace, setPidInUrl, renderSidebar,
    renderEmptyRecent, DEFAULT_PROJECT_STORAGE_LIMIT,
    API_HOST, getUsername,
  } = deps;

  let pid, slug, createdAt = Date.now();

  if (isGuest()) {
    pid = `local_${Date.now()}`;
    slug = cleaned.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'project';
  } else {
    const res = await apiFetch(API_HOST + '?action=projects/create', {
      method: 'POST',
      body: JSON.stringify({ name: cleaned, description }),
    });
    if (!res.ok || !res.data?.success) {
      toast(res.data?.error || 'Could not create project', 'error');
      return;
    }
    const serverProject = res.data.project || null;
    pid = res.data.pid;
    slug = serverProject?.slug
      || cleaned.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      || 'project';
    createdAt = serverProject?.createdAt
      ? (typeof serverProject.createdAt === 'number'
          ? serverProject.createdAt
          : new Date(serverProject.createdAt).getTime())
      : Date.now();

    if (iconUrl) {
      await apiFetch(API_HOST + '?action=projects/update', {
        method: 'POST',
        body: JSON.stringify({ pid, iconUrl }),
      }).catch(() => {});
    }
  }

  const project = {
    pid, name: cleaned, slug, description,
    iconUrl: iconUrl || null,
    createdAt,
    updatedAt: Date.now(),
    storageLimit: DEFAULT_PROJECT_STORAGE_LIMIT,
    myRole: 'owner',
    ownerUsername: getUsername(),
    _server: !isGuest(),
  };

  try {
    await db.putProject(project);
  } catch (err) {
    console.error('[CreateProject] putProject failed:', err);
    toast('Could not save project locally', 'error');
    return;
  }

  const indexHtml = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>' + cleaned + '</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>' + cleaned + '</h1>\n  <p>' + (description || 'Edit this file to get started.') + '</p>\n  <script src="app.js"><' + '/script>\n</body>\n</html>';
  const styleCss = 'body {\n  font-family: system-ui, sans-serif;\n  margin: 2rem;\n  background: #0a0c10;\n  color: #e8ecf1;\n}\n';
  const appJs = "console.log('Hello from " + cleaned.replace(/'/g, "\\'") + "');\n";

  try {
    await db.putFile(pid, 'index.html', indexHtml);
    await db.putFile(pid, 'style.css', styleCss);
    await db.putFile(pid, 'app.js', appJs);
  } catch (err) {
    console.error('[CreateProject] putFile failed:', err);
  }

  if (!isGuest() && isOnline()) {
    try {
      const sync = await apiFetch(API_HOST + '?action=project/sync-back', {
        method: 'POST',
        body: JSON.stringify({
          pid,
          files: { 'index.html': indexHtml, 'style.css': styleCss, 'app.js': appJs },
        }),
      });
      if (!sync.ok || !sync.data?.success) {
        toast('Project created, but files not synced to server', 'warning', 4000);
      }

      const metaTags = {};
      if (cleaned) metaTags.title = cleaned;
      if (description) metaTags.description = description;
      if (coverUrl) metaTags.ogImage = coverUrl;
      if (Object.keys(metaTags).length > 0) {
        await apiFetch(API_HOST + '?action=metatags/save', {
          method: 'POST',
          body: JSON.stringify({ pid, metaTags }),
        }).catch(() => {});
      }
    } catch {
      toast('Project created, but files not synced to server', 'warning', 4000);
    }
  }

  if (description || coverUrl) {
    try {
      const meta = {};
      if (cleaned) meta.title = cleaned;
      if (description) meta.description = description;
      if (coverUrl) meta.ogImage = coverUrl;
      await db.setProjectMeta(pid, { meta });
    } catch {}
  }

  toast(isGuest() ? `Created ${cleaned} (local)` : `Created ${cleaned}`, 'success');
  try {
    await workspace.openProject(project);
    setPidInUrl(project.pid);
    renderSidebar();
    renderEmptyRecent();
  } catch (err) {
    console.error('[CreateProject] openProject failed:', err);
    toast('Project created, but could not open editor', 'warning');
  }
}

// ─── Return-trip handler (call from boot) ──────────────────

export function handleNewProjectImageReturn() {
  if (!deps) return false;
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('tmp') !== '1') return false;
    const genType = params.get('generated');
    const genUrl = params.get('url');
    if (!genType || !genUrl) return false;

    sessionStorage.setItem(
      'folio.newProject.pending.' + genType,
      decodeURIComponent(genUrl)
    );

    const cleanUrl = new URL(location.href);
    ['generated', 'url', 'slot', 'tmp', 'pid', 'from', 'return', 'name', 'desc', 'tool']
      .forEach(k => cleanUrl.searchParams.delete(k));
    history.replaceState(null, '', cleanUrl.toString());

    setTimeout(() => createNewProject(), 300);
    return true;
  } catch {
    return false;
  }
}

// ─── The form ──────────────────────────────────────────────

function newProjectForm() {
  return new Promise((resolve) => {
    const { getAvatarColor, getInitials, isGuest, toast, getUsername } = deps;
    ensureMiniToolCSS();

    const overlay = el('div', {
      style: {
        position: 'fixed', inset: '0', zIndex: '1000',
        background: 'rgba(10,12,16,0.78)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        overflowY: 'auto',
      },
    });
    if (window.innerWidth >= 640) {
      overlay.style.alignItems = 'center';
      overlay.style.padding = '20px';
    }

    const formCard = el('div', {
      style: {
        background: 'var(--theme-surface-card-solid, #151922)',
        border: '1px solid var(--theme-glass-border, rgba(255,255,255,0.09))',
        borderRadius: window.innerWidth >= 640 ? '16px' : '22px 22px 0 0',
        padding: '20px',
        width: '100%',
        maxWidth: '460px',
        maxHeight: '92vh',
        overflowY: 'auto',
        boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
        paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        boxSizing: 'border-box',
      },
    });

    const toolCard = el('div', { class: 'folio-cp-tool-card', style: { display: 'none' } });

    overlay.appendChild(formCard);
    overlay.appendChild(toolCard);

    // ── Inputs ──
    const nameInput = el('input', {
      class: 'input',
      placeholder: 'My awesome project',
      maxlength: '100',
      style: { width: '100%' },
    });

    const descInput = el('textarea', {
      class: 'textarea',
      placeholder: 'A short description (optional)',
      maxlength: '300',
      style: { width: '100%', minHeight: '60px', resize: 'vertical' },
    });

    // ── Icon preview ──
    const iconPreview = el('div', {
      class: 'project-icon-box',
      style: {
        width: '56px', height: '56px', borderRadius: '14px',
        fontSize: '18px', fontWeight: '800',
        background: getAvatarColor('new-project'),
        color: '#0a0c10',
        flexShrink: '0',
        overflow: 'hidden',
      },
    }, '?');

    const iconBtn = el('button', {
      class: 'btn btn-secondary btn-sm',
      type: 'button',
      style: { marginTop: '4px' },
    }, 'Choose icon');

    // ── Cover preview ──
    const coverPreview = el('div', {
      style: {
        width: '100%', aspectRatio: '1200/630',
        borderRadius: '10px',
        background: 'var(--theme-glass-bg, rgba(255,255,255,0.05))',
        border: '1px dashed var(--theme-card-border, rgba(255,255,255,0.08))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--theme-text-tertiary, rgba(232,236,241,0.44))',
        fontSize: '10.5px', textAlign: 'center', padding: '14px',
        overflow: 'hidden',
      },
    }, 'No cover image');

    const coverBtn = el('button', {
      class: 'btn btn-secondary btn-sm',
      type: 'button',
      style: { marginTop: '6px' },
    }, 'Choose cover');

    let chosenIconUrl = null;
    let chosenCoverUrl = null;

    function updateIconPreview(url, fallbackName) {
      iconPreview.innerHTML = '';
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.borderRadius = 'inherit';
        iconPreview.appendChild(img);
      } else {
        const name = fallbackName || nameInput.value || 'New';
        iconPreview.textContent = getInitials(name);
        iconPreview.style.background = getAvatarColor(name);
      }
    }

    function updateCoverPreview(url) {
      coverPreview.innerHTML = '';
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '10px';
        coverPreview.appendChild(img);
        coverPreview.style.borderStyle = 'solid';
      } else {
        coverPreview.textContent = 'No cover image';
        coverPreview.style.borderStyle = 'dashed';
      }
    }

    nameInput.addEventListener('input', () => {
      if (!chosenIconUrl) updateIconPreview(null, nameInput.value);
    });

    // ── Tool switcher ──
    function showForm() {
      toolCard.style.display = 'none';
      toolCard.innerHTML = '';
      formCard.style.display = 'flex';
    }
    function showTool(content) {
      formCard.style.display = 'none';
      toolCard.innerHTML = '';
      toolCard.style.display = 'flex';
      if (content instanceof Node) toolCard.appendChild(content);
    }

    // ── Icon tool ──
    iconBtn.addEventListener('click', () => {
      const username = (getUsername && getUsername()) || 'new-project';
      const displayName = nameInput.value.trim() || 'New project';
      const content = buildIconTool({
        username,
        displayName,
        isGuest: isGuest(),
        initialUrl: chosenIconUrl,
        onSave: (url) => {
          chosenIconUrl = url;
          updateIconPreview(url);
          showForm();
        },
        onCancel: () => showForm(),
        toast,
      });
      showTool(content);
    });

    // ── Cover tool ──
    coverBtn.addEventListener('click', () => {
      if (isGuest()) {
        toast('Sign in to generate covers', 'warning');
        return;
      }
      const username = (getUsername && getUsername()) || 'new-project';
      const content = buildCoverTool({
        username,
        projectName: nameInput.value.trim() || 'New project',
        projectDescription: descInput.value.trim(),
        initialUrl: chosenCoverUrl,
        onSave: (url) => {
          chosenCoverUrl = url;
          updateCoverPreview(url);
          showForm();
        },
        onCancel: () => showForm(),
        toast,
      });
      showTool(content);
    });

    if (isGuest()) {
      coverBtn.textContent = 'Cover unavailable (guest)';
      coverBtn.disabled = true;
      coverBtn.style.opacity = '0.5';
    }

    // Legacy round-trip pickup
    try {
      const sIcon = sessionStorage.getItem('folio.newProject.pending.icon');
      const sCover = sessionStorage.getItem('folio.newProject.pending.cover');
      if (sIcon) {
        chosenIconUrl = sIcon;
        updateIconPreview(chosenIconUrl);
      }
      if (sCover) {
        chosenCoverUrl = sCover;
        updateCoverPreview(chosenCoverUrl);
      }
      sessionStorage.removeItem('folio.newProject.pending.icon');
      sessionStorage.removeItem('folio.newProject.pending.cover');
    } catch {}

    // ── Actions ──
    const createBtn = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      style: { flex: '1' },
    }, 'Create project');
    createBtn.disabled = true;

    const cancelBtn = el('button', {
      class: 'btn btn-secondary',
      type: 'button',
      style: { flex: '1' },
      onclick: () => { cleanup(); resolve(null); },
    }, 'Cancel');

    nameInput.addEventListener('input', () => {
      createBtn.disabled = !nameInput.value.trim();
    });

    function cleanup() { try { overlay.remove(); } catch {} }

    function submit() {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      cleanup();
      resolve({
        name,
        description: descInput.value.trim(),
        iconUrl: chosenIconUrl,
        coverUrl: chosenCoverUrl,
      });
    }

    createBtn.addEventListener('click', submit);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(null); }
    });

    // ── Assemble ──
    formCard.appendChild(el('div', {
      style: { fontSize: '17px', fontWeight: '800', color: 'var(--theme-text, #e8ecf1)', marginBottom: '4px' },
    }, 'New project'));

    formCard.appendChild(el('div', {
      style: {
        fontSize: '11.5px', color: 'var(--theme-text-tertiary, rgba(232,236,241,0.44))',
        marginBottom: '4px', lineHeight: '1.5',
      },
    }, 'Give it a name. Add a description, icon, and cover to make it look sharp.'));

    formCard.appendChild(el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Name'),
      nameInput,
    ));

    formCard.appendChild(el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Description'),
      descInput,
    ));

    formCard.appendChild(el('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '12px',
        background: 'var(--theme-glass-bg, rgba(255,255,255,0.05))',
        border: '1px solid var(--theme-card-border, rgba(255,255,255,0.08))',
        borderRadius: '10px',
      },
    },
      iconPreview,
      el('div', { style: { flex: '1', minWidth: '0' } },
        el('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--theme-text, #e8ecf1)' } }, 'Project icon'),
        el('div', { style: { fontSize: '10px', color: 'var(--theme-text-tertiary, rgba(232,236,241,0.44))', marginTop: '2px' } }, 'Shown in the sidebar and header'),
        iconBtn,
      ),
    ));

    formCard.appendChild(el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Cover image'),
      coverPreview,
      el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '6px' } }, coverBtn),
    ));

    formCard.appendChild(el('div', {
      style: {
        display: 'flex', gap: '8px',
        marginTop: '8px', paddingTop: '16px',
        borderTop: '1px solid var(--theme-divider, rgba(255,255,255,0.08))',
      },
    }, cancelBtn, createBtn));

    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); resolve(null); }
    });

    setTimeout(() => nameInput.focus(), 80);
  });
}

// ═══════════════════════════════════════════════════════════
// ICON MINI-TOOL
// ═══════════════════════════════════════════════════════════

function buildIconTool({ username, displayName, isGuest, initialUrl, onSave, onCancel, toast }) {
  ensureMiniToolCSS();
  const container = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });

  // Header
  const header = el('div', { class: 'folio-cp-tool-header' });
  const backBtn = el('button', {
    class: 'folio-cp-tool-back', type: 'button', 'aria-label': 'Back', onclick: onCancel,
  });
  backBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  header.appendChild(backBtn);
  header.appendChild(el('div', { class: 'folio-cp-tool-title' }, 'Project icon'));
  container.appendChild(header);

  container.appendChild(el('div', { class: 'folio-cp-tool-desc' },
    isGuest ? 'Pick from 5 generated presets.' : 'Pick from presets, or customize colors and text.'));

  // Tabs
  const tabs = el('div', { class: 'folio-cp-tool-tabs' });
  const presetTab = el('button', { class: 'folio-cp-tool-tab active', type: 'button' }, 'Presets');
  const customTab = el('button', { class: 'folio-cp-tool-tab', type: 'button' }, 'Customize');
  if (isGuest) customTab.style.display = 'none';
  tabs.appendChild(presetTab);
  tabs.appendChild(customTab);
  container.appendChild(tabs);

  // Preview
  const preview = el('div', { class: 'folio-cp-preview' });
  preview.appendChild(el('div', { class: 'folio-cp-preview-placeholder' }, 'Select a variant or customize'));
  container.appendChild(preview);

  // Panels
  const presetsPanel = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const customPanel = el('div', { style: { display: 'none', flexDirection: 'column', gap: '10px' } });
  container.appendChild(presetsPanel);
  container.appendChild(customPanel);

  // ── Presets ──
  const presetGrid = el('div', { class: 'folio-cp-presets-grid' });
  const shuffleBtn = el('button', {
    class: 'btn btn-secondary btn-sm', type: 'button',
    style: { alignSelf: 'flex-start' },
  }, 'Shuffle');
  presetsPanel.appendChild(presetGrid);
  presetsPanel.appendChild(shuffleBtn);

  let selectedPresetUrl = null;
  let presetSelection = -1;

  async function loadPresets(shuffle) {
    presetGrid.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      presetGrid.appendChild(el('div', {
        style: { aspectRatio: '1', borderRadius: '9px', background: 'var(--theme-glass-bg, rgba(255,255,255,0.05))' },
      }));
    }
    const suffix = shuffle ? Math.random().toString(36).slice(2, 6) : '';
    const res = await flierAvatarPreview({
      username: username + suffix,
      displayName,
    });
    presetGrid.innerHTML = '';
    if (res.error) {
      const msg = res.error === 'RATE_LIMITED'
        ? 'Rate limited — try again later.'
        : res.error === 'AUTH_REQUIRED'
          ? 'Sign in required.'
          : 'Could not load presets.';
      presetGrid.appendChild(el('div', {
        style: {
          gridColumn: '1 / -1', fontSize: '11px',
          color: 'var(--theme-text-tertiary, rgba(232,236,241,0.44))',
          textAlign: 'center', padding: '12px',
        },
      }, msg));
      return;
    }
    res.variants.forEach((v, i) => {
      const btn = el('button', {
        class: 'folio-cp-preset', type: 'button',
        'aria-label': v.label || ('Variant ' + (i + 1)),
        onclick: () => {
          presetSelection = i;
          selectedPresetUrl = v.dataUrl;
          presetGrid.querySelectorAll('.folio-cp-preset').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          setPreview(v.dataUrl);
          updateSaveButton();
        },
      });
      const img = document.createElement('img');
      img.src = v.dataUrl;
      img.alt = '';
      btn.appendChild(img);
      presetGrid.appendChild(btn);
    });
  }

  shuffleBtn.addEventListener('click', () => loadPresets(true));

  // ── Custom ──
  const palette = pickDefaultPalette(displayName);
  const state = {
    headline: (displayName || 'P').slice(0, 40),
    primary: palette.primary,
    accent: palette.accent,
    bgType: 'gradient',
  };

  const headlineInput = el('input', {
    class: 'input',
    maxlength: '40',
    value: state.headline,
    style: { width: '100%' },
    oninput: (e) => { state.headline = e.target.value; schedulePreview(); },
  });

  function colorRow(label, initialHex, onChange) {
    const colorInput = el('input', { type: 'color', value: initialHex });
    const hexInput = el('input', {
      class: 'input',
      maxlength: '7',
      value: initialHex,
      style: { flex: '1', minWidth: '0', fontFamily: 'var(--font-mono, monospace)', fontSize: '11px' },
    });
    const swatch = el('div', { class: 'folio-cp-color-swatch' });
    swatch.appendChild(colorInput);
    colorInput.addEventListener('input', (e) => {
      hexInput.value = e.target.value;
      onChange(e.target.value);
    });
    hexInput.addEventListener('input', (e) => {
      const v = clampHex(e.target.value);
      if (v) { colorInput.value = v; onChange(v); }
    });
    return el('div', { class: 'folio-cp-field' },
      el('label', { class: 'folio-cp-field-label' }, label),
      el('div', { class: 'folio-cp-row' }, swatch, hexInput),
    );
  }

  customPanel.appendChild(el('div', { class: 'folio-cp-field' },
    el('label', { class: 'folio-cp-field-label' }, 'Headline'),
    headlineInput,
  ));
  customPanel.appendChild(colorRow('Primary', state.primary, (v) => { state.primary = v; schedulePreview(); }));
  customPanel.appendChild(colorRow('Accent', state.accent, (v) => { state.accent = v; schedulePreview(); }));

  // Style pills
  const stylePills = el('div', { class: 'folio-cp-pills' });
  ['gradient', 'solid', 'pattern'].forEach((v) => {
    const pill = el('button', {
      class: 'filter-pill' + (state.bgType === v ? ' active' : ''),
      type: 'button',
      onclick: () => {
        state.bgType = v;
        stylePills.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        schedulePreview();
      },
    }, v.charAt(0).toUpperCase() + v.slice(1));
    stylePills.appendChild(pill);
  });
  customPanel.appendChild(el('div', { class: 'folio-cp-field' },
    el('label', { class: 'folio-cp-field-label' }, 'Background'),
    stylePills,
  ));

  function setPreview(url) {
    preview.innerHTML = '';
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      preview.appendChild(img);
    } else {
      preview.appendChild(el('div', { class: 'folio-cp-preview-placeholder' }, 'Select a variant or customize'));
    }
  }

  if (initialUrl) setPreview(initialUrl);

  // ✅ Live preview: debounced, in-flight-safe
  const schedulePreview = makePreviewScheduler(async () => {
    if (!state.headline.trim()) return;
    if (preview.querySelector('.folio-cp-preview-spinner')) return;

    // Show spinner overlay while we wait
    const spinner = el('div', { class: 'folio-cp-preview-spinner' });
    preview.appendChild(spinner);

    try {
      const payload = {
        type: 'template',
        template: 'hero-short',
        size: '512x512',
        seed: displayName,
        data: {
          text: { headline: state.headline },
          style: {
            variant: 'dark',
            colors: { primary: state.primary, accent: state.accent },
            background: {
              type: state.bgType === 'solid' ? 'solid' : 'gradient',
              from: state.primary,
              to: state.accent,
              angle: 135,
            },
            pattern: state.bgType === 'pattern' ? 'dots' : 'none',
          },
          images: {},
        },
      };
      const res = await flierCustomPreview(payload);
      if (res.error) {
        if (res.error === 'RATE_LIMITED') toast('Rate limited — try again in a moment', 'warning', 2500);
        return;
      }
      setPreview(res.preview);
      updateSaveButton();
    } finally {
      try { spinner.remove(); } catch {}
    }
  });

  // Tabs
  presetTab.addEventListener('click', () => {
    presetTab.classList.add('active');
    customTab.classList.remove('active');
    presetsPanel.style.display = 'flex';
    customPanel.style.display = 'none';
    if (selectedPresetUrl) setPreview(selectedPresetUrl);
    updateSaveButton();
  });
  customTab.addEventListener('click', () => {
    customTab.classList.add('active');
    presetTab.classList.remove('active');
    presetsPanel.style.display = 'none';
    customPanel.style.display = 'flex';
    schedulePreview();
    updateSaveButton();
  });

  // ── Footer ──
  const saveBtn = el('button', {
    class: 'btn btn-primary', type: 'button', style: { flex: '1' },
  }, 'Use this icon');
  const cancelBtn = el('button', {
    class: 'btn btn-secondary', type: 'button', style: { flex: '1' }, onclick: onCancel,
  }, 'Cancel');
  container.appendChild(el('div', { class: 'folio-cp-tool-footer' }, cancelBtn, saveBtn));

  function updateSaveButton() {
    const presetOk = presetSelection >= 0 && selectedPresetUrl;
    const customOk = customTab.classList.contains('active') && !!preview.querySelector('img');
    saveBtn.disabled = !(presetOk || customOk);
  }
  updateSaveButton();

  // ── Save ──
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const prev = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';

    try {
      if (presetTab.classList.contains('active') && selectedPresetUrl) {
        const res = await flierUploadDataUrl(selectedPresetUrl, username, 'icon');
        if (res.error) throw new Error(res.error === 'RATE_LIMITED' ? 'Rate limited — try again later' : res.error);
        onSave(res.url);
        return;
      }
      if (customTab.classList.contains('active')) {
        const payload = {
          type: 'template',
          template: 'hero-short',
          size: '512x512',
          seed: displayName,
          data: {
            text: { headline: state.headline },
            style: {
              variant: 'dark',
              colors: { primary: state.primary, accent: state.accent },
              background: {
                type: state.bgType === 'solid' ? 'solid' : 'gradient',
                from: state.primary,
                to: state.accent,
                angle: 135,
              },
              pattern: state.bgType === 'pattern' ? 'dots' : 'none',
            },
            images: {},
          },
          upload: { name: `icon_${username}_${Date.now()}` },
        };
        const res = await flierGenerateUpload(payload);
        if (res.error) throw new Error(res.error === 'RATE_LIMITED' ? 'Rate limited — try again later' : res.error);
        onSave(res.url);
        return;
      }
    } catch (err) {
      toast(err.message || 'Could not save icon', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = prev;
    }
  });

  loadPresets(false);
  return container;
}

// ═══════════════════════════════════════════════════════════
// COVER MINI-TOOL
// ═══════════════════════════════════════════════════════════

const COVER_TEMPLATES = [
  { id: 'browser-frame', label: 'Browser' },
  { id: 'hero-short', label: 'Hero' },
  { id: 'poster-centered', label: 'Poster' },
  { id: 'scene-poster', label: 'Scene' },
  { id: 'quote-card', label: 'Quote' },
  { id: 'split-image-side', label: 'Split' },
  { id: 'event-poster', label: 'Event' },
  { id: 'stat-hero', label: 'Stat' },
];

const COVER_SCENES = [
  { id: 'auto', label: 'Auto' },
  { id: 'none', label: 'None' },
  { id: 'ribbon', label: 'Ribbon' },
  { id: 'grid_wave', label: 'Grid' },
  { id: 'halftone', label: 'Halftone' },
  { id: 'skyline', label: 'Skyline' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'vinyl', label: 'Vinyl' },
  { id: 'shelf', label: 'Shelf' },
  { id: 'window_sill', label: 'Window' },
  { id: 'glass_cards', label: 'Glass' },
  { id: 'paper_stack', label: 'Paper' },
];

const COVER_PALETTES = [
  { id: 'auto', label: 'Auto' },
  { id: 'warm', label: 'Warm' },
  { id: 'cool', label: 'Cool' },
  { id: 'neon', label: 'Neon' },
  { id: 'earth', label: 'Earth' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'mono', label: 'Mono' },
];

function buildCoverTool({ username, projectName, projectDescription, initialUrl, onSave, onCancel, toast }) {
  ensureMiniToolCSS();
  const container = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });

  const header = el('div', { class: 'folio-cp-tool-header' });
  const backBtn = el('button', {
    class: 'folio-cp-tool-back', type: 'button', 'aria-label': 'Back', onclick: onCancel,
  });
  backBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  header.appendChild(backBtn);
  header.appendChild(el('div', { class: 'folio-cp-tool-title' }, 'Project cover'));
  container.appendChild(header);

  container.appendChild(el('div', { class: 'folio-cp-tool-desc' },
    'Used on share cards and the project page. 1200×630.'));

  const palette = pickDefaultPalette(projectName || 'project');
  const state = {
    template: 'browser-frame',
    scene: 'auto',
    scenePalette: 'auto',
    primary: palette.primary,
    accent: palette.accent,
    bgFrom: palette.primary,
    bgTo: palette.accent,
    bgAngle: 135,
    headline: (projectName || 'Untitled').slice(0, 120),
    subheadline: (projectDescription || '').slice(0, 160),
  };

  // Preview
  const preview = el('div', { class: 'folio-cp-preview is-cover' });
  if (initialUrl) {
    const img = document.createElement('img');
    img.src = initialUrl;
    img.alt = '';
    preview.appendChild(img);
  } else {
    preview.appendChild(el('div', { class: 'folio-cp-preview-placeholder' }, 'Adjust controls below to preview'));
  }
  container.appendChild(preview);

  // ── Template pills ──
  const tplPills = el('div', { class: 'folio-cp-pills' });
  COVER_TEMPLATES.forEach((t, i) => {
    const pill = el('button', {
      class: 'filter-pill' + (i === 0 ? ' active' : ''),
      type: 'button',
      onclick: () => {
        state.template = t.id;
        tplPills.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        schedulePreview();
      },
    }, t.label);
    tplPills.appendChild(pill);
  });
  container.appendChild(el('div', { class: 'folio-cp-field' },
    el('label', { class: 'folio-cp-field-label' }, 'Template'),
    tplPills,
  ));

  // ── Scene pills ──
  const scenePills = el('div', { class: 'folio-cp-pills' });
  COVER_SCENES.forEach((s, i) => {
    const pill = el('button', {
      class: 'filter-pill' + (i === 0 ? ' active' : ''),
      type: 'button',
      onclick: () => {
        state.scene = s.id;
        scenePills.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        schedulePreview();
      },
    }, s.label);
    scenePills.appendChild(pill);
  });
  container.appendChild(el('div', { class: 'folio-cp-field' },
    el('label', { class: 'folio-cp-field-label' }, 'Scene'),
    scenePills,
  ));

  // ── Palette pills ──
  const palettePills = el('div', { class: 'folio-cp-pills' });
  COVER_PALETTES.forEach((p, i) => {
    const pill = el('button', {
      class: 'filter-pill' + (i === 0 ? ' active' : ''),
      type: 'button',
      onclick: () => {
        state.scenePalette = p.id;
        palettePills.querySelectorAll('.filter-pill').forEach(x => x.classList.remove('active'));
        pill.classList.add('active');
        schedulePreview();
      },
    }, p.label);
    palettePills.appendChild(pill);
  });
  container.appendChild(el('div', { class: 'folio-cp-field' },
    el('label', { class: 'folio-cp-field-label' }, 'Scene palette'),
    palettePills,
  ));

  // ── Headline / Subheadline ──
  const headlineInput = el('input', {
    class: 'input', maxlength: '120', value: state.headline,
    oninput: (e) => { state.headline = e.target.value; schedulePreview(); },
  });
  const subheadlineInput = el('input', {
    class: 'input', maxlength: '160', value: state.subheadline,
    oninput: (e) => { state.subheadline = e.target.value; schedulePreview(); },
  });

  container.appendChild(el('div', { class: 'folio-cp-field' },
    el('label', { class: 'folio-cp-field-label' }, 'Headline'),
    headlineInput,
  ));
  container.appendChild(el('div', { class: 'folio-cp-field' },
    el('label', { class: 'folio-cp-field-label' }, 'Subheadline'),
    subheadlineInput,
  ));

  // ── Colors ──
  function colorRow(label, initialHex, onChange) {
    const colorInput = el('input', { type: 'color', value: initialHex });
    const hexInput = el('input', {
      class: 'input', maxlength: '7', value: initialHex,
      style: { flex: '1', minWidth: '0', fontFamily: 'var(--font-mono, monospace)', fontSize: '11px' },
    });
    const swatch = el('div', { class: 'folio-cp-color-swatch' });
    swatch.appendChild(colorInput);
    colorInput.addEventListener('input', (e) => { hexInput.value = e.target.value; onChange(e.target.value); });
    hexInput.addEventListener('input', (e) => {
      const v = clampHex(e.target.value);
      if (v) { colorInput.value = v; onChange(v); }
    });
    return el('div', { class: 'folio-cp-field' },
      el('label', { class: 'folio-cp-field-label' }, label),
      el('div', { class: 'folio-cp-row' }, swatch, hexInput),
    );
  }

  container.appendChild(colorRow('Primary', state.primary, (v) => {
    state.primary = v; state.bgFrom = v; schedulePreview();
  }));
  container.appendChild(colorRow('Accent', state.accent, (v) => {
    state.accent = v; state.bgTo = v; schedulePreview();
  }));

  // ── Angle slider ──
  const angleLabel = el('span', { style: { fontSize: '10px', color: 'var(--theme-text-tertiary)' } }, state.bgAngle + '°');
  const angleInput = el('input', {
    type: 'range', min: '0', max: '360', value: String(state.bgAngle), class: 'folio-cp-slider',
    oninput: (e) => {
      state.bgAngle = Number(e.target.value);
      angleLabel.textContent = state.bgAngle + '°';
      schedulePreview();
    },
  });
  container.appendChild(el('div', { class: 'folio-cp-field' },
    el('label', { class: 'folio-cp-field-label', style: { display: 'flex', justifyContent: 'space-between' } },
      el('span', {}, 'Gradient angle'),
      angleLabel,
    ),
    angleInput,
  ));

  // ── Footer ──
  const saveBtn = el('button', {
    class: 'btn btn-primary', type: 'button', style: { flex: '1' },
  }, 'Use this cover');
  const cancelBtn = el('button', {
    class: 'btn btn-secondary', type: 'button', style: { flex: '1' }, onclick: onCancel,
  }, 'Cancel');
  container.appendChild(el('div', { class: 'folio-cp-tool-footer' }, cancelBtn, saveBtn));

  let pendingPreview = null;

  function setPreview(url) {
    preview.innerHTML = '';
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      preview.appendChild(img);
    } else {
      preview.appendChild(el('div', { class: 'folio-cp-preview-placeholder' }, 'Adjust controls below to preview'));
    }
  }

  function buildPayload(mode) {
    return {
      mode,
      type: 'template',
      template: state.template,
      size: '1200x630',
      seed: projectName || 'new-project',
      data: {
        text: {
          headline: state.headline,
          subheadline: state.subheadline,
        },
        style: {
          variant: 'dark',
          colors: { primary: state.primary, accent: state.accent },
          background: {
            type: 'gradient',
            from: state.bgFrom,
            to: state.bgTo,
            angle: state.bgAngle,
          },
          scene: state.scene,
          scenePalette: state.scenePalette,
          sceneOpacity: 0.85,
        },
        images: {},
      },
      upload: mode === 'upload' ? { name: `cover_${username}_${Date.now()}` } : undefined,
    };
  }

  // ✅ Live preview: debounced
  const schedulePreview = makePreviewScheduler(async () => {
    if (preview.querySelector('.folio-cp-preview-spinner')) return;
    const spinner = el('div', { class: 'folio-cp-preview-spinner' });
    preview.appendChild(spinner);

    try {
      const res = await flierCustomPreview(buildPayload('preview'));
      if (res.error) {
        if (res.error === 'RATE_LIMITED') toast('Rate limited — try again in a moment', 'warning', 2500);
        return;
      }
      pendingPreview = res.preview;
      setPreview(res.preview);
      saveBtn.disabled = false;
    } finally {
      try { spinner.remove(); } catch {}
    }
  });

  // Save
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const prev = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    try {
      const res = await flierGenerateUpload(buildPayload('upload'));
      if (res.error) throw new Error(res.error === 'RATE_LIMITED' ? 'Rate limited — try again later' : res.error);
      onSave(res.url);
    } catch (err) {
      toast(err.message || 'Could not save cover', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = prev;
    }
  });

  // Initial preview
  schedulePreview();

  return container;
}