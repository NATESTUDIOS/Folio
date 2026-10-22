// ═══════════════════════════════════════════════════════════
// CREATE PROJECT — full flow as a standalone module
//   import { createNewProject } from '/js/create-project.js';
//
//   Depends on a small set of host functions passed in at init:
//     initCreateProject({ apiFetch, db, toast, workspace, setPidInUrl,
//                         getAvatarColor, getInitials, renderSidebar,
//                         renderEmptyRecent, DEFAULT_PROJECT_STORAGE_LIMIT,
//                         API_HOST, isGuest: () => S.isGuest,
//                         isOnline: () => S.online,
//                         getUsername: () => S.user?.profile?.username || null,
//                         getSession: () => S.session })
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

// ─── Public API ──────────────────────────────────────────────

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

  const { apiFetch, db, workspace, setPidInUrl, renderSidebar,
          renderEmptyRecent, DEFAULT_PROJECT_STORAGE_LIMIT,
          API_HOST, getUsername } = deps;

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
  }

  const project = {
    pid,
    name: cleaned,
    slug,
    description,
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

// ─── Return-trip handler (call from boot) ────────────────────

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

// ─── The form ────────────────────────────────────────────────

function newProjectForm() {
  return new Promise((resolve) => {
    const { getAvatarColor, getInitials, isGuest, toast } = deps;

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

    const iconPreview = el('div', {
      class: 'project-icon-box',
      style: {
        width: '56px', height: '56px', borderRadius: '14px',
        fontSize: '18px', fontWeight: '800',
        background: getAvatarColor('new-project'),
        color: '#0a0c10',
        flexShrink: '0',
      },
    }, '?');

    const iconBtn = el('button', {
      class: 'btn btn-secondary btn-sm',
      type: 'button',
      style: { marginTop: '4px' },
    }, 'Choose icon');

    const coverPreview = el('div', {
      style: {
        width: '100%', aspectRatio: '1200/630',
        borderRadius: '10px',
        background: 'var(--theme-glass-bg)',
        border: '1px dashed var(--theme-card-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--theme-text-tertiary)',
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

    iconBtn.addEventListener('click', () => {
      if (isGuest()) { toast('Sign in to generate icons', 'warning'); return; }
      const pid = 'new_' + Date.now();
      const params = new URLSearchParams({
        tool: 'image-generator',
        from: 'editor',
        pid,
        slot: 'icon',
        return: location.pathname + location.search,
        name: nameInput.value.trim() || 'New project',
        desc: descInput.value.trim().slice(0, 120),
        tmp: '1',
      });
      window.location.href = '/tools?' + params.toString();
    });

    if (isGuest()) {
      iconBtn.textContent = 'Random icon color';
      iconBtn.onclick = () => {
        const seed = nameInput.value || String(Math.random());
        iconPreview.style.background = getAvatarColor(seed + Date.now());
        iconPreview.textContent = getInitials(nameInput.value || 'New');
      };
    }

    coverBtn.addEventListener('click', () => {
      if (isGuest()) { toast('Sign in to generate covers', 'warning'); return; }
      const pid = 'new_' + Date.now();
      const params = new URLSearchParams({
        tool: 'image-generator',
        from: 'editor',
        pid,
        slot: 'cover',
        return: location.pathname + location.search,
        name: nameInput.value.trim() || 'New project',
        desc: descInput.value.trim().slice(0, 120),
        tmp: '1',
      });
      window.location.href = '/tools?' + params.toString();
    });

    if (isGuest()) {
      coverBtn.textContent = 'Cover unavailable (guest)';
      coverBtn.disabled = true;
      coverBtn.style.opacity = '0.5';
    }

    // Pick up pending images from /tools round-trip
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

    function cleanup() {
      try { overlay.remove(); } catch {}
    }

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

    const card = el('div', {
      style: {
        background: 'var(--theme-surface-card-solid)',
        border: '1px solid var(--theme-glass-border)',
        borderRadius: window.innerWidth >= 640 ? '16px' : '22px 22px 0 0',
        padding: '20px',
        width: '100%',
        maxWidth: '460px',
        maxHeight: '92vh',
        overflowY: 'auto',
        boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
        paddingBottom: 'calc(20px + var(--safe-bottom, 0px))',
      },
    },
      el('div', {
        style: {
          fontSize: '17px', fontWeight: '800',
          color: 'var(--theme-text)', marginBottom: '4px',
        },
      }, 'New project'),
      el('div', {
        style: {
          fontSize: '11.5px', color: 'var(--theme-text-tertiary)',
          marginBottom: '16px', lineHeight: '1.5',
        },
      }, 'Give it a name. Add a description, icon, and cover to make it look sharp.'),

      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Name'),
        nameInput,
      ),

      el('div', { class: 'field', style: 'margin-top:12px;' },
        el('label', { class: 'field-label' }, 'Description'),
        descInput,
      ),

      el('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '12px',
          marginTop: '16px', padding: '12px',
          background: 'var(--theme-glass-bg)',
          border: '1px solid var(--theme-card-border)',
          borderRadius: '10px',
        },
      },
        iconPreview,
        el('div', { style: { flex: '1', minWidth: '0' } },
          el('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--theme-text)' } }, 'Project icon'),
          el('div', { style: { fontSize: '10px', color: 'var(--theme-text-tertiary)', marginTop: '2px' } }, 'Shown in the sidebar and header'),
          iconBtn,
        ),
      ),

      el('div', { class: 'field', style: 'margin-top:16px;' },
        el('label', { class: 'field-label' }, 'Cover image'),
        coverPreview,
        el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '6px' } }, coverBtn),
      ),

      el('div', {
        style: {
          display: 'flex', gap: '8px',
          marginTop: '20px',
          paddingTop: '16px',
          borderTop: '1px solid var(--theme-divider)',
        },
      }, cancelBtn, createBtn),
    );

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); resolve(null); }
    });

    setTimeout(() => nameInput.focus(), 80);
  });
}